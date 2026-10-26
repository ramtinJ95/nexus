# Claude worker conversations verification

Verified in this task's pylon on 2026-10-25, on branch `claude-thread-streaming`, with
Claude Code 2.1.308 and Herdr 0.9.5. No live control plane, node, image or other thread
was touched.

## The stack

`stack.ts` runs the real registry, API and dashboard on `127.0.0.1:7470`. Its node's
probe runs commands through the real `runCommand` (`open-session`, `send-claude`) and
its pipes as local processes, so the transcript reader's `sh` helper reads a real file.
The Claude worker is a real Claude Code session, started and steered by the real
`sessions.ts` code. Only the boundaries a pylon cannot host here are stand-ins:

- The pylon is this machine. HOME, the checkout and the Herdr server are redirected to
  `/tmp/nexus-claude-verify` and the Herdr session `verify-claude`, so nothing touches
  this pylon's own Claude session. The pane shells source `/etc/profile.d/nexus-secrets.sh`
  for the Claude token placeholder, as a pylon's login shells do.
- The isolated HOME has the image's Claude hooks only, and `NEXUS_API` points them at a
  bridge on `127.0.0.1:7489`, which hands each event to `registry.reportSession`, as the
  probe's observation would. No hook reaches the live control plane.
- The node's observation is written by the stack every second. `POST /verify/pause/<thread>`
  reports the pylon `stopped` and makes its probe answer not-running, and `/verify/run`
  reverts both. `wake` is a no-op, so a paused pylon runs only once the driver says so.
- The worker launch is the reconcile loop's launch step, copied: fence the session ID,
  then `open-session` with the prompt. The model harness is the test fake, which a
  Claude worker thread never calls.

`drive.mjs` and `drive-pause.mjs` drive it through the person's surfaces: the dashboard
in headless Chromium (`@sparticuz/chromium` and `puppeteer-core`, installed outside the
repo), and the CLI, `node src/cli/nexus.ts` with `NEXUS_URL` and `NEXUS_SOCKS=none`.

## What was checked

- `01-start-dialog.png`. The start dialog defaults to Claude Code, with the prompt as
  the main field, the optional model and an optional title. The thread was started from
  this form. Its first prompt reached Claude as `/pstack:poteto-mode …`.
- `02-live-turn.png`, `stream-frames.log`. The thread page's stream delivered new
  conversation frames during the turn, as Claude wrote each tool call (frames at
  23:33:46, :49, :53 and :59 with 1 to 4 tools, and more as the turn went on), with the
  run bar showing Claude working. The turn ended at about 23:34:45.
- `03-steered-mid-turn.png`. A message sent from the composer during the turn, with
  newlines, double and single quotes, backticks and `$`, shows as queued.
  `04-turn-ended.png` shows Claude absorbed it at its next tool step and acted on it.
- `05-sent-after-turn.png`, `cli-send-after-turn.json`. `nexus send` after the turn
  started a new turn (`outcome: sent`), and Claude echoed the text back unchanged.
- `exactness.json`. Both messages appear byte-for-byte in the transcript Claude Code
  itself wrote: `{"midTurn": true, "afterTurn": true}`.
- `06-tools-expanded.png`. Tool calls fold into summaries ("Wrote 2 files, ran a
  command") that expand into each call, with a Write's content as a diff.
- `cli-conversation.txt`, `cli-conversation.json`. `nexus conversation` prints the
  transcript, and `--json` prints the `ClaudeConversation`.
- `07-paused.png`, `paused-detail.json`, `cli-conversation-paused.txt`. With the pylon
  paused, the page and the CLI show the transcript as of its last read, and no read
  reached the pylon.
- `activity-while-paused.json`, `cli-send-while-paused.json`, `08-after-wake.png`. A
  `nexus send` while paused recorded human activity, so the desired phase became
  running. The CLI retried the 409 until the stack reported the pylon running, and the
  message was then delivered under the same request ID.
- `09-phone.png`. The phone layout.

## Bugs this run found and fixed

- The worker's first prompt showed as raw `<command-message>` tags. Claude records a
  person's slash command in its command form, with a human origin. Fixed in the parser.
- Steering text sat unsubmitted in Claude's prompt with `-- ` before each chunk. Herdr
  0.9.5 types every argument after the pane, `--` included. And Claude reads an Enter
  that directly follows a burst of input as a newline. The typing script now passes one
  argument per chunk and waits half a second before Enter. The `stack.ts` adapter
  problems met on the way (the launch receipt path, Herdr's socket under the redirected
  HOME, a paused phase named `paused` instead of `stopped`) were the stack's own.
- An unknown attachment, `remote_session_change`, showed as a generic entry, as designed
  for unknown records. Now that it has been observed, it is hidden as bookkeeping.
- Replies showed raw `#`, `-` and `**`. The conversation pane now renders markdown.

The captures here are from the last clean run, after these fixes.

## Not verified

- A real pylon VM, probe and reconcile loop. The stack stands in for them, so the wake
  path from the API to a booted pylon and Herdr's relaunch of the session after a real
  checkpoint were not exercised here.
- Resuming a session that no pane runs. Unit tests cover it, with a fake guest.
- A Claude dialog (`blocked`) in a real session.
- The Changes pane shows an error in these captures because the stack's checkout has no
  `refs/nexus/base`. That ref is recorded by a real pylon's first boot.
