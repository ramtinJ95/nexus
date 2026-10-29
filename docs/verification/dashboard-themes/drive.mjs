// Drives the stack in stack.ts in headless Chromium and saves what it saw in OUT: each theme's pages at a desktop
// width and at a phone's, in a folder per theme, and findings.txt, which says for each check what the page measured
// and whether that is what the theme picker promises.
//
//   OUT=... STACK='{...}' MODULES=... node docs/verification/dashboard-themes/drive.mjs
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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

const themes = ["light", "dark", "tokyo-night", "catppuccin-mocha", "kanagawa-wave"];
/** Each theme's page background, as style.css gives it. */
const backgrounds = { light: "rgb(255, 255, 255)", dark: "rgb(28, 28, 30)", "tokyo-night": "rgb(26, 27, 38)", "catppuccin-mocha": "rgb(30, 30, 46)", "kanagawa-wave": "rgb(31, 31, 40)" };
const widths = [{ name: "desktop", width: 1280, height: 900, mobile: false }, { name: "phone", width: 390, height: 844, mobile: true }];

// What a terminal of the pylon shows, as the attach route would send it: a prompt, a Claude Code-like reply with a
// diff, and the 16 colours of the theme's palette, normal and bright.
const esc = (code) => `\x1b[${code}m`;
const sample = [
  `${esc("1;32")}verify@pylon${esc(0)}:${esc("1;34")}~/workspace/repo${esc(0)}$ claude`,
  "",
  `${esc("38;5;174")}✻${esc(0)} Welcome to ${esc(1)}Claude Code${esc(0)}`,
  "",
  `${esc(2)}>${esc(0)} Make the planner return a list of actions`,
  "",
  `${esc(1)}●${esc(0)} I'll change ${esc(36)}src/control/loop.ts${esc(0)} so the planner returns actions.`,
  "",
  `  ${esc(1)}Update${esc(0)}(src/control/loop.ts)`,
  `  ${esc(31)}- export const step3 = (state: number) => state + 3;${esc(0)}`,
  `  ${esc(32)}+ export const step3 = (state: number, by = 3) => state + by;${esc(0)}`,
  "",
  `  ${esc(33)}⚠ 2 tests were skipped${esc(0)}   ${esc(35)}✓ 118 passed${esc(0)}   ${esc(90)}(4.2s)${esc(0)}`,
  "",
  ["", "normal ", ...[0, 1, 2, 3, 4, 5, 6, 7].map((c) => `${esc(40 + c)}  ${esc(0)}${esc(30 + c)} ${c} ${esc(0)}`)].join(""),
  ["", "bright ", ...[0, 1, 2, 3, 4, 5, 6, 7].map((c) => `${esc(100 + c)}  ${esc(0)}${esc(90 + c)} ${c} ${esc(0)}`)].join(""),
  "",
  `${esc("1;32")}verify@pylon${esc(0)}:${esc("1;34")}~/workspace/repo${esc(0)}$ `,
].join("\r\n");

writeFileSync(join(out, "drive.log"), "");
writeFileSync(join(out, "findings.txt"), "");
const finding = (check, measured, ok) => {
  const line = `${check}: ${measured} -> ${ok ? "ok" : "BUG"}`;
  appendFileSync(join(out, "findings.txt"), `${line}\n`);
  log(line);
};
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });

/** A page whose attach WebSocket is a stand-in that attaches at once and sends the sample, as no pylon runs here. */
async function newPage(view) {
  const page = await browser.newPage();
  await page.setViewport({ width: view.width, height: view.height, isMobile: view.mobile, hasTouch: view.mobile });
  page.on("pageerror", (err) => log(`${view.name}: page error: ${err.message}`));
  await page.evaluateOnNewDocument((sample) => {
    const Real = window.WebSocket;
    window.WebSocket = class extends EventTarget {
      constructor(url) {
        if (!String(url).includes("/attach")) return new Real(url);
        super();
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "attached" }) }));
          this.dispatchEvent(new MessageEvent("message", { data: new TextEncoder().encode(sample).buffer }));
        }, 50);
      }
      send() {}
      close() { this.readyState = 3; }
    };
  }, sample);
  return page;
}
const ev = (page, f, ...args) => page.evaluate(f, ...args);
/** Long enough for the page to load its client and draw, as its poll and stream keep the network busy for good. */
const settle = () => sleep(1_500);
const pick = async (page, theme) => { await page.select("#theme", theme); await sleep(150); };
const shown = (page) => ev(page, () => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).backgroundColor, picked: document.getElementById("theme")?.value }));

