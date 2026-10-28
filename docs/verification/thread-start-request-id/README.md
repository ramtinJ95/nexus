# Retry-safe thread starts

Verified in this thread's pylon on 2026-10-28, on branch `feat/thread-start-request-id` against main at `716a624`, with Node 24.22.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/thread-start-request-id/run.sh origin/main 455667a
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs `stack.ts drive` there. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt` and every step in `timeline.txt`. Both runs use the same file and the same steps, so the captures differ only by the code under test. Then it runs the branch's request ID tests from `src/control/api.test.ts`, with the branch's fake harness, against each checkout's code, into `tests-main.txt` and `tests-branch.txt`.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` runs the real `startControlPlane` from the checkout under test in one child process: the registry, loop, harness and API. It runs the real probe server in another, so a control plane restart is a process exit and the registry file survives it. Every start goes through the real `nexus` CLI (`NEXUS_URL`, `NEXUS_SOCKS=none`), and the raw repeats through `fetch`. Only the production boundaries are stand-ins:

- tailscaled's whois is a socket in the run's folder;
- the model is the scripted one (`src/harness/test-fixture.ts`), which answers a plain message with `scripted answer after user`;
- the VM backend boots nothing. Its guest runs the pi-env daemon from `node_modules` for the harness, so a thread's first message reaches the real pi-durable conversation and gets the scripted answer.

A proxy in the driver, on port 7471, forwards a request to the API, waits for the API's answer, and hangs up without passing it on. That is a connection that drops after the control plane acted, the case a client cannot tell from one that never arrived.

Thread IDs are random, so the captures name each thread by the order it first appeared, as `<thread 1>`, and replace times with `<time>`.

## Main (`main/`) and this branch (`branch/`)

| Step | main, 716a624 | this branch, 455667a |
|---|---|---|
| `03` `start --message ... --request-id start:lost-answer` through the proxy | exit 64, `Unknown option '--request-id'` | exit 2, `socket hang up`. The control plane started the thread and sent its first message |
| `04`, `05` the same command again direct, then once more after a control plane restart | exit 64 | exit 0 both times, the same `<thread 1>` |
| `06` threads and conversations | 0 threads | 1 thread, whose conversation holds `> Fix the flaky checkout test` once and one scripted answer |
| `07` the same request ID, another `--message` | exit 64 | exit 5, `request ID start:lost-answer started thread <thread 1> with another body` |
| `08`, `09` `POST /v1/threads` with `requestId`, twice | HTTP 400, `Unrecognized key: "requestId"` | HTTP 201 both times, the same `<thread 2>` |
| `10` the same `requestId`, another title | HTTP 400 | HTTP 409, `request ID start:api started thread <thread 2> with another body` |
| `11`, `12` `start --message "Tidy the docs"` without a request ID, through the proxy, then again direct | exit 2, then exit 0. Two threads | exit 2, then exit 0. Two threads |
| `13` threads and conversations at the end | `Tidy the docs` twice. The first has `No messages yet.`: the CLI sent its first message in a second request, which the lost answer stopped | 4 threads. Each has its first message once and one scripted answer. The two `Tidy the docs` threads are the retry without a request ID |
| `tests-*.txt`, the request ID tests in `api.test.ts` | the 4 new tests fail (3 failed, 1 cancelled at the 30 s timeout), and the 2 older Claude send tests pass | all 6 pass |

So a retried start with a request ID makes one thread with one first message, and a start whose answer was lost no longer leaves a thread without its brief, even without a request ID. A retry without a request ID still makes a second thread, by design: only the client can say that two starts are the same.

## Not verified here

- A real pylon VM, a real model and the Mac's SOCKS path. The stand-ins replace them, and none of them takes part in deduplicating a start.
- A retry while the first start is still in flight, on the stack. The API test `starts repeated at once under one request ID start one thread` holds the first start in its setup read to cover it, and fails on the branch with the in-flight sharing removed.
