// Drives the stack in stack.ts in headless Chromium and saves what it saw in OUT. On both runs it reads the home page
// and a held review's thread page at a laptop's 1280 by 860 and a phone's 390 by 844, says what each tab's title was,
// and has a thread fail while a thread page is open, to show where its notice leads. Where the page has Needs you, it
// answers a question, answers Claude's AskUserQuestion, archives a thread stopped on its usage limit, and lands a
// review, each from its card, and screenshots the list after each. A browser's confirmation dialog is not part of a
// screenshot, so the driver puts what the dialog said in a dashed yellow box, marked as its own.
//
//   OUT=... STACK='{"held":...}' MODULES=... node docs/verification/needs-you/drive.mjs
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const out = process.env.OUT;
const ids = JSON.parse(process.env.STACK);
const base = "http://127.0.0.1:7470";
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const desk = { width: 1280, height: 860 };
const phone = { width: 390, height: 844, isMobile: true, hasTouch: true };

writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: desk });
const page = await browser.newPage();
let asked = null;
page.on("dialog", async (dialog) => {
  asked = dialog.message();
  log(`the page asked: ${JSON.stringify(asked)}, and the driver pressed OK`);
  await dialog.accept();
});
page.on("pageerror", (err) => log(`page error: ${err.message}`));

const box = (text) => page.evaluate((text) => {
  const div = document.createElement("div");
  div.id = "drive-box";
  div.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:200;max-width:min(560px,calc(100vw - 24px));padding:12px 16px;background:#fff8c5;color:#111;border:2px dashed #b08800;border-radius:6px;font:14px/1.5 system-ui,sans-serif";
  div.textContent = text;
  document.body.append(div);
}, text);
const shot = async (name, note) => {
  if (note !== undefined) await box(note);
  await page.screenshot({ path: join(out, name) });
  if (note !== undefined) await page.evaluate(() => document.getElementById("drive-box").remove());
  log(`screenshot ${name}`);
};
const open = async (path) => {
  await page.goto(`${base}${path}`);
  await page.waitForSelector("main");
  await sleep(600);
};
/** What a person reading the page sees of what waits on them. */
const seen = () => page.evaluate(() => ({
  title: document.title,
  count: document.getElementById("needs-count")?.textContent ?? "(no Needs you in the sidebar)",
  cards: [...document.querySelectorAll(".need")].map((c) => `${c.querySelector(".need-what").textContent}: ${c.querySelector(".need-thread").textContent}`),
  error: document.getElementById("action-error")?.hidden === false ? document.getElementById("action-error").textContent : null,
}));
/** Waits for the next poll to take the card off the list, or 12 s. */
async function gone(selector) {
  for (const deadline = Date.now() + 12_000; Date.now() < deadline; await sleep(250)) if (await page.$(selector) === null) return true;
  return false;
}

await open("/");
const inbox = await page.$("#needs-you") !== null;
log(`home page, laptop: ${JSON.stringify(await seen(), null, 2)}`);
await shot("01-home.png");
await page.setViewport({ ...desk, height: 3000 });
await sleep(300);
await shot("02-home-whole.png");
await page.setViewport(desk);
await open(`/threads/${ids.reserved}`);
log(`a held review's own page: title ${JSON.stringify(await page.title())}`);
await shot("03-held-thread-page.png");
await page.setViewport(phone);
await open("/");
await shot("04-phone-home.png");
await open(`/threads/${ids.reserved}`);
await shot("05-phone-thread-page.png");
await page.setViewport(desk);

if (inbox) {
  await open("/");
  const before = await seen();
  await page.click('.need button[data-action="answer"][data-question="qn-image"][data-option="Rebuild"]');
  const answered = await gone('.need [data-question="qn-image"]');
  log(`answered qn-image from its card; the card ${answered ? "left the list" : "is still there"}: ${JSON.stringify({ before: before.count, after: await seen() }, null, 2)}`);
  await shot("06-answered-question.png", `Added by drive.mjs. The driver pressed Rebuild on the question's card. The browser asked: "${asked}" and the driver pressed OK. The count went from ${before.count} to ${(await seen()).count}.`);

  const form = `.need form.ask[data-thread="${ids.ask}"]`;
  await page.click(`${form} input[name="picked-0"][value="Inter"]`);
  await page.click(`${form} input[name="picked-1"][value="16"]`);
  await page.type(`${form} input[name="notes-0"]`, "for the body text");
  await shot("07-ask-filled.png");
  await page.click(`${form} button[type=submit]`);
  const took = await gone(form);
  log(`answered Claude's ask from its card; the card ${took ? "left the list" : "is still there"}: ${JSON.stringify(await seen(), null, 2)}`);
  await shot("08-answered-ask.png", `Added by drive.mjs. The browser asked: "${asked}" and the driver pressed OK. hook.log shows what the pylon's hook was handed.`);

  await page.click(`.need[data-thread="${ids.limited}"] button[data-action="archive"]`);
  const archived = await gone(`.need[data-thread="${ids.limited}"]`);
  log(`archived the thread stopped on its usage limit from its card; the card ${archived ? "left the list" : "is still there"}: ${JSON.stringify(await seen(), null, 2)}`);

  const land = `#land-${ids.reserved}`;
  await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: "center" }), land);
  await shot("09-land-card.png");
  await page.click(land);
  const landing = await gone(`.need[data-thread="${ids.reserved}"]`);
  log(`pressed Land on #42's card; the card ${landing ? "left the list" : "is still there"}: ${JSON.stringify(await seen(), null, 2)}`);
  await page.evaluate(() => document.querySelector(".scroll").scrollTo(0, 0));
  await shot("10-after-landing.png", `Added by drive.mjs. The browser asked: "${asked}" and the driver pressed OK.`);
  await open(`/threads/${ids.reserved}`);
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(500)) {
    const r = (await (await fetch(`${base}/v1/threads/${ids.reserved}`)).json()).review;
    if (r.phase.kind === "landed" || r.phase.kind === "needs-person") { log(`#42's review is ${r.phase.kind}, waiver ${JSON.stringify(r.waiver)}`); break; }
  }
  await sleep(6000);
  await shot("11-landed-thread-page.png");
}

await open(`/threads/${ids.held}`);
const failed = await (await fetch("http://127.0.0.1:7489/verify/fail", { method: "POST" })).json();
let toast = null;
for (const deadline = Date.now() + 15_000; Date.now() < deadline && toast === null; await sleep(250)) toast = await page.$(".attention-toast");
log(`a thread failed while a thread page was open: ${toast === null ? "no toast showed" : `the toast said ${JSON.stringify(await toast.evaluate((t) => t.innerText))} and opens ${await toast.$eval("a", (a) => a.getAttribute("href"))}`}`);
await shot("12-notice.png");
if (toast !== null) {
  await Promise.all([page.waitForNavigation(), toast.$eval("a", (a) => a.click())]);
  await sleep(800);
  log(`the toast's Open went to ${page.url()}, where ${await page.evaluate(() => document.querySelector(".need.picked")?.id ?? "no card is picked")} is picked and focus is on ${await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)}`);
  await shot("13-notice-opened.png");
}
log(`the failed thread was ${failed.id}; with things waiting, the tab's title is ${JSON.stringify(await page.title())} and its icon is ${await page.$eval('link[rel="icon"]', (l) => l.getAttribute("href").slice(0, 40))}`);

await page.setViewport(phone);
await open("/");
log(`home page, phone, at the end: ${JSON.stringify(await seen(), null, 2)}`);
await shot("14-phone-home-after.png");
await browser.close();
