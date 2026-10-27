# Queued threads

Verified in this task's pylon on 2026-10-27, on branch `feat/queued-threads` against main at `cf2558c`, with Node 24.22.1 and headless Chromium from `@sparticuz/chromium`. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs `stack.ts drive` there. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same file and the same steps, so the captures differ only by the code under test.

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=/tmp/lib FONTCONFIG_PATH=/tmp \
  docs/verification/queued-threads/run.sh origin/main HEAD
```

`/tmp/lib` and `/tmp/fonts.conf` are what `al2023.tar.br` and `fonts.tar.br` in `@sparticuz/chromium/bin` unpack to, after brotli and tar.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` runs the real `startControlPlane` from the checkout under test in one child process: the registry, loop, harness, PR watch, review loop, queue, API and dashboard. It runs the real probe server in another child process, so a control plane restart is a process exit and the registry file survives it. Every command goes through the real `nexus` CLI (`NEXUS_URL`, `NEXUS_SOCKS=none`), and every page through headless Chromium. Only the production boundaries are stand-ins:

- tailscaled's whois is a socket in the run's folder;
- the model is the scripted one (`src/harness/test-fixture.ts`), which answers a plain message with `scripted answer after user`;
- GitHub is an HTTP server in the driver, reached by rewriting the control plane's `fetch` to `api.github.com`. It serves the PR watch's reads over four pull requests the driver opens, merges and closes. `github.log` has every request;
- the VM backend boots nothing and logs each pylon it is asked to boot to `backend.log`. Its guest answers the probe's git read with the branch the driver says the agent pushed, which is how the PR watch links each `A` thread to its pull request, and runs the pi-env daemon from `node_modules` for the harness, so a started thread's first message gets its scripted answer. It reads no checkout, so the dashboard's Changes panel shows that read's error.

The driver starts four threads, A1 to A4, on project `wave`, pushes a branch for each and opens PR #1 to #4. It queues B1 after A1, B2 after A2, C after A3 and D after A4, each with a first message. Then:

1. It waits for the PR watch to link the pull requests, then merges PR #1 and closes PR #2 without merging.
2. It runs `nexus start-queued` on B2, and clicks Archive on D's dashboard page.
3. It restarts the control plane while C waits, stops it, merges PR #3 while it is down, and starts it again. A page left open on C stays open throughout. Once C has started, it restarts the control plane once more.

## Main (`main/`) and this branch (`branch/`)

| Step | main, cf2558c | this branch |
|---|---|---|
| `07-queue-b1.txt`, `start --after A1 --message ...` | exit 64, `Unknown option '--after'` | exit 0, a `QueuedThread` with `"status": "queued"` and the wait `has no pull request yet` |
| `backend.log` right after queueing | the four A pylons | the four A pylons only. No queued thread booted a pylon |
| `11-threads-queued.txt`, `threads` | A1 to A4 | A1 to A4, then B1, B2, C and D as `queued`, each with `waits for <A>: has no pull request yet` and `node node-a` |
| `13-show-b1-waiting.txt` once PR #1 is linked | exit 4, no thread | `status: queued`, `waits for <A1>: PR #1 is open` |
| `home-queued.png` | the four A threads | the A threads, and a Queued table: each queued thread, what it waits for and its node. The sidebar lists them as `queued` |
| `b1-queued.png` | not taken: there is no B1 | B1's page: "Starts once these threads' pull requests merge", A1's PR #1 open, what it starts with, Start now and Archive |
| After PR #1 merged (`timeline.txt`) | nothing starts | `backend: booted pylon-<B1>` 115 s after the merge, the PR watch's 2-minute read plus one queue pass |
| `16-show-b1-started.txt`, `17-conversation-b1.txt` | exit 4 | a normal thread: `status: active`, `placement: node-a, the project's default node`, and its conversation is the queued message and `scripted answer after user` |
| `18-show-b2-blocked.txt` after PR #2 closed | exit 4 | `status: blocked`, `blocked by <A2>: PR #2 closed without merging`, and `nexus start-queued <B2> starts it now; nexus archive <B2> cancels it.` |
| `home-blocked.png`, `b2-blocked.png` | the A threads | B1 now an ordinary row, B2 `blocked` in red in the sidebar, the overview and its own page with the reason |
| `19-start-queued-b2.txt` | exit 64, `unknown command start-queued` | exit 0, `Started <B2> on wave: B2: build on A2`, and `backend: booted pylon-<B2>` at the same moment |
| `21-show-d-cancelled.txt` after Archive on D's page | exit 4 | `status: cancelled`, `nexus unarchive <D> queues it again.` |
| `22-show-c-after-restart.txt` | exit 4 | after a control plane restart, C is still `queued`, `waits for <A3>: PR #3 is open` |
| PR #3 merged while the control plane was down | nothing | C booted 16 s after the control plane came back, on its first PR watch read and queue pass |
| `c-page-left-open.png` | not taken | the page opened on C while it was queued, never navigated, reloaded itself into C's thread page with its conversation |
| `23-show-c-started.txt`, `24-conversation-c.txt` after one more restart | exit 4 | C is a normal thread, one user message and one answer |
| `25-threads-all.txt`, `26-threads-all-json.txt` | four A threads | seven threads and D `cancelled` in the text. The JSON is the unchanged `ThreadRow[]`, seven rows, with no queued thread in it |
| `backend.log` at the end | four boots | B1, B2 and C booted once each, across three control plane restarts. D, cancelled, never booted |

## Unit tests

`tests-main.txt` is the branch's queue, PR watch, registry, API, CLI and dashboard tests run against main's code. On main, `queue.test.ts`, `pr-watch.test.ts`, `api.test.ts`, `nexus.test.ts` and `dashboard.test.ts` fail to load, since they import the queue or test its routes and commands. The registry's queued-start test fails, and so does the one downgrade test that counts the migrations after it. `tests-branch.txt` is the same files on the branch, all passing. The full suite passes on the branch, 1223 tests.

## What this does not prove

- Real GitHub, and a pull request landed by the review loop. The merge here is made outside any review, which the PR watch reads. A review that lands its pull request records `merged`, which `queue.test.ts` covers.
- A real deploy's drain. `queue.test.ts` covers a start refused while the gate drains, left queued with its reason, and started on the next pass. The restarts here are process exits with no drain.
- A crash in the middle of a start. `registry.test.ts` and `queue.test.ts` cover the transaction that refuses a second start, an archive while a start is in flight, and a first message sent again under the same request ID after a crash.
- A pylon VM, a real model, a Claude worker queued with `--claude`, and an `auto` thread waiting for room. Unit tests cover the last two.
