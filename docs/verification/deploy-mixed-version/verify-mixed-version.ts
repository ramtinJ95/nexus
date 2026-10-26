/**
 * A deploy's mixed-version window, end to end: a control plane on the new release boots a pylon that needs the
 * ChatGPT login on a node whose probe still runs a release from before it, and the probe is then upgraded.
 *
 *   node docs/verification/deploy-mixed-version/verify-mixed-version.ts <control-src> <old-probe-src>
 *
 * The control plane is the real reconcile loop and registry from `control-src`, the src directory of a checkout. The probe is the real probe server in a child process,
 * started from `old-probe-src` and replaced after 20 s by one from this branch, as `nexus deploy` restarts it. Both read
 * a secret file that holds only GH_TOKEN. Only the VM backend is a stand-in: it boots nothing and reports the pylon
 * running once a spawn reaches it, with the names of the secrets the spawn was given.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VmBackend } from "../../../src/backend.ts";
import type { Thread, ThreadId } from "../../../src/control/registry.ts";
import type { ImageId } from "../../../src/images.ts";
import type { LiveHash, NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";
import type { ProjectId } from "../../../src/project.ts";

const [mode, controlSrc, oldProbeSrc] = process.argv.slice(2) as [string, string, string | undefined];
const node = "verify-node" as NodeName;
const nodeId = "nVERIFY" as TailnetNodeId;
const pylonId = "pylon-th-verify" as PylonId;
const image = "img-000000000000" as ImageId;
const port = 17490;
const upgradeAfterMs = 20_000;
const t0 = Date.now();
const log = (line: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(3)}s ${line}`);
const fileSecrets = { value: (name: string) => name === "GH_TOKEN" ? "ghp_example" : undefined, names: () => ["GH_TOKEN"] };

async function probe(src: string) {
  let booted: string[] | null = null;
  const backend: VmBackend = {
    async ensureRunning(boot) {
      booted = boot.network.secrets.map((grant) => grant.name);
      console.log(`backend: booted ${boot.pylonId} with secrets ${booted.join(", ")}`);
    },
    async ensurePaused() {}, async ensureDeleted() {},
    list: async () => booted === null ? [] : [{ pylonId, vm: "running", checkpoint: null, image, bootedAt: new Date().toISOString() }],
    async buildTemplate() {}, async buildImage() {},
    guest: () => { throw new Error("no guest in this check"); },
    artifacts: { list: async () => [image], manifest: async () => null, export: () => Promise.reject(new Error("unused")), async import() {}, async drop() {} },
    async updateSecret() { return []; },
  } as VmBackend;
  const { startProbe } = await import(`${src}/probe/server.ts`) as typeof import("../../../src/probe/server.ts");
  const config = await import(`${src}/probe/config.ts`) as Partial<typeof import("../../../src/probe/config.ts")>;
  const secrets = config.nodeSecrets?.(fileSecrets) ?? fileSecrets;
  const probe = await startProbe({ node, host: "127.0.0.1", port, auth: { controlPlane: nodeId, peers: [] }, whois: async () => nodeId, backend, secrets: secrets as never, log: (line: string) => console.log(line) });
  console.log(`probe ${process.pid} listening on ${port} as boot ${probe.bootId}, from ${src}`);
  process.once("SIGTERM", () => { console.log(`probe ${process.pid}: SIGTERM, closing`); void probe.close().then(() => process.exit(0)); });
}

async function controlPlane() {
  const src = resolve(controlSrc);
  const here = fileURLToPath(new URL("../../../src", import.meta.url));
  const { openRegistry } = await import(`${src}/control/registry.ts`) as typeof import("../../../src/control/registry.ts");
  const { startLoop } = await import(`${src}/control/loop.ts`) as typeof import("../../../src/control/loop.ts");
  const { connectProbe } = await import(`${src}/protocol.ts`) as typeof import("../../../src/protocol.ts");
  const { ingest } = await import(`${src}/reconcile.ts`) as typeof import("../../../src/reconcile.ts");
  const { newPylonRecord } = await import(`${src}/tick.ts`) as typeof import("../../../src/tick.ts");
  const { chatgptTokenGrant } = await import(`${src}/project.ts`) as typeof import("../../../src/project.ts");
  log(`control plane from ${src}`);

  const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-mixed-")), "registry.db"));
  registry.upsertNode({ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: nodeId });
  registry.createProject({ id: "verify" as ProjectId, repoUrl: "https://example.com/verify.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: ["chatgpt"], preSetup: null });
  const id = "th-verify" as ThreadId;
  const thread: Thread = { seenAt: null, lastReplyAt: null, id, title: "mixed versions", project: "verify" as ProjectId, pylonId, status: "active", conversationId: null, startedBy: "nVERIFY", createdAt: Date.now(), agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now() };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: id, pylonId, node, desired: "running",
    boot: { pylonId, image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [chatgptTokenGrant] }, repo: { kind: "clone", url: "https://example.com/verify.git", checkout: { branch: "main", commit: "origin/main" } }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" } },
    firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash-1" as LiveHash,
  });
  registry.createThread(thread, pylon);

  const children: ChildProcess[] = [];
  let booted = false;
  const startProbeProcess = (probeSrc: string) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "probe", probeSrc], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) { booted ||= l.startsWith("backend: booted"); log(l); } });
    child.stderr!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) log(`probe stderr: ${l}`); });
    children.push(child);
    return child;
  };
  const old = startProbeProcess(resolve(oldProbeSrc ?? here));
  const upgrade = setTimeout(() => {
    log("deploy: upgrading the probe");
    old.kill("SIGTERM");
    old.once("exit", () => setTimeout(() => startProbeProcess(here), 1_300));
  }, upgradeAfterMs);

  const client = connectProbe(node, "127.0.0.1", nodeId, { port, whois: async () => nodeId });
  const loop = startLoop({ registry, probes: [client], ingest, previewPorts: { first: 20200, last: 20209 }, log });

  let last = "";
  const deadline = Date.now() + 3 * 60_000;
  try {
    for (;;) {
      const p = registry.pylon(pylonId)!;
      const state = p.failed !== null ? `failed: ${p.failed}` : `attempts ${p.attempts.count}, job in flight: ${p.submitted?.job.kind ?? "none"}, node ${registry.node(node)?.state}`;
      if (state !== last) log(`pylon ${last = state}`);
      if (p.failed !== null || (booted && p.submitted === null) || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    log(`thread.failed events: ${registry.events().filter((e) => e.kind === "thread.failed").length}`);
    log(`pylon failed: ${registry.pylon(pylonId)!.failed ?? "no"}`);
  } finally {
    clearTimeout(upgrade);
    await loop.close();
    registry.close();
    for (const child of children) child.kill("SIGTERM");
  }
}

await (mode === "probe" ? probe(controlSrc) : controlPlane());
