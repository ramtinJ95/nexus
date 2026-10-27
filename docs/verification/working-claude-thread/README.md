# A working Claude thread reads as working (#127)

Captured in this task's pylon on 2026-10-27, by `run.sh`, which runs `capture.ts` once against main at 137242d
(`main/`) and once against the branch (`branch/`) with the same steps. No live control plane, node, image or other
thread was touched.

## The stack

`capture.ts` runs the checkout's own registry, API and dashboard on `127.0.0.1:7471`, with the test fake as the model
harness. It starts three threads through `POST /v1/threads`: a Claude worker thread whose session turn runs, a harness
thread whose turn runs, and one where nothing runs. The probe's event stream is the replaced boundary: each Claude
hook event goes to `registry.reportSession`, the call `src/control/loop.ts` makes for a probe's session event. The CLI
is the real `node src/cli/nexus.ts` with `NEXUS_URL` and `NEXUS_SOCKS=none`, and its output is rendered by xterm.js.
The dashboard is driven in headless Chromium, `@sparticuz/chromium`, because the pylon has no browser and no Docker
for the verify-nexus stack.

## What changed

| | main | branch |
|---|---|---|
| `nexus threads`, the Claude thread's row | `-` | `working` |
| `nexus show`, its status line | `status: active` | `status: active, agent working` |
| `show --json` thread | no `working` | `"working": true` |
| thread page `#facts` `data-turn` | `false` | `true` |
| changes reads during 15 s of the turn's heartbeats | 3 | 0 |
| changes reads in the 7 s after the turn ends | 1 | 1 |
| toasts 3 s after a follow-up turn starts, while it runs | `Fix the flaky stream test: reply` | none |
| toasts 3 s after that turn ends | that toast and a second one | `Fix the flaky stream test: reply` |

The harness thread prints `working` on both, as a control. Each directory's `capture.log` holds those lines, and
`threads.txt`, `show.txt` and `thread-facts.html` the raw output.

The notification steps run on the home page, focused: a turn ends with a reply, the page's attention poll sees it, a
follow-up turn starts before the reply's two-second grace ends, and the page waits 3 s. On main the reply toast fires
while the follow-up runs, because the notifier read only `agentTurnRunning`. On the branch it fires once that turn
ends, with that turn's reply.

## Not checked here

- A real Claude Code session's hooks. The events are the ones its hooks report, handed to the registry directly.
- System notifications. Only the in-page toast was driven. Both go through the same `coordinator` in
  `notifications.js`, which is what changed.
- The CLI against an older control plane that sends no `working`. `src/cli/nexus.test.ts` covers it with a stand-in
  server.

## Rerun

```sh
docs/verification/working-claude-thread/run.sh            # main is origin/main
docs/verification/working-claude-thread/run.sh <base>
```

It needs Node 24 or newer, `npm ci` in the checkout, port 7471 free and the npm registry. It replaces `main/` and
`branch/`.
