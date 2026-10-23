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
- Run `nexus start --project <P> --message <M>`, which titles the thread after the first line of `M`.
- Choose `New thread` in the dashboard's sidebar or on a project's overview row, press `N` on any page, or open `/threads/new`.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds, and the stack serves `http://127.0.0.1:7470`.

- **CLI start.** Start a titled thread. Run `$V cli start-cli -- start --project spoon --title "start: cli" --json`. Exit 0. Stdout is a `Thread` with `status` `active`, `project` `spoon` and an `id` like `th-0123456789ab`. Keep it as `T1`.
- **Boot.** Wait for the pylon. Repeat `$V cli start-show -- show $T1 --json` every 5 s until `.pylon.actualState` is `running`, for up to 2 minutes. `.desired` is `running`, `.pylon.node` is `verify-node`, and `.pylon.failed` is null.
- **Overlay in the pylon.** Check what the boot wrote. Run `$V pylon start-overlay $T1 -- cat /home/user/.nexus/pylon.json`. The JSON's `threadId` is `$T1` and its `project` is `spoon`.
- **Start with a message.** Run `$V cli start-cli-message -- start --project spoon --message "bash: echo started-with-message" --json`. Exit 0, and the `title` is `bash: echo started-with-message`. After the pylon runs, `conversation <id> --json` holds a `pi.tool-result` entry whose text contains `started-with-message`.
- **Dashboard start.** Open the dialog and submit it:
  - Run `$V browser start-ui-open -- goto http://127.0.0.1:7470/threads/new`. The `Start a thread` dialog is open, with `spoon` checked under `Project`.
  - Run `$V browser start-ui-title -- fill "#start-title" "start: ui"`.
  - Run `$V browser start-ui-submit -- click "#start button[type=submit]"`. The page moves to `/threads/th-…`, and its header shows `start: ui`.
  - Capture the page with `$V browser start-ui-snap -- snapshot --filename start-ui.md` and `$V browser start-ui-shot -- screenshot --filename start-ui.png`.
  - Confirm the thread from the CLI: `$V cli start-ui-list -- threads --project spoon --json` has a row titled `start: ui`.
- **Refusals.** Run `$V cli start-unknown -- start --project nope --title x --json`, which exits 4 with `"kind": "not-found"`. Run `$V cli start-untitled -- start --project spoon --json`, which exits 64 with `"kind": "invalid"`.
- **Proof.** The recorded `start-cli`, the `start-show` that reads `running`, `start-overlay`, `start-ui.md` and `start-ui.png`, and the two refusals.

## Gotchas

- A thread's `id` exists before its pylon does. `actualState` reads `absent` or `spawning` for the first few seconds, so poll rather than asserting the first `show`.
- The scripted model treats a message that does not start with `bash: ` as plain text, so `start-cli-message` needs the prefix to produce a tool call.
- The stack's pylons run `sleep infinity` under Docker and never clone. The Spoon-Knife URL only labels the project. A fresh pylon's checkout is the image's one-commit repo, not Spoon-Knife.
- The dashboard's `N` shortcut types into a focused text field instead of opening the dialog.
- Each started thread holds a container until `$V down` or its delete, so starting many threads in one run costs memory on Docker Desktop.
