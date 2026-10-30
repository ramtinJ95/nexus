# A Claude transcript records a typed message exactly as Nexus typed it

`promptSenders` in `src/control/inbox.ts` reads a Claude worker's prompt as Nexus's only when the thread has a recorded send by Nexus of exactly that text, by SHA-256. That holds only if Claude Code records the text unchanged. `run.sh` checks it against a real Claude Code session in a Herdr pane, typed the way the probe's `send-claude` types (`src/sessions.ts`: chunks of 64 code points, then Enter).

It ran on 2026-10-30 with Claude Code 2.1.310 and `claude-haiku-5-5`, in this thread's pylon. `check.txt` is its output:

- A review-shaped message of 2,216 code points, with CRLF, a tab, quotes, backticks, `$`, an em dash, other non-ASCII and 34 lines, typed while Claude was idle. `type.ts` passes it through `typeable` first, as the inbox does. It is recorded as a `user` record whose text has the same SHA-256 as the typed text. It was not wrapped in `<pasted_content>`, as a burst pasted at once is.
- A message that starts a turn of five tool calls, recorded the same way.
- A nudge-shaped message of 566 code points typed during that turn. Claude took it mid-turn and recorded it as a `queued_command` attachment, which `parseRecord` reads as a prompt `from: "person"`. Its text has the same SHA-256 too.

An earlier run in the same session also typed a message while Claude was finishing a turn. Claude recorded it as a `user` record with `promptSource: "queued"`, and it matched as well.
