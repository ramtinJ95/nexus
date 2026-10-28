# Held review, new head verification

Verified in this task's pylon on 2026-10-28, on branch `fix/held-review-new-head`, against main at 5666156, with headless Chromium 143. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test.

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=/tmp/fonts \
  docs/verification/held-review-new-head/run.sh origin/main HEAD
```

`stack.ts` runs the real registry, API, dashboard, PR watch, inbox and review loop as `src/control/main.ts` wires them, on plain HTTP at 127.0.0.1:7470 for a deployer. It replays #185 of 2026-10-28. Review `rv-e94f1556` approved PR #185 at `103598e…`, its check passed, and it starts at the merge step, where the real merge policy holds it for the person because it adds a registry migration. Only what a pylon cannot host is a stand-in:

- GitHub is a fetch handler behind the real `githubClient`. The driver moves PR #185 to the rebased head `b3ee8a6…` (`github.log`).
- The reviewer is a harness thread in the fake harness, which approves every head it is sent (`reviewer.log`).
- `.nexus/check` passes 2 seconds after it starts (`check.log`).
- The PR watch reads GitHub only when the driver asks, and the driver can pause the review loop, so it can capture the page after the push, after the watch's read, and after the loop's next pass.

## What was checked

| Step | main | branch |
|---|---|---|
| Held at `103598e…` | `01-held.png`: Held for you, Land #185 at `103598e…`. | The same. |
| Pushed, before the watch reads | `02-pushed-before-the-watch-reads.png`: Land #185 at `103598e…`. | The same. Nothing has read the push yet. |
| The watch read `b3ee8a6…`, before the loop's pass | `03-watch-read-before-the-loop.png`: Land #185 at `103598e…`. | No Land button. The card says the head is now `b3ee8a6…`, so `103598e…` no longer lands. |
| The loop's next pass | `04-after-the-loop.png`, `04-show.txt`: still `needs-person`, round 1, at `103598e…`. | `reviewing`, round 2, at `b3ee8a6…`. `reviewer.log`: the reviewer was told new commits were pushed after it approved `103598e…`. |
| Once the round ends | `05-held-again.png`, `05-show.txt`: unchanged. | `05-held-again.png`: held again with the same reserved hold, Land #185 at `b3ee8a6…`, and the note that a new round reviews `b3ee8a6…` because the head moved. `check.log`: the check ran at `b3ee8a6…`. |
| `review.changed` events | `06-events-review.txt`: merging, then needs-person. | merging, needs-person, then reviewing, checking, merging and needs-person in round 2. |

`branch/05-show.txt` prints:

```
review rv-e94f1556 of PR #185: needs-person, round 2 of 5, reviewer th-… on gpt-6-astra, landing when approved
a new round reviews b3ee8a600000, since the pull request's head moved from 103598e00000 after its approval
no live check: b3ee8a600000 has no .nexus/verify, so the landing reads the pull request's statement of what could not be checked live
needs you: Always needs the person: anything irreversible, as it changes src/control/registry.ts.
```

## What this does not prove

- Real GitHub, a real reviewer, a real check pylon, and the PR watch's two-minute timing. On the live control plane, the old head's Land stays on the card from the push until the watch's next read, up to two minutes. A Land pressed in that window merges nothing, since the landing reads the moved head from GitHub and starts the round, as #181 showed. Only the live control plane can show the timing end to end.
- The out-of-rounds hold and the deploy hold. `src/control/review.test.ts` covers both.
