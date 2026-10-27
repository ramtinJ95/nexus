// Drives the stack in stack.ts through the CLI and in headless Chromium, and saves what it saw in OUT. PHASE 1 runs on
// the stack's first start: the totals against the hand sum, the Usage page, a thread's own totals, and a transcript
// read again. PHASE 2 runs after run.sh restarted the stack on the same registry: the totals after the restart, and
// after deleting the Claude worker thread, whose pylon's disk goes with it. The same driver runs on main and on the
// branch, and records whatever each one shows and answers.
//
//   OUT=... ROOT=<checkout> STACK='{...}' PHASE=1|2 MODULES=... node docs/verification/token-usage/drive.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const out = process.env.OUT;
const phase = process.env.PHASE;
const stack = JSON.parse(process.env.STACK);
const base = "http://127.0.0.1:7470";
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, text) => { writeFileSync(join(out, name), text); log(text); };

// Summed by hand from the fixtures and the scripted model, as README.md shows.
const claudeWorker = { calls: 9, input: 20, output: 1523, cacheWrite: 37665, cacheRead: 293246 };
const piReviewer = { calls: 2, input: 1723 + 204, output: 5 + 5, cacheWrite: 0, cacheRead: 1536 };
const scripted = { calls: 1, input: 1234, output: 56, cacheWrite: 890, cacheRead: 7000 };
const handSum = Object.fromEntries(Object.keys(claudeWorker).map((k) => [k, claudeWorker[k] + piReviewer[k] + 3 * scripted[k]]));
handSum.total = handSum.input + handSum.output + handSum.cacheWrite + handSum.cacheRead;

const cli = (name, args) => {
  const run = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env: { ...process.env, NEXUS_URL: base, NEXUS_SOCKS: "none" }, encoding: "utf8" });
  save(`${name}.txt`, `$ nexus ${args.join(" ")}\n${run.stdout}${run.stderr}exit ${run.status}\n`);
  return run;
};
const apiTotal = async () => {
  const res = await fetch(`${base}/v1/usage?since=all&by=kind`);
  return res.status === 200 ? (await res.json()).total : `GET /v1/usage answered ${res.status}`;
};
const compare = (what, seen, expected) => typeof seen === "string" || typeof expected === "string"
  ? `${what}: nothing to compare, as ${typeof seen === "string" ? seen : expected}\n`
  : `${what}: ${JSON.stringify(seen)}\nexpected:  ${JSON.stringify(expected)}\n${JSON.stringify(seen) === JSON.stringify(expected) ? "MATCH" : "DIFFERENT"}\n`;
const ordered = (t) => typeof t === "string" ? t : { calls: t.calls, input: t.input, output: t.output, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, total: t.total };

if (phase === "1") writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 1000 } });
const page = await browser.newPage();
const open = async (path) => {
  const res = await page.goto(`${base}${path}`);
  await sleep(500);
  return res.status();
};
const shot = async (name, fullPage = true) => {
  await page.screenshot({ path: join(out, name), fullPage });
  log(`screenshot ${name}`);
};
/** The exact counts the Usage page's totals row carries, or what the page says instead. */
const pageTotals = () => page.evaluate(() => {
  const cells = [...document.querySelectorAll("#usage-totals [data-tokens]")];
  if (cells.length === 0) return `no totals on the page, which says: ${document.body.innerText.slice(0, 200)}`;
  return Object.fromEntries(cells.map((c) => [c.dataset.column ?? c.cellIndex, Number(c.dataset.tokens)]));
});

if (phase === "1") {
  save("01-hand-sum.txt", `Claude worker transcript: ${JSON.stringify(claudeWorker)}\npi reviewer session:      ${JSON.stringify(piReviewer)}\n3 scripted answers:       3 × ${JSON.stringify(scripted)}\nhand sum:                 ${JSON.stringify(handSum)}\n`);
  cli("02-cli-usage", ["usage", "--since", "all"]);
  cli("02-cli-usage-json", ["usage", "--since", "all", "--json"]);
  cli("02-cli-usage-by-model", ["usage", "--since", "all", "--by", "model"]);
  save("03-api-total.txt", compare("GET /v1/usage total", ordered(await apiTotal()), handSum));
  log(`GET /usage?period=all answered ${await open("/usage?period=all")}`);
  await shot("04-usage-all.png");
  save("04-page-totals.txt", `the Usage page's totals row, from its data-tokens attributes:\n${JSON.stringify(await pageTotals())}\nhand sum: ${JSON.stringify(handSum)}\n`);
  await open("/usage?period=today");
  await shot("05-usage-today.png");
  await open("/");
  await shot("06-home-nav.png", false);
  await open(`/threads/${stack.claude}`);
  await page.click('label.seg-tab:has(input[value="pylon"])');
  await sleep(300);
  await shot("07-thread-claude.png", false);
  save("07-thread-totals.txt", await page.evaluate(() => document.getElementById("thread-usage")?.outerHTML ?? "no #thread-usage on the thread page"));
  const before = await apiTotal();
  await fetch("http://127.0.0.1:7489/verify/reread", { method: "POST" });
  await sleep(4000);
  save("08-reread.txt", `The stack appended the Claude worker's transcript to itself and reported its turn's end.\n${compare("total after the read", ordered(await apiTotal()), ordered(before))}`);
  writeFileSync(join(out, "phase-1-total.json"), JSON.stringify(await apiTotal()));
} else {
  const before = JSON.parse(readFileSync(join(out, "phase-1-total.json"), "utf8"));
  await sleep(2000);
  save("09-restart.txt", `The stack was stopped and started again on the same registry and harness storage.\n${compare("total after the restart", ordered(await apiTotal()), ordered(before))}`);
  cli("10-cli-delete", ["delete", stack.claude]);
  await sleep(3000);
  save("10-delete.txt", `${compare("total after deleting the Claude worker thread", ordered(await apiTotal()), ordered(before))}`);
  cli("10-cli-usage-after-delete", ["usage", "--since", "all", "--by", "project"]);
  await open("/usage?period=all");
  await shot("11-usage-after-restart-and-delete.png");
  await open("/usage?period=all&project=spoon");
  await shot("12-usage-project-spoon.png");
  await page.setViewport({ width: 390, height: 844 });
  await open("/usage?period=7d");
  await shot("13-usage-phone.png");
}
await browser.close();
