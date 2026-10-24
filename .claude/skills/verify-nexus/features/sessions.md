# Herdr sessions and attach

A thread's pylon runs Herdr, and each session is a Herdr workspace with a harness in it: Claude Code, pi or a plain shell. From the Mac, a person opens a session with a title, sees it in the thread with that title, closes it, and attaches a terminal to the pylon's Herdr session. A session survives an archive and an unarchive, and an archived thread refuses to open one.

## Sub-features

- `sessions-open` opens a shell session with a title, and prints its pane, harness and title.
- `sessions-show` lists the open session in `show` with its title.
- `sessions-wake` keeps the session, with its title, across an archive and an unarchive.
- `sessions-close` closes the session's pane, and closing it again also succeeds.
- `sessions-archived` refuses to open a session, or to attach, while the thread is archived.
- `sessions-attach-resolve` resolves the attach command: the thread's pylon, node and node host reach the configured attach command, which reaches the pylon's Herdr session.
- `sessions-attach-pty` attaches a real terminal to the Herdr session and counts it as an attached terminal while it stays.

## How to get to it (user POV)

- Run `nexus session open <thread> [--harness claude-code|pi|shell] [--title T]` and `nexus session close <thread> <pane>` in a terminal.
- Run `nexus show <thread>`, whose `sessions` list each pane with its harness, status and title.
- Run `nexus attach <thread>`. On the home lab it runs `ssh -t <node> nexus-attach <pylon>`. Here, with no node to ssh to, it runs the command in `NEXUS_ATTACH` with `sh -c`.
- The dashboard's thread page lists sessions under `Sessions` with their titles, and offers no open, close or attach yet.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Thread `T` was started with `$V cli sessions-start -- start --project spoon --title "sessions: proof" --json`, and `show $T --json` reads `.pylon.actualState` `running`.
- `show $T --json` lists `.sessions` as `[]`. A fresh pylon has no Herdr server until a session opens.

- **Open.** Run `$V cli sessions-open -- session open $T --harness shell --title "sessions: sh" --json`. Exit 0, and stdout is `{"herdrPane": "<pane>", "harness": "shell", "title": "sessions: sh"}`. Keep `<pane>` as `P`.
- **Show.** Poll `$V cli sessions-show -- show $T --json` every 3 s, for up to 30 s, until `.sessions` has one entry. It has `herdrPane` `P`, `harness` `shell`, `title` `sessions: sh`, `harnessSessionId` null, and `status` `unknown` or `idle`. The node reads sessions again right after an open, so it usually shows on the first poll.
- **Herdr side effect.** Run `$V pylon sessions-herdr $T -- herdr --session nexus workspace list`. Its JSON reply lists a workspace whose `label` is `sessions: sh`.
- **Attach resolution, environment.** Run `NEXUS_ATTACH='printf "%s %s %s %s\n" "$NEXUS_THREAD" "$NEXUS_PYLON" "$NEXUS_NODE" "$NEXUS_NODE_HOST"' $V cli sessions-attach-env -- attach $T`. Exit 0, and stdout is `<T> pylon-<T> verify-node 127.0.0.1`. This proves that `attach` found the running pylon, its node and the node's `tailnetHost`, and handed them to the attach command. It does not prove ssh, `nexus-attach` or a terminal.
- **Attach resolution, Herdr.** Run `NEXUS_ATTACH='docker exec $NEXUS_PYLON herdr --session nexus workspace list' $V cli sessions-attach-resolve -- attach $T`. Exit 0, and stdout is Herdr's JSON reply listing the workspace `sessions: sh`. This proves the resolved names reach the pylon's container and its Herdr session, without a pty. The interactive form is `NEXUS_ATTACH='docker exec -it $NEXUS_PYLON herdr --session nexus' nexus attach $T`, which the next step drives.
- **Attach with a pty.** This step is optional, because it needs `script` to give the command a pseudo-terminal. Run it in one shell:

  ```sh
  E=$($V evidence)
  NEXUS_ATTACH='docker exec -it $NEXUS_PYLON herdr --session nexus' NEXUS_URL=http://127.0.0.1:7470 NEXUS_SOCKS=none \
    script -q "$E/sessions-attach-pty.typescript" node src/cli/nexus.ts attach $T </dev/null & ATTACH=$!
  sleep 5
  $V pylon sessions-attached $T -- pgrep -c -x -f 'herdr --session nexus'
  kill $ATTACH; sleep 2
  $V pylon sessions-detached $T -- pgrep -c -x -f 'herdr --session nexus'
  ```

  - While attached, `sessions-attached` prints `1`: one Herdr client whose command line the probe counts as an attached terminal, which is what keeps a pylon awake.
  - After the kill, `sessions-detached` should print `0`, with pgrep exiting 1. If it prints `1`, Docker left the Herdr client running after its terminal went away. Report that as a finding: here it keeps the pylon awake until the container stops. On a real node, sshd hangs up the session's processes when ssh disconnects, which this stack does not show.
  - `sessions-attach-pty.typescript` holds Herdr's screen, with the workspace `sessions: sh`.
  - If `script` fails without a terminal of its own, report `sessions-attach-pty` as not driven, with its error. Never report it as verified through `sessions-attach-resolve`.
