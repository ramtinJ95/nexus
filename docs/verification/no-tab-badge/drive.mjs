// Opens the home page and a thread page of the stack in ../dashboard-scrolling/stack.ts, whose threads need the person,
// and saves in OUT what the browser tab would show: tab.json with each page's title and icon link as the page served
// them and as they stood once the page had read the threads; tab.png, those drawn as a tab on a light and a dark tab bar;
// and icon.png, the static icon the page links at 16, 32 and 128 px on light and dark backgrounds. A headless browser
// has no tab bar, so tab.png is drawn from the values, not captured from one.
//
//   OUT=... STACK='{...}' MODULES=... node docs/verification/no-tab-badge/drive.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const out = process.env.OUT;
const ids = JSON.parse(process.env.STACK);
const base = "http://127.0.0.1:7470";

const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
const page = await browser.newPage();
const threads = await (await fetch(`${base}/v1/threads?deleted=false`)).json();
const attention = Object.groupBy(threads.filter((t) => t.attention !== null), (t) => t.attention);
const tabs = [];
for (const [name, path] of [["home", "/"], ["thread", `/threads/${ids.long}`]]) {
  const served = await (await fetch(`${base}${path}`)).text();
  await page.goto(`${base}${path}`);
  await page.waitForResponse((r) => r.url().includes("/v1/threads?deleted=false"));
  await new Promise((r) => setTimeout(r, 1500));
  const shown = await page.evaluate(() => ({ title: document.title, icon: document.querySelector('link[rel="icon"]').href }));
  const icon = await (await fetch(shown.icon.startsWith("data:") ? shown.icon : new URL(shown.icon, base))).text();
  tabs.push({ name, static: await (await fetch(new URL(/<link rel="icon" href="([^"]+)"/.exec(served)[1], base))).text(), served: { title: /<title>(.*?)<\/title>/.exec(served)[1].replaceAll("&middot;", "·"), icon: /<link rel="icon" href="([^"]+)"/.exec(served)[1] }, shown, icon });
}
writeFileSync(join(out, "tab.json"), `${JSON.stringify({ needsPerson: Object.fromEntries(Object.entries(attention).map(([k, v]) => [k, v.length])), tabs: tabs.map(({ icon, static: _, ...t }) => t) }, null, 2)}\n`);

const svg = (text) => `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;
const bar = (bg, tab, fg) => `<div style="background:${bg};padding:8px 8px 0;display:flex;gap:2px">${tabs.map((t) => `<div style="background:${tab};color:${fg};border-radius:8px 8px 0 0;padding:8px 12px;width:220px;display:flex;gap:8px;align-items:center;font:12px system-ui,sans-serif"><img width="16" height="16" src="${svg(t.icon)}"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.shown.title}</span></div>`).join("")}</div>`;
const drawing = await browser.newPage();
await drawing.setViewport({ width: 480, height: 100, deviceScaleFactor: 2 });
await drawing.setContent(`<body style="margin:0;display:inline-block;width:480px">${bar("#dee1e6", "#ffffff", "#1f1f1f")}${bar("#202124", "#35363a", "#e3e3e3")}</body>`);
await drawing.waitForFunction(() => [...document.images].every((i) => i.complete));
await (await drawing.$("body")).screenshot({ path: join(out, "tab.png") });
const sizes = (bg) => `<div style="background:${bg};padding:16px;display:flex;gap:16px;align-items:center">${[16, 32, 128].map((size) => `<img width="${size}" height="${size}" src="${svg(tabs[0].static)}">`).join("")}</div>`;
await drawing.setContent(`<body style="margin:0;display:inline-flex">${sizes("#ffffff")}${sizes("#202124")}</body>`);
await drawing.waitForFunction(() => [...document.images].every((i) => i.complete));
await (await drawing.$("body")).screenshot({ path: join(out, "icon.png") });
await browser.close();
