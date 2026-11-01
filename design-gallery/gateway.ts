/**
 * The design gallery: one port that shows every dashboard design over the same demo data. A bar on top picks the
 * design, the page, the theme and the width, and the dashboard runs in a frame below it, so the bar covers nothing.
 * A cookie names the design, and every other request is proxied to that design's demo server, so the dashboard's
 * absolute paths, polls, streams and terminals reach the design the person is looking at. The compare view shows one
 * page in every design side by side, from screenshots the headless shooter takes on demand.
 *
 *   node design-gallery/gateway.ts      # PORT=8080, each design's demo on its port below
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";

const port = Number(process.env.PORT ?? 8080);
const shooter = process.env.SHOOTER ?? "/tmp/claude-1000/shot/run.sh";
const shots = process.env.SHOTS ?? "/home/user/.cache/nexus-gallery";

export const designs = [
  { key: "original", label: "Original", port: 8086, idea: "The dashboard as it is on main." },
  { key: "inbox", label: "Inbox", port: 8081, idea: "Calm triage of what needs you, Linear and Superhuman style." },
  { key: "mission-control", label: "Mission control", port: 8082, idea: "A dense, dark-first operator console." },
  { key: "conversation", label: "Conversation", port: 8083, idea: "Nexus as a chat app; everything else comes into the conversation." },
  { key: "pipeline-board", label: "Pipeline board", port: 8084, idea: "A kanban board of each piece of work's life." },
  { key: "keyboard", label: "Keyboard", port: 8085, idea: "A command palette and split panes, monospace-forward." },
] as const;
type Design = (typeof designs)[number];

/** Each page the bar offers: a path, or a thread found by its title, since every demo server mints its own IDs. */
export const pages: readonly { key: string; label: string; path?: string; thread?: string }[] = [
  { key: "home", label: "Home", path: "/" },
  { key: "long", label: "Long thread", thread: "Graph node health with 31 days of history" },
  { key: "review", label: "Held review", thread: "Retry flaky probe reconnects" },
  { key: "question", label: "Open question", thread: "Choose the metrics retention" },
  { key: "claude", label: "Claude worker", thread: "Keep nexus attach alive across a deploy" },
  { key: "planning", label: "Planning", thread: "Plan the maintenance wave" },
  { key: "failed", label: "Failed", thread: "Fix doctor's certificate check" },
  { key: "pipeline", label: "Pipeline", path: "/pipeline" },
  { key: "nodes", label: "Nodes", path: "/nodes/infra-testbench" },
  { key: "graphs", label: "Node graphs", path: "/nodes/rj-firebat" },
  { key: "health", label: "Health", path: "/health" },
  { key: "usage", label: "Usage", path: "/usage" },
  { key: "start", label: "Start form", path: "/threads/new" },
];

const designOf = (req: IncomingMessage): Design => {
  const key = /(?:^|;\s*)gallery-design=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
  return designs.find((d) => d.key === key) ?? designs[0];
};

async function threadPath(d: Design, title: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${d.port}/v1/threads`);
  const threads = await res.json() as { id: string; title: string }[];
  const t = threads.find((x) => x.title === title);
  return t === undefined ? "/" : `/threads/${t.id}`;
}

async function pathOf(d: Design, key: string): Promise<string> {
  const page = pages.find((p) => p.key === key) ?? pages[0]!;
  return page.path ?? threadPath(d, page.thread!);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function shell(d: Design, path: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design gallery · ${esc(d.label)}</title><link rel="stylesheet" href="/__gallery/style.css"></head><body class="gallery">
<header class="bar" role="toolbar" aria-label="Design gallery">
  <span class="brand">Gallery</span>
  <nav class="seg" aria-label="Design">${designs.map((x) => `<button type="button" data-design="${x.key}" title="${esc(x.idea)}"${x.key === d.key ? ' aria-pressed="true"' : ""}>${esc(x.label)}</button>`).join("")}</nav>
  <label class="pick"><span class="vh">Page</span><select id="page">${pages.map((p) => `<option value="${p.key}">${esc(p.label)}</option>`).join("")}</select></label>
  <nav class="seg" aria-label="Theme"><button type="button" data-theme="light">Light</button><button type="button" data-theme="dark">Dark</button></nav>
  <nav class="seg" aria-label="Width"><button type="button" data-width="desktop">Desktop</button><button type="button" data-width="phone">Phone</button></nav>
  <a class="compare" id="compare" href="/__gallery/compare">Compare</a>
</header>
<main class="stage"><iframe id="view" title="Dashboard" src="${esc(path)}"></iframe></main>
<script type="module" src="/__gallery/shell.js"></script></body></html>`;
}

