// Drives review notes on the dashboard's diff in headless Chromium and saves what it saw here. `harness` runs against
// docs/verification/pierre-diffs/stack.ts on 7470: a note of each kind, by mouse and keyboard, on all three bases and in
// split, a reload, a note whose lines changed, the review put in the composer and sent to the thread's agent. `claude`
// runs against docs/verification/claude-turn-snapshots/stack.ts on 7472: notes on a Claude worker's latest turn, a
// reload, and the review sent into the worker's session. It fails on any CSP violation or page error. Chromium and
// puppeteer-core come from the npm packages @sparticuz/chromium and puppeteer-core, installed outside the repo, whose
// node_modules MODULES names. REPO is the fixture checkout the harness stack prints.
//
//   MODULES=... REPO=/tmp/nexus-diffs-.../repo node docs/verification/diff-review/drive.mjs harness th-...
//   MODULES=... node docs/verification/diff-review/drive.mjs claude th-...
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const out = new URL(".", import.meta.url).pathname;
const [mode, thread] = process.argv.slice(2);
const port = mode === "claude" ? 7472 : 7470;
const logFile = join(out, `${mode}.log`);
const log = (line) => { console.log(line); appendFileSync(logFile, `${line}\n`); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

writeFileSync(logFile, "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const problems = [];

async function open(scheme = "light") {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.evaluateOnNewDocument(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI} ${e.sample}`));
  });
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${scheme}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${scheme}: page error ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400) log(`${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search} answered ${r.status()}`); });
  await page.goto(`http://127.0.0.1:${port}/threads/${thread}`);
  return page;
}

const shot = async (page, name) => {
  await page.screenshot({ path: join(out, `${mode}-${name}.png`) });
  log(`screenshot ${mode}-${name}.png`);
};

async function base(page, which) {
  await page.waitForSelector("#changes-head");
  const want = { start: [false, false], head: [true, false], turn: [false, true] }[which];
  for (const [id, on] of [["changes-head", want[0]], ["changes-turn", want[1]]]) {
    if (await page.$eval(`#${id}`, (el) => el.checked) !== on) await page.click(`#${id}`);
  }
  await page.waitForFunction((label) => document.getElementById("changes-base").textContent.startsWith(label) && document.querySelector(".tree-file") !== null,
    { timeout: 20_000 }, { start: "Since the pylon booted,", head: "Since the last commit,", turn: "Since the latest turn began," }[which]);
}

async function diff(page, path) {
  await page.click(`.tree-file[data-path="${path}"]`);
  await page.waitForFunction((path) => document.getElementById("file-view").dataset.path === path && document.querySelector("#file-view .diff-view") !== null, {}, path);
  await pause(500);
}

async function layout(page, which) {
  await page.click(`.fv-layout button[value="${which}"]`);
  await page.waitForFunction((which) => document.querySelector(".diff-view")?.shadowRoot?.querySelector("pre")?.dataset.diffType === (which === "split" ? "split" : "single"), {}, which);
  await pause(300);
}

/** The middle of a line number in the open diff: on the old side for a removed line, the new side otherwise. */
const number = (page, line, removed = false) => page.evaluate((line, removed) => {
  const cell = [...document.querySelector(".diff-view").shadowRoot.querySelectorAll("[data-column-number]")]
    .find((el) => el.textContent.trim() === String(line) && (el.dataset.lineType === "change-deletion") === removed);
  cell.scrollIntoView({ block: "center", inline: "nearest" });
  const box = cell.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}, line, removed);

/** Drags across line numbers from one line to another. */
async function drag(page, from, to, removed = false) {
  const a = await number(page, from, removed);
  const b = await number(page, to, removed);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

/** Picks a kind from the bar under the selection, writes the note and saves it with Ctrl+Enter. */
async function write(page, kind, body, how = "bar") {
  if (how === "bar") {
    await page.waitForSelector(".note-pick:not([hidden])");
    const picked = await page.$$eval(".note-pick button", (buttons, kind) => {
      const button = buttons.find((b) => b.textContent === kind);
      button?.click();
      return button !== undefined;
    }, kind);
    assert.ok(picked, `the bar offers ${kind}`);
  } else {
    await page.keyboard.press(how);
  }
  await page.waitForSelector(".note-text");
  await page.keyboard.type(body);
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => document.querySelector(".note-draft") === null);
}

const review = (page) => page.evaluate((thread) => JSON.parse(localStorage.getItem(`nexus.review.${thread}`) ?? "null"), thread);
const cards = (page) => page.$$eval(".diff-view .note", (notes) => notes.map((n) => n.innerText.replace(/\s+/g, " ").trim()));
const selected = (page) => page.evaluate(() => [...document.querySelector(".diff-view").shadowRoot.querySelectorAll("[data-line][data-selected-line]")].map((row) => row.textContent));

/** Puts the review in the composer, cuts the entries after `keep` if given, sends it, and waits until the conversation shows it. */
async function send(page, keep = Infinity) {
  await page.click(".review-bar .btn-primary");
  await page.waitForFunction(() => document.getElementById("prompt-text")?.value.startsWith("I reviewed the diff"));
  const text = await page.$eval("#prompt-text", (el) => el.value);
  writeFileSync(join(out, `${mode}-composed.md`), `${text}\n`);
  log(`composed review: ${text.split("\n").length} lines, saved as ${mode}-composed.md; the tab on show is ${await page.$eval("main", (m) => m.dataset.view)}`);
  await page.$eval("#prompt-text", (el, keep) => {
    const cut = el.value.search(new RegExp(`\\n\\n${keep + 1}\\. \\*\\*\\[`));
    if (cut !== -1) el.value = el.value.slice(0, cut);
  }, keep);
  await page.focus("#prompt-text");
  await page.keyboard.press("End");
  await page.keyboard.type("\n\nThanks.");
  await shot(page, "composer");
  const reviews = () => document.getElementById("convo")?.innerText.split("I reviewed the diff in the Nexus dashboard").length - 1;
  const before = await page.evaluate(reviews);
  await page.click("#send");
  await page.waitForFunction((before) => document.getElementById("convo")?.innerText.split("I reviewed the diff in the Nexus dashboard").length - 1 > before, { timeout: 90_000 }, before);
  log(`the conversation shows ${await page.evaluate(reviews)} reviews, ${before} before the send`);
  await page.waitForFunction(() => document.getElementById("prompt-text")?.value === "");
  await pause(500);
  return text;
}

if (mode === "harness") {
  const page = await open();
  await page.evaluate(() => localStorage.clear());
  await base(page, "start");
  await diff(page, "src/server.ts");

  await drag(page, 10, 12);
  log(`dragged over lines 10-12 of src/server.ts: ${(await selected(page)).length} rows selected; the bar reads "${await page.$eval(".note-pick", (el) => el.innerText.replace(/\s+/g, " "))}"`);
  await shot(page, "01-selected");
  await write(page, "Comment", "notFound could live beside the routes map.");

  await page.focus(".diff-view");
  for (let i = 0; i < 18; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Shift");
  log(`keyboard selection: ${JSON.stringify(await selected(page))}`);
  await page.keyboard.press("q");
  await page.waitForSelector(".note-text");
  await shot(page, "02-question-draft");
  await page.keyboard.type("Why does a missing route return early here instead of falling through?");
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => document.querySelector(".note-draft") === null);

  await layout(page, "split");
  await drag(page, 12, 15, true);
  await write(page, "Suggestion", "Keep the 404 body empty, as before.");
  await shot(page, "03-split");
  await layout(page, "unified");
  log(`src/server.ts notes after the switch back to unified: ${JSON.stringify(await cards(page))}`);

  await base(page, "turn");
  await diff(page, "app.py");
  await drag(page, 7, 10);
  await write(page, "Requested change", "Raise a ValueError, not SystemExit, so callers can catch it.");
  await shot(page, "04-turn");

  await base(page, "head");
  await diff(page, "style.css");
  await drag(page, 3, 4);
  await page.keyboard.press("Escape");
  await drag(page, 3, 4);
  await write(page, "Comment", "Use the gap token here.", "c");

  const before = await review(page);
  await page.reload();
  await base(page, "head");
  await diff(page, "style.css");
  const after = await review(page);
  assert.deepEqual(after.notes, before.notes, "the notes survive a reload");
  log(`after a reload: ${after.notes.length} notes of kinds ${after.notes.map((n) => n.kind).join(", ")}; style.css shows ${JSON.stringify(await cards(page))}; the tree counts ${JSON.stringify(await page.$$eval(".note-count", (els) => els.map((e) => `${e.parentElement.dataset.path}: ${e.textContent}`)))}`);
  await shot(page, "05-reloaded");

  await drag(page, 1, 1);
  await write(page, "Question", "Is light-dark supported everywhere we run?");
  await page.click(".diff-view .note-question .btn-ghost");
  await page.waitForSelector(".note-text");
  await page.keyboard.type(" Safari 17.5?");
  await page.reload();
  await base(page, "head");
  await diff(page, "style.css");
  log(`a draft after a reload: ${await page.$eval(".note-text", (el) => el.value)}`);
  await page.click(".note-draft .note-actions .btn-ghost");
  await page.click(".diff-view .note-question .btn-ghost.danger");

  writeFileSync(join(process.env.REPO, "style.css"), readFileSync(join(process.env.REPO, "style.css"), "utf8").replace("gap: 8px;", "gap: 12px;"));
  await page.click("#changes-reload");
  await page.waitForFunction(() => document.querySelector(".notes-outdated") !== null, { timeout: 20_000 });
  log(`after style.css changed under its note: ${await page.$eval(".notes-outdated", (el) => el.innerText.replace(/\s+/g, " "))}`);
  await shot(page, "06-outdated");

  const dark = await open("dark");
  await base(dark, "start");
  await diff(dark, "src/server.ts");
  await shot(dark, "07-dark");
  await dark.close();

  const text = await send(page, 4);
  assert.equal((text.match(/^\d+\. \*\*\[/gm) ?? []).length, 5);
  for (const tag of ["COMMENT", "QUESTION", "SUGGESTION", "REQUESTED CHANGE"]) assert.match(text, new RegExp(`\\*\\*\\[${tag}\\]\\*\\*`));
  log(`after the send: the stored review is ${JSON.stringify(await review(page))}, and the conversation's last message starts "${await page.$eval("#convo", (el) => el.innerText.trim().split("\n").slice(-60).join(" ").slice(0, 120))}"`);
  await shot(page, "08-sent");
  await diff(page, "app.py").catch(() => {});
  const left = await review(page);
  assert.deepEqual(left.notes.map((n) => n.path), ["style.css"], "the note cut from the message stays in the review");
  log(`the review bar after the send: ${await page.$eval(".review-bar", (el) => el.innerText.replace(/\s+/g, " "))}`);
}

if (mode === "claude") {
  const page = await open();
  await page.evaluate(() => localStorage.clear());
  await base(page, "turn");
  log(`latest turn: ${await page.$eval("#changes-body", (el) => el.innerText.replace(/\s+/g, " "))}`);
  const path = await page.$eval("#changes-body .tree-file", (el) => el.dataset.path);
  await diff(page, path);
  const lines = await page.evaluate(() => [...document.querySelector(".diff-view").shadowRoot.querySelectorAll("[data-column-number]")]
    .filter((el) => el.dataset.lineType !== "change-deletion").map((el) => Number(el.textContent.trim())));
  log(`${path}'s diff shows new lines ${lines[0]}-${lines.at(-1)}`);
  await drag(page, lines[0], lines[2]);
  await write(page, "Question", "Why is this the order the functions come in?");
  await drag(page, lines.at(-3), lines.at(-1));
  await write(page, "Requested change", "Add a docstring to each function you added.");
  await page.reload();
  await base(page, "turn");
  await diff(page, path);
  log(`after a reload: ${JSON.stringify(await cards(page))}`);
  await shot(page, "01-notes");
  await send(page);
  log(`after the send: the stored review is ${JSON.stringify(await review(page))}`);
  await shot(page, "02-sent");
}

log(`problems: ${JSON.stringify(problems)}`);
await browser.close();
assert.deepEqual(problems.filter((p) => /CSP|page error/.test(p)), [], "no CSP violation and no page error");
