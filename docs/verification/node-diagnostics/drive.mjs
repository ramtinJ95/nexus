// Drives the stack in stack.ts in headless Chromium and through the real CLI, and saves what it saw in OUT. The same
// driver runs on main and on the branch, and records whatever each one shows and answers.
//
//   OUT=... ROOT=<checkout> STACK='{...}' MODULES=... node docs/verification/node-diagnostics/drive.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const out = process.env.OUT;
const stack = JSON.parse(process.env.STACK);
const base = "http://127.0.0.1:7470";
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, text) => { writeFileSync(join(out, name), text); log(`--- ${name}\n${text}`); };
const run = (...args) => spawnSync(process.execPath, [join(process.env.ROOT, "src/cli/nexus.ts"), ...args], { env: { ...process.env, NEXUS_URL: base, NEXUS_SOCKS: "none" }, encoding: "utf8" });
const nexus = (...args) => {
  const r = run(...args);
  return { code: r.status, text: `$ nexus ${args.join(" ")}\n${r.stdout}${r.stderr}exit ${r.status}\n` };
};
const as = async (who) => {
  await fetch("http://127.0.0.1:7489/verify/caller", { method: "POST", body: JSON.stringify({ as: who }) });
  log(`whois now answers the ${who}, ${stack.callers[who]}`);
};
const api = async (path) => (await fetch(`${base}${path}`)).json();
const until = async (what, check, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};
const leaks = (name, text) => `${name}: ${text.split(stack.planted).length - 1}`;

writeFileSync(join(out, "drive.log"), "");
save("00-version.txt", nexus("--version").text);
const start = (project, title) => JSON.parse(run("start", "--project", project, "--title", title, "--json").stdout);
const flaky = start("flaky", "Flaky boot");
const busy = start("acme", "Busy build");
const idle = start("docs", "Idle docs");
log(`threads: flaky ${flaky.id} (${flaky.pylonId}), busy ${busy.id}, idle ${idle.id}`);
await until("the planner to give up on the flaky pylon", async () => (await api(`/v1/threads/${flaky.id}`)).pylon.failed !== null);
await until("both other pylons to run", async () => (await Promise.all([busy, idle].map((t) => api(`/v1/threads/${t.id}`)))).every((d) => d.pylon.actualState === "running"));

save("01-show-failed.txt", nexus("show", flaky.id).text);
const detail = await api(`/v1/threads/${flaky.id}`);
save("02-api-thread-detail-pylon.json", `${JSON.stringify(detail.pylon, null, 2)}\n`);

const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 900 } });
const page = await browser.newPage();
const shot = async (name) => { await page.screenshot({ path: join(out, name) }); log(`screenshot ${name}`); };
const settle = () => page.waitForSelector("#side-nodes", { timeout: 5000 }).catch(() => log("the page has no sidebar")).then(() => sleep(500));
const failureBox = async () => page.evaluate(() => document.querySelector(".failed-box")?.innerText ?? "(no failure box)");
await page.goto(`${base}/threads/${flaky.id}`, { waitUntil: "load" });
await settle();
save("03-thread-page-failure.txt", `${await failureBox()}\n`);
await shot("03-thread-page-failure.png");
await page.evaluate(() => { const pre = document.querySelector(".failed-box pre"); if (pre) pre.scrollTop = pre.scrollHeight; });
await shot("04-thread-page-failure-scrolled.png");
const html = await page.content();

save("05-nexus-node.txt", nexus("node", stack.node).text);
save("06-nexus-node.json", nexus("node", stack.node, "--json").text);
await page.goto(`${base}/`, { waitUntil: "load" });
await settle();
save("07-sidebar-nodes.txt", `${await page.evaluate(() => {
  const nodes = document.querySelector("#side-nodes");
  return `${nodes?.innerText ?? "(no nodes)"}\nlinks: ${[...nodes?.querySelectorAll("a") ?? []].map((a) => a.getAttribute("href")).join(", ") || "none"}`;
})}\n`);
const nodeResponse = await page.goto(`${base}/nodes/${stack.node}`, { waitUntil: "load" });
await settle();
await shot("08-node-page.png");
save("08-node-page.txt", `HTTP ${nodeResponse.status()}\n${await page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText)}\n`);
await page.setViewport({ width: 390, height: 844 });
await shot("09-node-page-phone-width.png");
await page.setViewport({ width: 1280, height: 900 });

await as("phone");
await page.goto(`${base}/nodes/${stack.node}`, { waitUntil: "load" });
await settle();
await shot("10-node-page-not-deployer.png");
save("10-nexus-node-not-deployer.txt", nexus("node", stack.node).text);
await as("laptop");

const controllerLog = readFileSync(join(stack.root, "n", "instances", flaky.pylonId, "controller.log"), "utf8");
save("11-planted-secret-count.txt", [
  `the planted GH_TOKEN value, counted on each surface`,
  leaks("the flaky pylon's controller.log on the node", controllerLog),
  leaks("nexus show", readFileSync(join(out, "01-show-failed.txt"), "utf8")),
  leaks("GET /v1/threads/<id>", JSON.stringify(detail)),
  leaks("the thread page's HTML", html),
  "",
].join("\n"));

await fetch("http://127.0.0.1:7489/verify/restart", { method: "POST" });
log("the probe stopped and the control plane restarted on its registry file");
await until("the node to be offline", async () => (await api("/v1/nodes")).every((n) => n.state === "offline"), 90_000);
save("12-nodes-after-restart.txt", nexus("nodes").text);
save("12-show-after-restart-node-offline.txt", nexus("show", flaky.id).text);
await page.goto(`${base}/threads/${flaky.id}`, { waitUntil: "load" });
await settle();
save("13-thread-page-after-restart.txt", `${await failureBox()}\n`);
await page.evaluate(() => { const pre = document.querySelector(".failed-box pre"); if (pre) pre.scrollTop = pre.scrollHeight; });
await shot("13-thread-page-after-restart.png");
save("14-nexus-node-unreachable.txt", nexus("node", stack.node).text);
await browser.close();
