// Runs the real registry, API and dashboard with the fake model harness the API tests use, and drives two pages in
// headless Chromium: the home page, whose sidebar lists each node's release lines and whose start dialog is filled in
// and then swapped by a poll, and a harness thread's page, whose conversation streams while it polls. Writes what the
// pages showed and what the polls carried to <out-dir>/result.json.
// Run from the root of a checkout: MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/dashboard-render/drive.ts <out-dir>
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2]!;
mkdirSync(out, { recursive: true });
const require = createRequire(join(process.env.MODULES!, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");

const { startApi } = await import("../../../src/control/api.ts");
const { fakeHarness } = await import("../../../src/control/fake-harness.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { threadStarter } = await import("../../../src/control/threads.ts");
type Thread = import("../../../src/control/registry.ts").Thread;
type NodeName = import("../../../src/protocol.ts").NodeName;
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;

const node = "verify-node" as NodeName;
const laptop = "nVERIFY" as TailnetNodeId;
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-render-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
registry.upsertNode({ name: "tower" as NodeName, tailnetHost: "tower.tail.ts.net", tailnetNodeId: "nTOWER" as TailnetNodeId });
const fake = fakeHarness();
const startThread = threadStarter({ registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } });
const api = await startApi({
  registry, host: "127.0.0.1", port: 0,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  deployment: { self: "nNODE" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  harness: fake.harness, startThread, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});
const base = `http://127.0.0.1:${api.port}`;

registry.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-27T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never, null);
registry.setCurrentImage("img-0000000000aa" as never);
const project = (id: string, repoUrl: string | null) => registry.createProject({ id, repoUrl, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null } as never);
project("acme", "git@example.com:acme.git");
project("sketch", null);
const commit = "c".repeat(40);
registry.reportRelease({ node, role: "control", commit, target: commit, state: "healthy", reason: null, observedAt: Date.now() });
registry.reportRelease({ node, role: "probe", commit, target: commit, state: "healthy", reason: null, observedAt: Date.now() - 120_000 });

const res = await fetch(`${base}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "acme", title: "Streaming thread" }) });
assert.equal(res.status, 201, await res.clone().text());
const thread = await res.json() as Thread;
const transcript = fake.transcript(thread.id);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const said = (text: string, content: unknown[] = [{ type: "text", text }]) => ({ role: "assistant", content, stopReason: "stop", api: "x", provider: "x", model: "gpt-verify", usage, timestamp: 0 });
for (let i = 0; i < 40; i++) transcript.messages.push({ role: "user", content: `Step ${i}: fix **the** \`parser\`.`, timestamp: 0 } as never, said(`Fixed step ${i}.\n\n- one\n- two`) as never);
transcript.messages.push({ role: "user", content: "Build it", timestamp: 0 } as never, { ...said(""), content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm run build" } }], stopReason: "toolUse" } as never);
const live = (output: string) => ({ run: { taskId: 1, inputs: [1] }, tools: [{ callId: "c1", name: "bash", status: "running", output }] });
transcript.docs["pi.live"] = live("compiling\n");
fake.commit(thread.id);

const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 900 } });
const until = async (what: string, check: () => Promise<boolean>, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await check()) return;
  throw new Error(`timed out: ${what}`);
};

const home = await browser.newPage();
await home.goto(`${base}/`);
const release = await home.$$eval("#side-nodes > span, #side-nodes > small[title]", (els) => els.map((el) => el.tagName === "SPAN" ? `node ${el.textContent!.trim()}` : `${el.textContent} (${el.getAttribute("title")})`));
await home.click(".side-head [data-start]");
await home.waitForSelector("#start-dialog[open]");
const hint = () => home.$eval("#start-hint", (el) => el.innerHTML);
const opened = await hint();
await home.click("input[name=worker][value=harness]");
await home.type("#start-title", "Ship the fix");
await home.select("#start-node", "tower");
await home.click("input[name=project][value=sketch]");
await home.type("#start-branch", "dev");
const typed = await hint();
await home.screenshot({ path: join(out, "start-before-swap.png") });
// A project added since the page loaded changes the dialog's region, so the next poll swaps it.
project("gamma", "git@example.com:gamma.git");
await until("the poll swaps in the dialog with the new project", async () => (await home.$("input[name=project][value=gamma]")) !== null);
const kept = await home.$eval("#start", (form: HTMLFormElement) => ({
  worker: (form.elements.namedItem("worker") as RadioNodeList).value, title: (form.elements.namedItem("title") as HTMLInputElement).value,
  node: (form.elements.namedItem("node") as HTMLSelectElement).value, branch: (form.elements.namedItem("branch") as HTMLInputElement).value,
  project: (form.querySelector("input[name=project]:checked") as HTMLInputElement | null)?.value ?? null,
  harnessFieldsShown: !(form.querySelector("#start-harness-fields") as HTMLElement).hidden,
}));
const swapped = await hint();
await home.screenshot({ path: join(out, "start-after-swap.png") });

const page = await browser.newPage();
const polls: { shows: string | null; insideBytes: number }[] = [];
page.on("response", async (r: { url(): string; text(): Promise<string> }) => {
  if (!r.url().startsWith(`${base}/threads/${thread.id}?streaming=1`)) return;
  const html = await r.text();
  const tag = /<div class="convo" id="convo" data-rendered-reply-at="\d*"(?: data-shows="([^"]+)")? data-live[^>]*>/.exec(html)!;
  polls.push({ shows: tag[1] ?? null, insideBytes: html.slice(tag.index + tag[0].length).split('<section class="file-view"')[0]!.length });
});
await page.goto(`${base}/threads/${thread.id}`);
await until("two polls of the streaming page", async () => polls.length >= 2);
transcript.docs["pi.live"] = live("compiling\nlinking\n");
fake.commit(thread.id);
await until("the stream grows the running call's output", async () => (await page.$eval("#convo", (el) => el.textContent!)).includes("linking"));
await until("a poll after the stream grew", async () => polls.length >= 3);
const shown = await page.$eval("#convo", (el) => ({ messages: el.querySelectorAll(".msg").length, output: el.querySelector(".t-out")?.textContent ?? null }));

const result = { release, hint: { opened, typed, swapped }, kept, stream: { polls, shown } };
assert.ok(shown.messages >= 80, "the stream's render stays in the page");
await writeFile(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
await api.close();
registry.close();
