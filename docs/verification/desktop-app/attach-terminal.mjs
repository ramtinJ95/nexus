// Checks that a browser terminal on the dashboard can use the attach route the CLI uses, against the stack in
// ../claude-thread-streaming/stack.ts. It starts a thread with a shell session, then in headless Chromium: opens the
// attach WebSocket from the thread page under the dashboard's own CSP, and opens it from a page on another origin.
// Then it renders the terminal with xterm.js on the thread page, under that page's own CSP: with the WebGL renderer it
// types a command and resizes, and with the DOM renderer it records what the CSP refuses. Chromium and the rest come
// from the npm packages @sparticuz/chromium, puppeteer-core, @xterm/xterm and @xterm/addon-webgl, installed outside the
// repo: MODULES names their node_modules, and LD_LIBRARY_PATH and FONTCONFIG_FILE their libraries and fonts.
//
//   MODULES=... node docs/verification/desktop-app/attach-terminal.mjs
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const xterm = join(process.env.MODULES, "@xterm/xterm");
const out = new URL(".", import.meta.url).pathname;
const base = "http://127.0.0.1:7470";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(join(out, "attach.log"), "");
const log = (line) => { console.log(line); appendFileSync(join(out, "attach.log"), `${new Date().toISOString()} ${line}\n`); };
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} answered ${res.status} ${await res.text()}`);
  return res.json();
};

const thread = (await post("/v1/threads", { project: "words", title: "Browser terminal" })).id;
await post(`/v1/threads/${thread}/sessions`, { harness: "shell", title: "shell" });
log(`thread ${thread} with a shell session`);

const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const attachFrom = (p) => p.evaluate((thread) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:7470/v1/threads/${thread}/attach?cols=80&rows=24`);
  ws.binaryType = "arraybuffer";
  let bytes = 0;
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") bytes += e.data.byteLength;
    else if (JSON.parse(e.data).type === "attached") setTimeout(() => { ws.close(); resolve({ attached: true, bytes }); }, 1500);
  };
  ws.onerror = () => resolve({ attached: false, bytes });
}), thread);

await page.goto(`${base}/threads/${thread}`, { waitUntil: "networkidle2" });
const own = await attachFrom(page);
assert.ok(own.attached && own.bytes > 0, `the thread page could not attach under its CSP: ${JSON.stringify(own)}`);
log(`from the dashboard's origin, under its CSP: attached, ${own.bytes} bytes of Herdr's screen`);

const other = createServer((_, res) => res.end("<!doctype html><title>other</title>")).listen(7471, "127.0.0.1");
const elsewhere = await browser.newPage();
await elsewhere.goto("http://127.0.0.1:7471/");
const refused = await attachFrom(elsewhere);
assert.equal(refused.attached, false, "a page on another origin attached");
const answer = await new Promise((resolve, reject) => {
  get(`${base}/v1/threads/${thread}/attach?cols=80&rows=24`, {
    headers: { origin: "http://127.0.0.1:7471", connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
  }, (res) => {
    let body = "";
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve(`${res.statusCode} ${body}`));
  }).on("error", reject);
});
log(`from http://127.0.0.1:7471: refused, ${answer}`);
await elsewhere.close();
other.close();

// The dashboard does not serve xterm.js, so each terminal page is the real thread page, with its real headers and CSP,
// plus script tags for xterm.js that the browser loads from the dashboard's own origin, as shipped assets would be.
const assets = {
  "/__terminal/xterm.css": ["text/css", readFileSync(join(xterm, "css/xterm.css"))],
  "/__terminal/xterm.js": ["text/javascript", readFileSync(join(xterm, "lib/xterm.js"))],
  "/__terminal/webgl.js": ["text/javascript", readFileSync(join(process.env.MODULES, "@xterm/addon-webgl/lib/addon-webgl.js"))],
};
for (const renderer of ["dom", "webgl"]) assets[`/__terminal/${renderer}-start.js`] = ["text/javascript", `window.violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective));
const box = document.createElement("div");
box.id = "terminal";
box.style.position = "fixed"; box.style.left = "270px"; box.style.right = "330px"; box.style.bottom = "0"; box.style.height = "420px"; box.style.zIndex = "9";
document.body.append(box);
const term = new Terminal({ cols: 110, rows: 24, fontSize: 13 });
term.open(box);
${renderer === "webgl" ? "term.loadAddon(new WebglAddon.WebglAddon());" : ""}
const ws = new WebSocket(\`ws://\${location.host}/v1/threads/\${location.pathname.split("/")[2]}/attach?cols=110&rows=24&term=xterm-256color\`);
ws.binaryType = "arraybuffer";
window.attach = {
  messages: [], bytes: 0,
  resize: (cols, rows) => { term.resize(cols, rows); ws.send(JSON.stringify({ type: "resize", cols, rows })); },
  screen: () => Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? ""),
};
ws.onmessage = (e) => {
  if (typeof e.data === "string") window.attach.messages.push(JSON.parse(e.data));
  else { window.attach.bytes += e.data.byteLength; term.write(new Uint8Array(e.data)); }
};
ws.onclose = (e) => window.attach.messages.push({ close: e.code });
term.onData((keys) => ws.readyState === WebSocket.OPEN && ws.send(new TextEncoder().encode(keys)));
term.focus();`];

