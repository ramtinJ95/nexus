// One node on this machine: a real probe over a real pylon-vm backend, followed by the real control-plane loop and
// API on 127.0.0.1:7470, with the real project mirror, which the real `nexus` CLI drives. This pylon has no KVM, so
// no VM boots, and a template build cannot prepare one. The backend's buildTemplate is replaced by what a successful
// prepare and publish leave: the template published through the real artifact store, with its manifest and a
// placeholder disk.qcow2. Each build's inputs go to builds.json beside this file, and each spawn's boot source and
// checkout, as the probe handed them to the backend, to spawns.json.
//
//   node docs/verification/templates-at-start/stack.ts
//   NEXUS_URL=http://127.0.0.1:7470 NEXUS_SOCKS=none node src/cli/nexus.ts threads
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDirectory, tarCodec } from "../../../src/artifacts.ts";
import type { VmBackend } from "../../../src/backend.ts";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { startLoop } from "../../../src/control/loop.ts";
import { projectMirror } from "../../../src/control/mirror.ts";
import { openRegistry } from "../../../src/control/registry.ts";
import type { ImageId, TemplateBuildInputs, TemplateId } from "../../../src/images.ts";
import { parseSecretsEnv } from "../../../src/probe/config.ts";
import { startProbe } from "../../../src/probe/server.ts";
import type { BootInputs } from "../../../src/project.ts";
import { connectProbe, type NodeName, type TailnetNodeId } from "../../../src/protocol.ts";
import { createPylonVmBackend } from "../../../src/pylon-vm-backend.ts";
import { ingest } from "../../../src/reconcile.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Under /tmp, not the scratchpad: a controller's Unix socket path must stay short.
const root = "/tmp/nexus-templates";
const image = "img-0000000000cc" as ImageId;
const node = "local-node" as NodeName;
const nodeId = "nLOCAL" as TailnetNodeId;
const controlPlane = "nCONTROL" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
await rm(root, { recursive: true, force: true });

const artifacts = join(root, "artifacts");
await mkdir(join(artifacts, image), { recursive: true });
await writeFile(join(artifacts, image, "manifest.json"), "{}");
await writeFile(join(artifacts, image, "image.json"), "{}");

const builds: { template: TemplateId; inputs: TemplateBuildInputs }[] = [];
const spawns: Record<string, Pick<BootInputs, "source" | "repo">> = {};
await writeFile(join(here, "builds.json"), "[]\n");
await writeFile(join(here, "spawns.json"), "{}\n");

const stateRoot = join(root, node);
await mkdir(join(stateRoot, "instances"), { recursive: true, mode: 0o700 });
const secrets = parseSecretsEnv("");
const real = createPylonVmBackend({ stateRoot, artifacts, secrets });
const store = artifactDirectory(artifacts, tarCodec);
const backend: VmBackend = {
  ...real,
  async ensureRunning(boot, live, signal) {
    spawns[boot.pylonId] = { source: boot.source, repo: boot.repo };
    await writeFile(join(here, "spawns.json"), `${JSON.stringify(spawns, null, 2)}\n`);
    return real.ensureRunning(boot, live, signal);
  },
  async buildTemplate(template, inputs, signal) {
    builds.push({ template, inputs });
    await writeFile(join(here, "builds.json"), `${JSON.stringify(builds, null, 2)}\n`);
    if (await store.manifest(template) !== null) return;
    await store.publish({ id: template, key: inputs.key, commit: inputs.repo.commit, builtAt: new Date().toISOString() },
      (into) => writeFile(join(into, "disk.qcow2"), "placeholder: no VM ran setup in this verification\n"), signal);
  },
};
const probe = await startProbe({
  node, host: "127.0.0.1", port: 0, auth: { controlPlane, peers: [] }, whois: async () => controlPlane, backend, secrets, gitSsh: false,
});
const client = connectProbe(node, "127.0.0.1", nodeId, { port: probe.port, whois: async () => nodeId });

const registry = openRegistry(join(root, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: nodeId });
registry.saveImage({ id: image, gondolinBuildId: "b", builtOn: node, builtAt: "2026-10-26T00:00:00Z", sha256: "c".repeat(64), pins: {} } as never, null);
registry.setCurrentImage(image);

const loop = startLoop({ registry, probes: [client], ingest, previewPorts: { first: 10200, last: 10299 }, log: (m) => console.error(m) });
const { harness } = fakeHarness();
await startApi({
  registry, whois: async () => laptop, host: "127.0.0.1", port: 7470, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "https://github.com/ramtinJ95/dotfiles.git", ref: "main" }, harness: harness as never, mirror: projectMirror({ githubToken: null }),
  wake: (n) => { void loop.wake(n); }, probes: new Map([[client.node, client]]), previewPorts: { first: 10200, last: 10299 },
});
console.log(`nexus API on http://127.0.0.1:7470 following ${node}; registry at ${join(root, "registry.db")}`);
