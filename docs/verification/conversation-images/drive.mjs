// Drives the stack in stack.ts in headless Chromium, at a desktop width and at a phone's, and saves what it saw in
// OUT: the whole of each conversation as one tall image, the full-size image a click opens, the Changes diff of each
// screenshot, the paused thread once its pylon runs again, and findings.txt, which says what the page measured. Then
// it asks the image route for what it must refuse. The same driver runs on main and on the branch.
//
//   OUT=... STACK='{...}' MODULES=... node docs/verification/conversation-images/drive.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const finding = (line) => { appendFileSync(join(out, "findings.txt"), `${line}\n`); log(line); };

writeFileSync(join(out, "drive.log"), "");
writeFileSync(join(out, "findings.txt"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
const widths = [
  { name: "desktop", viewport: { width: 1280, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
];

/** What the conversation shows of images: each `<img>` with whether it loaded and fits its column, and the text placeholders. */
const images = (page) => page.evaluate(() => {
  const convo = document.getElementById("convo");
  const imgs = [...convo.querySelectorAll("img")].map((img) => {
    const box = img.getBoundingClientRect();
    const column = img.closest(".msg, .tool, #convo").getBoundingClientRect();
    return { src: img.getAttribute("src"), loaded: img.complete && img.naturalWidth > 0, shown: `${Math.round(box.width)}x${Math.round(box.height)}`, natural: `${img.naturalWidth}x${img.naturalHeight}`, fits: box.width <= column.width + 1, link: img.closest("a")?.getAttribute("href") ?? null };
  });
  const text = convo.innerText;
  return { imgs, placeholders: (text.match(/\[(?:image\/png )?image\]/g) ?? []).length, notes: [...convo.querySelectorAll(".shot-gone, .shots .note, .shots p")].map((p) => p.textContent.trim()), oversized: (text.match(/oversized record/g) ?? []).length };
});

async function tall(page, viewport, file) {
  const height = await page.evaluate(() => {
    const scroll = document.getElementById("scroll");
    return document.documentElement.clientHeight + scroll.scrollHeight - scroll.clientHeight;
  });
  await page.setViewport({ ...viewport, height: Math.min(height, 12_000) });
  await sleep(800);
  await page.screenshot({ path: join(out, file) });
  await page.setViewport(viewport);
  await sleep(300);
}

/** Opens every tool call and fold, so images inside a call's body show in the capture. */
const openCalls = (page) => page.evaluate(() => { for (const d of document.querySelectorAll("#convo details")) d.open = true; });

try {
  for (const { name: width, viewport } of widths) {
    for (const [name, id] of Object.entries(ids)) {
      const page = await browser.newPage();
      await page.setViewport(viewport);
      page.on("pageerror", (err) => log(`${name} ${width}: page error: ${err.message}`));
      await page.goto(`${base}/threads/${id}`, { waitUntil: "load" });
      await sleep(2_500);
      await openCalls(page);
      await sleep(1_500);
      const seen = await images(page);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      finding(`${name} ${width}: ${seen.imgs.length} images in the conversation, ${seen.imgs.filter((i) => i.loaded).length} loaded, ${seen.imgs.filter((i) => !i.fits).length} wider than their column; ${seen.placeholders} [image] placeholders; ${seen.oversized} oversized-record notices; notes: ${JSON.stringify(seen.notes)}; page scrolls sideways: ${sideways}`);
      for (const i of seen.imgs) log(`  ${i.loaded ? "loaded" : "NOT loaded"} ${i.natural} shown ${i.shown}${i.fits ? "" : " (too wide)"} ${i.src}${i.link === null ? " (no link)" : ""}`);
      await tall(page, viewport, `${name}-${width}-all.png`);
      if (width === "desktop") writeFileSync(join(out, `${name}.txt`), `${(await page.evaluate(() => document.getElementById("convo").innerText)).replace(/\n{3,}/g, "\n\n")}\n`);

      const first = seen.imgs.find((i) => i.loaded && i.link !== null);
      if (first !== undefined && name === "worker") {
        const opened = new Promise((resolve) => browser.once("targetcreated", resolve));
        await page.evaluate((src) => document.querySelector(`#convo img[src="${CSS.escape(src)}"]`).click(), first.src);
        const target = await Promise.race([opened, sleep(5_000).then(() => null)]);
        const tab = target === null ? null : await target.page();
        if (tab === null) finding(`${name} ${width}: a click on the first image opened no tab`);
        else {
          await tab.setViewport(viewport);
          await sleep(1_500);
          const full = await tab.evaluate(() => { const img = document.querySelector("img"); return img === null ? null : `${img.naturalWidth}x${img.naturalHeight}`; });
          finding(`${name} ${width}: a click on the first image opened ${tab.url().replace(base, "")}, an image of ${full}`);
          await tab.screenshot({ path: join(out, `${name}-${width}-full-size.png`) });
          await tab.close();
        }
      }

      if (name === "worker") {
        if (width === "phone") {
          await page.evaluate(() => document.querySelector('[data-open="inspect"][data-pane="changes"]')?.click());
          await sleep(500);
        }
        await page.waitForSelector(".tree-file", { timeout: 15_000 }).catch(() => null);
        for (const path of ["docs/shots/conversation-phone.png", "docs/shots/conversation-desktop.png"]) {
          const opened = await page.evaluate((p) => {
            const row = document.querySelector(`.tree-file[data-path="${CSS.escape(p)}"]`);
            row?.click();
            return row !== null;
          }, path);
          await page.evaluate(() => document.querySelector(".scrim")?.click());
          await sleep(3_000);
          const view = await page.evaluate(() => {
            const v = document.getElementById("file-view");
            return { text: v.innerText.replace(/\s+/g, " ").slice(0, 300), imgs: [...v.querySelectorAll("img")].map((i) => ({ src: i.getAttribute("src"), loaded: i.complete && i.naturalWidth > 0, natural: `${i.naturalWidth}x${i.naturalHeight}` })) };
          });
          finding(`${name} ${width}: the diff of ${path}${opened ? "" : " (no row to open)"} shows ${view.imgs.length} images (${view.imgs.filter((i) => i.loaded).map((i) => i.natural).join(", ")} loaded) and the text "${view.text}"`);
          for (const i of view.imgs) log(`  ${i.loaded ? "loaded" : "NOT loaded"} ${i.src}`);
          await page.screenshot({ path: join(out, `${name}-${width}-diff-${path.split("/").pop()}`) });
        }
      }
      await page.close();
    }
  }

  // The paused thread's page stays open while its pylon runs again, as after the wake its visit asked for.
  for (const { name: width, viewport } of widths) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.goto(`${base}/threads/${ids.paused}`, { waitUntil: "load" });
    await sleep(2_500);
    await openCalls(page);
    await sleep(1_000);
    const before = await images(page);
    await fetch("http://127.0.0.1:7489/verify/run", { method: "POST" });
    await sleep(12_000);
    const after = await images(page);
    finding(`paused ${width}, its page left open while the pylon runs again: ${before.imgs.filter((i) => i.loaded).length} images loaded and ${before.notes.length} notes before, ${after.imgs.filter((i) => i.loaded).length} loaded and ${after.notes.length} notes after`);
    await tall(page, viewport, `paused-${width}-after-run.png`);
    await page.close();
    await fetch("http://127.0.0.1:7489/verify/pause", { method: "POST" });
    await sleep(2_000);
  }

  // What the route must refuse, asked directly, each a variation of a URL the page used.
  const page = await browser.newPage();
  await page.goto(`${base}/threads/${ids.worker}`, { waitUntil: "load" });
  await sleep(2_000);
  const srcs = await page.evaluate(() => [...document.querySelectorAll("#convo img")].map((i) => i.getAttribute("src")));
  await page.close();
  const transcriptSrc = srcs.find((s) => s.includes("transcript"));
  const fileSrc = srcs.find((s) => s.includes("source=file"));
  const asks = [
    ["a transcript image the page shows", transcriptSrc],
    ["the same with its SHA-256 changed", transcriptSrc?.replace(/sha256=([0-9a-f])/, (_, c) => `sha256=${c === "0" ? "1" : "0"}`)],
    ["the same image asked of the paused thread", transcriptSrc?.replace(ids.worker, ids.paused)],
    ["a checkout file the page shows", fileSrc],
    ["a file outside the checkout", fileSrc && `/v1/threads/${ids.worker}/image?source=file&path=${encodeURIComponent("/tmp/before.png")}`],
    ["a path that climbs out of the checkout", fileSrc && `/v1/threads/${ids.worker}/image?source=file&path=${encodeURIComponent("../../../etc/passwd")}`],
    ["a text file in the checkout", fileSrc && `/v1/threads/${ids.worker}/image?source=file&path=style.css`],
    ["a screenshot as it was when the pylon booted", fileSrc && `/v1/threads/${ids.worker}/image?source=file&path=${encodeURIComponent("docs/shots/conversation-phone.png")}&base=start`],
    ["a screenshot added since boot, at boot", fileSrc && `/v1/threads/${ids.worker}/image?source=file&path=${encodeURIComponent("docs/shots/conversation-desktop.png")}&base=start`],
  ];
  for (const [what, url] of asks) {
    if (url === undefined) { finding(`route: ${what}: the page shows no such URL`); continue; }
    const res = await fetch(`${base}${url}`);
    const body = Buffer.from(await res.arrayBuffer());
    const said = res.headers.get("content-type")?.startsWith("application/json") ? ` ${body.toString().slice(0, 200)}` : ` ${body.length} bytes`;
    finding(`route: ${what}: ${res.status} ${res.headers.get("content-type")}, cache-control ${res.headers.get("cache-control")}${said}`);
  }
} finally {
  await browser.close();
}
