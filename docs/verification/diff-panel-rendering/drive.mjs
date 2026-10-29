// Drives the diff panel on the stack in stack.ts in headless Chromium, once at a desktop width and once at a phone's,
// and saves what it saw in OUT: a screenshot of each kind of diff, of notes written on them, and findings.txt, which
// says for each check what the page measured and whether that is a rendering problem. The same driver runs on main
// and on the branch.
//
//   OUT=... STACK='{...}' MODULES=... node docs/verification/diff-panel-rendering/drive.mjs
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const out = process.env.OUT;
const { thread } = JSON.parse(process.env.STACK);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };

writeFileSync(join(out, "drive.log"), "");
writeFileSync(join(out, "findings.txt"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
const views = [{ name: "desktop", width: 1280, height: 900, mobile: false }, { name: "phone", width: 390, height: 844, mobile: true }];
const cases = [
  ["long-lines", "src/rules.ts"], ["wide-file", "data/table.csv"], ["rename-with-edits", "lib/new-name.js"], ["pure-rename", "docs/renamed.md"],
  ["binary", "assets/logo.png"], ["binary-added", "assets/new-icon.png"], ["added", "src/added.ts"], ["deleted", "src/gone.ts"],
  ["mode-change", "scripts/run.sh"], ["type-change", "link-target.txt"], ["no-newline-at-end", "config/no-eol.json"],
  ["very-long-file", "src/generated.ts"], ["crlf", "win/notes.txt"], ["crlf-endings-only", "win/endings.txt"], ["tabs-make", "Makefile"],
  ["tabs-go", "go/main.go"], ["unicode", "i18n/greetings.md"],
  ["deep-path", "src/very/deeply/nested/directory/structure/that/goes/on/and/on/with-a-long-file-name-too.component.tsx"],
];

for (const view of views) {
  const page = await browser.newPage();
  await page.setViewport({ width: view.width, height: view.height, isMobile: view.mobile, hasTouch: view.mobile });
  await page.evaluateOnNewDocument(() => {
    window.longTasks = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.longTasks.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true });
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.sample}`));
  });
  page.on("pageerror", (err) => log(`${view.name}: page error: ${err.message}`));
  page.on("console", (m) => { if (m.type() === "error") log(`${view.name}: console error: ${m.text()}`); });
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
  const layout = (which) => ev((which) => document.querySelector(`.fv-layout button[value="${which}"]`)?.click(), which);
  /** Opens a file's diff from the changes tree and waits until it is drawn, returning how long that took and the longest task meanwhile. */
  const open = async (path) => {
    await ev(() => { window.longTasks = []; });
    const started = Date.now();
    await ev((path) => document.querySelector(`.tree-file[data-path="${CSS.escape(path)}"]`).click(), path);
    await ev(() => document.querySelector(".scrim")?.click());
    await page.waitForFunction((path) => document.getElementById("file-view").dataset.path === path && !document.getElementById("file-view").textContent.includes("Reading the diff"), { timeout: 120_000 }, path);
    const ms = Date.now() - started;
    await sleep(600);
    return { ms, longest: Math.max(0, ...await ev(() => window.longTasks)) };
  };
  /** Whether the end of an element's text is drawn inside the element's box, rather than cut off or scrolled away. */
  const endShows = (selector) => ev((selector) => {
    const node = document.querySelector(selector);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let last = null;
    while (walker.nextNode()) if (walker.currentNode.textContent.trim() !== "") last = walker.currentNode;
    const range = document.createRange();
    range.setStart(last, last.length - 1);
    range.setEnd(last, last.length);
    const char = range.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return char.right <= box.right + 1 && char.left >= box.left - 1;
  }, selector);
  /** Whether a text is in the diff, and whether it lies within the panel's width: `{ found, inside }`. */
  const textInPanel = (text) => ev((text) => {
    const root = document.querySelector(".diff-view").shadowRoot;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const at = walker.currentNode.textContent.indexOf(text);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(walker.currentNode, at);
      range.setEnd(walker.currentNode, at + text.length);
      const r = range.getBoundingClientRect();
      const panel = document.getElementById("file-view").getBoundingClientRect();
      return { found: true, inside: r.left >= panel.left && r.right <= panel.right };
    }
    return { found: false, inside: false };
  }, text);
  /**
   * Scrolls a line's number into view and returns its middle, on the new side, or the old side when the diff shows
   * only its removal.
   */
  const numberPoint = (line) => ev((line) => {
    const cells = [...document.querySelector(".diff-view").shadowRoot.querySelectorAll("[data-column-number]")].filter((el) => el.textContent.trim() === String(line));
    const cell = cells.find((el) => el.dataset.lineType !== "change-deletion") ?? cells[0];
    cell.scrollIntoView({ block: "center", inline: "nearest" });
    const box = cell.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, line);
  /**
   * Writes a comment on one line by clicking its number and pressing C, and returns the saved note's quote, whether
   * its card is drawn, and whether the card lies within the panel.
   */
  const note = async (line, body) => {
    const at = await numberPoint(line);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.press("c");
    await page.waitForSelector(".note-text");
    await page.keyboard.type(body);
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await page.waitForFunction(() => document.querySelector(".note-draft") === null);
    await sleep(300);
    return ev((thread, body) => {
      const saved = JSON.parse(localStorage.getItem(`nexus.review.${thread}`)).notes.find((n) => n.body === body);
      const card = [...document.querySelectorAll(".diff-view .note")].find((n) => n.textContent.includes(body));
      card?.scrollIntoView({ block: "center" });
      const r = card?.getBoundingClientRect();
      const panel = document.getElementById("file-view").getBoundingClientRect();
      return { quote: saved?.quote, card: card !== undefined, inside: r !== undefined && r.left >= panel.left - 1 && r.right <= panel.right + 1 && r.width > 0 };
    }, thread, body);
  };

  await page.goto(`http://127.0.0.1:7470/threads/${thread}`);
  await ev(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("nexus.review.") || key === "nexus.diff-layout") localStorage.removeItem(key); });
  await page.reload();
  await page.waitForSelector(".tree-file", { timeout: 30_000 });

  for (const [name, path] of cases) {
    const { ms, longest } = await open(path);
    const overflow = await ev(() => document.documentElement.scrollWidth > innerWidth + 1);
    finding(`${name}: drawn in`, `${ms} ms, longest task ${longest} ms, page wider than the window ${overflow}`, longest > 1_000 || overflow);
    await shot(name);
  }

  await open("src/rules.ts");
  const long = await ev(() => {
    const code = document.querySelector(".diff-view").shadowRoot.querySelector("[data-code]");
    const panel = document.getElementById("file-view").getBoundingClientRect();
    return { hidden: code.scrollWidth - code.clientWidth, below: Math.round(code.getBoundingClientRect().bottom - panel.bottom) };
  });
  finding("long lines: text hidden to the side, and the sideways scrollbar below the panel's bottom by", `${long.hidden}px, ${long.below}px`, long.hidden > 0 && long.below > 0);
  const row = await ev(() => {
    const line = document.querySelector(".diff-view").shadowRoot.querySelector('[data-line="2"]');
    const r = line.getBoundingClientRect();
    return line.scrollWidth <= line.clientWidth + 1 && r.right <= document.getElementById("file-view").getBoundingClientRect().right + 1;
  });
  finding("long lines: the whole of line 2 is drawn within the panel's width", String(row), !row);

  await open("data/table.csv");
  const cell = await textInPanel("R6C37");
  finding("wide file: the changed cell R6C37 is in the panel", String(cell.inside), !cell.inside);
  await shot("wide-file-changed-cell");

  await open("src/generated.ts");
  const band = await ev(() => document.querySelector(".diff-view").shadowRoot.querySelector("[data-separator]")?.textContent.trim() ?? "none");
  finding("very long file, whose first line changed: the band above its first row", band, /unmodified/.test(band));
  const cut = await ev(() => {
    const note = [...document.querySelectorAll("#file-view .fv-note")].find((p) => /too long to show/.test(p.textContent));
    const view = document.querySelector(".diff-view");
    return { rows: view.shadowRoot.querySelectorAll("[data-line]").length, above: note !== undefined && (note.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 };
  });
  finding("very long file: rows drawn, and says above them that it is cut short", `${cut.rows}, ${cut.above}`, !cut.above);

  await open("win/endings.txt");
  const endings = await ev(() => document.getElementById("file-view").textContent);
  finding("only the line endings changed: the panel says so", String(/line ending/i.test(endings)), !/line ending/i.test(endings));
  await shot("crlf-endings-only");

  await open("src/very/deeply/nested/directory/structure/that/goes/on/and/on/with-a-long-file-name-too.component.tsx");
  const name = await endShows(".fv-head .fv-path");
  const base = await ev(() => Math.round(document.querySelector(".fv-head > .dim").getBoundingClientRect().height));
  finding("deep path: the file's name shows in the panel's header", String(name), !name);
  finding("deep path: the height of the header's base label, as \"vs boot\"", `${base}px`, base > 20);

  await open("src/rules.ts");
  await layout("split");
  await sleep(800);
  const split = await ev(() => {
    const root = document.querySelector(".diff-view").shadowRoot;
    const line = root.querySelector("[data-line]");
    const ch = document.createElement("span");
    ch.textContent = "0".repeat(10);
    line.append(ch);
    const width = ch.getBoundingClientRect().width / 10;
    ch.remove();
    const code = line.closest("[data-code]");
    const box = getComputedStyle(code).display === "contents" ? line.getBoundingClientRect() : code.getBoundingClientRect();
    const shown = Math.min(line.getBoundingClientRect().right, box.right) - line.getBoundingClientRect().left;
    return { type: root.querySelector("pre").dataset.diffType, columns: Math.floor(shown / width) };
  });
  finding("split picked: layout drawn, and characters a line shows before it wraps or scrolls", `${split.type}, ${split.columns}`, split.columns < 40);
  await shot("split-long-lines");
  await layout("unified");
  await sleep(500);

  const many = ["src/rules.ts", "data/table.csv", "lib/new-name.js", "src/added.ts", "src/gone.ts", "win/notes.txt", "go/main.go", "i18n/greetings.md"];
  for (const path of many) await open(path);
  const tabs = await ev(() => [...document.querySelectorAll(".tab-file .tab-name")].map((n) => Math.round(n.getBoundingClientRect().width)));
  finding("eight files open: the narrowest file tab's name is", `${Math.min(...tabs)}px wide`, Math.min(...tabs) < 30);
  const convo = await ev(() => {
    const bar = document.getElementById("tabs").getBoundingClientRect();
    const tab = document.querySelector('#tabs [data-tab="convo"]').getBoundingClientRect();
    return tab.left >= bar.left - 1 && tab.right <= bar.right + 1;
  });
  finding("eight files open: the conversation's tab is in the bar's view", String(convo), !convo);
  await shot("eight-tabs");
  await open(many[0]);
  const first = await ev(() => {
    const bar = document.getElementById("tabs").getBoundingClientRect();
    const pinned = document.querySelector('#tabs [data-tab="convo"]').getBoundingClientRect();
    const tab = document.querySelector("#tabs .tab-file.active").getBoundingClientRect();
    return tab.left >= pinned.right - 1 && tab.right <= bar.right + 1;
  });
  finding("eight files open, the first opened again: its tab shows beside the conversation's, not under it", String(first), !first);
  await shot("first-tab-again");

  await open("src/rules.ts");
  const onLong = await note(3, `A note on a long line, at ${view.name} width.`);
  finding("long lines: a note on line 3 is saved, drawn and inside the panel", `${onLong.quote !== undefined}, ${onLong.card}, ${onLong.inside}`, !onLong.card || !onLong.inside);
  await shot("note-on-long-line");
  await open("win/notes.txt");
  const onCrlf = await note(6, `A note on a CRLF line, at ${view.name} width.`);
  finding("CRLF: a note on line 6 quotes it without its CR", JSON.stringify(onCrlf.quote), onCrlf.quote === undefined || onCrlf.quote.some((line) => line.includes("\r")));
  await shot("note-on-crlf-line");
  await open("src/generated.ts");
  await ev(() => { window.longTasks = []; });
  const started = Date.now();
  await note(2, `A note on the very long file, at ${view.name} width.`);
  const noted = { ms: Date.now() - started, longest: Math.max(0, ...await ev(() => window.longTasks)) };
  finding("very long file: a note written and saved in", `${noted.ms} ms, longest task ${noted.longest} ms`, noted.longest > 1_000);
  await shot("note-on-very-long-file");

  await page.close();
}
await browser.close();
