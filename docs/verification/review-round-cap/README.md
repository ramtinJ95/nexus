# Review round cap verification

Verified in this task's pylon on 2026-10-26, on branch `review-round-cap`, rebased onto main at `edd1ae3`, with CLI 0.23.0. Later rebases onto `989a8f2` renumbered the CLI 0.24.0 and changed none of the review loop's code. The one later review change, labelling a last-round check that fails again at an earlier head, is covered by `src/control/review.test.ts`, not by these runs. No live control plane, node, image, GitHub repository or other thread was touched.

Each run used [the review-flow stack](../review-flow/README.md#the-stack) and its `drive.mjs`: the real registry, API, PR watch, inbox, review loop, check runner and `githubClient`, a real Claude Code builder, a scripted harness reviewer, and a stand-in GitHub over a local bare repository. This branch gave the stand-in GitHub label endpoints, which keep the repository's labels and PR #1's labels. It gave the stack three options: `ALWAYS_CHANGES=1`, a reviewer that never approves, `DENY_LABELS=1`, a GitHub that answers every label write 403 as for a token that may not write issues or pull requests, and `P3=1`, an approval that carries a P3 finding. `drive.mjs` gained a `--rounds 6` step and `ROUNDS`. Each folder holds the numbered CLI steps, `drive.log`, `timeline.txt`, `github.log` (every request to GitHub), `typed.log` (every message typed into Claude) and `reviewer.log`.

## The rounds run out, and the PR is labelled (`ran-out/`)

Run with `ALWAYS_CHANGES=1` and no `--rounds`.

- `04-review-rounds-6.txt`. `nexus review <builder> --rounds 6` exits 64: `Too big: expected number to be <=5`.
- `05-review.txt`, `timeline.txt`. `review` without `--rounds` started with `maxRounds` 5. The review went through rounds 1 to 5, with the Claude builder answering each round's P1 finding, and ended `needs-person` after the reviewer's fifth `changes`.
- `github.log`. Once the review ended, the loop created the label `needs human review` in the repository and added it to PR #1, one request each, and never again.
- `06-show-ended.txt`. The review line ends `round 5 of 5, ..., labelled "needs human review"`, and `needs you:` says the reviewer still requests changes after 5 rounds.
- `08-events-review.txt`. `review.changed` reports `needs-person` with `label: {"state": "adding"}`, then again about 100 ms later with `{"state": "added"}`.

## A token that cannot label (`label-denied/`)

Run with `ALWAYS_CHANGES=1`, `DENY_LABELS=1` and `ROUNDS=1`.

- `github.log`. The loop asked once to create the label and once to add it, and GitHub refused both with 403. It sent no further label request for the rest of the run.
- `06-show-ended.txt`. The review line ends `label "needs human review" not added`. A second `needs you:` line says the label could not be added to PR #1, quotes GitHub's 403 answer, and says labelling needs a token that may write issues or pull requests.
- `08-events-review.txt`. The last `review.changed` has both reasons and `label: {"state": "failed", "why": "GitHub answered 403: Resource not accessible by personal access token"}`.

## A P3-only approval goes straight to the checks (`p3-approved/`)

Run with `P3=1` and a task that already asks for the name, so the reviewer approves in round 1 with one P3 finding.

- `08-events-review.txt`. `reviewing`, `checking`, `merging`, `deploying` and `landed`, all in round 1, with no `fixing`.
- `typed.log`. The builder got the approval's notes: `N1 (P3) greet.sh:1: Quote the argument in the echo`, that they need no answer or push, and not to push to the approved branch. It got no `nexus-review-answers` block to fill in.

## What this does not prove

- Real GitHub. That `POST /repos/<repo>/labels` answers 422 for an existing label, and that a read-only token gets 403 on both writes, comes from GitHub's documentation and `src/control/pr-watch.test.ts`'s fetch fakes, not from a live repository.
- A real model as the reviewer. The verdicts are scripted, so whether a real reviewer assigns P0 to P3 as the prompt defines them is unverified.
- A review stored before this branch. The unit tests read records with `serious` and `minor` findings and `maxRounds` 10, but no registry from a running control plane was upgraded.
