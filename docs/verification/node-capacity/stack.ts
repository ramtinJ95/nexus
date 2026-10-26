// Two nodes on this machine, each a real probe over a real pylon-vm backend, followed by the real control-plane loop
// and API on 127.0.0.1:7470, which the real `nexus` CLI drives. This pylon has no KVM, so no VM boots: each node's
// instances are the files pylon-vm leaves on disk, and a running one answers on its control socket as a controller
// does, with the resources its boot gave it. Everything above the controller socket is the code that ships.
//
//   node docs/verification/node-capacity/stack.ts
//   NEXUS_URL=http://127.0.0.1:7470 NEXUS_SOCKS=none node src/cli/nexus.ts nodes
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { startLoop } from "../../../src/control/loop.ts";
import { openRegistry } from "../../../src/control/registry.ts";
import { startProbe } from "../../../src/probe/server.ts";
import { parseSecretsEnv } from "../../../src/probe/config.ts";
import { connectProbe, type NodeName, type TailnetNodeId } from "../../../src/protocol.ts";
import { createPylonVmBackend } from "../../../src/pylon-vm-backend.ts";
import { ingest } from "../../../src/reconcile.ts";
import type { ImageId } from "../../../src/images.ts";

// Under /tmp, not the scratchpad: a controller's Unix socket path must stay short.
const root = "/tmp/nexus-capacity";
const image = "img-0000000000cc" as ImageId;
const controlPlane = "nCONTROL" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
await rm(root, { recursive: true, force: true });

const artifacts = join(root, "artifacts");
await mkdir(join(artifacts, image), { recursive: true });
await writeFile(join(artifacts, image, "manifest.json"), "{}");
await writeFile(join(artifacts, image, "image.json"), "{}");

/** An instance as pylon-vm leaves it. A running one gets a controller socket that answers inspect with its resources. */
async function instance(instances: string, name: string, state: "running" | "stopped", diskGiB: number, resources = { cpus: 4, memoryGiB: 8 }) {
  const dir = join(instances, name);
  await mkdir(dir, { mode: 0o700 });
  const config = { version: 1, diskGiB, image: join(artifacts, image), workspace: "/home/user/workspace", setup: [], resume: [], services: {} };
  await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name, config, createdAt: "2026-10-26T00:00:00Z", labels: { "nexus.image": image } }));
  await writeFile(join(dir, "status.json"), JSON.stringify({ name, state, resources, diskGiB }));
  if (state === "stopped") return;
  const status = { name, state, resources, diskGiB, bootedAt: "2026-10-26T00:00:00Z", setupRecorded: true };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.end(JSON.stringify(JSON.parse(body).action === "inspect"
      ? { ok: true, result: { name, labels: { "nexus.image": image }, status } }
      : { ok: false, error: "no VM runs in this verification" }));
  });
  await new Promise<void>((resolve) => server.listen(join(dir, "control.sock"), resolve));
}

async function node(name: string, nodeId: TailnetNodeId, secrets: string, fill: (instances: string) => Promise<void>) {
  const stateRoot = join(root, name);
  const instances = join(stateRoot, "instances");
  await mkdir(instances, { recursive: true, mode: 0o700 });
  await fill(instances);
  const secretSource = parseSecretsEnv(secrets);
  const probe = await startProbe({
    node: name as NodeName, host: "127.0.0.1", port: 0, auth: { controlPlane, peers: [] }, whois: async () => controlPlane,
    backend: createPylonVmBackend({ stateRoot, artifacts, secrets: secretSource }), secrets: secretSource, gitSsh: false,
  });
  return { name: name as NodeName, nodeId, client: connectProbe(name as NodeName, "127.0.0.1", nodeId, { port: probe.port, whois: async () => nodeId }) };
}

// The roadmap's reading: five 8 GiB pylons running, and two paused ones whose disks stay.
const busy = await node("busy-node", "nBUSY" as TailnetNodeId, "GH_TOKEN=placeholder\n", async (instances) => {
  for (const n of [1, 2, 3, 4, 5]) await instance(instances, `pylon-th-running${n}`, "running", 60);
  for (const n of [1, 2]) await instance(instances, `pylon-th-paused${n}`, "stopped", 60);
});
const quiet = await node("quiet-node", "nQUIET" as TailnetNodeId, "GH_TOKEN=placeholder\n", async (instances) => {
  await instance(instances, "pylon-th-paused3", "stopped", 30);
});
const bare = await node("bare-node", "nBARE" as TailnetNodeId, "", async () => {});

const registry = openRegistry(join(root, "registry.db"));
for (const n of [busy, quiet, bare]) registry.upsertNode({ name: n.name, tailnetHost: "127.0.0.1", tailnetNodeId: n.nodeId });
registry.saveImage({ id: image, gondolinBuildId: "b", builtOn: busy.name, builtAt: "2026-10-26T00:00:00Z", sha256: "c".repeat(64), pins: {} } as never);
registry.setCurrentImage(image);
const dotfiles = { repo: "https://github.com/ramtinJ95/dotfiles.git", ref: "main" };
const project = { repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: busy.name, allowedHosts: [], logins: [], preSetup: null };
registry.createProject({ ...project, id: "acme", resources: { cpus: 2, memoryGiB: 3, diskGiB: 10 }, secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com"] }] } as never);
registry.createProject({ ...project, id: "huge", resources: { cpus: 2, memoryGiB: 64, diskGiB: 10 }, secrets: [] } as never);

const probes = [busy, quiet, bare].map((n) => n.client);
const loop = startLoop({ registry, probes, ingest, previewPorts: { first: 10200, last: 10299 }, log: () => {} });
const { harness } = fakeHarness();
await startApi({
  registry, whois: async () => laptop, host: "127.0.0.1", port: 7470, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles, harness: harness as never, wake: (n) => { void loop.wake(n); }, probes: new Map(probes.map((p) => [p.node, p])), previewPorts: { first: 10200, last: 10299 },
});
console.log("nexus API on http://127.0.0.1:7470 following busy-node, quiet-node and bare-node");
