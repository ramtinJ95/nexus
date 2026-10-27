# Skip deleted threads' pylons that are gone

Issue #136: every reconcile pass ticked the pylon of every thread ever deleted, and the Claude conversation service kept a reader for every Claude thread it ever read. These captures count that work on main (82a703f) and on this branch with the same script.

## What the branch changes

A pass lists the node's pylons with `registry.pylonIdsToTick(node, present)`. That query leaves out a deleted thread's pylon only when a tick of it would change nothing:

- the node neither lists it nor routes a preview port to it (`present`, from the node's current observation),
- no job is sent for it (`submitted` is null),
- the registry keeps no preview port for it,
- no API retry is pending (`retrying` is 0),
- and its thread has no Claude launch left in `starting`.

For such a pylon, the old tick read it, rendered its LiveSpec, planned `done`, and released zero preview rows. If the node lists or routes the pylon again, it is back in the pass and is torn down again.

A Claude conversation reader now goes once its thread is deleted, nothing reads it and nothing watches it. Deleting a Claude thread through the API runs one read, which finds the thread deleted and lets the reader go.

## The work, main against branch

`node --no-warnings docs/verification/skip-deleted-pylons/count-pass-work.ts` drives the real `startLoop`, registry (SQLite in a temp dir), planner and ingest against a fake probe whose jobs finish at once. Each run seeds N deleted threads whose pylons the node no longer has, one active thread, and two deleted threads the node still holds: one whose pylon runs and one whose pylon is gone but still routes a preview port. It waits until the loop settles, asserts that each of the two still-held pylons got exactly one `delete` and no other pylon did, then counts the registry methods and probe calls of 50 passes through a Proxy. It then sends 10 snapshots and counts the pylon writes ingest makes for them.

The reader part reads, watches and stops N deleted Claude threads plus one active one, and reads the size of the service's `readers` Map from the heap with `v8.queryObjects`.

`main.txt` ran the script in a worktree of main and `branch.txt` ran it on this branch. Per pass, at 1000 deleted threads:

| | main | branch |
|---|---:|---:|
| pylon record reads | 1003 | 1 |
| thread reads | 1003 | 1 |
| project reads | 2005 | 1 |
| previews reads | 1003 | 1 |
| Claude worker reads | 1003 | 1 |
| `releasePreviews` deletes | 1002 | 0 |
| ms per pass | 257 | 1.8 |
| deletes sent to the two still-held pylons | 2 | 2 |
| pylon writes per snapshot | 0 | 0 |
| readers kept after 3000 deleted Claude threads | 3000 | 0 |

On main every column but the last two grows by one per deleted thread. On the branch they stay at the one active pylon's cost.

## What the numbers do not show

- The time per pass still grows a little on the branch (0.44 ms at 0, 1.8 ms at 1000), because the query still scans every pylon row on the node to leave the deleted ones out. Nothing past the query grows.
- The times come from one run on this pylon and are noisy. The counts are exact and the same on every run.
- Pylon saves are 0 on both sides here, because the project never changes. On main, a project change rewrote the LiveSpec of every deleted thread's pylon on the next pass. The branch leaves those records as they are. Nothing reads a deleted pylon's LiveSpec unless the node lists it again, and then it is ticked and rendered first.
- The runs used Node 24.22.1. The repo asks for Node 26, whose binary needs `libatomic.so.1`, which this pylon lacks and cannot install. The full suite passed on Node 24.22.1.
- The loop's `listed` set still keeps every pylon whose session list it wrote, deleted ones included. Removing a pylon from `listed` when its teardown finishes does not shrink it, so the branch does not do that. `follow()` builds ingest's `known` from every pylon on the node. The next snapshot sees the removed pylon as absent and unlisted, so ingest writes its empty session list and `follow()` adds it back to `listed`. Shrinking the set needs `known` to leave the same pylons out, which is in `follow()`, which #141 also changes.

## Behaviour

The tests below pin what a person or the node would see. `new-tests-main.txt` runs them against main's code and `new-tests-branch.txt` against the branch. They pass on both, so they pin behaviour that main already had:

- a deleted thread's pylon that is gone is torn down again whenever its node lists or routes it again,
- a deleted thread's ports go back after a restart between its delete and their release,
- a deleted thread whose Claude launch was cut off has the launch failed, though its pylon is gone,
- and the existing deleted-thread tests.

`src/control/claude-conversation.test.ts` pins the reader's lifecycle against a probe whose transcript reads wait until the test ends them:

- a read that ends after the service and its registry closed settles without touching the registry,
- a deleted thread's reader stays while a read runs, so a refresh meanwhile waits for it,
- a watch of a deleted thread keeps its reader, so closing the service still ends the watch,
- and a deleted thread's reader goes once its last read and its last watch end, while an active thread's stays.

`mutations.sh` removes each clause of the query, and each guard and call of the reader's release, in turn, and runs those tests. Each removal fails at least one test (`mutations.txt`). The `retrying` clause has no test. The API refuses a retry of a deleted thread's pylon, so the clause covers only a retry made just before the delete.

The full suite, `npm test`, passed with 1208 tests on the branch rebased onto cf2558c, and `npm run typecheck` passed.
