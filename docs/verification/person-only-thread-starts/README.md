# Person-only thread starts and messages

Verified in this thread's pylon on 2026-10-28, on branch `fix/person-only-thread-starts` against main at `8a94974`, with Node 26.12.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/person-only-thread-starts/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `capture.ts` into each, builds the dashboard and runs it there, into `main.txt` and `branch.txt`. Thread IDs read `<thread>` and times `<time>`.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `capture.ts` runs the real `startApi` of the checkout under test with a real pi-durable harness over the scripted model and no pylon, as `src/control/stream.check.ts` does, and drives it with the real `nexus` CLI (`NEXUS_URL`, `NEXUS_SOCKS=none`). whois names the caller each step says: the person's laptop `nLAPTOP`, the control node `nFIREBAT`, or the infrastructure node `nTESTBENCH`. A pylon's request would reach the API as its node, so the two nodes stand for pylons too.

## Main and this branch

| Step | main | this branch |
|---|---|---|
| `start`, `send`, `conversation` as the laptop | exit 0, the scripted answer | exit 0, the scripted answer |
| `start` and `send` as the control node | exit 0, a thread started by `nFIREBAT` | exit 3, `caller may not start a thread` and `caller may not message a thread` |
| `start` and `send` as an infrastructure node | exit 0, a thread started by `nTESTBENCH` | exit 3, as for the control node |

`start-queued` needs the control plane's GitHub token, which this stack has no use for, so only `src/control/api.test.ts` covers it.
