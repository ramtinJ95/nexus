// Three nodes on this machine, each a real probe over a real pylon-vm backend with its own artifact store, followed by
// the real control-plane loop, image rollout worker and API on 127.0.0.1:7470, which the real `nexus` CLI drives. The
// worker builds the real recipe in images/pylon/ of this checkout and records this checkout's HEAD as the release.
//
// Stand-ins, because this pylon has no Docker and no KVM:
// - buildImage writes a small Gondolin-shaped asset directory instead of running Docker, Gondolin and a smoke boot. It
//   gets the recipe from the build-image job, checks it is the job's image as the real backend does, and hashes the
//   directory with artifactArchive as the real build does.
// - rj-nuc's store refuses every import, as a full disk would.
// - whois: every probe and the control plane are one tailnet node, so each probe accepts the others as peers. The API's
//   caller is whatever ID the file `caller` under the stack's root holds, so drive.sh can call as a non-deployer.
// Everything else is the code that ships: the probes' job, observe, manifest and artifact routes, the tar archive, the
// checksum check on import, the registry, the loop and the worker.
//
//   node docs/verification/image-rollout/stack.ts
//   kill -USR2 <pid> stops rj-nuc's probe, so the loop marks it offline.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { artifactArchive } from "../../../src/artifacts.ts";
import { JobFailure, type VmBackend } from "../../../src/backend.ts";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { startImageRollout } from "../../../src/control/image-rollout.ts";
import { startLoop } from "../../../src/control/loop.ts";
import { openRegistry } from "../../../src/control/registry.ts";
import { loadImageRecipe } from "../../../src/image-build.ts";
import { imageIdOf, type ImageId, type ImageManifest, type ImageRecipe } from "../../../src/images.ts";
import { parseSecretsEnv } from "../../../src/probe/config.ts";
import { startProbe, type Probe } from "../../../src/probe/server.ts";
import { connectProbe, type NodeName, type TailnetNodeId } from "../../../src/protocol.ts";
import { createPylonVmBackend } from "../../../src/pylon-vm-backend.ts";
import { ingest } from "../../../src/reconcile.ts";

// Under /tmp, not the scratchpad: a controller's Unix socket path must stay short.
const root = "/tmp/nir";
const tailnet = "nFLEET" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const control = "nCONTROL" as TailnetNodeId;
const old = "img-0000000000aa" as ImageId;
const release = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await writeFile(join(root, "caller"), laptop);

