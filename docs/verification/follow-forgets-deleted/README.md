# Follow forgets deleted pylons verification

Verified in this task's pylon on 2026-10-29, on branch `fix/bootstrap-deployer-loop-listed`, against main at 87d7e0d,
with Node v26.12.1. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
docs/verification/follow-forgets-deleted/run.sh origin/main HEAD
```

This is [follow-skip-noops](../follow-skip-noops/README.md)' harness with deleted threads added. `run.sh` checks out
both commits into two worktrees, copies `measure.ts` into each and runs it there. Each run's output lands in `main/` or
`branch/`. `compare.ts` prints the table below into `compare.txt` and exits non-zero if the two runs end in different
state.

`measure.ts` feeds the real `startLoop`, registry and `ingest` the same simulated hour as follow-skip-noops, with three
changes:

- The registry also holds 300 threads that were deleted before the control plane started. The node lists none of
  their pylons.
- At minute 20, five of the ten running threads are deleted, and the node stops listing their pylons.
- Each snapshot lists the jobs the passes submitted as finished. Without this, every pylon keeps an unsettled spawn
  and stays one the pass must tick, so none would ever leave `known`.

A wrapper around `ingest` counts the `known` entries it reads and the sessions writes it returns. It also reads the
size of `listed`, which is `known` less `unlisted` when follow() calls ingest.

## Work done

`compare.txt`:

| follow() work | main | branch | change |
|---|---:|---:|---:|
| pylon ID reads, one per `known` built | 90 | 90 | 0% |
| `known` entries ingest read, over all events | 27900 | 666 | -98% |
| sessions writes | 317 | 17 | -95% |
| most pylons in `listed` | 310 | 10 | -97% |
| pylons in `listed` at the end | 310 | 5 | -98% |
| BEGIN IMMEDIATE transactions | 504 | 504 | 0% |
| SQL statements run | 20955 | 20655 | -1% |

On main, every `known` holds all 310 pylons the node ever had, so 90 builds read 27900 entries. On the branch, a
deleted thread's pylon is in `known` only while the node lists it or something is left to tear down. On main,
`listed` takes in all 310 pylons and keeps them. Each of the 300 historical pylons costs one empty sessions write
after the start, so main does 300 more sessions writes. On the branch, `listed` holds at most the ten live pylons. It
ends at five, after the five deleted pylons' delete jobs settle.

## Nothing observable changed

`main/state.json` and `branch/state.json` dump every registry table after the stream, and they are identical. Four
things are left out. The `pylons` and `jobs` tables and the node's stored `jobs` hold random job IDs. `usage_since`
holds the wall-clock time that SQLite set when the registry was made. The loop logs are identical too.

As a check that the comparison can fail, a mutant that leaves every deleted thread's pylon out of `known` was run
through `run.sh`. It ended `DIFFERENT`, because the five pylons deleted at minute 20 kept their session rows.

## Not verified

- Wall time. The table counts operations, not milliseconds.
- A live probe. The stream is scripted.
