# Dashboard bugs and scrolling verification

Verified in this thread's pylon on 2026-10-29, on branch `fix/dashboard-bugs-scrolling` against main at `db5eb92`, with Node 26.12.1 and headless Chromium 153 from `@sparticuz/chromium`. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> LD_LIBRARY_PATH=<its al2023 lib> FONTCONFIG_PATH=<its fonts.conf dir> \
  docs/verification/dashboard-scrolling/run.sh origin/main HEAD
```

`run.sh` checks out main and the branch into two worktrees, copies `stack.ts` and `drive.mjs` into each, builds the dashboard, starts the stack and drives it. Each run's captures land in `main/` or `branch/`, with the commit in `commit.txt`. Both runs use the same two files, so the captures differ only by the code under test.

## The stack

Docker is not available in this pylon, so the verify-nexus stack could not run. `stack.ts` runs the real registry, API and dashboard on 127.0.0.1:7470 and seeds what a busy deployment holds:

- 52 threads in four projects, some archived and some deleted, and a thread title long enough to need an ellipsis.
- A harness conversation of 40 rounds, each with a list, a code block of long lines, two tool calls and a long URL, and a shorter conversation that the driver grows while it watches.
- A Claude worker's transcript of 70 steps, with its turn running.
- Three questions waiting on one thread, a review in its second round on another, and an approved review on a third.
- A checkout with 40 changed files, one of them with 400 changed lines, which every thread's Changes pane and diff tab read through the real checkout helper.
- Twelve pipeline items in two projects, one waiting for the person's approval, and a node whose health the node page reads.

Only what a pylon cannot host is a stand-in: whois answers the laptop, a deployer; the model is the test harness; the probe runs the checkout helper against a fixture repository and reports made-up health. Port 7489 lets the driver add replies, stream one, start or end a turn and ask a question while a page is open.

`drive.mjs` opens every page at 1280×900 and at 390×844 as a phone, screenshots each, then repeats each bug's steps and writes what it measured to `findings.txt`, with `BUG` or `ok`.

## What was checked

| Check, at both widths | main, db5eb92 | this branch |
|---|---|---|
| Whether the document itself scrolls, on every page | On the long conversation, at both widths, the page is taller than the window. | No page scrolls. |
| A mouse wheel over the composer (`11`) | Scrolls the window 3,000 px, into a blank page. | Nothing moves. |
| Question cards whose option buttons show (`12`) | 0 of 3. Each card is squeezed into its own scroll box. | 3 of 3. The stack of cards scrolls instead. |
| At the end, then the window shrinks by 300 px as a phone's keyboard opens, then a reply (`13`) | 397 px above the end on the desktop, 413 px on the phone. | At the end. |
| At the end, six lines typed into the composer, then a reply (`14`) | 186 px and 239 px above the end. | At the end. |
| At the end, a question card joins the dock across a poll | At the end, since the swap that adds the card puts the reader back. | At the end. |
| Scrolled up to 600 px, replies, a stream and a poll (`15`) | Held at 600 px. | Held at 600 px. |
| A diff tab scrolled to 4,000 px across a poll (`16`) | Held. | Held. |
| At the end, open a diff tab, three replies, back to the conversation (`17`) | 291 px and 423 px above the end. | At the end. |
| The open thread's row in the sidebar (`18`) | Hidden under the notifications button on the desktop, and below the fold when the phone opens the list. | In view. |
| The sidebar and the inspector scrolled across a poll | Held. | Held. |
| The inspector's Changes, Previews and Pylon tabs while its pane scrolls (`19`) | Scrolled away. | Stay at the top. |
| Pipeline cells whose text is cut off (`20`) | 19 on the desktop, 2 on the phone, mid-word and with no ellipsis. | None. Titles and reasons wrap. |

## Not verified here

- A real phone. Chromium's mobile emulation stands in for touch and the keyboard, and the driver shrinks the window as Android Chrome does when its keyboard opens. iOS Safari overlays its keyboard without resizing the page, which this run does not show.
- The verify-nexus Docker stack, so no real pylon, pi-durable harness or Claude transcript read. The Claude worker's transcript is seeded, and its reads fail on purpose.
- Dark mode, and fonts other than the ones `@sparticuz/chromium` ships, which have no ☰ and ⋯ glyphs, so the phone's menu buttons show blank in the screenshots. The buttons are there and open their panels.
- Whether the home page holds its place when a thread above moves into the archived fold.
