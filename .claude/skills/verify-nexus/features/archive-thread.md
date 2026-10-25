# Archive and unarchive

Archiving a thread puts its pylon to sleep at once. The VM stops and only its disk is kept, as a checkpoint. While the thread is archived, it refuses new messages. Unarchiving wakes the pylon from that checkpoint, so files the agent wrote are still there.

## Sub-features

- `archive-cli` archives from the terminal, and the pylon pauses to a checkpoint.
- `archive-refuse` refuses a message to an archived thread with a conflict.
- `unarchive-cli` unarchives from the terminal, and the pylon runs again with its disk intact.
- `archive-ui` archives and unarchives with the thread page's `Archive` and `Unarchive` buttons.

## How to get to it (user POV)

- Run `nexus archive <thread>` and `nexus unarchive <thread>` in a terminal.
- Choose `Archive` or `Unarchive` in the thread page's header, `/threads/<id>`. On a narrow window, they sit behind the `Thread actions` menu.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Thread `T` was started with `$V cli archive-start -- start --project spoon --title "archive: proof" --json`, and its pylon is `running`.
- Its disk holds a marker written by the agent: `$V cli archive-mark -- send $T "bash: echo before-archive > marker.txt" --json`. `send` returns before the tool runs, so poll `conversation $T --json` until it ends in `scripted answer after toolResult`. Then `$V pylon archive-mark-disk $T -- cat marker.txt` prints `before-archive`.

- **Archive.** Run `$V cli archive-cli -- archive $T --json`. Exit 0, and the returned `Thread` has `status` `archived`.
- **Paused.** Repeat `$V cli archive-show -- show $T --json` every 5 s, for up to 2 minutes, until `.pylon.actualState` is `paused`. `.desired` is `paused`.
- **Checkpoint, no VM.** Run `{ docker ps -a --filter label=nexus.pylon=pylon-$T --format '{{.Names}}'; docker images --filter label=nexus.pylon=pylon-$T --format '{{.Repository}}:{{.Tag}}'; } > "$($V evidence)/archive-docker.txt"`. The file holds no container name and exactly one `nexus-checkpoint/pylon-$T:<checkpoint>`.
- **Refused message.** Run `$V cli archive-refuse -- send $T "bash: echo should-not-run" --json`. Exit 5, and stderr is `{"error":"thread <T> is archived","kind":"conflict","status":409}`.
- **Wake and archive again.** `$V cli archive-wake -- wake $T --json` exits 0, and `show $T --json` still reads `archived` and `paused`. `$V cli archive-again -- archive $T --json` exits 0 with `status` `archived`.
- **Unarchive.** Run `$V cli unarchive-cli -- unarchive $T --json`. Exit 0, and `status` is `active`. Poll `show` until `.pylon.actualState` is `running`. A second `$V cli unarchive-twice -- unarchive $T --json` exits 5 with stderr `{"error":"thread <T> is active, not archived","kind":"conflict","status":409}`.
- **Disk survived.** Run `$V pylon unarchive-disk $T -- cat marker.txt`, which prints `before-archive`. Then send `bash: cat marker.txt` with `$V cli unarchive-send` and read `conversation`. The new `pi.tool-result` contains `before-archive`.
- **Dashboard.** Repeat archive and unarchive from the page:
  - Run `$V browser archive-ui-open -- goto http://127.0.0.1:7470/threads/$T`, then `$V browser archive-ui-click -- click "#archive"`.
  - Within a few seconds, because the page reads again after the click, the header shows `Unarchive`, and its status chip (`.chip-label`) reads `archived`. The composer is replaced by `An archived thread takes no messages, because its pylon stays paused. Unarchive the thread to send one.`, the Changes tab, once selected with `click 'label.seg-tab:has(input[value="changes"])'`, reads `An archived thread's pylon stays paused, so its changes can't be read. Unarchive the thread to read them.` in place of the tree it read before, and the sidebar folds the thread under the project's closed summary, `1 archived` when it is the project's only closed thread. Capture it with `snapshot --filename archive-ui.md` and `screenshot --filename archive-ui.png`.
  - Once `show $T --json` reads `paused`, the step above's Docker command lists two checkpoints, one for each pause.
  - Run `$V browser unarchive-ui-click -- click "#unarchive"`. Within two polls `Archive` and the composer are back. Capture `snapshot --filename unarchive-ui.md` and `screenshot --filename unarchive-ui.png`.
  - Confirm both through `show $T --json` after each click.
  - On a narrow window, run `resize 600 900`, then `click "role=button[name=\"Thread actions\"]"`. The opened menu holds `Archive` and `Delete`. `resize 1280 800` restores the layout.
- **Proof.** The recorded `archive-cli`, the `archive-show` that reads `paused`, `archive-docker.txt`, `archive-refuse`, `unarchive-cli`, `unarchive-disk`, `archive-ui.md` with `archive-ui.png`, and `unarchive-ui.md` with `unarchive-ui.png`.

## Gotchas

- Docker's pause records the Herdr sessions, then runs `docker stop`, `docker commit` and `docker rm`, so running processes and memory are lost, as on a real pylon. Prove survival with a file, not a process.
- Unarchiving is the only path that wakes an archived thread. `nexus wake` records activity but never unarchives it, and opening an archived thread's page records no activity at all.
- Each pause adds a checkpoint image, including the idle pause after 20 minutes without human activity and 5 without agent activity, and a wake keeps the old ones. Only delete or `$V down` removes them, so a run that archives many threads holds their layers until then.
- The closed summary counts archived and deleted threads together, such as `2 archived, 1 deleted`, so its text depends on what ran earlier in the run.
- `actualState` passes through `pausing` and `spawning`. Assert only the settled `paused` and `running`.
