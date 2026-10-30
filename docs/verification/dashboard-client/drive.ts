// Runs the real registry, API and dashboard of the checkout it is in, and drives them in headless Chromium: two tabs
// of a page with no Web Locks, as over plain HTTP, the conversation's notes beside a review card, the terminal tab
// under a stream of output, and the changes pane of a thread whose checkout cannot be read. Writes what it saw to
// <out-dir>/result.json and screenshots beside it.
// Run from the root of a checkout: MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/dashboard-client/drive.ts <out-dir>
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2]!;
const require = createRequire(join(process.env.MODULES!, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");

const { startApi } = await import("../../../src/control/api.ts");
const { fakeHarness } = await import("../../../src/control/fake-harness.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { threadStarter } = await import("../../../src/control/threads.ts");
const { transcriptStart } = await import("../../../src/claude-transcript.ts");
type Thread = import("../../../src/control/registry.ts").Thread;
type NodeName = import("../../../src/protocol.ts").NodeName;
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;

const node = "verify-node" as NodeName;
const laptop = "nVERIFY" as TailnetNodeId;
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-client-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
const fake = fakeHarness();
const startThread = threadStarter({ registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("no remote")) } });
const api = await startApi({
  registry, host: "127.0.0.1", port: 0,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  deployment: { self: "nCONTROL" as TailnetNodeId, deployers: new Set(), keys: {} },
  harness: fake.harness, startThread, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});
const base = `http://127.0.0.1:${api.port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
};
registry.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-30T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never, null);
registry.setCurrentImage("img-0000000000aa" as never);
registry.createProject({ id: "nexus", repoUrl: "git@example.com:nexus.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null } as never);
const start = (title: string, claude?: string): Promise<Thread> => call("POST", "/v1/threads", { project: "nexus", title, ...(claude === undefined ? {} : { claude }) });

const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 800 } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const result: Record<string, unknown> = {};

// Headless Chromium counts 127.0.0.1 as a secure context, so the page loses Web Locks as it would over plain HTTP.
// Whether a tab is shown is set in the page, because headless Chromium shows every tab.
async function plainTab(name: string, path: string, hidden: boolean) {
  const page = await browser.newPage();
  const seen = { reads: 0, streams: 0 };
  page.on("request", (r: { method(): string; url(): string }) => {
    const url = new URL(r.url());
    if (r.method() === "GET" && url.pathname === "/v1/threads" && url.searchParams.get("deleted") === "false") seen.reads += 1;
    if (url.pathname === "/v1/events") seen.streams += 1;
  });
  await page.evaluateOnNewDocument((startHidden: boolean) => {
    Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined });
    let hidden = startHidden;
    Object.defineProperty(Document.prototype, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
    Object.defineProperty(Document.prototype, "hidden", { get: () => hidden });
    const w = window as unknown as { setShown(shown: boolean): void; openStreams(): number; EventSource: typeof EventSource };
    w.setShown = (shown) => { hidden = !shown; document.dispatchEvent(new Event("visibilitychange")); };
    const streams: EventSource[] = [];
    const Stream = w.EventSource;
    w.EventSource = class extends Stream {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        if (String(url).startsWith("/v1/events")) streams.push(this);
      }
    };
    w.openStreams = () => streams.filter((s) => s.readyState !== Stream.CLOSED).length;
  }, hidden);
  await page.goto(`${base}${path}`);
  await page.waitForSelector("main");
  const open = (): Promise<number> => page.evaluate(() => (window as unknown as { openStreams(): number }).openStreams());
  const show = (shown: boolean) => page.evaluate((s: boolean) => (window as unknown as { setShown(s: boolean): void }).setShown(s), shown);
  return { name, page, seen, open, show };
}

for (let i = 0; i < 3; i += 1) await start(`Open thread ${i}`);
const shown = await plainTab("visible home", "/", false);
const hidden = await plainTab("hidden home", "/", true);
const before = { visible: { ...shown.seen }, hidden: { ...hidden.seen } };
await sleep(30_000);
result.rows = {
  windowMs: 30_000,
  listReadsIn30s: { visible: shown.seen.reads - before.visible.reads, hidden: hidden.seen.reads - before.hidden.reads },
  openEventStreams: { visible: await shown.open(), hidden: await hidden.open() },
};
await shown.show(false);
await sleep(200);
const whileHidden = await shown.open();
await shown.show(true);
await sleep(500);
(result.rows as Record<string, unknown>).visibleTabStreams = { hidden: whileHidden, shownAgain: await shown.open() };
await shown.page.close();
await hidden.page.close();

const claude = await start("Notes", "Count the lines");
registry.setClaudeWorker(claude.id, "Count the lines", "started", undefined, "s1");
registry.appendClaudeRead(claude.id, {
  session: "s1", from: transcriptStart, cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: Date.now(), entries: [
    { kind: "prompt", at: 1, text: "Count the lines of hello.py", from: "person" },
    { kind: "reply", at: 2, text: "It has one line." },
    { kind: "turn", at: 3, durationMs: 63_000 },
    { kind: "pull-request", at: 4, number: 7, url: "https://github.com/acme/shop/pull/7", repository: "acme/shop" },
  ],
});
const notes = await browser.newPage();
await notes.goto(`${base}/threads/${claude.id}`);
await notes.waitForSelector("#convo p.note");
result.notes = await notes.evaluate(() => [...document.querySelectorAll("#convo p.note")].map((p) => {
  const s = getComputedStyle(p);
  return { text: p.textContent, color: s.color, quietColor: getComputedStyle(document.documentElement).getPropertyValue("--text-3").trim(), display: s.display, borderLeft: s.borderLeftWidth, padding: s.padding, boxShadow: s.boxShadow };
}));
await (await notes.$("#convo"))!.screenshot({ path: join(out, "notes.png") });
await notes.close();

const term = await browser.newPage();
await term.evaluateOnNewDocument(() => {
  const w = window as unknown as { copies: number; flood(lines: number): Promise<void>; WebSocket: unknown };
  w.copies = 0;
  const replace = CSSStyleSheet.prototype.replaceSync;
  CSSStyleSheet.prototype.replaceSync = function (text: string) { w.copies += 1; return replace.call(this, text); };
  let socket: EventTarget & { readyState: number };
  w.WebSocket = class extends EventTarget {
    readyState = 1;
    binaryType = "arraybuffer";
    constructor() {
      super();
      socket = this;
      setTimeout(() => {
        this.dispatchEvent(new Event("open"));
        this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "attached" }) }));
      });
    }
    send() {}
    close() {}
  };
  w.flood = async (lines) => {
    for (let i = 0; i < lines; i += 1) {
      socket.dispatchEvent(Object.assign(new Event("message"), { data: new TextEncoder().encode(`line ${i} of the log\r\n`).buffer }));
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
});
const plain = await start("Terminal");
await term.goto(`${base}/threads/${plain.id}#terminal`);
await term.waitForSelector(".xterm-screen", { timeout: 15_000 });
await sleep(1000);
const opened = await term.evaluate(() => (window as unknown as { copies: number }).copies);
await term.evaluate(() => (window as unknown as { flood(n: number): Promise<void> }).flood(200));
await sleep(500);
const flooded = await term.evaluate(() => (window as unknown as { copies: number }).copies);
result.terminal = { styleElements: await term.evaluate(() => document.querySelectorAll(".xterm-screen > style").length), copiesAtOpen: opened, copiesFor200FramesOfOutput: flooded - opened };
await term.screenshot({ path: join(out, "terminal.png") });
await term.close();

const archived = await start("Archived");
await call("POST", `/v1/threads/${archived.id}/archive`);
const deleted = await start("Deleted");
await call("DELETE", `/v1/threads/${deleted.id}`);
const pane: Record<string, string> = {};
for (const [name, thread] of [["idle", plain], ["archived", archived], ["deleted", deleted]] as const) {
  const page = await browser.newPage();
  await page.goto(`${base}/threads/${thread.id}`);
  await page.waitForSelector("main");
  await page.evaluate(() => (document.querySelector('label.seg-tab:has(input[value="changes"])') as HTMLElement | null)?.click());
  await sleep(300);
  pane[name] = await page.evaluate(() => document.getElementById("changes-body")?.innerText.replace(/\s+/g, " ").trim() ?? "no changes pane");
  await page.close();
}
result.changesPane = pane;

await writeFile(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
await api.close();
process.exit(0);
