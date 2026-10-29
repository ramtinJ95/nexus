# Interrupting a Claude worker, and the composer's slash commands

Verified in this task's pylon on 2026-10-29, on branch `feat/claude-interrupt`, against main at 94cf908. The Claude worker was a real Claude Code 2.1.310 (haiku) in a scratch Herdr 0.9.5 session. The browser was headless Chromium 138. No live control plane, node, image or other thread was touched.

## How to rerun

```sh
bash -l docs/verification/claude-interrupt/run.sh [base]
```

`with-claude.sh` starts a real Claude Code in pane `w1:p1` of a scratch Herdr session. Claude runs under its own HOME, in default permission mode, and keeps only Herdr's SessionStart hook. So Herdr learns Claude's session IDs, and no Nexus hook reports anywhere. `run.sh` runs `capture.ts` on main and on the branch, each beside a fresh Claude. Then it runs `live.ts` on the branch, and runs the branch's changed tests against both checkouts.

`capture.ts` is the checkout's own registry, API, dashboard and CLI on 127.0.0.1:7472. Its probe is the stand-in: commands run the checkout's own `runCommand`, and pipes run the transcript reader, both against the scratch Herdr and HOME. Session events come from Herdr's state of the pane, not from the image's hooks. The inspector's Changes panel shows this checkout's working tree, because the capture's pylon is this machine.

`live.ts` calls `interruptClaude` and `sendToClaude` directly against the real Claude.

## What was checked

| Step | main | branch |
|---|---|---|
| A turn runs, `01-working.png` | `Claude is working`, and no way to stop it, so the turn ran to its end | `Claude is working … Interrupt` |
| Interrupt clicked, `02-after-turn.png` | no button | probe gets `interrupt-claude`. Claude's terminal shows `Interrupted · What should Claude do instead?`, and the page shows `Interrupted` and `Idle` |
| `nexus abort` while a permission dialog waits, `03-dialog.png`, `abort-at-dialog.txt` | exit 5, `has no conversation` | exit 5, `Claude waits at a prompt in its terminal, which Esc would cancel, so nothing was pressed`. The dialog still waits |
| `/clear` in the composer, `04-clear.png`, `clear.txt` | typed. Herdr's session for the pane moves to a new ID while the worker stays on the old one, and the page keeps showing the old transcript | not typed. The composer says why, points to `nexus attach`, and keeps the draft. Herdr's session ID is unchanged |
| `tests.txt` | 12 of 408 fail: the new and changed tests, and the version test | 481 of 481 pass |

`live/live.txt`, against the real Claude:

- An interrupt while Claude writes its reply presses Esc, and Claude stops with `Interrupted`.
- An interrupt before Claude starts its reply also stops it, but Claude puts the message back in its prompt, as Esc does at the terminal.
- Two interrupts at an idle prompt press nothing, and no rewind picker opens. By hand, two quick Esc presses at an idle prompt open the rewind picker while Herdr still reports `idle`.
- An interrupt at a permission dialog presses nothing, and the dialog still waits.
- After `/clear`, Herdr reports a new session ID for the pane. An interrupt of the old session answers `not-running`, and the next message to it resumes it in a second pane, `w2:p1`.

By hand: `/model sonnet` and `/effort high` act at once. A bare `/model` opens a picker while Herdr reports `idle`.

### main

![main, a turn runs](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/claude-interrupt/docs/verification/claude-interrupt/main/01-working.png)
![main, /clear typed](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/claude-interrupt/docs/verification/claude-interrupt/main/04-clear.png)

### branch

![branch, a turn runs with Interrupt](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/claude-interrupt/docs/verification/claude-interrupt/branch/01-working.png)
![branch, after Interrupt](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/claude-interrupt/docs/verification/claude-interrupt/branch/02-after-turn.png)
![branch, abort at the dialog](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/claude-interrupt/docs/verification/claude-interrupt/branch/03-dialog.png)
![branch, /clear refused](https://raw.githubusercontent.com/ramtinJ95/nexus/feat/claude-interrupt/docs/verification/claude-interrupt/branch/04-clear.png)

## Not checked live

- The probe server, its HTTP transport and a Gondolin pylon. The capture's probe calls `runCommand` in process, and the lock that queues an interrupt behind a send is checked only by `src/probe/server.test.ts`.
- The image's own hooks. Session events came from Herdr's state of the pane.
- `/resume`, `/branch`, `/fork` and `/exit` in a real Claude. Only `/clear` was typed live. The others are refused from Claude Code's description of them.
- Which picker commands act at once with an argument, beyond `/model` and `/effort`. Every other picker command is refused with or without one.
