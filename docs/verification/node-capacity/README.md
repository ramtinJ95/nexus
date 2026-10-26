# Node capacity and `--node auto` verification

Verified in this task's pylon on 2026-10-26, on branch `node-capacity`. No live control plane, node, image or other thread was touched.

## The stack

`stack.ts` runs three nodes on this machine. Each is a real probe (`startProbe`) over a real pylon-vm backend (`createPylonVmBackend`) with its own state root. The real control-plane loop follows all three over the probe protocol, and the real API serves `127.0.0.1:7470`, as `src/control/main.ts` wires them. `drive.sh` drives it with the real CLI (`node src/cli/nexus.ts` with `NEXUS_URL` and `NEXUS_SOCKS=none`) and writes every capture here.

This pylon has no KVM, so no VM boots. That is the one stand-in. Each node's instances are the files pylon-vm leaves on disk: `record.json`, `status.json` and the image label. A running instance also answers `inspect` on its control socket with the status a controller reports, including the resources its boot gave it.

- `busy-node` runs five pylons with 4 CPUs, 8 GiB and a 60 GiB disk each, and holds two paused pylons with 60 GiB disks. Its secret file has `GH_TOKEN`.
- `quiet-node` holds one paused pylon with a 30 GiB disk. Its secret file has `GH_TOKEN`.
- `bare-node` holds nothing and has an empty secret file.

The probes all read this machine, so each node reports 4 CPUs, 7.8 GiB of memory and 17.8 GiB of free disk. Project `acme` asks for 2 CPUs, 3 GiB and 10 GiB, grants `GH_TOKEN`, and defaults to `busy-node`. Project `huge` asks for 64 GiB.

## What it shows

- `nodes-before.txt` is the same stack on `main` (`0663299`), CLI 0.18.0. Every node reports `0/7.7654571533203125 GiB committed`, `busy-node` included, as the roadmap reported.
- `nodes.txt` and `nodes.json` are this branch, CLI 0.20.0 (`version.txt`). `busy-node` reports 20 CPUs, 40 GiB of memory and 420 GiB of disk committed. That is the five running pylons' CPUs and memory and all seven disks. `quiet-node` reports its paused pylon's 30 GiB disk and no memory.
- `start-default.txt` and the first block of `show.txt`. A start without `--node` goes to `busy-node`, the project's default, although it is the fullest node.
- `start-auto.txt` and the second block of `show.txt`. `--node auto` chose `quiet-node`. `show` gives every node's reason. `bare-node` lacks `GH_TOKEN`. `busy-node` has 43 of 7.8 GiB committed, which is its 40 plus the default thread's 3, still unreported. `quiet-node` had 4.8 GiB, 2 CPUs and 7.8 GiB of disk left.
- `start-refused.txt`. A 64 GiB pylon fits nowhere. The start exits 5, names each node's reason, and starts no thread. `threads.json` lists only the two threads above.

After the start, each pylon shows `failed` with `the controller failed to boot the VM`. The loop sent the spawn to the chosen node, and pylon-vm could not boot without KVM. Placement happens before that, and does not depend on it.

## What was not verified

- A real pylon-vm controller's status for a running VM. The probe test and the backend test read the `resources` that `runtime.ts` puts in its status, and the client now writes them into `status.json` at launch. No VM ran here.
- The live fleet's reading. `nexus nodes` against the live control plane needs the tailnet, which this pylon cannot reach.
- The dashboard's start dialog in a browser. `dashboard.test.ts` checks that it offers `auto`.

## Rerun

```sh
node docs/verification/node-capacity/stack.ts &
sleep 5
sh docs/verification/node-capacity/drive.sh
```

`stack.ts` starts from an empty `/tmp/nexus-capacity` each time, so the thread IDs change.
