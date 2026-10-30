/**
 * A prompted Claude worker launch that stalls, end to end: the real control loop and registry, the real probe server in a
 * child process, and a real Herdr server in an isolated HOME. `claude` on the pane's PATH is a stand-in that prints a
 * screen and waits, so no UserPromptSubmit receipt ever comes and the launch stalls after its 30 seconds.
 *
 *   node docs/verification/launch-stall-as-data/verify-stall.ts [main-src]
 *
 * With `main-src`, the src directory of a checkout of main, the probe runs main's code, which throws a stall as an error,
 * as a node that has not updated yet does, while the control plane runs this branch.
 *
 * Only the VM backend is a stand-in: it reports one running pylon whose guest is this machine.
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Guest, VmBackend } from "../../../src/backend.ts";
import { startLoop } from "../../../src/control/loop.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import type { ImageId } from "../../../src/images.ts";
import type { LiveHash, NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";
import { connectProbe } from "../../../src/protocol.ts";
import type { ProjectId } from "../../../src/project.ts";
import { ingest } from "../../../src/reconcile.ts";
import { newPylonRecord } from "../../../src/tick.ts";

const isProbe = process.argv[2] === "probe";
const mainSrc = isProbe ? undefined : process.argv[2];
const probeSrc = process.env.PROBE_SRC;
const root = `/tmp/nexus-stall-${isProbe ? process.env.STEP : mainSrc === undefined ? "branch" : "main-probe"}`;
const home = `${root}/home`;
const repo = `${root}/repo`;
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: `${home}/.config`, XDG_RUNTIME_DIR: `${root}/run`, XDG_STATE_HOME: `${home}/.local/state`, XDG_DATA_HOME: `${home}/.local/share` };
const node = "verify-node" as NodeName;
const nodeId = "nVERIFY" as TailnetNodeId;
const pylonId = "pylon-th-verify" as PylonId;
const image = "img-000000000000" as ImageId;
const port = 17490;
const t0 = Date.now();
const log = (line: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(3)}s ${line}`);

/** Runs argv on this machine as the probe runs it in a pylon, with /home/user and the checkout moved under `root`. */
function run(argv: readonly string[], timeoutMs: number): Promise<{ exitCode: number | null; output: string; truncated: boolean }> {
  const moved = argv.map((a) => a.replaceAll("/home/user/workspace/repo", repo).replaceAll("/home/user", home));
  return new Promise((resolve) => execFile(moved[0]!, moved.slice(1), { cwd: home, env, timeout: timeoutMs }, (err, stdout, stderr) => {
    const killed = err !== null && "killed" in err && err.killed;
    resolve({ exitCode: err === null ? 0 : killed ? null : typeof err.code === "number" ? err.code : 127, output: stdout + stderr, truncated: false });
  }));
}

async function probe() {
  const guest: Guest = {
    exec: (argv, opts) => run(argv, opts.timeoutMs),
    async writeFiles(files) {
      for (const f of files) {
        const path = f.path.replace("/home/user", home);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.content, { mode: f.mode });
      }
    },
    stream: () => Promise.reject(new Error("no streams in this check")),
    services: async () => ({ services: [] }),
    startService: () => Promise.reject(new Error("no services in this check")),
    linkPort: () => Promise.reject(new Error("no previews in this check")),
    unlinkPort: () => Promise.reject(new Error("no previews in this check")),
    previewOrigin: () => { throw new Error("no previews in this check"); },
  };
  const backend: VmBackend = {
    async ensureRunning() {}, async ensurePaused() {}, async ensureDeleted() {},
    list: async () => [{ pylonId, vm: "running", checkpoint: null, image, bootedAt: "2026-10-30T00:00:00Z" }],
    state: async () => "running",
    async buildTemplate() {}, async buildImage() {},
    guest: () => guest,
    updateSecret: async () => [],
    artifacts: { list: async () => [image], has: async (a) => a === image, manifest: async () => null, export: () => Promise.reject(new Error("unused")), async import() {}, async drop() {} },
  };
  const { startProbe } = await import(`${probeSrc ?? "../../../src"}/probe/server.ts`) as typeof import("../../../src/probe/server.ts");
  const probe = await startProbe({ node, host: "127.0.0.1", port, auth: { controlPlane: nodeId, peers: [] }, whois: async () => nodeId, backend, secrets: { value: () => undefined, names: () => [], hold() {} } });
  console.log(`probe ${process.pid} listening on ${port}, from ${probeSrc ?? "this branch"}`);
  process.once("SIGTERM", () => { void probe.close().then(() => process.exit(0)); });
}

