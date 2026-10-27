// Captures how a checkout of Nexus shows a Claude worker thread whose turn runs: what the real `nexus threads` and
// `nexus show` print, the thread page and its data-turn, how often the thread page reads the checkout's changes
// during the turn, and which reply notifications the home page raises while a follow-up turn runs.
//
// The control plane is the checkout's own registry, API and dashboard on 127.0.0.1:7471, with the test fake for the
// model harness. The probe's event stream is the replaced boundary: a session event is handed to
// registry.reportSession, as src/control/loop.ts does with the probe's session events. Nothing reaches a pylon or the
// live control plane. run.sh runs this once against main and once against the branch.
//
//   node capture.ts <checkout> <out dir> <label>
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const [root, out, label] = process.argv.slice(2) as [string, string, string];
const deps = process.env.BROWSER_DEPS!;
const chromium = process.env.CHROMIUM!;
mkdirSync(out, { recursive: true });
const lines: string[] = [];
const log = (line: string) => {
  console.log(line);
  lines.push(line);
};

const { startApi } = await import(join(root, "src/control/api.ts"));
const { fakeHarness } = await import(join(root, "src/control/fake-harness.ts"));
const { threadStarter } = await import(join(root, "src/control/threads.ts"));
const { openRegistry } = await import(join(root, "src/control/registry.ts"));
const { transcriptStart } = await import(join(root, "src/claude-transcript.ts"));

