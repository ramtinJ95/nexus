/**
 * Retries thread starts on a local stack, as a client does when it never got the answer, and captures what the CLI and
 * the API answered and what each thread's conversation holds:
 *
 *   node docs/verification/thread-start-request-id/stack.ts drive <src> <out>
 *
 * `src` is the src directory of the checkout to run, and `out` the folder for the captures. The control plane is the
 * real startControlPlane from that checkout, with its registry, loop, harness and API, in a child process. The node is
 * the real probe server in another. Every start goes through the real `nexus` CLI, and the raw repeats through fetch.
 * Only the production boundaries are stand-ins: tailscaled's whois, the scripted model, and a VM backend that boots
 * nothing. Its guest runs the pi-env daemon from node_modules for the harness, so a thread's first message gets the
 * scripted answer. The control plane restarts once between two retries. A proxy in the driver forwards a request to the API and hangs up before the answer, as a dropped
 * connection does after the control plane acted.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { VmBackend, Guest } from "../../../src/backend.ts";
import type { ImageId, ImageManifest } from "../../../src/images.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";

const [mode, srcArg, ...rest] = process.argv.slice(2) as [string, string, ...string[]];
const src = resolve(srcArg);
const image = "img-0000000000aa" as ImageId;
const controlId = "nVERIFYCONTROL" as TailnetNodeId;
const node = { name: "node-a" as NodeName, host: "127.0.0.1", id: "nVERIFYA" as TailnetNodeId };
const api = "http://127.0.0.1:7470";
const lossy = "http://127.0.0.1:7471";

async function probe() {
  const { startProbe } = await import(`${src}/probe/server.ts`) as typeof import("../../../src/probe/server.ts");
  const { nodeSecrets } = await import(`${src}/probe/config.ts`) as typeof import("../../../src/probe/config.ts");
  const { processStream } = await import(`${src}/process-stream.ts`) as typeof import("../../../src/process-stream.ts");
  const piEnv = join(src, "../node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64");
  const booted = new Set<PylonId>();
  const guest = (): Guest => ({
    exec: async () => ({ exitCode: 1, output: "", truncated: false }),
    async stream(argv, log) {
      if (!argv[2]?.includes("/usr/local/libexec/nexus/pi-env")) throw new Error(`the stand-in guest runs only the pi-env daemon, not ${argv.join(" ")}`);
      return processStream(piEnv, argv.slice(4), log);
    },
    async writeFiles() {},
    services: async () => ({ services: [] }),
    startService: () => Promise.reject(new Error("no services in the stand-in guest")),
    linkPort: () => Promise.reject(new Error("no ports in the stand-in guest")),
    unlinkPort: async () => null,
    previewOrigin: () => { throw new Error("no previews in the stand-in guest"); },
  } as Guest);
  const backend = {
    async ensureRunning(boot: Parameters<VmBackend["ensureRunning"]>[0]) {
      if (!booted.has(boot.pylonId)) console.log(`backend: booted ${boot.pylonId}`);
      booted.add(boot.pylonId);
    },
    async ensurePaused() {}, async ensureDeleted(pylonId: PylonId) { booted.delete(pylonId); },
    list: async () => [...booted].map((pylonId) => ({ pylonId, vm: "running" as const, checkpoint: null, image, bootedAt: "2026-10-28T00:00:00.000Z" })),
    async buildTemplate() {}, async buildImage() {},
    guest,
    artifacts: { list: async () => [image], manifest: async () => null, export: () => Promise.reject(new Error("unused")), async import() {}, async drop() {} },
    async updateSecret() { return []; },
  } as unknown as VmBackend;
  const secrets = nodeSecrets({ value: () => undefined, names: () => [] });
  const p = await startProbe({ node: node.name, host: node.host, port: 7480, auth: { controlPlane: controlId, peers: [] }, whois: async () => controlId, backend, secrets, log: () => {} });
  console.log(`probe listening on ${node.host}:${p.port}`);
  process.once("SIGTERM", () => { void p.close().then(() => process.exit(0)); });
}

async function control(runDir: string) {
  const { startControlPlane } = await import(`${src}/control/main.ts`) as typeof import("../../../src/control/main.ts");
  const { scriptedModel, scriptedModels } = await import(`${src}/harness/test-fixture.ts`) as typeof import("../../../src/harness/test-fixture.ts");
  const socket = join(runDir, "tailscaled.sock");
  rmSync(socket, { force: true });
  await new Promise<void>((done) => createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: addr === `${node.host}:7480` ? node.id : controlId } }));
  }).listen(socket, done));
  const cp = await startControlPlane({
    db: join(runDir, "registry.db"),
    listen: { host: "127.0.0.1", port: 7470, hostnames: ["127.0.0.1"] },
    self: { tailnetNodeId: controlId },
    nodes: [{ name: node.name, tailnetHost: node.host, tailnetNodeId: node.id }],
    callers: [],
    dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    harness: { storage: join(runDir, "harness.sqlite"), credentials: join(runDir, "unused-credentials.json"), model: scriptedModel },
    tailscaledSocket: socket,
    previewPorts: { first: 10200, last: 10299 },
    resumeAfterUsageLimit: false,
  }, scriptedModels());
  console.log("control plane listening");
  process.once("SIGTERM", () => { void cp.close().then(() => process.exit(0)); });
}

/** Forwards each request to the API, waits for the API's answer, and hangs up without passing it on. */
function lossyProxy(log: (line: string) => void) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const answer = await fetch(`${api}${req.url}`, { method: req.method!, headers: { "content-type": "application/json" }, ...chunks.length === 0 ? {} : { body: Buffer.concat(chunks) } });
    log(`proxy: the API answered ${req.method} ${req.url} with ${answer.status}, and the proxy hung up before passing it on`);
    await answer.arrayBuffer();
    res.socket?.destroy();
  });
  return {
    listen: () => new Promise<void>((done) => server.listen(7471, "127.0.0.1", done)),
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

async function drive(out: string) {
  const runDir = mkdtempSync(join(tmpdir(), "nexus-start-request-"));
  mkdirSync(out, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  writeFileSync(join(out, "timeline.txt"), "");
  writeFileSync(join(out, "control.log"), "");
  const log = (line: string) => { console.log(line); appendFileSync(join(out, "timeline.txt"), `${line}\n`); };
  const proxy = lossyProxy(log);
  await proxy.listen();

  const children = new Set<ChildProcess>();
  const child = (label: string, args: string[]) => {
    const c = spawn(process.execPath, [here, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(c);
    c.stdout!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) if (l.startsWith("backend:")) log(l.replace(/th-[0-9a-f]{12}/g, (id) => name(id))); });
    c.stderr!.on("data", (b: Buffer) => appendFileSync(join(out, "control.log"), `${label}: ${b.toString().replaceAll(runDir, "<run>")}`));
    return new Promise<ChildProcess>((ready, failed) => {
      c.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("listening")) ready(c); });
      c.once("exit", (code) => { children.delete(c); failed(new Error(`${label} exited with ${code} before it listened. control.log says why`)); });
    });
  };
  const stop = (c: ChildProcess) => new Promise<void>((done) => { c.once("exit", () => done()); c.kill("SIGTERM"); });

  /** Thread IDs are random, so the captures name each by the order it first appeared in. */
  const names = new Map<string, string>();
  const name = (id: string) => { if (!names.has(id)) names.set(id, `<thread ${names.size + 1}>`); return names.get(id)!; };
  const scrub = (text: string) => text.replace(/th-[0-9a-f]{12}/g, (id) => name(id)).replace(/"(createdAt|lastHumanActivityAt|lastAgentActivityAt|seenAt|lastReplyAt|observedAt|workingSince)": \d+/g, '"$1": <time>');

  let step = 0;
  const run = promisify(execFile);
  const save = (label: string, text: string) => {
    const file = `${String(++step).padStart(2, "0")}-${label}.txt`;
    writeFileSync(join(out, file), scrub(text));
    return file;
  };
  /** One CLI call, saved as NN-<label>.txt with the command, stdout, stderr and exit code. */
  async function nexus(label: string, url: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    let code = 0, stdout = "", stderr = "";
    try {
      ({ stdout, stderr } = await run(process.execPath, [join(src, "cli/nexus.ts"), ...args], { env: { ...process.env, NEXUS_URL: url, NEXUS_SOCKS: "none" } }));
    } catch (err) {
      ({ code, stdout, stderr } = err as { code: number; stdout: string; stderr: string });
    }
    const file = save(label, `$ NEXUS_URL=${url} nexus ${args.map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(" ")}\n${stdout}${stderr === "" ? "" : `[stderr] ${stderr}`}[exit ${code}]\n`);
    log(scrub(`nexus ${args.join(" ")}${url === lossy ? " (through the proxy)" : ""} -> exit ${code} (${file})`));
    return { code, stdout };
  }
  /** One raw API call, saved as NN-<label>.txt with the request and the answer. */
  async function post(label: string, body: unknown) {
    const res = await fetch(`${api}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = await res.json() as { id?: string; error?: string };
    const file = save(label, `POST /v1/threads ${JSON.stringify(body)}\nHTTP ${res.status}\n${JSON.stringify(answer, null, 2)}\n`);
    log(scrub(`POST /v1/threads ${JSON.stringify(body)} -> HTTP ${res.status} ${answer.id ?? answer.error ?? ""} (${file})`));
    return answer;
  }
  const threads = async () => (await (await fetch(`${api}/v1/threads`)).json()) as { id: string; title: string }[];
  /** Waits until every thread's conversation has a scripted answer, then saves them all. */
  async function conversations(label: string) {
    const list = await threads();
    const deadline = Date.now() + 120_000;
    const read = async (id: string) => (await run(process.execPath, [join(src, "cli/nexus.ts"), "conversation", id], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } })).stdout;
    for (const t of list) {
      for (;;) {
        if ((await read(t.id).catch(() => "")).includes("scripted answer") || Date.now() > deadline) break;
        await sleep(500);
      }
    }
    const texts = await Promise.all(list.map(async (t) => `== ${t.id} ${t.title}\n${await read(t.id).catch((err: Error) => err.message)}`));
    const file = save(label, `$ nexus threads, then nexus conversation <thread> for each\n${list.length} thread(s)\n\n${texts.join("\n")}`);
    log(scrub(`${list.length} thread(s): ${list.map((t) => `${t.id} "${t.title}"`).join(", ")} (${file})`));
  }

  try {
    const { openRegistry } = await import(`${src}/control/registry.ts`) as typeof import("../../../src/control/registry.ts");
    const seed = openRegistry(join(runDir, "registry.db"));
    seed.saveImage({ id: image, gondolinBuildId: "stand-in", builtOn: node.name, builtAt: new Date().toISOString(), sha256: "0".repeat(64), pins: {} } as unknown as ImageManifest, null);
    seed.setCurrentImage(image);
    seed.close();
    await child("probe", ["probe", src]);
    const startControl = async () => {
      const c = await child("control", ["control", src, runDir]);
      for (;;) { try { if ((await fetch(`${api}/v1/nodes`)).ok) break; } catch {} await sleep(50); }
      return c;
    };
    let cp = await startControl();
    await nexus("version", api, "--version");
    await nexus("project-add", api, "project", "add", "scratch", "--scratch", "--node", node.name, "--cpus", "1", "--memory", "1", "--disk", "1");

    log("== a start whose answer is lost, retried with a request ID");
    const start = ["start", "--project", "scratch", "--message", "Fix the flaky checkout test", "--request-id", "start:lost-answer", "--json"];
    await nexus("start-lost-answer", lossy, ...start);
    await nexus("start-retry", api, ...start);
    await stop(cp);
    cp = await startControl();
    log("control plane restarted");
    await nexus("start-retry-after-restart", api, ...start);
    await conversations("threads-after-retries");

    log("== the same request ID with another body");
    await nexus("start-other-body", api, "start", "--project", "scratch", "--message", "Fix the login page", "--request-id", "start:lost-answer", "--json");

    log("== the API repeated directly, the same body twice and then another");
    const body = { project: "scratch", title: "Through the API", message: "Read the README", requestId: "start:api" };
    await post("post-first", body);
    await post("post-repeat", body);
    await post("post-other-body", { ...body, title: "Another title" });

    log("== a start whose answer is lost, retried without a request ID");
    const plain = ["start", "--project", "scratch", "--message", "Tidy the docs", "--json"];
    await nexus("plain-lost-answer", lossy, ...plain);
    await nexus("plain-retry", api, ...plain);
    await conversations("threads-at-the-end");
  } finally {
    await Promise.all([...children].map(stop));
    await proxy.close();
    rmSync(runDir, { recursive: true, force: true });
  }
}

await (mode === "probe" ? probe() : mode === "control" ? control(rest[0]!) : drive(resolve(rest[0]!)));
