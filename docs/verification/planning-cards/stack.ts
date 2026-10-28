/**
 * Opens a planning thread on a local stack, has its scripted model propose two items from the roadmap's orchestration
 * wave, accepts one card and rejects the other on the dashboard, and captures what the CLI, the dashboard and the
 * stand-in VM backend saw:
 *
 *   MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/planning-cards/stack.ts drive <src> <out>
 *
 * `src` is the src directory of the checkout to run, and `out` the folder for the captures. The control plane is the
 * real startControlPlane from that checkout, with its registry, loop, harness, PR watch, review loop, queue, pipeline,
 * API and dashboard, in a child process, so a restart is a process exit. The node is the real probe server in another
 * child process. Every command goes through the real `nexus` CLI, and every page through headless Chromium. Only the
 * production boundaries are stand-ins: tailscaled's whois, the scripted model, GitHub, and a VM backend that boots
 * nothing. The scripted model answers a message that asks for a plan with a nexus-plan block that echoes the token
 * the message holds, or "none" when it holds none, and any other message as the repository's scripted model does.
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
/** Every caller of the API but the probe is the person's laptop, as the CLI on a Mac is. */
const laptop = "nVERIFYLAPTOP" as TailnetNodeId;
const node = { name: "node-a" as NodeName, host: "127.0.0.1", id: "nVERIFYA" as TailnetNodeId };
const api = "http://127.0.0.1:7470";
const githubPort = 7499;
const repo = "verify/wave";
/** What the person asks the planning thread, which is what makes the scripted model answer with a plan. */
const ask = "Plan the next two items of the roadmap's orchestration wave: wake-ups from the event stream, and asking the person through the attention status.";

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
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: addr === `${node.host}:7480` ? node.id : laptop } }));
  }).listen(socket, done));
  writeFileSync(join(runDir, "github-token"), "verifytoken\n");
  const { AssistantMessageEventStream } = await import(`${src}/../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`) as typeof import("@earendil-works/pi-ai/utils/event-stream");
  const scripted = scriptedModels();
  const text = (m: { content: unknown }) => typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).flatMap((c) => c.type === "text" ? [c.text!] : []).join("");
  const models = Object.assign(scripted, {
    streamSimple(model: unknown, input: { messages: { role: string; content: unknown }[] }, ...rest: unknown[]) {
      const last = input.messages.at(-1)!;
      if (last.role !== "user" || !text(last).includes(ask)) return (scripted.streamSimple as Function)(model, input, ...rest);
      const token = /"token": "([^"]+)"/.exec(text(last))?.[1] ?? "none";
      const plan = { token, items: [
        { key: "wake", title: "Wake the passes from the event stream", brief: "Make the review loop, the queue and the pipeline pass run as soon as the registry appends an event that matters to them (thread.turn-ended, thread.failed, review.changed, release.changed), not only on their 15-second timers. Keep the timers as the fallback, so a missed event costs at most one pass. Add a registry test that an appended event runs the pass at once.", after: [] },
        { key: "ask", title: "Ask the person through the attention status", brief: "When a pipeline item reaches a call the merge policy reserves for the person, such as an image rebuild or a secret, ask a question on its thread instead of stalling the pipeline, and act on the answer on the next pass. Hold only that item.", after: ["wake"] },
      ] };
      const message = {
        role: "assistant", api: "nexus-scripted", provider: "nexus-fixture", model: "scripted", timestamp: Date.now(), stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "text", text: `Two items from the wave, the second after the first.\n\n\`\`\`nexus-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`` }],
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message } as never);
      return stream;
    },
  });
  const cp = await startControlPlane({
    db: join(runDir, "registry.db"),
    github: { tokenFile: join(runDir, "github-token") },
    listen: { host: "127.0.0.1", port: 7470, hostnames: ["127.0.0.1"] },
    self: { tailnetNodeId: controlId },
    nodes: [{ name: node.name, tailnetHost: node.host, tailnetNodeId: node.id }],
    callers: [laptop],
    dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    harness: { storage: join(runDir, "harness.sqlite"), credentials: join(runDir, "unused-credentials.json"), model: scriptedModel },
    tailscaledSocket: socket,
    previewPorts: { first: 10200, last: 10299 },
    resumeAfterUsageLimit: false,
  }, models as never);
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

    const planned = await nexus("start-plan", "start", "--project", "wave", "--plan", "--title", "Plan the orchestration wave", "--message", ask, "--json");
    // Main has no --plan, so its run starts the same thread without it, to show what main does with the same reply.
    const plain = planned.code === 0 ? null : await nexus("start-plain", "start", "--project", "wave", "--title", "Plan the orchestration wave", "--message", ask, "--json");
    const tp = idOf(planned) ?? idOf(plain!);
    await until("the planning thread's first message has its scripted answer", tp, (d) => d.lastReplyAt !== null, 60_000);
    await nexus("conversation-plan", "conversation", tp ?? "th-000000000000");
    await until("the plan's two cards are asked", tp, (d) => (d.questions ?? []).length === 2, 45_000);
    await nexus("show-plan-cards", "show", tp ?? "th-000000000000");
    await nexus("items-before-answers", "items", "--all");
    await nexus("threads-before-answers", "threads", "--all");

    log("== restart: the control plane stops and starts again, and reads the planning thread's replies afresh");
    await stop(cp);
    cp = await startControl();
    await sleep(3000);
    await nexus("show-plan-after-restart", "show", tp ?? "th-000000000000", "--json");

    page.on("dialog", async (dialog: { message(): string; accept(): Promise<void> }) => { log(`the page asked: ${JSON.stringify(dialog.message())}, and the driver accepted`); await dialog.accept(); });
    await shot("01-plan-cards", `/threads/${tp}`);
    await page.screenshot({ path: join(out, "01-plan-cards-full.png"), fullPage: true });
    const questions = tp === null ? [] : (JSON.parse((await run(process.execPath, [join(src, "cli/nexus.ts"), "show", tp, "--json"], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } })).stdout).questions ?? []) as { id: string }[];
    /** Presses the option's button on the dashboard, as the person does, and waits until the card reads as answered. */
    async function press(question: string | undefined, option: string, name: string) {
      if (question === undefined) return log(`skipped: pressing ${option}, because there is no card`);
      const button = await page.$(`button[data-action="answer"][data-question="${question}"][data-option="${option}"]:not([disabled])`);
      if (button === null) return log(`no enabled ${option} button for ${question}`);
      await button.click();
      for (const deadline = Date.now() + 8_000; Date.now() < deadline;) {
        const answered = await page.evaluate(`document.querySelector('section[data-question="${question}"]')?.classList.contains("answered") ?? false`);
        if (answered) break;
        await sleep(250);
      }
      await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
      log(`pressed ${option} on ${question} -> ${name}.png`);
    }
    await press(questions[0]?.id, "accept", "02-accepted-first");
    await press(questions[1]?.id, "reject", "03-rejected-second");
    await nexus("show-plan-answered", "show", tp ?? "th-000000000000");

    const accepted = await (async () => {
      for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(1000)) {
        const { stdout } = await run(process.execPath, [join(src, "cli/nexus.ts"), "items", "--all", "--json"], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } }).catch(() => ({ stdout: "[]" }));
        const items = JSON.parse(stdout) as { id: string; thread: string | null }[];
        if (items[0]?.thread != null) return items[0];
      }
      log("gave up after 60 s waiting for an item with a thread");
      return null;
    })();
    await nexus("items-after-answers", "items", "--all");
    if (accepted !== null) {
      await nexus("item-show-accepted", "item", "show", accepted.id);
      await until("the accepted item's builder has its scripted answer", accepted.thread, (d) => d.lastReplyAt !== null, 60_000);
      await nexus("conversation-builder", "conversation", accepted.thread!);
    }
    await nexus("threads-after-answers", "threads", "--all");
    await shot("04-pipeline", "/pipeline");

    const replied = tp === null ? null : (JSON.parse((await run(process.execPath, [join(src, "cli/nexus.ts"), "show", tp, "--json"], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" } })).stdout).lastReplyAt as number);
    await nexus("send-plan", "send", tp ?? "th-000000000000", "Hold the second one until the first has landed.");
    await until("the planning thread answered the person's next message", tp, (d) => d.lastReplyAt > (replied ?? 0), 30_000);
    await nexus("conversation-plan-after", "conversation", tp ?? "th-000000000000");
    await shot("05-home-end", "/");
    log(`backend boots: ${readFileSync(join(out, "backend.log"), "utf8").trim().split("\n").filter((l) => l !== "").length}`);
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
