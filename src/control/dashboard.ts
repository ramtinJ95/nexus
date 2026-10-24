/**
 * The dashboard: server-rendered HTML pages for the control plane, served behind the API's own checks. A page
 * reads the registry the way the JSON API does, so the sidebar, the thread page and `GET /v1/threads/<id>` agree.
 *
 * Every page is the same console: threads by project on the left, the page in the middle, and on a thread page
 * its pylon, previews, outputs and sessions on the right. Starting a thread and adding a project are dialogs every
 * page carries.
 *
 * Every action goes through the JSON API from `dashboard/client.js`, because the API refuses state changes
 * without a JSON content type and an HTML form cannot send one. The client polls each page and swaps the regions
 * marked `data-live` that changed. A thread page also opens its stream, which sends the conversation region as the
 * run streams: whole when its shape changed, or else only the parts that grow in place, the partial answer and
 * each running tool.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AssistantMessage, ImageContent, TextContent, ToolCall, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, InboxState, LiveState } from "@earendil-works/pi-durable";
import { desiredPhase, type ActualState, type DesiredPhase } from "../reconcile.ts";
import type { HerdrStatus } from "../protocol.ts";
import { githubTokenGrant, linkedPort, type SessionHarness } from "../project.ts";
import type { ThreadDetail } from "./api.ts";
import type { NodeRecord, Output, Preview, Registry, Thread, ThreadId } from "./registry.ts";

export interface DashboardOptions {
  registry: Registry;
  /** The API's thread detail, so the dashboard derives the actual state exactly as the API does. */
  detail(thread: Thread): ThreadDetail;
  /** The API's conversation view, for a thread that has a conversation and is not deleted. */
  conversation(thread: Thread): Promise<ConversationView>;
  now?: () => number;
}

export interface Page { status: number; headers: Record<string, string>; body: string }

/** How often the client refetches a page. The loop ticks every 5 s, so polling faster shows nothing new. */
export const pollMs = 5_000;

/** What every part of a page reads. */
interface Context { registry: Registry; detail: DashboardOptions["detail"]; now: number }

