# Follow skips no-op work verification

Verified in this task's pylon on 2026-10-27, on branch `perf/follow-skip-noops`, against main at 82a703f, with Node
v24.22.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/follow-skip-noops/run.sh origin/main HEAD
```

`run.sh` checks out both commits into two worktrees, copies `measure.ts` into each and runs it there, so the two runs
differ only by the code under test. Each run's output lands in `main/` or `branch/`, with the commit in `commit.txt`.
`compare.ts` prints the table below into `compare.txt` and exits non-zero if the two runs end in different state.

`measure.ts` starts the real `startLoop` with the real registry, on a SQLite file, and the real `ingest`. A scripted
probe feeds it one simulated hour of a node with ten running pylons. Each minute brings ten session reports and a
snapshot carrying the journal's last 100 reports. Every other minute brings a preview hit. Every five minutes a job
runs: two job events, a pylon event and a snapshot. At minute 30 the observe stream ends and the loop reconnects on
its own, so the run spans two observe connections. The 50 reports of minutes 30 to 34 reach control only through the
journal in the snapshot that opens the second one. The clock is frozen, so both runs store the same times.

The counts cover registry calls whose direct caller is `follow()`, and the SQL statements, transactions and
observation writes those calls run. The registry methods are wrapped and `StatementSync` and `exec` are patched, the
same way on both checkouts.

## Work done

`compare.txt`:

| follow() work | main | branch | change |
|---|---:|---:|---:|
| registry.node reads | 678 | 678 | 0% |
| pylonIdsOn reads, one per `known` built | 678 | 106 | -84% |
| reportSession calls, each a zod parse and a pylon lookup | 6670 | 600 | -91% |
| eventReceipt reads | 0 | 68 | new |
| ingested calls | 678 | 678 | 0% |
| BEGIN IMMEDIATE transactions | 7348 | 728 | -90% |
| node observation UPDATEs | 678 | 79 | -88% |
| observation JSON written, bytes | 11340554 | 1318296 | -88% |
| SQL statements run | 45046 | 18563 | -59% |

Every branch number matches the stream. The 600 reportSession calls are the 550 live reports plus the 50 the
reconnect snapshot brought. The 106 `known` builds are 68 snapshots, 11 pylon events and 27 preview hits. The 79
observation writes are the snapshots and pylon events, the only events that change the observation. Main's 6670
reportSession calls are the 550 live reports plus 6120 journal reports replayed from snapshots. The 728 transactions
are the 600 reports plus the 128 non-session events whose writes still apply. A session event's `ingested` call has
no observation and no writes, so it opens no transaction.

## Nothing observable changed

`main/state.json` and `branch/state.json` dump every registry table after the stream, except `pylons`, whose stored
job envelopes carry random IDs drawn by the ticks. They are identical, and so are the loop logs. That covers threads,
attention, session activity and order, the event stream, jobs, the node row and its stored observation, and the
event receipt. As a check that this comparison can fail, a mutant that filters `report.sequence > receipt + 1` was
run through `run.sh` and ended `DIFFERENT`.

`tests-main.txt` runs `src/control/loop.test.ts` at a3c41b8, which adds two behaviour tests on top of main's code. Both
pass there, so they pin behaviour main already had:

- A snapshot's journal applies each report past the node's receipt, in order, including the one right after it.
  Replayed reports change nothing, and a live report after a replay still applies. The `receipt + 1` mutant fails it.
- Preview-hit and session events still apply their writes, and after them and a job event the stored observation is
  the one the last snapshot stored.

`tests-branch.txt` is the typecheck and the full suite on the branch: 1182 of 1182 pass. One existing test changed. It
asserted `known` on every event, and job events now get an empty `known`, which ingest never reads for them. It now
asserts `known` on the snapshots it records.

## Not verified

- Wall time. The table counts operations, not milliseconds. A SQLite file in a pylon on one machine says little about
  the production disk, so no timing is reported.
- A live probe. The stream is scripted. Its shape follows `src/probe/server.ts`, but its event mix is a guess at a busy
  node, not a capture from one.
- `reconcilePreviews` and the passes `follow()` wakes are not counted. Neither changed.
- PR watch was left as it is. See the pull request.
