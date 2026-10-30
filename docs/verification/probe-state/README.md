# The probe checks one pylon without listing them all, and coalesces snapshots

Verified in this task's pylon on 2026-10-30, on branch `simplify/w3-probe-state` against `main` at `90f4299`. No live control plane, node, image or other thread was touched.

## The harness

`count.ts` starts a real probe (`startProbe`) over a real pylon-vm backend (`createPylonVmBackend`), as `src/probe/main.ts` wires them. Its state root holds ten stopped pylons as pylon-vm leaves them on disk. No VM boots, because this pylon has no KVM. The probe polls listening ports every 50 ms instead of every 10 s.

The script counts reads of `<stateRoot>/instances`. Each is one sandbox `list` RPC, which is one backend `list()`. It then:

- sends an `exec` command to a stopped pylon, which the probe refuses as `not-running`;
- asks for a stream to that pylon, which the probe refuses with 409;
- keeps one observer connected for one second of polls;
- submits five pauses at once and counts the snapshots the observer gets until a second after the last one finished. A pause of a stopped pylon changes nothing, so each finishes at once.

## Results

`main.txt` is `main`, and `branch.txt` is this branch.

| | main | branch |
| --- | --- | --- |
| refused command | 1 list | 0 lists |
| refused stream | 1 list | 0 lists |
| 1 s of 50 ms polls, one observer | 20 lists | 0 lists |
| five pauses at once | 5 snapshots, 26 lists | 2 snapshots, 2 lists |

On main each poll lists every pylon, so 20 polls make 20 lists, and the pauses' window adds about 21 poll lists to the 5 snapshot reads. On the branch the command and the stream ask the backend for the one pylon's `state`, and a poll reads only the pylons the last snapshot saw running. None runs here, so a poll reads nothing. The first pause starts a snapshot read, and the four that finish during it share one more. Three more runs on the branch gave 2 snapshots each time.

## What the numbers do not measure

- Time. The counts are of reads, not of how long they take.
- A running pylon. No VM can boot here, so no poll read a running pylon's ports, and no command or stream reached a guest. `src/probe/server.test.ts` covers both with a fake backend.
- The Docker backend. `src/docker-backend.test.ts` checks its `state` against a fake `docker`.

## Rerun

```sh
node docs/verification/probe-state/count.ts > docs/verification/probe-state/branch.txt
```

For main, copy `count.ts` into a worktree of main and run it there.
