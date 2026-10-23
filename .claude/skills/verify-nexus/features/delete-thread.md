# Delete a thread

Deleting a thread removes its pylon and every checkpoint of its disk. The thread drops out of the default lists but stays readable as `deleted`, and a `watch` on it ends cleanly.

## Sub-features

- `delete-cli` deletes from the terminal and returns the thread with status `deleted`.
- `delete-watch` ends a running `watch` with exit 0 after its `deleted` state.
- `delete-cleanup` leaves no container and no checkpoint image for the pylon.
- `delete-lists` hides the thread from `threads` and shows it with `threads --all`.
- `delete-ui` deletes from the thread page after a confirmation.
- `delete-again` refuses actions on a deleted thread with a conflict.

## How to get to it (user POV)

- Run `nexus delete <thread>` in a terminal.
- Choose `Delete` in the thread page's header, `/threads/<id>`, and accept the `Delete "<title>"? Its pylon and disk are removed.` confirmation.

## Driving it with verify-nexus

Preconditions:

- The baseline from the index holds.
- Thread `T` was started with `$V cli delete-start -- start --project spoon --title "delete: cli" --json`, its pylon is `running`, and it has been archived and unarchived once, so it holds a checkpoint image (see [Archive and unarchive](./archive-thread.md)).

- **Watch first.** Start a watch in the background: `$V cli delete-watch -- watch $T --json --interval 1000 & W=$!`. Within a few seconds, the recorded `delete-watch.stdout` starts with a `reset` line, then a `state` line.
- **Delete.** Run `$V cli delete-cli -- delete $T --json`. Exit 0, and `status` is `deleted`.
- **Watch ends.** Run `wait $W`. It returns 0, and the last line of `delete-watch.stdout` is a `state` event with `"status":"deleted"`.
- **Cleanup on the node.** Poll `docker ps -a --filter label=nexus.pylon=pylon-$T -q` and `docker images --filter label=nexus.pylon=pylon-$T -q` every 5 s, for up to 2 minutes, until both print nothing. Save the final outputs to `"$($V evidence)/delete-docker.txt"`.
- **Lists.** `$V cli delete-list -- threads --json` has no row with `id` `$T`. `$V cli delete-list-all -- threads --all --json` has it, with `status` `deleted`.
- **Again.** `$V cli delete-again -- delete $T --json` exits 5 with `"kind": "conflict"`. So does `$V cli delete-send -- send $T "bash: true" --json`.
- **Dashboard delete.** Start a second thread, `delete: ui`, as `T2`, and wait until it runs. Then:
  - Run `$V browser delete-ui-open -- goto http://127.0.0.1:7470/threads/$T2`.
  - Run `$V browser delete-ui-click -- click "#delete"`.
  - Run `$V browser delete-ui-accept -- dialog-accept`.
  - Capture with `snapshot --filename delete-ui.md` and `screenshot --filename delete-ui.png`. Then repeat the CLI and Docker checks for `T2`.
- **Proof.** The recorded `delete-watch` stream, `delete-cli`, `delete-docker.txt`, `delete-list` with `delete-list-all`, `delete-again`, and `delete-ui.md` with `delete-ui.png` plus T2's CLI and Docker checks.

## Gotchas

- `watch` also ends when the process that started it exits. If the shell running `$V cli … &` is gone, the watch stops on its own at the next poll, and its `.exit` file may be missing.
- The `Delete` click opens a native `confirm()`. Without `dialog-accept`, the click does nothing, and the thread stays active.
- The registry keeps deleted threads. `show $T --json` still answers, and `conversation $T` exits 5. Don't treat either as a failed delete.
- The pylon's removal is asynchronous. The API answers `deleted` before the planner has removed the container, so poll Docker rather than checking once.
