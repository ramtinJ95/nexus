import { createServer as createTcp, connect } from "node:net";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { startServeEntry } from "./serve-entry.ts";
import { WebSocketServer } from "../../../node_modules/ws/wrapper.mjs";

const { startGateway } = await import(process.argv[2]!);
const browserDir = process.env.BROWSER_DIR!;
const { default: chromium } = await import(`${browserDir}/node_modules/@sparticuz/chromium/build/esm/index.js`);
const { default: puppeteer } = await import(`${browserDir}/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js`);
const dir = import.meta.dirname;
const certDir = process.env.CERT_DIR!;
const host = "rj-firebat.example.ts.net";
const viteMain = `${process.env.VITE_APP}/main.js`;
writeFileSync(viteMain, 'document.getElementById("h").textContent = "main loaded v1";\n');

function relay(to: { host: string; port: number }) {
  const server = createTcp((c) => { const up = connect(to.port, to.host); c.pipe(up).pipe(c); up.on("error", () => c.destroy()); c.on("error", () => up.destroy()); });
  return new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
}

const python = spawn("python3", [`${dir}/wsgi_app.py`, "8001"], { stdio: "inherit" });
const naive = createServer((req, res) => {
  if (req.url === "/") return res.writeHead(302, { location: `http://${req.headers.host}/dashboard` }).end();
  if (req.url === "/app.js") return res.writeHead(200, { "content-type": "text/javascript" })
    .end('document.body.append("script ran. "); const s = new WebSocket("ws://" + location.host + "/live"); s.onmessage = (e) => document.body.append("live reload: " + e.data);');
  res.writeHead(200, { "content-type": "text/html" }).end(`<p>dashboard</p><script src="http://${req.headers.host}/app.js"></script>`);
});
const live = new WebSocketServer({ noServer: true });
naive.on("upgrade", (req, socket, head) => live.handleUpgrade(req, socket, head, (ws) => ws.send("connected")));
await new Promise<void>((r) => naive.listen(8002, "127.0.0.1", () => r()));
await new Promise((r) => setTimeout(r, 500));

const apps = [
  { port: 10201, service: "vite", relay: await relay({ host: "::1", port: 5173 }) },
  { port: 10202, service: "wsgi", relay: await relay({ host: "127.0.0.1", port: 8001 }) },
  { port: 10203, service: "naive", relay: await relay({ host: "127.0.0.1", port: 8002 }) },
];
const gateway = await startGateway({
  port: 0,
  routes: new Map(apps.map((a) => [a.port, { pylonId: "pylon-probe", service: a.service }])),
  origin: (route: { service: string }) => `http://127.0.0.1:${apps.find((a) => a.service === route.service)!.relay}`,
  onHit: () => {},
});
const gatewayPort = Number(new URL(gateway.origin).port);
const fronts = await Promise.all(apps.map((a) => startServeEntry(a.port, gatewayPort, certDir)));
const dashboard = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" })
  .end(`<h1>Previews</h1>${apps.map((a) => `<a id="${a.service}" href="https://${host}:${a.port}/">${a.service}</a>`).join(" ")}`));
await new Promise<void>((r) => dashboard.listen(0, "127.0.0.1", () => r()));
const dashboardFront = await startServeEntry(7443, (dashboard.address() as { port: number }).port, certDir);

const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args, `--host-resolver-rules=MAP ${host} 127.0.0.1`, "--ignore-certificate-errors"],
  headless: true,
});

for (const app of apps) {
  const page = await browser.newPage();
  const log: string[] = [];
  page.on("console", (m) => log.push(`console ${m.type()}: ${m.text().slice(0, 240)}`));
  page.on("requestfailed", (r) => log.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on("response", (r) => {
    if (r.status() >= 300 && r.status() < 400) log.push(`redirect ${r.status()}: ${r.url()} -> ${r.headers().location}`);
    else log.push(`loaded ${r.status()}: ${r.url()}`);
  });
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketCreated", (e) => log.push(`websocket opened: ${e.url}`));
  cdp.on("Network.webSocketHandshakeResponseReceived", (e) => log.push(`websocket handshake: ${e.response.status}`));
  await page.goto(`https://${host}:7443/`);
  log.length = 0;
  await Promise.all([page.waitForNavigation({ timeout: 10_000 }).catch((e) => log.push(`navigation: ${e.message}`)), page.evaluate((id) => (document.getElementById(id) as HTMLAnchorElement).click(), app.service)]);
  await new Promise((r) => setTimeout(r, 2500));
  console.log(`\n## ${app.service}: on https://${host}:7443/, follow the link to https://${host}:${app.port}/`);
  for (const l of log) console.log(`- ${l}`);
  console.log(`- landed on ${page.url()}`);
  console.log(`- page text: ${JSON.stringify((await page.evaluate(() => document.body?.textContent ?? "")).trim().slice(0, 120))}`);
  if (app.service === "wsgi") {
    log.length = 0;
    await page.goto(`https://${host}:${app.port}/login`);
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`- then open https://${host}:${app.port}/login directly:`);
    for (const l of log) console.log(`  - ${l}`);
  }
  if (app.service === "vite") {
    const before = log.length;
    writeFileSync(viteMain, 'document.getElementById("h").textContent = "main loaded v2";\n');
    await new Promise((r) => setTimeout(r, 3000));
    for (const l of log.slice(before)) console.log(`- after editing main.js: ${l}`);
    console.log(`- after editing main.js, page text: ${JSON.stringify((await page.evaluate(() => document.body?.textContent ?? "")).trim())}`);
  }
  await page.close();
}

await browser.close();
for (const f of [...fronts, dashboardFront]) f.close();
await gateway.close();
naive.close();
dashboard.close();
python.kill();
process.exit(0);