async function openDiff(page) {
  await page.waitForSelector(".tree-file", { timeout: 30_000 });
  await ev(page, () => document.querySelector('.tree-file[data-path="src/control/loop.ts"]').click());
  await ev(page, () => document.querySelector(".scrim")?.click());
  await page.waitForFunction(() => document.querySelector("#file-view .diff-view") !== null, { timeout: 60_000 });
  await sleep(800);
}
/** The background the diff draws its code on, from inside its shadow root. */
const diffBackground = (page) => ev(page, () => {
  const line = document.querySelector("#file-view .diff-view").shadowRoot.querySelector("[data-line]");
  return getComputedStyle(line).backgroundColor;
});
async function openTerminal(page) {
  await ev(page, () => document.querySelector('[data-tab="term"]').click());
  await page.waitForFunction(() => document.querySelector("#term-host .xterm-rows")?.textContent.includes("passed"), { timeout: 30_000 });
  await sleep(500);
}
/** What xterm.js draws the terminal's background and its first red cell in. */
const terminalColours = (page) => ev(page, () => {
  const red = [...document.querySelectorAll("#term-host .xterm-rows span")].find((s) => s.textContent.startsWith("- export"));
  return { bg: getComputedStyle(document.querySelector("#term-host .xterm-viewport") ?? document.querySelector("#term-host .xterm")).backgroundColor, red: red === undefined ? null : getComputedStyle(red).color };
});

const pages = [
  ["home", "/"],
  ["thread", `/threads/${ids.long}`],
  ["question", `/threads/${ids.asks}`],
  ["diff", `/threads/${ids.long}`, openDiff],
  ["terminal", `/threads/${ids.long}`, openTerminal],
  ["pipeline", "/pipeline"],
  ["claude", `/threads/${ids.claude}`, null, "desktop"],
  ["review", `/threads/${ids.reviewed}`, null, "desktop"],
  ["land", `/threads/${ids.landable}`, null, "desktop"],
  ["usage", "/usage", null, "desktop"],
  ["node", `/nodes/${ids.node}`, null, "desktop"],
  ["sidebar", "/", async (page) => { await ev(page, () => document.querySelector(".menu").click()); await sleep(300); }, "phone"],
];

for (const view of widths) {
  const page = await newPage(view);
  for (const theme of themes) {
    mkdirSync(join(out, theme), { recursive: true });
    await page.goto(`${base}/`);
    await ev(page, (theme) => localStorage.setItem("nexus.theme", theme), theme);
    for (const [name, path, act, only] of pages) {
      if (only !== undefined && only !== view.name) continue;
      await page.goto(`${base}${path}`);
      await settle();
      if (act) await act(page);
      const { theme: on, picked } = await shown(page);
      const wide = await ev(page, () => document.documentElement.scrollWidth > innerWidth + 1);
      if (on !== theme || picked !== theme || wide) finding(`${view.name} ${theme} ${name}`, `shows ${on}, the picker says ${picked}, wider than the window ${wide}`, false);
      const file = join(theme, `${view.name}-${name}.png`);
      await page.screenshot({ path: join(out, file) });
      log(`screenshot ${file}`);
    }
  }
  await page.close();
}

const desktop = widths[0];
const page = await newPage(desktop);
await page.goto(`${base}/`);
await ev(page, () => localStorage.clear());

// The head script alone sets the theme: with client.js served empty, each stored theme still paints its own
// background, and the picker keeps the server's first option, as nothing of the client ran.
await page.setCacheEnabled(false);
await page.setRequestInterception(true);
const refuse = (req) => (req.url().includes("/assets/client.js") ? req.respond({ status: 200, contentType: "text/javascript", body: "" }) : req.continue());
page.on("request", refuse);
for (const theme of themes) {
  await ev(page, (theme) => localStorage.setItem("nexus.theme", theme), theme);
  await page.goto(`${base}/`);
  const { theme: on, bg } = await shown(page);
  const picked = await ev(page, () => document.getElementById("theme").value);
  finding(`first paint with client.js served empty, stored ${theme}`, `data-theme ${on}, background ${bg}, the picker untouched at ${picked}`, on === theme && bg === backgrounds[theme] && picked === "system");
}
page.off("request", refuse);
await page.setRequestInterception(false);
await page.setCacheEnabled(true);
await ev(page, () => localStorage.clear());

await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await page.goto(`${base}/`);
await settle();
let now = await shown(page);
finding("nothing stored, a light device", `picker ${now.picked}, data-theme ${now.theme}`, now.picked === "system" && now.theme === "light");
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await sleep(200);
now = await shown(page);
finding("System, the device turns dark with the page open", `data-theme ${now.theme}, background ${now.bg}`, now.theme === "dark" && now.bg === backgrounds.dark);
await page.screenshot({ path: join(out, "system-dark-device.png") });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await sleep(200);
now = await shown(page);
finding("System, the device turns light again", `data-theme ${now.theme}`, now.theme === "light");

await ev(page, () => { window.notReloaded = true; });
await pick(page, "tokyo-night");
now = await shown(page);
const stayed = await ev(page, () => window.notReloaded === true);
finding("picking Tokyo Night", `data-theme ${now.theme}, background ${now.bg}, same document ${stayed}, stored ${await ev(page, () => localStorage.getItem("nexus.theme"))}`, now.theme === "tokyo-night" && now.bg === backgrounds["tokyo-night"] && stayed);
await page.reload();
await settle();
now = await shown(page);
finding("Tokyo Night after a reload", `data-theme ${now.theme}, picker ${now.picked}`, now.theme === "tokyo-night" && now.picked === "tokyo-night");

