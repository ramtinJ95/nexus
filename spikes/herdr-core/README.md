# Herdr Core behaviour checks

What Nexus needs to know about Herdr Core before pylon sessions move from Herdr 0.9.5 onto it. `check.sh` settles each
question and prints one `RESULT` line per check. It runs against an isolated core (`HC_SESSION=nexus-checks`) in a clean
environment, with Claude Code on Haiku, and, given a verify-stack thread, against the core inside that pylon.

Run on 2026-11-10 with herdr-core 0.1.20, Claude Code 2.1.322, pi 1.5.2 and the verify stack's Docker pylon.

| Check | Result | What it means for Nexus |
|---|---|---|
| argv-newline | PASS | `hc run -- argv` keeps a newline inside one argument. A prompted launch passes the prompt as argv, so the typed, bash-quoted launch line and its claim-once marker go. |
| prompted-launch | PASS | A two-line prompt given at launch is the session's first user message, as written. |
| send-multiline | PASS | `hc send` submits a three-line message once, as written. |
| send-slash | PASS | A `/`-leading message that is not a command is submitted as written. |
| send-long | DIFFERS | A 4,284-character message reaches the model whole, but Claude wraps it in `<pasted_content id=…>` tags, because `hc send` pastes. Nexus types in 64-code-point chunks today to avoid exactly this (`src/probe/guest/sessions.ts:287`). The three-line message was not wrapped. |
| send-bang | SAME | A `!`-leading message runs in Claude's bash mode, as typed text does today. |
| send-if-idle | PASS | `hc send --if idle` refuses while Claude works (exit 10, `status_mismatch`, "nothing was typed"). |
| esc-interrupt | PASS | `hc keys <t> esc` stops a turn and Claude stays live. |
| trust-status | OBSERVED | At the trust dialog Claude reports nothing: status `null`, `reported: false`, for the whole 7 s sampled. Once past it, `idle`. A Claude that has not reported yet looks the same starting up or waiting at a dialog. |
| session-label | OBSERVED | Claude started with `--session-id` carries `claude.session_id` equal to its transcript's ID. The label came from the person's shepherdr 0.3.0, which also relabels after `/clear` and `/resume`. |
| status values | OBSERVED | After a turn Claude and pi report `done`, which becomes `idle` only once someone looks. Nexus must read `done` as idle. `turn` counts turns. |
| pi-status | PASS | pi reports `idle` at start and `done` after a turn by itself. |
| attach-detach | OBSERVED | `hc attach` ends with exit 0 on Ctrl+\\. |
| attach-events | OBSERVED | `hc events` shows nothing for a viewer attaching. Core gives no count of viewers. |
| address-reuse | PASS | Addresses are never reused after `hc rm`, so a failed session's record needs no hashed ID. |
| restart-kept | PASS | Across a core stop and start, kept terminals keep their address and labels, and get a shell. Claude's terminal came back as a shell with `claude.session_id` still on it. |
| pylon-core-by-exec | PASS | In the Docker pylon a core started by an exec outlived that exec. hc warns that without a systemd user manager "the core ends with whatever started it", so a pylon VM, whose execs are ssh sessions, may differ. |
| pylon-core-detached | PASS | A core started with `setsid -f herdr-core serve` outlived its exec. Nexus starts Herdr's server detached today, and does the same for Core. |

Seen outside the script, on the same stack:

- A pylon paused 24 minutes after its last human activity while herdr-app was connected to it as a machine. A held `nexus exec` does not keep a pylon up, as intended. Typing into it through herdr-app does not count as human activity either.
- After an archive and an unarchive, herdr-app reconnected by itself about 22 s after the pylon ran, and its kept terminal was in the same pane, with a file from before the pause still on disk.
- `hc send` waits while a person has an unfinished draft in the terminal (`draft_wait`, 60 s by default), where Nexus today joins its text to the draft.
- Core may type notes and `<hc>` tags on its own unless its config sets `notes = false`, so the pylon image must set it.

Open for the sessions PR:

1. Long messages arrive in `<pasted_content>` tags. Either the conversation readers drop the tags, or Nexus keeps typing in chunks some other way. Core has no command that types text without pasting it.
2. Human activity typed through herdr-app is not seen. Claude's `UserPromptSubmit` hook, which the image already installs for receipts, could record a prompt typed in any terminal as the person's.
3. Telling "Claude starting" from "Claude at a dialog" needs the screen, since neither reports a status.
4. Viewers are counted by finding `herdr-core attach` processes in the guest, as `pgrep` counts Herdr clients today.
