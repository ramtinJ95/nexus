# Image build and rollout verification

Verified in this task's pylon on 2026-10-26, on branch `image-rollout-command`. No live control plane, node, image or other thread was touched, and no real image was built.

## The stack

`stack.ts` runs three nodes on this machine: `infra-testbench`, the image build node, plus `rj-firebat` and `rj-nuc`. Each is a real probe (`startProbe`) over a real pylon-vm backend with its own artifact store. The real control-plane loop follows all three. The real image rollout worker and the real API serve `127.0.0.1:7470`, as `src/control/main.ts` wires them. The worker loads the real recipe from this checkout's `images/pylon/` and records this checkout's HEAD as the release. `drive.sh` drives the stack with the real CLI and writes every capture here. `stack.log` is the stack's own log.

This pylon has no Docker and no KVM, so three things are stand-ins:

- `buildImage` receives the recipe from the `build-image` job and checks that the recipe is the job's image, as the real backend does. It does not run Docker, Gondolin and a smoke boot. It writes a 24 MiB Gondolin-shaped directory and hashes it with `artifactArchive`, as the real build does.
- `rj-nuc`'s store refuses every import with `no space left on device`.
- whois is faked. All three probes and the control plane share one tailnet ID, so each probe accepts the others as peers. The API's caller is the ID in `/tmp/nir/caller`, which `drive.sh` switches.

Copies between the probes are real. They go over the probes' artifact route as GNU tar, and the importing store checks them against the job's sha256 before it unpacks them.

## What it shows

- `01-list-before.txt`. `img-0000000000aa` is current and held by all three nodes.
- `02-build-as-control-node.txt`. The control node itself is refused with exit 3, because only `deployers` may build.
- `03-build.txt`. `image build --wait` sends `build-image` with the 13-file recipe (`stack.log`). It prints the step on stderr while it runs, and the image `img-c6e71ae15790` when it is recorded, with release `cb2e8856ce66`. Nothing became current.
- `04-build-again.txt`. The unchanged recipe answers at once, `recorded already`, and `stack.log` shows no second build.
- `05-rollout-nuc-fails.txt` and `06-current-after-failure.txt`. `rj-firebat` fetched the image, `rj-nuc` could not, and the rollout failed with exit 1, naming `rj-nuc` and the probe's reason. `img-0000000000aa` stayed current.
- `07-nodes-nuc-offline.txt` and `08-rollout.txt`. With `rj-nuc`'s probe stopped and the node offline, the rollout skipped it and made `img-c6e71ae15790` current, with `img-0000000000aa` as previous.
- `09-list-after-rollout.txt` and `10-list-json.txt`. These show which nodes hold each image, the release and build time, and the last operation.
- `11-stores.txt`. `rj-firebat`'s copy archives to the recorded sha256, the same as the build node's copy.
- `12-rollback.txt` and `13-current-after-rollback.txt`. A rollback made `img-0000000000aa` current again. `14-rollback-forward.txt` shows that a second rollback goes forward again.

`11-stores.txt` also shows that the imported directory is mode 0755 while a published one is 0700. The importer extracts the archive's normalized modes, which `src/artifacts.ts` already does on `main`. The store root on a node is 0700, so nothing outside the probe user reads it.

## What was not verified

- A real image build. It needs Docker and KVM on `infra-testbench`, and the probe user `nexus` has no Docker access there today (deploy/README.md, Docker access for the image build node's probe).
- A copy at the home lab's speed. Each copy here was 24 MiB between processes on one machine. Between the nodes, copies run at about 22 Mbit/s.
- The live fleet, including a control plane restart in the middle of a rollout. `src/control/image-rollout.test.ts` covers the restart with fake probes.
- The Mac CLI through ts-home's SOCKS proxy. The CLI ran in direct mode.

## Rerun

```sh
node docs/verification/image-rollout/stack.ts > /tmp/nir.log &
sleep 7
sh docs/verification/image-rollout/drive.sh $!
kill %1
```
