// Drives the stack in stack.ts through the Mac CLI and headless Chromium, and saves each step's command, output and exit
// code in OUT. Both projects land their builders' PRs on their own. In nexus, whose repository has a .nexus/verify,
// "Greet by name" passes its live check and "Say goodbye" fails it. In greeter, whose repository has none, "Greet
// warmly" lands on its statement of what it could not check live, as every landing did before.
//
//   OUT=... ROOT=<checkout> MODULES=... node docs/verification/verify-pylon/drive.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const out = process.env.OUT;
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(join(out, "drive.log"), "");

const env = { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" };
let step = 0;
function nexus(name, args) {
  const r = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env, encoding: "utf8" });
  const text = `$ nexus ${args.join(" ")}\n${r.stdout}${r.stderr ? `[stderr] ${r.stderr}` : ""}[exit ${r.status}]\n`;
  writeFileSync(join(out, `${String(++step).padStart(2, "0")}-${name}.txt`), text);
  log(text);
  return r;
}
const json = (args) => JSON.parse(spawnSync("node", ["src/cli/nexus.ts", ...args, "--json"], { cwd: process.env.ROOT, env, encoding: "utf8" }).stdout);
const ended = new Set(["approved", "landed", "needs-person", "merged", "closed", "cancelled"]);
async function until(what, ok, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (ok()) { log(`waited: ${what}`); return true; } await sleep(500); }
  log(`gave up waiting after ${ms / 1000} s: ${what}`);
  return false;
}

nexus("version", ["--version"]);
nexus("auto-review-nexus", ["project", "edit", "nexus", "--auto-review", "land"]);
nexus("auto-review-greeter", ["project", "edit", "greeter", "--auto-review", "land"]);
const started = {};
for (const [key, project, title, prompt] of [
  ["pass", "nexus", "Greet by name", 'push greet-name "Hello, Ramtin"'],
  ["fail", "nexus", "Say goodbye", 'push say-goodbye "Goodbye"'],
  ["plain", "greeter", "Greet warmly", 'push greet-warm "Hello, friend" not checked live: the greeting is printed by a script, with no service to start.'],
]) started[key] = JSON.parse(nexus(`start-${key}`, ["start", "--project", project, "--title", title, "--claude", prompt, "--json"]).stdout).id;
const ids = () => Object.values(started);
await until("the PR watch linked every PR", () => ids().every((id) => (json(["show", id]).pullRequests ?? []).length === 1), 30_000);
await until("every review has ended", () => ids().every((id) => ended.has(json(["show", id]).review?.phase.kind)), 90_000);
await sleep(3_000);
nexus("threads", ["threads", "--all"]);
for (const [key, id] of Object.entries(started)) nexus(`show-${key}`, ["show", id]);
const verifiers = json(["threads", "--all"]).filter((t) => t.startedBy === "nexus-verify");
for (const t of verifiers) nexus(`show-verify-pylon-${t.id}`, ["show", t.id]);
nexus("land-fail", ["land", started.fail]);
nexus("events-review", ["events", "--kind", "review.changed"]);
writeFileSync(join(out, "threads.json"), JSON.stringify({ builders: started, verifiers: verifiers.map((t) => t.id) }, null, 2));
for (const [key, id] of Object.entries(started)) writeFileSync(join(out, `review-${key}.json`), JSON.stringify(json(["show", id]).review, null, 2));

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default ?? require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
async function shot(name, path, tab) {
  await page.goto(`http://127.0.0.1:7470${path}`);
  await page.waitForSelector("#side-threads");
  if (tab !== undefined) await page.click(`label.seg-tab:has(input[value="${tab}"])`);
  await page.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });
  await sleep(1_000);
  const landing = await page.evaluate(() => document.querySelector("#landing")?.innerText.replace(/\s+/g, " ").trim() ?? "");
  const review = await page.evaluate(() => [...document.querySelectorAll("p")].filter((p) => /^Nexus review|live check/.test(p.innerText)).map((p) => p.innerText).join(" | "));
  log(`screenshot ${name}: ${path}\n  landing card: ${landing || "none"}\n  review lines: ${review || "none"}`);
  await page.screenshot({ path: join(out, name), fullPage: true });
}
await shot("01-home.png", "/");
await shot("02-pass.png", `/threads/${started.pass}`);
await shot("03-fail.png", `/threads/${started.fail}`);
await shot("04-plain.png", `/threads/${started.plain}`);
await shot("05-fail-pylon-tab.png", `/threads/${started.fail}`, "pylon");
await browser.close();