function comparePage(page: string, width: string, theme: string): string {
  const option = (value: string, label: string, current: string) => `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compare · ${esc(page)}</title><link rel="stylesheet" href="/__gallery/style.css"></head><body class="gallery">
<form class="bar" method="get" action="/__gallery/compare">
  <a class="brand" href="/__gallery/">← Gallery</a>
  <label class="pick">Page <select name="page" onchange="this.form.submit()">${pages.map((p) => option(p.key, p.label, page)).join("")}</select></label>
  <label class="pick">Width <select name="width" onchange="this.form.submit()">${option("desktop", "Desktop 1440", width)}${option("phone", "Phone 390", width)}</select></label>
  <label class="pick">Theme <select name="theme" onchange="this.form.submit()">${option("light", "Light", theme)}${option("dark", "Dark", theme)}</select></label>
  <span class="hint">Screenshots are taken on first view and kept. <a href="?page=${page}&width=${width}&theme=${theme}&fresh=${Date.now()}">Retake</a></span>
</form>
<main class="grid ${width}">${designs.map((d) => `<figure><figcaption><button type="button" data-open="${d.key}" data-page="${page}">${esc(d.label)}</button><small>${esc(d.idea)}</small></figcaption>
<a href="/__gallery/open?design=${d.key}&page=${page}" target="_top"><img loading="lazy" alt="${esc(d.label)}: ${esc(page)}" src="/__gallery/shot/${d.key}/${page}/${width}/${theme}.png"></a></figure>`).join("")}</main>
<script type="module" src="/__gallery/compare.js"></script></body></html>`;
}

const css = `
:root { color-scheme: light dark; --bg: #0f1115; --fg: #e8e8ea; --muted: #9aa0aa; --line: #2a2e36; --chip: #1a1d23; --on: #3b82f6; font: 13px/1.3 ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
body.gallery { margin: 0; background: var(--bg); color: var(--fg); height: 100vh; display: flex; flex-direction: column; }
.bar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: #14171c; }
.brand { font-weight: 650; color: var(--fg); text-decoration: none; margin-right: 4px; }
.seg { display: flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
.seg button { font: inherit; color: var(--muted); background: var(--chip); border: 0; padding: 5px 10px; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { color: #fff; background: var(--on); }
.seg button:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
select { font: inherit; color: var(--fg); background: var(--chip); border: 1px solid var(--line); border-radius: 7px; padding: 4px 8px; }
.pick { color: var(--muted); display: flex; gap: 6px; align-items: center; }
.compare, .hint a { color: #93c5fd; }
.hint { color: var(--muted); margin-left: auto; }
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.stage { flex: 1; min-height: 0; display: flex; justify-content: center; background: #0b0d10; }
.stage iframe { border: 0; width: 100%; height: 100%; background: #fff; }
.stage.phone { padding: 16px 0; }
.stage.phone iframe { width: 390px; border-radius: 18px; box-shadow: 0 0 0 1px var(--line), 0 12px 40px #0008; }
.grid { flex: 1; overflow: auto; display: grid; gap: 16px; padding: 16px; grid-template-columns: repeat(3, minmax(0, 1fr)); align-content: start; }
.grid.phone { grid-template-columns: repeat(6, minmax(0, 1fr)); }
figure { margin: 0; display: flex; flex-direction: column; gap: 6px; }
figcaption { display: flex; flex-direction: column; gap: 2px; }
figcaption button { all: unset; font-weight: 650; cursor: pointer; }
figcaption small { color: var(--muted); }
figure img { width: 100%; border: 1px solid var(--line); border-radius: 6px; background: var(--chip); min-height: 120px; display: block; }
`;

