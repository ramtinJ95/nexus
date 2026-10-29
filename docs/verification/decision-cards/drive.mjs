// Drives the stack in stack.ts in headless Chromium and saves what it saw in OUT. On both runs it opens each decision
// source's thread page at a laptop's 1280 by 860, and the silent reviewer's and the hand-merged PR's at a phone's 390 by
// 844, and logs the header chip and the dock's cards and buttons. It then reads Needs you at both sizes. Where the
// buttons exist, it presses Review again on the silent reviewer's page, Cancel review on the hand-merged PR's card in
// Needs you, and Write to it on the nudged builder's card, and logs what each left. A browser's confirmation dialog is not
// part of a screenshot, so the driver puts what the dialog said in a dashed yellow box, marked as its own.
//
//   OUT=... STACK='{"silent":...}' MODULES=... node docs/verification/decision-cards/drive.mjs
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
  div.style.cssText = "position:fixed;top:200px;left:50%;transform:translateX(-50%);z-index:200;max-width:min(560px,calc(100vw - 24px));padding:12px 16px;background:#fff8c5;color:#111;border:2px dashed #b08800;border-radius:6px;font:14px/1.5 system-ui,sans-serif";
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
/** The header chip, and each card in the dock with its heading and the actions it offers. */
const threadSeen = () => page.evaluate(() => ({
  chip: document.querySelector(".chip-label")?.textContent ?? null,
  cards: [...document.querySelectorAll(".dock section.landing")].map((s) => ({
    heading: s.querySelector("h2")?.textContent ?? null,
    actions: [...s.querySelectorAll("button, a.btn")].map((b) => `${b.textContent.trim()}${b.disabled ? " (disabled)" : ""}`),
  })),
}));
const needsSeen = () => page.evaluate(() => ({
  count: document.getElementById("needs-count")?.textContent ?? "(no Needs you)",
  cards: [...document.querySelectorAll(".need")].map((c) => `${c.querySelector(".need-what").textContent}: ${c.querySelector(".need-thread").textContent.trim()} [${[...c.querySelectorAll("button, a.btn")].map((b) => b.textContent.trim()).join(", ")}]`),
}));
/** Brings the dock's cards into view, since the conversation above them is empty. */
const toDock = () => page.evaluate(() => document.querySelector(".dock")?.scrollIntoView({ block: "end" }));

const sources = [
  ["silent", "01-silent-reviewer"], ["mergedByHand", "02-merged-by-hand"], ["rolledBack", "03-merged-not-deployed"], ["held", "04-held-landable"],
  ["nudged", "05-nudged"], ["question", "06-question"], ["planning", "07-proposal"],
];
for (const [key, name] of sources) {
  await open(`/threads/${ids[key]}`);
  await toDock();
  log(`${key} at 1280: ${JSON.stringify(await threadSeen())}`);
  await shot(`${name}.png`);
}
await page.setViewport(phone);
for (const [key, name] of sources.slice(0, 2)) {
  await open(`/threads/${ids[key]}`);
  await toDock();
  log(`${key} at 390: ${JSON.stringify(await threadSeen())}`);
  await shot(`${name}-phone.png`);
}
await open("/");
log(`Needs you at 390: ${JSON.stringify(await needsSeen())}`);
await shot("08-needs-you-phone.png");
await page.setViewport(desk);
await open("/");
log(`Needs you at 1280: ${JSON.stringify(await needsSeen())}`);
await shot("09-needs-you.png");

await open(`/threads/${ids.silent}`);
const again = await page.$('[data-action="review-again"]');
if (again === null) log("the silent reviewer's page has no Review again");
else {
  await again.click();
  await page.waitForFunction(() => document.querySelector('[data-action="review-again"]') === null, { timeout: 15_000 });
  await sleep(1_500);
  await toDock();
  log(`after Review again: ${JSON.stringify(await threadSeen())}`);
  const review = await (await fetch(`${base}/v1/threads/${ids.silent}`)).json();
  log(`the review is now ${review.review.id}, ${review.review.phase.kind}, round ${review.review.rounds.length}, reviewer ${review.review.reviewer}, land ${JSON.stringify(review.review.land)}`);
  await shot("10-after-review-again.png", `The driver pressed Review again and OK on: ${asked}`);
}

await open("/");
const cancel = await page.$(`.need[data-thread="${ids.mergedByHand}"] [data-action="cancel-review"]`);
if (cancel === null) log("the hand-merged PR's Needs you card has no Cancel review");
else {
  await cancel.click();
  await page.waitForFunction((id) => document.querySelector(`.need[data-thread="${id}"]`) === null, { timeout: 15_000 }, ids.mergedByHand);
  log(`after Cancel review: ${JSON.stringify(await needsSeen())}`);
  await shot("11-after-cancel.png", `The driver pressed Cancel review on the hand-merged PR's card and OK on: ${asked}`);
  await open(`/threads/${ids.mergedByHand}`);
  log(`its page after Cancel review: ${JSON.stringify(await threadSeen())}`);
}

await open("/");
const write = await page.$(`.need[data-thread="${ids.nudged}"] a[data-write]`);
if (write === null) log("the nudged builder's Needs you card has no Write to it");
else {
  await Promise.all([page.waitForNavigation(), write.click()]);
  await sleep(600);
  log(`Write to it opened ${new URL(page.url()).pathname}${new URL(page.url()).hash}, with the focus on #${await page.evaluate(() => document.activeElement?.id)}`);
  await shot("12-write-to-it.png");
}
await browser.close();
