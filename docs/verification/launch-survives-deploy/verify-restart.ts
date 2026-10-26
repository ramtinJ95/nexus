/**
 * A Claude worker launch whose probe is stopped by SIGTERM partway and started again 1.3 s later, as a deploy does,
 * end to end: the real control loop and registry, the real probe server in a child process, and real Herdr and Claude
 * Code in an isolated HOME, so the Herdr server and Claude state are separate from the pylon's own.
 *
 *   node docs/verification/launch-survives-deploy/verify-restart.ts before-typing|while-typing|after-typing [main-src]
 *
 * With `main-src`, the src directory of a checkout of main, the probe that is stopped runs main's code, which records
 * nothing of a launch, as the probe a deploy replaces does, and only the replacement runs this branch.
 *
 * Only the VM backend is a stand-in: it reports one running pylon whose guest is this machine. The probe stops itself
 * with SIGTERM when its guest is asked for the first exec of the chosen step: the wait for the shell prompt, the exec
 * that types the launch (started first, as a guest exec runs to its end), or the wait for the submission receipt.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const [mode, mainSrc] = process.argv.slice(2) as [string, string | undefined];
const steps = {
  "before-typing": (a: readonly string[]) => a[3] === "shell-ready",
  "while-typing": (a: readonly string[]) => (a[0] === "sh" && a[4] === "herdr") || (a[3] === "pane" && a[4] === "run"),
  "after-typing": (a: readonly string[]) => a[3] === "claude-submitted",
};
const kill = mode === "probe" ? process.env.STOP_AT as keyof typeof steps | undefined : mode as keyof typeof steps;
if (kill !== undefined && !(kill in steps)) throw new Error(`usage: verify-restart.ts ${Object.keys(steps).join("|")}`);
const root = `/tmp/nexus-restart-${mode === "probe" ? process.env.STEP : `${mode}${mainSrc === undefined ? "" : "-from-main"}`}`;
const home = `${root}/home`;
const repo = `${root}/repo`;
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: `${home}/.config`, XDG_RUNTIME_DIR: `${root}/run`, XDG_STATE_HOME: `${home}/.local/state`, XDG_DATA_HOME: `${home}/.local/share` };
const node = "verify-node" as NodeName;
const nodeId = "nVERIFY" as TailnetNodeId;
const pylonId = "pylon-th-verify" as PylonId;
const image = "img-000000000000" as ImageId;
const port = 17480;
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
    async exec(argv, opts) {
      if (kill !== undefined && steps[kill](argv)) {
        console.log(`probe ${process.pid}: stopping with SIGTERM at ${kill}`);
        const started = kill === "while-typing" ? run(argv, opts.timeoutMs) : null;
        process.kill(process.pid, "SIGTERM");
        await started;
        return new Promise(() => {});
      }
      return run(argv, opts.timeoutMs);
    },
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
    list: async () => [{ pylonId, vm: "running", checkpoint: null, image, bootedAt: "2026-10-26T00:00:00Z" }],
    async buildTemplate() {}, async buildImage() {},
    guest: () => guest,
    artifacts: { list: async () => [image], manifest: async () => null, export: () => Promise.reject(new Error("unused")), async import() {}, async drop() {} },
  };
  const { startProbe } = await import(`${process.env.PROBE_SRC ?? "../../../src"}/probe/server.ts`) as typeof import("../../../src/probe/server.ts");
  const probe = await startProbe({ node, host: "127.0.0.1", port, auth: { controlPlane: nodeId, peers: [] }, whois: async () => nodeId, backend, secrets: { value: () => undefined, names: () => [] } });
  console.log(`probe ${process.pid} listening on ${port} as boot ${probe.bootId}, from ${process.env.PROBE_SRC ?? "this branch"}`);
  process.once("SIGTERM", () => { console.log(`probe ${process.pid}: SIGTERM, closing`); void probe.close().then(() => process.exit(0)); });
}

async function controlPlane() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(`${root}/run`, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true });
  // The pane's bash reads only this HOME's startup files, so it takes the pylon's Claude token placeholder from here.
  for (const file of [".bashrc", ".bash_profile"]) writeFileSync(`${home}/${file}`, ". /etc/profile.d/nexus-secrets.sh\n");
  mkdirSync(repo, { recursive: true });
  await run(["git", "init", "-q", repo], 10_000);
  const registry = openRegistry(`${root}/registry.db`);
  registry.upsertNode({ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: nodeId });
  registry.createProject({ id: "verify" as ProjectId, repoUrl: "https://example.com/verify.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null });
  const id = "th-verify" as ThreadId;
  const thread: Thread = { seenAt: null, lastReplyAt: null, id, title: `restart ${mode}`, project: "verify" as ProjectId, pylonId, status: "active", conversationId: null, startedBy: "nVERIFY", createdAt: Date.now(), agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now() };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: id, pylonId, node, desired: "running",
    boot: { pylonId, image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: "https://example.com/verify.git", checkout: { branch: "main", commit: "origin/main" } }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" } },
    firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash-1" as LiveHash,
  });
  registry.createThread(thread, pylon);
  registry.setClaudeWorker(id, "Reply with exactly the words: restart verified. Use no tools.", "pending");

  const children: ChildProcess[] = [];
  const startProbeProcess = (stopAt: string | undefined) => {
    const old = stopAt !== undefined && mainSrc !== undefined ? { PROBE_SRC: mainSrc } : {};
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "probe"], { env: { ...process.env, STEP: `${mode}${mainSrc === undefined ? "" : "-from-main"}`, ...old, ...(stopAt === undefined ? {} : { STOP_AT: stopAt }) }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) log(l); });
    child.stderr!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) log(`probe stderr: ${l}`); });
    children.push(child);
    return child;
  };
  startProbeProcess(mode).once("exit", (code) => {
    log(`probe exited ${code}; the replacement starts in 1.3 s`);
    setTimeout(() => startProbeProcess(undefined), 1_300);
  });

  const loop = startLoop({ registry, probes: [connectProbe(node, "127.0.0.1", nodeId, { port, whois: async () => nodeId })], ingest, previewPorts: { first: 20200, last: 20209 }, log });
  let last = "";
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const worker = registry.claudeWorker(id)!;
    if (worker.state !== last) log(`worker ${last = worker.state}${worker.message ? `: ${worker.message}` : ""}`);
    if (worker.state === "started" || worker.state === "failed" || worker.state === "stalled" || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const herdr = (...args: string[]) => run(["herdr", "--session", "nexus", ...args], 10_000);
  try {
    log(`thread.failed events: ${registry.events().filter((e) => e.kind === "thread.failed").length}`);
    await new Promise((r) => setTimeout(r, 15_000));
    const snapshot = JSON.parse((await herdr("api", "snapshot")).output).result.snapshot;
    log(`${snapshot.workspaces.length} workspace(s), ${snapshot.panes.length} pane(s)`);
    for (const pane of snapshot.panes) {
      const info = JSON.parse((await herdr("pane", "process-info", "--pane", pane.pane_id)).output).result.process_info;
      log(`pane ${pane.pane_id}: agent ${pane.agent} ${pane.agent_status}, foreground ${info.foreground_processes.map((p: { argv: string[] }) => p.argv.slice(0, 3).join(" ")).join(", ")}`);
      log(`pane ${pane.pane_id} shows:\n${(await herdr("pane", "read", pane.pane_id, "--source", "recent-unwrapped", "--lines", "40")).output.trimEnd()}`);
    }
    log(`claude processes in the isolated HOME: ${(await run(["sh", "-c", `for p in $(pgrep -x claude); do tr '\\0' ' ' < /proc/$p/environ | grep -q "HOME=${home} " && echo $p; done | wc -l`], 5_000)).output.trim()}`);
    log(`launch record: ${(await run(["sh", "-c", 'cd "$0"/.nexus/claude-launches/* && for f in *; do if test -d "$f"; then printf "%s/ " "$f"; else printf "%s=%s " "$f" "$(cat "$f")"; fi; done', home], 5_000)).output.trim()}`);
  } finally {
    await loop.close();
    registry.close();
    for (const child of children) child.kill("SIGTERM");
    await herdr("server", "stop");
  }
}

await (mode === "probe" ? probe() : controlPlane());
