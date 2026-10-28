// Drives the stack in stack.ts through the Mac CLI and headless Chromium, the same steps on main and on the branch,
// and saves each step's command, output and exit code in OUT. Three builders push PRs: "Greet by name" in project
// nexus, which lands its builders' PRs on its own; "Rebuild the image", also in nexus, whose change under images/ the
// merge policy holds for the person; and "Greet in French" in nexus-review, which reviews without landing. Once every
// review has ended, the person unarchives "Greet by name".
//
//   OUT=... ROOT=<checkout> MODULES=... node docs/verification/archive-landed/drive.mjs
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
nexus("auto-review-land", ["project", "edit", "nexus", "--auto-review", "land"]);
nexus("auto-review-review", ["project", "edit", "nexus-review", "--auto-review", "review"]);
const started = {};
for (const [key, project, title, prompt] of [
  ["byName", "nexus", "Greet by name", "push greet-name"],
  ["image", "nexus", "Rebuild the image", "push image-rebuild reserved"],
  ["french", "nexus-review", "Greet in French", "push greet-french"],
]) started[key] = JSON.parse(nexus(`start-${key}`, ["start", "--project", project, "--title", title, "--claude", prompt, "--json"]).stdout).id;
const ids = () => Object.values(started);
await until("the PR watch linked every PR", () => ids().every((id) => (json(["show", id]).pullRequests ?? []).length === 1), 30_000);
await until("every review has ended", () => ids().every((id) => ended.has(json(["show", id]).review?.phase.kind)), 60_000);
await sleep(4_000);
nexus("threads", ["threads", "--all"]);
for (const [key, id] of Object.entries(started)) nexus(`show-${key}`, ["show", id]);
const reviewers = Object.fromEntries(Object.entries(started).map(([key, id]) => [key, json(["show", id]).review.reviewer]));
for (const [key, id] of Object.entries(reviewers)) nexus(`show-reviewer-${key}`, ["show", id]);
nexus("events-review", ["events", "--kind", "review.changed"]);
writeFileSync(join(out, "threads.json"), JSON.stringify({ builders: started, reviewers }, null, 2));

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default ?? require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
async function shot(name, path) {
  await page.goto(`http://127.0.0.1:7470${path}`);
  await page.waitForSelector("#side-threads");
  await page.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });
  await sleep(1_000);
  const actions = await page.evaluate(() => [...document.querySelectorAll("[data-action]")].map((b) => b.getAttribute("data-action")).join(", "));
  log(`screenshot ${name}: ${path}, actions offered: ${actions || "none"}`);
  await page.screenshot({ path: join(out, name) });
}
await shot("01-home.png", "/");
await shot("02-by-name.png", `/threads/${started.byName}`);
await shot("03-image-held.png", `/threads/${started.image}`);

nexus("unarchive-byName", ["unarchive", started.byName]);
await sleep(5_000);
nexus("show-byName-after-unarchive", ["show", started.byName]);
nexus("threads-after-unarchive", ["threads", "--all"]);
await shot("04-by-name-unarchived.png", `/threads/${started.byName}`);
await browser.close();