async function controlPlane() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(`${root}/run`, { recursive: true, mode: 0o700 });
  mkdirSync(`${root}/bin`, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(`${root}/bin/claude`, "#!/bin/sh\necho 'stand-in claude: waiting at its first screen, and never taking the prompt'\nexec sleep 600\n");
  chmodSync(`${root}/bin/claude`, 0o755);
  for (const file of [".bashrc", ".bash_profile"]) writeFileSync(`${home}/${file}`, `export PATH=${root}/bin:$PATH\n`);
  mkdirSync(repo, { recursive: true });
  await run(["git", "init", "-q", repo], 10_000);
  const registry = openRegistry(`${root}/registry.db`);
  registry.upsertNode({ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: nodeId });
  registry.createProject({ id: "verify" as ProjectId, repoUrl: "https://example.com/verify.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null });
  const id = "th-verify" as ThreadId;
  const thread: Thread = { seenAt: null, lastReplyAt: null, id, title: "stall", project: "verify" as ProjectId, pylonId, status: "active", conversationId: null, startedBy: "nVERIFY", createdAt: Date.now(), agentTurnRunning: false, working: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now() };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: id, pylonId, node, desired: "running",
    boot: { pylonId, image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: "https://example.com/verify.git", checkout: { branch: "main", commit: "origin/main" } }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" } },
    firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash-1" as LiveHash,
  });
  registry.createThread(thread, pylon);
  registry.setClaudeWorker(id, "Reply with exactly the words: stall verified.", "pending");

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "probe"], { env: { ...process.env, STEP: mainSrc === undefined ? "branch" : "main-probe", ...(mainSrc === undefined ? {} : { PROBE_SRC: mainSrc }) }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) log(l); });
  child.stderr!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) log(`probe stderr: ${l}`); });

  const loop = startLoop({ registry, probes: [connectProbe(node, "127.0.0.1", nodeId, { port, whois: async () => nodeId })], ingest, previewPorts: { first: 20210, last: 20219 }, log });
  let last = "";
  const deadline = Date.now() + 3 * 60_000;
  for (;;) {
    const worker = registry.claudeWorker(id)!;
    if (worker.state !== last) log(`worker ${last = worker.state}`);
    if (worker.state === "started" || worker.state === "failed" || worker.state === "stalled" || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const herdr = (...args: string[]) => run(["herdr", "--session", "nexus", ...args], 10_000);
  try {
    const worker = registry.claudeWorker(id)!;
    log(`worker state: ${worker.state}`);
    log(`worker message:\n${worker.message}`);
    log(`thread.failed events: ${registry.events().filter((e) => e.kind === "thread.failed").length}`);
    log(`attention: ${registry.events().filter((e) => e.kind === "attention.changed").at(-1)?.payload.attention}`);
    const snapshot = JSON.parse((await herdr("api", "snapshot")).output).result.snapshot;
    log(`${snapshot.workspaces.length} workspace(s), ${snapshot.panes.length} pane(s) left open`);
  } finally {
    await loop.close();
    registry.close();
    child.kill("SIGTERM");
    await herdr("server", "stop");
  }
}

await (isProbe ? probe() : controlPlane());
