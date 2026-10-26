# Slow Claude sends and four flaky tests

Verified in this task's pylon on 2026-10-26, on branch `slow-send-and-flake`. The pylon is Linux with 4 CPUs, Node 24.22.1, Python 3.11.2 and git 2.39.5. Each "before" capture ran the same tool against `origin/main` (`91ce541`) in a worktree. No live control plane, node or other thread was touched.

## A send queued behind a slow one

`slow-send.ts` wires the real `nexus` CLI (as a process, `NEXUS_SOCKS=none`) to the real control-plane API, which reaches the real probe server through the real probe client and its 90 s wait. The guest is scripted. Herdr reports one working Claude pane, and typing takes 60 s for the first message and 40 s for the second, so the second waits behind the first for 59 s and is typed by 100 s. Run it with `node docs/verification/slow-send-and-flake/slow-send.ts`.

- `slow-send-before.txt` is `main`. The CLI gives up after 30 silent seconds, with exit 2, on both sends. A resend under the second's request ID is refused with "failed partway", although nothing failed. Both messages were still being typed when the script shut down at 32 s, so its `typed` list is empty.
- `slow-send-after.txt` is this branch. The first send answers at 60 s. The second runs out the control plane's 90 s wait and fails at 91 s with exit 1, saying the message may still reach Claude, at most once, and naming request ID `msg:second`. The resend under that ID waits for the queued send and answers at 100 s with exit 0, `Queued for Claude`. A third send under it answers at once. The guest typed each message once.

## The flaky tests

`tools/loop.sh <runs> <test file> [pattern]` runs one test file repeatedly and prints the first lines of each failure.

- **src/pylon-vm/relay.test.ts:72.** `tools/squat.mjs` holds about 3500 ephemeral listeners on 127.0.0.1 that answer with an empty body, as other test files' servers do in a parallel suite. The test took the `::1` server's port from the ephemeral range, and the relay rightly tries 127.0.0.1 first, so it reached the stranger and got `""`. `relay-before.txt` has 8 of 30 passing, 12 of the failures being `actual: '', expected: 'v6'` and the rest the same race on the relay port. `relay-after.txt` has 100 of 100.
- **src/deploy/worker.test.ts:27.** A mount namespace replaces `/usr/bin` with a copy that lacks `flock` and `timeout`, as macOS does. The supervisor script's `flock -n 9 || exit 0` then exits 0 without running anything, so `deployer/rejected` is never written. `worker-before.txt` shows the Mac's ENOENT. `worker-after.txt` skips the test and names the missing tools. Both pass 20 of 20 with the tools present.
- **src/git-facts.test.ts:37 and :46.** XNU's `killpg1` (`bsd/kern/kern_sig.c` in apple-oss-distributions/xnu) skips zombie members of a group and returns EPERM when it found none to signal. Linux signals a zombie successfully. The helper reads the first byte of `git status` and then kills git's group, by when git has often exited unreaped. `tools/sitecustomize.py` makes Python's `os.killpg` follow XNU's rule. Under it, `git-facts-before.txt` fails 15 of 15 runs, exactly at those two tests, the only ones that expect a dirty checkout to read. `git-facts-after.txt` passes 15 of 15, with 45 EPERMs tolerated, and both pass 15 of 15 without the emulation.
- **The stall-limit test, src/control/api.test.ts:1080.** It failed at :1092, where the reconnect waits for its first event, which carries the whole 16 MiB view. The test reader rescanned everything it held on every chunk. `stall-profile-before.txt` shows that handler, `event-reader.ts:38`, taking 962 ms of one unloaded run, and `stall-profile-after.txt` shows it gone from the top. `tools/burn.sh 6 420` runs six busy loops on the 4 CPUs. Under it, `stall-before.txt` has 7 of 20 passing, every failure `no event on /v1/threads/…/events`, and `stall-after.txt` has 40 of 40.

## The review loop's check

The review loop's `.nexus/check` failed twice at `npm ci` with `SELF_SIGNED_CERT_IN_CHAIN` on `zwitch-2.0.4.tgz`. A check runs over a raw stream, which goes over SSH to the guest's sshd. sshd runs the command in a shell that is no login shell, so it never reads `/etc/profile.d/gondolin-image-env.sh`. That file is where `gondolin build` writes `gondolin.json`'s env, `NODE_EXTRA_CA_CERTS` among it, which npm needs to trust Gondolin's TLS proxy. sandboxd's execs get the same env directly, which is why npm works in a pylon's terminal. `remoteCommand` now reads that file first and then execs the command. `tools/check-ca.ts` runs a cold-cache `npm ci` through a shell without the CA, as sshd starts one. `check-ca.txt` shows the argv alone failing on the certificate at that same tarball every time, and `remoteCommand` installing. This pylon's network also times out some cold-cache downloads, with or without the fix, as the capture records.

## What was not verified

- macOS itself. The worker test's cause comes from the Mac's error and from the tools the script needs. The git-facts cause comes from XNU's source and from an emulation of its rule, not from a Mac run.
- A real Claude pane and a real pylon VM. The probe, client, API and CLI are real, and the guest is scripted, as in the probe's tests.
- The dashboard's send. It keeps the request ID when the same text is sent again, and now shows a 503's reason as it is. No browser drove it here.
- The check in a real check pylon over real SSH. The stream test stands in for sshd with `sh -c`, as the existing stream test does, and the capture ran the shell side in this pylon.
- A mixed deployment. A probe older than `send-claude-outcome` refuses the command, and `src/control/api.test.ts` checks that the control plane then answers 422 as before. No old probe ran here.
