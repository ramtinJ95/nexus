# Observation reads verification

Verified in this task's pylon on 2026-10-30, on branch `simplify/w2-observation-reads`, against main at b636ea9, with
Node v26.12.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/observation-reads/run.sh origin/main HEAD 50
```

`run.sh` checks out both commits into two worktrees, copies `measure.ts` and the branch's `observed.test.ts`,
`peers.test.ts`, `loop.test.ts`, `registry.test.ts` and `usage.test.ts` into each, and runs them there, so the two
runs differ only by the code under test. It writes `main.txt`, `branch.txt`, `compare.txt`, `tests-main.txt` and
`tests-branch.txt` here.

`measure.ts` opens the real registry on a SQLite file and counts the rows that `SELECT * FROM nodes` statements return,
each of which parses the node's whole observation, and the rows read from `usage_cursors`. It runs the real loop and
ingest against a probe that sends one snapshot of 50 running pylons, each with a service that wants a preview, and 5
pylons the registry does not know, then holds the stream open and refuses every job. It runs the real peers handoff
over 10 nodes, each storing an observation of 50 pylons. It runs the real usage counter over 200 harness threads, each
with a cursor, every fourth deleted. Last, it ingests a snapshot with one unknown pylon and looks for the orphans table.

## Reads

`compare.txt`:

| measure | main | branch |
|---|---|---|
| observation bytes | 19392 | 19392 |
| node rows read from start until 50 pylons have previews | 354 | 1 |
| node rows read by one pass over 50 running pylons | 151 | 0 |
| orphans listed by nodePylons | pylon-stray-0 … pylon-stray-4 | pylon-stray-0 … pylon-stray-4 |
| node rows read to put 10 nodes their peers | 90 | 0 |
| puts of an unchanged list over two snapshots | 2 | 2 |
| harness reads by one sweep of 200 threads, 50 deleted | 200 | 150 |
| usage cursor rows loaded by that sweep | 40000 | 150 |
| orphans table | 1 rows | absent |

On main a pass reads the node's row three times per pylon, in `withLive`, in the tick's context and in `previews`, and
once more for the pass. On the branch the loop reads the row once, when it starts following the node, and keeps the
observation it stores. The orphans the dashboard and `GET /v1/nodes` list come from the observation on both, so they
are the same. A probe still gets its peers on every snapshot, unchanged or not.

## New tests

`tests-main.txt` and `tests-branch.txt` hold the six tests this branch adds. Five fail on main and pass on the
branch. `observed.test.ts` fails on main because `observed.ts` does not exist there. The sixth is a pin that holds on
both: a deleted thread's harness read that is in flight through a sweep keeps its one-at-a-time flight. Main never
forgets a read, and the branch forgets only reads that are not in flight.
