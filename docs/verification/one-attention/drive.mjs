// Drives the stack in stack.ts in headless Chromium and through the CLI, and saves what it saw in OUT: the home page
// with its tab title and favicon, the page after a Claude session moves from working to waiting, and the attention
// `show` and `events` report for a parked thread after `delete`. The tab title and favicon are outside a screenshot,
// so the page gets a box, marked as added by this script, that shows what the page set them to.
//
//   OUT=... ROOT=<checkout> STACK=<pid> IDS='{"reply":...}' MODULES=... node docs/verification/one-attention/drive.mjs
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const out = process.env.OUT;
const ids = JSON.parse(process.env.IDS);
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 720 } });
const page = await browser.newPage();

const seen = () => page.evaluate(() => ({
  title: document.title,
  favicon: document.querySelector('link[rel="icon"]').href.startsWith("data:") ? "red badge" : "plain",
  toasts: [...document.querySelectorAll(".attention-toast span")].map((s) => s.textContent),
  focused: document.hasFocus(),
  rows: [...document.querySelectorAll("#side-threads a.row")].map((a) => `${a.classList.contains("dim") ? "dim   " : "bright"} ${a.innerText.replace(/\s+/g, " ").trim()}`),
}));
const box = () => page.evaluate(() => {
  const icon = document.querySelector('link[rel="icon"]').href;
  const div = document.createElement("div");
  div.id = "drive-box";
  div.style.cssText = "position:fixed;top:12px;right:12px;z-index:200;padding:10px 14px;background:#fff8c5;color:#111;border:2px dashed #b08800;border-radius:6px;font:14px/1.5 system-ui,sans-serif;display:flex;gap:10px;align-items:center";
  div.innerHTML = `<img src="${icon}" width="28" height="28"><span>Added by drive.mjs. Tab title: <b>${document.title}</b></span>`;
  document.body.append(div);
});
const shot = async (name) => {
  await box();
  await page.screenshot({ path: join(out, name) });
  await page.evaluate(() => document.getElementById("drive-box").remove());
  log(`screenshot ${name}`);
};

await page.goto("http://127.0.0.1:7470/");
await page.waitForSelector("#side-threads");
await sleep(2500);
log(`home ${JSON.stringify(await seen(), null, 2)}`);
await shot("01-home.png");

process.kill(Number(process.env.STACK), "SIGUSR2");
await sleep(3000);
log(`after "Pick a migration path" moved from working to waiting ${JSON.stringify(await seen(), null, 2)}`);
await shot("02-session-waits.png");
await browser.close();

const cli = (args) => execFileSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env: { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" }, encoding: "utf8" });
const nexus = (name, args) => {
  const text = cli(args);
  writeFileSync(join(out, `${name}.txt`), `$ nexus ${args.join(" ")}\n${text}`);
  log(`$ nexus ${args.join(" ")}\n${text}`);
};
nexus("03-events-parked", ["events", "--thread", ids.parked, "--kind", "attention.changed"]);
nexus("04-delete", ["delete", ids.parked]);
const shown = JSON.parse(cli(["show", ids.parked, "--json"])).attention;
const last = JSON.parse(/attention\.changed (\{.*\})$/.exec(cli(["events", "--thread", ids.parked, "--kind", "attention.changed"]).trim().split("\n").at(-1))[1]).attention;
nexus("05-show-deleted", ["show", ids.parked]);
nexus("06-events-deleted", ["events", "--thread", ids.parked, "--kind", "attention.changed"]);
log(`deleted parked thread: show says attention ${JSON.stringify(shown)}, the event stream last said ${JSON.stringify(last)}, ${shown === last ? "they agree" : "THEY DISAGREE"}`);