/** A Gondolin-shaped image directory: the same files give the same bytes, so the same sha256 on every node. */
async function writeImage(artifacts: string, id: ImageId, node: NodeName, rootfsMiB: number): Promise<ImageManifest> {
  const partial = join(artifacts, `${id}.partial`);
  await mkdir(partial, { recursive: true, mode: 0o700 });
  await writeFile(join(partial, "manifest.json"), JSON.stringify({ buildId: `stand-in-${id}` }));
  const rootfs = Buffer.alloc(rootfsMiB * 2 ** 20);
  for (let i = 0; i < rootfs.length; i += 4096) rootfs.write(`${id} block ${i}`, i);
  await writeFile(join(partial, "rootfs.ext4"), rootfs);
  const sha = createHash("sha256");
  for await (const chunk of artifactArchive(partial, "image.json")) sha.update(chunk as Buffer);
  const manifest: ImageManifest = {
    id, gondolinBuildId: `stand-in-${id}`, builtOn: node, builtAt: new Date().toISOString(), sha256: sha.digest("hex"),
    pins: JSON.parse(await readFile(new URL("../../../images/pylon/pins.json", import.meta.url), "utf8")) as ImageRecipe["pins"],
  };
  await writeFile(join(partial, "image.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(partial, join(artifacts, id));
  return manifest;
}

const ports = new Map<NodeName, number>();
async function node(name: string, options: { failImports?: boolean } = {}) {
  const nodeName = name as NodeName;
  const stateRoot = join(root, name);
  const artifacts = join(stateRoot, "artifacts");
  await mkdir(join(stateRoot, "instances"), { recursive: true, mode: 0o700 });
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const secrets = parseSecretsEnv("");
  const real = createPylonVmBackend({ stateRoot, artifacts, secrets });
  const backend: VmBackend = {
    ...real,
    async buildImage(image, recipe, on) {
      if (imageIdOf(recipe) !== image) throw new JobFailure("invalid", `the recipe is image ${imageIdOf(recipe)}, not ${image}`);
      console.log(`${name}: build-image ${image} from a recipe of ${recipe.files.length} files, Dockerfile included: ${recipe.files.some((f) => f.path === "Dockerfile")}`);
      await sleep(4_000);
      await writeImage(artifacts, image, on, 24);
    },
    artifacts: options.failImports
      ? { ...real.artifacts, import: async (manifest, stream) => { stream.destroy(); throw new JobFailure("backend", `no space left on device writing ${manifest.id}.partial.archive`); } }
      : real.artifacts,
  };
  const probe: Probe = await startProbe({
    node: nodeName, host: "127.0.0.1", port: 0, auth: { controlPlane: tailnet, peers: [tailnet] }, whois: async () => tailnet,
    backend, secrets, gitSsh: false, log: () => {},
    peerAddress: (peer) => ({ host: "127.0.0.1", port: ports.get(peer)! }),
  });
  ports.set(nodeName, probe.port);
  return { name: nodeName, artifacts, probe, client: connectProbe(nodeName, "127.0.0.1", tailnet, { port: probe.port, whois: async () => tailnet }) };
}

const testbench = await node("infra-testbench");
const firebat = await node("rj-firebat");
const nuc = await node("rj-nuc", { failImports: true });
const nodes = [testbench, firebat, nuc];

// The image current before this stack: the same bytes on every node, recorded by hand, so with no release.
const registry = openRegistry(join(root, "registry.db"));
for (const n of nodes) registry.upsertNode({ name: n.name, tailnetHost: "127.0.0.1", tailnetNodeId: `n${n.name.replaceAll("-", "").toUpperCase()}` as TailnetNodeId });
let oldManifest: ImageManifest | undefined;
for (const n of nodes) oldManifest = await writeImage(n.artifacts, old, testbench.name, 8);
registry.saveImage({ ...oldManifest!, builtAt: "2026-10-20T00:00:00.000Z" }, null);
registry.setCurrentImage(old);

const probes = nodes.map((n) => n.client);
const loop = startLoop({ registry, probes, ingest, previewPorts: { first: 10200, last: 10299 }, offlineAfterMs: 3_000, reconnectMs: 500, log: () => {} });
const images = startImageRollout({
  registry, probes: new Map(probes.map((p) => [p.node, p])), buildNode: testbench.name, recipe: () => loadImageRecipe(), release,
  log: (line) => console.log(`worker: ${line}`),
});
const { harness } = fakeHarness();
await startApi({
  registry, whois: async () => (await readFile(join(root, "caller"), "utf8")).trim() as TailnetNodeId, host: "127.0.0.1", port: 7470,
  allowed: new Set([laptop, control]), hostnames: new Set(["127.0.0.1"]),
  deployment: { self: control, deployers: new Set([laptop]), keys: {} },
  dotfiles: { repo: "https://github.com/ramtinJ95/dotfiles.git", ref: "main" }, harness: harness as never,
  wake: (n) => { void loop.wake(n); }, probes: new Map(probes.map((p) => [p.node, p])), previewPorts: { first: 10200, last: 10299 }, images,
});
process.on("SIGUSR2", () => { void nuc.probe.close().then(() => console.log("rj-nuc's probe stopped")); });
console.log(`nexus API on http://127.0.0.1:7470 following ${nodes.map((n) => n.name).join(", ")}; release ${release}`);
