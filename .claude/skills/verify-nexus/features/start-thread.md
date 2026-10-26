# Start a thread

Starting a thread creates its conversation and a fresh pylon on the project's node. The pylon boots from the current image with the thread's overlay files in it, and the thread shows as running in the CLI and the dashboard.

## Sub-features

- `start-cli` starts a thread from the terminal and prints the new `Thread`.
- `start-cli-message` starts a thread and sends its first message in one command, taking the title from that message.
- `start-options` starts a thread on a named node and branch.
- `start-placement` records where the pylon went, as `placement`: the project's default node, or the node with the most room left with `--node auto`.
- `start-size` starts a thread with its own CPUs, memory and disk instead of the project's.
- `start-ui` starts a Nexus agent thread from the dashboard's start dialog, whose hint names the node, the image and the branch, and lands on the thread page.
- `start-boot` boots the thread's pylon to `running`, with `pylon.json` naming the thread.
- `start-refused` rejects an unknown project, an unknown node, a start with no project, a start with no title, message or Claude prompt, a size that is not a whole number, and `--model` without `--claude`.

## How to get to it (user POV)

- Run `nexus start --project <P> --title <T>` in a terminal, with `--node <N|auto>`, `--branch`, `--commit`, `--cpus`, `--memory` and `--disk` to override the project's defaults. A scratch project refuses `--commit` (see [Add a project](./add-project.md)).
- Run `nexus start --project <P> --claude <prompt> [--model <ID>]` to start a Claude worker thread instead of a Nexus agent one. This stack never starts one (see Gotchas).
- Run `nexus start --project <P> --message <M>`, which titles the thread after the first non-empty line of `M`, trimmed and cut to 80 characters plus `...`.
- Choose `New thread` in the dashboard's sidebar, the `+` that shows when the pointer is over a project in the sidebar, or `New thread` in a project's section header on the overview. Or press `n` on any page, or open `/threads/new`, or `/threads/new?project=<P>` to choose the project.
- The dialog asks first for the `Worker`: `Claude Code`, the default, with a required `Prompt` and an optional `Model`, or `Nexus agent`. Then it asks for the title, which only `Nexus agent` requires, the project, the node, which can be `auto`, the branch, and the CPUs, memory and disk. Its hint reads `Boots a pylon on <node> from image <image> and checks out <branch>.`
- A thread whose pylon failed offers `Start again` on its page, which opens the dialog with its title filled in.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds, and the stack serves `http://127.0.0.1:7470`.

- **CLI start.** Start a titled thread. Run `$V cli start-cli -- start --project spoon --title "start: cli" --json`. Exit 0. Stdout is a `Thread` with `status` `active`, `project` `spoon`, `placement` `{"how": "default", "node": "verify-node"}` and an `id` like `th-0123456789ab`. Keep it as `T1`.
- **Boot.** Wait for the pylon. Repeat `$V cli start-show -- show $T1 --json` every 5 s until `.pylon.actualState` is `running`, for up to 2 minutes. `.desired` is `running`, `.pylon.node` is `verify-node`, and `.pylon.failed` is null.
- **Overlay in the pylon.** Check what the boot wrote. Run `$V pylon start-overlay $T1 -- cat /home/user/.nexus/pylon.json`. The JSON's `threadId` is `$T1` and its `project` is `spoon`.
- **Start with a message.** Run `$V cli start-cli-message -- start --project spoon --message "bash: echo started-with-message" --json`. Exit 0, and the `title` is `bash: echo started-with-message`. Keep its `id` as `T2`. After the pylon runs, `$V cli start-msg-conversation -- conversation $T2 --json` holds a `pi.tool-result` entry whose text contains `started-with-message`.
- **Long first line.** Run `$V cli start-long -- start --project spoon --message "$(printf '\n\n%s\nsecond line' "$(printf 'x%.0s' $(seq 100))")" --json`. The `title` is the 100-character line cut to its first 80 characters plus `...`.
- **Node and branch.** `$V cli start-options -- start --project spoon --title "start: branch" --node verify-node --branch main --json` exits 0 with `project` `spoon`.
- **Auto placement.** `$V cli start-auto -- start --project spoon --title "start: auto" --node auto --json` exits 0 with `placement.how` `auto` and `placement.node` `verify-node`.
- **Size.** `$V cli start-size -- start --project spoon --title "start: size" --cpus 2 --memory 2 --disk 2 --json` exits 0. Once its pylon runs, `$V cli start-size-show -- show <id> --json` has `.pylon.resources` `{"cpus": 2, "memoryGiB": 2, "diskGiB": 2}`, where the seeded project has 1, 1 and 1. Delete the `start: auto` and `start: size` threads once checked, because each holds a container.
- **Dashboard start.** Open the dialog and submit it:
  - Each entry point opens the dialog, checked with `$V browser <step> -- eval "() => document.getElementById('start-dialog').open"` and closed again with `press Escape`: `click "aside .side-head [data-start]"` in the sidebar, `click "#overview [data-start=spoon]"` on the overview, which also checks `spoon`, `hover "#group-spoon > summary"` then `click "#group-spoon .group-new"` in the sidebar, which also checks `spoon`, and `press n` with the focus outside any field. `press N` leaves the dialog closed.
  - Run `$V browser start-ui-open -- goto "http://127.0.0.1:7470/threads/new?project=spoon"`. The `Start a thread` dialog is open, with `spoon` checked under `Project` and `Claude Code` checked under `Worker`. `eval "() => document.getElementById('start-hint').textContent"` prints `Boots a pylon on verify-node from image img-0000000000aa and checks out main.`
  - Run `$V browser start-ui-worker -- click 'label.seg-opt:has(input[value="harness"])'` to choose `Nexus agent`. Without it the submit does nothing, because the empty `Prompt` is required.
  - Run `$V browser start-ui-title -- fill "#start-title" "start: ui"`.
  - Run `$V browser start-ui-submit -- click "#start button[type=submit]"`. The page moves to `/threads/th-…`, and its header shows `start: ui`.
  - Capture the page with `$V browser start-ui-snap -- snapshot --filename start-ui.md` and `$V browser start-ui-shot -- screenshot --filename start-ui.png`.
  - Confirm the thread from the CLI: `$V cli start-ui-list -- threads --project spoon --json` has a row titled `start: ui`.
