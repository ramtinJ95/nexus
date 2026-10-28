/**
 * Drives a planning thread on a local stack, through the real `nexus` CLI, and captures what the CLI answered and what
 * each thread's conversation holds:
 *
 *   node docs/verification/drive-tools/stack.ts drive <src> <out>
 *
 * `src` is the src directory of the checkout to run, and `out` the folder for the captures. The control plane is the
 * real startControlPlane from that checkout, with its registry, loop, harness and API, in a child process. The node is
 * the real probe server in another. Only the production boundaries are stand-ins: tailscaled's whois, the scripted
 * model, and a VM backend that boots nothing, whose guest runs the pi-env daemon from node_modules for the harness. The
 * scripted model turns a message `tool: <name> <JSON>` into one call of that tool. The control plane restarts twice:
 * between a watch and the turn it waits for, and after the watch's message, which must still be there once.
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

async function drive(out: string) {
  const runDir = mkdtempSync(join(tmpdir(), "nexus-drive-tools-"));
  mkdirSync(out, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  writeFileSync(join(out, "timeline.txt"), "");
  writeFileSync(join(out, "control.log"), "");
  const log = (line: string) => { console.log(line); appendFileSync(join(out, "timeline.txt"), `${line}\n`); };

  const children = new Set<ChildProcess>();
  const child = (label: string, args: string[]) => {
    const c = spawn(process.execPath, [here, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(c);
    c.stdout!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) if (l.startsWith("backend:")) log(scrub(l)); });
    c.stderr!.on("data", (b: Buffer) => appendFileSync(join(out, "control.log"), `${label}: ${scrub(b.toString().replaceAll(runDir, "<run>"))}`));
    return new Promise<ChildProcess>((ready, failed) => {
      c.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("listening")) ready(c); });
      c.once("exit", (code) => { children.delete(c); failed(new Error(`${label} exited with ${code} before it listened. control.log says why`)); });
    });
  };
  const stop = (c: ChildProcess) => new Promise<void>((done) => { c.once("exit", () => done()); c.kill("SIGTERM"); });

  /** Thread IDs are random, so the captures name each by the order it first appeared in. */
  const names = new Map<string, string>();
  const name = (id: string) => { if (!names.has(id)) names.set(id, `<thread ${names.size + 1}>`); return names.get(id)!; };
  const scrub = (text: string) => text.replace(/th-[0-9a-f]{12}/g, (id) => name(id)).replace(/"(createdAt|lastHumanActivityAt|lastAgentActivityAt|seenAt|lastReplyAt|observedAt|workingSince)": \d+/g, '"$1": <time>')
    .replace(/observed \d+s ago/g, "observed <time> ago");

  let step = 0;
  const run = promisify(execFile);
  const save = (label: string, text: string) => {
    const file = `${String(++step).padStart(2, "0")}-${label}.txt`;
    writeFileSync(join(out, file), scrub(text));
    return file;
  };
  const cli = async (...args: string[]) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [join(src, "cli/nexus.ts"), ...args], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } });
      return { code: 0, stdout, stderr };
    } catch (err) {
      return err as { code: number; stdout: string; stderr: string };
    }
  };
  /** One CLI call, saved as NN-<label>.txt with the command, stdout, stderr and exit code. */
  async function nexus(label: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    const { code, stdout, stderr } = await cli(...args);
    const file = save(label, `$ nexus ${args.map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(" ")}\n${stdout}${stderr === "" ? "" : `[stderr] ${stderr}`}[exit ${code}]\n`);
    log(scrub(`nexus ${args.join(" ")} -> exit ${code} (${file})`));
    return { code, stdout };
  }
  const conversation = async (id: string) => (await cli("conversation", id)).stdout;
  /** Waits until the thread's conversation satisfies `done`, or 60 s, and saves it. */
  async function settled(label: string, id: string, done: (text: string) => boolean) {
    const deadline = Date.now() + 60_000;
    let text = await conversation(id);
    while (!done(text) && Date.now() < deadline) { await sleep(500); text = await conversation(id); }
    const file = save(label, `$ nexus conversation ${id}\n${text}`);
    log(scrub(`conversation of ${id}${done(text) ? "" : " (timed out waiting)"} (${file})`));
  }
  const answered = (n: number) => (text: string) => (text.match(/^scripted answer after/gm) ?? []).length >= n && !text.includes("(the agent is working)");
  const tool = (name: string, args: unknown) => `tool: ${name} ${JSON.stringify(args)}`;
  const brief = (title: string) => ({ project: "scratch", title, brief: `${title}: say hello and stop.`, agent: "nexus" });

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
    await nexus("version", "--version");
    await nexus("project-add", "project", "add", "scratch", "--scratch", "--node", node.name, "--cpus", "1", "--memory", "1", "--disk", "1");

    log("== a thread started without --drive calls nexus_start");
    const plain = await nexus("start-plain", "start", "--project", "scratch", "--title", "Plain", "--message", tool("nexus_start", brief("Build 0")), "--json");
    if (plain.code === 0) await settled("plain-conversation", JSON.parse(plain.stdout).id, answered(1));

    log("== a planning thread started with --drive starts builders, up to 3 live ones");
    const started = await nexus("start-planner", "start", "--project", "scratch", "--title", "Plan", "--drive", "--message", tool("nexus_start", brief("Build 1")), "--json");
    if (started.code !== 0) {
      log("no planning thread started, so the steps that drive one are skipped");
      return;
    }
    const plan = JSON.parse(started.stdout).id as string;
    await settled("planner-after-first-start", plan, answered(1));
    for (const n of [2, 3, 4]) {
      await nexus(`send-start-${n}`, "send", plan, tool("nexus_start", brief(`Build ${n}`)));
      await settled(`planner-after-start-${n}`, plan, answered(n));
    }
    await nexus("threads", "threads");
    await nexus("show-planner", "show", plan);
    const list = JSON.parse((await cli("threads", "--json")).stdout) as { id: string; title: string; parent?: string }[];
    const builder = list.find((t) => t.title === "Build 1")!.id;
    await nexus("show-builder", "show", builder);
    await settled("builder-conversation", builder, answered(1));

    log("== a builder has no drive tools, so it starts no thread of its own");
    await nexus("builder-tries-start", "send", builder, tool("nexus_start", brief("Grandchild")));
    await settled("builder-after-try", builder, answered(2));

    log("== the planner reads its builder and watches it");
    await nexus("send-read", "send", plan, tool("nexus_read", { thread: builder }));
    await settled("planner-after-read", plan, answered(5));
    await nexus("send-wait", "send", plan, tool("nexus_wait", { thread: builder, until: "turn-ended" }));
    await settled("planner-after-wait", plan, answered(6));
    await stop(cp);
    cp = await startControl();
    log("control plane restarted, with the watch pending");
    await nexus("builder-next-turn", "send", builder, "Again.");
    await settled("builder-after-next-turn", builder, answered(3));
    await settled("planner-after-watch", plan, (text) => text.includes("[Nexus watch") && answered(7)(text));
    await stop(cp);
    cp = await startControl();
    log("control plane restarted after the watch's message; waiting two watch passes");
    await sleep(32_000);
    const final = await conversation(plan);
    const watchMessages = (final.match(/^> \[Nexus watch/gm) ?? []).length;
    save("planner-at-the-end", `$ nexus conversation ${plan}\n${final}\n\n${watchMessages} watch message(s)\n`);
    log(`the planner holds ${watchMessages} watch message(s) after the second restart`);
  } finally {
    await Promise.all([...children].map(stop));
    rmSync(runDir, { recursive: true, force: true });
  }
}

await (mode === "probe" ? probe() : mode === "control" ? control(rest[0]!) : drive(resolve(rest[0]!)));
