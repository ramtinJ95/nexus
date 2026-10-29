# Review model failures verification

Verified in this task's pylon on 2026-10-29, on branch `fix/review-model-failures`, against main at c3cff81. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs the stack, which drives itself and exits. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same file, so the captures differ only by the code under test.

```sh
docs/verification/review-model-failures/run.sh origin/main HEAD
```

`stack.ts` runs the real registry, API, PR watch, inbox and review loop as `src/control/main.ts` wires them, on plain HTTP at 127.0.0.1:7470. Only what a pylon cannot host is a stand-in:

- GitHub is a fetch handler behind the real `githubClient`.
- The reviewer is a harness thread in the fake harness. A failed turn pushes four assistant messages with `stopReason: "error"` and `errorMessage: "Request timed out."`, as each of rv-c9d7b72d's three turns had, and reports the turn's end (`reviewer.log`).
- A Claude builder's pylon. What the loop types into the session goes to `builder.log`. A failed turn writes the prompt, the entries `parseRecord` makes of the 529 record in `src/fixtures/claude-api-errors.jsonl`, which is a real Claude Code synthetic assistant record, and a turn record, then records the turn's end as the StopFailure hook's `session.turn-ended` does.
- `.nexus/check` passes at once (`check.log`).
- The clock. The loop's `now`, the turn ends and the transcript entries share one clock, which the driver moves forward past the reply grace and to each retry the loop scheduled, so a run takes about two minutes. Every time in the captures is on that clock.

## What was checked

| Review | main | branch |
|---|---|---|
| #221. The reviewer's model times out on its first three turns and approves on the fourth (`01-reviewer-recovers-*.txt`) | Two reminders, then `needs-person`: "The reviewer ended 3 turns in a row without an answer Nexus could read, in round 1." This is rv-c9d7b72d's ending. | No reminder. `reviewer.log` shows the same request sent again as `:2`, `:3` and `:4`, 3, 6 and 11 minutes after the one before: the minute's reply grace plus the 2, 5 and 10 minute waits. The fourth turn's verdict, under the first request's token, is read, and the review ends `approved` in round 1. `show` and the dashboard said `the reviewer's model is failing (1 in a row, last: Request timed out.), retrying at 17:17 UTC` meanwhile. |
| #222. The reviewer's model times out on every turn (`02-reviewer-keeps-failing-*.txt`) | The same three-turn ending, with the same reason. | Five sends of the same request, the last 21 minutes after the fourth, then `needs-person`: "The reviewer's model failed 5 times in a row (last: Request timed out.), in round 1. Run nexus review again once the provider recovers." |
| #223. The reviewer requests changes, and the Claude builder's first turn ends on Claude Code's API error (`03-claude-builder-api-error-*.txt`) | The builder gets a reminder that its reply had no `nexus-review-answers` block, answers it, and the review goes on. | The builder gets the round's findings again 3 minutes later (`builder.log`), and `show` says `the builder's model is failing (1 in a row, last: API Error: 529 Overloaded. ...), retrying at 18:21 UTC` meanwhile. It answers, pushes, and round 2 is approved. |

`events.log` lists each run's `review.changed` events, and `drive.log` each capture's review record.

## What this does not prove

- A real pi harness session failing. The stand-in pushes the messages pi records for a failed call. Whether pi's conversation always ends a failed turn on an assistant message with `stopReason: "error"`, rather than retrying further or appending something after it, rests on rv-c9d7b72d's conversation, not on a run here.
- A real Claude Code session failing an API call, its StopFailure hook and the probe's transcript read. The stand-in writes the entries those would produce, from a real record.
- The waits in real time. The shared clock skips them.
- The control plane restarting during a wait. The failures and the retry time are in the review's record, so a pass after a restart should read them, but no run or test here restarts it mid-wait.
