# Dashboard polish verification

Verified in this task's pylon on 2026-10-26, on branch `dashboard-polish`, with headless
Chromium. No live control plane, node, image or other thread was touched.

## The stack

`stack.ts` runs the real registry, API and dashboard on `127.0.0.1:7470` and seeds seven
threads: a harness thread with a running turn, a Claude worker with a running session
turn, an unread reply, a failed pylon, a Claude session waiting for input, a seen idle
thread and an archived one. The harness conversation and the Claude transcript each hold
a run of tool calls. The model harness is the test fake and the stack writes the node's
observation. The registry's clock is set back while each turn starts, so the turns have
run for over a minute when the page loads.

`drive.mjs` opens the pages in headless Chromium (`@sparticuz/chromium` and
`puppeteer-core`, installed outside the repo) and writes `drive.log`.

## What was checked

- `01-home.png`, `drive.log`. The two working rows show `working 1m 37s` and
  `working 1m 05s` in the sidebar and the home table's Agent column. Three seconds later
  they read `1m 40s` and `1m 08s` without a reload. Meanwhile the page made no request
  except the attention poll of `/v1/threads`, which already ran once a second before this
  change.
- `01-home.png`, `drive.log`. The working rows and the seen idle row are dimmed (title
  opacity 0.6). The unread reply, the failed pylon and the waiting session stay at full
  opacity.
- `02-dim-row-hovered.png`, `drive.log`. Hovering a dimmed row brings it back to full
  strength, and clicking it opens its thread.
- `03-harness-conversation.png`, `04-harness-fold-open.png`. The harness conversation's
  first run folds as "Ran 3 commands, changed 2 files, read a file". Two edits and a write
  over two files count as two changed files. The running call after the next reply is its
  own fold. The run bar shows the same clock as the row.
- `05-claude-fold-open.png`. The Claude transcript's run folds as "Ran 2 commands, changed
  2 files, read a file, used 3 other tools". An Edit and a MultiEdit of one file and a
  Write of another count as two changed files, and the fold opens to each call.
- `06-home-dark.png`. The dimmed rows in the dark theme.
- `00-before-home.png`, `00-before-claude-conversation.png`. The same stack on `main`
  before the change. Its rows show "now" and "turn running", nothing is dimmed, and
  the Claude fold reads "Ran 2 commands, read a file, searched, edited a file, edited a
  file, wrote a file, updated the to-do list, fetched a page".

## Not verified

- A real pylon, probe and harness turn. The turn starts come from the registry calls that
  the harness tracker and the session hooks make, not from a live agent.
- The phone layout.