const toggle = async () => { await page.click("#theme-toggle"); await sleep(150); return { ...(await shown(page)), label: await ev(page, () => document.getElementById("theme-toggle").getAttribute("aria-label")) }; };
const before = await ev(page, () => document.getElementById("theme-toggle").getAttribute("aria-label"));
let toggled = await toggle();
finding("the toggle from Tokyo Night", `labelled "${before}", then data-theme ${toggled.theme}, picker ${toggled.picked}, labelled "${toggled.label}"`, toggled.theme === "light" && toggled.picked === "light");
toggled = await toggle();
finding("the toggle again", `data-theme ${toggled.theme}, picker ${toggled.picked}`, toggled.theme === "tokyo-night");
await pick(page, "light");
await ev(page, () => localStorage.removeItem("nexus.theme.dark"));
await page.reload();
await settle();
toggled = await toggle();
finding("the toggle from Light before any dark theme was picked", `data-theme ${toggled.theme}`, toggled.theme === "dark");
await pick(page, "system");
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await sleep(200);
toggled = await toggle();
finding("the toggle from System on a dark device", `data-theme ${toggled.theme}, picker ${toggled.picked}`, toggled.theme === "light" && toggled.picked === "light");
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);

const other = await newPage(desktop);
await other.goto(`${base}/pipeline`);
await settle();
await pick(page, "kanagawa-wave");
await sleep(300);
const there = await shown(other);
finding("another tab when this one picks Kanagawa Wave", `data-theme ${there.theme}, picker ${there.picked}`, there.theme === "kanagawa-wave" && there.picked === "kanagawa-wave");
await other.close();

await pick(page, "light");
await page.goto(`${base}/threads/${ids.long}`);
await settle();
await openDiff(page);
const lightDiff = await diffBackground(page);
await ev(page, () => { window.notReloaded = true; });
await pick(page, "catppuccin-mocha");
await page.waitForFunction(() => document.querySelector("#file-view .diff-view")?.shadowRoot.querySelector("[data-line]") !== null, { timeout: 30_000 });
await sleep(1_500);
const mochaDiff = await diffBackground(page);
/** The lightness of a colour the diff gives in CSS's lab(), from 0 for black to 100 for white. */
const lightness = (lab) => Number(/^lab\(([\d.]+)/.exec(lab)?.[1]);
finding("the open diff when Light becomes Catppuccin Mocha", `code background ${lightDiff}, then ${mochaDiff}, same document ${await ev(page, () => window.notReloaded === true)}`, lightness(lightDiff) > 85 && lightness(mochaDiff) < 25);
await page.screenshot({ path: join(out, "diff-switched-to-catppuccin-mocha.png") });

await pick(page, "light");
await openTerminal(page);
const lightTerm = await terminalColours(page);
await pick(page, "tokyo-night");
await sleep(500);
const tokyoTerm = await terminalColours(page);
await pick(page, "kanagawa-wave");
await sleep(500);
const kanagawaTerm = await terminalColours(page);
finding("the open terminal through Light, Tokyo Night and Kanagawa Wave", `background ${lightTerm.bg}, ${tokyoTerm.bg}, ${kanagawaTerm.bg}; red ${lightTerm.red}, ${tokyoTerm.red}, ${kanagawaTerm.red}`,
  lightTerm.bg === "rgb(22, 24, 29)" && tokyoTerm.bg === "rgb(26, 27, 38)" && kanagawaTerm.bg === "rgb(31, 31, 40)" && tokyoTerm.red === "rgb(247, 118, 142)" && kanagawaTerm.red === "rgb(195, 64, 67)");
await page.screenshot({ path: join(out, "terminal-switched-to-kanagawa-wave.png") });

// A browser whose storage refuses every write, as a full quota does: the picker and the toggle still apply.
const refusing = await newPage(desktop);
await refusing.evaluateOnNewDocument(() => {
  Storage.prototype.setItem = () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
});
await refusing.goto(`${base}/`);
await settle();
await pick(refusing, "tokyo-night");
const refusedPick = await shown(refusing);
await refusing.click("#theme-toggle");
await sleep(150);
const refusedLight = await shown(refusing);
await refusing.click("#theme-toggle");
await sleep(150);
const refusedBack = await shown(refusing);
finding("storage that refuses writes: pick Tokyo Night, toggle, toggle", `data-theme ${refusedPick.theme}, ${refusedLight.theme}, ${refusedBack.theme}`, refusedPick.theme === "tokyo-night" && refusedLight.theme === "light" && refusedBack.theme === "tokyo-night");
await refusing.close();

// A question asked on another thread toasts on the page the reader has focused, once its poll sees it.
const asked = [ids.long, ids.live, ids.claude, ids.reviewed, ids.landable];
for (const [i, theme] of themes.entries()) {
  await pick(page, theme);
  await page.goto(`${base}/pipeline`);
  await settle();
  await control("ask", { thread: asked[i] });
  const toasted = await page.waitForSelector(".attention-toast", { timeout: 20_000 }).then(() => true, () => false);
  finding(`a toast in ${theme}`, `shown ${toasted}`, toasted);
  await page.screenshot({ path: join(out, theme, "desktop-toast.png") });
}

await browser.close();