const shellJs = `
const view = document.getElementById("view");
const stage = view.parentElement;
const state = JSON.parse(localStorage.getItem("gallery") ?? "{}");
state.theme ??= localStorage.getItem("nexus.theme") === "dark" ? "dark" : "light";
const asked = new URLSearchParams(location.search).get("page");
if (asked) state.page = asked;
const mark = (attr, value) => document.querySelectorAll("[data-" + attr + "]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === value)));
function apply() {
  stage.classList.toggle("phone", state.width === "phone");
  mark("width", state.width ?? "desktop");
  mark("theme", state.theme ?? "light");
  document.getElementById("compare").href = "/__gallery/compare?page=" + document.getElementById("page").value + "&width=" + (state.width ?? "desktop") + "&theme=" + (state.theme ?? "light");
  localStorage.setItem("gallery", JSON.stringify(state));
}
const pageOf = (path) => (${JSON.stringify(pages)}).find((p) => p.path === path)?.key;
view.addEventListener("load", () => {
  const path = view.contentWindow.location.pathname;
  const known = pageOf(path) ?? (path.startsWith("/threads/") && path !== "/threads/new" ? state.page : undefined);
  if (known) { state.page = known; document.getElementById("page").value = known; }
  apply();
  history.replaceState(null, "", "/__gallery/?path=" + encodeURIComponent(path + view.contentWindow.location.search) + (state.page ? "&page=" + state.page : ""));
});
document.querySelectorAll("[data-design]").forEach((b) => b.addEventListener("click", () => {
  location.href = "/__gallery/open?design=" + b.dataset.design + "&page=" + document.getElementById("page").value;
}));
document.getElementById("page").addEventListener("change", (e) => { state.page = e.target.value; apply(); view.src = "/__gallery/go?page=" + e.target.value; });
document.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => {
  state.theme = b.dataset.theme; localStorage.setItem("nexus.theme", state.theme); apply(); view.contentWindow.location.reload();
}));
document.querySelectorAll("[data-width]").forEach((b) => b.addEventListener("click", () => { state.width = b.dataset.width; apply(); }));
if (state.theme && localStorage.getItem("nexus.theme") !== state.theme) localStorage.setItem("nexus.theme", state.theme);
apply();
`;

const compareJs = `
document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { location.href = "/__gallery/open?design=" + b.dataset.open + "&page=" + b.dataset.page; }));
`;

/** Screenshots run one at a time through the shooter, which also serializes with the design workers' own. */
const taking = new Map<string, Promise<void>>();
function shoot(d: Design, page: string, width: string, theme: string, out: string): Promise<void> {
  const existing = taking.get(out);
  if (existing) return existing;
  const job = (async () => {
    await mkdir(join(shots, d.key), { recursive: true });
    const url = `http://127.0.0.1:${d.port}${await pathOf(d, page)}`;
    const [w, h] = width === "phone" ? ["390", "844"] : ["1440", "900"];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(shooter, [url, out, w, h, theme], { stdio: "ignore" });
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`the shooter exited ${code}`)));
      child.on("error", reject);
    });
  })().finally(() => taking.delete(out));
  taking.set(out, job);
  return job;
}

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
}

