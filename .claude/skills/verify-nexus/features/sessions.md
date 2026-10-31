# Herdr sessions and attach

A thread's pylon runs Herdr, and each session is a Herdr workspace with a harness in it: Claude Code, pi or a plain shell. From the Mac, a person opens a session with a title, sees it in the thread with that title, closes it, and attaches a terminal to the pylon's Herdr session. A session survives an archive and an unarchive, and an archived thread refuses to open one.

## Sub-features

- `sessions-open` opens a shell session with a title, and prints its pane, harness and title.
- `sessions-show` lists the open session in `show` with its title.
- `sessions-ui` lists the session under the thread page's Pylon tab, with the in-pylon attach command and its `Copy` button.
- `sessions-ui-open` opens a shell session from the Pylon tab's `New shell`, and `sessions-ui-close` closes it with its row's `Close`.
- `sessions-refused` refuses a harness Nexus does not know.
- `sessions-wake` keeps the session, with its title, across an archive and an unarchive.
- `sessions-paused` lists the session as paused while the thread is archived, and refuses to close it without waking the pylon.
- `sessions-close` closes the session's pane, and closing it again fails, because the pane is not open.
- `sessions-archived` refuses to open a session, or to attach, while the thread is archived.
- `sessions-attach` attaches a real terminal to the Herdr session through the control plane: it shows the session, follows a resize, counts as human presence while it stays, detaches with exit code 0 and leaves the terminal as it was, and an archived thread refuses it with exit code 5.

## How to get to it (user POV)

- Run `nexus session open <thread> [--harness claude-code|pi|shell] [--title T]` and `nexus session close <thread> <pane|id>` in a terminal. The harness defaults to `claude-code`, and the title to the harness's name.
- Run `nexus show <thread>`, whose `sessions` list each session with its harness, title, pane, and status or state: `paused (resumes on wake)`, `paused (resumes on unarchive)` or `failed: <why>`.
- Run `nexus attach <thread>` in a terminal. It goes through the control plane's attach route, here as on the home lab.
- The thread page's inspector lists sessions under `Sessions` in its `Pylon` tab, each with its harness, title, status and pane, a `paused, resumes on wake` or `paused, resumes on unarchive` state for a paused one, and `failed` with why for a failed one. While the thread is active, each running session's row has `Show in terminal`, which focuses its pane in Herdr, and `Close`, which asks for confirmation, and `New shell`, `New pi` and `New Claude` open a session below the list. Below them, `Attach from a shell in the pylon` shows `herdr --session nexus` with a `Copy` button. The page's `Terminal` tab attaches to the pylon's Herdr in the page. An archived thread's tab keeps only the list and the `Copy` button.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Thread `T` was started with `$V cli sessions-start -- start --project spoon --title "sessions: proof" --json`, and `show $T --json` reads `.pylon.actualState` `running`.
- `show $T --json` lists `.sessions` as `[]`. A fresh pylon has no Herdr server until a session opens.

- **Open.** Run `$V cli sessions-open -- session open $T --harness shell --title "sessions: sh" --json`. Exit 0, and stdout is `{"herdrPane": "<pane>", "harness": "shell", "title": "sessions: sh"}`. Keep `<pane>` as `P`.
- **Show.** Poll `$V cli sessions-show -- show $T --json` every 3 s, for up to 30 s, until `.sessions` has one entry. It has `id` and `herdrPane` `P`, `state` `running`, `message` null, `harness` `shell`, `title` `sessions: sh`, `harnessSessionId` null, and `status` `unknown` or `idle`. The node reads sessions again right after an open, so it usually shows on the first poll.
- **Herdr side effect.** Run `$V pylon sessions-herdr $T -- herdr --session nexus workspace list`. Its JSON reply lists a workspace whose `label` is `sessions: sh`.
- **Dashboard.** Run `$V browser sessions-ui-open -- goto http://127.0.0.1:7470/threads/$T`, then `$V browser sessions-ui-tab -- click 'label.seg-tab:has(input[value="pylon"])'`. The tab shows the heading `Sessions 1`, a row with `Shell`, `sessions: sh`, its status and `P`, and `Attach from a shell in the pylon` with `herdr --session nexus` and a `Copy` button. The row has `Show in terminal` and `Close`, and below the list sit `New shell`, `New pi` and `New Claude`. Capture `snapshot --filename sessions-ui.md` and `screenshot --filename sessions-ui.png`.
- **Open and close from the page.** Run `$V browser sessions-ui-new -- click "role=button[name=\"New shell\"]"`. The page opens its `Terminal` tab, and the Pylon tab's heading becomes `Sessions 2` within a poll. `$V cli sessions-ui-new-show -- show $T --json` lists a second running session, harness `shell` titled `shell`. Keep its `herdrPane` as `P3`, and capture `snapshot --filename sessions-ui-new.md` and `screenshot --filename sessions-ui-new.png` while it is open. Run `$V browser sessions-ui-close -- click 'li:has(code:text-is("<P3>")) >> role=button[name="Close"]'`, then `$V browser sessions-ui-close-accept -- dialog-accept`, and poll `show` until only `sessions: sh` is left. Then capture `sessions-ui-closed.md` and `sessions-ui-closed.png`.
- **Unknown harness.** `$V cli sessions-bad-harness -- session open $T --harness codex --json` exits 64 with `kind` `invalid` and `status` 400, and its `error` names `claude-code`, `pi` and `shell`.
- **Attach.** Run the proof script against the stack, from the checkout, in a shell that may run for about five minutes:

  ```sh
  node src/cli/attach.check.ts --project spoon --url http://127.0.0.1:7470 --socks none --skip-idle-pause --evidence "$($V evidence)/sessions-attach"
  ```

  It starts its own thread, so `T` is untouched, and makes each terminal itself, so it needs no terminal of yours. It exits 0 and prints `ATTACH_CHECK_PASS` last, after lines that show Herdr's screen with `attach-check`, Herdr drawing past row 30 after the resize to 140x40, `lastHumanActivityAt` advancing while attached, `attach-exit=0` and an `lflags` line with `icanon` and `echo` after the detach, and `attach-exit=5` with `archived` for the archived thread. `--skip-idle-pause` leaves out the wait of up to 30 minutes for the pylon to pause for idleness, and the attach that wakes it. Drop the flag to drive that too.
  - A failed step names itself and keeps the thread, whose ID the script prints. Delete it with `$V cli sessions-attach-delete -- delete <its ID> --json`.
  - If Herdr's prefix in the stack's pylons is not ctrl+b, pass it as `--prefix`.
