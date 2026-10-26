// Drives the stack in stack.ts in headless Chromium and saves what it saw here: the home page and a thread page with
// rows dimmed by attention and the working clocks ticking, and both conversation kinds with their tool runs folded
// and one fold opened. Chromium and puppeteer-core come from the npm packages @sparticuz/chromium and puppeteer-core,
// installed outside the repo, whose node_modules MODULES names. The stack prints the thread IDs this reads from IDS.
//
//   MODULES=... IDS='{"loop":...}' node docs/verification/dashboard-polish/drive.mjs
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const out = new URL(".", import.meta.url).pathname;
const base = "http://127.0.0.1:7470";
const ids = JSON.parse(process.env.IDS);
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };

writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const shot = async (name) => { await page.screenshot({ path: join(out, name) }); log(`screenshot ${name}`); };
const requests = [];
page.on("request", (r) => requests.push(r.url()));

const rows = () => page.$$eval("#side-threads a.row", (as) => as.map((a) => ({
  title: a.querySelector(".row-title")?.textContent, at: a.querySelector(".row-at")?.textContent,
  opacity: getComputedStyle(a.querySelector(".row-title")).opacity, dim: a.className,
})));
const clocks = () => page.$$eval("time[data-since]", (ts) => ts.map((t) => t.textContent));

await page.goto(`${base}/`);
await page.waitForSelector("#overview");
log(`sidebar rows: ${JSON.stringify(await rows())}`);
const before = await clocks();
requests.length = 0;
await new Promise((r) => setTimeout(r, 3000));
const after = await clocks();
log(`clocks before ${JSON.stringify(before)} after 3 s ${JSON.stringify(after)}, requests meanwhile ${JSON.stringify(requests)}`);
assert.notDeepEqual(before, after, "the working clocks tick without a reload");
assert.ok(requests.every((url) => url === `${base}/v1/threads`), "the clocks add no request: only the attention poll that runs every second anyway");
await shot("01-home.png");

const quiet = await page.$(`#side-threads a[href="/threads/${ids.quiet}"]`);
await quiet.hover();
await new Promise((r) => setTimeout(r, 400));
log(`hovered dim row opacity ${await page.$eval(`#side-threads a[href="/threads/${ids.quiet}"] .row-title`, (e) => getComputedStyle(e).opacity)}`);
await shot("02-dim-row-hovered.png");
await page.click(`#side-threads a[href="/threads/${ids.quiet}"]`);
await page.waitForFunction((id) => location.pathname === `/threads/${id}`, {}, ids.quiet);
log(`clicking a dimmed row opened ${await page.evaluate(() => location.pathname)}`);

await page.goto(`${base}/threads/${ids.loop}`);
await page.waitForSelector("#convo .steps");
log(`harness folds: ${JSON.stringify(await page.$$eval("#convo .steps .s-names", (s) => s.map((e) => e.textContent)))}`);
log(`harness run bar: ${await page.$eval("#run", (e) => e.textContent.trim().replace(/\s+/g, " "))}`);
await shot("03-harness-conversation.png");
await page.click("#convo details.steps:not([open]) > summary");
await shot("04-harness-fold-open.png");

await page.goto(`${base}/threads/${ids.flaky}`);
await page.waitForSelector("#convo .steps");
log(`claude folds: ${JSON.stringify(await page.$$eval("#convo .steps .s-names", (s) => s.map((e) => e.textContent)))}`);
log(`claude run bar: ${await page.$eval("#run", (e) => e.textContent.trim().replace(/\s+/g, " "))}`);
await page.click("#convo details.steps:not([open]) > summary");
await shot("05-claude-fold-open.png");

await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await page.goto(`${base}/`);
await page.waitForSelector("#overview");
await shot("06-home-dark.png");
await browser.close();
