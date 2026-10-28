// Drives the stack in stack.ts through the Mac CLI, the same steps on main and on the branch, and saves each step's
// command, output and exit code in OUT. Four Claude workers start in project nexus, which reviews its builders' pull
// requests on its own. The drive waits for the PR watch's second pass, two minutes after the stack started, so every
// PR a builder opened is linked by the end.
//
//   OUT=... ROOT=<checkout> [MODULES=<node_modules with @sparticuz/chromium and puppeteer-core>] node docs/verification/nudge-stalled-builder/drive.mjs
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.env.OUT;
const env = { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" };
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const began = Date.now();
writeFileSync(join(out, "drive.log"), "");

let step = 0;
function nexus(name, args) {
  const r = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env, encoding: "utf8" });
  const text = `$ nexus ${args.join(" ")}\n${r.stdout}${r.stderr ? `[stderr] ${r.stderr}` : ""}[exit ${r.status}]\n`;
  writeFileSync(join(out, `${String(++step).padStart(2, "0")}-${name}.txt`), text);
  log(text);
  return r;
}
const json = (args) => JSON.parse(spawnSync("node", ["src/cli/nexus.ts", ...args, "--json"], { cwd: process.env.ROOT, env, encoding: "utf8" }).stdout);
const typed = () => existsSync(join(out, "typed.log")) ? readFileSync(join(out, "typed.log"), "utf8") : "";
const nudgesOf = (id) => typed().split(`typed into ${id}:\n[Nexus nudge`).length - 1;
async function until(what, ok, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (ok()) { log(`waited: ${what}`); return true; } await sleep(250); }
  log(`gave up waiting after ${ms / 1000} s: ${what}`);
  return false;
}

nexus("auto-review", ["project", "edit", "nexus", "--auto-review", "review"]);
const builders = [
  ["byName", "Greet by name", "stop-before-push greet-name"],
  ["loudly", "Greet loudly", "stop-before-push greet-loud stay"],
  ["quietly", "Greet quietly", "push greet-quiet"],
  ["explain", "Explain the queue", "investigate"],
];
const started = {};
for (const [key, title, prompt] of builders) {
  started[key] = JSON.parse(nexus(`start-${key}`, ["start", "--project", "nexus", "--title", title, "--claude", prompt, "--json"]).stdout).id;
}
writeFileSync(join(out, "threads.json"), JSON.stringify(started, null, 2));

await until("Greet loudly needs the person", () => json(["show", started.loudly]).attention === "decision", 30_000);
await until("Explain the queue was nudged once", () => nudgesOf(started.explain) >= 1, 10_000);
nexus("send-explain", ["send", started.explain, "Thanks. This one needs no pull request. Which file holds the queue?"]);
await sleep(10_000);
nexus("threads-before-link", ["threads"]);
log(`waiting for the PR watch's second pass, ${Math.round((began + 125_000 - Date.now()) / 1000)} s from now`);
await sleep(Math.max(0, began + 125_000 - Date.now()));
await until("the PR watch linked every opened PR", () => ["byName", "quietly"].every((key) => (json(["show", started[key]]).pullRequests ?? []).length === 1), 30_000);
await sleep(3_000);
for (const [key, id] of Object.entries(started)) nexus(`show-${key}`, ["show", id]);
nexus("threads-after-link", ["threads"]);
nexus("events-attention", ["events", "--kind", "attention.changed"]);
for (const [key, id] of Object.entries(started)) log(`${key} (${id}): ${nudgesOf(id)} nudges typed, attention ${json(["show", id]).attention ?? "none"}`);

if (process.env.MODULES) {
  const require = createRequire(join(process.env.MODULES, "x.js"));
  const chromium = require("@sparticuz/chromium").default ?? require("@sparticuz/chromium");
  const puppeteer = require("puppeteer-core");
  const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
  const page = await browser.newPage();
  for (const [name, path] of [["01-home.png", "/"], ["02-loudly.png", `/threads/${started.loudly}`], ["03-by-name.png", `/threads/${started.byName}`]]) {
    await page.goto(`http://127.0.0.1:7470${path}`);
    await sleep(1_500);
    await page.screenshot({ path: join(out, name) });
    log(`screenshot ${name} of ${path}`);
  }
  await browser.close();
}
