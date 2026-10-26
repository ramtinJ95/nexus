/**
 * Starts a thread that needs the ChatGPT token right after a control plane restart, a deploy that restarts the control
 * plane and then every probe, and a probe restart, on a local stack of two nodes:
 *
 *   node docs/verification/start-right-after-restart/stack.ts drive <src>
 *
 * `src` is the src directory of the checkout to run. The control plane is the real startControlPlane from it, with its
 * registry, loop, harness, API and token handoff, and the starts go through the real `nexus` CLI. Each node is the real
 * probe server in a child process, on 127.0.0.1 and 127.0.0.2, so a restart is a process exit. Only the production
 * boundaries are stand-ins: tailscaled's whois, the scripted model, a fixed token in place of the harness's ChatGPT
 * login, and a VM backend that boots nothing and reports what the probe would boot the pylon with.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { VmBackend } from "../../../src/backend.ts";
import type { ImageId, ImageManifest } from "../../../src/images.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";

const [mode, srcArg, ...rest] = process.argv.slice(2) as [string, string, ...string[]];
const src = resolve(srcArg);
const image = "img-0000000000aa" as ImageId;
const controlId = "nVERIFYCONTROL" as TailnetNodeId;
const nodes = [{ name: "node-a" as NodeName, host: "127.0.0.1", id: "nVERIFYA" as TailnetNodeId }, { name: "node-b" as NodeName, host: "127.0.0.2", id: "nVERIFYB" as TailnetNodeId }];
const api = "http://127.0.0.1:7470";
const token = "eyJhbGciOiJub25lIn0.eyJ2ZXJpZnkiOnRydWV9.c3RhbmQtaW4";
const t0 = Date.now();
const log = (line: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${line}`);

async function probe(name: NodeName, host: string) {
  const { startProbe } = await import(`${src}/probe/server.ts`) as typeof import("../../../src/probe/server.ts");
  const { nodeSecrets } = await import(`${src}/probe/config.ts`) as typeof import("../../../src/probe/config.ts");
  const secrets = nodeSecrets({ value: () => undefined, names: () => [] });
  const booted = new Set<PylonId>();
  const backend = {
    async ensureRunning(boot: Parameters<VmBackend["ensureRunning"]>[0]) {
      const held = boot.network.secrets.some((s) => s.name === "NEXUS_CHATGPT_TOKEN") ? secrets.value("NEXUS_CHATGPT_TOKEN") === token ? "the handed-over token" : "the stand-in" : "none";
      booted.add(boot.pylonId);
      console.log(`backend: booted ${boot.pylonId} with NEXUS_CHATGPT_TOKEN: ${held}`);
    },
    async ensurePaused() {}, async ensureDeleted() {},
    list: async () => [...booted].map((pylonId) => ({ pylonId, vm: "running" as const, checkpoint: null, image, bootedAt: new Date().toISOString() })),
    async buildTemplate() {}, async buildImage() {},
    guest: () => { throw new Error("no guest in this check"); },
    artifacts: { list: async () => [image], manifest: async () => null, export: () => Promise.reject(new Error("unused")), async import() {}, async drop() {} },
    async updateSecret() { return []; },
  } as unknown as VmBackend;
  const p = await startProbe({ node: name, host, port: 7480, auth: { controlPlane: controlId, peers: [] }, whois: async () => controlId, backend, secrets, log: () => {} });
  console.log(`probe listening on ${host}:${p.port}`);
  process.once("SIGTERM", () => { void p.close().then(() => process.exit(0)); });
}

async function control(runDir: string) {
  const { startControlPlane } = await import(`${src}/control/main.ts`) as typeof import("../../../src/control/main.ts");
  const { scriptedModel, scriptedModels } = await import(`${src}/harness/test-fixture.ts`) as typeof import("../../../src/harness/test-fixture.ts");
  const socket = join(runDir, "tailscaled.sock");
  rmSync(socket, { force: true });
  await new Promise<void>((done) => createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
    const id = nodes.find((n) => addr === `${n.host}:7480`)?.id ?? controlId;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: id } }));
  }).listen(socket, done));
  const cp = await startControlPlane({
    db: join(runDir, "registry.db"),
    listen: { host: "127.0.0.1", port: 7470, hostnames: ["127.0.0.1"] },
    self: { tailnetNodeId: controlId },
    nodes: nodes.map((n) => ({ name: n.name, tailnetHost: n.host, tailnetNodeId: n.id })),
    callers: [],
    dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    harness: { storage: join(runDir, "harness.sqlite"), credentials: join(runDir, "unused-credentials.json"), model: scriptedModel },
    tailscaledSocket: socket,
    previewPorts: { first: 10200, last: 10299 },
    resumeAfterUsageLimit: false,
  }, scriptedModels(), async () => token);
  console.log("control plane listening");
  process.once("SIGTERM", () => { void cp.close().then(() => process.exit(0)); });
}

async function drive() {
  const runDir = mkdtempSync(join(tmpdir(), "nexus-restart-"));
  const here = fileURLToPath(import.meta.url);
  const boots: string[] = [];
  const children = new Set<ChildProcess>();
  const child = (label: string, args: string[]) => {
    const c = spawn(process.execPath, [here, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(c);
    c.once("exit", () => children.delete(c));
    c.stdout!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) { if (l.startsWith("backend: booted")) boots.push(`${label} ${l}`); if (!l.startsWith("backend") || l.includes("th-")) log(`${label}: ${l}`); } });
    c.stderr!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) if (/error|refused|fail/i.test(l)) log(`${label} stderr: ${l.replaceAll(runDir, "<run>")}`); });
    return new Promise<ChildProcess>((ready) => c.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("listening")) ready(c); }));
  };
  const stop = (c: ChildProcess) => new Promise<void>((done) => { c.once("exit", () => done()); c.kill("SIGTERM"); });
  const startProbes = () => Promise.all(nodes.map((n) => child(n.name, ["probe", src, n.name, n.host])));
  const startControl = () => child("control", ["control", src, runDir]);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${api}${path}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const cli = promisify(execFile);
  async function start(title: string): Promise<{ ok: boolean; thread?: { id: string; pylonId: string; placement: { node: string } }; error?: string }> {
    try {
      const { stdout } = await cli(process.execPath, [join(src, "cli/nexus.ts"), "start", "--project", "chat", "--title", title, "--json"], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } });
      return { ok: true, thread: JSON.parse(stdout) };
    } catch (err) {
      const e = err as { code: number; stderr: string };
      return { ok: false, error: `exit ${e.code}: ${e.stderr.trim()}` };
    }
  }
  /** Starts at once, then again every 5 s while refused, and waits for the accepted thread's pylon to boot. */
  async function startNow(title: string) {
    const from = Date.now();
    let refusals = 0;
    for (;;) {
      const r = await start(title);
      if (r.ok) {
        log(`nexus start "${title}": accepted after ${((Date.now() - from) / 1000).toFixed(1)} s and ${refusals} refusals, ${r.thread!.id} on ${r.thread!.placement.node}`);
        const deadline = Date.now() + 180_000;
        while (!boots.some((b) => b.includes(r.thread!.pylonId))) {
          if (Date.now() > deadline) return log(`${r.thread!.pylonId} did not boot within 180 s`);
          await new Promise((w) => setTimeout(w, 100));
        }
        return log(`booted ${((Date.now() - from) / 1000).toFixed(1)} s after the first start: ${boots.find((b) => b.includes(r.thread!.pylonId))}`);
      }
      if (refusals++ === 0) log(`nexus start "${title}": refused, ${r.error}`);
      if (Date.now() - from > 180_000) return log(`still refused after 180 s, ${refusals} refusals`);
      await new Promise((w) => setTimeout(w, 5_000));
    }
  }
  const healthy = async () => { for (;;) { try { if ((await call("GET", "/v1/nodes")).status === 200) return; } catch {} await new Promise((w) => setTimeout(w, 50)); } };

  try {
    const { openRegistry } = await import(`${src}/control/registry.ts`) as typeof import("../../../src/control/registry.ts");
    const seed = openRegistry(join(runDir, "registry.db"));
    seed.saveImage({ id: image, gondolinBuildId: "stand-in", builtOn: nodes[0]!.name, builtAt: new Date().toISOString(), sha256: "0".repeat(64), pins: {} } as unknown as ImageManifest, null);
    seed.setCurrentImage(image);
    seed.close();
    log(`checkout ${src.replace(process.cwd(), "<repo>")}`);
    let probes = await startProbes();
    let cp = await startControl();
    await healthy();
    const added = await call("POST", "/v1/projects", { id: "chat", repoUrl: null, defaultBranch: "main", defaultNode: "auto", resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 }, allowedHosts: [], secrets: [], logins: ["chatgpt"], preSetup: null });
    log(`project chat with the chatgpt login and default node auto: HTTP ${added.status}`);
    log("== a cold start: the first start on a new stack");
    await startNow("cold start");

    log("== a control plane restart");
    await stop(cp);
    cp = await startControl();
    await healthy();
    log("control plane healthy");
    await startNow("after a control plane restart");

    log("== a deploy: the control plane restarts, then both probes, as nexus deploy upgrades them");
    await stop(cp);
    cp = await startControl();
    await healthy();
    log("control plane healthy");
    await new Promise((w) => setTimeout(w, 3_000));
    await Promise.all(probes.map(stop));
    probes = await startProbes();
    log("probes listening again");
    await startNow("after a deploy");

    log("== a probe restart on both nodes");
    await Promise.all(probes.map(stop));
    const restartedAt = new Date().toISOString();
    probes = await startProbes();
    while (!(await call("GET", "/v1/nodes")).body.every((n: { observedAt: string | null }) => n.observedAt !== null && n.observedAt > restartedAt)) await new Promise((w) => setTimeout(w, 50));
    log("the control plane has each restarted probe's first snapshot");
    await startNow("after a probe restart");
  } finally {
    await Promise.all([...children].map(stop));
  }
}

await (mode === "probe" ? probe(rest[0] as NodeName, rest[1]!) : mode === "control" ? control(rest[0]!) : drive());
