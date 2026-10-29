// Drives the stack in stack.ts through the Mac CLI and headless Chromium, the same steps on main and on the branch,
// and saves each step's command, output and exit code in OUT. Four builders: "Hold in review" and "Hold in fixing" in
// project nexus-review, whose reviews stop in reviewing and fixing; "Deploy slowly" in nexus, which lands its builders'
// PRs on its own and whose deploy waits until OUT/healthy exists; and "Bystander", which opens no PR. The person
// cancels the first review from the CLI and the second from the dashboard, and tries to cancel the deploy. Then the
// control node calls every route that acts on a thread, on Bystander, and the person archives it.
//
//   OUT=... ROOT=<checkout> MODULES=... node docs/verification/person-routes-review-cancel/drive.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const out = process.env.OUT;
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(join(out, "drive.log"), "");

const env = { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" };
let step = 0;
const save = (name, text) => { writeFileSync(join(out, `${String(++step).padStart(2, "0")}-${name}.txt`), text); log(text); };
function nexus(name, args) {
  const r = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env, encoding: "utf8" });
  save(name, `$ nexus ${args.join(" ")}\n${r.stdout}${r.stderr ? `[stderr] ${r.stderr}` : ""}[exit ${r.status}]\n`);
  return r;
}
const json = (args) => JSON.parse(spawnSync("node", ["src/cli/nexus.ts", ...args, "--json"], { cwd: process.env.ROOT, env, encoding: "utf8" }).stdout);
const phase = (id) => json(["show", id]).review?.phase.kind;
async function until(what, ok, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (ok()) { log(`waited: ${what}`); return true; } await sleep(500); }
  log(`gave up waiting after ${ms / 1000} s: ${what}`);
  return false;
}
const as = (who) => { if (who === "person") rmSync(join(out, "caller"), { force: true }); else writeFileSync(join(out, "caller"), "nNODE"); log(`calling as ${who}`); };

nexus("version", ["--version"]);
nexus("auto-review-land", ["project", "edit", "nexus", "--auto-review", "land"]);
nexus("auto-review-review", ["project", "edit", "nexus-review", "--auto-review", "review"]);
const started = {};
for (const [key, project, title, prompt] of [
  ["holdReview", "nexus-review", "Hold in review", "push hold-review"],
  ["holdFixing", "nexus-review", "Hold in fixing", "push hold-fixing"],
  ["deploySlowly", "nexus", "Deploy slowly", "push deploy-slowly"],
  ["bystander", "nexus-review", "Bystander", "look around"],
]) started[key] = JSON.parse(nexus(`start-${key}`, ["start", "--project", project, "--title", title, "--claude", prompt, "--json"]).stdout).id;
await until("each review is where the capture needs it", () => phase(started.holdReview) === "reviewing" && json(["show", started.holdReview]).review.outbox === null
  && phase(started.holdFixing) === "fixing" && phase(started.deploySlowly) === "deploying", 60_000);
const reviewers = Object.fromEntries(["holdReview", "holdFixing", "deploySlowly"].map((key) => [key, json(["show", started[key]]).review.reviewer]));
writeFileSync(join(out, "threads.json"), JSON.stringify({ builders: started, reviewers }, null, 2));

nexus("review-again-holdReview", ["review", started.holdReview]);
nexus("cancel-holdReview", ["review", "--cancel", started.holdReview]);
await sleep(3_000);
nexus("show-holdReview", ["show", started.holdReview]);
nexus("show-reviewer-holdReview", ["show", reviewers.holdReview]);
nexus("cancel-holdReview-again", ["review", "--cancel", started.holdReview]);

nexus("cancel-deploySlowly", ["review", "--cancel", started.deploySlowly]);
writeFileSync(join(out, "healthy"), "");
await until("the slow deploy landed", () => phase(started.deploySlowly) === "landed", 30_000);
nexus("show-deploySlowly", ["show", started.deploySlowly]);

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default ?? require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); log(`confirm: ${d.message()}`); await d.accept(); });
async function shot(name) {
  await page.evaluate(() => { document.querySelector('[data-pane="pylon"], #tab-pylon')?.click(); });
  await sleep(500);
  await page.screenshot({ path: join(out, name), fullPage: true });
  log(`screenshot ${name}`);
}
await page.goto(`http://127.0.0.1:7470/threads/${started.holdFixing}`);
await page.waitForSelector("#side-threads");
const button = await page.$('button[data-action="cancel-review"]');
log(`the review line of Hold in fixing offers ${button === null ? "no Cancel review button" : `"${await button.evaluate((b) => b.textContent)}"`}`);
await shot("01-hold-fixing-before.png");
if (button !== null) {
  await button.evaluate((b) => b.click());
  await until("the dashboard's cancel ended the review", () => phase(started.holdFixing) === "cancelled", 10_000);
  await page.reload();
  await page.waitForSelector("#side-threads");
  log(`after the click the review line offers ${(await page.$('button[data-action="cancel-review"]')) === null ? "no Cancel review button" : "Cancel review still"}`);
}
await shot("02-hold-fixing-after.png");
await browser.close();
nexus("show-holdFixing", ["show", started.holdFixing]);
nexus("show-reviewer-holdFixing", ["show", reviewers.holdFixing]);

as("control node");
const b = started.bystander;
for (const [name, args] of [
  ["abort", ["abort", b]], ["retry", ["retry", b]], ["retry-pylon", ["retry-pylon", b]],
  ["session-open", ["session", "open", b, "--harness", "shell"]], ["session-close", ["session", "close", b, "w1:p1"]],
  ["preview", ["preview", b, "3000"]], ["unpreview", ["unpreview", b, "3000"]],
  ["review", ["review", b]], ["review-cancel", ["review", "--cancel", b]],
  ["project-edit", ["project", "edit", "nexus-review", "--branch", "trunk"]],
  ["unarchive", ["unarchive", b]], ["archive", ["archive", b]], ["delete", ["delete", b]],
]) nexus(`node-${name}`, args);
{
  const r = spawnSync("script", ["-qec", `stty cols 100 rows 30; node src/cli/nexus.ts attach ${b}`, "/dev/null"], { cwd: process.env.ROOT, env, encoding: "utf8", timeout: 20_000 });
  save("node-attach", `$ nexus attach ${b}   (in a pty)\n${r.stdout}[exit ${r.status}]\n`);
}
as("person");
nexus("person-archive", ["archive", b]);
nexus("projects", ["projects"]);
nexus("threads", ["threads", "--all"]);
nexus("events-review", ["events", "--kind", "review.changed"]);
