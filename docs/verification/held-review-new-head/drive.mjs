// Drives the stack in stack.ts in headless Chromium and through the CLI, and saves what it saw in OUT: the held
// landing of PR #185, a rebased head pushed while it is held, the page before and after the PR watch reads that head,
// and what the review loop does next. The same driver runs on main and on the branch, and records whatever each shows.
//
//   OUT=... ROOT=<checkout> STACK='{...}' MODULES=... node docs/verification/held-review-new-head/drive.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const out = process.env.OUT;
const stack = JSON.parse(process.env.STACK);
const plain = "http://127.0.0.1:7470";
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const control = (path) => fetch(`http://127.0.0.1:7472${path}`, { method: "POST" });
const review = async () => (await (await fetch(`${plain}/v1/threads/${stack.builder}`)).json()).review;

writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 1000 } });
const page = await browser.newPage();
const seen = () => page.evaluate(() => ({
  landing: document.getElementById("landing")?.innerText.trim() ?? null,
  landButton: (() => { const b = document.getElementById("land"); return b === null ? "(no Land button)" : `${b.textContent} at ${b.dataset.head ?? "?"}${b.disabled ? " (disabled)" : ""}`; })(),
  review: [...document.querySelectorAll("p")].map((p) => p.innerText).filter((t) => t.startsWith("Nexus review") || t.startsWith("a new round")),
}));
const shot = async (name) => {
  await page.goto(`${plain}/threads/${stack.builder}`);
  await sleep(800);
  const r = await review();
  log(`${name}: the review is ${r.phase.kind} at round ${r.rounds.length}, head ${r.rounds.at(-1).head}\n${JSON.stringify(await seen(), null, 2)}`);
  await page.screenshot({ path: join(out, name), fullPage: true });
};
const cli = (name, args) => {
  const run = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env: { ...process.env, NEXUS_URL: plain, NEXUS_SOCKS: "none" }, encoding: "utf8" });
  writeFileSync(join(out, `${name}.txt`), `$ nexus ${args.join(" ")}\n${run.stdout}${run.stderr}exit ${run.status}\n`);
  log(`${name}.txt:\n${run.stdout}${run.stderr}`);
};
const until = async (done, ms) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(250)) if (done(await review())) return true;
  return false;
};

await shot("01-held.png");
cli("01-show", ["show", stack.builder]);

await control("/pause");
await control("/push");
await shot("02-pushed-before-the-watch-reads.png");

await control("/watch");
await shot("03-watch-read-before-the-loop.png");

await control("/resume");
log(`the loop started a round on ${stack.rebasedHead}: ${await until((r) => r.rounds.length > 1, 8_000)}`);
await shot("04-after-the-loop.png");
cli("04-show", ["show", stack.builder]);

log(`the review ended again: ${await until((r) => r.rounds.length > 1 && ["needs-person", "approved", "landed"].includes(r.phase.kind), 20_000)}`);
await shot("05-held-again.png");
cli("05-show", ["show", stack.builder]);
cli("06-events-review", ["events", "--thread", stack.builder, "--kind", "review.changed"]);
await browser.close();