/** Returns the page for a GET of `path`, or undefined when the path is not the dashboard's. */
export function dashboard(options: DashboardOptions): (path: string, query: URLSearchParams) => Promise<Page | undefined> {
  const { registry, detail } = options;
  const context = (): Context => ({ registry, detail, now: (options.now ?? Date.now)() });

  /** A failed read shows in the conversation, so the rest of the page still says what the pylon is doing. */
  async function transcript(t: Thread): Promise<ConversationView | Error | null> {
    if (t.conversationId === null || t.status === "deleted") return null;
    return options.conversation(t).catch((err: unknown) => err as Error);
  }

  const pages: readonly [RegExp, (m: RegExpExecArray, query: URLSearchParams) => Page | Promise<Page>][] = [
    [/^\/$/, () => ok(home(context(), {}))],
    [/^\/threads\/new$/, (_, query) => ok(home(context(), { start: { project: query.get("project") } }))],
    [/^\/projects\/new$/, () => ok(home(context(), { addProject: true }))],
    [/^\/threads\/([^/]+)$/, async (m) => {
      const thread = registry.thread(m[1]! as ThreadId);
      if (thread === undefined) return { ...ok(notFound(context(), `No thread ${m[1]!}.`)), status: 404 };
      const view = await transcript(thread);
      // After the read, so the facts are no older than the conversation, and a thread deleted meanwhile shows none.
      const d = detail(registry.thread(thread.id)!);
      return ok(threadPage(context(), d, registry.node(d.pylon.node)!, d.thread.status === "deleted" ? null : view));
    }],
    [/^\/assets\/([a-z]+\.[a-z]+)$/, (m, query) => {
      const asset = assets.get(m[1]!);
      if (asset === undefined) return { ...ok(notFound(context(), `No asset ${m[1]!}.`)), status: 404 };
      // Pages link each asset with its hash, so a versioned URL never changes and the phone keeps it.
      const cache = query.get("v") === asset.version ? "public, max-age=31536000, immutable" : "no-cache";
      return { status: 200, headers: { "content-type": asset.type, "cache-control": cache, "x-content-type-options": "nosniff" }, body: asset.body };
    }],
  ];

  return async (path, query) => {
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

/** The colour of a status dot. `work` is an agent mid-turn, `busy` a pylon changing phase. */
type Tone = "ok" | "work" | "busy" | "idle" | "bad" | "muted";
const actualBadge: Record<ActualState, [label: string, tone: Tone]> = {
  running: ["running", "ok"], spawning: ["spawning", "busy"], pausing: ["pausing", "busy"], deleting: ["deleting", "busy"],
  paused: ["paused", "idle"], absent: ["not on its node", "muted"], failed: ["failed", "bad"], unknown: ["unknown", "muted"],
};
const desiredTone: Record<DesiredPhase, Tone> = { running: "ok", paused: "idle", deleted: "muted" };
const sessionTone: Record<HerdrStatus, Tone> = { working: "work", idle: "idle", blocked: "bad", done: "ok", unknown: "muted" };
const harnessLabel: Record<SessionHarness, string> = { "claude-code": "Claude Code", pi: "pi", shell: "Shell" };
const outputLabel: Record<Output["kind"], string> = { branch: "branch", diff: "diff", preview: "preview", file: "file" };

/** A dot alone carries its meaning in its accessible name. One beside its label is decoration. */
const dot = (tone: Tone, label?: string) => label === undefined
  ? html`<span class="dot dot-${tone}" aria-hidden="true"></span>`
  : html`<span class="dot dot-${tone}" role="img" aria-label="${label}" title="${label}"></span>`;
const state = (label: string, tone: Tone) => html`<span class="state">${dot(tone)}${label}</span>`;

/** What a thread is doing, most urgent first: the agent mid-turn hides a running pylon, never a failed one. */
function threadState({ thread: t, pylon }: ThreadDetail): [label: string, tone: Tone] {
  if (t.status === "archived" || t.status === "deleted") return [t.status, "muted"];
  if (t.agentTurnRunning && pylon.actualState !== "failed") return ["agent working", "work"];
  return actualBadge[pylon.actualState];
}

/** "5 min", or null under 45 seconds. */
function span(at: number, now: number): string | null {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 45 ? null
    : seconds < 45 * 60 ? `${Math.round(seconds / 60)} min`
    : seconds < 36 * 3600 ? `${Math.round(seconds / 3600)} h`
    : `${Math.round(seconds / 86_400)} d`;
}

function ago(at: number, now: number): Html {
  if (at === 0) return html`never`;
  const iso = new Date(at).toISOString();
  const label = span(at, now);
  return html`<time datetime="${iso}" title="${iso}">${label === null ? "just now" : `${label} ago`}</time>`;
}

/** A run's length as a clock reads it, such as 1m 12s. client.js ticks it with the same format. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

interface Shell {
  title: string;
  /** The thread the sidebar marks as open. */
  active?: ThreadId;
  main: Html;
  inspector?: Html;
  /** The thread whose visits count as human activity: an open thread's page. */
  activity?: ThreadId;
  /** Opens the start dialog on load, for /threads/new. */
  start?: { project: string | null } | undefined;
  /** Opens the new-project dialog on load, for /projects/new. */
  addProject?: boolean | undefined;
}

function layout(c: Context, page: Shell): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${page.title} · Nexus</title>
<link rel="icon" href="${assetUrl("favicon.svg")}" type="image/svg+xml">
<link rel="stylesheet" href="${assetUrl("style.css")}">
<script src="${assetUrl("client.js")}" defer></script>
</head>
<body>
<div class="app${page.inspector !== undefined && " has-inspect"}">
${sidebar(c, page.active)}
<main class="main" data-poll-ms="${pollMs}"${page.activity !== undefined && html` data-activity="${page.activity}"`}>
${page.main}
</main>
${page.inspector}
</div>
<p id="refresh-state" class="refresh-state" role="status"></p>
<div class="scrim" data-close aria-hidden="true"></div>
${startDialog(c, page.start)}
${projectDialog(c, page.addProject === true)}
<noscript><p class="noscript">Adding projects, starting, archiving and deleting threads, sending messages and live updates need JavaScript.</p></noscript>
</body>
</html>
`;
}

/** A project's threads, newest first: the open ones, and the archived or deleted ones folded below them. */
function threadsOf(c: Context, project: string) {
  const threads = c.registry.threads(project as Thread["project"]).toReversed();
  const closed = (t: Thread) => t.status === "archived" || t.status === "deleted";
  return { open: threads.filter((t) => !closed(t)), closed: threads.filter(closed) };
}
const lastActive = (t: Thread) => Math.max(t.createdAt, t.lastHumanActivityAt, t.lastAgentActivityAt);
function closedLabel(threads: readonly Thread[]): string {
  const deleted = threads.filter((t) => t.status === "deleted").length;
  const archived = threads.length - deleted;
  return [archived > 0 && `${archived} archived`, deleted > 0 && `${deleted} deleted`].filter(Boolean).join(", ");
}

function sidebar(c: Context, active: ThreadId | undefined): Html {
  const projects = c.registry.projects();
  const row = (t: Thread) => {
    const [label, tone] = threadState(c.detail(t));
    return html`<li><a class="row${t.id === active && " active"}" href="/threads/${t.id}"${t.id === active && html` aria-current="page"`}>${dot(tone, label)}<span class="row-title">${t.title}</span><span class="row-at">${span(lastActive(t), c.now) ?? "now"}</span></a></li>`;
  };
  return html`<aside class="side" aria-label="Threads">
<div class="side-head"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">◆</span>nexus</a><a class="btn btn-new" href="/threads/new" data-start>New thread<kbd>N</kbd></a></div>
<label class="filter"><span aria-hidden="true">⌕</span><input id="filter" type="search" placeholder="Filter threads" aria-label="Filter threads" autocomplete="off"></label>
<nav class="groups" id="side-threads" data-live aria-label="Threads by project">
${projects.length === 0 ? html`<p class="empty side-empty">No projects yet.</p>` : projects.map((p) => {
  const { open, closed } = threadsOf(c, p.id);
  return html`<section class="group" aria-labelledby="group-${p.id}">
<h2 class="group-h" id="group-${p.id}"><span>${p.id}</span><span class="count">${open.length}</span></h2>
${open.length > 0 && html`<ul>${open.map(row)}</ul>`}
${closed.length > 0 && html`<details class="archived" id="archived-${p.id}"${closed.some((t) => t.id === active) && " open"}><summary>${closedLabel(closed)}</summary><ul>${closed.map(row)}</ul></details>`}
</section>`;
})}
</nav>
<a class="btn btn-ghost side-add" href="/projects/new" data-new-project>New project</a>
<div class="nodes" id="side-nodes" data-live aria-label="Nodes">${c.registry.nodes().map((n) => html`<span>${dot(n.state === "online" ? "ok" : "muted")}${n.name}${n.state === "offline" && html`<em>offline</em>`}</span>`)}</div>
</aside>`;
}

function startDialog(c: Context, start: Shell["start"]): Html {
  const projects = c.registry.projects();
  const nodes = c.registry.nodes();
  const image = c.registry.currentImage();
  const chosen = projects.find((p) => p.id === start?.project) ?? projects[0];
  return html`<dialog id="start-dialog" class="modal" aria-labelledby="start-h"${start !== undefined && " data-autoopen"}>
<header><h2 id="start-h">Start a thread</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
<div id="start-body" data-live>
${chosen === undefined ? html`<div class="modal-empty"><p class="empty">No projects yet, so there is no repository to start a thread on.</p>${newProjectButton}</div>` : html`<form id="start" class="form">
${image === null && html`<p class="error">No image is current yet, so a new pylon has nothing to boot.</p>`}
<label for="start-title">Title</label>
<input id="start-title" name="title" required autocomplete="off" placeholder="What should this thread do?" autofocus>
<fieldset class="seg"><legend>Project</legend>
${projects.map((p) => html`<label class="seg-opt"><input type="radio" name="project" required value="${p.id}" data-node="${p.defaultNode}" data-branch="${p.defaultBranch}"${p.repoUrl === null && " data-scratch"}${p === chosen && " checked"}><span class="seg-name">${p.id}</span><span class="seg-repo">${p.repoUrl ?? "scratch"}</span></label>`)}
</fieldset>
<div class="two">
<div><label for="start-node">Node</label><select id="start-node" name="node">
<option value="">${chosen.defaultNode} (project default)</option>
${nodes.map((n) => html`<option value="${n.name}">${n.name}${n.state === "offline" && ", offline"}</option>`)}
</select></div>
<div><label for="start-branch">Branch</label><input id="start-branch" name="branch" autocomplete="off" placeholder="${chosen.defaultBranch}"></div>
</div>
<p class="hint" id="start-hint" data-image="${image ?? ""}">Boots a pylon on <b>${chosen.defaultNode}</b>${image !== null && html` from image <code>${image}</code>`} and ${chosen.repoUrl === null ? "starts an empty repository on" : "checks out"} <code>${chosen.defaultBranch}</code>.</p>
<p id="start-error" class="error" role="alert" hidden></p>
<footer><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Start thread<kbd>⌘↵</kbd></button></footer>
</form>`}
</div>
</dialog>`;
}

const newProjectButton = html`<a class="btn btn-primary" href="/projects/new" data-new-project>New project</a>`;

/** What a new project gets beyond the dialog's fields, the same as `nexus project add` without its flags. */
const newProjectResources = { cpus: 2, memoryGiB: 4, diskGiB: 10 };

/**
 * The fields `nexus project add` asks for. The node is one of the known nodes, the first online one unless changed,
 * and the API's own checks, such as for an ID that exists, answer in the dialog. GitHub access is the one secret
 * grant the dialog offers, githubTokenGrant, which the form carries for client.js to send. Nodes come from the control plane's
 * config and change only with a restart, so the dialog is not refreshed with the page, and its default is the node
 * that was online when the page loaded.
 */
function projectDialog(c: Context, open: boolean): Html {
  const nodes = c.registry.nodes();
  const chosen = nodes.find((n) => n.state === "online") ?? nodes[0];
  const { cpus, memoryGiB, diskGiB } = newProjectResources;
  return html`<dialog id="project-dialog" class="modal" aria-labelledby="project-h"${open && " data-autoopen"}>
<header><h2 id="project-h">New project</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
${chosen === undefined ? html`<p class="empty modal-empty">No nodes yet, so a project has nowhere to run.</p>` : html`<form id="project" class="form" data-resources="${JSON.stringify(newProjectResources)}" data-github-grant="${JSON.stringify(githubTokenGrant)}">
<label for="project-id">ID</label>
<input id="project-id" name="id" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="my-app" autofocus>
<fieldset class="seg"><legend>Repository</legend>
<label class="seg-opt"><input type="radio" name="repoKind" value="clone" checked><span class="seg-name">Clone a URL</span><span class="seg-repo">threads check out a branch</span></label>
<label class="seg-opt"><input type="radio" name="repoKind" value="scratch"><span class="seg-name">Empty (scratch)</span><span class="seg-repo">git init, nothing kept</span></label>
</fieldset>
<label for="project-repo">Repository URL</label>
<input id="project-repo" name="repoUrl" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="git@github.com:you/my-app.git">
<div class="two">
<div><label for="project-node">Node</label><select id="project-node" name="defaultNode">
${nodes.map((n) => html`<option value="${n.name}"${n === chosen && " selected"}>${n.name}${n.state === "offline" && ", offline"}</option>`)}
</select></div>
<div><label for="project-branch">Branch</label><input id="project-branch" name="defaultBranch" required autocomplete="off" autocapitalize="off" spellcheck="false" value="main"></div>
</div>
<label class="check"><input type="checkbox" name="github"> GitHub access</label>
<p class="hint">Threads clone the repository at this branch, or in a scratch project start an empty repository on it, and boot on this node unless they pick another. A scratch pylon keeps nothing once its thread is deleted, so its agent publishes what is worth keeping. GitHub access sends the node's <code>${githubTokenGrant.name}</code> to ${githubTokenGrant.hosts.join(" and ")}, so agents can create repositories and push. Each pylon gets ${cpus} CPUs, ${memoryGiB} GiB of memory and ${diskGiB} GiB of disk. <code>nexus project add</code> can set those, allowed hosts, logins and other secrets.</p>
<p id="project-error" class="error" role="alert" hidden></p>
<footer><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Add project<kbd>⌘↵</kbd></button></footer>
</form>`}
</dialog>`;
}

/** Every open thread with what its pylon is asked to be and is, for the desk and for the phone's thread list. */
function home(c: Context, dialogs: Pick<Shell, "start" | "addProject">): Html {
  const projects = c.registry.projects();
  const nodes = new Map(c.registry.nodes().map((n) => [n.name, n]));
  const table = (threads: readonly Thread[]) => html`<table class="ov">
<thead><tr><th>Thread</th><th class="wide">Desired</th><th>Observed</th><th class="wide">Node</th><th class="wide">Human</th><th class="wide">Agent</th></tr></thead>
<tbody>${threads.map((t) => {
  const d = c.detail(t);
  const desired = desiredPhase(t, c.now);
  const [label, tone] = threadState(d);
  return html`<tr>
<td><span class="ov-title">${dot(tone, label)}<a href="/threads/${t.id}">${t.title}</a>${t.status !== "active" && html`<span class="tag">${t.status}</span>`}</span></td>
<td class="wide">${state(desired, desiredTone[desired])}</td>
<td>${state(...actualBadge[d.pylon.actualState])}</td>
<td class="wide">${d.pylon.node}${nodes.get(d.pylon.node)!.state === "offline" && html` <span class="tag">offline</span>`}</td>
<td class="wide">${ago(t.lastHumanActivityAt, c.now)}</td>
<td class="wide">${t.agentTurnRunning ? "turn running" : ago(t.lastAgentActivityAt, c.now)}</td>
</tr>`;
})}</tbody>
</table>`;
  return layout(c, {
    title: dialogs.start !== undefined ? "Start a thread" : dialogs.addProject === true ? "New project" : "Threads",
    ...dialogs,
    main: html`<header class="bar"><button type="button" class="icon-btn menu" data-open="side" aria-label="Threads">☰</button><div class="crumb"><h1>Threads</h1></div><div class="bar-end"><a class="btn btn-ghost" href="/projects/new" data-new-project>New project</a><a class="btn btn-new phone-only" href="/threads/new" data-start>New thread</a></div></header>
<div class="scroll"><div class="page" id="overview" data-live>
${projects.length === 0 ? html`<div class="first-project"><p class="empty">No projects yet. A project names the repository its threads clone and the node they run on.</p>${newProjectButton}</div>` : projects.map((p) => {
  const { open, closed } = threadsOf(c, p.id);
  return html`<section aria-labelledby="project-${p.id}">
<div class="ov-head"><h2 id="project-${p.id}">${p.id}</h2><code class="dim">${p.repoUrl ?? "scratch, no remote"}</code><a class="btn btn-xs" href="/threads/new?project=${encodeURIComponent(p.id)}" data-start="${p.id}">New thread</a></div>
${open.length === 0 ? html`<p class="empty">No open threads.</p>` : table(open)}
${closed.length > 0 && html`<details class="ov-closed" id="closed-${p.id}"><summary>${closedLabel(closed)}</summary>${table(closed)}</details>`}
</section>`;
})}
</div></div>`,
  });
}

/**
 * A paused pylon's preview keeps its link, because a visit wakes the pylon. An archived thread's pylon is
 * paused or about to be, and stays so whatever the visit, so its preview would only show the waking page. A
 * failed service's preview has no link, because the gateway can only answer 502 for it.
 */
type PreviewState = "ready" | "starting" | "failed" | "paused" | "archived";
function previewState(d: ThreadDetail, p: Preview): PreviewState {
  if (d.thread.status === "archived") return "archived";
  if (d.pylon.actualState === "paused") return "paused";
  if (p.failed !== null) return "failed";
  return p.ready ? "ready" : "starting";
}
const previewLook: Record<PreviewState, { linked: boolean; label: string | null; tone: Tone; hint: string | null }> = {
  ready: { linked: true, label: null, tone: "ok", hint: null },
  starting: { linked: false, label: "starting", tone: "busy", hint: null },
  failed: { linked: false, label: "failed", tone: "bad", hint: null }, // lookOf gives it the preview's own reason
  paused: { linked: true, label: "paused", tone: "idle", hint: "Opening it wakes the pylon." },
  archived: { linked: false, label: "paused", tone: "idle", hint: "Unarchive the thread to open it." },
};
/** The preview's look, with its service's failure as a failed preview's hint. */
function lookOf(d: ThreadDetail, p: Preview) {
  const state = previewState(d, p);
  return state === "failed" ? { ...previewLook.failed, hint: p.failed } : previewLook[state];
}

function threadPage(c: Context, d: ThreadDetail, node: NodeRecord, view: ConversationView | Error | null): Html {
  const { thread: t } = d;
  const read = view === null || view instanceof Error ? null : view;
  const items = read === null ? [] : conversationItems(read);
  const run = runOf(d, read, items);
  const [label, tone] = threadState(d);
  const open = t.status === "active" || t.status === "idle";
  const actions = [
    open && html`<button type="button" class="btn btn-ghost" id="archive" data-action="archive" data-thread="${t.id}">Archive</button>`,
    t.status === "archived" && html`<button type="button" class="btn btn-ghost" id="unarchive" data-action="unarchive" data-thread="${t.id}">Unarchive</button>`,
    t.status !== "deleted" && html`<button type="button" class="btn btn-ghost danger" id="delete" data-action="delete" data-thread="${t.id}" data-title="${t.title}">Delete</button>`,
  ].filter((a) => a !== false);
  return layout(c, {
    title: t.title,
    active: t.id,
    ...(open ? { activity: t.id } : {}),
    main: html`<header class="bar" id="bar" data-live>
<button type="button" class="icon-btn menu" data-open="side" aria-label="Threads">☰</button>
<div class="crumb"><a class="crumb-p" href="/">${t.project}</a><span class="sep" aria-hidden="true">/</span><h1>${t.title}</h1></div>
<span class="chip chip-${tone}">${dot(tone)}<span class="chip-label">${label}</span></span>
${actions.length > 0 && html`<div class="bar-actions" id="thread-actions">${actions}</div><button type="button" class="icon-btn more" data-open="actions" aria-label="Thread actions" aria-controls="thread-actions">⋯</button>`}
</header>
<div class="strip" id="strip" data-live>${strip(d)}</div>
<div class="scroll" id="scroll"><div class="convo" id="convo" data-live${t.conversationId !== null && t.status !== "deleted" && html` data-stream="/threads/${t.id}/stream"`}>${convo(t, view, items, c.now)}</div></div>
<div class="dock">
<p id="action-error" class="error" role="alert" hidden></p>
<div id="run" data-live>${runBar(t, run, c.now)}</div>
<div id="composer" data-live>${composer(d, run, read === null ? null : modelOf(read))}</div>
</div>`,
    inspector: inspector(d, node, c.now),
  });
}

/** Gondolin's ingress connects only to the pylon's 127.0.0.1, so a server bound only to ::1 is neither listed nor reachable. */
const unreachableHint = "A server bound only to ::1 can't be previewed, so bind it to 0.0.0.0 or 127.0.0.1.";

/**
 * Each preview is listed once, under Previews, so the outputs leave out those it lists. A preview output stays for
 * one the control plane no longer has.
 */
const outputsOf = (d: ThreadDetail) => d.outputs.filter((o) => o.kind !== "preview" || !d.previews.some((p) => p.service === o.ref));

/** The inside of the conversation region, which the page's stream sends again whenever it changed. */
function convo(t: Thread, view: ConversationView | Error | null, items: readonly Item[], now: number): Html {
  const read = view === null || view instanceof Error ? null : view;
  return html`
<p class="convo-meta"><code>${t.id}</code> · started ${ago(t.createdAt, now)}${read !== null && modelOf(read) !== null && html` · ${modelOf(read)}`}</p>
${view === null ? html`<p class="empty">${t.status === "deleted" ? "The thread is deleted, so its conversation is gone." : "This thread has no agent conversation."}</p>`
  : view instanceof Error ? html`<p class="error">The conversation could not be read: ${view.message}</p>`
  : items.length === 0 ? html`<p class="empty">No messages yet.</p>`
  : blocks(items).map(blockView)}
`;
}

/**
 * One event of a thread page's stream: the conversation region's inside, or the new inside of each part that grew,
 * by its place among the region's `data-grow` elements.
 */
export type LiveFrame = { convo: string } | { grow: [index: number, inside: string][] };

/**
 * The inside of a `data-grow` element, which grows in place while the run streams. Every string in a page is
 * escaped, so no text can forge the comments that bound it.
 */
const grows = (inside: Part) => html`<!--grow-->${inside}<!--/grow-->`;
const grown = /<!--grow-->([\s\S]*?)<!--\/grow-->/g;

/**
 * The frames of one reader of a thread page's stream. The conversation region goes whole whenever anything but
 * its growing parts changed, such as a new entry or a tool call that finished, and otherwise only the parts that
 * grew. Each frame is the change since the one this reader got last, so a reader that fell behind skips ahead.
 */
export function liveFrames(t: Thread, now: () => number = Date.now): (view: ConversationView) => LiveFrame | null {
  let shape: string | null = null;
  let parts: string[] = [];
  return (view) => {
    const region = convo(t, view, conversationItems(view), now()).text;
    const next = [...region.matchAll(grown)].map((m) => m[1]!);
    const nextShape = region.replace(grown, "<!--grow-->");
    const grew = next.flatMap((inside, i): [number, string][] => inside === parts[i] ? [] : [[i, inside]]);
    const changed = nextShape !== shape;
    shape = nextShape;
    parts = next;
    if (changed) return { convo: region };
    return grew.length === 0 ? null : { grow: grew };
  };
}

/** The phone's stand-in for the inspector: the pylon, each preview as a link where it has one, and the outputs. */
function strip(d: ThreadDetail): Html {
  const outputs = outputsOf(d).length;
  const [label, tone] = actualBadge[d.pylon.actualState];
  return html`<button type="button" class="mini" data-open="inspect">${dot(tone)}${label} · ${d.pylon.node}</button>
${d.previews.map((p) => {
  const look = lookOf(d, p);
  return look.linked
    ? html`<a class="mini mini-${look.tone}" href="${p.url}" target="_blank" rel="noopener">${p.service}${look.label !== null && `, ${look.label}`} ↗</a>`
    : html`<span class="mini mini-${look.tone}">${p.service}, ${look.label}</span>`;
})}
<button type="button" class="mini" data-open="inspect">${outputs} ${outputs === 1 ? "output" : "outputs"}</button>`;
}

function inspector(d: ThreadDetail, node: NodeRecord, now: number): Html {
  const { thread: t, pylon } = d;
  const desired = desiredPhase(t, now);
  const outputs = outputsOf(d);
  // A port with a preview is listed under Previews. Ports lists the rest, which are published only when someone opens one.
  const unpublished = d.ports?.filter((l) => l.preview === null) ?? null;
  const host = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");
  // Only a linked port's preview can be unpublished. A service's preview is part of its declaration.
  const open = t.status === "active" || t.status === "idle";
  const count = (n: number) => html`<span class="count">${n}</span>`;
  return html`<aside class="inspect" id="inspect" data-live aria-label="Pylon details">
<button type="button" class="icon-btn inspect-close" data-close aria-label="Close details">✕</button>
<section aria-labelledby="pylon-h"><h2 id="pylon-h">Pylon</h2>
<dl class="kv">
<dt>Desired</dt><dd>${state(desired, desiredTone[desired])}</dd>
<dt>Observed</dt><dd>${state(...actualBadge[pylon.actualState])}</dd>
<dt>Node</dt><dd>${pylon.node}${node.state === "offline" && html` <span class="tag">offline</span>`}</dd>
<dt>Last seen</dt><dd>${pylon.observedAt === null ? "never" : ago(Date.parse(pylon.observedAt), now)}${node.state === "offline" && pylon.observedAt !== null && " (stale)"}</dd>
<dt>Human</dt><dd>${ago(t.lastHumanActivityAt, now)}</dd>
<dt>Agent</dt><dd>${t.agentTurnRunning ? "turn running" : ago(t.lastAgentActivityAt, now)}</dd>
</dl>
<code class="id">${pylon.id}</code>
${pylon.failed !== null && html`<p class="error">The planner gave up: ${pylon.failed}</p>`}
</section>
<section aria-labelledby="previews-h"><h2 id="previews-h">Previews ${count(d.previews.length)}</h2>
${d.previews.length === 0 ? html`<p class="empty">No previews.</p>` : html`<ul class="list">${d.previews.map((p) => {
  const look = lookOf(d, p);
  return html`<li class="pv pv-${look.tone}">
<div class="pv-top">${dot(look.tone)}<span class="pv-name">${p.service}</span>${look.label !== null && html`<span class="pv-note">${look.label}</span>`}${look.linked && html`<a class="btn btn-xs" href="${p.url}" target="_blank" rel="noopener" aria-label="Open ${p.service}">Open ↗</a>`}${open && linkedPort(p.service) !== null && html`<button type="button" class="btn btn-xs btn-ghost" data-action="unpublish" data-thread="${t.id}" data-port="${linkedPort(p.service)}" aria-label="Unpublish ${p.service}">Unpublish</button>`}</div>
<div class="pv-url">${host(p.url)}</div>
${look.hint !== null && html`<div class="pv-hint">${look.hint}</div>`}
</li>`;
})}</ul>`}
</section>
<section aria-labelledby="ports-h"><h2 id="ports-h">Ports ${count(unpublished?.length ?? 0)}</h2>
${unpublished === null ? html`<p class="empty">The pylon's ports could not be read.</p>`
  : unpublished.length > 0 ? html`<ul class="list">${unpublished.map((l) => html`<li class="pv pv-muted">
<div class="pv-top">${dot("muted")}<span class="pv-name">${l.port}</span>${l.service === null
  ? html`<button type="button" class="btn btn-xs" data-action="link-port" data-thread="${t.id}" data-port="${l.port}" aria-label="Open port ${l.port}">Open</button>`
  : html`<span class="pv-note">${l.service}</span>`}</div>
</li>`)}</ul>`
  : pylon.actualState !== "running" ? html`<p class="empty">Ports show while the pylon runs.</p>`
  : html`<p class="empty">${d.ports?.length === 0 ? "Nothing listens yet." : "Every port that listens is under Previews."} ${unreachableHint}</p>`}
</section>
<section aria-labelledby="outputs-h"><h2 id="outputs-h">Outputs ${count(outputs.length)}</h2>
${outputs.length === 0 ? html`<p class="empty">No outputs yet.</p>` : html`<ul class="list outs">${outputs.map((o) => html`<li><span class="o-kind">${outputLabel[o.kind]}</span><code>${o.ref}</code></li>`)}</ul>`}
</section>
<section aria-labelledby="sessions-h"><h2 id="sessions-h">Sessions ${count(d.sessions.length)}</h2>
${d.sessions.length === 0 ? html`<p class="empty">No sessions.</p>` : html`<ul class="list outs">${d.sessions.map((s) => html`<li>
<span class="o-kind">${harnessLabel[s.harness]}</span>${s.title !== null && html`<span class="s-title">${s.title}</span>`}${s.state === "running" ? state(s.status, sessionTone[s.status])
  : s.state === "paused" ? state(t.status === "archived" ? "paused, resumes on unarchive" : "paused, resumes on wake", "idle")
  : state("failed", "bad")}${s.herdrPane !== null && html`<code class="dim pane">${s.herdrPane}</code>`}
${s.harnessSessionId !== null && html`<code class="dim sid" title="${s.harnessSessionId}">session ${s.harnessSessionId}</code>`}
${s.state === "failed" && html`<p class="error s-why">It did not come back from the last wake, which the next tries again: ${s.message}</p>`}
</li>`)}</ul>`}
<p class="attach-h">Attach from a shell in the pylon</p>
<div class="attach"><code id="attach-command">${d.attach}</code><button type="button" class="btn btn-xs" data-copy="attach-command">Copy</button></div>
</section>
</aside>`;
}

/** One row of the conversation. A tool call carries its result, which the transcript holds in a later entry. */
type Item =
  | { kind: "user"; text: string; queued: boolean; at: number }
  | { kind: "agent"; text: string; streaming: boolean }
  | { kind: "tool"; call: Pick<ToolCall, "id" | "name" | "arguments">; result: ToolResult }
  | { kind: "notice"; text: string; tone: Tone };
type ToolResult = { state: "done"; output: string; isError: boolean } | { state: "running"; output: string } | { state: "none" };
type ToolItem = Extract<Item, { kind: "tool" }>;

const contentText = (content: UserMessage["content"]) => typeof content === "string" ? content
  : content.map((part: TextContent | ImageContent) => part.type === "text" ? part.text : `[${part.mimeType} image]`).join("");

/**
 * The transcript's messages, then what pi-durable shows of the current run: tool output as it streams, the
 * partial answer and a model request waiting to be retried, then the messages queued behind the run.
 */
function conversationItems(view: ConversationView): Item[] {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const answer = (message: AssistantMessage, streaming: boolean) => {
    for (const part of message.content) {
      if (part.type === "text" && part.text !== "") items.push({ kind: "agent", text: part.text, streaming });
      // A streaming call's arguments are not whole yet. Its committed answer shows it.
      if (part.type === "toolCall" && !streaming) {
        const tool: ToolItem = { kind: "tool", call: part, result: { state: "none" } };
        tools.set(part.id, tool);
        items.push(tool);
      }
    }
    if (message.stopReason === "error") items.push({ kind: "notice", text: `The model failed: ${message.errorMessage ?? "no reason given"}`, tone: "bad" });
    if (message.stopReason === "aborted") items.push({ kind: "notice", text: "Aborted.", tone: "muted" });
  };

  for (const message of view.entries.flatMap((entry) => entry.model ?? [])) {
    if (message.role === "user") items.push({ kind: "user", text: contentText(message.content), queued: false, at: message.timestamp });
    if (message.role === "assistant") answer(message, false);
    if (message.role === "toolResult") {
      const result: ToolResult = { state: "done", output: contentText(message.content), isError: message.isError };
      const tool = tools.get(message.toolCallId);
      if (tool === undefined) items.push({ kind: "tool", call: { id: message.toolCallId, name: message.toolName, arguments: {} }, result });
      else tool.result = result;
    }
  }
  for (const slot of live?.tools ?? []) {
    const tool = tools.get(slot.callId);
    if (tool !== undefined && tool.result.state === "none" && slot.status === "running") tool.result = { state: "running", output: slot.output ?? "" };
  }
  const generation = live?.generation;
  if (generation?.message !== undefined) answer(generation.message as AssistantMessage, true);
  if (generation?.retry !== undefined) items.push({ kind: "notice", text: `The model request failed and will be retried: ${generation.retry.error}`, tone: "busy" });
  for (const queued of inbox?.items ?? []) {
    if (queued.mode !== "write") items.push({ kind: "user", text: contentText(queued.content as UserMessage["content"]), queued: true, at: 0 });
  }
  return items;
}

/** The model of the newest committed answer, which is the one the next message goes to. */
function modelOf(view: ConversationView): string | null {
  const answers = view.entries.flatMap((entry) => entry.model ?? []).filter((m) => m.role === "assistant");
  return answers.at(-1)?.model ?? null;
}

/**
 * What the agent's run is doing. Busy comes from the view rather than agentTurnRunning, which a parked run
 * reports as false, so a stuck run can still be aborted. A parked run is stuck, not working.
 */
type Run =
  | { kind: "idle" }
  | { kind: "working"; since: number | null; tools: number }
  | { kind: "parked"; tasks: number; busy: boolean };
function runOf(d: ThreadDetail, view: ConversationView | null, items: readonly Item[]): Run {
  const busy = (view?.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
  const parked = d.agent?.parkedTasks ?? 0;
  if (parked > 0) return { kind: "parked", tasks: parked, busy };
  if (!busy) return { kind: "idle" };
  // pi-durable keeps no start time for a run, so it is timed from the message it answers.
  const asked = items.findLastIndex((item) => item.kind === "user" && !item.queued);
  const turn = items.slice(asked + 1);
  const since = asked === -1 ? null : (items[asked] as Extract<Item, { kind: "user" }>).at;
  return { kind: "working", since, tools: turn.filter((item) => item.kind === "tool").length };
}

function runBar(t: Thread, run: Run, now: number): Html {
  const abort = html`<button type="button" class="btn btn-abort" id="abort" data-action="abort" data-thread="${t.id}">Abort</button>`;
  switch (run.kind) {
    case "idle": return html``;
    case "working": return html`<div class="run-bar working" role="status"><span class="spin" aria-hidden="true"></span><span class="run-label">The agent is working.</span><span class="dim">${run.since !== null && html`<time data-since="${run.since}">${clock(now - run.since)}</time> · `}${run.tools} ${run.tools === 1 ? "tool" : "tools"} this turn${t.status !== "archived" && " · new messages queue"}</span>${abort}</div>`;
    case "parked": return html`<div class="run-bar parked" role="alert"><span>${run.tasks} ${run.tasks === 1 ? "task" : "tasks"} hit the restart limit and hold the run. ${t.status === "archived" ? "Unarchive the thread to retry them." : "Retry runs them again."}</span>${t.status !== "archived" && html`<button type="button" class="btn" id="retry" data-action="retry" data-thread="${t.id}">Retry</button>`}${run.busy && abort}</div>`;
  }
}

/** Why a thread takes no messages, or the prompt box. A busy run queues what is sent, so the button says so. */
function composer(d: ThreadDetail, run: Run, model: string | null): Html {
  const { thread: t } = d;
  if (t.status === "deleted" || t.conversationId === null) return html``;
  // Only the planner giving up holds the pylon until a human acts. A pylon the probe reports broken may still be paused and resumed.
  if (d.pylon.failed !== null) {
    const refused = d.pylon.retryRefused !== null;
    return html`<div class="note-box failed-box" role="alert"><p>The planner gave up on this thread's pylon, so its agent cannot run tools and the thread takes no messages. ${refused
      ? `${d.pylon.retryRefused}.`
      : "Fix the cause, such as the project's git access, and retry, or start again from the same project. A retry runs setup again on a new pylon whose setup failed, and resumes a broken pylon from its newest disk."}</p>
