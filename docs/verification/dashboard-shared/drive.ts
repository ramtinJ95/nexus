// Drives the dashboard of the checkout it runs in through headless Chromium, against that checkout's own registry,
// API and dashboard on a free port, and writes what the page did to <out>/result.json and <out>/*.png. The model
// harness is the test fake and the node's observation is written here, so nothing reaches a pylon or the live
// control plane. The browser's clock runs two hours ahead of the server's, so each age and run clock the page ticks
// differs from the one the server rendered.
//
//   MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/dashboard-shared/drive.ts <out>
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { openRegistry, type Thread } from "../../../src/control/registry.ts";
import type { NodeName, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";

const out = process.argv[2]!;
mkdirSync(out, { recursive: true });
const modules = createRequire(join(process.env.MODULES!, "x.js"));
const chromium = modules("@sparticuz/chromium").default;
const puppeteer = modules("puppeteer-core").default;

const node = "verify-node" as NodeName;
const laptop = "nVERIFY" as TailnetNodeId;
let back = 0;
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-shared-")), "registry.db"), () => Date.now() - back);
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
const fake = fakeHarness();
const startThread = threadStarter({ registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the capture reads no remote")) } });
const api = await startApi({
  registry, host: "127.0.0.1", port: 0,
  deployment: { self: "nNODE" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" },
  harness: fake.harness, startThread, wake: () => {}, previewPorts: { first: 10200, last: 10299 },
  // The attach route upgrades for a node with a probe, and this one fails each terminal it is asked to open.
  probes: new Map([[node, { stream: async () => { throw new Error("the capture opens no terminal in a pylon"); } }]]),
} as unknown as Parameters<typeof startApi>[0]);
const base = `http://127.0.0.1:${api.port}`;
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
  id: "spoon", repoUrl: "git@example.com:spoon.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 1, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
registry.saveImage(image as never, null);
registry.setCurrentImage(image.id as never);
const thread: Thread = await call("POST", "/v1/threads", { project: "spoon", title: "Refactor the loop" });
back = 63_000;
registry.recordActivity(thread.id, { agent: Date.now() - 63_000, agentTurnRunning: true });
back = 0;
const observe = () => {
  registry.apply({ record: "node", node, state: "online", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 } });
  const pylon: PylonObservation = {
    pylonId: thread.pylonId, phase: "running", liveHash: registry.pylon(thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [], jobs: [], pylons: [pylon], previewRoutes: [] }, []);
};
observe();
const observing = setInterval(observe, 1000);

const ahead = 2 * 3_600_000;
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 900 });
await page.evaluateOnNewDocument((ms: number) => {
  const now = Date.now.bind(Date);
  Date.now = () => now() + ms;
}, ahead);
const posted: Record<string, unknown> = {};
await page.setRequestInterception(true);
page.on("request", (request: any) => {
  const path = new URL(request.url()).pathname;
  if (request.method() === "POST" && (path === "/v1/threads" || path === "/v1/projects")) {
    posted[path] = JSON.parse(request.postData());
    return request.respond({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "the driver kept this request" }) });
  }
  return request.continue();
});
const cdp = await page.createCDPSession();
await cdp.send("Network.enable");
const socket: { url: string | null; sent: string[]; received: string[] } = { url: null, sent: [], received: [] };
cdp.on("Network.webSocketCreated", ({ url }: { url: string }) => { socket.url ??= url; });
cdp.on("Network.webSocketFrameSent", ({ response }: { response: { opcode: number; payloadData: string } }) => { if (response.opcode === 1) socket.sent.push(response.payloadData); });
cdp.on("Network.webSocketFrameReceived", ({ response }: { response: { opcode: number; payloadData: string } }) => { if (response.opcode === 1) socket.received.push(response.payloadData); });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const result: Record<string, unknown> = {};

const served = await (await fetch(`${base}/`)).text();
result.servedAges = [...served.matchAll(/data-ago>([^<]*)</g)].map((m) => m[1]);
result.servedClocks = [...served.matchAll(/<time data-since="\d+">([^<]*)</g)].map((m) => m[1]);
await page.goto(`${base}/`);
await settle(2000);
result.tickedAges = await page.$$eval("time[data-ago]", (els: Element[]) => els.map((e) => e.textContent));
result.tickedClocks = await page.$$eval("time[data-since]", (els: Element[]) => els.map((e) => e.textContent));
await page.screenshot({ path: join(out, "home.png") });

await page.goto(`${base}/threads/new`);
await page.waitForSelector("#start-dialog[open]");
result.modelPlaceholder = await page.$eval("#start-model", (e: HTMLInputElement) => e.placeholder);
result.modelHint = await page.$eval("#start-model + .hint", (e: Element) => e.textContent);
await page.$eval("#start-claude", (e: HTMLTextAreaElement) => { e.value = `\n   \n  ${"Fix the login page so a wrong password says why, and keep the session cookie as it is".padEnd(90, ".")}  \nthen test it`; });
await page.screenshot({ path: join(out, "start-dialog.png") });
await page.click("#start button[type=submit]");
await page.waitForSelector("#start-error:not([hidden])");
result.startBody = posted["/v1/threads"];

await page.goto(`${base}/projects/new`);
await page.waitForSelector("#project-dialog[open]");
result.projectHint = await page.$eval("#project", (e: Element) => e.textContent!.match(/Each pylon gets [^.]*\./)?.[0] ?? null);
await page.type("#project-id", "acme");
await page.type("#project-repo", "git@example.com:acme.git");
await page.click("#project button[type=submit]");
await page.waitForSelector("#project-error:not([hidden])");
result.projectBody = posted["/v1/projects"];

await page.goto(`${base}/threads/${thread.id}#terminal`);
await settle(3000);
result.terminalStatus = await page.$eval("#term-status", (e: Element) => e.textContent);
await page.screenshot({ path: join(out, "terminal.png") });
result.terminal = { ...socket, url: socket.url?.replace(base.slice("http://".length), "HOST").replace(thread.id, "THREAD") };

writeFileSync(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
clearInterval(observing);
await api.close();
process.exit(0);
