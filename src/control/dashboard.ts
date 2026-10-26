/**
 * The dashboard: server-rendered HTML pages for the control plane, served behind the API's own checks. A page
 * reads the registry the way the JSON API does, so the sidebar, the thread page and `GET /v1/threads/<id>` agree.
 *
 * Every page is the same console, laid out after Jetline's: threads by project on the left, the page in the middle,
 * and on a thread page an inspector on the right whose tabs show the checkout's changes, the previews and ports, and
 * the pylon with its outputs and sessions. A thread page's middle has tabs too: the conversation, and a diff for
 * each changed file opened from the inspector. Starting a thread and adding a project are dialogs every page carries.
 *
 * Every action goes through the JSON API from `dashboard/client.js`, because the API refuses state changes
 * without a JSON content type and an HTML form cannot send one. The client polls each page and swaps the regions
 * marked `data-live` that changed. A thread page also opens its stream, which sends the conversation region as the
 * run streams: whole when its shape changed, or else only the parts that grow in place, the partial answer and
 * each running tool. A Claude worker thread's conversation is its transcript, shown in the same rows. The changes and
 * the diffs are read by the client from the JSON API, because each read reaches into the pylon and counts as a
 * human's visit, so they are read when asked for rather than with every poll.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { AssistantMessage, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, InboxState, LiveState } from "@earendil-works/pi-durable";
import { desiredPhase, type ActualState, type DesiredPhase } from "../reconcile.ts";
import type { HerdrStatus } from "../protocol.ts";
import { githubTokenGrant, linkedPort, type SessionHarness } from "../project.ts";
import type { ThreadDetail } from "./api.ts";
import type { Attention } from "./attention.ts";
import type { NodeRecord, Output, Preview, Registry, Thread, ThreadId } from "./registry.ts";
import { usageLimitText, type ClaudeConversation, type ClaudeEntry, type PromptSource } from "../claude-transcript.ts";
import { queuedOf } from "./claude-conversation.ts";
import { roundsSpent } from "./review.ts";

export interface DashboardOptions {
  registry: Registry;
  /** The API's thread detail, so the dashboard derives the actual state exactly as the API does. */
  detail(thread: Thread): ThreadDetail;
  /** The API's conversation view, or a Claude worker's transcript, for a thread that has one and is not deleted. */
  conversation(thread: Thread): Promise<Conversation>;
  now?: () => number;
}

export interface Page { status: number; headers: Record<string, string>; body: string }

/** What a thread page shows as its conversation: the harness conversation's view, or a Claude worker's transcript. */
type Conversation = ConversationView | ClaudeConversation;
const isClaude = (view: Conversation): view is ClaudeConversation => (view as Partial<ClaudeConversation>).kind === "claude";

/** How often the client refetches a page. The loop ticks every 5 s, so polling faster shows nothing new. */
export const pollMs = 5_000;

/** What every part of a page reads. */
interface Context { registry: Registry; detail: DashboardOptions["detail"]; now: number }

