# Registry reads verification

Verified in this task's pylon on 2026-10-29, on branch `simplify/w1-registry-reads`, against main at c5168d6, with
Node v26.12.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/registry-reads/run.sh origin/main HEAD 300
```

`run.sh` checks out both commits into two worktrees, copies `measure.ts` and the branch's `registry.test.ts`,
`activity.test.ts` and `host.test.ts` into each, and runs them there, so the two runs differ only by the code under
test. It writes `main.txt`, `branch.txt`, `compare.txt`, `tests-main.txt` and `tests-branch.txt` here.

`measure.ts` opens the real registry on a SQLite file and seeds 300 threads on one node. Every third thread is a
Claude worker with a 20-entry transcript, every fifth has a live session turn, every seventh a waiting session, and
every fourth is deleted. The node's observation lists every live pylon. `StatementSync`'s `get`, `all`, `run` and
`iterate` are patched to count, the same way on both checkouts. It then calls the real `threads()`, `thread(id)`,
`nodePylons`, `roomLeft` and the locator's `awaitRunning`. It also runs what `main.ts` reads at start to open the
harness: on main `threads()` and `agent()` per thread, on the branch `harnessThreads()`. The branch records each abort
the first start makes, as `onAborted` does, before the second read. Last, it tracks one conversation with the real
`trackActivity` through 200 `pi.live` changes, a park and a retry.

## Statements and reports

`compare.txt`:

| read | main | branch |
|---|---:|---:|
| threads(), 300 threads | 1226 | 6 |
| thread(id) for each of them | 1525 | 1525 |
| nodePylons, 225 observed pylons | 1375 | 1 |
| roomLeft | 1526 | 7 |
| locator poll of a running pylon | 8 | 3 |
| start-up read | 1526 | 1 |
| deleted conversations the first start aborts | 50 | 50 |
| deleted conversations the next start aborts | 50 | 0 |
| onParked calls over track, 200 pi.live changes, a park and a retry | 203 | 3 |

`threads()` on main runs one SELECT and then three to five statements per thread: two `session_activity` reads, the
usage backfill read, and for a Claude worker with no live turn the worker join and its newest 16 entries. On the
branch it runs the SELECT and five reads for the whole set, the last two only because some threads are Claude
workers with no live turn. One `thread(id)` costs the same on both, since it is the same set of reads over one thread.
The per-row callers stop paying it: `nodePylons` is one join, `roomLeft` one pylon read, one thread read and the five
batched reads, and the start-up read one SELECT.

## New tests

`tests-main.txt` and `tests-branch.txt` hold the seven tests this branch adds. Three are pins of behaviour that holds
on both checkouts: `threads()` deep-equals `thread(id)` for every kind of session fact, `setDrain(null)` reads back
null, and the node tallies and room for an up, paused, waking, unreported, archived, reading, crashed, failed and
orphaned pylon. Four fail on main and pass on the branch: `storedThreads` and `threadStatus`, the start-up harness
read that leaves out a recorded abort, `onAborted` at open and at a delete, and `onParked` reporting only flips.
