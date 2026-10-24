# Message the agent

A user sends a thread's agent a message. The agent runs tools inside the thread's pylon, and its turn shows up in the conversation from the CLI and on the dashboard's thread page. A message retried with the same request ID is taken once.

## Sub-features

- `msg-cli-send` sends a follow-up from the terminal and gets a submission number.
- `msg-tool` runs the agent's tool call in the pylon, and the conversation carries the call, its result and the final answer.
- `msg-disk` leaves the tool call's file on the pylon's disk.
- `msg-dedupe` takes a resend with the same `--request-id` as the same message.
- `msg-ui` sends from the dashboard's composer and shows the turn on the thread page.

## How to get to it (user POV)

- Run `nexus send <thread> <text...>` in a terminal, with `--steer` to join a busy run, or `--request-id <ID>` to make a retry safe.
- Read the result with `nexus conversation <thread>`, or follow it with `nexus watch <thread>`.
- Type into `Message the agent` on the thread page, `/threads/<id>`, and choose `Send` or press `⌘↵`.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Thread `T` was started with `$V cli msg-start -- start --project spoon --title "msg: proof" --json`, and `$V cli msg-pre-show -- show $T --json` reads `.pylon.actualState` `running`.

- **CLI send.** Ask for a file and its listing. Run `$V cli msg-cli-send -- send $T "bash: echo msg-proof > proof.txt && ls" --request-id msg:proof-1 --json`. Exit 0, and stdout is `{"submission": <n>}`.
- **Conversation.** Read the turn. Repeat `$V cli msg-conversation -- conversation $T --json` every 3 s, for up to 30 s, until the entries end in a `pi.assistant` entry whose text is `scripted answer after toolResult`. Before it, in order, are a `pi.user` entry with the sent text, a `pi.assistant` entry with a `toolCall` whose `name` is `bash` and whose `arguments.command` is the sent command, and a `pi.tool-result` entry whose text contains `proof.txt` and `README.md`.
- **Disk.** Confirm the side effect. Run `$V pylon msg-disk $T -- cat proof.txt`. Stdout is `msg-proof`.
- **Run settled.** Run `$V cli msg-show -- show $T --json`. `.thread.agentTurnRunning` is `false`.
- **Dedupe.** Resend the same message with the same ID. Run `$V cli msg-dedupe -- send $T "bash: echo msg-proof > proof.txt && ls" --request-id msg:proof-1 --json`. Exit 0, and stdout is the same `{"submission": <n>}` as the first send. Then `$V cli msg-dedupe-conversation -- conversation $T --json` holds exactly one `pi.user` entry with that text and one `toolCall` for it.
- **Dashboard send.** Send from the thread page:
  - Run `$V browser msg-ui-open -- goto http://127.0.0.1:7470/threads/$T`.
  - Run `$V browser msg-ui-fill -- fill "#prompt-text" "bash: echo from-ui >> proof.txt"`.
  - Run `$V browser msg-ui-send -- click "#send"`.
  - Repeat `$V browser msg-ui-snap -- snapshot --filename msg-ui.md` every 5 s, for up to 30 s, until the snapshot shows the `bash: echo from-ui >> proof.txt` message, a `bash echo from-ui >> proof.txt ✓` tool row, and a later `scripted answer after toolResult`. Then run `$V browser msg-ui-shot -- screenshot --filename msg-ui.png`.
  - Confirm from the other views: `$V pylon msg-ui-disk $T -- cat proof.txt` prints `msg-proof`, then `from-ui`, and `$V cli msg-ui-conversation -- conversation $T --json` holds the dashboard's message as a `pi.user` entry, followed by its `toolCall` and a final `scripted answer after toolResult`.
- **Proof.** The recorded `msg-cli-send`, the final `msg-conversation`, `msg-disk`, `msg-dedupe` with `msg-dedupe-conversation`, `msg-ui-conversation`, `msg-ui.md`, `msg-ui.png` and `msg-ui-disk`.

## Gotchas

- Tool calls run as root through Docker, so `~` is `/root`, not `/home/user`. The overlay files are under `/home/user/.nexus`, and the working directory is `/home/user/workspace/repo`. A real pylon runs them as `user`.
- `NEXUS_API` in a login shell is `http://nexus.pylon`, from the overlay's `/etc/profile.d/nexus.sh`. Nothing in a Docker pylon resolves that name, so an agent's in-pylon `nexus` command fails here, though it works on a Gondolin pylon. Don't map outputs or previews through this stack until that is solved.
- Only messages that start with `bash: ` make a tool call. Only a `stream: <n>` message streams, so only its answer shows a `partial` in `watch --json` and grows in place on the thread page.
- The conversation route serves the active context, not the full history. Find entries by kind and text, not by position or ID order. A `pi.system` entry with no text and the tool definitions sits between the first `pi.user` and its answer. Skip it.
- A command with no output, such as `echo x >> file`, gives a `pi.tool-result` with empty `content` and `isError: false`. Prove that kind of call through the disk.
- A send to an archived thread exits 5 with `"kind": "conflict"`. That case belongs to [Archive and unarchive](./archive-thread.md).
- `$V browser` steps run in the evidence directory. A relative `--filename` lands there, but an absolute one does not. playwright-cli also saves a snapshot of each page it touches into `.playwright-cli/` there.