<pre class="diag">${d.pylon.failed}</pre>
<div class="failed-actions">${!refused && html`<button type="button" class="btn" id="retry-pylon" data-action="retry-pylon" data-thread="${t.id}">Retry</button>`}<button type="button" class="btn" data-start="${t.project}" data-title="${t.title}">Start again</button></div></div>`;
  }
  if (t.status === "archived") return html`<p class="note-box">An archived thread takes no messages, because its pylon stays paused. Unarchive the thread to send one.</p>`;
  const queue = run.kind !== "idle";
  return html`<form id="prompt" class="composer${queue && " busy"}" data-thread="${t.id}">
${d.pylon.actualState === "paused" && html`<p class="comp-note">The pylon is paused. Sending a message wakes it.</p>`}
<div class="comp-box">
<textarea id="prompt-text" name="text" rows="2" required aria-label="Message the agent" placeholder="${queue ? "Queue a follow-up…" : "Message the agent…"}"></textarea>
<div class="comp-foot">${model !== null && html`<span class="chip chip-model">${model}</span>`}<span class="dim small keys">⌘↵ to ${queue ? "queue" : "send"}</span><button type="submit" class="btn btn-primary" id="send">${queue ? "Queue" : "Send"}</button></div>
</div>
</form>`;
}

/** A run of tool calls this long folds into one line, so a busy turn does not bury the answer around it. */
const foldAt = 4;

type Block = Exclude<Item, ToolItem> | { kind: "tools"; tools: ToolItem[] };
function blocks(items: readonly Item[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind !== "tool") out.push(item);
    else if (last?.kind === "tools") last.tools.push(item);
    else out.push({ kind: "tools", tools: [item] });
  }
  return out;
}

function blockView(block: Block): Html {
  switch (block.kind) {
    case "user": return html`<div class="msg user${block.queued && " queued"}"><div class="msg-who">You${block.queued && html`<span class="chip chip-queued">queued, sends after this run</span>`}</div><div class="text">${prose(block.text)}</div></div>`;
    case "agent": return block.streaming
      ? html`<div class="msg agent streaming"><div class="text" data-grow>${grows(html`${prose(block.text)}<span class="caret" aria-hidden="true"></span>`)}</div></div>`
      : html`<div class="msg agent"><div class="text">${prose(block.text)}</div></div>`;
    case "notice": return html`<p class="notice notice-${block.tone}"><span class="notice-mark" aria-hidden="true">!</span>${block.text}</p>`;
    case "tools": return block.tools.length >= foldAt ? stepsView(block.tools) : html`<div class="tools">${block.tools.map(toolView)}</div>`;
  }
}

/** Fenced blocks and `inline code` from the model's markdown. Everything else stays text. */
function prose(text: string): Html {
  const inline = (part: string) => {
    const pieces = part.split("`");
    // An odd count of backticks leaves one unmatched, so the text stays as written.
    return pieces.length % 2 === 0 ? part : pieces.map((piece, i) => i % 2 === 1 ? html`<code>${piece}</code>` : piece);
  };
  return html`${text.split(/```[^\n]*\n([\s\S]*?)```/).map((part, i) => i % 2 === 1 ? html`<pre class="code">${part}</pre>` : inline(part))}`;
}

