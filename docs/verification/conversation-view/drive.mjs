// Captures each thread of stack.ts at a desktop and a phone width: the whole conversation as one tall image, then
// the conversation with its first fold of calls and the call with the longest output opened, then that output shown
// in full where the page clips it. OUT is the folder for the captures, STACK the
// thread IDs stack.ts printed, and MODULES the node_modules that hold @sparticuz/chromium and puppeteer-core.
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const out = process.env.OUT;
const ids = JSON.parse(process.env.STACK);
const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
writeFileSync(join(out, "drive.log"), "");

const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
const widths = { desktop: { width: 1360, height: 900 }, phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The conversation's scroller grown to show all of it, so one screenshot holds the whole conversation. */
async function tall(page, viewport, file) {
  const height = await page.evaluate(() => {
    const scroll = document.getElementById("scroll");
    return document.documentElement.clientHeight + scroll.scrollHeight - scroll.clientHeight;
  });
  await page.setViewport({ ...viewport, height: Math.min(height, 12_000) });
  await sleep(300);
  await page.screenshot({ path: join(out, file) });
  await page.setViewport(viewport);
  return height;
}

try {
  for (const [name, id] of Object.entries(ids)) {
    for (const [width, viewport] of Object.entries(widths)) {
      const page = await browser.newPage();
      await page.setViewport(viewport);
      await page.goto(`http://127.0.0.1:7470/threads/${id}`, { waitUntil: "load" });
      await sleep(1500);
      const height = await tall(page, viewport, `${name}-${width}-all.png`);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      log(`${name} ${width}: the conversation is ${height} px tall${sideways ? ", and the page scrolls sideways" : ""}`);
      if (width === "desktop") {
        const text = await page.evaluate(() => document.getElementById("convo").innerText);
        writeFileSync(join(out, `${name}.txt`), `${text.replace(/\n{3,}/g, "\n\n")}\n`);
      }

      const opened = await page.evaluate(() => {
        const fold = [...document.querySelectorAll("#convo details.steps")].find((d) => !d.open);
        if (fold !== undefined) fold.querySelector(":scope > summary").click();
        const output = (tool) => [...tool.querySelectorAll("pre.t-out")].map((pre) => pre.textContent).join("\n");
        const tools = [...document.querySelectorAll("#convo details.tool")];
        const longest = tools.sort((a, b) => output(b).length - output(a).length)[0];
        if (longest === undefined) return null;
        longest.closest("details.steps")?.setAttribute("open", "");
        if (!longest.open) longest.querySelector(":scope > summary").click();
        longest.scrollIntoView({ block: "start" });
        const shown = [...longest.querySelectorAll("pre.t-out")].filter((pre) => pre.checkVisibility());
        return { fold: fold?.id ?? null, tool: longest.id, lines: shown.map((pre) => pre.textContent.split("\n").length).reduce((a, b) => a + b, 0) };
      });
      if (opened === null) continue;
      await sleep(300);
      await page.screenshot({ path: join(out, `${name}-${width}-opened.png`) });
      log(`${name} ${width}: opened the fold ${opened.fold} and the call ${opened.tool}, whose output shows ${opened.lines} lines`);
      const more = await page.evaluate((tool) => {
        const button = document.querySelector(`#${CSS.escape(tool)} [data-more]`);
        if (button === null) return null;
        const label = button.textContent.trim();
        button.click();
        return label;
      }, opened.tool);
      if (more !== null) {
        await sleep(300);
        const lines = await page.evaluate((tool) => [...document.querySelectorAll(`#${CSS.escape(tool)} pre.t-out`)].filter((pre) => pre.checkVisibility()).map((pre) => pre.textContent.split("\n").length).reduce((a, b) => a + b, 0), opened.tool);
        await page.screenshot({ path: join(out, `${name}-${width}-more.png`) });
        log(`${name} ${width}: pressed "${more}", and the output shows ${lines} lines`);
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}