async function gallery(req: IncomingMessage, res: ServerResponse, url: URL) {
  const d = designOf(req);
  const route = url.pathname.replace(/^\/__gallery/, "") || "/";
  if (route === "/") return send(res, 200, "text/html; charset=utf-8", shell(d, /^\/(?!\/)/.test(url.searchParams.get("path") ?? "") ? url.searchParams.get("path")! : "/"));
  if (route === "/style.css") return send(res, 200, "text/css", css);
  if (route === "/shell.js") return send(res, 200, "text/javascript", shellJs);
  if (route === "/compare.js") return send(res, 200, "text/javascript", compareJs);
  if (route === "/compare") return send(res, 200, "text/html; charset=utf-8", comparePage(url.searchParams.get("page") ?? "home", url.searchParams.get("width") === "phone" ? "phone" : "desktop", url.searchParams.get("theme") === "dark" ? "dark" : "light"));
  if (route === "/go") return res.writeHead(302, { location: await pathOf(d, url.searchParams.get("page") ?? "home") }).end();
  if (route === "/open") {
    const next = designs.find((x) => x.key === url.searchParams.get("design")) ?? d;
    const path = await pathOf(next, url.searchParams.get("page") ?? "home");
    return res.writeHead(302, { "set-cookie": `gallery-design=${next.key}; Path=/; SameSite=Lax; Max-Age=31536000`, location: `/__gallery/?path=${encodeURIComponent(path)}&page=${url.searchParams.get("page") ?? "home"}` }).end();
  }
  const shot = /^\/shot\/([\w-]+)\/([\w-]+)\/(desktop|phone)\/(light|dark)\.png$/.exec(route);
  if (shot) {
    const design = designs.find((x) => x.key === shot[1]);
    if (design === undefined || !pages.some((p) => p.key === shot[2])) return send(res, 404, "text/plain", "no such design or page");
    const out = join(shots, design.key, `${shot[2]}-${shot[3]}-${shot[4]}.png`);
    const fresh = /[?&]fresh=/.test(req.headers.referer ?? "");
    if (fresh || !existsSync(out)) await shoot(design, shot[2]!, shot[3]!, shot[4]!, out).catch(() => undefined);
    if (!existsSync(out)) return send(res, 503, "text/plain", `${design.label} did not answer: is its demo running on ${design.port}?`);
    res.writeHead(200, { "content-type": "image/png", "content-length": (await stat(out)).size, "cache-control": "no-cache" });
    return createReadStream(out).pipe(res);
  }
  send(res, 404, "text/plain", "no such gallery route");
}

/** The design's response, with its frame-ancestors relaxed so the gallery's own frame may show it. */
function proxy(req: IncomingMessage, res: ServerResponse, d: Design) {
  const host = `127.0.0.1:${d.port}`;
  const headers = { ...req.headers, host, ...(req.headers.origin === undefined ? {} : { origin: `http://${host}` }) };
  const upstream = request({ host: "127.0.0.1", port: d.port, method: req.method, path: req.url, headers }, (up) => {
    const out = { ...up.headers };
    const csp = out["content-security-policy"];
    if (typeof csp === "string") out["content-security-policy"] = csp.replace(/frame-ancestors[^;]*/, "frame-ancestors 'self'");
    delete out["x-frame-options"];
    res.writeHead(up.statusCode ?? 502, out);
    up.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) send(res, 502, "text/plain", `${d.label}'s demo is not answering on port ${d.port}.`); else res.destroy(); });
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://gallery");
  if (url.pathname === "/__gallery" || url.pathname.startsWith("/__gallery/")) {
    gallery(req, res, url).catch((err: unknown) => { if (!res.headersSent) send(res, 500, "text/plain", (err as Error).message); });
    return;
  }
  // A page opened at the top level, not in the gallery's frame, opens in the gallery.
  if (req.method === "GET" && req.headers["sec-fetch-dest"] === "document") {
    res.writeHead(302, { location: `/__gallery/?path=${encodeURIComponent(req.url ?? "/")}` }).end();
    return;
  }
  proxy(req, res, designOf(req));
});

// Terminals and other upgrades pass through to the design as raw bytes, with Host and Origin rewritten as for HTTP.
server.on("upgrade", (req, socket, head) => {
  const d = designOf(req);
  const host = `127.0.0.1:${d.port}`;
  const upstream = connect(d.port, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      const value = /^host$/i.test(name) ? host : /^origin$/i.test(name) ? `http://${host}` : req.rawHeaders[i + 1]!;
      lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(port, "127.0.0.1", () => console.log(`design gallery on http://127.0.0.1:${port}/__gallery/`));
