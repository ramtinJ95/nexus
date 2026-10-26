// Checks that a browser terminal on the dashboard can use the attach route the CLI uses, against the stack in
// ../claude-thread-streaming/stack.ts. It starts a thread with a shell session, then in headless Chromium: opens the
// attach WebSocket from the thread page under the dashboard's own CSP, opens it from a page on another origin, and
// renders the terminal with xterm.js on the thread page, types a command into it and resizes it. Last it renders
// xterm.js under the thread page's CSP with its DOM renderer and with its WebGL renderer. Chromium and the rest come
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

// The dashboard does not serve xterm.js, so this page takes it as an injected tag, which the dashboard's
// `script-src 'self'` refuses. A terminal that ships with the dashboard is served from 'self' and needs no bypass.
const cspBypassedPage = await browser.newPage();
await cspBypassedPage.setViewport({ width: 1440, height: 900 });
await cspBypassedPage.setBypassCSP(true);
await cspBypassedPage.goto(`${base}/threads/${thread}`, { waitUntil: "networkidle2" });
await cspBypassedPage.addStyleTag({ path: join(xterm, "css/xterm.css") });
await cspBypassedPage.addScriptTag({ path: join(xterm, "lib/xterm.js") });
await cspBypassedPage.evaluate((thread) => {
  const box = document.createElement("div");
  box.id = "terminal";
  box.style.cssText = "position:fixed;left:270px;right:330px;bottom:0;height:420px;background:#000;z-index:9;padding:6px";
  document.body.append(box);
  const term = new window.Terminal({ cols: 110, rows: 24, fontSize: 13 });
  term.open(box);
  const ws = new WebSocket(`ws://${location.host}/v1/threads/${thread}/attach?cols=110&rows=24&term=xterm-256color`);
  ws.binaryType = "arraybuffer";
  window.attach = { messages: [], bytes: 0, resize: (cols, rows) => { term.resize(cols, rows); ws.send(JSON.stringify({ type: "resize", cols, rows })); } };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") window.attach.messages.push(JSON.parse(e.data));
    else { window.attach.bytes += e.data.byteLength; term.write(new Uint8Array(e.data)); }
  };
  ws.onclose = (e) => window.attach.messages.push({ close: e.code });
  term.onData((keys) => ws.readyState === WebSocket.OPEN && ws.send(new TextEncoder().encode(keys)));
}, thread);
await sleep(4000);
await cspBypassedPage.click("#terminal");
await cspBypassedPage.keyboard.type("clear; echo typed in the dashboard, over the attach route; git --no-pager log --oneline -1\n");
await sleep(2500);
const screen = await cspBypassedPage.evaluate(() => document.querySelector("#terminal .xterm-rows")?.innerText ?? "");
const echoed = screen.split("\n").map((line) => line.trim()).find((line) => line.endsWith("typed in the dashboard, over the attach route"));
assert.ok(echoed !== undefined, "the typed command's output is not on the screen");
await cspBypassedPage.screenshot({ path: join(out, "attach-terminal.png") });
log(`typed a command in the browser terminal, and its output came back: ${JSON.stringify(echoed)}`);

await cspBypassedPage.evaluate(() => window.attach.resize(90, 16));
await sleep(1500);
const state = await cspBypassedPage.evaluate(() => window.attach);
assert.deepEqual(state.messages, [{ type: "attached" }], "the attach ended or reported an error");
log(`resized to 90x16, still attached: messages ${JSON.stringify(state.messages)}, ${state.bytes} bytes received`);

const csp = (await fetch(`${base}/threads/${thread}`)).headers.get("content-security-policy");
const selfServedXtermPage = (renderer) => `<!doctype html><link rel=stylesheet href=/xterm.css><div id=t></div><script src=/xterm.js></script><script src=/webgl.js></script><script src=/${renderer}.js></script>`;
const xtermBootScript = (webgl) => `window.violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective));
const term = new Terminal({ cols: 40, rows: 3 });
term.open(document.getElementById("t"));
${webgl ? "term.loadAddon(new WebglAddon.WebglAddon());" : ""}
term.write("\\x1b[32mgreen\\x1b[0m plain");`;
const files = {
  "/dom": ["text/html", selfServedXtermPage("dom")], "/webgl": ["text/html", selfServedXtermPage("webgl-start")],
  "/xterm.css": ["text/css", readFileSync(join(xterm, "css/xterm.css"))],
  "/xterm.js": ["text/javascript", readFileSync(join(xterm, "lib/xterm.js"))],
  "/webgl.js": ["text/javascript", readFileSync(join(process.env.MODULES, "@xterm/addon-webgl/lib/addon-webgl.js"))],
  "/dom.js": ["text/javascript", xtermBootScript(false)], "/webgl-start.js": ["text/javascript", xtermBootScript(true)],
};
const selfServedXterm = createServer((req, res) => {
  const file = files[req.url];
  if (file === undefined) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": file[0], "content-security-policy": csp }).end(file[1]);
}).listen(7472, "127.0.0.1");
for (const renderer of ["dom", "webgl"]) {
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:7472/${renderer}`, { waitUntil: "networkidle0" });
  await sleep(1000);
  const seen = await p.evaluate(() => {
    const green = [...document.querySelectorAll(".xterm-rows span")].find((span) => span.textContent === "green");
    return { violations: window.violations, domColor: green === undefined ? null : getComputedStyle(green).color };
  });
  await p.screenshot({ path: join(out, `xterm-csp-${renderer}.png`), clip: { x: 0, y: 0, width: 360, height: 70 } });
  log(`xterm.js ${renderer} renderer under ${JSON.stringify(csp)}: ${JSON.stringify(seen)}`);
  await p.close();
}
selfServedXterm.close();
await browser.close();
