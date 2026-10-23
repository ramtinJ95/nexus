/**
 * The dashboard: server-rendered HTML pages for the control plane, served behind the API's own checks. A page
 * reads the registry the way the JSON API does, so the list, the thread page and `GET /v1/threads/<id>` agree.
 *
 * Every action goes through the JSON API from `dashboard/client.js`, because the API refuses state changes
 * without a JSON content type and an HTML form cannot send one. The control plane has no event stream for
 * browsers yet, so the client polls each page and swaps the part marked `#live`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { desiredPhase, type ActualState, type DesiredPhase, type ThreadStatus } from "../reconcile.ts";
import type { SessionFact } from "../protocol.ts";
import type { SessionHarness } from "../project.ts";
import { herdrSession } from "../sessions.ts";
import type { ThreadDetail } from "./api.ts";
import { previewUrl } from "./live.ts";
import type { NodeRecord, Output, Registry, Thread, ThreadId } from "./registry.ts";

export interface DashboardOptions {
  registry: Registry;
  /** The API's thread detail, so the dashboard derives the actual state exactly as the API does. */
  detail(thread: Thread): ThreadDetail;
  now?: () => number;
}

export interface Page { status: number; headers: Record<string, string>; body: string }

/** How often the client refetches a page. The loop ticks every 5 s, so polling faster shows nothing new. */
export const pollMs = 5_000;

/** Returns the page for a GET of `path`, or undefined when the path is not the dashboard's. */
export function dashboard(options: DashboardOptions): (path: string, query: URLSearchParams) => Page | undefined {
  const { registry, detail } = options;
  const now = options.now ?? Date.now;

  const pages: readonly [RegExp, (m: RegExpExecArray, query: URLSearchParams) => Page][] = [
    [/^\/$/, (_, query) => ok(threadList(registry, detail, now(), query.has("all")))],
    [/^\/threads\/new$/, (_, query) => ok(newThread(registry, query.get("project")))],
    [/^\/threads\/([^/]+)$/, (m) => {
      const thread = registry.thread(m[1]! as ThreadId);
      if (thread === undefined) return { ...ok(notFound(`No thread ${m[1]!}.`)), status: 404 };
      const d = detail(thread);
      return ok(threadPage(d, registry.node(d.pylon.node)!, now()));
    }],
    [/^\/assets\/([a-z]+\.[a-z]+)$/, (m, query) => {
      const asset = assets.get(m[1]!);
      if (asset === undefined) return { ...ok(notFound(`No asset ${m[1]!}.`)), status: 404 };
      // Pages link each asset with its hash, so a versioned URL never changes and the phone keeps it.
      const cache = query.get("v") === asset.version ? "public, max-age=31536000, immutable" : "no-cache";
      return { status: 200, headers: { "content-type": asset.type, "cache-control": cache, "x-content-type-options": "nosniff" }, body: asset.body };
    }],
  ];

  return (path, query) => {
    for (const [pattern, page] of pages) {
      const m = pattern.exec(path);
      if (m !== null) return page(m, query);
    }
    return undefined;
  };
}

const assets = new Map([
  ["style.css", "text/css; charset=utf-8"],
  ["client.js", "text/javascript; charset=utf-8"],
  ["favicon.svg", "image/svg+xml"],
].map(([file, type]) => {
  const body = readFileSync(new URL(`./dashboard/${file}`, import.meta.url), "utf8");
  return [file!, { type: type!, body, version: createHash("sha256").update(body).digest("hex").slice(0, 12) }];
}));
const assetUrl = (file: string) => `/assets/${file}?v=${assets.get(file)!.version}`;

const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const ok = (html: Html): Page => ({ status: 200, headers: pageHeaders, body: html.text });

