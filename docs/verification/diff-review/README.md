# Review notes on the diff verification

Verified in this task's pylon on 2026-10-26, on branch `diff-review-comments` rebased on
`main` after nexus#96, with headless Chromium, Claude Code 2.1.308 and Herdr 0.9.5. No live
control plane, node, image or other thread was touched.

## The stacks

- `harness` runs against [the highlighted diffs stack](../pierre-diffs/README.md),
  `docs/verification/pierre-diffs/stack.ts` on `127.0.0.1:7470`. It serves one running
  harness thread whose checkout is a fixture repository, read by the real checkout helper
  through a fake probe. Its harness is the fake one, which adds a sent message to the
  thread's conversation as pi-durable would.
- `claude` runs against [the Claude turn snapshots stack](../claude-turn-snapshots/README.md),
  `docs/verification/claude-turn-snapshots/stack.ts` on `127.0.0.1:7472`. Its worker is a
  real Claude Code session in Herdr, messaged by the real `sessions.ts` code, and its
  latest turn is the snapshot the worker's hook took. Since nexus#96 the hook reports only
  from the real home and only for a Claude that no other Claude started, so the stack now
  stages `nexus-outbox.ts`, points the hook's home check at its own home, and launches the
  worker without this session's `CLAUDE_CODE_SESSION_ID`. Without those changes the
  worker's turns took no snapshot.

`drive.mjs` drives the thread page in headless Chromium (`@sparticuz/chromium` and
`puppeteer-core`, installed outside the repo, run with `LD_LIBRARY_PATH=/tmp/al2023/lib`
and `FONTCONFIG_PATH=/tmp/fonts` so Chromium finds the libraries and fonts the package
unpacks). It writes `harness.log` or `claude.log`, logs every response with a status of
400 or more, and fails on any CSP violation or page error.

## What was checked

- `harness-01-selected.png`. Dragging over the line numbers 10 to 12 selects those rows,
  and a bar under them offers the four kinds of note.
- `harness-02-question-draft.png`. Down moves through the rows, Shift with Down extends the
  selection, and Q opens a question on it. Ctrl+Enter saves the note.
- `harness-03-split.png`. In split, a suggestion on removed lines 12 to 15 sits in the old
  file's column, and the notes made in unified sit under their rows in both columns. Each
  note fits its column.
- `harness-04-turn.png`. A requested change on Latest turn, on `app.py`.
- `harness-05-reloaded.png`. After a reload, the five notes (comment, question,
  suggestion, requested change, and a comment made with the C key on Only uncommitted)
  read back as they were, and the changes tree counts the notes on each file. A note
  half-written when the page reloaded comes back with its text.
- `harness-06-outdated.png`. After `style.css` changed under its note, the diff no
  longer shows its rows as quoted. The note is listed above the diff with its quote.
- `harness-07-dark.png`. The notes in the dark theme.
- `harness-composer.png`, `harness-composed.md`. Add to message puts the review in the
  composer and switches to the conversation. The drive cuts the last entry from the
  message and types a line of its own before sending.
- `harness-08-sent.png`. The review arrives in the conversation as the reader's message.
  The four notes it carried are cleared, and the note cut from the message stays in the
  review.
- `claude-01-notes.png`. A question and a requested change on the Claude worker's latest
  turn, after a reload.
- `claude-composer.png`, `claude-composed.md`, `claude-02-sent.png`. The review is typed
  into the worker's session. The conversation shows one more review than before the send,
  and the notes are cleared.
- `harness.log`, `claude.log`. No CSP violation and no page error, under the page's
  unchanged policy. The one failed response is the Claude page's first read of its
  changes since boot, `changes?base=start`, answered 422. The stack's scratch repository
  has no `refs/nexus/base`. The page reads the default base before the drive switches to
  Latest turn, so that read fails in the same way without this change.

## Not verified

- A real pylon, probe and node. The harness thread's reads went through a fake probe, and
  the Claude worker ran in this pylon's Herdr.
- Safari and Firefox, a touch screen, and the phone layout.
- A screen reader.
