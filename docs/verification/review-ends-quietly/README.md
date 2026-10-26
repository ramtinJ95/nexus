# A review ends quietly when nothing is left to review

Verified in this task's pylon on 2026-10-26, on branch `review-ends-quietly` from main at `bd1335d`, with CLI 0.26.0. No live control plane, node, image, GitHub repository or other thread was touched.

Both runs used [the review-flow stack](../review-flow/README.md#the-stack) and `drive.mjs` in this folder: the real registry, API, PR watch, inbox, review loop and `githubClient`, a scripted harness reviewer, and a stand-in GitHub over a local bare repository. The stack had drifted from main, so this branch brought it up to date (`saveImage`, node capacity and grants, the project mirror, `writeFiles`, `send-claude-outcome`). It also gave the stack these options:

- `SCRIPTED_BUILDER=1`. The builder is a Claude worker record with no Claude session, and the stack pushes `feature` for it. The Claude launch through Herdr no longer works in the stack, and none of these endings needs the builder to answer anything.
- `/verify/merge`, `/verify/close` and `/verify/reopen`. The person merges PR #1 outside the review and deletes `feature`, as GitHub's auto-delete does, or closes or reopens it.
- `REVIEWER_DELAY_MS`. The reviewer answers this long after each request. These runs used 40 seconds, so the person acts while the reviewer still owes its verdict.

The runs used `ALWAYS_CHANGES=1`, so the reviewer never approves. The driver runs four reviews of one PR, one after another: one with `--rounds 1` whose rounds run out, one whose reviewer the person archives with `nexus archive`, one whose PR the person closes, and one whose PR the person reopens and then merges. Each folder holds the numbered CLI steps, `timeline.txt`, `github.log` (every request to GitHub), `reviewer.log` and `stack.log`.

## After this change (`after/`)

- `03-show-ran-out.txt`. A review whose rounds ran out on an open PR still asks for the person: `attention: decision`, `needs-person`, `labelled "needs human review"`, and a `needs you:` line.
- `06-show-cancelled.txt`. After the person archived the reviewer, `attention: none`, and the review line reads `cancelled, round 1 of 5, ..., the reviewer thread th-e169b02a8c5b was archived`, with no `needs you:` line.
- `08-show-closed.txt`. After the person closed the PR, the review ended `closed`, and attention stayed `none`.
- `10-show-merged.txt`. After the person merged the PR and deleted its branch, the review ended `merged`, and attention stayed `none`. The driver waited 45 seconds more, past the reviewer's late answer, and nothing changed.
- `12-events.txt`. `attention.changed` is `decision` only for the review whose rounds ran out, and `null` from the next review on. The last three `review.changed` events are `cancelled` (`who: reviewer`, `status: archived`), `closed` and `merged`, each within 10 seconds of the person's action.
- `github.log`. The loop created and added the label once, for the review whose rounds ran out, and sent no other write.
- There is no `typed.log`, because nothing was typed into the builder.

## Before this change (`before/`)

The same driver against main's `src/control/review.ts`, `src/cli/nexus.ts` and `src/control/dashboard.ts`.

- `06-show-cancelled.txt`. After the person archived the reviewer: `attention: decision`, `needs-person`, and `needs you: The reviewer thread th-7f1cee4da74e is archived, so the review stopped.`
- `timeline.txt` and `typed.log`. After the person closed the PR, the review went on. The reviewer's answer moved it to `fixing`, and the builder got the round's findings for the closed PR. The driver then timed out while it waited for the review to end.

## Unit tests

`unit-before.txt` is `src/control/review.test.ts` with the new tests on main's loop. Two fail: the review of a merged PR whose check pylon failed with `Setup exited 128` ends `needs-person`, as #104's did, and an archived reviewer ends `needs-person`. `unit-after.txt` is the same file after the fix, with all 41 tests passing, the last one added for the pre-PR review's findings.

## What this does not prove

- Real GitHub. The merged and closed states come from the stand-in's `merged` and `state` fields, which `githubClient` already read before this change.
- The exact #104 path on the stack. With an approving reviewer, the check would start in a check pylon, which the stack makes from a local clone. Only the unit test covers a merge during a running check and the GitHub read before a check starts.
- A real Claude builder or a real model as the reviewer.
