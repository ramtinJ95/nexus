# Drive tools

Verified in this thread's pylon on 2026-10-28, on branch `feat/drive-tools` at `258254b` against main at `b996fb0`, with Node 24.22.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/drive-tools/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs `stack.ts drive` there. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt` and every step in `timeline.txt`. Both runs use the same file and the same steps, and the same scripted model: `run.sh` copies the branch's `src/harness/test-fixture.ts` into main's checkout, so on both a message `tool: <name> <JSON>` makes one call of that tool. The captures differ only by the code under test. Then it runs the branch's drive tool tests, `src/harness/drive-tools.test.ts` and `src/control/drive.test.ts` with the branch's `src/harness/drive-fixture.ts`, against each checkout's code, into `tests-main.txt` and `tests-branch.txt`.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` runs the real `startControlPlane` from the checkout under test in one child process: the registry, loop, harness, review passes, watch pass and API. It runs the real probe server in another, so a control plane restart is a process exit and the registry and harness files survive it. Every step goes through the real `nexus` CLI (`NEXUS_URL`, `NEXUS_SOCKS=none`). Only the production boundaries are stand-ins:

- tailscaled's whois is a socket in the run's folder;
- the model is the scripted one, which answers a plain message with `scripted answer after user` and a tool result with `scripted answer after toolResult`;
- the VM backend boots nothing. Its guest runs the pi-env daemon from `node_modules` for the harness, and refuses the checkout snapshot each turn asks for, which `control.log` records.

Thread IDs are random, so the captures name each thread by the order it first appeared, as `<thread 1>`, and replace times with `<time>`.

## Main (`main/`) and this branch (`branch/`)

| Step | main, b996fb0 | this branch, 258254b |
|---|---|---|
| `03`, `04` a thread started without `--drive` is told to call `nexus_start` | `[tool error] nexus_start: Tool nexus_start is not available` | The same. A thread that does not ask for the tools does not get them |
| `05` `start --title Plan --drive --message "tool: nexus_start ..."` | exit 64, `Unknown option '--drive'`. The remaining steps need a planning thread, so they are skipped | exit 0, `<thread 2>` |
| `06` to `12` the planner calls `nexus_start` four times | | Builds 1 to 3 start as `<thread 3>` to `<thread 5>`. The fourth answers `[tool error] nexus_start: thread <thread 2> has 3 live children (<thread 3>, <thread 4>, <thread 5>), the most a thread may have` |
| `13` to `15` `threads`, `show` of the planner and of Build 1 | | 5 threads. `drive tools: on, children: <thread 3> (active), <thread 4> (active), <thread 5> (active)`, and `started by thread <thread 2>, with nexus_start` |
| `16` Build 1's conversation | | Its brief once, `From thread <thread 2> "Plan", which started this thread with nexus_start:`, and one scripted answer |
| `17`, `18` Build 1 is told to call `nexus_start` | | `Tool nexus_start is not available`: a child has no drive tools |
| `19`, `20` the planner calls `nexus_read` on Build 1 | | Its status, attention, `parent`, pull requests, review, children and conversation |
| `21`, `22` the planner calls `nexus_wait` on Build 1 until `turn-ended` | | `"watch": "tool:18:call-22"`, `"delivered": false`, and the call returns at once |
| restart, `23` to `25` Build 1 ends another turn | | After the restart, the planner gets `[Nexus watch — automated, not a message from the person] Thread <thread 3> "Build 1", which you watched until turn-ended: its turn ended.` and answers it |
| restart, wait 32 s, `26` | | The planner holds `1 watch message(s)`: two more watch passes after a second restart sent nothing new |
| `tests-*.txt` | Both files fail to load: `Cannot find module '<checkout>/src/control/drive.ts'` | 16 of 16 pass |

The tests in `tests-branch.txt` are the ones the step's Verify sentence names, among others:

- `the drive tools answer while the thread's pylon is paused, where bash cannot run`. The locator refuses every pylon as paused. `nexus_start` and `nexus_read` answer, and `bash` in the same conversation answers `pylon-<id> is paused`;
- `a control plane killed mid nexus_start, after the child's row was written, starts no second thread`. A child process runs the control plane's drive wiring over real registry and harness files, and SIGKILLs itself in the start's `wake`, just after the transaction that wrote the child's row. The reopened harness runs the call again under the same request ID, which answers the thread the killed call wrote. There is one child, and its brief arrived once;
- `a watch whose message was sent just before the control plane was killed delivers once`. The child process SIGKILLs itself just after the watch's message was submitted and before the watch was saved delivered. After the restart the watch is still pending and the planner holds the message. The next pass saves it delivered and the planner still holds it once.

Each of these was checked to fail with its guard removed: with `replay: "unsafe"` or a request ID that changes per attempt the kill test fails, with a watch request ID that changes per send the watch test fails, and with `nexus_read` reading its environment the paused test fails. With the second cap check removed, `two starts at once for a parent's last place start one thread` fails.

## Not verified here

- A real pylon VM, a real model and the Mac's SOCKS path. The tools never reach the pylon, and the stand-ins replace only what they do not touch.
- A real pause on the stack. The loop pauses a pylon only after its idle timeout, so the paused case is the harness test's: a locator that refuses the pylon, as one that never wakes does.
- A kill mid-call on the stack. A kill from outside cannot land between the child's row and the tool's result reliably, so the kill is the harness test's, which kills the process at that point from inside.
- The turn snapshot. Every Nexus agent turn still waits for its pylon to wake to snapshot the checkout before the model answers, as on main, so a planning thread's turn waits for its pylon even though its tools do not. The stand-in refuses the snapshot at once, so the stack does not show the wait.
- The control plane's refusal of a grandchild, on the stack. A child's model has no drive tools to call, so the stack shows the tool missing. `src/control/drive.test.ts` drives the control plane's refusal directly.
