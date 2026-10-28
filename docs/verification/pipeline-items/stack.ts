/**
 * Lines up two pipeline items on a local stack, the second after the first, and captures what the CLI, the dashboard
 * and the stand-in VM backend saw as the first is built, opens its pull request and merges, and the second starts:
 *
 *   MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/pipeline-items/stack.ts drive <src> <out>
 *
 * `src` is the src directory of the checkout to run, and `out` the folder for the captures. The control plane is the
 * real startControlPlane from that checkout, with its registry, loop, harness, PR watch, review loop, API and dashboard,
 * in a child process, so a restart is a process exit. The node is the real probe server in another child process.
 * Every command goes through the real `nexus` CLI, and every page through headless Chromium. Only the production
 * boundaries are stand-ins: tailscaled's whois, the scripted model, GitHub, and a VM backend that boots nothing. The
 * stand-in guest answers the probe's git read with the branch the driver says the agent pushed, and runs the pi-env
 * daemon from node_modules on this machine for the harness, so a thread's first message gets the scripted answer.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const githubPort = 7499;
const repo = "verify/wave";

async function probe(runDir: string) {
  const { startProbe } = await import(`${src}/probe/server.ts`) as typeof import("../../../src/probe/server.ts");
  const { nodeSecrets } = await import(`${src}/probe/config.ts`) as typeof import("../../../src/probe/config.ts");
  const { processStream } = await import(`${src}/process-stream.ts`) as typeof import("../../../src/process-stream.ts");
  const piEnv = join(src, "../node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64");
  const booted = new Set<PylonId>();
  const guest = (pylonId: PylonId): Guest => ({
    async exec(argv) {
      if (argv[0] !== "python3" || !argv[2]?.includes("GIT_NO_LAZY_FETCH")) return { exitCode: 1, output: "", truncated: false };
      const pushed = join(runDir, "pushed", pylonId);
      const head = "1".repeat(40);
      const branch = existsSync(pushed) ? readFileSync(pushed, "utf8").trim() : null;
      return { exitCode: 0, truncated: false, output: JSON.stringify({ head, branch, dirty: false, branches: branch === null ? [] : [{ name: branch, head, pushedAs: `origin/${branch}` }] }) };
    },
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
    list: async () => [...booted].map((pylonId) => ({ pylonId, vm: "running" as const, checkpoint: null, image, bootedAt: "2026-10-27T00:00:00.000Z" })),
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
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith("https://api.github.com/") ? real(`http://127.0.0.1:${githubPort}${url.slice("https://api.github.com".length)}`, init) : real(input, init);
  };
  const socket = join(runDir, "tailscaled.sock");
  rmSync(socket, { force: true });
  await new Promise<void>((done) => createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: addr === `${node.host}:7480` ? node.id : controlId } }));
  }).listen(socket, done));
  writeFileSync(join(runDir, "github-token"), "verifytoken\n");
  const cp = await startControlPlane({
    db: join(runDir, "registry.db"),
    github: { tokenFile: join(runDir, "github-token") },
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

interface Pr { number: number; branch: string; title: string; state: "open" | "closed"; merged: boolean }

/** The GitHub REST reads the PR watch makes, over a list of pull requests the driver opens, merges and closes. */
function fakeGitHub(log: (line: string) => void) {
  const prs: Pr[] = [];
  const json = (p: Pr) => ({
    number: p.number, title: p.title, html_url: `https://github.com/${repo}/pull/${p.number}`, state: p.state, merged: p.merged, body: "", merge_commit_sha: p.merged ? "2".repeat(40) : null,
    head: { sha: "1".repeat(40), ref: p.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://github");
    log(`${req.method} ${url.pathname}${url.search}`);
    const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const base = `/repos/${repo}`;
    if (url.pathname === `${base}/pulls`) {
      const head = url.searchParams.get("head")?.split(":")[1];
      return reply(200, prs.filter((p) => (url.searchParams.get("state") === "all" || p.state === "open") && p.branch === head).map(json));
    }
    const pr = /^\/repos\/verify\/wave\/pulls\/(\d+)$/.exec(url.pathname);
    if (pr !== null) {
      const found = prs.find((p) => p.number === Number(pr[1]));
      return found === undefined ? reply(404, { message: "Not Found" }) : reply(200, json(found));
    }
    if (url.pathname.endsWith("/check-runs")) return reply(200, { check_runs: [] });
    if (/\/(statuses|reviews|comments)$/.test(url.pathname)) return reply(200, []);
    reply(404, { message: "Not Found" });
  });
  return {
    listen: () => new Promise<void>((done) => server.listen(githubPort, "127.0.0.1", done)),
    close: () => new Promise<void>((done) => server.close(() => done())),
    open(branch: string, title: string) { const p: Pr = { number: prs.length + 1, branch, title, state: "open", merged: false }; prs.push(p); return p.number; },
    merge(n: number) { const p = prs[n - 1]!; p.state = "closed"; p.merged = true; },
    close_(n: number) { prs[n - 1]!.state = "closed"; },
  };
}

async function drive(out: string) {
  const runDir = mkdtempSync(join(tmpdir(), "nexus-pipeline-"));
  mkdirSync(join(runDir, "pushed"));
  mkdirSync(out, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  for (const f of ["timeline.txt", "github.log", "backend.log", "control.log"]) writeFileSync(join(out, f), "");
  const log = (line: string) => { const l = `${stamp()} ${line}`; console.log(l); appendFileSync(join(out, "timeline.txt"), `${l}\n`); };
  const scrub = (text: string) => text.replaceAll(runDir, "<run>");
  const github = fakeGitHub((line) => appendFileSync(join(out, "github.log"), `${stamp()} ${line}\n`));
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
  const startControl = async () => {
    const c = await child("control", ["control", src, runDir]);
    for (;;) { try { if ((await fetch(`${api}/v1/nodes`)).ok) break; } catch {} await sleep(50); }
    log("control plane is up");
    return c;
  };

  let step = 0;
  const run = promisify(execFile);
  /** One CLI call, saved as NN-<name>.txt with the command, stdout, stderr and exit code. */
  async function nexus(name: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    let code = 0, stdout = "", stderr = "";
    try {
      ({ stdout, stderr } = await run(process.execPath, [join(src, "cli/nexus.ts"), ...args], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } }));
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      ({ code, stdout, stderr } = e);
    }
    const file = `${String(++step).padStart(2, "0")}-${name}.txt`;
    writeFileSync(join(out, file), `$ nexus ${args.map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(" ")}\n${stdout}${stderr === "" ? "" : `[stderr] ${stderr}`}[exit ${code}]\n`);
    log(`nexus ${args.join(" ")} -> exit ${code} (${file})`);
    return { code, stdout };
  }
  const idOf = (r: { code: number; stdout: string }) => r.code === 0 ? (JSON.parse(r.stdout) as { id: string }).id : null;
  /** Polls `show --json` without saving it, until `done` holds or the deadline passes. */
  async function until(what: string, id: string | null, done: (d: any) => boolean, ms = 240_000) {
    if (id === null) return log(`skipped: waiting until ${what}, because the thread was never created`);
    const from = Date.now();
    for (;;) {
      try {
        const { stdout } = await run(process.execPath, [join(src, "cli/nexus.ts"), "show", id, "--json"], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } });
        if (done(JSON.parse(stdout))) return log(`${what} after ${((Date.now() - from) / 1000).toFixed(1)} s`);
      } catch {}
      if (Date.now() - from > ms) return log(`gave up after ${ms / 1000} s waiting until ${what}`);
      await sleep(1000);
    }
  }
  const started = (d: any) => d.thread !== undefined;
  const boots = (id: string | null) => id === null ? 0 : readFileSync(join(out, "backend.log"), "utf8").split("\n").filter((l) => l.endsWith(`pylon-${id}`)).length;

  const require = createRequire(join(process.env.MODULES!, "x.js"));
  const chromiumModule = require("@sparticuz/chromium");
  const chromium = chromiumModule.default ?? chromiumModule;
  const puppeteer = require("puppeteer-core");
  const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1360, height: 820 } });
  const page = await browser.newPage();
  async function shot(name: string, path: string) {
    // A thread page keeps its conversation's stream open, so the network never goes idle.
    await page.goto(`${api}${path}`, { waitUntil: "load" });
    await sleep(1500);
    await page.screenshot({ path: join(out, `${name}.png`) });
    const text = await page.evaluate('document.querySelector("main")?.innerText ?? ""') as string;
    writeFileSync(join(out, `${name}.txt`), `GET ${path}\n${text.replace(/\n{3,}/g, "\n\n")}\n`);
    log(`dashboard ${path} -> ${name}.png`);
  }

  /** Polls `item show --json` without saving it, until `done` holds or the deadline passes. */
  async function untilItem(what: string, id: string | null, done: (i: any) => boolean, ms = 240_000) {
    if (id === null) { log(`skipped: waiting until ${what}, because the item was never added`); return null; }
    const from = Date.now();
    for (;;) {
      try {
        const { stdout } = await run(process.execPath, [join(src, "cli/nexus.ts"), "item", "show", id, "--json"], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } });
        const item = JSON.parse(stdout);
        if (done(item)) { log(`${what} after ${((Date.now() - from) / 1000).toFixed(1)} s: ${item.phase.kind}, ${item.phase.why}`); return item; }
      } catch {}
      if (Date.now() - from > ms) { log(`gave up after ${ms / 1000} s waiting until ${what}`); return null; }
      await sleep(1000);
    }
  }
  /** Every distinct phase each item showed, read once a second by the driver, into phases.txt. */
  let watching = true;
  const watcher = (async () => {
    const last = new Map<string, string>();
    while (watching) {
      try {
        const { stdout } = await run(process.execPath, [join(src, "cli/nexus.ts"), "items", "--all", "--json"], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } });
        for (const item of JSON.parse(stdout) as { id: string; title: string; thread: string | null; phase: { kind: string; why: string } }[]) {
          const seen = `${item.phase.kind}: ${item.phase.why} (thread ${item.thread ?? "none"})`;
          if (last.get(item.id) === seen) continue;
          last.set(item.id, seen);
          const line = `${stamp()} ${item.title}: ${seen}`;
          appendFileSync(join(out, "phases.txt"), `${line}\n`);
        }
      } catch {}
      await sleep(1000);
    }
  })();
  writeFileSync(join(out, "phases.txt"), "");

  try {
    const { openRegistry } = await import(`${src}/control/registry.ts`) as typeof import("../../../src/control/registry.ts");
    const seed = openRegistry(join(runDir, "registry.db"));
    seed.saveImage({ id: image, gondolinBuildId: "stand-in", builtOn: node.name, builtAt: new Date().toISOString(), sha256: "0".repeat(64), pins: {} } as unknown as ImageManifest, null);
    seed.setCurrentImage(image);
    seed.close();
    log(`checkout ${src.replace(process.cwd(), "<repo>")}`);
    const probeChild = await child("probe", ["probe", src, runDir]);
    let cp = await startControl();
    await nexus("version", "--version");
    await nexus("project-add", "project", "add", "wave", `git@github.com:${repo}.git`, "--node", node.name, "--cpus", "1", "--memory", "3", "--disk", "5");
    await nexus("project-edit-pipeline", "project", "edit", "wave", "--pipeline", "start");
    await nexus("projects", "projects");
    await shot("01-pipeline-empty", "/pipeline");

    const add = async (name: string, title: string, after: string | null) => idOf(await nexus(`item-add-${name}`, "item", "add", "--project", "wave", "--title", title,
      "--message", `${title}. Commit, push branch feat-${name} and open a pull request.`, ...after === null ? [] : ["--after", after], "--json"));
    const a = await add("a", "A: greet by name", null);
    const b = await add("b", "B: greet in French, after A", a);
    await nexus("items-added", "items");
    await nexus("item-show-b-added", "item", "show", b ?? "it-000000000000");

    const aBuilding = await untilItem("A's thread started", a, (i) => i.phase.kind === "building", 60_000);
    await nexus("items-a-building", "items");
    await nexus("threads-a-building", "threads");
    await shot("02-pipeline-a-building", "/pipeline");
    const ta = aBuilding?.thread as string | undefined;
    if (ta !== undefined) {
      await until("A's first message has its scripted answer", ta, (x) => x.lastReplyAt !== null, 60_000);
      await nexus("conversation-a", "conversation", ta);
      writeFileSync(join(runDir, "pushed", `pylon-${ta}`), "feat-a\n");
      const pr = github.open("feat-a", "A: greet by name");
      log(`A's thread ${ta} pushed feat-a, and PR #${pr} opened`);
    }

    log("== restart: the control plane stops and starts again while B waits for A");
    await stop(cp);
    cp = await startControl();
    await nexus("items-after-restart", "items");

    const aReviewing = await untilItem("A's PR is linked", a, (i) => i.phase.kind === "reviewing");
    await nexus("item-show-a-reviewing", "item", "show", a ?? "it-000000000000");
    await nexus("item-show-b-waiting", "item", "show", b ?? "it-000000000000");
    await shot("03-pipeline-a-reviewing", "/pipeline");
    if (aReviewing !== null) {
      github.merge(1);
      log("PR #1 (A) merged outside any review");
    }
    await untilItem("A landed", a, (i) => i.phase.kind === "landed");
    const bBuilding = await untilItem("B's thread started", b, (i) => i.phase.kind === "building");
    const tb = bBuilding?.thread as string | undefined;
    if (tb !== undefined) {
      await until("B's first message has its scripted answer", tb, (x) => x.lastReplyAt !== null, 60_000);
      await nexus("conversation-b", "conversation", tb);
      await nexus("show-b-thread", "show", tb);
    }
    await nexus("items-end", "items");
    await nexus("items-end-json", "items", "--json");
    await nexus("threads-end", "threads", "--all");
    await shot("04-pipeline-b-building", "/pipeline");
    await shot("05-home-end", "/");
    log(`backend boots: A ${ta === undefined ? 0 : boots(ta)}, B ${tb === undefined ? 0 : boots(tb)}`);
    await stop(cp);
    await stop(probeChild);
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
await (mode === "probe" ? probe(rest[0]!) : mode === "control" ? control(rest[0]!) : drive(resolve(rest[0]!)));
