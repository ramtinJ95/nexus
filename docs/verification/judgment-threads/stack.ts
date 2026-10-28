/**
 * Breaks two builder pylons on a local stack and captures what the CLI, the dashboard and the stand-in VM backend saw
 * as the control plane judged each failure:
 *
 *   MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/judgment-threads/stack.ts drive <src> <out>
 *
 * `src` is the src directory of the checkout to run, and `out` the folder for the captures. The control plane is the
 * real startControlPlane from that checkout, with its registry, loop, harness, pipeline, API and dashboard, in a child
 * process. Each node is the real probe server in a child process of its own, node-a on 127.0.0.1 and node-b on
 * 127.0.0.2. Every command goes through the real `nexus` CLI, and every page through headless Chromium. Only the
 * production boundaries are stand-ins: tailscaled's whois, the scripted model, GitHub, and a VM backend that boots
 * nothing. The backend reports a pylon broken by its controller, with the driver's lines as the controller log's tail,
 * once the driver writes them to `<run>/break/<pylon>`, and a pause of a broken pylon settles it onto a checkpoint as
 * the pylon VM backend does. The scripted model's judgment follows the `judge: <answer>` marker in that log.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { VmBackend, Guest, BackendPylon } from "../../../src/backend.ts";
import type { CheckpointId, ImageId, ImageManifest } from "../../../src/images.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";

const [mode, srcArg, ...rest] = process.argv.slice(2) as [string, string, ...string[]];
const src = resolve(srcArg);
const image = "img-0000000000aa" as ImageId;
const controlId = "nVERIFYCONTROL" as TailnetNodeId;
/** Every caller of the API but the probes is the person's laptop, as the CLI on a Mac is. */
const laptop = "nVERIFYLAPTOP" as TailnetNodeId;
const nodes = [
  { name: "node-a" as NodeName, host: "127.0.0.1", id: "nVERIFYA" as TailnetNodeId },
  { name: "node-b" as NodeName, host: "127.0.0.2", id: "nVERIFYB" as TailnetNodeId },
];
const api = "http://127.0.0.1:7470";
const githubPort = 7499;
const repo = "verify/wave";

async function probe(runDir: string, name: string) {
  const node = nodes.find((n) => n.name === name)!;
  const { startProbe } = await import(`${src}/probe/server.ts`) as typeof import("../../../src/probe/server.ts");
  const { nodeSecrets } = await import(`${src}/probe/config.ts`) as typeof import("../../../src/probe/config.ts");
  const { processStream } = await import(`${src}/process-stream.ts`) as typeof import("../../../src/process-stream.ts");
  const piEnv = join(src, "../node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64");
  const vms = new Map<PylonId, { vm: "running" | "stopped"; checkpoint: CheckpointId | null }>();
  const broken = (pylonId: PylonId) => join(runDir, "break", pylonId);
  const guest = (pylonId: PylonId): Guest => ({
    async exec(argv) {
      if (argv[0] !== "python3" || !argv[2]?.includes("GIT_NO_LAZY_FETCH")) return { exitCode: 1, output: "", truncated: false };
      return { exitCode: 0, truncated: false, output: JSON.stringify({ head: "1".repeat(40), branch: null, dirty: false, branches: [] }) };
    },
    async stream(argv, log) {
      if (!argv[2]?.includes("/usr/local/libexec/nexus/pi-env")) throw new Error(`the stand-in guest of ${pylonId} runs only the pi-env daemon, not ${argv.join(" ")}`);
      return processStream(piEnv, argv.slice(4), log);
    },
    async writeFiles() {},
    services: async () => ({ services: [] }),
    startService: () => Promise.reject(new Error("no services in the stand-in guest")),
    linkPort: () => Promise.reject(new Error("no ports in the stand-in guest")),
    unlinkPort: async () => null,
    previewOrigin: () => { throw new Error("no previews in the stand-in guest"); },
  } as Guest);
  const holds = { cpus: 1, memoryGiB: 1, diskGiB: 5 };
  const backend = {
    async ensureRunning(boot: Parameters<VmBackend["ensureRunning"]>[0]) {
      if (vms.get(boot.pylonId)?.vm !== "running") console.log(`backend: ${node.name} booted ${boot.pylonId} from ${boot.source.kind === "resume" ? `checkpoint ${boot.source.checkpoint}` : boot.source.kind}`);
      vms.set(boot.pylonId, { vm: "running", checkpoint: vms.get(boot.pylonId)?.checkpoint ?? null });
    },
    async ensurePaused(pylonId: PylonId, checkpoint: CheckpointId) {
      const was = existsSync(broken(pylonId)) ? "broken" : vms.get(pylonId)?.vm;
      rmSync(broken(pylonId), { force: true });
      if (was !== "stopped") console.log(`backend: ${node.name} paused ${was} ${pylonId} onto checkpoint ${checkpoint}`);
      vms.set(pylonId, { vm: "stopped", checkpoint });
    },
    async ensureDeleted(pylonId: PylonId) { vms.delete(pylonId); rmSync(broken(pylonId), { force: true }); },
    list: async (): Promise<BackendPylon[]> => [...vms].map(([pylonId, { vm, checkpoint }]) => existsSync(broken(pylonId))
      ? { pylonId, vm: "broken", cause: "controller", detail: "the VM stopped outside a completed pause", logTail: readFileSync(broken(pylonId), "utf8"), checkpoint, image, bootedAt: null, holds }
      : { pylonId, vm, checkpoint, image, bootedAt: vm === "running" ? "2026-10-28T00:00:00.000Z" : null, holds, ...vm === "stopped" ? { sessions: null } : {} }),
    async buildTemplate() {}, async buildImage() {},
    guest,
    artifacts: { list: async () => [image], manifest: async () => null, export: () => Promise.reject(new Error("unused")), async import() {}, async drop() {} },
    async updateSecret() { return []; },
  } as unknown as VmBackend;
  const secrets = nodeSecrets({ value: () => undefined, names: () => [] });
  const p = await startProbe({ node: node.name, host: node.host, port: 7480, auth: { controlPlane: controlId, peers: [] }, whois: async () => controlId, backend, secrets, log: () => {} });
  console.log(`probe ${node.name} listening on ${node.host}:${p.port}`);
  process.once("SIGTERM", () => { void p.close().then(() => process.exit(0)); });
}