/** Returns the page for a GET of `path`, or undefined when the path is not the dashboard's. */
export function dashboard(options: DashboardOptions): (path: string, query: URLSearchParams) => Promise<Page | undefined> {
  const { registry, detail } = options;
  const context = (): Context => ({ registry, detail, now: (options.now ?? Date.now)() });

  /** A failed read shows in the conversation, so the rest of the page still says what the pylon is doing. */
  async function transcript(t: Thread): Promise<Conversation | Error | null> {
    if ((t.conversationId === null && registry.claudeWorker(t.id) === undefined) || t.status === "deleted") return null;
    return options.conversation(t).catch((err: unknown) => err as Error);
  }

  const pages: readonly [RegExp, (m: RegExpExecArray, query: URLSearchParams) => Page | Promise<Page>][] = [
    [/^\/$/, () => ok(home(context(), {}))],
    [/^\/threads\/new$/, (_, query) => ok(home(context(), { start: { project: query.get("project") } }))],
    [/^\/projects\/new$/, () => ok(home(context(), { addProject: true }))],
    [/^\/threads\/([^/]+)$/, async (m) => {
      const thread = registry.thread(m[1]! as ThreadId);
      if (thread === undefined) return { ...ok(notFound(context(), `No thread ${m[1]!}.`)), status: 404 };
      // The reply known before this read is a safe watermark even if another turn ends during it.
      const view = await transcript(thread);
      // After the read, so the facts are no older than the conversation, and a thread deleted meanwhile shows none.
      const d = detail(registry.thread(thread.id)!);
      return ok(threadPage(context(), d, registry.node(d.pylon.node)!, d.thread.status === "deleted" ? null : view, thread.lastReplyAt));
    }],
    [/^\/assets\/([\w.-]+)$/, (m, query) => {
      const asset = assets.get(m[1]!);
      if (asset === undefined) return { ...ok(notFound(context(), `No asset ${m[1]!}.`)), status: 404 };
      // Pages link each asset with its hash, and a chunk's name has its hash, so neither URL ever changes and the
      // phone keeps it.
      const cache = asset.version === null || query.get("v") === asset.version ? "public, max-age=31536000, immutable" : "no-cache";
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

const types: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml" };
const bundle = new URL("../../dist/dashboard/", import.meta.url);
if (!existsSync(new URL("client.js", bundle))) throw new Error("The dashboard client is not built. Run `npm run build`.");
/** The stylesheet and icon as they are in src, and the client as src/control/dashboard/build.ts bundled it. */
const assets = new Map([
  ...["style.css", "favicon.svg"].map((file) => [file, new URL(`./dashboard/${file}`, import.meta.url)] as const),
  ...readdirSync(bundle).map((file) => [file, new URL(file, bundle)] as const),
].map(([file, url]) => {
  const body = readFileSync(url, "utf8");
  // A chunk is named by its hash, so only the files a page links carry a version.
  const version = ["style.css", "favicon.svg", "client.js"].includes(file) ? createHash("sha256").update(body).digest("hex").slice(0, 12) : null;
  return [file, { type: types[file.split(".").at(-1)!]!, body, version }];
}));
const assetUrl = (file: string) => `/assets/${file}?v=${assets.get(file)!.version}`;

const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
const outputLabel: Record<Output["kind"], string> = { branch: "branch", diff: "diff", preview: "preview", file: "file", "pull-request": "pull request" };

/** A dot alone carries its meaning in its accessible name. One beside its label is decoration. */
const dot = (tone: Tone, label?: string) => label === undefined
  ? html`<span class="dot dot-${tone}" aria-hidden="true"></span>`
  : html`<span class="dot dot-${tone}" role="img" aria-label="${label}" title="${label}"></span>`;
const state = (label: string, tone: Tone) => html`<span class="state">${dot(tone)}${label}</span>`;

/** Line icons on a 16-unit grid, drawn in the text's colour. client.js clones them from the page's `#icons`. */
const iconPaths = {
  folder: "M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z",
  branch: "M5 2.5v11M5 13.5a1.5 1.5 0 1 0 0-.01M11 2.5a1.5 1.5 0 1 0 0 .01M11 4v1.5a3 3 0 0 1-3 3H5",
  chevron: "M6 4l4 4-4 4",
  chat: "M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5z",
  changes: "M8 2.5v6M5 5.5h6M5 12.5h6",
  globe: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12",
  server: "M3 3h10v4H3zM3 9h10v4H3zM5.5 5h.01M5.5 11h.01",
  plus: "M8 3v10M3 8h10",
  up: "M8 13V3M4 7l4-4 4 4",
} as const;
type IconName = keyof typeof iconPaths;
const icon = (name: IconName) => html`<svg class="i i-${name}" viewBox="0 0 16 16" aria-hidden="true"><path d="${iconPaths[name]}"/></svg>`;
/** Text a screen reader says that the page shows another way, such as with an icon or a bubble's side. */
const unseen = (text: string) => html`<span class="vh">${text}</span>`;

/** What a thread is doing, most urgent first: the agent mid-turn hides a running pylon, never a failed one. */
function threadState({ thread: t, pylon, attention }: ThreadDetail): [label: string, tone: Tone] {
  if (attention === "failed") return ["failed", "bad"];
  if (attention === "decision") return ["needs your decision", "bad"];
  if (attention === "parked") return ["parked", "bad"];
  if (attention === "limited") return [usageLimitText(t.usageLimit ?? { resetsAt: null }, Date.now()), "bad"];
  if (attention === "reply") return ["new reply", "ok"];
  if (attention === "waiting") return [t.sessionWaitingMessage ?? "waiting for input", "idle"];
  if (attention === "working") return ["agent working", "work"];
  if (t.status === "archived" || t.status === "deleted") return [t.status, "muted"];
  return actualBadge[pylon.actualState];
}

/**
 * Whether a thread needs the person, so its row stays bright: a failure or a parked run to fix, a review's decision,
 * a session stopped on its usage limit, a reply to read, or a session waiting on an answer. Waiting ranks below working, but only waiting is blocked on the person.
 */
const needsPerson: Record<`${Attention}`, boolean> = { failed: true, decision: true, parked: true, limited: true, reply: true, waiting: true, working: false, null: false };
/** The open thread's row never dims, nor a closed thread's, which its fold already sets apart. */
const dims = (d: ThreadDetail, active?: ThreadId) =>
  d.thread.id !== active && (d.thread.status === "active" || d.thread.status === "idle") && !needsPerson[`${d.attention}`];

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

/** A run's length as a clock reads it, such as 1m 03s. client.js ticks it with the same format. */
// After t3code's formatElapsedSeconds. Copyright (c) 2026 T3 Tools Inc., MIT licence; see THIRD_PARTY_NOTICES.md.
function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long a thread's running turn has worked, which client.js ticks, or null when no turn runs. */
function workingFor(t: Thread, now: number): Html | null {
  if (!t.agentTurnRunning && t.sessionTurnRunning !== true) return null;
  return t.workingSince === undefined ? html`working` : html`working <time data-since="${t.workingSince}">${clock(now - t.workingSince)}</time>`;
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
<meta name="color-scheme" content="light dark">
<title>${page.title} · Nexus</title>
<link rel="icon" href="${assetUrl("favicon.svg")}" type="image/svg+xml">
<link rel="stylesheet" href="${assetUrl("style.css")}">
<script type="module" src="${assetUrl("client.js")}"></script>
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
<template id="icons">${(Object.keys(iconPaths) as IconName[]).map(icon)}</template>
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
  // A thread works in its own checkout, as a Jetline workspace does, so its row shows a branch with its state as a badge.
  const row = (t: Thread) => {
    const d = c.detail(t);
    const [label, tone] = threadState(d);
    return html`<li><a class="row${t.id === active && " active"}${dims(d, active) && " dim"}" href="/threads/${t.id}"${t.id === active && html` aria-current="page"`}><span class="row-icon">${icon("branch")}${dot(tone, label)}</span><span class="row-title">${t.title}</span><span class="row-at">${workingFor(t, c.now) ?? span(lastActive(t), c.now) ?? "now"}</span></a></li>`;
  };
  return html`<aside class="side" aria-label="Threads">
<div class="side-head"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">◆</span>nexus</a><a class="btn btn-new" href="/threads/new" data-start>New thread<kbd>N</kbd></a></div>
<label class="filter"><span aria-hidden="true">⌕</span><input id="filter" type="search" placeholder="Filter threads" aria-label="Filter threads" autocomplete="off"></label>
<nav class="groups" id="side-threads" data-live aria-label="Threads by project">
${projects.length === 0 ? html`<p class="empty side-empty">No projects yet.</p>` : projects.map((p) => {
  const { open, closed } = threadsOf(c, p.id);
  // A project folds like a folder. client.js remembers which ones the reader folded.
  return html`<details class="group" id="group-${p.id}" open>
<summary class="group-h">${icon("chevron")}${icon("folder")}<span class="group-name"><span>${p.id}</span><span class="group-branch">${p.defaultBranch}</span></span></summary>
<a class="group-new" href="/threads/new?project=${encodeURIComponent(p.id)}" data-start="${p.id}" aria-label="New thread in ${p.id}" title="New thread in ${p.id}">${icon("plus")}</a>
${open.length > 0 && html`<ul>${open.map(row)}</ul>`}
${closed.length > 0 && html`<details class="archived" id="archived-${p.id}"${closed.some((t) => t.id === active) && " open"}><summary>${closedLabel(closed)}</summary><ul>${closed.map(row)}</ul></details>`}
</details>`;
})}
</nav>
<div class="nodes" id="side-nodes" data-live aria-label="Nodes"><h2>Nodes</h2><small>Desired release: ${c.registry.desiredRelease()?.commit.slice(0, 12) ?? "manual"}</small>${c.registry.nodes().map((n) => html`<span>${icon("server")}${n.name}${dot(n.state === "online" ? "ok" : "muted")}${n.state === "offline" && html`<em>offline</em>`}</span>${c.registry.releaseReports().filter((r) => r.node === n.name).map((r) => html`<small title="${r.reason ?? ""}">${r.role}: ${r.commit?.slice(0, 12) ?? "unknown"} · ${c.now - r.observedAt >= 90_000 ? "stale" : r.state}</small>`)}`)}</div>
<a class="btn side-add" href="/projects/new" data-new-project>New project</a>
</aside>`;
}

/**
 * The dialog starts a Claude Code worker unless the reader picks the Nexus agent. A Claude worker's title is its
 * prompt's first line unless given, as `nexus start --claude` does. client.js disables the fields of the worker not
 * picked, so the form never sends them, and makes the title required for the Nexus agent.
 */
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
<fieldset class="seg" id="start-worker"><legend>Worker</legend>
<label class="seg-opt"><input type="radio" name="worker" value="claude" checked><span class="seg-name">Claude Code</span><span class="seg-repo">for code work</span></label>
<label class="seg-opt"><input type="radio" name="worker" value="harness"><span class="seg-name">Nexus agent</span><span class="seg-repo">the control plane's own harness</span></label>
</fieldset>
<div id="start-claude-fields">
<label for="start-claude">Prompt</label>
<textarea id="start-claude" name="claude" required placeholder="What should Claude do?" autofocus></textarea>
<p class="hint">Runs <code>/poteto-mode</code> with this prompt, as <code>nexus start --claude</code> does.</p>
<label for="start-model">Model (optional)</label>
<input id="start-model" name="model" autocomplete="off" placeholder="claude-opus-5-5">
<p class="hint">Opus 5.5 unless you name another.</p>
</div>
<label for="start-title" id="start-title-label">Title (optional)</label>
<input id="start-title" name="title" autocomplete="off" placeholder="The prompt's first line">
<fieldset class="seg"><legend>Project</legend>
${projects.map((p) => html`<label class="seg-opt"><input type="radio" name="project" required value="${p.id}" data-node="${p.defaultNode}" data-branch="${p.defaultBranch}"${p.repoUrl === null && " data-scratch"}${p === chosen && " checked"}><span class="seg-name">${p.id}</span><span class="seg-repo">${p.repoUrl ?? "scratch"}</span></label>`)}
</fieldset>
<div class="two">
<div><label for="start-node">Node</label><select id="start-node" name="node">
<option value="">${chosen.defaultNode} (project default)</option>
<option value="auto">auto, where it fits best</option>
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
  return html`<tr${dims(d) && html` class="dim"`}>
<td><span class="ov-title">${dot(tone, label)}<a href="/threads/${t.id}">${t.title}</a>${t.status !== "active" && html`<span class="tag">${t.status}</span>`}</span></td>
<td class="wide">${state(desired, desiredTone[desired])}</td>
<td>${state(...actualBadge[d.pylon.actualState])}</td>
<td class="wide">${d.pylon.node}${nodes.get(d.pylon.node)!.state === "offline" && html` <span class="tag">offline</span>`}</td>
<td class="wide">${ago(t.lastHumanActivityAt, c.now)}</td>
<td class="wide">${workingFor(t, c.now) ?? ago(t.lastAgentActivityAt, c.now)}</td>
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

function threadPage(c: Context, d: ThreadDetail, node: NodeRecord, view: Conversation | Error | null, renderedReplyAt: number | null): Html {
  const { thread: t } = d;
  const read = view === null || view instanceof Error ? null : view;
  const items = read === null ? [] : itemsOf(read);
  const run = runOf(d, read, items);
  const model = d.claudeWorker !== undefined ? d.claudeWorker.model : read === null || isClaude(read) ? null : modelOf(read);
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
<div class="tabs" id="tabs" role="tablist" aria-label="Open views" data-thread="${t.id}"><button type="button" class="tab active" role="tab" aria-selected="true" aria-controls="scroll" data-tab="convo">${icon("chat")}<span class="tab-name">${t.title}</span></button></div>
<div class="strip" id="strip" data-live>${strip(d)}</div>
<div id="facts" data-live hidden>${facts(d)}</div>
<div class="scroll" id="scroll" role="tabpanel"><div class="convo" id="convo" data-rendered-reply-at="${read === null ? "" : renderedReplyAt ?? ""}" data-live${(t.conversationId !== null || d.claudeWorker !== undefined) && t.status !== "deleted" && html` data-stream="/threads/${t.id}/stream"`}>${convo(t, view, items, model, c.now)}</div></div>
<section class="file-view" id="file-view" role="tabpanel" aria-label="File diff" hidden></section>
<div class="dock">
<p id="action-error" class="error" role="alert" hidden></p>
<p id="action-status" class="comp-note" role="status" hidden></p>
<div id="run" data-live>${runBar(t, run, c.now)}</div>
<div id="composer" data-live>${composer(d, run, model, read !== null && isClaude(read) ? read : null, c.now)}</div>
</div>`,
    inspector: inspector(d, node, c.now),
  });
}

/**
 * Each preview is listed once, under Previews, so the outputs leave out those it lists. A preview output stays for
 * one the control plane no longer has.
 */
const outputsOf = (d: ThreadDetail) => d.outputs.filter((o) => o.kind !== "pull-request" && (o.kind !== "preview" || !d.previews.some((p) => p.service === o.ref)));

/**
 * The inside of the conversation region, which the page's stream sends again whenever it changed. `model` is the
 * model the next message goes to, or a Claude worker's.
 */
function convo(t: Thread, view: Conversation | Error | null, items: readonly Item[], model: string | null, now: number): Html {
  const claude = view !== null && !(view instanceof Error) && isClaude(view) ? view : null;
  return html`
<p class="convo-meta"><code>${t.id}</code> · started ${ago(t.createdAt, now)}${claude !== null && " · Claude Code"}${model !== null && html` · ${model}`}</p>
${view === null ? html`<p class="empty">${t.status === "deleted" ? "The thread is deleted, so its conversation is gone." : "This thread has no agent conversation."}</p>`
  : view instanceof Error ? html`<p class="error">The conversation could not be read: ${view.message}</p>`
  : claude !== null && items.length === 0 ? html`<p class="empty">${claude.readAt === null ? "Claude's transcript has not been read yet. It is read while the pylon runs." : "Claude has not written a transcript yet."}</p>`
  : items.length === 0 ? html`<p class="empty">No messages yet.</p>`
  : html`${claude !== null && claude.dropped > 0 && html`<p class="note">${claude.dropped} older ${claude.dropped === 1 ? "entry is" : "entries are"} not kept.</p>`}${blocks(items).map(blockView)}`}
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
export function liveFrames(t: Thread, claudeModel: string | null = null, now: () => number = Date.now): (view: Conversation) => LiveFrame | null {
  let shape: string | null = null;
  let parts: string[] = [];
  return (view) => {
    const region = convo(t, view, itemsOf(view), isClaude(view) ? claudeModel : modelOf(view), now()).text;
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

/**
 * What client.js reads to decide when to read the checkout's changes: once the pylon runs, and again when its
 * agent was active and no turn runs, as that is when the checkout has changed. The agent's last activity catches a
 * turn that began and ended between two polls.
 */
function facts({ thread: t, pylon }: ThreadDetail): Html {
  return html`<span data-pylon="${pylon.actualState}" data-turn="${String(t.agentTurnRunning)}" data-agent-at="${t.lastAgentActivityAt}" data-thread-status="${t.status}"></span>`;
}

/** The phone's stand-in for the inspector: the pylon, each preview as a link where it has one, and the outputs. */
function strip(d: ThreadDetail): Html {
  const outputs = outputsOf(d).length + (d.pullRequests?.length ?? 0);
  const [label, tone] = actualBadge[d.pylon.actualState];
  return html`<button type="button" class="mini" data-open="inspect" data-pane="pylon">${dot(tone)}${label} · ${d.pylon.node}</button>
${d.previews.map((p) => {
  const look = lookOf(d, p);
  return look.linked
    ? html`<a class="mini mini-${look.tone}" href="${p.url}" target="_blank" rel="noopener">${p.service}${look.label !== null && `, ${look.label}`} ↗</a>`
    : html`<span class="mini mini-${look.tone}">${p.service}, ${look.label}</span>`;
})}
<button type="button" class="mini" data-open="inspect" data-pane="changes">Changes</button>
<button type="button" class="mini" data-open="inspect" data-pane="pylon">${outputs} ${outputs === 1 ? "output" : "outputs"}</button>`;
}

const panes = [["changes", "Changes", "changes"], ["previews", "Previews", "globe"], ["pylon", "Pylon", "server"]] as const;

/**
 * The inspector's tabs are radios, so the one picked stays picked while the regions under it are swapped, and
 * shows its pane without a script. The Changes pane is filled by client.js, so it is outside every live region.
 */
function inspector(d: ThreadDetail, node: NodeRecord, now: number): Html {
  // The Previews tab counts what its pane lists: the previews and the ports without one.
  const listed = d.previews.length + (d.ports?.filter((l) => l.preview === null).length ?? 0);
  return html`<aside class="inspect" aria-label="Thread details">
<button type="button" class="icon-btn inspect-close" data-close aria-label="Close details">✕</button>
<div class="seg-bar" role="radiogroup" aria-label="Inspector">${panes.map(([pane, label, glyph]) => html`<label class="seg-tab"><input type="radio" name="pane" value="${pane}"${pane === "changes" && " checked"}>${icon(glyph)}<span class="seg-label">${label}</span>${pane === "previews" && html`<span class="count" id="count-previews" data-live>${listed}</span>`}</label>`)}</div>
<section class="ipane" id="pane-changes" aria-labelledby="changes-h" data-thread="${d.thread.id}">
<h2 id="changes-h" class="vh">Changes</h2>
<div class="ch-head"><label class="switch"><input type="checkbox" id="changes-head"><span class="switch-label">Only uncommitted</span></label><label class="switch"><input type="checkbox" id="changes-turn"><span class="switch-label">Latest turn</span></label><button type="button" class="icon-btn" id="changes-reload" aria-label="Read the changes again" title="Read the changes again">↻</button></div>
<p class="ch-base dim small" id="changes-base">Since the pylon booted</p>
<div id="changes-body"><p class="empty">The changes show once the page's script loads.</p></div>
</section>
<div class="pane-live" id="inspect" data-live>${inspectorPanes(d, node, now)}</div>
</aside>`;
}

function inspectorPanes(d: ThreadDetail, node: NodeRecord, now: number): Html {
  const { thread: t, pylon } = d;
  const count = (n: number) => html`<span class="count">${n}</span>`;
  const desired = desiredPhase(t, now);
  const outputs = outputsOf(d);
  // A port with a preview is listed under Previews. Ports lists the rest, which are published only when someone opens one.
  const unpublished = d.ports?.filter((l) => l.preview === null) ?? null;
  const host = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");
  // Only a linked port's preview can be unpublished. A service's preview is part of its declaration.
  const open = t.status === "active" || t.status === "idle";
  return html`<div class="ipane" id="pane-previews">
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
  : html`<p class="empty">${d.ports?.length === 0 ? "Nothing listens yet." : "Every port that listens is under Previews."}</p>`}
</section>
</div>
<div class="ipane" id="pane-pylon">
<section aria-labelledby="pylon-h"><h2 id="pylon-h">Pylon</h2>
<dl class="kv">
<dt>Desired</dt><dd>${state(desired, desiredTone[desired])}</dd>
<dt>Observed</dt><dd>${state(...actualBadge[pylon.actualState])}</dd>
<dt>Node</dt><dd>${pylon.node}${node.state === "offline" && html` <span class="tag">offline</span>`}</dd>
<dt>Last seen</dt><dd>${pylon.observedAt === null ? "never" : ago(Date.parse(pylon.observedAt), now)}${node.state === "offline" && pylon.observedAt !== null && " (stale)"}</dd>
<dt>Human</dt><dd>${ago(t.lastHumanActivityAt, now)}</dd>
<dt>Agent</dt><dd>${workingFor(t, now) ?? ago(t.lastAgentActivityAt, now)}</dd>
</dl>
<code class="id">${pylon.id}</code>
${pylon.failed !== null && html`<p class="error">The planner gave up: ${pylon.failed}</p>`}
</section>
<section aria-labelledby="outputs-h"><h2 id="outputs-h">Outputs ${count(outputs.length + (d.pullRequests?.length ?? 0))}</h2>
${!d.prWatch?.enabled ? html`<p class="empty">PR watch: off (no control-plane GitHub token configured).</p>` : html`<p>PR watch: ${d.prWatch.stopped ? "stopped (10 comment-only wakes)" : "on"}${d.prWatch.error && html` — ${d.prWatch.error}`}</p>`}
${(d.pullRequests ?? []).map((pr) => html`<p><a href="${pr.url}" target="_blank" rel="noreferrer">PR #${pr.number}: ${pr.title}</a> — ${pr.state}, checks ${pr.checks}, review ${pr.review}</p>`)}
${d.review != null && html`<p>Nexus review ${d.review.id}: ${d.review.phase.kind}, round ${roundsSpent(d.review)} of ${d.review.maxRounds}, by <a href="/threads/${d.review.reviewer}">${d.review.reviewer}</a> on ${d.review.models.reviewer}${d.review.land !== null && ", landing when approved"}</p>${d.review.phase.kind === "needs-person" && html`<ul class="error">${d.review.phase.reasons.map((reason) => html`<li>${reason}</li>`)}</ul>`}`}
${outputs.length === 0 ? html`<p class="empty">No other outputs yet.</p>` : html`<ul class="list outs">${outputs.map((o) => html`<li><span class="o-kind">${outputLabel[o.kind]}</span><code>${o.ref}</code></li>`)}</ul>`}
</section>
${d.claudeWorker === undefined ? "" : html`<section><h2>Claude worker</h2><p>${d.claudeWorker.state} · ${d.claudeWorker.model ?? "unknown"}</p>${d.claudeWorker.message === undefined ? "" : html`<pre>${d.claudeWorker.message}</pre>`}</section>`}
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
</div>`;
}

/**
 * One row of the conversation. A tool call carries its result, which the transcript holds in a later entry, and the
 * finish of a background task it started. A queued message carries what happens to it, such as that it sends after
 * the run. A note is a quiet line, such as how long a turn took.
 */
type Item =
  | { kind: "user"; text: string; queued: string | null; at: number; from: PromptFrom }
  | { kind: "agent"; text: string; streaming: boolean }
  | { kind: "tool"; call: { id: string; name: string; arguments: Readonly<Record<string, unknown>> }; result: ToolResult; task?: Pick<Extract<ClaudeEntry, { kind: "task" }>, "status" | "summary" | "result"> }
  | { kind: "notice"; text: string; tone: Tone }
  | { kind: "note"; text: string }
  | { kind: "link"; text: string; url: string };
type ToolResult = { state: "done"; output: string; isError: boolean } | { state: "running"; output: string } | { state: "none" };
type ToolItem = Extract<Item, { kind: "tool" }>;
type UserItem = Extract<Item, { kind: "user" }>;

/** Who a message came from. Nexus's PR watch and review loop write into a conversation as a user. */
type PromptFrom = PromptSource | "pr-watch" | "review";
/** How a bubble names who a message came from. A person's is said only to a screen reader, as the bubble's side shows it. */
const promptLabel: Record<PromptFrom, string> = {
  person: "You", "pr-watch": "Nexus PR watch", review: "Nexus review", command: "Slash command", other: "Claude Code",
};

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

  for (const { entry, message } of view.entries.flatMap((entry) => (entry.model ?? []).map((message) => ({ entry, message })))) {
    if (message.role === "user") items.push({ kind: "user", text: contentText(message.content), queued: null, at: message.timestamp, from: entry.kind === "nexus.pr-watch" ? "pr-watch" : entry.kind === "nexus.review" ? "review" : "person" });
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
    if (queued.mode !== "write") items.push({ kind: "user", text: contentText(queued.content as UserMessage["content"]), queued: "sends after this run", at: 0, from: "person" });
  }
  return items;
}

const itemsOf = (view: Conversation): Item[] => isClaude(view) ? claudeItems(view) : conversationItems(view);

/**
 * A Claude worker's transcript as the rows a harness conversation shows. Each result goes on its call, and a
 * background task's finish on the call that started it. A call of the current turn without a result runs while
 * Claude works. A message Claude Code queued and has not taken shows queued at the end. A pull request shows once.
 */
function claudeItems({ entries, working }: ClaudeConversation): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const pullRequests = new Set<string>();
  let turn: ToolItem[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "prompt": items.push({ kind: "user", text: entry.text, queued: null, at: entry.at, from: entry.from }); break;
      case "reply": items.push({ kind: "agent", text: entry.text, streaming: false }); break;
      case "tool": {
        const tool: ToolItem = { kind: "tool", call: { id: entry.id, name: entry.name, arguments: entry.input }, result: { state: "none" } };
        tools.set(entry.id, tool);
        turn.push(tool);
        items.push(tool);
        break;
      }
      case "result": {
        const result: ToolResult = { state: "done", output: entry.output, isError: entry.isError };
        const tool = tools.get(entry.toolUseId);
        if (tool === undefined) items.push({ kind: "tool", call: { id: entry.toolUseId, name: "tool", arguments: {} }, result });
        else tool.result = result;
        break;
      }
      case "task": {
        const tool = entry.toolUseId === null ? undefined : tools.get(entry.toolUseId);
        if (tool === undefined) items.push({ kind: "notice", text: `A background task ${entry.status}: ${entry.summary}`, tone: "muted" });
        else tool.task = entry;
        break;
      }
      case "queue": break;
      case "notice": items.push({ kind: "notice", text: entry.text, tone: entry.tone === "error" ? "bad" : "muted" }); break;
      case "turn":
        turn = [];
        items.push({ kind: "note", text: `Worked for ${clock(entry.durationMs)}.` });
        break;
      case "pull-request":
        if (!pullRequests.has(entry.url)) items.push({ kind: "link", text: `Opened pull request #${entry.number}`, url: entry.url });
        pullRequests.add(entry.url);
        break;
      case "record": items.push({ kind: "notice", text: `Claude Code wrote a ${entry.type} record: ${entry.summary}`, tone: "muted" }); break;
    }
  }
  if (working) for (const tool of turn) if (tool.result.state === "none") tool.result = { state: "running", output: "" };
  for (const q of queuedOf(entries)) items.push({ kind: "user", text: q.text ?? "A message the transcript does not show", queued: "Claude takes it at its next step", at: q.at, from: "person" });
  return items;
}

