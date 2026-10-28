# Live checks on a verify pylon

Verified in this task's pylon on 2026-10-28, on branch `feat/verify-pylon` at 1febce3, with headless Chromium 138. No live control plane, node, image, GitHub repository or other thread was touched, and no VM booted.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023/lib> FONTCONFIG_PATH=<its fonts> \
  docs/verification/verify-pylon/run.sh
```

`run.sh` builds the dashboard, starts `stack.ts`, drives it with `drive.mjs`, and saves every capture in `branch/`, with the commit in `commit.txt`. Then it runs the live check's tests into `tests.txt`.

`stack.ts` runs the real registry, API, dashboard, PR watch, inbox, review loop, thread starter and placement, and the real check runner for both `.nexus/check` and the live check, wired as `src/control/main.ts` wires them. It is the [archive-landed](../archive-landed/README.md) stack with three changes:

- GitHub serves two local git repositories. `ramtinJ95/nexus` has a `.nexus/verify` on main, which prints how it boots the change and fails unless `src/greeting.txt` starts with `Hello`. `ramtinJ95/greeter` has none. Each builder's push is a real commit, and GitHub's contents read looks the file up in it.
- Two nodes report themselves online. `verify-node` is each project's default and reports no nested virtualization. `rj-firebat` reports it.
- The probe's stream is the fake verify pylon, and the fake check pylon. It clones the pylon's repository at the pylon's boot commit into a directory of its own and runs the gate's script there as a local process, so the script, the checkout check and the exit status are real. `pylons.log` records each run with the pylon's node and boot resources.

Docker is not available in this pylon, so the verify-nexus stack could not run.

`drive.mjs` uses only the Mac CLI and the dashboard. Both projects land their builders' pull requests on their own (`project edit --auto-review land`), and no one runs `nexus review`.

## What was checked

| Builder | Review, from `14-events-review.txt` | Live check |
|---|---|---|
| "Greet by name" in `nexus`, greeting `Hello, Ramtin` | `reviewing`, `checking`, `verifying`, `merging`, `deploying`, `landed` | Passed in a verify pylon on `rj-firebat`. The description says nothing of what was not checked live, and it landed anyway. `08-show-pass.txt` prints `live check passed at 1c7d4c145c6f`. |
| "Say goodbye" in `nexus`, greeting `Goodbye` | `reviewing`, `checking`, `verifying`, `fixing`, `needs-person` | Failed. The builder got `LIVE (P0) .nexus/verify` with the output and rejected it without a push, so the review went to the person with the output (`09-show-fail.txt`). `nexus land` exits 5, `not approved with its checks passing` (`13-land-fail.txt`). Nothing merged (`github.log`). |
| "Greet warmly" in `greeter`, no `.nexus/verify` | `reviewing`, `checking`, `merging`, `landed` | None ran: no verify pylon was started, and GitHub's contents read answered 404. It landed on its statement of what it could not check live, as before. `10-show-plain.txt` prints `no live check: e6abb6fd3d2f has no .nexus/verify, ...`. |

The two verify pylons (`11-` and `12-show-verify-pylon-*.txt`, `07-threads.txt`) are archived, on `rj-firebat`, sized `2 CPUs, 8 GiB memory, 10 GiB disk, nested virtualization`, with the placement line `verify-node cannot give a pylon KVM of its own: its probe does not report nested virtualization`. The check threads went to `verify-node` and are deleted. `pylons.log`:

```
pylon-th-…  on verify-node, {"cpus":2,"memoryGiB":4,"diskGiB":10}, runs nexus-check at …   (three of these)
pylon-th-9876a72551ea on rj-firebat, {"cpus":2,"memoryGiB":8,"diskGiB":10,"nestedVirtualization":true}, runs nexus-verify at 3203f8e70f1e
pylon-th-e34e8d228810 on rj-firebat, {"cpus":2,"memoryGiB":8,"diskGiB":10,"nestedVirtualization":true}, runs nexus-verify at 1c7d4c145c6f
```

`tests.txt` runs the 13 tests this branch adds for the live check, 13 of 13 passing. The repository's full suite passed too, as the pull request says.

"Greet by name", landed through the live check, with its Live check step done:

![the landed builder](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/verify-pylon/docs/verification/verify-pylon/branch/02-pass.png)

"Say goodbye", held for the person. The transcript holds the `LIVE` finding the builder rejected, and the Pylon tab the review's line, `live check failed at …`, and the reasons:

![the held builder](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/verify-pylon/docs/verification/verify-pylon/branch/05-fail-pylon-tab.png)

"Greet warmly", landed on its statement, with the Live check step skipped:

![the builder without a verify script](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/verify-pylon/docs/verification/verify-pylon/branch/04-plain.png)

## Not verified

Only a real node can prove these:

- That a pylon-vm probe on `rj-firebat` reports nested virtualization. `hostNestsKvm` reads `/sys/module/kvm_amd/parameters/nested`, which the 2026-10-26 spike did not record. The tests cover the reading, not the host.
- That a verify pylon boots there with `/dev/kvm`: the image's `nexus-kvm` step, which needs the image built since #178 and rolled out, and 8 GiB on top of what the node already holds.
- How long a real live check takes. The review gives it the hour `.nexus/check` gets, which is a guess, not a measurement.
- Nexus's own live check. Nexus has no `.nexus/verify` yet, because the verify-nexus stack runs its pylons on Docker, which a verify pylon lacks. `.claude/skills/verify-nexus/scripts/live-check` is the drive it would run. It was not run here, because this pylon has no Docker.
- A verify pylon that no node can take, a live check its pylon cannot run, and a landing tried again that keeps a passed live check, on the stack. `review.test.ts` covers each.