type Thread = { id: string; pylonId: string };
const node = "verify-node";
const laptop = "nVERIFY";
const port = 7471;
const base = `http://127.0.0.1:${port}`;
let back = 0;
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-working-")), "registry.db"), () => Date.now() - back);
const startedAgo = <T>(ms: number, act: () => T): T => {
  back = ms;
  try { return act(); } finally { back = 0; }
};
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" });
const harness = fakeHarness().harness;
const dotfiles = { repo: "git@example.com:dotfiles.git", ref: "main" };
const api = await startApi({
  registry, host: "127.0.0.1", port,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles, harness, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
  startThread: threadStarter({ registry, harness, dotfiles, wake: () => {}, mirror: { setupInputs: () => Promise.reject(new Error("the capture reads no remote")) } }),
});
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
await call("POST", "/v1/projects", {
  id: "nexus", repoUrl: "git@example.com:nexus.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
await call("POST", "/v1/images", image);
registry.setCurrentImage(image.id);

const prompt = "Find why src/control/stream.check.ts fails one run in ten and fix it";
const docs: Thread = await call("POST", "/v1/threads", { project: "nexus", title: "Write the CLI usage docs" });
const pi: Thread = await call("POST", "/v1/threads", { project: "nexus", title: "Refactor the reconcile loop" });
const claude: Thread = await call("POST", "/v1/threads", { project: "nexus", title: "Fix the flaky stream test", claude: prompt });
registry.setClaudeWorker(claude.id, `/poteto-mode ${prompt}`, "started", undefined, "s1");
registry.appendClaudeRead(claude.id, {
  session: "s1", from: transcriptStart, cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: Date.now(),
  entries: [
    { kind: "prompt", at: Date.now() - 95_000, text: `/poteto-mode ${prompt}`, from: "person" },
    { kind: "reply", at: 1, text: "Reproducing it first." },
    { kind: "tool", at: 2, id: "c1", name: "Bash", input: { command: "for i in $(seq 20); do node src/control/stream.check.ts || echo FAIL; done" } },
  ],
});
startedAgo(63_000, () => registry.recordActivity(pi.id, { agent: Date.now() - 63_000, agentTurnRunning: true }));
let sequence = 0;
const report = (kind: "session.turn-started" | "session.heartbeat" | "session.turn-ended") =>
  registry.reportSession(node, { sequence: ++sequence, pylon: claude.pylonId, time: Date.now(), event: { kind, session: "s1" } });
startedAgo(95_000, () => report("session.turn-started"));
const observe = () => {
  registry.apply({ record: "node", node, state: "online", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 } });
  const pylons = [docs, pi, claude].map((t) => ({
    pylonId: t.pylonId, phase: "running", liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [], jobs: [], pylons, previewRoutes: [] }, []);
};
observe();
const observing = setInterval(observe, 1000);
log(`${label}: Claude thread ${claude.id}, harness thread ${pi.id}, idle thread ${docs.id}`);

const home = mkdtempSync(join(tmpdir(), "nexus-working-home-"));
const nexus = async (args: string[]) => {
  const { stdout } = await promisify(execFile)("node", [join(root, "src/cli/nexus.ts"), ...args], { env: { PATH: process.env.PATH!, HOME: home, NEXUS_URL: base, NEXUS_SOCKS: "none" } });
  return stdout;
};
const threads = await nexus(["threads"]);
const show = await nexus(["show", claude.id]);
writeFileSync(join(out, "threads.txt"), `$ nexus threads\n${threads}`);
writeFileSync(join(out, "show.txt"), `$ nexus show ${claude.id}\n${show}`);
const row = threads.split("\n").find((l) => l.startsWith(claude.id))!;
log(`nexus threads, the Claude thread's row: ${row.replace(/ {2,}/g, " | ")}`);
log(`nexus show, its status line: ${show.split("\n").find((l) => l.startsWith("status:"))}`);
const json = await call("GET", `/v1/threads/${claude.id}`);
const { agentTurnRunning, sessionTurnRunning, working, workingSince } = json.thread;
log(`show --json thread: ${JSON.stringify({ agentTurnRunning, sessionTurnRunning, working, workingSince: workingSince === undefined ? undefined : "set" })}`);

const require = createRequire(join(deps, "node_modules", "x.js"));
const { chromium: playwright } = require("playwright-core");
const browser = await playwright.launch({ executablePath: chromium, args: ["--no-sandbox", "--headless=new", "--font-render-hinting=none"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme: "light" });

const xterm = readFileSync(require.resolve("@xterm/xterm/lib/xterm.js"), "utf8");
const xtermCss = readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8");
async function terminal(file: string, text: string) {
  const page = await context.newPage();
  const body = text.replace(/\n$/, "").split("\n");
  await page.setContent(`<!doctype html><style>${xtermCss} body{margin:0;background:#1e1e1e;font:13px "DejaVu Sans";color:#ddd}
    header{padding:8px 14px;background:#2d2d2d;border-bottom:1px solid #444}#t{padding:10px 14px}</style>
    <header>${label}</header><div id="t"></div><script>${xterm}</script>`);
  await page.evaluate(([rows, lines]: [number, string[]]) => new Promise<void>((done) => {
    const term = new (window as any).Terminal({ cols: 132, rows, fontFamily: "DejaVu Sans Mono", fontSize: 13, theme: { background: "#1e1e1e" } });
    term.open(document.getElementById("t"));
    term.write(lines.map((l, i) => i === 0 ? `\x1b[32m${l}\x1b[0m` : l).join("\r\n"), done);
  }), [body.length + 1, body] as [number, string[]]);
  await page.locator("body").screenshot({ path: join(out, file) });
  await page.close();
}
await terminal("threads.png", `$ nexus threads\n${threads}`);
await terminal("show.png", `$ nexus show ${claude.id}\n${show}`);

const thread = await context.newPage();
let reads = 0;
thread.on("request", (r: { url(): string }) => { if (r.url().includes(`/v1/threads/${claude.id}/changes`)) reads++; });
await thread.goto(`${base}/threads/${claude.id}`);
await thread.waitForSelector("#run .run-bar.working");
const facts = await thread.locator("#facts span").evaluate((span: Element) => span.outerHTML);
writeFileSync(join(out, "thread-facts.html"), `${facts}\n`);
log(`thread page while the turn runs: ${facts}`);
await thread.screenshot({ path: join(out, "thread-page.png") });
const before = reads;
for (let i = 0; i < 6; i++) {
  await sleep(2_500);
  report("session.heartbeat");
}
const during = reads - before;
report("session.turn-ended");
await sleep(7_000);
log(`changes reads by the thread page: ${during} during 15 s of the turn's heartbeats, ${reads - before - during} in the 7 s after the turn ends`);
await thread.close();

const page = await context.newPage();
const toasts = () => page.locator(".attention-toast span").allTextContents();
const polled = (test: (row: Record<string, unknown>) => boolean) => page.waitForResponse(async (res: { url(): string; json(): Promise<Record<string, unknown>[]> }) =>
  res.url().endsWith("/v1/threads") && (await res.json()).some((r) => r.id === claude.id && test(r)), { timeout: 15_000 });
report("session.turn-started");
await page.goto(`${base}/`);
await polled((r) => r.sessionTurnRunning === true);
await sleep(2_000);
log(`home page has focus: ${await page.evaluate(() => document.hasFocus())}`);
report("session.turn-ended");
await polled((r) => r.attention === "reply");
report("session.turn-started");
await polled((r) => r.sessionTurnRunning === true);
await sleep(3_000);
log(`toasts 3 s after a follow-up turn starts, while it runs: ${JSON.stringify(await toasts())}`);
await page.screenshot({ path: join(out, "notification-during-turn.png") });
report("session.turn-ended");
await polled((r) => r.sessionTurnRunning === undefined);
await sleep(3_000);
log(`toasts 3 s after that turn ends: ${JSON.stringify(await toasts())}`);
await page.screenshot({ path: join(out, "notification-after-turn.png") });

writeFileSync(join(out, "capture.log"), `${lines.join("\n")}\n`);
await browser.close();
clearInterval(observing);
await api.close();
registry.close();
