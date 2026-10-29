# Decision cards verification

Verified in this thread's pylon on 2026-10-29, on branch `fix/decision-cards` against main at `c3cff81`, with Node 26 and headless Chromium 153 from `@sparticuz/chromium`. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/decision-cards/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt` and what the driver saw in `drive.log`. Both runs use the same two files, so the captures differ only by the code under test.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` runs the real registry, API, dashboard, review loop and PR watch on 127.0.0.1:7470, as `src/control/main.ts` wires them, in one project whose auto-review lands. Seven threads need the person's decision, one for each source:

| Thread | Source |
|---|---|
| Read the reviewer's answer | #51, a Claude builder's review whose reviewer ended 3 turns without an answer Nexus could read, in round 1. Nothing to land. |
| Install with one command | #52, held for a reserved case, then merged on GitHub outside the review, as #190 was. |
| Rename the deploy flag | #53, merged by its landing, whose deploy rolled back. |
| Cache the thread list | #54, held while its GitHub checks were pending. Landable. |
| Draft the install guide | A builder that stopped short of a pull request after two nudges. |
| Rebuild the pylon image | A question for the person. |
| Plan the install wave | A proposed item, as a planning thread asks one. |

GitHub is a fetch handler behind the real `githubClient` (`github.log`), the harness is the fake one, and whois answers the laptop, a deployer.

## What was checked

| | main | branch |
|---|---|---|
| The silent reviewer's page | `main/01-silent-reviewer.png`, `main/01-silent-reviewer-phone.png`. The chip says "needs your decision" and the dock is empty. | `branch/01-silent-reviewer.png`, `branch/01-silent-reviewer-phone.png`. Review needs you: the reason, "Ended in round 1 of 5", the reviewer thread linked, Review again and Cancel review. |
| The PR merged by hand | `main/02-merged-by-hand.png`. Chip, empty dock. | `branch/02-merged-by-hand.png`. Merged outside its review: nothing to review or land, deploy with `nexus deploy`, and Cancel review. No Review again, as there is no open PR. |
| Merged, not deployed | `main/03-merged-not-deployed.png`. The steps and reasons, no action. | `branch/03-merged-not-deployed.png`. The same, then how to deploy it, and Cancel review. |
| A landable held review | `main/04-held-landable.png`. Held for you with Land #54. | The same. |
| The nudged builder | `main/05-nudged.png`. Chip, empty dock. | `branch/05-nudged.png`. Stopped short of a pull request, with Write to it. |
| The question and the proposal | `main/06-question.png`, `main/07-proposal.png`. Their cards. | The same. |
| Needs you | `main/09-needs-you.png`, `main/08-needs-you-phone.png`. Seven cards, four with only Open thread. | `branch/09-needs-you.png`, `branch/08-needs-you-phone.png`. Seven cards, each with its thread page's buttons. `drive.log` lists them. |
| Review again | No button. | `drive.log`: the confirmation names #51, round 1 and the landing. The card left, the chip went to "running", Needs you went from 7 to 6, and the review is a new one, reviewing in round 1 with a new reviewer, landing for the laptop. `branch/10-after-review-again.png`. |
| Cancel review | No button. | Cancel review on #52's card in Needs you, the route `nexus review --cancel` calls. The card left, 6 to 5, and its thread page has no chip and no card. `branch/11-after-cancel.png`. |
| Write to it | No button. | From Needs you it opened the thread at `#write` with the focus in the composer. `branch/12-write-to-it.png`. |

On both runs every thread page's chip says "needs your decision". On main, three of the seven docks are empty. On the branch, each has a card with an action.

## Not checked live

- Real GitHub, a real reviewer and a real deploy. The review loop started a reviewer thread on the fake harness, and no round ran past its first request. `review-flow` and `dashboard-land-button` cover those paths.
- A failure judgment's question. It is the same question card the question and the proposal show, which `dashboard.test.ts` covers with a judgment above it. A judgment's thread is `failed`, which outranks `decision`, so its chip says failed.
- A real planning thread. The stack has no planning pass, so the proposal sits on a plain thread.
- A real phone. The 390-wide window is Chromium's mobile emulation.
