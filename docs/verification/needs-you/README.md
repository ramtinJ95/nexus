# Needs you verification

Verified in this thread's pylon on 2026-10-29, on branch `feat/needs-you-inbox` against main at `1cebcf4`, with Node 26 and headless Chromium 143 from `@sparticuz/chromium`. No live control plane, node, image, GitHub repository or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/needs-you/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt` and what the driver saw in `drive.log`. Both runs use the same two files, so the captures differ only by the code under test.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` runs the real registry, API, dashboard, review loop and PR watch on 127.0.0.1:7470, as `src/control/main.ts` wires them, with 49 threads in three projects. Ten wait on the person:

| Thread | What waits |
|---|---|
| Cache the thread list | #41, held while its GitHub checks were pending. Not waivable. |
| Rename the deploy flag | #42, held by a breaking CLI change the policy reserves for the person. Waivable. |
| Show node load | #45, approved by a Claude reviewer. Holds again, so no Land button. |
| Retry image builds | #46, out of rounds with changes asked, so nothing to land. |
| Rebuild the pylon image | A question for the person. |
| Rotate the payment keys | A question reserved for a deployer. |
| Pick the editor font | A Claude worker's AskUserQuestion with a single-select and a multi-select question. |
| Write the sync docs | A Claude worker stopped on its usage limit. |
| Migrate the orders table | A Claude worker's permission dialog in its terminal, under a newer unread reply. |
| Port the CLI to Rust | A Claude worker whose launch failed. |

The other 39 are idle, working, a reviewer, or have a new reply. Stand-ins replace only what this pylon cannot host: GitHub is a fetch handler behind the real `githubClient` (`github.log`), a check thread passes after 6 seconds, the node's release worker reports a desired release healthy 8 seconds later (`release.log`), and the probe answers only the pylon hook's `answer` command, logging what it was handed (`hook.log`). [The AskUserQuestion capture](../ask-user-question-card/README.md) covers the real hook and Claude. `POST /verify/fail` on port 7489 fails one more Claude worker while the driver watches.

## What was checked

| | main | branch |
|---|---|---|
| The home page | `main/01-home.png`. The project tables only. Nothing says what waits. | `branch/01-home.png`, and all of it in `branch/02-home-whole.png`. Needs you first, ten cards oldest first, and Needs you 10 in the sidebar. |
| The tab | `drive.log`: the title is `(9+) Nexus` and the icon a red count. | `drive.log`: the title stays `Threads · Nexus` and the icon `/assets/favicon.svg` throughout. |
| A held review's card | The card is only on its thread page, `main/03-held-thread-page.png`. | Each card has the PR's link, three lines of its description, what was not checked live, the holds with "not waivable", "you may waive" or "holds again", the findings, and Land where the thread page has it. |
| A phone | `main/04-phone-home.png`, `main/05-phone-thread-page.png`. | `branch/04-phone-home.png` starts with Needs you. `branch/05-phone-thread-page.png` has the inbox link in the bar beside the menu. |
| Answering a question | No card. | `branch/06-answered-question.png`. Rebuild, OK, and the card left within a poll: the count went from 10 to 9. |
| Answering Claude's ask | No card. | `branch/07-ask-filled.png`, then `branch/08-answered-ask.png`: the card left, and `hook.log` shows the pylon was handed Inter, 16 and the note. |
| Archiving from a card | No card. | `drive.log`: Archive on the usage-limit card took it off, 8 to 7. |
| Landing from a card | No card. | `branch/09-land-card.png`, then Land #42 asked the thread page's own question, waiving the reserved hold. `branch/10-after-landing.png` has 6 left. `branch/11-landed-thread-page.png` shows it merged, deployed and landed, and `drive.log` the waiver of that one hold at that head. |
| A notice | `main/12-notice.png`. The toast opens `/threads/<id>`. | `branch/12-notice.png`. The toast opens `/#needs-you:<id>:failed`, and `branch/13-notice-opened.png` shows that thread's card outlined and focused. |
| The list at the end | `main/14-phone-home-after.png`. | `branch/14-phone-home-after.png`, with the thread that failed meanwhile. |

## What this does not prove

- Real GitHub, a real check pylon and a real deploy. `review-flow` and `dashboard-land-button` cover those paths.
- A real pylon answering an ask. The probe here stands in for the hook.
- A system notification. The page was focused, so the notice was a toast. A system notification's click goes to the same URL.
- A real phone. The 390-wide window is Chromium's mobile emulation. Its fonts lack the ☰ glyph, so the menu button shows blank on both runs.
