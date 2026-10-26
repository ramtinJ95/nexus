// Opens each thread's Changes pane in the stack's dashboard in headless Chromium, turns on Latest turn, and saves what
// it shows here. Chromium and puppeteer-core come from the npm packages @sparticuz/chromium and puppeteer-core,
// installed outside the repo, whose node_modules MODULES names.
//
//   MODULES=... node docs/verification/claude-turn-snapshots/drive.mjs <snapshotted thread> <old-hook thread>
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const out = new URL(".", import.meta.url).pathname;
const [snapshotted, oldHook] = process.argv.slice(2);
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };

writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
for (const [thread, shot] of [[snapshotted, "01-latest-turn.png"], [oldHook, "02-old-hook-refused.png"]]) {
  await page.goto(`http://127.0.0.1:7472/threads/${thread}`);
  // The page keeps the base it was last shown with, so only the first thread needs the switch turned on.
  if (!await page.$eval("#changes-turn", (e) => e.checked)) await page.click("#changes-turn");
  await page.waitForSelector("#changes-body .error, #changes-body .tree");
  const file = await page.$("#changes-body .tree-file");
  if (file !== null) {
    await file.click();
    await page.waitForSelector("#file-view .diff-view", { timeout: 10_000 }).catch(() => log("no diff view appeared"));
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  log(`${thread} with Latest turn on: ${await page.$eval("#changes-base", (e) => e.innerText)}`);
  log((await page.$eval("#changes-body", (e) => e.innerText)).trim());
  await page.screenshot({ path: join(out, shot) });
  log(`screenshot ${shot}`);
}
await browser.close();