- **Refusals.** Run `$V cli start-unknown -- start --project nope --title x --json`, which exits 4 with stderr `{"error":"no project nope","kind":"not-found","status":404}`. Run `$V cli start-untitled -- start --project spoon --json`, which exits 64 before any request with stderr `{"error":"start needs --title, --message or --claude","kind":"invalid","status":null}`. `$V cli start-bad-node -- start --project spoon --title x --node nope --json` exits 64 with `{"error":"no node nope","kind":"invalid","status":400}`, and `$V cli start-no-project -- start --title x --json` exits 64 before any request with `{"error":"start needs --project","kind":"invalid","status":null}`. `$V cli start-cpus-invalid -- start --project spoon --title x --cpus 1.5 --json` exits 64 before any request with `{"error":"--cpus takes a whole number, got 1.5","kind":"invalid","status":null}`, and `$V cli start-model-invalid -- start --project spoon --title x --model m --json` exits 64 before any request with `{"error":"--model requires --claude","kind":"invalid","status":null}`.
- **Proof.** The recorded `start-cli`, the `start-show` that reads `running`, `start-overlay`, `start-cli-message` with its conversation, `start-long`, `start-options`, `start-auto`, `start-size` with `start-size-show`, the entry-point checks, the hint, `start-ui.md`, `start-ui.png`, `start-ui-list`, and the six refusals.

## Gotchas

- A thread's `id` exists before its pylon does. `actualState` reads `absent` or `spawning` for the first few seconds, so poll rather than asserting the first `show`.
- The scripted model treats a message that does not start with `bash: ` as plain text, so `start-cli-message` needs the prefix to produce a tool call.
- The stack's pylons run `sleep infinity` under Docker and never clone. The Spoon-Knife URL only labels the project. A fresh pylon's checkout is the image's one-commit repo, not Spoon-Knife.
- A bare `[data-start=spoon]` matches both the overview's `New thread` and the sidebar's hidden `+`, so Playwright refuses it as ambiguous. Scope it to `#overview`.
- `Start again` needs a failed pylon, which this recipe never makes, so it stays unverified.
- The recipe never starts a Claude worker thread, from `--claude` or the dialog's default `Claude Code` worker, because the scripted model stands in only for the Nexus agent. Claude worker starts stay unverified here.
- With `Claude Code` chosen, the dialog is taller than an 800-pixel viewport, and clicking its submit fails with `element is outside of the viewport`. Choosing `Nexus agent` first hides the Claude fields and brings the button back into view.
- The page's script sets the tab title to `Nexus`, with the unread count in front, such as `(2) Nexus`, so the served title `Start a thread · Nexus` does not last. Assert on the open dialog instead.
- The shortcut is the bare lowercase `n`. `N`, a modifier, a focused text field or an open dialog leaves it doing nothing.
- `/threads/new` without `?project=` checks the first project by ID. After [Add a project](./add-project.md) that is `quill`, not `spoon`.
- Each started thread holds a container until `$V down` or its delete, so starting many threads in one run costs memory on Docker Desktop.
