# Start a thread

Starting a thread creates its conversation and a fresh pylon on the project's node. The pylon boots from the current image with the thread's overlay files in it, and the thread shows as running in the CLI and the dashboard.

## Sub-features

- `start-cli` starts a thread from the terminal and prints the new `Thread`.
- `start-cli-message` starts a thread and sends its first message in one command, taking the title from that message.
- `start-ui` starts a thread from the dashboard's start dialog and lands on the thread page.
- `start-boot` boots the thread's pylon to `running`, with `pylon.json` naming the thread.
- `start-refused` rejects an unknown project or a start with neither a title nor a message.

## How to get to it (user POV)

- Run `nexus start --project <P> --title <T>` in a terminal.
- Run `nexus start --project <P> --message <M>`, which titles the thread after the first non-empty line of `M`, trimmed and cut to 80 characters plus `...`.
- Choose `New thread` in the dashboard's sidebar or on a project's overview row, press `n` on any page, or open `/threads/new`, or `/threads/new?project=<P>` to choose the project.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds, and the stack serves `http://127.0.0.1:7470`.

- **CLI start.** Start a titled thread. Run `$V cli start-cli -- start --project spoon --title "start: cli" --json`. Exit 0. Stdout is a `Thread` with `status` `active`, `project` `spoon` and an `id` like `th-0123456789ab`. Keep it as `T1`.
- **Boot.** Wait for the pylon. Repeat `$V cli start-show -- show $T1 --json` every 5 s until `.pylon.actualState` is `running`, for up to 2 minutes. `.desired` is `running`, `.pylon.node` is `verify-node`, and `.pylon.failed` is null.
- **Overlay in the pylon.** Check what the boot wrote. Run `$V pylon start-overlay $T1 -- cat /home/user/.nexus/pylon.json`. The JSON's `threadId` is `$T1` and its `project` is `spoon`.
- **Start with a message.** Run `$V cli start-cli-message -- start --project spoon --message "bash: echo started-with-message" --json`. Exit 0, and the `title` is `bash: echo started-with-message`. Keep its `id` as `T2`. After the pylon runs, `$V cli start-msg-conversation -- conversation $T2 --json` holds a `pi.tool-result` entry whose text contains `started-with-message`.
- **Long first line.** Run `$V cli start-long -- start --project spoon --message "$(printf '\n\n%s\nsecond line' "$(printf 'x%.0s' $(seq 100))")" --json`. The `title` is the 100-character line cut to its first 80 characters plus `...`.
- **Dashboard start.** Open the dialog and submit it:
  - Each entry point opens the dialog, checked with `$V browser <step> -- eval "() => document.getElementById('start-dialog').open"` and closed again with `press Escape`: `click "aside .side-head [data-start]"` in the sidebar, `click "[data-start=spoon]"` on the overview, which also checks `spoon`, and `press n` with the focus outside any field. `press N` leaves the dialog closed.
  - Run `$V browser start-ui-open -- goto "http://127.0.0.1:7470/threads/new?project=spoon"`. The `Start a thread` dialog is open, with `spoon` checked under `Project`.
  - Run `$V browser start-ui-title -- fill "#start-title" "start: ui"`.
  - Run `$V browser start-ui-submit -- click "#start button[type=submit]"`. The page moves to `/threads/th-…`, and its header shows `start: ui`.
  - Capture the page with `$V browser start-ui-snap -- snapshot --filename start-ui.md` and `$V browser start-ui-shot -- screenshot --filename start-ui.png`.
  - Confirm the thread from the CLI: `$V cli start-ui-list -- threads --project spoon --json` has a row titled `start: ui`.
- **Refusals.** Run `$V cli start-unknown -- start --project nope --title x --json`, which exits 4 with stderr `{"error":"no project nope","kind":"not-found","status":404}`. Run `$V cli start-untitled -- start --project spoon --json`, which exits 64 before any request with stderr `{"error":"start needs --title or --message","kind":"invalid","status":null}`.
- **Proof.** The recorded `start-cli`, the `start-show` that reads `running`, `start-overlay`, `start-cli-message` with its conversation, `start-long`, the entry-point checks, `start-ui.md`, `start-ui.png`, `start-ui-list`, and the two refusals.

## Gotchas

- A thread's `id` exists before its pylon does. `actualState` reads `absent` or `spawning` for the first few seconds, so poll rather than asserting the first `show`.
- The scripted model treats a message that does not start with `bash: ` as plain text, so `start-cli-message` needs the prefix to produce a tool call.
- The stack's pylons run `sleep infinity` under Docker and never clone. The Spoon-Knife URL only labels the project. A fresh pylon's checkout is the image's one-commit repo, not Spoon-Knife.
- The shortcut is the bare lowercase `n`. `N`, a modifier, a focused text field or an open dialog leaves it doing nothing.
- `/threads/new` without `?project=` checks the first project by ID. After [Add a project](./add-project.md) that is `quill`, not `spoon`.
- Each started thread holds a container until `$V down` or its delete, so starting many threads in one run costs memory on Docker Desktop.