- **Archived thread refuses.** Run `$V cli sessions-archive -- archive $T --json` and poll `show` until `.pylon.actualState` is `paused`. Then:
  - `$V cli sessions-archived-open -- session open $T --harness shell --json` exits 5. Its stderr is `{"error":"thread <T> is archived, so its pylon stays paused","kind":"conflict","status":409}`.
  - `$V cli sessions-archived-attach -- attach $T --json`, with `NEXUS_ATTACH` set as in the environment step, exits 5. Its stderr's `error` starts with `thread <T> is archived, so its pylon stays paused`, its `status` is null, and stdout is empty, so the attach command never ran.
  - `show $T --json` still reads `archived` and `paused`.
- **Survives the wake.** Run `$V cli sessions-unarchive -- unarchive $T --json`, and poll `show` until `.pylon.actualState` is `running` and `.sessions` has an entry titled `sessions: sh`. Its `herdrPane` may differ from `P`. Keep it as `P2`. Run `docker logs pylon-$T 2>&1 | grep 'sessions:' > "$($V evidence)/sessions-wake-log.txt"`. The file holds a line for `"sessions: sh" (shell)`, either `was already running in <pane>` or `relaunched … in <pane>`.
- **Close.** Run `$V cli sessions-close -- session close $T "$P2" --json`. Exit 0, and stdout is `null`. Poll `show` until `.sessions` is `[]`. Then `$V cli sessions-close-again -- session close $T "$P2" --json` exits 0 with `null` too, because a pane that is already gone counts as closed.
- **Proof.** The recorded `sessions-open`, the `sessions-show` that lists the title, `sessions-herdr`, `sessions-attach-env`, `sessions-attach-resolve`, `sessions-attached` and `sessions-detached` if the pty step ran, `sessions-archived-open`, `sessions-archived-attach`, the `show` after `sessions-unarchive` that lists the title, `sessions-wake-log.txt`, `sessions-close`, the `show` with no sessions, and `sessions-close-again`.

## Gotchas

- The stack's pylon image has neither Claude Code nor pi, so only `--harness shell` opens here. `--harness claude-code`, its `/login` and its resume after a wake are proven only on a real node.
- Neither ssh nor `nexus-attach` runs here. Nothing in this stack proves the default attach path, Tailscale SSH, ts-home's SOCKS proxy or the node's sudo rule.
- `$V cli` passes the caller's environment through, so set `NEXUS_ATTACH` in front of `$V`, as the steps do. A `NEXUS_ATTACH` left exported changes every later `attach` in the same shell.
- Docker's pause stops and removes the container, so the log of the pause, with its `sessions: recorded` line, goes with it. Only the wake's line survives in the new container's log.
- Docker pylons run Herdr as root, unlike a real pylon's `user`. The attach command therefore runs `docker exec` without `-u`.
- A terminal left attached counts a human as present, so the pylon never pauses for idleness while it stays. Kill the pty step's process before you move on.