/** Markup that is safe to send. Only `html` makes one, and it escapes every string it interpolates. */
class Html {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}
type Part = Html | string | number | false | null | undefined | readonly Part[];

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const render = (part: Part): string => part instanceof Html ? part.text
  : Array.isArray(part) ? part.map(render).join("")
  : part === false || part === null || part === undefined ? ""
  : String(part).replace(/[&<>"']/g, (c) => escapes[c]!);

function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  return new Html(strings.reduce((out, s, i) => out + render(parts[i - 1]) + s));
}

type Tone = "ok" | "busy" | "idle" | "bad" | "muted";
const actualBadge: Record<ActualState, [label: string, tone: Tone]> = {
  running: ["running", "ok"], spawning: ["spawning", "busy"], pausing: ["pausing", "busy"], deleting: ["deleting", "busy"],
  paused: ["paused", "idle"], absent: ["not on its node", "muted"], failed: ["failed", "bad"], unknown: ["unknown", "muted"],
};
const desiredTone: Record<DesiredPhase, Tone> = { running: "ok", paused: "idle", deleted: "muted" };
const statusTone: Record<ThreadStatus, Tone> = { active: "ok", idle: "idle", archived: "muted", deleted: "muted" };
const sessionTone: Record<SessionFact["status"], Tone> = { working: "busy", idle: "idle", blocked: "bad", done: "ok", unknown: "muted" };
const harnessLabel: Record<SessionHarness, string> = { "claude-code": "Claude Code", pi: "pi", shell: "Shell" };
const outputLabel: Record<Output["kind"], string> = { branch: "Branch", diff: "Uncommitted diff", preview: "Preview", file: "File" };

const badge = (label: string, tone: Tone) => html`<span class="badge tone-${tone}">${label}</span>`;

function ago(at: number, now: number): Html {
  if (at === 0) return html`never`;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const label = seconds < 45 ? "just now"
    : seconds < 45 * 60 ? `${Math.round(seconds / 60)} min ago`
    : seconds < 36 * 3600 ? `${Math.round(seconds / 3600)} h ago`
    : `${Math.round(seconds / 86_400)} d ago`;
  const iso = new Date(at).toISOString();
  return html`<time datetime="${iso}" title="${iso}">${label}</time>`;
}


function layout(title: string, body: Html, attrs: { thread?: ThreadId; live: boolean }): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · Nexus</title>
<link rel="icon" href="${assetUrl("favicon.svg")}" type="image/svg+xml">
<link rel="stylesheet" href="${assetUrl("style.css")}">
<script src="${assetUrl("client.js")}" defer></script>
</head>
<body>
<header class="top"><nav aria-label="Nexus"><a href="/" class="brand">Nexus</a><a href="/threads/new" class="button">Start a thread</a></nav></header>
<main${attrs.live ? html` data-poll-ms="${pollMs}"` : ""}${attrs.thread === undefined ? "" : html` data-activity="${attrs.thread}"`}>
${body}
</main>
${attrs.live && html`<footer class="refresh"><p>Updates every ${pollMs / 1000} seconds. <span id="refresh-state" role="status"></span></p></footer>`}
<noscript><p class="note">Starting, archiving and deleting threads, and live updates, need JavaScript.</p></noscript>
</body>
</html>
`;
}

function threadList(registry: Registry, detail: DashboardOptions["detail"], now: number, all: boolean): Html {
  const projects = registry.projects();
  const nodes = new Map(registry.nodes().map((n) => [n.name, n]));
  const hidden = (t: Thread) => !all && (t.status === "archived" || t.status === "deleted");
  const sections = projects.map((project) => {
    const threads = registry.threads(project.id).toReversed();
    const shown = threads.filter((t) => !hidden(t));
    return html`<section class="project" aria-labelledby="project-${project.id}">
<div class="section-head"><h2 id="project-${project.id}">${project.id}</h2><a href="/threads/new?project=${encodeURIComponent(project.id)}">Start a thread</a></div>
<p class="meta">${project.repoUrl}</p>
${shown.length === 0 ? html`<p class="empty">No ${all ? "" : "open "}threads.</p>`
  : html`<ul class="threads">${shown.map((t) => {
    const d = detail(t);
    return threadRow(t, d, nodes.get(d.pylon.node)!, now);
  })}</ul>`}
${threads.length > shown.length && html`<p class="meta">${threads.length - shown.length} archived or deleted. <a href="/?all">Show all threads</a></p>`}
</section>`;
  });
  return layout("Threads", html`<h1>Threads</h1>
<div id="live">
${all && html`<p class="meta">Showing archived and deleted threads. <a href="/">Show open threads only</a></p>`}
${projects.length === 0 ? html`<p class="empty">No projects yet. Add one with <code>POST /v1/projects</code>.</p>` : sections}
</div>`, { live: true });
}

function threadRow(t: Thread, d: ThreadDetail, node: NodeRecord, now: number): Html {
  return html`<li class="thread">
<a href="/threads/${t.id}" class="title">${t.title}</a> ${t.status !== "active" && badge(t.status, statusTone[t.status])}
<dl class="facts">
<div><dt>Desired</dt><dd>${badge(desiredPhase(t, now), desiredTone[desiredPhase(t, now)])}</dd></div>
<div><dt>Observed</dt><dd>${badge(...actualBadge[d.pylon.actualState])}</dd></div>
<div><dt>Node</dt><dd>${d.pylon.node} ${node.state === "offline" && badge("offline", "muted")}</dd></div>
<div><dt>Human</dt><dd>${ago(t.lastHumanActivityAt, now)}</dd></div>
<div><dt>Agent</dt><dd>${t.agentTurnRunning ? "turn running" : ago(t.lastAgentActivityAt, now)}</dd></div>
</dl>
</li>`;
}

function threadPage(d: ThreadDetail, node: NodeRecord, now: number): Html {
  const { thread: t, pylon } = d;
  const desired = desiredPhase(t, now);
  const previewOf = new Map(d.previews.map((p) => [p.service, p]));
  // Outside #live, so a poll does not wipe an error before it is read.
  return layout(t.title, html`<p id="action-error" class="error" role="alert" hidden></p>
<div id="live">
<div class="section-head">
<h1>${t.title}</h1>
<div class="actions">
${t.status !== "archived" && t.status !== "deleted" && html`<button type="button" id="archive" data-action="archive" data-thread="${t.id}">Archive</button>`}
${t.status !== "deleted" && html`<button type="button" id="delete" class="danger" data-action="delete" data-thread="${t.id}" data-title="${t.title}">Delete</button>`}
</div>
</div>
<p class="meta">${badge(t.status, statusTone[t.status])} <a href="/">${t.project}</a> · <code>${t.id}</code> · started ${ago(t.createdAt, now)}</p>
<section aria-labelledby="pylon-h">
<h2 id="pylon-h">Pylon</h2>
<dl class="facts">
<div><dt>Desired</dt><dd>${badge(desired, desiredTone[desired])}</dd></div>
<div><dt>Observed</dt><dd>${badge(...actualBadge[pylon.actualState])}</dd></div>
<div><dt>Node</dt><dd>${pylon.node} ${node.state === "offline" && badge("offline", "muted")}</dd></div>
<div><dt>Last observed</dt><dd>${pylon.observedAt === null ? "never" : ago(Date.parse(pylon.observedAt), now)}${node.state === "offline" && pylon.observedAt !== null && " (stale)"}</dd></div>
<div><dt>Human</dt><dd>${ago(t.lastHumanActivityAt, now)}</dd></div>
<div><dt>Agent</dt><dd>${t.agentTurnRunning ? "turn running" : ago(t.lastAgentActivityAt, now)}</dd></div>
</dl>
<p class="meta"><code>${pylon.id}</code></p>
${pylon.failed !== null && html`<p class="error">The planner gave up: ${pylon.failed}</p>`}
</section>

<section aria-labelledby="sessions-h">
<h2 id="sessions-h">Sessions</h2>
${d.sessions.length === 0 ? html`<p class="empty">No sessions.</p>` : html`<ul class="rows">${d.sessions.map((s) => html`<li>
<span class="name">${harnessLabel[s.harness]}</span> ${badge(s.status, sessionTone[s.status])}
<span class="meta">pane <code>${s.herdrPane}</code>${s.harnessSessionId !== null && html` · session <code>${s.harnessSessionId}</code>`}</span>
</li>`)}</ul>`}
<p class="meta">Attach from a shell in the pylon with <code class="command">herdr --session ${herdrSession}</code>.</p>
</section>

<section aria-labelledby="previews-h">
<h2 id="previews-h">Previews</h2>
${d.previews.length === 0 ? html`<p class="empty">No previews.</p>` : html`<ul class="rows">${d.previews.map((p) => html`<li>
<span class="name">${p.service}</span>
${p.ready ? html`<a href="${previewUrl(node, p.httpsPort)}" target="_blank" rel="noopener">${previewUrl(node, p.httpsPort)}</a>` : badge("starting", "busy")}
</li>`)}</ul>`}
</section>

<section aria-labelledby="outputs-h">
<h2 id="outputs-h">Outputs</h2>
${d.outputs.length === 0 ? html`<p class="empty">No outputs yet.</p>` : html`<ul class="rows">${d.outputs.map((o) => {
  const preview = o.kind === "preview" ? previewOf.get(o.ref) : undefined;
  return html`<li><span class="name">${outputLabel[o.kind]}</span> ${preview?.ready ? html`<a href="${previewUrl(node, preview.httpsPort)}" target="_blank" rel="noopener">${o.ref}</a>` : html`<code>${o.ref}</code>`}</li>`;
})}</ul>`}
</section>

${conversation(t)}
</div>`, { live: true, ...(t.status === "active" || t.status === "idle" ? { thread: t.id } : {}) });
}

/** The hook for the conversation view and the prompt box, once the API serves a thread's conversation and takes prompts. */
function conversation(t: Thread): Html {
  return html`<section aria-labelledby="conversation-h">
<h2 id="conversation-h">Conversation</h2>
${t.conversationId === null ? html`<p class="empty">No agent conversation yet.</p>` : html`<p class="meta">Conversation <code>${t.conversationId}</code></p>`}
</section>`;
}

function newThread(registry: Registry, project: string | null): Html {
  const projects = registry.projects();
  const nodes = registry.nodes();
  if (projects.length === 0) {
    return layout("Start a thread", html`<h1>Start a thread</h1><p class="empty">No projects yet. Add one with <code>POST /v1/projects</code>.</p>`, { live: false });
  }
  return layout("Start a thread", html`<h1>Start a thread</h1>
${registry.currentImage() === null && html`<p class="error">No image is current yet, so a new pylon has nothing to boot.</p>`}
<form id="start" class="form">
<label for="start-project">Project</label>
<select id="start-project" name="project" required>
${projects.map((p) => html`<option value="${p.id}"${p.id === project && " selected"}>${p.id} (node ${p.defaultNode}, branch ${p.defaultBranch})</option>`)}
</select>
<label for="start-title">Title</label>
<input id="start-title" name="title" required autocomplete="off" placeholder="What should this thread do?">
<label for="start-node">Node</label>
<select id="start-node" name="node">
<option value="">The project's default node</option>
${nodes.map((n) => html`<option value="${n.name}">${n.name}${n.state === "offline" && " (offline)"}</option>`)}
</select>
<label for="start-branch">Branch</label>
<input id="start-branch" name="branch" autocomplete="off" placeholder="The project's default branch">
<p id="start-error" class="error" role="alert" hidden></p>
<button type="submit">Start thread</button>
</form>`, { live: false });
}

function notFound(message: string): Html {
  return layout("Not found", html`<h1>Not found</h1><p>${message}</p><p><a href="/">All threads</a></p>`, { live: false });
}

