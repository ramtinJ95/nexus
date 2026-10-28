// Runs the real registry, API and dashboard, opens four dashboard tabs in headless Chromium, counts the work the tabs
// make the control plane do while idle and while threads need the person, and records what each tab showed: its
// system notifications and toasts, its title, and what it marked seen.
// Run from the root of a checkout: MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/dashboard-polling/measure.ts <out-dir>
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

const out = process.argv[2]!;
const require = createRequire(join(process.env.MODULES!, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");

const inspector = new Session();
inspector.connect();
await inspector.post("Profiler.enable");
await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

// Setup also counts the takeover and the seen checks after the two measured phases.
type Phase = "setup" | "idle" | "attention";
let phase: Phase = "setup";
const zero = () => ({ sqlReads: 0, sqlWrites: 0, calls: {} as Record<string, number>, requests: {} as Record<string, number> });
const counts: Record<Phase, ReturnType<typeof zero>> = { setup: zero(), idle: zero(), attention: zero() };
for (const method of ["all", "get", "run", "iterate"] as const) {
  const original = StatementSync.prototype[method] as (...args: never[]) => unknown;
  (StatementSync.prototype[method] as unknown) = function (this: StatementSync, ...args: never[]) {
    counts[phase][/^\s*(SELECT|WITH)/i.test(this.sourceSQL) ? "sqlReads" : "sqlWrites"] += 1;
    return original.apply(this, args);
  };
}
const counted: Record<string, readonly string[]> = {
  "/src/control/api.ts": ["row", "detail", "followEvents"],
  "/src/control/registry.ts": ["markSeen", "updateAttention", "eventBatch", "withSessions"],
  "/src/control/dashboard.ts": ["sidebar", "home", "threadPage", "memoryLine"],
};
async function takeCalls(into: Phase) {
  const { result } = await inspector.post("Profiler.takePreciseCoverage");
  for (const script of result) {
    const names = Object.entries(counted).find(([file]) => script.url.endsWith(file))?.[1];
    if (names === undefined) continue;
    for (const f of script.functions) {
      if (!names.includes(f.functionName)) continue;
      counts[into].calls[f.functionName] = (counts[into].calls[f.functionName] ?? 0) + f.ranges[0]!.count;
    }
  }
}

const { startApi } = await import("../../../src/control/api.ts");
const { fakeHarness } = await import("../../../src/control/fake-harness.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { threadStarter } = await import("../../../src/control/threads.ts");
type Thread = import("../../../src/control/registry.ts").Thread;
type ThreadId = import("../../../src/control/registry.ts").ThreadId;
type NodeName = import("../../../src/protocol.ts").NodeName;
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;

const node = "verify-node" as NodeName;
const laptop = "nVERIFY" as TailnetNodeId;
const file = join(mkdtempSync(join(tmpdir(), "nexus-polling-")), "registry.db");
const registry = openRegistry(file);
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
const fake = fakeHarness();
const dotfiles = { repo: "git@example.com:dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness: fake.harness, wake: () => {}, dotfiles, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } });
const api = await startApi({
  registry, host: "127.0.0.1", port: 0,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  harness: fake.harness, startThread, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});
const base = `http://127.0.0.1:${api.port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
};

registry.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-27T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never, null);
registry.setCurrentImage("img-0000000000aa" as never);
for (const id of ["nexus", "spoon"]) {
  registry.createProject({ id, repoUrl: `git@example.com:${id}.git`, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null } as never);
}
const start = (project: string, title: string, claude?: string): Promise<Thread> => call("POST", "/v1/threads", { project, title, ...(claude === undefined ? {} : { claude }) });

const focus = await start("nexus", "Focused thread");
// Its page says when it started, which the client ticks. Three hours back, that text holds still through the run.
new DatabaseSync(file).prepare("UPDATE threads SET created_at = created_at - 3 * 3600 * 1000 WHERE id = ?").run(focus.id);
fake.transcript(focus.id).messages.push({ role: "user", content: "Say hello.", timestamp: Date.now() });
fake.commit(focus.id);
registry.recordReply(focus.id, Date.now());
const replies = await start("nexus", "Replies thread");
const waits = await start("spoon", "Waits thread", "Ask before you push");
registry.setClaudeWorker(waits.id, "Ask before you push", "started", undefined, "s1");
const hiddenThread = await start("spoon", "Hidden tab's thread");
for (let i = 0; i < 6; i += 1) await start(i % 2 ? "nexus" : "spoon", `Open thread ${i}`);
for (let i = 0; i < 4; i += 1) await call("POST", `/v1/threads/${(await start("nexus", `Archived thread ${i}`)).id}/archive`);
for (let i = 0; i < 30; i += 1) await call("DELETE", `/v1/threads/${(await start(i % 2 ? "nexus" : "spoon", `Deleted thread ${i}`)).id}`);
let sequence = 0;
const report = (thread: Thread, kind: "session.turn-started" | "session.waiting", message?: string) =>
  registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session: "s1", ...(message === undefined ? {} : { message }) } });
report(waits, "session.turn-started");

const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 800 } });
const route = (method: string, url: string) => `${method} ${new URL(url).pathname.replace(/\/(th-[\w-]+)/, "/<thread>")}${new URL(url).searchParams.has("follow") ? "?follow" : ""}`;
/** The browser stands in for the person: whether each tab is shown and focused is set, not read from the window manager. */
async function tab(name: string, path: string, shown: { hidden: boolean; focused: boolean }) {
  const page = await browser.newPage();
  page.on("request", (r: { method(): string; url(): string; resourceType(): string }) => {
    if (!r.url().startsWith(base) || r.url().includes("/assets/")) return;
    const key = `${name}: ${route(r.method(), r.url())}`;
    counts[phase].requests[key] = (counts[phase].requests[key] ?? 0) + 1;
  });
  await page.evaluateOnNewDocument(({ hidden, focused }: { hidden: boolean; focused: boolean }) => {
    Object.defineProperty(Document.prototype, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
    Object.defineProperty(Document.prototype, "hidden", { get: () => hidden });
    Document.prototype.hasFocus = () => focused;
    const w = window as unknown as { notices: unknown[]; toasts: unknown[]; triggers: unknown[]; Notification: unknown; EventSource: typeof EventSource; fetch: typeof fetch };
    w.notices = [];
    w.toasts = [];
    // What ends a tab's wait for a change: on main its next read of the list, on the branch the event stream's message.
    w.triggers = [];
    const Stream = w.EventSource;
    w.EventSource = class extends Stream {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        if (String(url).startsWith("/v1/events")) this.addEventListener("message", () => w.triggers.push({ kind: "event", at: Date.now() }));
      }
    };
    const send = w.fetch;
    w.fetch = (input, init) => {
      if (String(input).startsWith("/v1/threads?") || String(input) === "/v1/threads") {
        if ((init?.method ?? "GET") === "GET") w.triggers.push({ kind: "list read", at: Date.now() });
      }
      return send(input, init);
    };
    w.Notification = class {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick = null;
      constructor(title: string, options: { body: string }) { w.notices.push({ title, body: options.body, at: Date.now() }); }
      close() {}
    };
    new MutationObserver((records) => {
      for (const r of records) for (const added of r.addedNodes) {
        if (added instanceof HTMLElement && added.classList.contains("attention-toast")) w.toasts.push({ text: added.querySelector("span")?.textContent, at: Date.now() });
      }
    }).observe(document, { childList: true, subtree: true });
  }, shown);
  await page.goto(`${base}${path}`);
  await page.waitForSelector("main");
  return { name, page, ...shown };
}
// The hidden tabs open first, so on the branch a hidden tab follows the events for the others.
const tabs = [
  await tab("hidden home", "/", { hidden: true, focused: false }),
  await tab("hidden thread page", `/threads/${hiddenThread.id}`, { hidden: true, focused: false }),
  await tab("focused thread page", `/threads/${focus.id}`, { hidden: false, focused: true }),
  await tab("visible home", "/", { hidden: false, focused: false }),
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seen = (t: { lastReplyAt: number | null; seenAt: number | null }) => t.lastReplyAt === null || (t.seenAt !== null && t.seenAt >= t.lastReplyAt);
const until = async (what: string, ok: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`);
    await sleep(25);
  }
};
// The same offsets on both checkouts, so no change lands at the same point of every poll or every stream tick.
const jitter = [137, 811, 403, 952, 268, 690, 45, 577, 334, 909, 721, 12, 486, 863, 199, 640, 375, 958];
await until("the focused page marks its reply seen", () => seen(registry.thread(focus.id)!), 10_000);
await sleep(3000);

await takeCalls("setup");
phase = "idle";
await sleep(Number(process.env.IDLE_MS ?? 60_000));
await takeCalls("idle");

type Round = { kind: string; thread: string; at: number; open: string[]; titles?: Record<string, string> };
const rounds: Round[] = [];
type Trigger = { kind: string; at: number };
const shown: { tab: string; notices: { title: string; body: string; at: number }[]; toasts: { text: string; at: number }[]; triggers: Trigger[] }[] = [];
const collect = async (t: (typeof tabs)[number]) => shown.push({
  tab: t.name,
  notices: await t.page.evaluate(() => (window as unknown as { notices: unknown[] }).notices),
  toasts: await t.page.evaluate(() => (window as unknown as { toasts: unknown[] }).toasts),
  triggers: await t.page.evaluate(() => (window as unknown as { triggers: unknown[] }).triggers),
});
async function round(i: number) {
  await sleep(jitter[i % jitter.length]!);
  const at = Date.now();
  const open = tabs.map((t) => t.name);
  if (i % 2 === 0) {
    registry.recordReply(replies.id, at);
    rounds.push({ kind: "new reply", thread: replies.title, at, open });
  } else {
    report(waits, "session.waiting", "May I push?");
    rounds.push({ kind: "waiting for input", thread: waits.title, at, open });
  }
  await sleep(5000);
  rounds.at(-1)!.titles = Object.fromEntries(await Promise.all(tabs.map(async (t) => [t.name, await t.page.title()])));
  await sleep(1000);
  if (i % 2 === 0) registry.markSeen(replies.id, false, Date.now());
  else report(waits, "session.turn-started");
  await sleep(2000);
}
phase = "attention";
for (let i = 0; i < 16; i += 1) await round(i);
await takeCalls("attention");
phase = "setup";

// The first tab is the one that follows the events on the branch. Closing it hands that to another tab.
const closed = tabs.shift()!;
await collect(closed);
await closed.page.close();
for (let i = 16; i < 18; i += 1) await round(i);
for (const t of tabs) await collect(t);

const roundOf = (at: number) => rounds.findLast((r) => r.at <= at)!;
const events = shown.flatMap((s) => s.triggers.filter((t) => t.kind === "event"));
/** The last trigger after the change and before the notification: the stream's message, or else the tab's own list read. */
const triggerOf = (tab: string, at: number) => {
  const after = (t: Trigger) => t.at >= roundOf(at).at && t.at <= at;
  const event = events.filter(after).at(-1);
  return event ?? shown.find((s) => s.tab === tab)!.triggers.filter((t) => t.kind === "list read" && after(t)).at(-1) ?? null;
};
const entry = (tab: string, channel: string, text: string, at: number) => {
  const trigger = triggerOf(tab, at);
  return { tab, channel, text, round: rounds.indexOf(roundOf(at)), afterMs: at - roundOf(at).at, trigger: trigger?.kind ?? null, triggerAfterMs: trigger === null ? null : trigger.at - roundOf(at).at };
};
const notices = shown.flatMap((s) => [
  ...s.notices.map((n) => entry(s.tab, "system", `${n.title}: ${n.body}`, n.at)),
  ...s.toasts.map((n) => entry(s.tab, "toast", n.text, n.at)),
]).sort((a, b) => a.round - b.round || a.tab.localeCompare(b.tab));

const newReplySeenAfterMs: number[] = [];
for (let i = 0; i < 3; i += 1) {
  await sleep(jitter[i]!);
  fake.transcript(focus.id).messages.push({
    role: "assistant", content: [{ type: "text", text: `Hello ${i}.` }], stopReason: "stop", api: "x", provider: "x", model: "x", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as never);
  fake.commit(focus.id);
  const replyAt = Date.now();
  registry.recordReply(focus.id, replyAt);
  await until("the focused page marks the new reply seen", () => seen(registry.thread(focus.id)!), 15_000);
  newReplySeenAfterMs.push(Date.now() - replyAt);
}
await sleep(1000);
await call("POST", `/v1/threads/${focus.id}/unseen`, {});
const unseenAt = Date.now();
const seenAgainAfterMs = await until("the focused page marks the reply seen again", () => seen(registry.thread(focus.id)!), 8000).then(() => Date.now() - unseenAt, () => null);
const unseenElsewhere = { seenAgainAfterMs, attentionAtEnd: registry.attention(focus.id) };

await browser.close();
await api.close();
const observed = { rounds: rounds.map(({ kind, thread, open, titles }) => ({ kind, thread, open, titlesAfter5s: titles })), notices, newReplySeenAfterMs, unseenElsewhere };
assert.ok(notices.length > 0, "the tabs showed notifications");
await writeFile(join(out, "counts.json"), `${JSON.stringify(counts, null, 2)}\n`);
await writeFile(join(out, "observed.json"), `${JSON.stringify(observed, null, 2)}\n`);
process.exit(0);
