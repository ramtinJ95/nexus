// Drives the stack in stack.ts in headless Chromium and saves what it saw here: the thread page's Changes view and the
// diff of each kind of change (an edit, a deletion, a rename, a mode change, a binary file and a diff too long to show
// whole) on each base, unified and split where the page offers both, in the light and dark themes, with every CSP
// violation and page error the page reported. Chromium and puppeteer-core come from the npm packages
// @sparticuz/chromium and puppeteer-core, installed outside the repo, whose node_modules MODULES names. THREAD is the
// thread ID the stack prints. LABEL prefixes the captures, so the same drive records the page before and after a change.
//
//   MODULES=... THREAD=th-... LABEL=after node docs/verification/pierre-diffs/drive.mjs
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const out = new URL(".", import.meta.url).pathname;
const label = process.env.LABEL;
const logFile = join(out, `${label}.log`);
const log = (line) => { console.log(line); appendFileSync(logFile, `${line}\n`); };

writeFileSync(logFile, "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const problems = [];
const requests = [];

async function open(scheme) {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.evaluateOnNewDocument(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI} ${e.sample}`));
  });
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${scheme}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${scheme}: page error ${e.message}`));
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  await page.goto(`http://127.0.0.1:7470/threads/${process.env.THREAD}`);
  await page.waitForSelector(".tree-file");
  return page;
}

async function base(page, which) {
  const want = { start: [false, false], head: [true, false], turn: [false, true] }[which];
  for (const [id, on] of [["changes-head", want[0]], ["changes-turn", want[1]]]) {
    if (await page.$eval(`#${id}`, (el) => el.checked) !== on) await page.click(`#${id}`);
  }
  await page.waitForFunction((label) => document.getElementById("changes-base").textContent.startsWith(label) && document.querySelector(".tree-file") !== null,
    {}, { start: "Since the pylon booted,", head: "Since the last commit,", turn: "Since the latest turn began," }[which]);
}

/** Opens a changed file's diff and waits until the view shows its lines or says why it has none. */
async function diff(page, path) {
  await page.click(`.tree-file[data-path="${path}"]`);
  await page.waitForFunction((path) => {
    const view = document.getElementById("file-view");
    return view.dataset.path === path && !/Reading the diff/.test(view.textContent) && view.querySelector(".fv-head") !== null;
  }, {}, path);
  await new Promise((r) => setTimeout(r, 600));
  return page.$eval("#file-view", (view) => view.innerText.split("\n").filter(Boolean).slice(0, 4).join(" | "));
}

const shot = async (page, name) => {
  await page.screenshot({ path: join(out, `${label}-${name}.png`) });
  log(`screenshot ${label}-${name}.png`);
};

const light = await open("light");
await base(light, "start");
log(`changes since boot: ${await light.$eval("#changes-body", (el) => el.innerText.replace(/\s+/g, " "))}`);
for (const [path, name] of [["src/server.ts", "modified-ts"], ["old.go", "deleted"], ["docs/handbook.md", "renamed"], ["logo.png", "binary"], ["run.sh", "mode"], ["config.txt", "typechange"], ["data/rows.csv", "long"]]) {
  log(`${path} since boot: ${await diff(light, path)}`);
  await shot(light, name);
}
await base(light, "turn");
log(`app.py since the latest turn: ${await diff(light, "app.py")}`);
await shot(light, "turn-python");
await base(light, "head");
log(`style.css since the last commit: ${await diff(light, "style.css")}`);
await shot(light, "head-css");

/** Picks a diff layout and waits until the open diff is drawn in it, where the page offers one. */
async function layout(page, which) {
  if (await page.$(".fv-layout") === null) return false;
  await page.click(`.fv-layout button[value="${which}"]`);
  await page.waitForFunction((which) => document.querySelector(".diff-view")?.shadowRoot?.querySelector("pre")?.dataset.diffType === (which === "split" ? "split" : "single"), {}, which);
  return true;
}

await base(light, "start");
await diff(light, "src/server.ts");
if (await layout(light, "split")) {
  await shot(light, "split-ts");
  await layout(light, "unified");
}

const dark = await open("dark");
await base(dark, "start");
log(`src/server.ts since boot, dark: ${await diff(dark, "src/server.ts")}`);
await shot(dark, "dark-modified-ts");
if (await layout(dark, "split")) {
  await shot(dark, "dark-split-ts");
  await layout(dark, "unified");
}

log(`requests: ${JSON.stringify([...new Set(requests.filter((p) => p.startsWith("/assets/")))])}`);
log(`problems: ${JSON.stringify(problems)}`);
await browser.close();
assert.deepEqual(problems.filter((p) => /CSP|page error/.test(p)), [], "no CSP violation and no page error");