/** The argument that says what a call did, shown in its row. */
const subjectKeys = ["command", "pattern", "path", "url"];
const subjectOf = (call: ToolItem["call"]) => {
  const key = subjectKeys.find((k) => typeof call.arguments[k] === "string");
  return key === undefined ? undefined : { key, value: String(call.arguments[key]) };
};

type DiffLine = readonly ["+" | "-", string];
const isEdit = (e: unknown): e is { oldText: string; newText: string } =>
  typeof e === "object" && e !== null && typeof (e as { oldText?: unknown }).oldText === "string" && typeof (e as { newText?: unknown }).newText === "string";
/** What pi's edit and write tools change, from the call's arguments, and the argument that holds it. */
function diffOf(call: ToolItem["call"]): { key: string; lines: DiffLine[] } | null {
  const lines = (sign: "+" | "-", text: string) => text.split("\n").map((line): DiffLine => [sign, line]);
  const { edits, content } = call.arguments;
  if (call.name === "edit" && Array.isArray(edits) && edits.length > 0 && edits.every(isEdit)) {
    return { key: "edits", lines: edits.flatMap((e) => [...lines("-", e.oldText), ...lines("+", e.newText)]) };
  }
  if (call.name === "write" && typeof content === "string") return { key: "content", lines: lines("+", content.replace(/\n$/, "")) };
  return null;
}

