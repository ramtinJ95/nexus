// Captures a thread's page on the stack in ../claude-thread-streaming/stack.ts, scrolled to its first pull request
// link, and saves the links' markup. MODULES names a node_modules with @sparticuz/chromium and puppeteer-core. The
// package unpacks the libraries its Chromium needs only on AWS Lambda, so AWS_EXECUTION_ENV says it runs there.
//
//   AWS_EXECUTION_ENV=AWS_Lambda_nodejs20.x LD_LIBRARY_PATH=/tmp/al2023/lib MODULES=... node docs/verification/cli-contract-fixes/shot.mjs <thread>
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const out = new URL(".", import.meta.url).pathname;
const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:7470/threads/${process.argv[2]}`);
await page.waitForSelector("#convo");
const links = await page.$$eval("#convo a[href*='/pull/']", (all) => all.map((a) => a.outerHTML));
writeFileSync(join(out, "dashboard-pull-request.json"), `${JSON.stringify(links, null, 2)}\n`);
await page.evaluate(() => document.querySelector("#convo a[href*='/pull/']")?.scrollIntoView({ block: "center" }));
await page.screenshot({ path: join(out, "dashboard-pull-request.png") });
console.log(`${links.length} pull request links`);
await browser.close();
