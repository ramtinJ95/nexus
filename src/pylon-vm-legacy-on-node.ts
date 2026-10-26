/**
 * Node validation that a pylon created by an earlier release, whose intent.json still says `fresh` and
 * `setupError`, wakes on this tree without rerunning its setup. Run by hand on a home-lab node, in two steps:
 *   node <this tree>/src/pylon-vm-legacy-on-node.ts create <earlier checkout> <state root> <image directory>
 *   node <this tree>/src/pylon-vm-legacy-on-node.ts wake <state root> <image directory>
 * `create` loads the earlier checkout's backend, which takes `images`: it boots a fresh pylon, which clones and
 * checks out, commits on its branch and pauses. `wake` loads this tree's backend, which takes `artifacts`, wakes
 * the pylon from its checkpoint and checks that the commit survived and that the disk now holds the setup
 * marker. A setup that ran again would clone into the existing checkout, fail, and fail the wake as
 * setup-failed. The state root must be at most 39 bytes, such as /tmp/nexus-legacy.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Guest, VmBackend } from "./backend.ts";
import type { CheckpointId, ImageId } from "./images.ts";
import type { BootInputs } from "./project.ts";
import type { PylonId } from "./protocol.ts";

const [step, ...args] = process.argv.slice(2);
const pylonId = "pylon-legacy-wake" as PylonId;
const checkpoint = "ckpt-legacy-wake-1" as CheckpointId;
const secrets = { value: () => undefined, names: () => [] };
const home = "/home/user";
const repoDir = `${home}/workspace/repo`;
const signal = () => AbortSignal.timeout(20 * 60_000);
const sh = (guest: Guest, script: string) => guest.exec(["sh", "-c", script], { cwd: repoDir, timeoutMs: 60_000 });

function boot(image: ImageId, source: BootInputs["source"]): BootInputs {
  return {
    pylonId, image, source,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 8 },
    network: { allowedHosts: ["github.com"], secrets: [] },
    repo: { kind: "clone", url: "https://github.com/octocat/Hello-World.git", checkout: { branch: "nexus-legacy", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" } },
    dotfiles: { repo: "https://github.com/octocat/Spoon-Knife.git", ref: "main" },
  };
}
const live = { previews: [], overlay: [] };

if (step === "create") {
  if (args.length !== 3) throw new Error("create <earlier checkout> <state root> <image directory>");
  const [earlier, stateRoot, imageDir] = args.map((a) => resolve(a)) as [string, string, string];
  const image = basename(imageDir) as ImageId;
  const { createPylonVmBackend } = await import(join(earlier, "src/pylon-vm-backend.ts")) as { createPylonVmBackend(options: unknown): VmBackend };
  const backend = createPylonVmBackend({ stateRoot, images: { [image]: imageDir }, secrets });
  await backend.ensureRunning(boot(image, { kind: "fresh", preSetup: null }), live, signal());
  const commit = "git -c user.name=legacy -c user.email=legacy@example.com commit --allow-empty --quiet -m 'work before the upgrade'";
  const made = await sh(backend.guest(pylonId), `${commit} && git rev-parse HEAD | tee ${home}/work-head`);
  assert.equal(made.exitCode, 0, made.output);
  await backend.ensurePaused(pylonId, checkpoint, signal());
  console.log(`work commit ${made.output.trim()}`);
  console.log(`intent ${await readFile(join(stateRoot, "instances", pylonId, "intent.json"), "utf8")}`);
} else if (step === "wake") {
  if (args.length !== 2) throw new Error("wake <state root> <image directory>");
  const [stateRoot, imageDir] = args.map((a) => resolve(a)) as [string, string];
  const image = basename(imageDir) as ImageId;
  const { createPylonVmBackend } = await import("./pylon-vm-backend.ts");
  const backend = createPylonVmBackend({ stateRoot, artifacts: dirname(imageDir), secrets });
  console.log(`intent before the wake ${await readFile(join(stateRoot, "instances", pylonId, "intent.json"), "utf8")}`);
  await backend.ensureRunning(boot(image, { kind: "resume", checkpoint }), live, signal());
  const guest = backend.guest(pylonId);
  const head = await sh(guest, `cat ${home}/work-head && git rev-parse HEAD && git symbolic-ref --short HEAD`);
  const [work, now, branch] = head.output.trim().split("\n");
  assert.ok(head.exitCode === 0 && work === now && branch === "nexus-legacy", `the commit made before the upgrade is gone: ${head.output}`);
  const marker = await sh(guest, "cat /var/lib/pi-sandbox/setup.json");
  assert.equal(marker.exitCode, 0, marker.output);
  assert.equal(JSON.parse(marker.output).instance, pylonId);
  console.log(`HEAD ${now} on ${branch}, the commit made before the upgrade`);
  console.log(`marker ${marker.output.trim()}`);
  await backend.ensurePaused(pylonId, "ckpt-legacy-wake-2" as CheckpointId, signal());
  await backend.ensureDeleted(pylonId, signal());
  console.log("legacy wake ok");
} else {
  throw new Error("name a step: create or wake");
}