/** The model of the newest committed answer, which is the one the next message goes to. */
function modelOf(view: ConversationView): string | null {
  const answers = view.entries.flatMap((entry) => entry.model ?? []).filter((m) => m.role === "assistant");
  return answers.at(-1)?.model ?? null;
}

/**
 * What the agent's run is doing. Busy comes from the view rather than agentTurnRunning, which a parked run
 * reports as false, so a stuck run can still be aborted. A parked run is stuck, not working. A Claude worker works
 * while a turn of its session runs, and the harness cannot abort it.
 */
type Run =
  | { kind: "idle" }
  | { kind: "working"; since: number | null; tools: number; claude: boolean }
  | { kind: "parked"; tasks: number; busy: boolean };
function runOf(d: ThreadDetail, view: Conversation | null, items: readonly Item[]): Run {
  if (view !== null && isClaude(view)) return view.working ? working(d, items, (item) => item.from === "person", true) : { kind: "idle" };
  const busy = (view?.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
  const parked = d.agent?.parkedTasks ?? 0;
  if (parked > 0) return { kind: "parked", tasks: parked, busy };
  if (!busy) return { kind: "idle" };
  return working(d, items, () => true, false);
}

/** A turn's calls are those after the message it answers. Its start is the registry's, so the bar and the rows agree. */
function working(d: ThreadDetail, items: readonly Item[], asks: (item: UserItem) => boolean, claude: boolean): Run {
  const turn = items.slice(items.findLastIndex((item) => item.kind === "user" && item.queued === null && asks(item)) + 1);
  return { kind: "working", since: d.thread.workingSince ?? null, tools: turn.filter((item) => item.kind === "tool").length, claude };
}

function runBar(t: Thread, run: Run, now: number): Html {
  const abort = html`<button type="button" class="btn btn-abort" id="abort" data-action="abort" data-thread="${t.id}">Abort</button>`;
  switch (run.kind) {
    case "idle": return html``;
    case "working": return html`<div class="run-bar working" role="status"><span class="spin" aria-hidden="true"></span><span class="run-label">${run.claude ? "Claude is working." : "The agent is working."}</span><span class="dim">${run.since !== null && html`<time data-since="${run.since}">${clock(now - run.since)}</time> · `}${run.tools} ${run.tools === 1 ? "tool" : "tools"} this turn${t.status !== "archived" && (run.claude ? " · new messages go in at its next step" : " · new messages queue")}</span>${!run.claude && abort}</div>`;
    case "parked": return html`<div class="run-bar parked" role="alert"><span>${run.tasks} ${run.tasks === 1 ? "task" : "tasks"} hit the restart limit and hold the run. ${t.status === "archived" ? "Unarchive the thread to retry them." : "Retry runs them again."}</span>${t.status !== "archived" && html`<button type="button" class="btn" id="retry" data-action="retry" data-thread="${t.id}">Retry</button>`}${run.busy && abort}</div>`;
  }
}

/**
 * Why a thread takes no messages, or the prompt box. A busy run queues what is sent, so the button says so. A Claude
 * worker's box is marked for client.js, which tries a send again while the pylon wakes, and says how old the
 * transcript is while the pylon does not run.
 */
function composer(d: ThreadDetail, run: Run, model: string | null, claude: ClaudeConversation | null, now: number): Html {
  const { thread: t } = d;
  if (t.status === "deleted" || (t.conversationId === null && claude === null)) return html``;
  const asOf = claude === null || d.pylon.actualState === "running" ? null
    : claude.readAt === null ? html`The pylon is not running, and Claude's transcript has not been read yet.`
    : html`The pylon is not running, so the transcript is as of its last read, ${ago(claude.readAt, now)}.`;
  // Only the planner giving up holds the pylon until a human acts. A pylon the probe reports broken may still be paused and resumed.
  if (d.pylon.failed !== null) {
    const refused = d.pylon.retryRefused !== null;
    return html`<div class="note-box failed-box" role="alert"><p>The planner gave up on this thread's pylon, so its agent cannot run tools and the thread takes no messages. ${refused
      ? `${d.pylon.retryRefused}.`
      : "Fix the cause, such as the project's git access, and retry, or start again from the same project. A retry runs setup again on a new pylon whose setup failed, and resumes a broken pylon from its newest disk."}</p>
<pre class="diag">${d.pylon.failed}</pre>
<div class="failed-actions">${!refused && html`<button type="button" class="btn" id="retry-pylon" data-action="retry-pylon" data-thread="${t.id}">Retry</button>`}<button type="button" class="btn" data-start="${t.project}" data-title="${t.title}">Start again</button></div></div>`;
  }
  if (t.status === "archived") return html`<p class="note-box">An archived thread takes no messages, because its pylon stays paused. Unarchive the thread to send one.${asOf !== null && html` ${asOf}`}</p>`;
  const queue = run.kind !== "idle";
  const placeholder = claude === null ? (queue ? "Queue a follow-up…" : "Message the agent…") : queue ? "Queue for Claude…" : "Message Claude…";
  return html`<form id="prompt" class="composer${queue && " busy"}" data-thread="${t.id}"${claude !== null && " data-claude"}>
${claude === null ? d.pylon.actualState === "paused" && html`<p class="comp-note">The pylon is paused. Sending a message wakes it.</p>`
  : html`${asOf !== null && html`<p class="comp-note">${asOf} Sending a message wakes it and resumes Claude.</p>`}${queue && html`<p class="comp-note">Claude Code takes a message sent during a turn at its next step.</p>`}`}
<div class="comp-box">
<textarea id="prompt-text" name="text" rows="2" required aria-label="${claude === null ? "Message the agent" : "Message Claude"}" placeholder="${placeholder}"></textarea>
<div class="comp-foot">${model !== null && html`<span class="chip chip-model">${model}</span>`}<span class="dim small keys">⌘↵ to ${queue ? "queue" : "send"}</span><button type="submit" class="send" id="send" title="${queue ? "Queue" : "Send"}">${icon("up")}${unseen(queue ? "Queue" : "Send")}</button></div>
</div>
</form>`;
}

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
    case "user": {
      const from: PromptFrom = block.from !== "person" ? block.from : block.text.startsWith("[Nexus PR watch") ? "pr-watch" : block.text.startsWith("[Nexus review") ? "review" : "person";
      const named = from !== "person" && from !== "pr-watch" && from !== "review";
      return html`<div class="msg user${block.queued !== null && " queued"}">${!named && unseen(promptLabel[from])}${(named || block.queued !== null) && html`<div class="msg-who">${named && html`<span class="chip chip-from">${promptLabel[from]}</span>`}${block.queued !== null && html`<span class="chip chip-queued">queued, ${block.queued}</span>`}</div>`}<div class="text">${prose(block.text)}</div></div>`;
    }
    case "agent": return block.streaming
      ? html`<div class="msg agent streaming"><div class="text" data-grow>${grows(prose(block.text, html`<span class="caret" aria-hidden="true"></span>`))}</div></div>`
      : html`<div class="msg agent"><div class="text">${prose(block.text)}</div></div>`;
    case "notice": return html`<p class="notice notice-${block.tone}"><span class="notice-mark" aria-hidden="true">!</span>${block.text}</p>`;
    case "note": return html`<p class="note">${block.text}</p>`;
    case "link": return html`<p class="note"><a class="link" href="${block.url}" target="_blank" rel="noopener">${block.text} ↗</a></p>`;
    case "tools": return stepsView(block.tools);
  }
}

