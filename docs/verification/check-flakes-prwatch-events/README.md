# A transient check reruns, and the PR watch's errors are events

Verified in this task's pylon on 2026-10-29, on branch `fix/check-flakes-prwatch-events` at eeb464f (code, docs and this script; the capture's own commit follows it), against main at 87d7e0d. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
docs/verification/check-flakes-prwatch-events/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into worktrees, copies `stack.ts` and `drive.mjs` into each, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test. For each run it also:

- runs that commit's own `.nexus/check` in a clean worktree with no `node_modules`, with npm's registry at a port that refuses connections and its fetch retries off, into `check.txt`;
- runs the branch's three new tests against that commit's code, into `tests.txt`.

`stack.ts` runs the real registry, API, PR watch, inbox and thread queue, wired as `src/control/main.ts` wires them, with the real `githubClient`, on 127.0.0.1:7470. GitHub is a fetch handler that the drive can make throw a transport error holding the token, for every request or only for the search of every PR on a branch, which only the PR watch's read for a queued thread makes. Builders are Claude workers with no Claude Code: each pushes the branch its prompt names. The PR watch polls every 2 s, instead of every 2 minutes.

`drive.mjs` uses only the Mac CLI, the same steps on both runs:

1. A follower starts with `nexus events --follow --since latest --kind pull-request.error --kind pull-request.error-cleared --json`.
2. A builder starts and pushes a branch, which opens a PR.
3. Every GitHub request fails for at least 6 s, three or more watch passes, then GitHub recovers.
4. A thread is queued with `start --after` the builder, and the builder is archived, so only the queued thread's read of its PR runs for it.
5. That read fails for at least 6 s, then recovers.
6. The follower stops, and `nexus events` runs with the same kinds.

## What was checked

| Capture | main | branch |
|---|---|---|
| `check.txt` | `npm ci` fails with `ECONNREFUSED`, exit 1, which the gate would call a failed check | the same failure, exit 75 |
| `follow-errors.txt` | exit 64: `unknown event kind` | 4 events, exit 0 by Ctrl-C |
| `07-events-errors.txt` (branch), `drive.log` | no events, and `show` never reports the archived builder's error: the failed read for the queued thread was dropped | `pull-request.error` once per outage however many passes failed, then `pull-request.error-cleared` once it recovered, for both outages |
| `03-show-failing.txt` | the retry notice | the retry notice |
| `06-show-settle-failing.txt` | no error | the queued thread's retry notice |
| `drive.log` | | no event holds the token or `ETIMEDOUT` |
| `tests.txt` | the three new tests fail | they pass |

The branch's `nexus events`:

```
2 2026-10-29T15:43:38.099Z th-caa7dc21f076 pull-request.error {"error":"PR watch could not read GitHub or deliver its message; it will retry."}
3 2026-10-29T15:43:46.105Z th-caa7dc21f076 pull-request.error-cleared {}
4 2026-10-29T15:43:48.100Z th-caa7dc21f076 pull-request.error {"error":"PR watch could not read the pull requests a queued thread waits for; it will retry."}
5 2026-10-29T15:43:56.100Z th-caa7dc21f076 pull-request.error-cleared {}
```

## Not checked live

- The review loop rerunning a check that exits 75 in a real check pylon. The capture shows the real `.nexus/check` exits 75 on a registry failure, and the gate test shows the gate voids such a run, deletes its thread, and makes the third in a row at a head unrunnable. That the loop starts a fresh check thread for a void run is `review.ts`'s existing behaviour, which this change does not touch. No stack here boots check pylons: Docker is not available in this pylon, so the verify-nexus stack could not run.
- A real registry timeout. The capture refuses the connection instead, which npm reports the same way, with a nonzero exit.
- Real GitHub. The fake answers only the reads the PR watch makes.
