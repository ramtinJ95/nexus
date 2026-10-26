# CLI contract fixes verification

Verified in this task's pylon on 2026-10-26, on branch `cli-contract-fixes`, with Claude
Code 2.1.308. No live control plane, node, image or other thread was touched.

## The stack

The stack is [`../claude-thread-streaming/stack.ts`](../claude-thread-streaming/stack.ts),
unchanged. It runs the real registry, API and dashboard on `127.0.0.1:7470`, with a real
Claude Code session as the worker. That README describes its stand-ins.
`drive.mjs` drives it through the Mac CLI, `node src/cli/nexus.ts` with `NEXUS_URL` and
`NEXUS_SOCKS=none`. `shot.mjs` captures the thread's page in headless Chromium.

The worker opens no real pull request. So `drive.mjs` appends real `pr-link` records to
the worker's transcript between its two turns. They are the first and the last copies
that Claude Code wrote into this task's own session when it opened
[nexus#92](https://github.com/ramtinJ95/nexus/pull/92). By then that session held five
copies of the record, one for each time Claude Code saved the session's metadata, each
with a new timestamp.

## What was checked

- `watch.txt`, `watch.jsonl`. `nexus watch` on the Claude worker thread printed the
  prompt, each tool call as Claude wrote it, the failed `false` as `[tool error] Exit
  code 1`, the reply, the turn, and the second turn after `nexus send`. `state` went
  `working` and back to `idle` for each turn. While `sleep 20` ran, `live.tools` named
  that call. The pull request printed once. The second copy of the record is a
  `claude-entry` whose `text` is empty.
- `show-working.json`, `threads-row-working.json`. While the turn ran, the thread had
  `sessionTurnRunning: true`, `sessionActiveUntil`, `workingSince` and attention
  `working`, the fields that docs/cli.md now lists.
- `seen.json`. After two replies, `seen --last-reply-at <first reply>` set `seenAt` to
  the first reply, and attention stayed `reply`. An older timestamp left the mark alone.
  The second reply's timestamp cleared attention.
- `conversation.txt`. `nexus conversation` printed `[pull request] Opened pull request
  #92: https://github.com/ramtinJ95/nexus/pull/92` once.
- `dashboard-pull-request.png`, `dashboard-pull-request.json`. The thread page showed one
  "Opened pull request #92" link to the pull request.

## Bugs this run found and fixed

- The text `watch` said "Claude's transcript was replaced" when the worker's first
  session started, though it had printed none of the transcript. The banner now needs
  printed entries. The JSON `claude-reset` was right, since the session changed.
- The pull request link was grey note text. It now uses the dashboard's link colour.

The captures here are from the run after these fixes. The screenshot was retaken after
the second fix.

## Not verified

- A real pylon VM, probe and reconcile loop, as in the stack's own README.
- `watch` against an older control plane, and across a reconnect, outside the unit tests.
- A worker that opens a real pull request itself. Its records came from this task's
  session instead.