/** A reply or prompt's markdown, with `end` after its last character, where a streaming reply's caret goes. */
function prose(text: string, end: Part = null): Html {
  return markdownView(parseMarkdown(text.split(/\r?\n/)), end);
}

/** A block of the markdown that replies and prompts are written in. A list's `start` is null for bullets. */
type Markdown =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; start: number | null; items: Markdown[][] }
  | { kind: "quote"; body: Markdown[] }
  | { kind: "rule" }
  | { kind: "para"; text: string };

const fenceLine = /^ {0,3}(`{3,})[^`]*$/;
const headingLine = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const ruleLine = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const quoteLine = /^ {0,3}> ?(.*)$/;
const itemLine = /^( *)([-*+]|(\d{1,9})[.)])[ \t]+(.*)$/;
const isBlank = (line: string) => line.trim() === "";
const indentOf = (line: string) => line.length - line.trimStart().length;
const startsBlock = (line: string) => [fenceLine, headingLine, ruleLine, quoteLine, itemLine].some((re) => re.test(line));
/** Quotes and lists nested deeper read as typed, since a reply is untrusted and each level parses and renders a call deeper. */
const maxNesting = 16;

/** Every line is kept, so a paragraph's line breaks show as they were typed. */
function parseMarkdown(lines: readonly string[], depth = 0): Markdown[] {
  if (depth === maxNesting) return lines.some((l) => !isBlank(l)) ? [{ kind: "para", text: lines.join("\n") }] : [];
  const out: Markdown[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = fenceLine.exec(line);
    const heading = headingLine.exec(line);
    const item = itemLine.exec(line);
    if (isBlank(line)) i++;
    else if (fence !== null) {
      const closes = (l: string) => /^ {0,3}`{3,}[ \t]*$/.test(l) && l.trim().length >= fence[1]!.length;
      let end = i + 1;
      while (end < lines.length && !closes(lines[end]!)) end++;
      // A fence that never closes runs to the end, as a streaming reply's open code block does.
      out.push({ kind: "code", text: lines.slice(i + 1, end).join("\n") });
      i = end + 1;
    } else if (heading !== null) {
      out.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
    } else if (ruleLine.test(line)) {
      out.push({ kind: "rule" });
      i++;
    } else if (quoteLine.test(line)) {
      const body: string[] = [];
      for (let q = quoteLine.exec(line); q !== null; q = i < lines.length ? quoteLine.exec(lines[i]!) : null) {
        body.push(q[1]!);
        i++;
      }
      out.push({ kind: "quote", body: parseMarkdown(body, depth + 1) });
    } else if (item !== null) {
      const ordered = item[3] !== undefined;
      const items: Markdown[][] = [];
      for (let m: RegExpExecArray | null = item; m !== null && (m[3] !== undefined) === ordered; m = i < lines.length ? itemLine.exec(lines[i]!) : null) {
        const own = m[1]!.length;
        const offset = m[0].length - m[4]!.length;
        const body = [m[4]!];
        for (i++; i < lines.length; i++) {
          const next = lines[i]!;
          if (isBlank(next)) {
            const after = lines.slice(i).findIndex((l) => !isBlank(l));
            if (after === -1) break;
            if (indentOf(lines[i + after]!) < offset) {
              // Blank lines between two items keep them in one list.
              if (itemLine.test(lines[i + after]!)) i += after;
              break;
            }
            body.push("");
          // An item indented past its parent's marker nests even short of the parent's text, as models often write them.
          } else if (indentOf(next) >= offset || itemLine.test(next) && indentOf(next) > own) body.push(next.slice(Math.min(indentOf(next), offset)));
          else if (!isBlank(body.at(-1)!) && !startsBlock(next)) body.push(next);
          else break;
        }
        items.push(parseMarkdown(body, depth + 1));
      }
      out.push({ kind: "list", start: ordered ? Number(item[3]) : null, items });
    } else {
      const start = i;
      do i++; while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!));
      out.push({ kind: "para", text: lines.slice(start, i).join("\n") });
    }
  }
  return out;
}

function markdownView(blocks: readonly Markdown[], end: Part): Html {
  return html`${blocks.map((block, i) => markdownBlock(block, i === blocks.length - 1 && end))}${blocks.length === 0 && end}`;
}

function markdownBlock(block: Markdown, end: Part): Html {
  switch (block.kind) {
    case "code": return html`<pre class="code">${block.text}${end}</pre>`;
    case "heading": {
      // A heading inside a message stays below the page's own.
      const tag = Math.min(block.level + 2, 6);
      return html`<h${tag} class="md-h">${inline(block.text)}${end}</h${tag}>`;
    }
    case "list": {
      const items = block.items.map((item, i) => html`<li>${markdownView(item, i === block.items.length - 1 && end)}</li>`);
      return block.start === null ? html`<ul>${items}</ul>` : html`<ol${block.start !== 1 && html` start="${block.start}"`}>${items}</ol>`;
    }
    case "quote": return html`<blockquote>${markdownView(block.body, end)}</blockquote>`;
    case "rule": return html`<hr>${end}`;
    case "para": return html`<p>${inline(block.text)}${end}</p>`;
  }
}

/**
 * Code spans, links and emphasis, by whether code spans are on. Emphasis and links take a code span whole, so no
 * marker inside one counts. A marker inside a word is text, so snake_case and 2*3*4 read as typed, and so is one
 * that a file's extension follows, so __init__.py does too.
 */
const inlinePatterns = [false, true].map((code) => {
  const any = code ? "(?:`[^`]*`|[^`])" : "[\\s\\S]";
  const label = code ? "(?:`[^`]*`|[^`\\[\\]])" : "[^\\[\\]]";
  const [stars, unders] = ["[\\p{L}\\p{N}*]", "[\\p{L}\\p{N}_]"];
  const underEnd = `(?!${unders}|\\.\\p{L})`;
  return new RegExp([
    code ? "`([^`]*)`" : "(?!)()",
    `\\[(${label}+?)\\]\\(((?:[^()\\s]|\\([^()\\s]*\\))+)\\)`,
    `\\*\\*(?![\\s*])(${any}+?)(?<![\\s*])\\*\\*`,
    `(?<!${unders})__(?![\\s_])(${any}+?)(?<![\\s_])__${underEnd}`,
    `(?<!${stars})\\*(?![\\s*])(${any}+?)(?<![\\s*])\\*(?!${stars})`,
    `(?<!${unders})_(?![\\s_])(${any}+?)(?<![\\s_])_${underEnd}`,
  ].join("|"), "gu");
});

// An odd count of backticks leaves one unmatched, so every backtick stays as written.
function inline(text: string, code = text.split("`").length % 2 === 1): Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const m of text.matchAll(inlinePatterns[Number(code)]!)) {
    const [whole, span, label, url] = m;
    const strong = m[4] ?? m[5];
    out.push(text.slice(at, m.index),
      span !== undefined ? html`<code>${span}</code>`
      : url !== undefined ? /^https?:\/\//i.test(url) ? html`<a class="link" href="${url}" target="_blank" rel="noopener noreferrer">${inline(label!, code)}</a>` : whole
      : strong !== undefined ? html`<strong>${inline(strong, code)}</strong>`
      : html`<em>${inline((m[6] ?? m[7])!, code)}</em>`);
    at = m.index + whole.length;
  }
  out.push(text.slice(at));
  return out;
}

type DiffLine = readonly ["+" | "-", string];
type Args = ToolItem["call"]["arguments"];
/** What a call changes, and the arguments that hold it. */
type Diff = { keys: readonly string[]; lines: DiffLine[] };
const linesOf = (sign: "+" | "-", text: string) => text.split("\n").map((line): DiffLine => [sign, line]);
const replaced = (old: string, now: string) => [...linesOf("-", old), ...linesOf("+", now)];
/** A list of edits under `edits`, each a pair of strings under these keys, as pi's edit and Claude Code's MultiEdit take. */
const editsDiff = (oldKey: string, newKey: string) => ({ edits }: Args): Diff | null => {
  const pairs = Array.isArray(edits) ? edits.flatMap((e: Record<string, unknown> | null) => typeof e?.[oldKey] === "string" && typeof e[newKey] === "string" ? [[e[oldKey], e[newKey]] as const] : []) : [];
  return pairs.length === 0 || pairs.length !== (edits as unknown[]).length ? null : { keys: ["edits"], lines: pairs.flatMap(([old, now]) => replaced(old, now)) };
};
const contentDiff = ({ content }: Args): Diff | null => typeof content === "string" ? { keys: ["content"], lines: linesOf("+", content.replace(/\n$/, "")) } : null;
const stringDiff = ({ old_string: old, new_string: now }: Args): Diff | null => typeof old === "string" && typeof now === "string" ? { keys: ["old_string", "new_string"], lines: replaced(old, now) } : null;

/**
 * How a fold says what calls did, by what they do rather than which tool did them, so an edit and a write are both
 * a change. A fold says its weightiest actions first: commands, changes and subagents, then reads and searches, then
 * tools it does not know.
 */
// After t3code's summarizeToolGroup. Copyright (c) 2026 T3 Tools Inc., MIT licence; see THIRD_PARTY_NOTICES.md.
type Action = "command" | "change" | "subagent" | "read" | "search" | "web" | "fetch" | "todo";
interface Phrase { priority: number; one: string; many: (n: number) => string }
const actions: Record<Action, Phrase> = {
  command: { priority: 0, one: "ran a command", many: (n) => `ran ${n} commands` },
  change: { priority: 0, one: "changed a file", many: (n) => `changed ${n} files` },
  subagent: { priority: 0, one: "ran a subagent", many: (n) => `ran ${n} subagents` },
  read: { priority: 1, one: "read a file", many: (n) => `read ${n} files` },
  search: { priority: 1, one: "searched the code", many: (n) => `searched the code ${n} times` },
  web: { priority: 1, one: "searched the web", many: (n) => `searched the web ${n} times` },
  fetch: { priority: 1, one: "fetched a page", many: (n) => `fetched ${n} pages` },
  todo: { priority: 1, one: "updated the to-do list", many: (n) => `updated the to-do list ${n} times` },
};
const unknownTool = (name: string): Phrase => ({ priority: 2, one: `used ${name}`, many: (n) => `used ${name} ${n} times` });

/**
 * How a tool's calls read, by its name, pi's in lower case and Claude Code's capitalized: the argument that says what
 * a call did, shown in its row, one shown whole as text, what it changes, the argument naming the file it acts on,
 * so a fold counts a file once, and the action a fold counts it under.
 */
interface ToolLook {
  subject?: string;
  text?: string;
  diff?: (args: Args) => Diff | null;
  file?: string;
  action?: Action;
}
const toolLooks: Readonly<Record<string, ToolLook>> = {
  read: { subject: "path", file: "path", action: "read" },
  bash: { subject: "command", action: "command" },
  edit: { subject: "path", file: "path", diff: editsDiff("oldText", "newText"), action: "change" },
  write: { subject: "path", file: "path", diff: contentDiff, action: "change" },
  grep: { subject: "pattern", action: "search" },
  find: { subject: "pattern", action: "search" },
  ls: { subject: "path", action: "search" },
  Read: { subject: "file_path", file: "file_path", action: "read" },
  Bash: { subject: "command", action: "command" },
  Edit: { subject: "file_path", file: "file_path", diff: stringDiff, action: "change" },
  MultiEdit: { subject: "file_path", file: "file_path", diff: editsDiff("old_string", "new_string"), action: "change" },
  Write: { subject: "file_path", file: "file_path", diff: contentDiff, action: "change" },
  Grep: { subject: "pattern", action: "search" },
  Glob: { subject: "pattern", action: "search" },
  Agent: { subject: "description", text: "prompt", action: "subagent" },
  WebFetch: { subject: "url", action: "fetch" },
  WebSearch: { subject: "query", action: "web" },
  TodoWrite: { action: "todo" },
  shell: { subject: "command", action: "command" },
};
/** The arguments that say what a call of a tool without a look did, the first one it has. */
const subjectKeys = ["command", "pattern", "path", "url"];
const lookOfTool = (name: string): ToolLook => Object.hasOwn(toolLooks, name) ? toolLooks[name]! : {};
const textArg = (args: Args, key: string | undefined) => key !== undefined && typeof args[key] === "string" ? { key, value: args[key] as string } : undefined;
const subjectOf = (call: ToolItem["call"]) => {
  const { subject } = lookOfTool(call.name);
  return textArg(call.arguments, subject ?? subjectKeys.find((k) => typeof call.arguments[k] === "string"));
};

const failed = ({ result }: ToolItem) => result.state === "done" && result.isError;
/** pi's bash tool ends a failed command's output with its exit code, and Claude Code's starts with it. */
const exitCode = (output: string) => /exited with code (\d+)|^Exit code (\d+)/.exec(output)?.slice(1).find((code) => code !== undefined);

function toolView(tool: ToolItem): Html {
  const { call, result, task } = tool;
  const look = lookOfTool(call.name);
  const subject = subjectOf(call);
  const text = textArg(call.arguments, look.text);
  const diff = look.diff?.(call.arguments) ?? null;
  const rest = Object.fromEntries(Object.entries(call.arguments).filter(([key]) => key !== subject?.key && key !== text?.key && !diff?.keys.includes(key)));
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
${text !== undefined && html`<div class="t-text">${prose(text.value)}</div>`}
${Object.keys(rest).length > 0 && html`<pre class="t-args">${JSON.stringify(rest, null, 2)}</pre>`}
${diff !== null && html`<pre class="t-out diff">${diff.lines.map(([sign, line]) => html`<span class="d d-${sign === "+" ? "add" : "del"}">${sign === "+" ? "+" : "−"} ${line}</span>`)}</pre>`}
${(diff === null || bad) && (output === "" ? html`<p class="t-empty">${running ? "No output yet." : "No output."}</p>` : html`<pre class="t-out"${running && " data-grow"}>${grow(output)}</pre>`)}
${task !== undefined && html`<p class="t-task">Background task ${task.status}: ${task.summary}</p>${task.result !== null && html`<div class="t-text">${prose(task.result)}</div>`}`}
</details>`;
}

/** How many actions a fold names before it counts the tools of the rest. */
const phrasesShown = 3;

/**
 * What a run of calls did: Ran 3 commands, changed 2 files. Calls on the same path count once, so an edit and a
 * write to one file are one changed file. Each tool without a look is its own action, named as it is.
 */
function stepsSummary(tools: readonly ToolItem[]): string {
  const done = new Map<string, { phrase: Phrase; seen: Set<string>; names: Set<string> }>();
  for (const { call } of tools) {
    const look = lookOfTool(call.name);
    const key = look.action === undefined ? `tool ${call.name}` : look.action;
    const action = done.get(key) ?? { phrase: look.action === undefined ? unknownTool(call.name) : actions[look.action], seen: new Set(), names: new Set() };
    action.seen.add(textArg(call.arguments, look.file)?.value ?? call.id);
    action.names.add(call.name);
    done.set(key, action);
  }
  // The sort is stable, so actions of one priority keep the order they first appear in.
  const ranked = [...done.values()].sort((a, b) => a.phrase.priority - b.phrase.priority);
  const others = new Set(ranked.slice(phrasesShown).flatMap((a) => [...a.names])).size;
  const said = [
    ...ranked.slice(0, phrasesShown).map(({ phrase, seen }) => seen.size === 1 ? phrase.one : phrase.many(seen.size)),
    ...others === 0 ? [] : [others === 1 ? "used another tool" : `used ${others} other tools`],
  ].join(", ");
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/**
 * Every run of calls folds into one line, so a busy turn does not bury the answer around it. The fold opens
 * itself when a call failed or is still running, which is when the reader needs to see it.
 */
function stepsView(tools: readonly ToolItem[]): Html {
  const bad = tools.filter(failed).length;
  const running = tools.filter((t) => t.result.state === "running").length;
  return html`<details class="steps${bad > 0 && " has-bad"}" id="steps-${tools[0]!.call.id}"${(bad > 0 || running > 0) && " open"}>
<summary><span class="s-names">${stepsSummary(tools)}</span>${bad > 0 && html`<span class="s-bad">${bad} failed</span>`}${running > 0 && html`<span class="s-run"><span class="spin" aria-hidden="true"></span>${running} running</span>`}<span class="chev" aria-hidden="true">›</span></summary>
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
