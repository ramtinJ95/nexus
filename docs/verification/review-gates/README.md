# Review gates, PR watch and GitHub client verification

Verified in this task's pylon on 2026-10-30, on branch `simplify/w6-review-gates`, against main at 78d75d0. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
docs/verification/review-gates/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs the stack. Each run writes `run.txt` and `github.log` to `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same `stack.ts`, so the captures differ only by the code under test.

`stack.ts` runs the real registry, API, GitHub client, PR watch, inbox and review loop as `src/control/main.ts` wires them. One builder pushed two branches with an open PR each, #185 and #186. GitHub is a fetch handler behind the real `githubClient` that answers every request after 100 ms with an ETag. The review of #185 starts at the merge step, where the real merge policy holds it for the person, because it adds a registry migration. The stack then moves #185 to a new head and back.

## What was checked

| Step | main | branch |
|---|---|---|
| The PR watch's first pass | Its 2 PR reads went one at a time, and the pass took 617 ms. | Its 2 PR reads were in flight together, and the pass took 340 ms. `github.log` shows `/pulls/186` and `/pulls/185` requested in the same millisecond. |
| Both links read | `[[186,true],[185,true]]` | The same. |
| The held review, as `GET /v1/threads/<builder>` returns it | `needs-person` with the reserved hold, no `cause`. | The same, with `cause: "policy"`. |
| A push to #185 | A new round, `reviewing` at `b3ee8a6`. | The same. |
| A force-push back to `103598e` | The PR watch asks for the old head's check runs with `If-None-Match`. | It asks without one, since the move to `b3ee8a6` dropped them from the cache. |
| `prWatch.stopped` | `false` | `false` |
