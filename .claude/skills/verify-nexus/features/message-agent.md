# Message the agent

A user sends a thread's agent a message. The agent runs tools inside the thread's pylon, and its turn shows up in the conversation from the CLI and on the dashboard's thread page. A message retried with the same request ID is taken once.

## Sub-features

- `msg-cli-send` sends a follow-up from the terminal and gets a submission number.
- `msg-tool` runs the agent's tool call in the pylon, and the conversation carries the call, its result and the final answer.
- `msg-disk` leaves the tool call's file on the pylon's disk.
- `msg-dedupe` takes a resend with the same `--request-id` as the same message.
- `msg-ui` sends from the dashboard's composer and shows the turn on the thread page, with its tool call as one line, `Bash echo from-ui >> proof.txt`.
- `msg-busy` shows the composer in its steer mode while a run is busy, and joins a busy run with `--steer`. Steering and queueing from the composer are driven by [the thread page's capture](../../../../docs/verification/thread-page-interaction/README.md), not here.

## How to get to it (user POV)

- Run `nexus send <thread> <text...>` in a terminal, with `--steer` to join a busy run, or `--request-id <ID>` to make a retry safe.
- Read the result with `nexus conversation <thread>`, or follow it with `nexus watch <thread>`.
- Type into `Message the agent` on the thread page, `/threads/<id>`, and choose the button `Send ⌘↵`, or press `⌘↵` or `Ctrl↵`. The line above the composer, `#agent-state`, reads `Idle`. While a run is busy it reads `Working`, the field reads `Steer the run…`, `#send` is named `Steer ⌘↵` and steers the run, and `#queue`, `Queue ⌥↵`, or `Alt↵` queues the message after the run.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Thread `T` was started with `$V cli msg-start -- start --project spoon --title "msg: proof" --json`, and `$V cli msg-pre-show -- show $T --json` reads `.pylon.actualState` `running`.

- **CLI send.** Ask for a file and its listing. Run `$V cli msg-cli-send -- send $T "bash: echo msg-proof > proof.txt && ls" --request-id msg:proof-1 --json`. Exit 0, and stdout's `.submission` is a number. Stdout is indented JSON, so read it with `jq`, not as a string.
- **Conversation.** Read the turn. Repeat `$V cli msg-conversation -- conversation $T --json` every 3 s, for up to 30 s, until the entries end in a `pi.assistant` entry whose text is `scripted answer after toolResult`. Before it, in order, are a `pi.user` entry with the sent text, a `pi.assistant` entry with a `toolCall` whose `name` is `bash` and whose `arguments.command` is the sent command, and a `pi.tool-result` entry whose text contains `proof.txt` and `README.md`.
- **Disk.** Confirm the side effect. Run `$V pylon msg-disk $T -- cat proof.txt`. Stdout is `msg-proof`.
- **Run settled.** Repeat `$V cli msg-show -- show $T --json` until `.thread.agentTurnRunning` is `false`, for up to 30 s.
- **Dedupe.** Resend the same message with the same ID. Run `$V cli msg-dedupe -- send $T "bash: echo msg-proof > proof.txt && ls" --request-id msg:proof-1 --json`. Exit 0, and `.submission` is the same number as the first send. Then `$V cli msg-dedupe-conversation -- conversation $T --json` holds exactly one `pi.user` entry with that text and one `toolCall` for it.
- **Dashboard send.** Send from the thread page:
  - Run `$V browser msg-ui-open -- goto http://127.0.0.1:7470/threads/$T`.
  - Run `$V browser msg-ui-fill -- fill "#prompt-text" "bash: echo from-ui >> proof.txt"`.
  - Run `$V browser msg-ui-send -- click "#send"`.
  - Repeat `$V browser msg-ui-snap -- snapshot` every 5 s, for up to 30 s, until it shows the `bash: echo from-ui >> proof.txt` message, the call's line after it, and a later `scripted answer after toolResult`.
  - Open the call with `$V browser msg-ui-unfold -- click "details.tool >> nth=-1 >> :scope > summary"`. Then `$V browser msg-ui-snap-open -- snapshot --filename msg-ui.md` shows the row `succeeded Bash echo from-ui >> proof.txt` with how long it took, and its command and `No output.` under it, and `$V browser msg-ui-shot -- screenshot --filename msg-ui.png` captures it.
  - Send by keyboard: `$V browser msg-ui-kbd-fill -- fill "#prompt-text" "bash: echo from-kbd >> proof.txt"`, then `$V browser msg-ui-kbd -- press Meta+Enter`. The message, a new call line and the answer appear as above.
  - Confirm from the other views: `$V pylon msg-ui-disk $T -- cat proof.txt` prints `msg-proof`, `from-ui` and `from-kbd`, and `$V cli msg-ui-conversation -- conversation $T --json` holds the dashboard's message as a `pi.user` entry, followed by its `toolCall` and a final `scripted answer after toolResult`.
- **Busy.** Run `$V cli msg-busy -- send $T "stream: 400" --json`, whose answer streams for about 8 s, and right away `$V browser msg-ui-busy -- snapshot --filename msg-ui-busy.md`. It shows `Working` in `#agent-state`, the placeholder `Steer the run…`, and the buttons `Queue ⌥↵` and `Steer ⌘↵`. Right away too, run `$V cli msg-steer -- send $T "steered note" --steer --json`, which exits 0 with a `.submission`. Once `show` reads `.thread.agentTurnRunning` `false`, `$V cli msg-steer-conversation -- conversation $T --json` holds, in order, `pi.user` `stream: 400`, the `pi.assistant` `word0` to `word399`, `pi.user` `steered note` and `pi.assistant` `scripted answer after user`.
- **Proof.** The recorded `msg-cli-send`, the final `msg-conversation`, `msg-disk`, `msg-dedupe` with `msg-dedupe-conversation`, `msg-ui-conversation`, `msg-ui.md`, `msg-ui.png`, `msg-ui-disk`, `msg-ui-busy.md`, `msg-steer` and `msg-steer-conversation`.

## Gotchas

- Tool calls run as root through Docker, so `~` is `/root`, not `/home/user`. The overlay files are under `/home/user/.nexus`, and the working directory is `/home/user/workspace/repo`. A real pylon runs them as `user`.
- A Docker pylon's environment has a working bridge, `NEXUS_API=http://host.docker.internal:7482/<token>`, but the agent's tools run in a login shell, where the overlay's `/etc/profile.d/nexus.sh` sets `NEXUS_API` to `http://nexus.pylon`. Nothing in a Docker pylon resolves that name, so an agent's in-pylon `nexus` command fails here, though it works on a Gondolin pylon. Don't map outputs or previews through this stack until that is solved.
- Only messages that start with `bash: ` make a tool call. Only a `stream: <n>` message streams, so only its answer shows a `partial` in `watch --json` and grows in place on the thread page.
- The conversation route serves the active context, not the full history. Find entries by kind and text, not by position or ID order. A `pi.system` entry with no text and the tool definitions sits between the first `pi.user` and its answer. Skip it.
- Each tool call is a `<details class="tool">` whose summary is its one line. A lone call stands alone, and two or more calls in a row sit in a `<details class="steps">` whose summary says what they did, such as `Ran 2 commands`, which starts closed only past five calls. Scope a click to one element's own summary with `:scope > summary`, because a bare `summary` inside a run matches the fold's and the row's, and Playwright refuses it as ambiguous.
- A command with no output, such as `echo x >> file`, gives a `pi.tool-result` with empty `content` and `isError: false`. Prove that kind of call through the disk.
- A send to an archived thread exits 5 with `"kind": "conflict"`. That case belongs to [Archive and unarchive](./archive-thread.md).
- `$V browser` steps run in the evidence directory. A relative `--filename` lands there, but an absolute one does not. playwright-cli also saves a snapshot of each page it touches into `.playwright-cli/` there.
