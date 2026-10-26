/**
 * The real control-plane loop, registry and ingest, following the real probe server over HTTP, whose backend is this
 * mount namespace: its guest execs run here, against a real Herdr server and Claude Code. A pause records the sessions
 * with the real recordBeforePause and SIGKILLs every process in the namespace but this driver, as a stopped VM does. A
 * wake runs the real relaunchAfterWake. Run it through sandbox.sh, never in a pylon's own home.
 *
 * With `fail-reads`, the probe's reads of Herdr fail from the wake on, as a read that times out or cannot parse does,
 * until the driver lets them through. The relaunch and the sends use a guest whose reads always work.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BackendPylon, Guest, VmBackend } from "./src/backend.ts";
import { startProbe } from "./src/probe/server.ts";
import { nodeSecrets } from "./src/probe/config.ts";
import { connectProbe, type LiveHash, type NodeName, type PausedSession, type PylonId, type TailnetNodeId } from "./src/protocol.ts";
import { startLoop } from "./src/control/loop.ts";
import { openRegistry, type Session, type Thread, type ThreadId } from "./src/control/registry.ts";
import { newPylonRecord } from "./src/tick.ts";
import { ingest } from "./src/reconcile.ts";
import type { CheckpointId, ImageId } from "./src/images.ts";
import type { ProjectId } from "./src/project.ts";
import { recordBeforePause, relaunchAfterWake } from "./src/session-wake.ts";
import { checkoutDir, openSession } from "./src/sessions.ts";

const label = process.argv[2] ?? "run";
const failReads = process.argv.includes("fail-reads");
const node = "verify-node" as NodeName;
const image = "img-000000000000" as ImageId;
const controlPlane = "nCONTROL" as TailnetNodeId;
const probeNodeId = "nPROBE" as TailnetNodeId;
const started = Date.now();
const log = (line: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${line}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const unused = () => Promise.reject(new Error("unused"));
const localGuest = (readsFail: () => boolean): Guest => ({
  exec: (argv, opts) => {
    if (readsFail() && argv[0] === "herdr" && argv.includes("snapshot")) return Promise.resolve({ exitCode: 1, output: "Error: exec failed", truncated: false });
    return new Promise((resolve) => {
      execFile(argv[0]!, argv.slice(1), { cwd: opts.cwd, timeout: opts.timeoutMs }, (err, stdout, stderr) => {
        const killed = err !== null && "killed" in err && err.killed;
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : 127;
        resolve({ exitCode: killed ? null : code, output: stdout + stderr, truncated: false });
      });
    });
  },
  async writeFiles(files) {
    for (const f of files) {
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.content, { mode: f.mode });
    }
  },
  stream: unused, services: unused, startService: unused, linkPort: unused, unlinkPort: unused,
  previewOrigin: () => { throw new Error("unused"); },
});
let readsFail = false;
const workGuest = localGuest(() => false);
const probeGuest = localGuest(() => readsFail);

function processes(): { pid: number; ppid: number; mnt: string | null }[] {
  return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).flatMap((d) => {
    try {
      const ppid = Number(readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1]!.split(" ")[1]);
      let mnt: string | null = null;
      try { mnt = readlinkSync(`/proc/${d}/ns/mnt`); } catch {}
      return [{ pid: Number(d), ppid, mnt }];
    } catch { return []; }
  });
}
function killGuest(): number {
  const mine = readlinkSync("/proc/self/ns/mnt");
  const all = processes();
  const keep = new Set<number>();
  for (let pid = process.pid; pid > 1; pid = all.find((p) => p.pid === pid)?.ppid ?? 1) keep.add(pid);
  const killed = all.filter((p) => p.mnt === mine && !keep.has(p.pid));
  for (const p of killed) try { process.kill(p.pid, "SIGKILL"); } catch {}
  return killed.length;
}
/** The `claude` processes in this mount namespace, so not the pylon's own. */
const claudes = () => readdirSync("/proc").filter((d) => /^\d+$/.test(d)).filter((d) => {
  try { return readlinkSync(`/proc/${d}/ns/mnt`) === readlinkSync("/proc/self/ns/mnt") && readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0")[0]?.split("/").at(-1) === "claude"; } catch { return false; }
}).length;

let vm: BackendPylon | null = null;
const backendLog = async (line: string) => log(`backend: ${line}`);
const backend: VmBackend = {
  async ensureRunning(boot) {
    const woke = vm?.vm === "stopped";
    vm = { pylonId: boot.pylonId, vm: "running", checkpoint: vm?.checkpoint ?? null, image, bootedAt: new Date().toISOString() };
    if (!woke) return;
    if (failReads) readsFail = true;
    await relaunchAfterWake(boot.pylonId, workGuest, backendLog);
  },
  async ensurePaused(pylonId, checkpoint) {
    if (vm?.vm !== "running") return;
    const recorded: readonly PausedSession[] | null = await recordBeforePause(workGuest, backendLog);
    log(`backend: pause SIGKILLed ${killGuest()} process(es), Herdr and Claude included`);
    vm = { pylonId, vm: "stopped", checkpoint, image, bootedAt: null, sessions: recorded };
  },
  async ensureDeleted() { vm = null; },
  buildTemplate: unused, buildImage: unused,
  async list() { return vm === null ? [] : [vm]; },
  guest: () => probeGuest,
  async updateSecret() { return []; },
  artifacts: {
    list: async () => [image, ...(vm?.checkpoint ? [vm.checkpoint as CheckpointId] : [])],
    manifest: async () => null, export: unused, import: unused, drop: unused,
  },
};

const probe = await startProbe({
  node, host: "127.0.0.1", port: 0, auth: { controlPlane, peers: [] }, whois: async () => controlPlane, backend,
  secrets: nodeSecrets({ value: () => undefined, names: () => [] }),
  log: (line) => { if (line.includes("sessions")) log(`probe: ${line}`); },
});
const registry = openRegistry(join(await mkdtemp(join(tmpdir(), "nexus-verify-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: probeNodeId });
registry.createProject({
  id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
const id = `th-${randomUUID().slice(0, 8)}` as ThreadId;
const pylonId = `pylon-${id}` as PylonId;
const thread: Thread = {
  seenAt: null, lastReplyAt: null, id, title: "Fix the login page", project: "acme" as ProjectId, pylonId, status: "active", conversationId: null,
  startedBy: "nLAPTOP", createdAt: Date.now(), agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now(),
};
const { desired: _, ...pylon } = newPylonRecord({
  thread: id, pylonId, node, desired: "running",
  boot: {
    pylonId, image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
    repo: { kind: "clone", url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
    dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  },
  firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash-1" as LiveHash,
});
registry.createThread(thread, pylon);
const loop = startLoop({
  registry, probes: [connectProbe(node, "127.0.0.1", probeNodeId, { port: probe.port, whois: async () => probeNodeId })],
  ingest, previewPorts: { first: 10200, last: 10209 }, intervalMs: 200, reconnectMs: 200, log: (line) => log(`loop: ${line}`),
});

const actual = () => registry.node(node)?.observation?.pylons.find((p) => p.pylonId === pylonId)?.phase ?? "absent";
/** One line per session, as `nexus show` prints it. */
const shown = (s: Session) => `${s.harness} ${JSON.stringify(s.title)} ${s.herdrPane === null ? `as ${s.id}` : `in pane ${s.herdrPane}`}, ${s.state === "paused" ? "paused (resumes on wake)" : s.state === "failed" ? `failed: ${s.message}` : s.status}`;
let last = "";
function show(when: string): string {
  const line = `pylon ${actual()}; ${registry.sessions(pylonId).map(shown).join("; ") || "no sessions"}; ${claudes()} claude process(es)`;
  if (line !== last) log(`${when}: ${line}`);
  last = line;
  return line;
}
async function until(what: string, predicate: () => boolean, timeoutMs = 90_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) {
    show(what);
    if (predicate()) return;
  }
  throw new Error(`timed out waiting until ${what}`);
}
const sessions = () => registry.sessions(pylonId);

log(`${label}: thread ${id}, ${failReads ? "the probe's reads fail from the wake on" : "the probe's reads work"}`);
await until("spawn", () => actual() === "running");
const pane = await openSession(workGuest, { harness: "claude-code", title: "Fix the login page", cwd: checkoutDir, resume: randomUUID(), prompt: "Reply with the single word ready, and do nothing else." });
log(`launch: the worker runs in ${pane}`);
await until("launched", () => sessions()[0]?.state === "running" && sessions()[0]?.status === "idle");
// Herdr saves its layout a few seconds after a change, and a pylon runs for minutes before it pauses.
await sleep(15_000);

registry.setThreadStatus(id, "archived");
await until("archived", () => actual() === "stopped" && sessions()[0]?.state === "paused");

registry.setThreadStatus(id, "active");
registry.recordActivity(id, { human: Date.now() });
await until("woken", () => actual() === "running" && claudes() === 1);
for (let i = 0; i < 20; i++, await sleep(500)) show("woken");
const afterWake = sessions().map((s) => s.state);
if (failReads) {
  readsFail = false;
  log("the probe's reads work again");
}
await until("read", () => sessions()[0]?.state === "running" && sessions()[0]?.status !== "unknown");
log(`${label}: session states 10 s after the pylon ran again: ${afterWake.join(", ")}`);

await loop.close();
await probe.close();
registry.close();
killGuest();
process.exit(afterWake.every((s) => s === "running") ? 0 : 1);