const failed = ({ result }: ToolItem) => result.state === "done" && result.isError;
/** pi's bash tool ends a failed command's output with its exit code. */
const exitCode = (output: string) => /exited with code (\d+)/.exec(output)?.[1];

function toolView(tool: ToolItem): Html {
  const { call, result } = tool;
  const subject = subjectOf(call);
  const diff = diffOf(call);
  const rest = Object.fromEntries(Object.entries(call.arguments).filter(([key]) => key !== subject?.key && key !== diff?.key));
  const output = result.state === "none" ? "" : result.output;
  const lines = output === "" ? 0 : output.trimEnd().split("\n").length;
  const bad = failed(tool);
  const running = result.state === "running";
  // Only what needs a look starts open: a failure, an edit's diff and a call still running.
  const open = bad || diff !== null || running;
  const added = diff?.lines.filter(([sign]) => sign === "+").length ?? 0;
  // A running call's line count and output grow in place, so a reader scrolled in its output keeps their place.
  const grow = (inside: Part) => running ? grows(inside) : inside;
  const meta = diff !== null ? html`<span class="add">+${added}</span> <span class="del">−${diff.lines.length - added}</span>` : lines > 0 && `${lines} ${lines === 1 ? "line" : "lines"}`;
  const status = running ? html`<span class="t-status run">running</span>`
    : result.state === "none" ? html`<span class="t-status none">no result</span>`
    : result.isError ? html`<span class="t-status bad">${exitCode(output) === undefined ? "failed" : `exit ${exitCode(output)}`}</span>`
    : html`<span class="t-status ok" title="succeeded">✓</span>`;
  return html`<details class="tool${bad && " failed"}${running && " running"}" id="tool-${call.id}"${open && " open"}>
<summary><span class="chev" aria-hidden="true">›</span><span class="t-name">${call.name}</span><span class="t-subj">${subject?.value}</span><span class="t-meta"${running && " data-grow"}>${grow(meta)}</span>${status}</summary>
${subject !== undefined && html`<pre class="t-full">${subject.value}</pre>`}
${Object.keys(rest).length > 0 && html`<pre class="t-args">${JSON.stringify(rest, null, 2)}</pre>`}
${diff !== null && html`<pre class="t-out diff">${diff.lines.map(([sign, line]) => html`<span class="d d-${sign === "+" ? "add" : "del"}">${sign === "+" ? "+" : "−"} ${line}</span>`)}</pre>`}
${(diff === null || bad) && (output === "" ? html`<p class="t-empty">${running ? "No output yet." : "No output."}</p>` : html`<pre class="t-out"${running && " data-grow"}>${grow(output)}</pre>`)}
</details>`;
}