const dashboardTerminal = async (renderer) => {
  const p = await browser.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.setRequestInterception(true);
  p.on("request", async (request) => {
    const path = new URL(request.url()).pathname;
    const asset = assets[path];
    if (asset !== undefined) return request.respond({ status: 200, contentType: asset[0], body: asset[1] });
    if (path !== `/threads/${thread}` || request.resourceType() !== "document") return request.continue();
    const res = await fetch(request.url());
    const tags = `<link rel="stylesheet" href="/__terminal/xterm.css"><script src="/__terminal/xterm.js"></script><script src="/__terminal/webgl.js"></script><script src="/__terminal/${renderer}-start.js"></script>`;
    const headers = Object.fromEntries([...res.headers].filter(([name]) => !["content-length", "content-encoding", "transfer-encoding"].includes(name)));
    request.respond({ status: res.status, headers, body: (await res.text()).replace("</body>", `${tags}</body>`) });
  });
  await p.goto(`${base}/threads/${thread}`, { waitUntil: "networkidle2" });
  await sleep(4000);
  return p;
};

const csp = (await fetch(`${base}/threads/${thread}`)).headers.get("content-security-policy");
const webgl = await dashboardTerminal("webgl");
await webgl.keyboard.type("clear; echo typed in the dashboard, over the attach route; git --no-pager log --oneline -1\n");
await sleep(2500);
const echoed = (await webgl.evaluate(() => window.attach.screen())).map((line) => line.trim()).find((line) => line.endsWith("typed in the dashboard, over the attach route"));
assert.ok(echoed !== undefined, "the typed command's output is not on the screen");
await webgl.screenshot({ path: join(out, "attach-terminal.png") });
log(`WebGL renderer on the thread page under its own CSP ${JSON.stringify(csp)}: typed a command, and its output came back: ${JSON.stringify(echoed)}`);
await webgl.evaluate(() => window.attach.resize(90, 16));
await sleep(1500);
const state = await webgl.evaluate(() => ({ messages: window.attach.messages, bytes: window.attach.bytes, violations: window.violations }));
assert.deepEqual(state.messages, [{ type: "attached" }], "the attach ended or reported an error");
assert.ok(!state.violations.some((directive) => directive.startsWith("script-src") || directive.startsWith("connect-src")), "the CSP refused a script or the socket");
log(`resized to 90x16, still attached: ${state.bytes} bytes received, CSP violations ${JSON.stringify(state.violations)}`);
await webgl.close();

const dom = await dashboardTerminal("dom");
const seen = await dom.evaluate(() => {
  const row = [...document.querySelectorAll("#terminal .xterm-rows > div")].find((div) => div.textContent.trim() !== "");
  return { attached: window.attach.messages.some((m) => m.type === "attached"), violations: window.violations, color: row === undefined ? null : getComputedStyle(row).color, background: getComputedStyle(document.querySelector("#terminal .xterm-viewport")).backgroundColor };
});
assert.ok(seen.attached && seen.violations.includes("style-src-elem"), `expected the DOM renderer's styles to be refused: ${JSON.stringify(seen)}`);
await dom.screenshot({ path: join(out, "attach-terminal-dom.png") });
log(`DOM renderer on the thread page under the same CSP: ${JSON.stringify(seen)}`);
await browser.close();
