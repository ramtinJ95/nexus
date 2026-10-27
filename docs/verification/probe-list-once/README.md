# One backend list per probe snapshot

Verified in this task's pylon on 2026-10-27, on branch `perf/probe-list-once` against `main` at `82a703f`. No live control plane, node, image or other thread was touched.

## The harness

`count.ts` starts a real probe (`startProbe`) over a real pylon-vm backend (`createPylonVmBackend`), as `src/probe/main.ts` wires them. Its state root holds ten stopped pylons as pylon-vm leaves them on disk. Eight have a checkpoint in their `nexus-checkpoint.json` and two have none. No VM boots, because this pylon has no KVM.

The script wraps `readdir` and `readFile` from `node:fs/promises` and counts three things under `<stateRoot>/instances`:

- `lists`. Reads of the instances directory. Each is one sandbox `list` RPC, which is one backend `list()`.
- `sidecars`. Reads of a pylon's `nexus-checkpoint.json`. The backend reads one per pylon per list.
- `records`. Reads of a pylon's `record.json`. A stopped instance's record is read twice per list, once by the sandbox list and once by the backend.

It takes five snapshots, each the first event of a fresh `observe`, as a control plane's reconnect gets. Then it asks `GET /v1/artifacts/tpl-absent000000` as the peer probe. Last, it prints the final snapshot's `artifacts` and `pylons`.

## Results

`main.txt` is `main`, and `branch.txt` is this branch. Per operation:

| | main lists | branch lists | main sidecars | branch sidecars | main records | branch records |
| --- | --- | --- | --- | --- | --- | --- |
| one snapshot | 2 | 1 | 20 | 10 | 40 | 20 |
| `GET /v1/artifacts/{id}` | 1 | 0 | 10 | 0 | 20 | 0 |

All five snapshots on each side count the same. The last line of the two files, the snapshot's `artifacts` and `pylons`, is byte for byte the same.

The artifacts route no longer lists pylons. It refuses a checkpoint ID before it looks, so it never needed their checkpoints.

## What the numbers do not measure

- Time. The counts are of reads, not of how long they take.
- A running pylon. A list asks each running instance's controller to `inspect` over its control socket. Here every instance is stopped, so that falls back to reading its files. By reading the code, a running pylon's `inspect` halves too, because it happens once per list. No controller ran to count it.
- The Docker backend. Its `artifacts.list` reads checkpoint images and never called `list()`, so its work does not change.

## Tests

`tests-main.txt` and `tests-branch.txt` are the summary lines of `npm test` on each side: 1180 and 1182 passing, none failing. The two new tests are the ones named at the end of `tests-branch.txt`.

- `src/probe/server.test.ts`. A pylon that stops while a snapshot is read shows as running with no checkpoint in that snapshot, and stopped with its checkpoint in the next. With `readSnapshot` changed back to two reads, this test fails.
- `src/pylon-vm-backend.test.ts`. The artifacts listed with a list of pylons hold the checkpoints of its stopped pylons only. They leave out a running pylon's and one that stopped after the list.

`npm run test:slice` was not run. It boots VMs on a node. `src/template-slice.test.ts` changed only in its call to `artifacts.list`, and the typecheck covers it.

## Rerun

```sh
node docs/verification/probe-list-once/count.ts > docs/verification/probe-list-once/branch.txt
```
