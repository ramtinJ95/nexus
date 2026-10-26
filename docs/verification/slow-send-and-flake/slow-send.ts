/**
 * Two messages to one busy Claude worker, through the real CLI, control-plane API, probe client and probe server on
 * loopback, with a scripted guest whose typing takes 60 s for the first and 40 s for the second. The second waits in
 * the probe behind the first, so the control plane's 90 s wait for it runs out before it is typed. Run from the repo:
 * `node docs/verification/slow-send-and-flake/slow-send.ts`. Takes about two minutes.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry, type Thread } from "../../../src/control/registry.ts";
import { fakeGuest, herdrError, herdrOk, herdrPane, herdrSnapshot } from "../../../src/fake-guest.ts";
import type { Guest, VmBackend } from "../../../src/backend.ts";
import type { ImageId, ImageManifest } from "../../../src/images.ts";
import type { Project, ProjectId } from "../../../src/project.ts";
import { connectProbe, type NodeName, type PylonId, type TailnetNodeId } from "../../../src/protocol.ts";
import { startProbe } from "../../../src/probe/server.ts";

const cli = fileURLToPath(new URL("../../../src/cli/nexus.ts", import.meta.url));
const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const control = "nCONTROL" as TailnetNodeId;
const probeId = "nPROBE" as TailnetNodeId;
const session = "11111111-2222-4333-8444-555555555501";
const project: Project = {
  id: "acme" as ProjectId, repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const image: ImageManifest = {
  id: "img-0123456789ab" as ImageId, gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: "d", node: "24.22.1", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s",
    gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
const typingMs: Record<string, number> = { first: 60_000, second: 40_000 };

const start = Date.now();
const log = (line: string) => console.log(`[${String(Math.round((Date.now() - start) / 1000)).padStart(3)} s] ${line}`);

const typed: string[] = [];
const base = fakeGuest((argv, herdr) => {
  if (!herdr) return { exitCode: argv[3] === "claude-type" ? 0 : 1, output: "" };
  const sub = argv.slice(0, 2).join(" ");
  if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "Claude Code" }], [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: session })]));
  if (sub === "pane process-info") return herdrOk({ type: "pane_process_info", process_info: { pane_id: "w1:p1", shell_pid: 100, foreground_processes: [{ pid: 101, name: "claude", argv: ["claude", "--resume", session] }] } });
  return herdrError("unscripted", sub);
});
const guest: Guest = {
  ...base,
  async exec(argv, options) {
    if (argv[3] !== "claude-type") return base.exec(argv, options);
    const text = argv[5]!;
    log(`guest: typing "${text}" starts`);
    await new Promise((resolve) => setTimeout(resolve, typingMs[text] ?? 0));
    typed.push(text);
    log(`guest: typing "${text}" done`);
    return base.exec(argv, options);
  },
};

let pylonId = "" as PylonId;
const backend: VmBackend = {
  ensureRunning: async () => {}, ensurePaused: async () => {}, ensureDeleted: async () => {},
  list: async () => pylonId === "" ? [] : [{ pylonId, vm: "running", checkpoint: null, image: image.id, bootedAt: "2027-01-01T00:00:00Z" }],
  buildTemplate: async () => {}, buildImage: async () => {},
  guest: () => guest,
  artifacts: { list: async () => [image.id], manifest: async () => null, export: async () => assert.fail("no export"), import: async () => {}, drop: async () => {} },
};
const probe = await startProbe({ node, host: "127.0.0.1", port: 0, auth: { controlPlane: control, peers: [] }, whois: async () => control, backend, secrets: { value: () => undefined, names: () => [] } });

const dir = await mkdtemp(join(tmpdir(), "nexus-slow-send-"));
const registry = openRegistry(join(dir, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: probeId });
registry.createProject(project);
registry.saveImage(image);
registry.setCurrentImage(image.id);
const api = await startApi({
  registry, host: "127.0.0.1", port: 0, whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" }, harness: fakeHarness().harness, wake: () => {},
  previewPorts: { first: 10200, last: 10299 },
  probes: new Map([[node, connectProbe(node, "127.0.0.1", probeId, { port: probe.port, whois: async () => probeId })]]),
});

const created = await fetch(`http://127.0.0.1:${api.port}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "acme", title: "Claude worker", claude: "fix it" }) });
const thread = await created.json() as Thread;
registry.setClaudeWorker(thread.id, "fix it", "started", undefined, session);
pylonId = thread.pylonId;
const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
registry.apply({ record: "node", node, state: "online", capacity });
registry.ingested({
  node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [],
  pylons: [{
    pylonId, phase: "running", liveHash: registry.pylon(pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: image.id, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }],
}, []);

function nexus(...args: string[]): Promise<{ code: number; out: string }> {
  log(`$ nexus ${args.join(" ")}`);
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH!, HOME: dir, NEXUS_URL: `http://127.0.0.1:${api.port}`, NEXUS_SOCKS: "none" } }, (err, stdout, stderr) => {
      const code = err === null ? 0 : (err as { code: number }).code;
      log(`  exit ${code}: ${(stdout + stderr).trim()}`);
      resolve({ code, out: stdout + stderr });
    });
  });
}

const first = nexus("send", thread.id, "first", "--request-id", "msg:first");
await new Promise((resolve) => setTimeout(resolve, 1_000));
const second = await nexus("send", thread.id, "second", "--request-id", "msg:second");
await first;
const resend = await nexus("send", thread.id, "second", "--request-id", "msg:second");
const again = await nexus("send", thread.id, "second", "--request-id", "msg:second");
log(`typed into Claude: ${JSON.stringify(typed)}`);

await api.close();
await probe.close();
registry.close();
await rm(dir, { recursive: true });
log(`second send exit ${second.code}, resend exit ${resend.code}, resend again exit ${again.code}`);
assert.deepEqual(typed, ["first", "second"], "each message typed exactly once");
