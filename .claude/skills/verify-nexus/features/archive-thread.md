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
- Its disk holds a marker written by the agent: `$V cli archive-mark -- send $T "bash: echo before-archive > marker.txt" --json`, and `$V pylon archive-mark-disk $T -- cat marker.txt` prints `before-archive`.

- **Archive.** Run `$V cli archive-cli -- archive $T --json`. Exit 0, and the returned `Thread` has `status` `archived`.
- **Paused.** Repeat `$V cli archive-show -- show $T --json` every 5 s, for up to 2 minutes, until `.pylon.actualState` is `paused`. `.desired` is `paused`.
- **Checkpoint, no VM.** Run `docker ps -a --filter label=nexus.pylon=pylon-$T --format '{{.Names}}'`, which prints nothing. Run `docker images --filter label=nexus.pylon=pylon-$T --format '{{.Repository}}:{{.Tag}}'`, which prints one `nexus-checkpoint/pylon-$T:<checkpoint>`. Save both outputs to the evidence directory: `> "$($V evidence)/archive-docker.txt"`.
- **Refused message.** Run `$V cli archive-refuse -- send $T "bash: echo should-not-run" --json`. Exit 5. Stderr is a JSON line with `"kind": "conflict"` and `"status": 409`.
- **Unarchive.** Run `$V cli unarchive-cli -- unarchive $T --json`. Exit 0, and `status` is `active`. Poll `show` until `.pylon.actualState` is `running`.
- **Disk survived.** Run `$V pylon unarchive-disk $T -- cat marker.txt`, which prints `before-archive`. Then send `bash: cat marker.txt` with `$V cli unarchive-send` and read `conversation`. The new `pi.tool-result` contains `before-archive`.
- **Dashboard.** Repeat archive and unarchive from the page:
  - Run `$V browser archive-ui-open -- goto http://127.0.0.1:7470/threads/$T`, then `$V browser archive-ui-click -- click "#archive"`.
  - Within two polls, about 10 s, the header shows `Unarchive` and the thread's tag reads `archived`. Capture it with `snapshot --filename archive-ui.md` and `screenshot --filename archive-ui.png`.
  - Run `$V browser unarchive-ui-click -- click "#unarchive"`.
  - Confirm both through `show $T --json` after each click.
- **Proof.** The recorded `archive-cli`, the `archive-show` that reads `paused`, `archive-docker.txt`, `archive-refuse`, `unarchive-cli`, `unarchive-disk`, and `archive-ui.md` with `archive-ui.png`.

## Gotchas

- Docker's pause is `docker stop` plus `docker commit`, so running processes and memory are lost, as on a real pylon. Prove survival with a file, not a process.
- Unarchiving is the only path that wakes an archived thread. `nexus wake` and opening the thread page record activity but never unarchive it.
- Each archive adds a checkpoint image. `$V down` removes them by the run's label, but a run that archives many threads holds their layers until then.
- `actualState` passes through `pausing` and `spawning`. Assert only the settled `paused` and `running`.