- **Archived thread refuses.** Run `$V cli sessions-archive -- archive $T --json` and poll `show` until `.pylon.actualState` is `paused`. Then:
  - `$V cli sessions-archived-open -- session open $T --harness shell --json` exits 5. Its stderr is `{"error":"thread <T> is archived, so its pylon stays paused","kind":"conflict","status":409,"code":null}`.
  - `$V cli sessions-archived-attach -- attach $T --json` exits 64, and its stderr's `error` is `attach needs a terminal, and stdin or stdout is not one`, because `$V cli` gives the CLI no terminal. The attach step's `attach-archived` proves the refusal of an archived thread.
  - `show $T --json` still reads `archived` and `paused`.
  - The Pylon tab lists the session as `paused, resumes on unarchive`, with no session buttons and no `New shell`. Capture `sessions-ui-paused.md`.
  - **Paused session.** `$V cli sessions-archived-show -- show $T --json` lists `.sessions` as one entry with `id` and `herdrPane` `P`, `state` `paused`, `message` null and `title` `sessions: sh`: the pause recorded it, and the node reports it from the checkpoint's label. `show $T` without `--json` prints `session: shell "sessions: sh" in pane <P>, paused (resumes on unarchive)`.
  - `$V cli sessions-archived-close -- session close $T "$P" --json` exits 5. Its stderr is `{"error":"session <P> is paused with its pylon and resumes when \`nexus unarchive <T>\` wakes its pylon. Close it once it runs","kind":"conflict","status":409,"code":null}`, and `show` still reads `paused`.
- **Survives the wake.** Run `$V cli sessions-unarchive -- unarchive $T --json`, and poll `show` until `.pylon.actualState` is `running` and `.sessions` has an entry titled `sessions: sh` whose `state` is `running`, and no `paused` entry. Its `herdrPane` may differ from `P`. Keep it as `P2`. Run `docker logs pylon-$T 2>&1 | grep 'sessions:' > "$($V evidence)/sessions-wake-log.txt"`. The file holds a line for `"sessions: sh" (shell)`, either `was already running in <pane>` or `relaunched … in <pane>`.
- **Close.** Run `$V cli sessions-close -- session close $T "$P2" --json`. Exit 0, and stdout is `null`. Poll `show` until `.sessions` is `[]`. Then `$V cli sessions-close-again -- session close $T "$P2" --json` exits 4, and its stderr's `error` starts with `no session is open in pane <P2>`: a pane that is not open is never reported closed, because after a wake it may name another session.
- **Proof.** The recorded `sessions-open`, the `sessions-show` that lists the title, `sessions-herdr`, `sessions-ui.md` with `sessions-ui.png`, `sessions-ui-new-show`, `sessions-ui-new.md`, `sessions-ui-closed.md`, `sessions-ui-paused.md`, `sessions-bad-harness`, the `sessions-attach` directory with the script's output, `sessions-archived-open`, `sessions-archived-attach`, `sessions-archived-show` and `sessions-archived-close`, the `show` after `sessions-unarchive` that lists the title, `sessions-wake-log.txt`, `sessions-close`, the `show` with no sessions, and `sessions-close-again`.

## Gotchas

- The stack's pylon image has neither Claude Code nor pi, so only `--harness shell` and the page's `New shell` open here. Don't click `New pi` or `New Claude`. `--harness claude-code`, its `/login` and its resume after a wake are proven only on a real node. Always pass `--harness shell`, because the default is `claude-code`. A Claude Code open exits 1 with `status` 500, `herdr agent start: timed out waiting for agent startup`, and the pane's `/bin/sh: 1: claude: not found`. It can leave a pane behind that `show` lists as harness `shell` titled `claude-code`, so close it with `session close` before asserting on `.sessions`.
- The attach step goes straight to the control plane, with `--socks none`, so nothing here proves ts-home's SOCKS proxy for attach. Run the script on the home lab without `--url` and `--socks` for that.
- Docker's pause stops and removes the container, so the log of the pause, with its `sessions: recorded` line, goes with it. Only the wake's line survives in the new container's log.
- Docker pylons run Herdr as root, unlike a real pylon's `user`.
- A terminal left attached counts a human as present, so the pylon never pauses for idleness while it stays. The script's detached wait checks that its terminal went away with the detach.
