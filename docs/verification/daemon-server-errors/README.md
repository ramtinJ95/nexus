# The controller's server errors after it listens

Verified in this task's pylon on 2026-10-27, on branch `fix/issue-143-daemon-server-errors`, for issue #143. No image was built, and no live control plane, node or other thread was touched.

## The bug

A pylon's controller is `src/pylon-vm/daemon.ts`, one detached Node process per instance on the node. It holds the Gondolin VM in its own process and answers the probe on `control.sock`. It waited for that socket with `server.once("error", reject)` and never removed the listener. The first error the server emitted after it listened went to a settled promise and left no trace. The second had no listener, so Node threw it and the controller died with exit code 1.

## Why the controller now logs and keeps serving

- Nothing restarts a controller that exits. `launch` in `src/pylon-vm/client.ts` starts one only on a later `create` or `start`. Until then `client.ts` reports the instance as `interrupted`, and `vmState` in `src/pylon-vm-backend.ts` turns that into a broken pylon with cause `controller`.
- The VM runs inside the controller, so an exit also ends the guest and every session in it. The next `start` restores only the last completed disk checkpoint, as the `interrupted` status's recovery text says.
- An accept error does not close the server. In `main.txt` and `branch.txt` the controller answers `inspect` after its first error, and on the branch after its second too.

So an exit would turn a failed connection into a broken pylon, and gain nothing a restart would fix. A startup `listen` error still rejects, now through `once(server, "listening")`, and the controller exits 1 as before.

## How the error is raised

`fake-runtime.ts` stands in for `runtime.ts`, so the real `daemon.ts` runs without a VM; this pylon has no `/dev/kvm`. On SIGUSR2 it calls the listening socket's `onconnection` with `-ENOBUFS`. That is the call libuv makes when `accept` fails, so Node's own `net` code builds the error and emits it on the server.

Running out of file descriptors does not reach the event. `emfile.sh` drops a listening server's open-file limit to 3 and connects. libuv's EMFILE handling drops the connection, and the server emits no error (`emfile.txt`). The errors that do reach it are rarer `accept` failures, such as `ENOBUFS` or `ENOMEM`.

## The checks

- `run.sh <ref>` checks out the ref in a temporary worktree, copies this branch's `fake-runtime.ts` into it, and runs that ref's `daemon.ts`. It fails two accepts, inspects the instance before and after each, sends SIGTERM if the controller still runs, and prints the controller's log, its exit code and the files it left. `main.txt` is `run.sh origin/main` and `branch.txt` is `run.sh HEAD`.
- `regression-test.txt` is `src/pylon-vm/daemon.test.ts` at the commit that adds it, with main's `daemon.ts`, and then at the fix.

| | main (137242d) | branch |
| --- | --- | --- |
| Log after the first accept error | nothing | the `accept ENOBUFS` error |
| After the second | crashed with `Unhandled 'error' event` | logged, still answers `inspect` |
| Exit code | 1, without a SIGTERM | 0, after SIGTERM |
| Left in the instance directory | `control.sock`, `controller.pid` | nothing |
| `daemon.test.ts` | fails, exit 1 | passes, exit 0 |

## Not verified

No real `accept` failure was produced. The error is replayed through Node's handler, as described above. The controller did not run a real VM, and no pylon on a node was checked.
