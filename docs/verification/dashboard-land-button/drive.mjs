// Drives the stack in stack.ts in headless Chromium and through the CLI, and saves what it saw in OUT. It reads each
// held or approved builder's page as a deployer, on a laptop-sized and a phone-sized window, and as a device that is
// not a deployer, and lands two reviews: through the page's Land button where the page has one, and with `nexus land`
// where it has none. It screenshots the page at every phase the review moves to. A browser's confirmation dialog is
// not part of a screenshot, so the driver adds a dashed yellow box, marked as added by this script, that shows what
// the dialog said.
//
//   OUT=... ROOT=<checkout> IDS='{"held":...}' MODULES=... node docs/verification/dashboard-land-button/drive.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const out = process.env.OUT;
const ids = JSON.parse(process.env.IDS);
const base = "http://127.0.0.1:7470";
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const as = (node) => fetch("http://127.0.0.1:7489/verify/caller", { method: "POST", body: JSON.stringify({ node }) });
const review = async (thread) => (await (await fetch(`${base}/v1/threads/${thread}`)).json()).review;

writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 860 } });
const page = await browser.newPage();
let dialogs = [];
let asked = null;
page.on("dialog", async (dialog) => {
  const answer = dialogs.shift() ?? "dismiss";
  asked = dialog.message();
  log(`the page asked: ${JSON.stringify(dialog.message())}, and the driver chose ${answer}`);
  await dialog[answer]();
});

/** What a person reading the page sees of the landing, and of the review anywhere on the page. */
const seen = () => page.evaluate(() => ({
  landing: document.getElementById("landing")?.innerText.trim() ?? "(the page has no landing region)",
  landButton: (() => { const b = document.getElementById("land"); return b === null ? "(no Land button)" : `${b.textContent}${b.disabled ? " (disabled)" : ""}`; })(),
  error: document.getElementById("action-error")?.hidden === false ? document.getElementById("action-error").textContent : null,
  reviewLine: [...document.querySelectorAll("#pane-pylon p")].map((p) => p.innerText).find((t) => t.startsWith("Nexus review")) ?? null,
}));
const box = (text) => page.evaluate((text) => {
  const div = document.createElement("div");
  div.id = "drive-box";
  div.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:200;max-width:min(560px,calc(100vw - 24px));padding:12px 16px;background:#fff8c5;color:#111;border:2px dashed #b08800;border-radius:6px;font:14px/1.5 system-ui,sans-serif";
  div.textContent = text;
  document.body.append(div);
}, text);
const shot = async (name, note) => {
  if (note !== undefined) await box(note);
  await page.screenshot({ path: join(out, name) });
  if (note !== undefined) await page.evaluate(() => document.getElementById("drive-box").remove());
  log(`screenshot ${name}`);
};
const open = async (thread) => {
  await page.goto(`${base}/threads/${thread}`);
  await page.waitForSelector("#composer");
  await sleep(500);
};

const cli = (name, args) => {
  const run = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env: { ...process.env, NEXUS_URL: base, NEXUS_SOCKS: "none" }, encoding: "utf8" });
  const text = `$ nexus ${args.join(" ")}\n${run.stdout}${run.stderr}exit ${run.status}\n`;
  writeFileSync(join(out, `${name}.txt`), text);
  log(text);
};

/**
 * Screenshots the page each time the review's phase changes, once the page shows the change or its next poll has
 * passed, until the review ends or a minute passes.
 */
async function follow(thread, prefix) {
  let last = null;
  let shown = JSON.stringify(await seen());
  let n = 0;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    const r = await review(thread);
    if (r.phase.kind !== last) {
      last = r.phase.kind;
      for (const by = Date.now() + 6_000; Date.now() < by && JSON.stringify(await seen()) === shown;) await sleep(200);
      shown = JSON.stringify(await seen());
      log(`${prefix}: the review is ${last} ${JSON.stringify(await seen(), null, 2)}`);
      await shot(`${prefix}-${++n}-${last}.png`);
      if (["landed", "needs-person", "approved"].includes(last)) return;
    }
    await sleep(250);
  }
  log(`${prefix}: the review did not end within a minute`);
}

/** Lands the thread's review the way this checkout lets the person: the page's Land button, or else the CLI. */
async function land(thread, prefix) {
  await open(thread);
  const button = await page.$("#land:not([disabled])");
  if (button === null) {
    log(`${prefix}: the page has no Land button, so the person lands it from a terminal`);
    cli(`${prefix}-0-nexus-land`, ["land", thread]);
  } else {
    dialogs = ["dismiss"];
    await button.click();
    await sleep(1500);
    const phase = (await review(thread)).phase.kind;
    log(`${prefix}: after Cancel the review is still ${phase}`);
    await shot(`${prefix}-0-confirm.png`, `Added by drive.mjs. The browser's confirmation dialog said: "${asked}" The driver pressed Cancel, and the review is still ${phase}.`);
    dialogs = ["accept"];
    await page.click("#land");
  }
  await follow(thread, prefix);
}

await as(ids.laptop);
await open(ids.held);
log(`held, as a deployer ${JSON.stringify(await seen(), null, 2)}`);
await shot("01-held.png");
await page.click('input[name="pane"][value="pylon"]');
await sleep(300);
await shot("01-held-pylon-tab.png");
await open(ids.reserved);
log(`reserved, as a deployer ${JSON.stringify(await seen(), null, 2)}`);
await shot("02-reserved.png");
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await open(ids.held);
await shot("03-held-phone.png");
await page.setViewport({ width: 1280, height: 860 });

await as(ids.phone);
await open(ids.refused);
log(`refused, as a device that is not a deployer ${JSON.stringify(await seen(), null, 2)}`);
await shot("04-not-deployer.png");
await as(ids.laptop);
await open(ids.refused);
await as(ids.phone);
const stale = await page.$("#land:not([disabled])");
if (stale === null) log("refused: the page has no Land button to press");
else {
  dialogs = ["accept"];
  await stale.click();
  await sleep(1500);
  log(`refused, pressed on a page loaded as a deployer after whois changed to the phone ${JSON.stringify(await seen(), null, 2)}`);
  await shot("05-not-deployer-pressed.png");
}
cli("06-nexus-land-not-deployer", ["land", ids.refused]);
log(`refused: the review is still ${(await review(ids.refused)).phase.kind}`);
await as(ids.laptop);

await land(ids.held, "07-land");
await land(ids.approved, "08-rollback");
await browser.close();

cli("09-show-landed", ["show", ids.held]);
cli("10-events-landed", ["events", "--thread", ids.held, "--kind", "review.changed"]);
cli("11-show-rolled-back", ["show", ids.approved]);
cli("12-nexus-land-reserved", ["land", ids.reserved]);
for (const deadline = Date.now() + 30_000; Date.now() < deadline && (await review(ids.reserved)).phase.kind !== "needs-person";) await sleep(500);
cli("13-show-reserved-after-land", ["show", ids.reserved]);
