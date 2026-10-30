# The backend interface the probe drives

Verified in this task's pylon on 2026-10-30, on branch `simplify/w4-backend-interface` against `main` at `74c09ae`. No live control plane, node, image or other thread was touched.

## The harness

`capture.ts` starts a real probe (`startProbe`) over a real pylon-vm backend (`createPylonVmBackend`), as `src/probe/main.ts` wires them. No VM boots, because this pylon has no KVM. The state root holds four instances as pylon-vm leaves them on disk:

- `pylon-paused`, stopped, whose sidecar holds a checkpoint and the session its pause recorded.
- `pylon-recorded-none`, stopped, whose pause recorded no sessions.
- `pylon-never-paused`, stopped with no checkpoint.
- `pylon-dead`, whose controller died without completing a stop.

The artifact store holds one image and one published template. The script takes one snapshot, then fetches five artifacts as the peer probe: a checkpoint, an absent template, an absent image, the template at the wrong sha256, and the template at its own. It counts the artifact store's lists, the reads of `<artifacts>`, for each.

`run.sh` runs the script on a worktree of `main` and on this checkout, and writes `main.txt` and `branch.txt`.

## Results

The snapshot is byte for byte the same on both sides. It lists the image, the template and the two stopped pylons' checkpoints, and leaves out the dead pylon's. Each pylon reports the same phase, sessions, detail, cause and log tail. On the branch, the probe adds the checkpoints from the pylons, where on `main` the backend did.

Each fetch answers with the same status and message. On `main` each one lists the store once. On the branch none does.

| fetch | status | main lists | branch lists |
| --- | --- | --- | --- |
| a checkpoint | 404 | 0 | 0 |
| an absent template | 404 | 1 | 0 |
| an absent image | 404 | 1 | 0 |
| the template, wrong sha256 | 409 | 1 | 0 |
| the template | 200 | 1 | 0 |

## Not measured here

- A running pylon, and a pause or a wake. They need a VM, and this pylon has no KVM. The unit tests cover the pause and relaunch decisions.
- The Docker backend. This pylon has no Docker. `src/docker-backend.test.ts` drives it against a fake `docker` on the PATH.

## Rerun

```sh
docs/verification/backend-interface/run.sh
```
