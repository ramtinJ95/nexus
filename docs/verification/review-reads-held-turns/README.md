# Held turns and gate holds verification

Verified in this task's pylon on 2026-10-29, on branch `fix/review-reads-held-turns`, against main at 87d7e0d. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` into each, builds the dashboard and runs the stack, which drives itself and exits. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same file, so the captures differ only by the code under test.

```sh
docs/verification/review-reads-held-turns/run.sh origin/main HEAD
```

`stack.ts` runs the real registry, API, PR watch, inbox and review loop as `src/control/main.ts` wires them, on plain HTTP at 127.0.0.1:7470. Only what a pylon cannot host is a stand-in:

- GitHub is a fetch handler behind the real `githubClient` (`github.log`).
- The reviewer is a harness thread in the fake harness. It requests changes in round 1 of #211 and #212, and approves every other head (`reviewer.log`).
- A Claude builder's pylon. What the loop types into the session goes to `builder.log`. The stand-in writes transcript entries into the registry, as the control plane's transcript read does, and reports `session.turn-started` and then a `session.heartbeat` every 2 seconds, as the pylon's Stop hook does every 5 minutes for a turn that ends with a background shell running. It never reports `session.turn-ended`, so `lastReplyAt` stays null.
- `.nexus/check` passes 2 seconds after it starts (`check.log`).

## What was checked

| Review | main | branch |
|---|---|---|
| #211. The builder answers F1 with the right token and pushes, and its turn is held by a background shell (`01-held-turn-answered.txt`) | `fixing`, `answers: null`, nudges 0, `working: true`. The answer is never read. | Round 2 `reviewing` at the pushed head, with F1's answer recorded, while the builder is still `working`. |
| #212. The builder says it started the tests and gives no answer, and its turn is held (`04-held-turn-silent.txt`) | `fixing`, nudges 0 after 75 seconds. No reminder. | Nudges 1. `builder.log` shows the reminder typed a minute after the held turn. |
| #213. Held after an approval because the builder did not rebase a conflicting branch, then the builder pushes a rebase (`02-conflict-hold-rebased.txt`) | Still `needs-person`, with the reason that says to run `nexus review`. | Round 2 at the rebased head, approved, checked, and `landed`, as the review was asked to land. |
| #214. Held with the reviewer's changes unanswered, then the builder pushes (`03-reviewer-changes-hold-pushed.txt`) | `needs-person`, with the reason that names the new head. | The same. Reviewer-requested changes stay the person's. |

`events.log` lists each run's `review.changed` events.

## What this does not prove

- A real Claude Code session, its Stop hook and the probe's transcript read. The stand-in writes the entries those would produce. The `turn` entry's shape and the hook's heartbeats are covered by `src/claude-transcript.test.ts` and `src/events.test.ts`, not here.
- The pylon's clock against the control plane's. A transcript entry's time comes from the pylon, and the loop compares it with its own clock.
- Real GitHub and the PR watch's two-minute timing. The stack polls the watch once, right after the pushes. `nexus show` still says #213 is open because the watch did not read it again after the merge.