const verbs: Record<string, string> = { read: "read", bash: "ran", edit: "edited", write: "wrote", grep: "searched", find: "found", ls: "listed" };
/** A step as the fold names it: read total.ts, ran npm test. */
function stepName({ call }: ToolItem): string {
  const subject = subjectOf(call);
  const short = subject === undefined ? ""
    : subject.key === "command" ? subject.value.trim().split(/\s+/).slice(0, 2).join(" ")
    : subject.key === "path" ? subject.value.split("/").at(-1)!
    : subject.value;
  return `${verbs[call.name] ?? call.name} ${short}`.trim();
}

/** The fold opens itself when a step failed or is still running, which is when the reader needs to see it. */
function stepsView(tools: readonly ToolItem[]): Html {
  const bad = tools.filter(failed).length;
  const running = tools.filter((t) => t.result.state === "running").length;
  return html`<details class="steps" id="steps-${tools[0]!.call.id}"${(bad > 0 || running > 0) && " open"}>
<summary><span class="chev" aria-hidden="true">›</span><span class="s-count">${tools.length} steps</span><span class="sep" aria-hidden="true">·</span><span class="s-names">${[...new Set(tools.map(stepName))].join(", ")}</span>${bad > 0 && html`<span class="sep" aria-hidden="true">·</span><span class="s-bad">${bad} failed</span>`}${running > 0 && html`<span class="sep" aria-hidden="true">·</span><span class="s-run">${running} running</span>`}</summary>
<div class="tools">${tools.map(toolView)}</div>
</details>`;
}

function notFound(c: Context, message: string): Html {
  return layout(c, {
    title: "Not found",
    main: html`<header class="bar"><button type="button" class="icon-btn menu" data-open="side" aria-label="Threads">☰</button><div class="crumb"><h1>Not found</h1></div></header>
<div class="scroll"><div class="page"><p>${message}</p><p><a class="link" href="/">All threads</a></p></div></div>`,
  });
}
