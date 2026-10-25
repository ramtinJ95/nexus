// The second half of drive.mjs, for the thread it started: pauses the thread's pylon, reads and steers it while
// paused, and wakes it, through the same surfaces. Drives the stack in stack.ts through the person's surfaces: the dashboard in headless Chromium and the Mac CLI. It
// starts a Claude Code thread from the start dialog, follows the thread's stream while the turn runs, steers Claude
// from the composer mid-turn and with `nexus send` after the turn, pauses and wakes the pylon, and saves what it saw
// here. Chromium and puppeteer-core come from the npm packages @sparticuz/chromium and puppeteer-core, installed
// outside the repo: MODULES names their node_modules, and LD_LIBRARY_PATH and FONTCONFIG_PATH their libraries.
//
//   MODULES=... node docs/verification/claude-thread-streaming/drive.mjs
import { execFile } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const out = new URL(".", import.meta.url).pathname;
const base = "http://127.0.0.1:7470";
const run = promisify(execFile);
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${new Date().toISOString()} ${line}\n`); };
const nexus = (...args) => run("node", ["src/cli/nexus.ts", ...args], { env: { ...process.env, NEXUS_URL: base, NEXUS_SOCKS: "none" }, maxBuffer: 1 << 24 });
const api = async (path) => (await fetch(`${base}${path}`)).json();
const until = async (what, check, ms = 600_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 1000))) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};

const thread = process.env.THREAD;
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const shot = async (name) => { await page.screenshot({ path: join(out, name) }); log(`screenshot ${name}`); };
const conversation = () => api(`/v1/threads/${thread}/conversation`);
await page.goto(`${base}/threads/${thread}`);
await fetch(`http://127.0.0.1:7489/verify/pause/${thread}`, { method: "POST" });
await page.reload();
await page.evaluate(() => document.getElementById("scroll").scrollTo(0, 1e9));
await shot("07-paused.png");
writeFileSync(join(out, "paused-detail.json"), JSON.stringify(await api(`/v1/threads/${thread}`), null, 2));
writeFileSync(join(out, "cli-conversation-paused.txt"), (await nexus("conversation", thread)).stdout);
const woken = nexus("send", thread, "One more, after a wake: reply with the word awake.", "--json");
await new Promise((r) => setTimeout(r, 4000));
writeFileSync(join(out, "activity-while-paused.json"), JSON.stringify((await api(`/v1/threads/${thread}`)).thread, null, 2));
await fetch(`http://127.0.0.1:7489/verify/run/${thread}`, { method: "POST" });
const wokenOut = await woken;
writeFileSync(join(out, "cli-send-while-paused.json"), wokenOut.stdout);
log(`nexus send while paused, then woken: ${wokenOut.stdout.trim()}`);
await until("the reply after the wake", async () => (await conversation()).entries.some((e) => e.kind === "reply" && /awake/i.test(e.text)));
await page.reload();
await page.evaluate(() => document.getElementById("scroll").scrollTo(0, 1e9));
await shot("08-after-wake.png");
await page.setViewport({ width: 390, height: 844, isMobile: true });
await page.reload();
await shot("09-phone.png");
await browser.close();
log("done");
process.exit(0);