async function control(runDir: string) {
  const { startControlPlane } = await import(`${src}/control/main.ts`) as typeof import("../../../src/control/main.ts");
  const { scriptedModel, scriptedModels } = await import(`${src}/harness/test-fixture.ts`) as typeof import("../../../src/harness/test-fixture.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith("https://api.github.com/") ? real(`http://127.0.0.1:${githubPort}${url.slice("https://api.github.com".length)}`, init) : real(input, init);
  };
  const socket = join(runDir, "tailscaled.sock");
  rmSync(socket, { force: true });
  await new Promise<void>((done) => createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
    const node = nodes.find((n) => addr === `${n.host}:7480`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: node?.id ?? laptop } }));
  }).listen(socket, done));
  writeFileSync(join(runDir, "github-token"), "verifytoken\n");
  const cp = await startControlPlane({
    db: join(runDir, "registry.db"),
    github: { tokenFile: join(runDir, "github-token") },
    listen: { host: "127.0.0.1", port: 7470, hostnames: ["127.0.0.1"] },
    self: { tailnetNodeId: controlId },
    nodes: nodes.map((n) => ({ name: n.name, tailnetHost: n.host, tailnetNodeId: n.id })),
    callers: [laptop],
    deployers: [laptop],
    dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    harness: { storage: join(runDir, "harness.sqlite"), credentials: join(runDir, "unused-credentials.json"), model: scriptedModel },
    tailscaledSocket: socket,
    previewPorts: { first: 10200, last: 10299 },
    resumeAfterUsageLimit: false,
  }, scriptedModels());
  console.log("control plane listening");
  process.once("SIGTERM", () => { void cp.close().then(() => process.exit(0)); });
}

