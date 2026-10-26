# Deterministic timing in the unit suite

Verified in this task's pylon on 2026-10-26, on branch `deterministic-timing-tests`. The pylon is Linux with 4 CPUs and Node 24.22.1. Each "before" ran `origin/main` (`d7f601a`) in a worktree, at the same time as the "after" run of this branch and under the same load. No live control plane, node or other thread was touched.

## What the tests waited on

The suite raced wall-clock time in four ways. Each now waits for something the code does instead.

- **Short deadlines on a condition.** Polling helpers gave up after 1 to 10 s, such as `until` in `src/control/loop.test.ts` (3 s) and the event reader's `next()` (5 s). They still poll the same condition, but give up only after 60 s, which only ends a hang.
- **A product timer the test sat through.** The page stream test slept 2.5 s twice to see the 2 s turn reads stop, and waited 5 s per event for them. The test now ticks node's mock timers, so it runs in about 150 ms. A close test waited out the API's 5 s close and then timed it. The API now takes that wait as `closeWaitMs`, 5 s by default, and the test sets 100 ms.
- **A sleep before a check.** "Wait 50 ms, then nothing changed" became a signal that the code had its chance. Examples are a loop pass after the fake node's events are delivered, a WebSocket ping answered after the earlier frames, and a whois that was reached.
- **Elapsed-time assertions,** such as `< 7000 ms` or a rendered `1m 0[34]s`. These became exact results under a frozen or stepped clock, or were dropped where the error already tells the paths apart.

Three tests had races the sleeps hid. None was in product code.

- `loop.test.ts` "services the probe could not read…" expected its four snapshots to be the last four. The preview spawn's own snapshot can land after them, and then the check never holds.
- `events.test.ts` read a child's `/proc/<pid>/environ` as soon as the spawn event fired. It once read empty under load. The cause is a guess: the exec may not yet have set up the environment. 3400 isolated tries never reproduced it. The test now reads only after the child prints.
- `cli/nexus.test.ts`'s SOCKS proxy left a client socket paused and half-closed when the API hung up first. Its `server.close()` then never returned, so the test's teardown stopped before the hook that kills the `watch` child. That stalled the suite for 22 minutes in one run. `diagnosis-proxy-hang.txt` has the live inspection. The proxy now closes the client when the API side closes, and `npm test` fails a test still running after 10 minutes.

One failure was a real bug in product code. `images/pylon/nexus-heartbeat.ts` read every `/proc/<pid>/stat` at once and dropped each process whose read failed. In this pylon, pid 1 (`/usr/bin/sandboxd`) never reaped the orphans the suite runs left behind. About 5000 `python3` and `sshd` zombies piled up, so with `ulimit -n` at 4096, about 1000 reads failed with EMFILE. Two events tests then found no background group. A pylon whose zombies pile up the same way would let a Stop hook decide a background command had ended. The scan now reads in batches of 256. `heartbeat-before.txt` runs the new test against main's heartbeat and fails 5 of 5. `heartbeat-after.txt` passes 5 of 5. The heartbeat ships in the pylon image, so pylons get the fix only when the image is rebuilt.

## Tools

- `tools/compare.sh <rounds> <cpus> <busy loops> <out dir> <before> <after>` runs the full suite in both checkouts at once each round. Both run beside that many busy loops, pinned with `taskset` to the same CPUs.
- `tools/side-by-side.sh <runs> <cpus> <busy loops> <out dir> <before> <after> <file> <pattern>` loops one test file in both checkouts at once, at nice 10. It uses `docs/verification/slow-send-and-flake/tools/loop.sh` from #98.
- `tools/slow-disk.mjs`, preloaded through `NODE_OPTIONS=--import`, blocks the process for `WRITE_MS` after each SQLite write. The registry writes synchronously, so a slow fsync holds up the whole event loop, as on the old disk. At 30 ms, `loop.test.ts` takes 271 s instead of 8 s, 34 times as long. #101's 2034 s run was 25 times the 81 s the suite takes here.
- `tools/slow-spawn.mjs` makes each spawned program start `SPAWN_MS` late. The page stream test reads the transcript through a shell script, so this makes each read slow.

## Results

CPU load alone rarely breaks these tests. Two suites on 2 CPUs beside 2 busy loops take about 6 minutes each, and most rounds pass on both sides. The reported flakes need a stall of seconds, so the targeted runs synthesize the stall each one hit.

| Run | Before | After |
| --- | --- | --- |
| Full suite under CPU load, 15 rounds (`cpu-*.txt`) | 12 of 15 passed. One failed the environment read, and two failed the heartbeat tests once the zombies passed the file limit | The 5 rounds at this branch's head passed all 1141 tests. Earlier states of the branch hung once on the proxy and failed the heartbeat tests once |
| `loop.test.ts` on a slow disk, `WRITE_MS=30` (`slow-disk-loop-*.txt`) | 0 of 5 passed, each timed out at "the last read is ingested" | 5 of 5 |
| The used-up port range test, `WRITE_MS=100` (`slow-disk-port-range-*.txt`) | 0 of 5, each timed out at "web is published" | 5 of 5 |
| The queued Claude worker test, `WRITE_MS=300` (`slow-disk-worker-*.txt`) | 0 of 3, each timed out at "worker started" | 3 of 3 |
| The page stream test with each read 6 s late, `SPAWN_MS=6000` (`slow-spawn-api-*.txt`) | 0 of 5, each `no event on /threads/…/stream`, as in #119 | 5 of 5 |

In the slow-spawn run, main survives reads up to about 4 s. Any frame restarts its 5 s wait, and the 2 s timer keeps the reads overlapping. It fails once one read takes longer than 5 s, which is what #119's run hit. 6 s is a synthesized stall, not a measured one.

Unloaded, the suite takes about 80 s on both sides. Main has 1140 tests and this branch has 1141, all passing, and typecheck is clean.

## What was not verified

- The original failures themselves. The three reported tests never failed here under CPU load alone. The slow disk and the slow spawn reproduce each one's failure mode, but they emulate the machines those runs had.
- The full suite on the slow disk. One round would take about 2.5 hours, because nearly every control-plane test writes the registry. That run covered `loop.test.ts` alone.
- The cause of the empty environment read in `events.test.ts`.
- The review loop's own check pylon. The suite ran here, not in a check pylon.
- Whether other pylons' pid 1 also leaves zombies unreaped. This was seen in this pylon only, after about 30 suite runs.
