// Drives the stack in stack.ts in headless Chromium, once at a desktop width and once at a phone's, and saves what it
// saw in OUT: a screenshot of every page and of each bug's steps, and findings.txt, which says for each check what the
// page measured and whether that is the bug. The same driver runs on main and on the branch.
//
//   OUT=... STACK='{...}' MODULES=... node docs/verification/dashboard-scrolling/drive.mjs
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
const control = (what, body) => fetch(`http://127.0.0.1:7489/verify/${what}`, { method: "POST", body: JSON.stringify(body) });
/** Long enough for the page's 5 s poll to have swapped in what changed. */
const poll = () => sleep(6_500);

writeFileSync(join(out, "drive.log"), "");
writeFileSync(join(out, "findings.txt"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
const widths = [{ name: "desktop", width: 1280, height: 900, mobile: false }, { name: "phone", width: 390, height: 844, mobile: true }];

for (const view of widths) {
  const page = await browser.newPage();
  const size = (height = view.height) => page.setViewport({ width: view.width, height, isMobile: view.mobile, hasTouch: view.mobile });
  await size();
  page.on("pageerror", (err) => log(`${view.name}: page error: ${err.message}`));
  const ev = (f, ...args) => page.evaluate(f, ...args);
  let shots = 0;
  const shot = async (name) => {
    const file = `${view.name}-${String(++shots).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: join(out, file) });
    log(`screenshot ${file}`);
  };
  const finding = (check, measured, bug) => {
    const line = `${view.name} ${check}: ${measured} -> ${bug ? "BUG" : "ok"}`;
    appendFileSync(join(out, "findings.txt"), `${line}\n`);
    log(line);
  };
  const open = async (path) => {
    await page.goto(`${base}${path}`);
    await sleep(1_500);
  };
  const conversation = () => ev(() => {
    const s = document.getElementById("scroll");
    return { top: Math.round(s.scrollTop), fromEnd: Math.round(s.scrollHeight - s.clientHeight - s.scrollTop) };
  });
  const documentScrolls = () => ev(() => document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1);

  const pages = [["home", "/"], ["long-conversation", `/threads/${ids.long}`], ["claude-transcript", `/threads/${ids.claude}`], ["questions", `/threads/${ids.asks}`],
    ["review-in-progress", `/threads/${ids.reviewed}`], ["approved-review", `/threads/${ids.landable}`], ["archived", `/threads/${ids.archived}`],
    ["pipeline", "/pipeline"], ["node", `/nodes/${ids.node}`], ["usage", "/usage"]];
  for (const [name, path] of pages) {
    await open(path);
    finding(`page ${name}: the document itself scrolls`, String(await documentScrolls()), await documentScrolls());
    await shot(name);
  }

  await open(`/threads/${ids.long}`);
  const dock = await ev(() => { const r = document.querySelector(".dock").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(dock.x, dock.y);
  await page.mouse.wheel({ deltaY: 3_000 });
  await sleep(500);
  const scrolled = await ev(() => Math.round(scrollY));
  finding("long conversation: a wheel over the composer scrolls the window by", `${scrolled}px`, scrolled > 0);
  await shot("wheel-over-composer");
  await ev(() => scrollTo(0, 0));

  await open(`/threads/${ids.long}`);
  const fold = () => ev(() => Math.round([...document.querySelectorAll("#convo .steps")].at(-1).getBoundingClientRect().top));
  await ev(() => [...document.querySelectorAll("#convo .steps > summary")].at(-1).click());
  await sleep(300);
  await ev(() => [...document.querySelectorAll("#convo .steps")].at(-1).querySelector(".tool > summary").click());
  await sleep(300);
  log(`${view.name}: the last run of tools and its first call are open, ${(await conversation()).fromEnd}px above the end`);
  const opened = await fold();
  await control("append", { thread: ids.long, n: 1 });
  await sleep(1_000);
  const after = await fold();
  finding("long conversation: at the end, the last fold opened, then a reply came, the fold's summary moved by", `${opened - after}px`, Math.abs(opened - after) > 2);
  await shot("fold-opened-then-reply");

  await open(`/threads/${ids.asks}`);
  const cards = await ev(() => [...document.querySelectorAll("#questions .question")].map((card) => {
    const buttons = card.querySelector(".question-options").getBoundingClientRect();
    const box = card.getBoundingClientRect();
    return buttons.bottom <= box.bottom + 1 && buttons.height > 0;
  }));
  finding("questions: cards whose option buttons show", `${cards.filter(Boolean).length} of ${cards.length}`, cards.some((shown) => !shown));
  await shot("question-cards");

  await open(`/threads/${ids.live}`);
  const loaded = await conversation();
  finding("live conversation: loaded, distance from its end", `${loaded.fromEnd}px`, loaded.fromEnd > 48);
  await control("append", { thread: ids.live, n: 1 });
  await sleep(800);
  const appended = await conversation();
  finding("live conversation: at the end, a reply came, distance from the end", `${appended.fromEnd}px`, appended.fromEnd > 48);
  await control("stream", { thread: ids.live, words: 60 });
  await sleep(3_500);
  const streamed = await conversation();
  finding("live conversation: at the end, a reply streamed, distance from the end", `${streamed.fromEnd}px`, streamed.fromEnd > 48);
  await size(view.height - 300);
  await sleep(500);
  await control("append", { thread: ids.live, n: 1 });
  await sleep(800);
  const keyboard = await conversation();
  finding("live conversation: at the end, the window shrank by 300px as a phone's keyboard opens, then a reply came, distance from the end", `${keyboard.fromEnd}px`, keyboard.fromEnd > 48);
  await shot("window-shrank-then-reply");
  await size();
  await sleep(500);
  await ev(() => { const s = document.getElementById("scroll"); s.scrollTop = s.scrollHeight; });
  await page.type("#prompt-text", "one\ntwo\nthree\nfour\nfive\nsix");
  await control("append", { thread: ids.live, n: 1 });
  await sleep(800);
  const typed = await conversation();
  finding("live conversation: at the end, six lines typed into the composer, then a reply came, distance from the end", `${typed.fromEnd}px`, typed.fromEnd > 48);
  await shot("typed-six-lines-then-reply");
  await ev(() => { const t = document.getElementById("prompt-text"); t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); });

  await ev(() => { const s = document.getElementById("scroll"); s.scrollTop = s.scrollHeight; });
  await control("ask", { thread: ids.live });
  await poll();
  const asked = await conversation();
  finding("live conversation: at the end, a question card joined the dock, distance from the end", `${asked.fromEnd}px`, asked.fromEnd > 48);

  await ev(() => { document.getElementById("scroll").scrollTop = 600; });
  await sleep(300);
  await control("append", { thread: ids.live, n: 2 });
  await control("stream", { thread: ids.live, words: 60 });
  await sleep(3_500);
  await poll();
  const held = await conversation();
  finding("live conversation: scrolled up to 600px, two replies came, one streamed and the page polled, scrolled to", `${held.top}px`, Math.abs(held.top - 600) > 2);
  await shot("scrolled-up-kept-place");

  await ev(() => { const s = document.getElementById("scroll"); s.scrollTop = s.scrollHeight; });
  await page.waitForSelector('.tree-file[data-path="src/control/loop.ts"]');
  await ev(() => document.querySelector('.tree-file[data-path="src/control/loop.ts"]').click());
  await ev(() => document.querySelector(".scrim")?.click());
  await sleep(2_500);
  await ev(() => { document.getElementById("file-view").scrollTop = 4_000; });
  await shot("diff-tab");
  await control("append", { thread: ids.live, n: 3 });
  await poll();
  const diffHeld = await ev(() => Math.round(document.getElementById("file-view").scrollTop));
  finding("diff tab: scrolled to 4000px, three replies came and the page polled, scrolled to", `${diffHeld}px`, Math.abs(diffHeld - 4_000) > 2);
  await ev(() => document.querySelector('[data-tab="convo"]').click());
  await sleep(500);
  const back = await conversation();
  finding("live conversation: left at the end for a diff tab, three replies came, back on the conversation, distance from the end", `${back.fromEnd}px`, back.fromEnd > 48);
  await shot("back-from-diff-tab");

  await open(`/threads/${ids.long}`);
  await ev(() => { document.getElementById("scroll").scrollTop = 600; });
  await sleep(300);
  await ev(() => {
    const top = document.getElementById("scroll").getBoundingClientRect().top;
    [...document.querySelectorAll("#convo .steps > summary")].find((s) => s.getBoundingClientRect().top > top).click();
  });
  await sleep(300);
  const before = (await conversation()).top;
  await page.waitForSelector('.tree-file[data-path="src/control/loop.ts"]');
  await ev(() => document.querySelector('.tree-file[data-path="src/control/loop.ts"]').click());
  await ev(() => document.querySelector(".scrim")?.click());
  await sleep(1_000);
  await control("append", { thread: ids.long, n: 1 });
  await poll();
  await ev(() => document.querySelector('[data-tab="convo"]').click());
  await sleep(500);
  const behind = (await conversation()).top;
  finding(`long conversation: scrolled up to ${before}px with a fold opened, a reply came while a diff tab covered it, back on the conversation, scrolled to`, `${behind}px`, Math.abs(behind - before) > 2);
  await shot("scrolled-up-behind-diff-tab");

  await open(`/threads/${ids.landable}`);
  if (view.mobile) {
    await ev(() => document.querySelector(".menu").click());
    await sleep(400);
  }
  const active = await ev(() => {
    const row = document.querySelector(".row.active").getBoundingClientRect();
    const list = document.querySelector(".groups").getBoundingClientRect();
    return { shown: row.top >= list.top - 1 && row.bottom <= list.bottom + 1, row: Math.round(row.bottom), list: Math.round(list.bottom) };
  });
  finding("sidebar: the open thread's row is inside the list's visible part", `row ends at ${active.row}px, the list at ${active.list}px`, !active.shown);
  await shot("sidebar-open-thread");
  if (view.mobile) await ev(() => document.querySelector(".scrim").click());

  if (!view.mobile) {
    await ev(() => { document.querySelector(".groups").scrollTop = 400; });
    await poll();
    const groups = await ev(() => Math.round(document.querySelector(".groups").scrollTop));
    finding("sidebar: scrolled to 400px, the page polled, scrolled to", `${groups}px`, Math.abs(groups - 400) > 2);
  } else {
    await ev(() => document.querySelector('[data-open="inspect"][data-pane="changes"]').click());
    await sleep(500);
  }
  await page.waitForSelector(".tree-file");
  await ev(() => { document.querySelector(".inspect").scrollTop = 400; });
  await poll();
  const inspector = await ev(() => {
    const pane = document.querySelector(".inspect");
    const tabs = document.querySelector(".seg-bar").getBoundingClientRect();
    return { top: Math.round(pane.scrollTop), tabs: tabs.bottom > pane.getBoundingClientRect().top && tabs.top >= pane.getBoundingClientRect().top - 1 };
  });
  finding("inspector: scrolled to 400px, the page polled, scrolled to", `${inspector.top}px`, Math.abs(inspector.top - 400) > 2);
  finding("inspector: scrolled down the changes, its Changes, Previews and Pylon tabs show", String(inspector.tabs), !inspector.tabs);
  await shot("inspector-scrolled");

  await open("/pipeline");
  const clipped = await ev(() => [...document.querySelectorAll(".ov-items td")].filter((td) => td.offsetParent !== null && [...td.querySelectorAll("span, code, a")].some((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > td.getBoundingClientRect().right + 1)).length);
  finding("pipeline: cells whose text is cut off", String(clipped), clipped > 0);
  await shot("pipeline-cells");
  await page.close();
}
await browser.close();