/** The GitHub REST reads the PR watch makes, with no pull request anywhere. */
function fakeGitHub(log: (line: string) => void) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://github");
    log(`${req.method} ${url.pathname}${url.search}`);
    const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === `/repos/${repo}/pulls`) return reply(200, []);
    reply(404, { message: "Not Found" });
  });
  return {
    listen: () => new Promise<void>((done) => server.listen(githubPort, "127.0.0.1", done)),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** A controller log as the pylon VM backend reads its tail, ending in the scripted model's marker. */
const controllerLog = (marker: string) => `2026-10-28T09:58:01.204Z controller: booting the VM from checkpoint ck-1
2026-10-28T09:58:03.911Z controller: guest agent connected
2026-10-28T10:02:14.377Z controller: Error: Guest command got no answer within 13000 ms
2026-10-28T10:02:14.380Z controller: qemu exited with signal 9 while the host was out of memory
2026-10-28T10:02:14.381Z controller: stand-in marker for the scripted model: judge: ${marker}
`;

async function drive(out: string) {
  const runDir = mkdtempSync(join(tmpdir(), "nexus-judgment-"));
  mkdirSync(join(runDir, "break"));
  mkdirSync(out, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  for (const f of ["timeline.txt", "backend.log", "control.log", "judgments.txt"]) writeFileSync(join(out, f), "");
  const log = (line: string) => { const l = `${stamp()} ${line}`; console.log(l); appendFileSync(join(out, "timeline.txt"), `${l}\n`); };
  const scrub = (text: string) => text.replaceAll(runDir, "<run>");
  const github = fakeGitHub(() => {});
  await github.listen();

  const children = new Set<ChildProcess>();
  const child = (label: string, args: string[]) => {
    const c = spawn(process.execPath, [here, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(c);
    c.once("exit", () => children.delete(c));
    c.stdout!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) { if (l.startsWith("backend:")) { appendFileSync(join(out, "backend.log"), `${stamp()} ${l}\n`); log(l); } } });
    c.stderr!.on("data", (b: Buffer) => appendFileSync(join(out, "control.log"), `${stamp()} ${label}: ${scrub(b.toString())}`));
    return new Promise<ChildProcess>((ready) => c.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("listening")) ready(c); }));
  };
  const stop = (c: ChildProcess) => new Promise<void>((done) => { c.once("exit", () => done()); c.kill("SIGTERM"); });

  let step = 0;
  const run = promisify(execFile);
  const env = { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" };
  /** One CLI call, saved as NN-<name>.txt with the command, stdout, stderr and exit code. */
  async function nexus(name: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    let code = 0, stdout = "", stderr = "";
    try {
      ({ stdout, stderr } = await run(process.execPath, [join(src, "cli/nexus.ts"), ...args], { env }));
    } catch (err) {
      ({ code, stdout, stderr } = err as { code: number; stdout: string; stderr: string });
    }
    const file = `${String(++step).padStart(2, "0")}-${name}.txt`;
    writeFileSync(join(out, file), `$ nexus ${args.map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(" ")}\n${stdout}${stderr === "" ? "" : `[stderr] ${stderr}`}[exit ${code}]\n`);
    log(`nexus ${args.join(" ")} -> exit ${code} (${file})`);
    return { code, stdout };
  }
  const show = async (id: string): Promise<any> => JSON.parse((await run(process.execPath, [join(src, "cli/nexus.ts"), "show", id, "--json"], { env })).stdout);
  /** Polls `show --json` without saving it, until `done` holds or the deadline passes. */
  async function until(what: string, id: string, done: (d: any) => boolean, ms: number): Promise<boolean> {
    const from = Date.now();
    for (;;) {
      try { if (done(await show(id))) { log(`${what} after ${((Date.now() - from) / 1000).toFixed(1)} s`); return true; } } catch {}
      if (Date.now() - from > ms) { log(`not seen within ${ms / 1000} s: ${what}`); return false; }
      await sleep(500);
    }
  }
  const threads = new Map<string, string>();
  /** Every distinct state of each thread's judgments and pylon, read twice a second, into judgments.txt. */
  const watched = new Map<string, string>();
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      for (const [id, title] of threads) {
        try {
          const d = await show(id);
          const seen = `pylon ${d.pylon.actualState}${d.pylon.failed === null ? "" : ", failed"}, attention ${d.attention ?? "none"}, judgments ${JSON.stringify((d.judgments ?? []).map((j: any) => ({ phase: j.phase, verdict: j.verdict ?? null, outcome: j.outcome ?? null })))}`;
          if (watched.get(id) !== seen) appendFileSync(join(out, "judgments.txt"), `${stamp()} ${title}: ${seen}\n`);
          watched.set(id, seen);
        } catch {}
      }
      await sleep(500);
    }
  })();

  const require = createRequire(join(process.env.MODULES!, "x.js"));
  const chromiumModule = require("@sparticuz/chromium");
  const chromium = chromiumModule.default ?? chromiumModule;
  const puppeteer = require("puppeteer-core");
  const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1360, height: 900 } });
  const page = await browser.newPage();
  page.on("dialog", async (dialog: any) => { log(`the page asked ${JSON.stringify(dialog.message())}, and the driver accepted`); await dialog.accept(); });
  async function shot(name: string, path: string) {
    // A thread page keeps its conversation's stream open, so the network never goes idle.
    await page.goto(`${api}${path}`, { waitUntil: "load" });
    await sleep(1500);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    const text = await page.evaluate('document.querySelector(".dock")?.innerText ?? document.querySelector("main")?.innerText ?? ""') as string;
    writeFileSync(join(out, `${name}.txt`), `GET ${path} (the thread page's dock)\n${text.replace(/\n{3,}/g, "\n\n")}\n`);
    log(`dashboard ${path} -> ${name}.png`);
  }
  const judged = (d: any) => (d.judgments ?? []).some((j: any) => j.phase === "done");
  const asked = (d: any) => (d.judgments ?? []).some((j: any) => j.phase === "asked");
  const running = (d: any) => d.pylon.actualState === "running" && d.pylon.failed === null;
  const boots = (id: string) => readFileSync(join(out, "backend.log"), "utf8").split("\n").filter((l) => l.includes(`booted pylon-${id} `)).length;

  try {
    const { openRegistry } = await import(`${src}/control/registry.ts`) as typeof import("../../../src/control/registry.ts");
    const seed = openRegistry(join(runDir, "registry.db"));
    seed.saveImage({ id: image, gondolinBuildId: "stand-in", builtOn: nodes[0]!.name, builtAt: new Date().toISOString(), sha256: "0".repeat(64), pins: {} } as unknown as ImageManifest, null);
    seed.setCurrentImage(image);
    seed.close();
    log(`checkout ${src.replace(process.cwd(), "<repo>")}`);
    const probes = [await child("probe-a", ["probe", src, runDir, "node-a"]), await child("probe-b", ["probe", src, runDir, "node-b"])];
    const cp = await child("control", ["control", src, runDir]);
    for (;;) { try { if ((await fetch(`${api}/v1/nodes`)).ok) break; } catch {} await sleep(50); }
    log("control plane is up");
    await nexus("version", "--version");
    await nexus("project-add", "project", "add", "wave", `git@github.com:${repo}.git`, "--node", "node-a", "--cpus", "1", "--memory", "1", "--disk", "5");
    await nexus("project-edit-pipeline", "project", "edit", "wave", "--pipeline", "start");
    await nexus("projects", "projects");

    const startBroken = async (key: string, title: string, marker: string): Promise<string | null> => {
      const started = await nexus(`start-${key}`, "start", "--project", "wave", "--title", title, "--node", "node-a", "--json");
      if (started.code !== 0) return null;
      const id = (JSON.parse(started.stdout) as { id: string }).id;
      threads.set(id, title);
      await until(`${title}: its pylon runs`, id, running, 60_000);
      writeFileSync(join(runDir, "break", `pylon-${id}`), controllerLog(marker));
      log(`${title}: the backend now reports pylon-${id} broken by its controller, its log ending in "judge: ${marker}"`);
      await until(`${title}: its pylon failed`, id, (d) => d.pylon.failed !== null, 60_000);
      return id;
    };

    const a = await startBroken("a", "A: controller crash the judgment retries", "retry");
    if (a !== null) {
      const done = await until("A: its judgment is done", a, judged, 60_000);
      await nexus("show-a-judged", "show", a);
      await until("A: its pylon runs again", a, running, done ? 60_000 : 1_000);
      await nexus("show-a-end", "show", a);
      await nexus("show-a-json", "show", a, "--json");
      await shot("01-thread-a", `/threads/${a}`);
      log(`A: the backend booted its pylon ${boots(a)} times`);
    }

    const b = await startBroken("b", "B: controller crash with a malformed judgment", "malformed");
    if (b !== null) {
      const card = await until("B: its judgment asks the person", b, asked, 60_000);
      await nexus("show-b-asked", "show", b);
      await shot("02-thread-b-card", `/threads/${b}`);
      if (card) {
        await page.goto(`${api}/threads/${b}`, { waitUntil: "load" });
        await sleep(1000);
        const clicked = await page.evaluate(`(() => {
          const button = [...document.querySelectorAll("#questions button[data-action=answer]")].find((el) => el.textContent.trim() === "Retry");
          button?.click();
          return button !== undefined;
        })()`) as boolean;
        log(clicked ? "B: the driver pressed Retry on the question card" : "B: the question card has no Retry button");
        await until("B: its judgment is done", b, judged, 60_000);
        await until("B: its pylon runs again", b, running, 60_000);
      }
      await nexus("show-b-end", "show", b);
      await nexus("show-b-json", "show", b, "--json");
      await shot("03-thread-b-answered", `/threads/${b}`);
      log(`B: the backend booted its pylon ${boots(b)} times`);
    }

    await nexus("threads-end", "threads", "--all");
    await shot("04-home-end", "/");
    await stop(cp);
    for (const p of probes) await stop(p);
  } finally {
    watching = false;
    await watcher;
    await browser.close();
    await Promise.all([...children].map(stop));
    await github.close();
    rmSync(runDir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((w) => setTimeout(w, ms));
await (mode === "probe" ? probe(rest[0]!, rest[1]!) : mode === "control" ? control(rest[0]!) : drive(resolve(rest[0]!)));
