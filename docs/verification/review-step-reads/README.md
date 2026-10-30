# Review step reads verification

Verified in this task's pylon on 2026-10-30, on branch `simplify/w4-review-reads`, against main at c91b4db. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs the stack, which drives itself and exits. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same file, so the captures differ only by the code under test.

```sh
docs/verification/review-step-reads/run.sh origin/main HEAD
```

`stack.ts` runs the real registry, API, inbox, GitHub client, review loop, PR watch, nudge, usage-limit and judgment passes, on plain HTTP at 127.0.0.1:7471. It runs each pass by hand and counts what it reads through the registry and at GitHub's fetch boundary. Only what a pylon cannot host is a stand-in:

- GitHub is a fetch handler behind the real `githubClient`. Each GET of `/pulls/<n>` is one read of PR n.
- The reviewer is a harness thread in the fake harness. It requests changes in round 1 and approves round 2, 200 ms after each request.
- A Claude builder's pylon. The stand-in answers what the loop types 200 ms later, with transcript entries written into the registry as the control plane's transcript read writes them, and pushes a new head.

The stack has a running review of #301, a review of #302 held for the person whose PR watch stopped at its comment cap, and 20 archived and 20 deleted threads.

## What was checked

`passes.log` has one line per review pass, 1 s apart. `archived.log` has one pass of each periodic loop.

| What | main | branch |
|---|---|---|
| Pass 2: the reviewer's changes go to the builder, whose message is stamped and then sent | 2 reads of #301 | 1 |
| Pass 3: the builder's answer and push are read, and the next round goes to the reviewer | 3 reads of #301, 2 reads of the builder's transcript | 1 and 1 |
| Pass 4: the approval, the check and its end | 3 reads of #301 | 1 |
| #302, held under a capped PR watch, over passes 1 to 8 | 1 read every pass | none after the read in the start's pass |
| Thread rows built by each of the nudge, usage-limit, judgment, PR watch and review passes | 44 | 0 |
| Reads of the 40 archived and deleted threads by the nudge, usage-limit, judgment and PR watch passes | 40 each | 0 |

The reviewer's conversation is opened once in pass 2 and once in pass 4, the passes after it replied, on both. Passes 5 to 8 read #301 once on both: the stack polls the PR watch once at the start, so its head of #301 is older than the review's latest round, and the loop asks GitHub before it acts on it.

## What this does not prove

- Real GitHub, a real Claude Code session and a real harness conversation. The stand-ins answer as those do, and the counts are of the calls the control plane makes to them.
- The two-minute interval. The stack runs 8 passes in 8 seconds, inside one interval. `src/control/review.test.ts` drives the read after the interval with a fake clock.
- How long a pass takes with many threads. The stack counts reads, not time.
