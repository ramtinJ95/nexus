// Drives the stack in stack.ts through the Mac CLI and headless Chromium, the same steps on main and on the branch,
// and saves each step's command, output and exit code in OUT. Four builders push PRs: "Greet by name" in project
// nexus and "Greet loudly", which conflicts with main, also in nexus, which the person asks to review and land on its
// own; "Greet in French" in nexus-manual, which asks for nothing; and "Greet quietly", which conflicts with main, in
// nexus-manual, whose review the person starts by hand with `nexus review --land`. Then two builders in nexus-manual
// push changes under images/, whose landings the policy holds for the person: the person closes one PR and archives
// the other builder.
//
//   OUT=... ROOT=<checkout> MODULES=... node docs/verification/auto-review/drive.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const out = process.env.OUT;
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(join(out, "drive.log"), "");

let step = 0;
function nexus(name, args, url = "http://127.0.0.1:7470") {
  const r = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env: { ...process.env, NEXUS_URL: url, NEXUS_SOCKS: "none" }, encoding: "utf8" });
  const as = url.endsWith(":7471") ? " (as nPHONE, not a deployer)" : "";
  const text = `$ nexus ${args.join(" ")}${as}\n${r.stdout}${r.stderr ? `[stderr] ${r.stderr}` : ""}[exit ${r.status}]\n`;
  writeFileSync(join(out, `${String(++step).padStart(2, "0")}-${name}.txt`), text);
  log(text);
  return r;
}
const json = (args) => JSON.parse(spawnSync("node", ["src/cli/nexus.ts", ...args, "--json"], { cwd: process.env.ROOT, env: { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" }, encoding: "utf8" }).stdout);
const ended = new Set(["approved", "landed", "needs-person", "merged", "closed", "cancelled"]);
async function until(what, ok, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (ok()) { log(`waited: ${what}`); return true; } await sleep(500); }
  log(`gave up waiting after ${ms / 1000} s: ${what}`);
  return false;
}

nexus("version", ["--version"]);
nexus("auto-review-land", ["project", "edit", "nexus", "--auto-review", "land"]);
nexus("auto-review-land-not-deployer", ["project", "edit", "nexus-manual", "--auto-review", "land"], "http://127.0.0.1:7471");
nexus("projects", ["projects"]);
const started = {};
for (const [key, project, title, prompt] of [
  ["byName", "nexus", "Greet by name", "push greet-name"],
  ["french", "nexus-manual", "Greet in French", "push greet-french"],
  ["loudly", "nexus", "Greet loudly", "push greet-loud conflict"],
]) started[key] = JSON.parse(nexus(`start-${key}`, ["start", "--project", project, "--title", title, "--claude", prompt, "--json"]).stdout).id;
const ids = () => Object.values(started);
await until("the PR watch linked every PR", () => ids().every((id) => (json(["show", id]).pullRequests ?? []).length === 1), 30_000);
await until("every review that started has ended", () => ids().every((id) => { const r = json(["show", id]).review; return r == null || ended.has(r.phase.kind); }) && ids().some((id) => json(["show", id]).review != null), 30_000);
await sleep(5_000);
for (const [key, id] of Object.entries(started)) nexus(`show-${key}`, ["show", id]);

started.quietly = JSON.parse(nexus("start-quietly", ["start", "--project", "nexus-manual", "--title", "Greet quietly", "--claude", "push greet-quiet conflict", "--json"]).stdout).id;
await until("the PR watch linked Greet quietly's PR", () => (json(["show", started.quietly]).pullRequests ?? []).length === 1, 30_000);
nexus("review-quietly-by-hand", ["review", started.quietly, "--land"]);
await until("Greet quietly's review ended", () => ended.has(json(["show", started.quietly]).review?.phase.kind), 60_000);
nexus("show-quietly", ["show", started.quietly]);
nexus("show-quietly-json", ["show", started.quietly, "--json"]);
for (const [key, title, prompt] of [["closes", "Rebuild the image", "push image-close reserved"], ["archives", "Rebuild the image again", "push image-archive reserved"]]) {
  started[key] = JSON.parse(nexus(`start-${key}`, ["start", "--project", "nexus-manual", "--title", title, "--claude", prompt, "--json"]).stdout).id;
}
await until("the PR watch linked both image PRs", () => [started.closes, started.archives].every((id) => (json(["show", id]).pullRequests ?? []).length === 1), 30_000);
nexus("review-closes", ["review", started.closes, "--land"]);
nexus("review-archives", ["review", started.archives, "--land"]);
await until("both image reviews are held for the person", () => [started.closes, started.archives].every((id) => json(["show", id]).review?.phase.kind === "needs-person"), 60_000);
nexus("show-closes-held", ["show", started.closes]);
nexus("show-archives-held", ["show", started.archives]);
const closed = await fetch(`http://127.0.0.1:7472/close/${json(["show", started.closes]).pullRequests[0].number}`, { method: "POST" });
log(`closed the PR of ${started.closes} on GitHub: HTTP ${closed.status}`);
nexus("archive-archives", ["archive", started.archives]);
await sleep(8_000);
nexus("show-closes-after", ["show", started.closes]);
nexus("show-archives-after", ["show", started.archives]);
nexus("events-review", ["events", "--kind", "review.changed"]);
nexus("release", ["release"]);
nexus("threads", ["threads"]);
writeFileSync(join(out, "threads.json"), JSON.stringify(started, null, 2));

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default ?? require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
async function shot(name, thread, pane) {
  await page.goto(`http://127.0.0.1:7470/threads/${thread}`);
  await page.waitForSelector("#side-threads");
  if (pane) await page.click(`label.seg-tab:has(input[value="${pane}"])`);
  await sleep(1_000);
  const review = await page.evaluate(() => [...document.querySelectorAll("#pane-pylon p, #pane-pylon li")].map((p) => p.innerText.trim()).filter((t) => /^(Nexus review|PR #|The )/.test(t)).join("\n"));
  log(`screenshot ${name}: ${review || "(no PR or review line)"}`);
  await page.screenshot({ path: join(out, name) });
}
await shot("01-by-name.png", started.byName, "pylon");
await shot("02-in-french.png", started.french, "pylon");
await shot("03-loudly.png", started.loudly, "pylon");
await shot("04-quietly.png", started.quietly, "pylon");
await shot("05-closed-held.png", started.closes, "pylon");
await shot("06-archived-held.png", started.archives, "pylon");
await browser.close();
