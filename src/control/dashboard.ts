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
import { posix } from "node:path";
import type { AssistantMessage, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, InboxState, LiveState } from "@earendil-works/pi-durable";
import { desiredPhase, type ActualState, type DesiredPhase } from "../reconcile.ts";
import { countedCapacity, type HerdrStatus, type NodeHealth, type NodeName } from "../protocol.ts";
import { githubTokenGrant, linkedPort, type Project, type ProjectId } from "../project.ts";
import { checkoutDir, harnessNamed } from "../sessions.ts";
import type { ThreadDetail, ThreadRow } from "./api.ts";
import { attentions, needsPerson, type Attention } from "./attention.ts";
import type { NodeRecord, Output, Preview, Registry, Thread, ThreadAgent, ThreadId } from "./registry.ts";
import { agentView, type AgentView } from "./thread-agent.ts";
import type { TailnetNodeId } from "../protocol.ts";
import { usageLimitText, type ClaudeConversation, type ClaudeEntry, type PromptSource, type TranscriptImage } from "../claude-transcript.ts";
import { queuedOf } from "./claude-conversation.ts";
import { blocks as blocking, cancellable, findingsOf, landable, liveNote, phaseNote, pushedHead, roundNote, roundsSpent, type Review } from "./review.ts";
import { heldBy, holdRule, reservedNames } from "./policy.ts";
import { askedIn, askQuestionId, type AnswerRefusal, type AskedQuestion, type Question } from "./questions.ts";
import { gib, nodePylons, overcommitted } from "./placement.ts";
import { itemView, type ItemPhase, type PipelineItem } from "./pipeline.ts";
import { queuedView, type QueuedThread, type Wait } from "./queue.ts";
import { breakdownLook, breakdowns, periods, periodStart, tokenColumns, tokenCount, type Period, type UsageBackfill, type UsageTotals } from "./usage.ts";

export interface DashboardOptions {
  registry: Registry;
  /** The API's thread detail, so the dashboard derives the actual state exactly as the API does. */
  detail(thread: Thread): ThreadDetail;
  /** The API's thread row, which is all a thread's line in the sidebar or the home table shows. */
  row(thread: Thread): ThreadRow;
  /** The API's conversation view, a Claude worker's transcript, or null for a thread with no agent. */
  conversation(thread: Thread): Promise<AgentView | null>;
  /** Why the land route would refuse the caller, or null when it would take the request. */
  landRefusal(caller: TailnetNodeId): LandRefusal | null;
  /** Why the answer route would refuse the caller's answer to the question, or null when it would take it. */
  answerRefusal(caller: TailnetNodeId, question: Question): AnswerRefusal | null;
  /** Whether the review's pull request deploys once it merges. */
  deploys(review: Review): boolean;
  /** The API's read of a node's health, which refuses a caller that is not a deployer. */
  nodeHealth(caller: TailnetNodeId, node: NodeName): Promise<NodeHealth>;
  now?: () => number;
}

export interface Page { status: number; headers: Record<string, string>; body: string }

/** How often the client refetches a page. The loop ticks every 5 s, so polling faster shows nothing new. */
export const pollMs = 5_000;

export type LandRefusal = "no review loop" | "not a deployer";

/** What every part of a page reads. */
interface Context {
  registry: Registry; row: DashboardOptions["row"]; deploys: DashboardOptions["deploys"]; now: number; caller: TailnetNodeId; landRefusal: LandRefusal | null;
  answerRefusal(question: Question): AnswerRefusal | null;
  /** What waits on the person, which the sidebar counts and the home page lists. */
  needs(): readonly Need[];
}

/** Returns the page for a GET of `path`, or undefined when the path is not the dashboard's. */
export function dashboard(options: DashboardOptions): (path: string, query: URLSearchParams, caller: TailnetNodeId) => Promise<Page | undefined> {
  const { registry, detail, deploys } = options;

  /** A failed read shows in the conversation, so the rest of the page still says what the pylon is doing. */
  async function transcript(t: Thread): Promise<AgentView | Error | null> {
    if (t.status === "deleted") return null;
    return options.conversation(t).catch((err: unknown) => err as Error);
  }

  const pages: readonly [RegExp, (m: RegExpExecArray, query: URLSearchParams, context: () => Context) => Page | Promise<Page>][] = [
    [/^\/$/, (_, __, context) => ok(home(context(), {}))],
    [/^\/threads\/new$/, (_, query, context) => ok(home(context(), { start: { project: query.get("project") } }))],
    [/^\/projects\/new$/, (_, __, context) => ok(home(context(), { addProject: true }))],
    [/^\/usage$/, (_, query, context) => {
      const period = query.get("period") ?? "";
      return ok(usagePage(context(), Object.hasOwn(periods, period) ? period as Period : "7d", (query.get("project") || null) as ProjectId | null));
    }],
    [/^\/pipeline$/, (_, __, context) => ok(pipelinePage(context()))],
    [/^\/threads\/([^/]+)$/, async (m, query, context) => {
      const thread = registry.thread(m[1]! as ThreadId);
      if (thread === undefined) {
        const queued = registry.queuedThread(m[1]! as ThreadId);
        if (queued !== undefined && queued.status !== "started") return ok(queuedPage(context(), queuedView(registry, queued)));
        return { ...ok(notFound(context(), `No thread ${m[1]!}.`)), status: 404 };
      }
      // The reply known before this read is a safe watermark even if another turn ends during it. A Claude worker's
      // transcript is as of its last read that reached its end, which holds the reply only if it started after the
      // reply was recorded.
      const view = await transcript(thread);
      const repliedAt = view !== null && !(view instanceof Error) && view.kind === "claude" && (view.view.readAt ?? 0) < (thread.lastReplyAt ?? 0) ? null : thread.lastReplyAt;
      // After the read, so the facts are no older than the conversation, and a thread deleted meanwhile shows none.
      const d = detail(registry.thread(thread.id)!);
      return ok(threadPage(context(), d, registry.node(d.pylon.node)!, d.thread.status === "deleted" ? null : view, repliedAt, query.has("streaming")));
    }],
    [/^\/nodes\/([^/]+)$/, async (m, _, context) => {
      const c = context();
      const name = m[1]! as NodeName;
      if (c.registry.node(name) === undefined) return { ...ok(notFound(c, `No node ${name}.`)), status: 404 };
      return ok(nodePage(c, name, await options.nodeHealth(c.caller, name).catch((err: unknown) => err as Error)));
    }],
    [/^\/assets\/([\w.-]+)$/, (m, query, context) => {
      const asset = assets.get(m[1]!);
      if (asset === undefined) return { ...ok(notFound(context(), `No asset ${m[1]!}.`)), status: 404 };
      // Pages link each asset with its hash, and a chunk's name has its hash, so neither URL ever changes and the
      // phone keeps it.
      const cache = asset.version === null || query.get("v") === asset.version ? "public, max-age=31536000, immutable" : "no-cache";
      return { status: 200, headers: { "content-type": asset.type, "cache-control": cache, "x-content-type-options": "nosniff" }, body: asset.body };
    }],
  ];

  return async (path, query, caller) => {
    const context = (): Context => {
      // The sidebar and the home table show the same threads.
      const rows = new Map<ThreadId, ThreadRow>();
      const row = (t: Thread) => rows.get(t.id) ?? rows.set(t.id, options.row(t)).get(t.id)!;
      let needs: readonly Need[] | undefined;
      const c: Context = { registry, row, deploys, now: (options.now ?? Date.now)(), caller, landRefusal: options.landRefusal(caller),
        answerRefusal: (question) => options.answerRefusal(caller, question), needs: () => needs ??= needsOf(c, detail) };
      return c;
    };
    for (const [pattern, page] of pages) {
      const m = pattern.exec(path);
      if (m !== null) return page(m, query, context);
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

/** The themes the sidebar's picker offers. Each but System is a block of style.css, and System is the device's light or dark. */
export const themes = [["system", "System"], ["light", "Light"], ["dark", "Dark"], ["tokyo-night", "Tokyo Night"], ["catppuccin-mocha", "Catppuccin Mocha"], ["kanagawa-wave", "Kanagawa Wave"]] as const;
/**
 * Sets the stored theme, or the device's light or dark, before the first paint, as theme.js does after it. A browser
 * that refuses the page its storage throws on reading it, and the device's theme stands.
 */
const themeScript = `{ let theme = null; try { theme = localStorage.getItem("nexus.theme"); } catch {} document.documentElement.dataset.theme = theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }`;

const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src 'self'; script-src 'self' 'sha256-${createHash("sha256").update(themeScript).digest("base64")}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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
const desiredTone: Record<DesiredPhase, Tone> = { running: "ok", reading: "work", paused: "idle", deleted: "muted" };
const sessionTone: Record<HerdrStatus, Tone> = { working: "work", idle: "idle", blocked: "bad", done: "ok", unknown: "muted" };
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
  palette: "M8 2.5a5.5 5.5 0 0 0 0 11c.8 0 1.2-.5 1.2-1.1 0-.7-.5-1-.5-1.6 0-.6.5-1 1.1-1h1.4a2.3 2.3 0 0 0 2.3-2.3C13.5 4.6 11.1 2.5 8 2.5zM5 8h.01M6.5 5.2h.01M9.7 5.2h.01",
  contrast: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM8 2.5v11",
  up: "M8 13V3M4 7l4-4 4 4",
  chart: "M3 13.5h10M4.5 11V8M8 11V3.5M11.5 11V6",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  terminal: "M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5",
  check: "M3.5 8.5l3 3 6-7",
  cross: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  dash: "M5 8h6",
  inbox: "M2.5 9.5h3l1 1.5h3l1-1.5h3M2.5 9.5 4.3 4.2a1 1 0 0 1 .9-.7h5.6a1 1 0 0 1 .9.7l1.8 5.3v2.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
} as const;
type IconName = keyof typeof iconPaths;
const icon = (name: IconName) => html`<svg class="i i-${name}" viewBox="0 0 16 16" aria-hidden="true"><path d="${iconPaths[name]}"/></svg>`;
/** Every page's way to the sidebar, and on a phone, where the sidebar is a drawer, to what waits on the person. */
const menu = html`<button type="button" class="icon-btn menu" data-open="side" aria-label="Threads">☰</button><a class="icon-btn phone-only" href="/#needs-you" aria-label="Needs you" title="Needs you">${icon("inbox")}</a>`;
/** Text a screen reader says that the page shows another way, such as with an icon or a bubble's side. */
const unseen = (text: string) => html`<span class="vh">${text}</span>`;

/** What a thread is doing, most urgent first: the agent mid-turn hides a running pylon, never a failed one. */
function threadState(t: ThreadRow): [label: string, tone: Tone] {
  const { attention, pylon } = t;
  if (attention === "limited") return [usageLimitText(t.usageLimit ?? { resetsAt: null }, Date.now()), attentions.limited.tone];
  if (attention === "waiting") return [t.sessionWaitingMessage ?? attentions.waiting.label, attentions.waiting.tone];
  if (attention !== null) return [attentions[attention].label, attentions[attention].tone];
  if (t.status === "archived" || t.status === "deleted") return [t.status, "muted"];
  return actualBadge[pylon.actualState];
}

/** The open thread's row never dims, nor a closed thread's, which its fold already sets apart. */
const dims = (t: ThreadRow, active?: ThreadId) =>
  t.id !== active && (t.status === "active" || t.status === "idle") && !needsPerson(t.attention);

/** "5 min", or null under 45 seconds. */
function span(at: number, now: number): string | null {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 45 ? null
    : seconds < 45 * 60 ? `${Math.round(seconds / 60)} min`
    : seconds < 36 * 3600 ? `${Math.round(seconds / 3600)} h`
    : `${Math.round(seconds / 86_400)} d`;
}

/** "5 min ago", which client.js ticks with the same format. */
function ago(at: number, now: number): Html {
  if (at === 0) return html`never`;
  const iso = new Date(at).toISOString();
  const label = span(at, now);
  return html`<time datetime="${iso}" title="${iso}" data-ago>${label === null ? "just now" : `${label} ago`}</time>`;
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
  if (!t.working) return null;
  return t.workingSince === undefined ? html`working` : html`working <time data-since="${t.workingSince}">${clock(now - t.workingSince)}</time>`;
}

interface Shell {
  title: string;
  /** The thread the sidebar marks as open. */
  active?: ThreadId;
  /** The sidebar's link to mark as the open page. */
  nav?: "usage" | "pipeline";
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
<script>${new Html(themeScript)}</script>
<link rel="icon" href="${assetUrl("favicon.svg")}" type="image/svg+xml">
<link rel="stylesheet" href="${assetUrl("style.css")}">
<script type="module" src="${assetUrl("client.js")}"></script>
</head>
<body>
<div class="app${page.inspector !== undefined && " has-inspect"}">
${sidebar(c, page.active, page.nav)}
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
/** A project's threads that wait in the queue, in the order they were queued. */
const queuedThreadsOf = (c: Context, project: string) =>
  c.registry.queuedThreads().filter((q) => q.project === project && q.status === "queued").map((q) => queuedView(c.registry, q));
/** A blocked thread waits for the person, as a review that ended for them does. */
function queuedLook(q: QueuedThread): [label: string, tone: Tone] {
  if (q.status !== "queued") return [q.status === "archived" ? "cancelled" : "deleted", "muted"];
  return q.blocked ? ["blocked", "bad"] : ["queued", "idle"];
}
const waitTone: Record<Wait["state"], Tone> = { waiting: "idle", landed: "ok", blocked: "bad" };
const predecessor = (c: Context, id: ThreadId) => c.registry.thread(id)?.title ?? c.registry.queuedThread(id)?.title ?? id;
const lastActive = (t: Thread) => Math.max(t.createdAt, t.lastHumanActivityAt, t.lastAgentActivityAt);
function closedLabel(threads: readonly Thread[]): string {
  const deleted = threads.filter((t) => t.status === "deleted").length;
  const archived = threads.length - deleted;
  return [archived > 0 && `${archived} archived`, deleted > 0 && `${deleted} deleted`].filter(Boolean).join(", ");
}

function sidebar(c: Context, active: ThreadId | undefined, nav: Shell["nav"]): Html {
  const projects = c.registry.projects();
  // A thread works in its own checkout, as a Jetline workspace does, so its row shows a branch with its state as a badge.
  const row = (t: Thread) => {
    const r = c.row(t);
    const [label, tone] = threadState(r);
    return html`<li><a class="row${t.id === active && " active"}${dims(r, active) && " dim"}" href="/threads/${t.id}"${t.id === active && html` aria-current="page"`}><span class="row-icon">${icon("branch")}${dot(tone, label)}</span><span class="row-title">${t.title}</span><span class="row-at">${workingFor(t, c.now) ?? span(lastActive(t), c.now) ?? "now"}</span></a></li>`;
  };
  // A queued thread has no time of its own to show until it starts, so its row says what it is instead.
  const queuedRow = (q: QueuedThread) => {
    const [label, tone] = queuedLook(q);
    return html`<li><a class="row${q.id === active && " active"}" href="/threads/${q.id}"${q.id === active && html` aria-current="page"`}><span class="row-icon">${icon("branch")}${dot(tone, label)}</span><span class="row-title">${q.title}</span><span class="row-at">${label}</span></a></li>`;
  };
  return html`<aside class="side" aria-label="Threads">
<div class="side-head"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">◆</span>nexus</a><a class="btn btn-new" href="/threads/new" data-start>New thread<kbd>N</kbd></a></div>
<label class="filter"><span aria-hidden="true">⌕</span><input id="filter" type="search" placeholder="Filter threads" aria-label="Filter threads" autocomplete="off"></label>
<nav class="side-nav" aria-label="Pages"><a class="side-link" href="/#needs-you">${icon("inbox")}Needs you<span class="side-count" id="needs-count" data-live>${c.needs().length || ""}</span></a>${([["pipeline", "Pipeline", "list"], ["usage", "Usage", "chart"]] as const).map(([to, label, glyph]) => html`<a class="side-link${nav === to && " active"}" href="/${to}"${nav === to && html` aria-current="page"`}>${icon(glyph)}${label}</a>`)}</nav>
<nav class="groups" id="side-threads" data-live aria-label="Threads by project">
${projects.length === 0 ? html`<p class="empty side-empty">No projects yet.</p>` : projects.map((p) => {
  const { open, closed } = threadsOf(c, p.id);
  const queued = queuedThreadsOf(c, p.id);
  // A project folds like a folder. client.js remembers which ones the reader folded.
  return html`<details class="group" id="group-${p.id}" open>
<summary class="group-h">${icon("chevron")}${icon("folder")}<span class="group-name"><span>${p.id}</span><span class="group-branch">${p.defaultBranch}</span></span></summary>
<a class="group-new" href="/threads/new?project=${encodeURIComponent(p.id)}" data-start="${p.id}" aria-label="New thread in ${p.id}" title="New thread in ${p.id}">${icon("plus")}</a>
${open.length + queued.length > 0 && html`<ul>${open.map(row)}${queued.map(queuedRow)}</ul>`}
${closed.length > 0 && html`<details class="archived" id="archived-${p.id}"${closed.some((t) => t.id === active) && " open"}><summary>${closedLabel(closed)}</summary><ul>${closed.map(row)}</ul></details>`}
</details>`;
})}
</nav>
<div class="nodes" id="side-nodes" data-live aria-label="Nodes"><h2>Nodes</h2><small>Desired release: ${c.registry.desiredRelease()?.commit.slice(0, 12) ?? "manual"}</small>${c.registry.nodes().map((n) => html`<span>${icon("server")}<a class="link" href="/nodes/${encodeURIComponent(n.name)}" title="Health of ${n.name}">${n.name}</a>${dot(n.state === "online" ? "ok" : "muted")}${n.state === "offline" && html`<em>offline</em>`}${overcommitted(n.capacity) && html`<em>overcommitted</em>`}</span>${memoryLine(c, n)}${c.registry.releaseReports().filter((r) => r.node === n.name).map((r) => html`<small title="${r.reason ?? ""}">${r.role}: ${r.commit?.slice(0, 12) ?? "unknown"} · ${c.now - r.observedAt >= 90_000 ? "stale" : r.state}</small>`)}`)}</div>
<div class="side-theme"><label class="theme-pick" title="Theme">${icon("palette")}<span class="vh">Theme</span><select id="theme">${themes.map(([name, label]) => html`<option value="${name}">${label}</option>`)}</select></label><button type="button" class="icon-btn" id="theme-toggle" aria-label="Switch between light and dark" title="Switch between light and dark">${icon("contrast")}</button></div>
<a class="btn side-add" href="/projects/new" data-new-project>New project</a>
</aside>`;
}

/** A node's committed and total memory, and what its paused pylons need to wake. */
function memoryLine(c: Context, n: NodeRecord): Html | false {
  const capacity = countedCapacity(n.capacity);
  if (capacity === null) return false;
  const paused = nodePylons(c.registry, n)?.paused.memoryGiB ?? 0;
  return html`<small>${gib(capacity.committedMemoryGiB)}/${gib(capacity.memoryGiB)} GiB memory${paused > 0 && ` · ${gib(paused)} GiB to wake paused`}</small>`;
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
<div id="start-harness-fields" hidden>
<label class="check"><input type="checkbox" id="start-planning" name="planning" value="true" disabled> Planning thread</label>
<p class="hint">It plans with you and proposes items. Each becomes a card here that you accept into the pipeline or reject, as <code>nexus start --plan</code> does.</p>
</div>
<label for="start-title" id="start-title-label">Title (optional)</label>
<input id="start-title" name="title" autocomplete="off" placeholder="The prompt's first line">
<fieldset class="seg"><legend>Project</legend>
${projects.map((p) => html`<label class="seg-opt"><input type="radio" name="project" required value="${p.id}" data-node="${p.defaultNode}" data-branch="${p.defaultBranch}" data-cpus="${p.resources.cpus}" data-memory-gib="${p.resources.memoryGiB}" data-disk-gib="${p.resources.diskGiB}"${p.repoUrl === null && " data-scratch"}${p === chosen && " checked"}><span class="seg-name">${p.id}</span><span class="seg-repo">${p.repoUrl ?? "scratch"}</span></label>`)}
</fieldset>
<div class="two">
<div><label for="start-node">Node</label><select id="start-node" name="node">
<option value="">${chosen.defaultNode} (project default)</option>
<option value="auto">auto, where it fits best</option>
${nodes.map((n) => html`<option value="${n.name}">${n.name}${n.state === "offline" && ", offline"}</option>`)}
</select></div>
<div><label for="start-branch">Branch</label><input id="start-branch" name="branch" autocomplete="off" placeholder="${chosen.defaultBranch}"></div>
</div>
<div class="two three">
<div><label for="start-cpus">CPUs</label><input id="start-cpus" name="cpus" type="number" min="1" step="1" inputmode="numeric" placeholder="${chosen.resources.cpus}"></div>
<div><label for="start-memory">Memory (GiB)</label><input id="start-memory" name="memoryGiB" type="number" min="1" step="1" inputmode="numeric" placeholder="${chosen.resources.memoryGiB}"></div>
<div><label for="start-disk">Disk (GiB)</label><input id="start-disk" name="diskGiB" type="number" min="1" step="1" inputmode="numeric" placeholder="${chosen.resources.diskGiB}"></div>
</div>
<p class="hint" id="start-hint" data-image="${image ?? ""}">Boots a pylon on ${chosen.defaultNode === "auto" ? "the node with the most room left" : html`<b>${chosen.defaultNode}</b>`}${image !== null && html` from image <code>${image}</code>`} and ${chosen.repoUrl === null ? "starts an empty repository on" : "checks out"} <code>${chosen.defaultBranch}</code>.</p>
<p id="start-error" class="error" role="alert" hidden></p>
<footer><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Start thread<kbd>⌘↵</kbd></button></footer>
</form>`}
</div>
</dialog>`;
}

const newProjectButton = html`<a class="btn btn-primary" href="/projects/new" data-new-project>New project</a>`;

/** What a new project gets beyond the dialog's fields, the same as `nexus project add` without its flags. */
const newProjectResources = { cpus: 2, memoryGiB: 6, diskGiB: 10 };

/**
 * The fields `nexus project add` asks for. The node is `auto` unless changed to one of the known nodes, as `nexus
 * project add` without --node, and the API's own checks, such as for an ID that exists, answer in the dialog. GitHub
 * access is the one secret grant the dialog offers, githubTokenGrant, which the form carries for client.js to send.
 * Nodes come from the control plane's config and change only with a restart, so the dialog is not refreshed with the page.
 */
function projectDialog(c: Context, open: boolean): Html {
  const nodes = c.registry.nodes();
  const { cpus, memoryGiB, diskGiB } = newProjectResources;
  return html`<dialog id="project-dialog" class="modal" aria-labelledby="project-h"${open && " data-autoopen"}>
<header><h2 id="project-h">New project</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
${nodes.length === 0 ? html`<p class="empty modal-empty">No nodes yet, so a project has nowhere to run.</p>` : html`<form id="project" class="form" data-resources="${JSON.stringify(newProjectResources)}" data-github-grant="${JSON.stringify(githubTokenGrant)}">
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
<option value="auto" selected>auto, where it fits best</option>
${nodes.map((n) => html`<option value="${n.name}">${n.name}${n.state === "offline" && ", offline"}</option>`)}
</select></div>
<div><label for="project-branch">Branch</label><input id="project-branch" name="defaultBranch" required autocomplete="off" autocapitalize="off" spellcheck="false" value="main"></div>
</div>
<label class="check"><input type="checkbox" name="github"> GitHub access</label>
<p class="hint">Threads clone the repository at this branch, or in a scratch project start an empty repository on it, and boot on this node unless they pick another. With auto, each boots on the node with the most room left among those that hold the image and the project's secrets. A scratch pylon keeps nothing once its thread is deleted, so its agent publishes what is worth keeping. GitHub access sends the node's <code>${githubTokenGrant.name}</code> to ${githubTokenGrant.hosts.join(" and ")}, so agents can create repositories and push. Each pylon gets ${cpus} CPUs, ${memoryGiB} GiB of memory and ${diskGiB} GiB of disk. <code>nexus project add</code> can set those, allowed hosts, logins and other secrets.</p>
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
  const r = c.row(t);
  const desired = desiredPhase(t, c.now);
  const [label, tone] = threadState(r);
  return html`<tr${dims(r) && html` class="dim"`}>
<td><span class="ov-title">${dot(tone, label)}<a href="/threads/${t.id}">${t.title}</a>${t.status !== "active" && html`<span class="tag">${t.status}</span>`}</span></td>
<td class="wide">${state(desired, desiredTone[desired])}</td>
<td>${state(...actualBadge[r.pylon.actualState])}</td>
<td class="wide">${r.pylon.node}${nodes.get(r.pylon.node)!.state === "offline" && html` <span class="tag">offline</span>`}</td>
<td class="wide">${ago(t.lastHumanActivityAt, c.now)}</td>
<td class="wide">${workingFor(t, c.now) ?? ago(t.lastAgentActivityAt, c.now)}</td>
</tr>`;
})}</tbody>
</table>`;
  return layout(c, {
    title: dialogs.start !== undefined ? "Start a thread" : dialogs.addProject === true ? "New project" : "Threads",
    ...dialogs,
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Threads</h1></div><div class="bar-end"><a class="btn btn-ghost" href="/projects/new" data-new-project>New project</a><a class="btn btn-new phone-only" href="/threads/new" data-start>New thread</a></div></header>
<div class="scroll"><div class="page page-needs"><p id="action-error" class="error" role="alert" hidden></p><section class="needs" id="needs-you" aria-labelledby="needs-h" data-live>${needsList(c)}</section></div>
<div class="page" id="overview" data-live>
${projects.length === 0 ? html`<div class="first-project"><p class="empty">No projects yet. A project names the repository its threads clone and the node they run on.</p>${newProjectButton}</div>` : projects.map((p) => {
  const { open, closed } = threadsOf(c, p.id);
  const queued = queuedThreadsOf(c, p.id);
  return html`<section aria-labelledby="project-${p.id}">
<div class="ov-head"><h2 id="project-${p.id}">${p.id}</h2><code class="dim">${p.repoUrl ?? "scratch, no remote"}</code><a class="btn btn-xs" href="/threads/new?project=${encodeURIComponent(p.id)}" data-start="${p.id}">New thread</a></div>
${open.length === 0 ? html`<p class="empty">No open threads.</p>` : table(open)}
${queued.length > 0 && html`<h3 class="ov-sub">Queued</h3><table class="ov ov-queued">
<thead><tr><th>Thread</th><th>Waits for</th><th class="wide">Node</th></tr></thead>
<tbody>${queued.map((q) => {
  const [label, tone] = queuedLook(q);
  return html`<tr>
<td><span class="ov-title">${dot(tone, label)}<a href="/threads/${q.id}">${q.title}</a><span class="tag">${label}</span></span></td>
<td>${q.waits.map((w) => html`<span class="ov-wait">${predecessor(c, w.thread)}: ${w.why}</span>`)}</td>
<td class="wide">${q.node}</td>
</tr>`;
})}</tbody>
</table>`}
${closed.length > 0 && html`<details class="ov-closed" id="closed-${p.id}"><summary>${closedLabel(closed)}</summary>${table(closed)}</details>`}
</section>`;
})}
</div></div>`,
  });
}

/**
 * One thing that waits on the person, for a card in the inbox: a review they can land, a question of the thread's, or
 * the thread itself, stopped where only they move it. `since` is when it began to wait, so far as the records say.
 */
type Need =
  | { kind: "land"; d: ThreadDetail; since: number }
  | { kind: "question"; d: ThreadDetail; question: Question; since: number }
  | { kind: "thread"; d: ThreadDetail; attention: Exclude<Attention, "reply" | "working" | null>; since: number };

/**
 * What waits on the person in the open threads, oldest first, so each card keeps its place while the person works down
 * the list and the one that has waited longest is first. A thread whose attention needs the person gets a card for it
 * unless its review or questions are already the decision. A new reply does not wait on the person, so it has none, but
 * it outranks a dialog in the terminal, which the session's own state says waits.
 */
function needsOf(c: Pick<Context, "registry" | "row">, detail: DashboardOptions["detail"]): Need[] {
  return c.registry.threads().filter((t) => t.status === "active" || t.status === "idle").flatMap((t): Need[] => {
    const { attention } = c.row(t);
    const review = c.registry.review(t.id);
    const holds = review !== null && review.phase.kind === "approved" && heldBy(review).length > 0;
    if (!holds && t.sessionWaiting !== true && (attention === "reply" || !needsPerson(attention))) return [];
    const d = detail(t);
    const needs: Need[] = [
      ...landOffered(d) && (d.review!.phase.kind === "needs-person" || holds) ? [{ kind: "land" as const, d, since: heldSince(c.registry, d.review!) }] : [],
      ...(d.questions ?? []).filter((q) => q.answer === null).map((question) => ({ kind: "question" as const, d, question, since: question.askedAt })),
    ];
    const stuck = attention === "failed" || attention === "parked" || attention === "limited" ? attention
      : attention === "decision" ? (needs.length === 0 ? "decision" : null)
      : t.sessionWaiting === true ? "waiting" : null;
    const since = t.usageLimit?.stoppedAt ?? (stuck === "decision" && d.review?.phase.kind === "needs-person" ? heldSince(c.registry, d.review) : Math.max(t.createdAt, t.lastAgentActivityAt));
    if (stuck !== null) needs.push({ kind: "thread", d, attention: stuck, since });
    return needs;
  }).sort((a, b) => a.since - b.since);
}

/**
 * When the review entered the phase it is in, from the oldest of the `review.changed` events in a row that record it
 * there, as a label change records one again. The review's own `since` stands in once those events are gone.
 */
function heldSince(registry: Registry, r: Review): number {
  const changes = registry.events("0", { thread: r.builder, kinds: ["review.changed"] });
  const at = changes.findLastIndex((e) => e.payload.review !== r.id || (e.payload.phase as Review["phase"] | undefined)?.kind !== r.phase.kind);
  return changes[at + 1]?.time ?? r.since;
}

const needId = (n: Need) => `need-${n.d.thread.id}-${n.kind === "question" ? n.question.id : n.kind}`;

/** The inbox's cards, each the card its thread's page shows where there is one, under a line that links the thread. */
function needsList(c: Context): Html {
  const needs = c.needs();
  return html`<div class="ov-head"><h2 id="needs-h">Needs you</h2>${needs.length > 0 && html`<span class="count">${needs.length}</span>`}</div>
${needs.length === 0 ? html`<p class="empty">Nothing waits on you.</p>` : html`<div class="need-list">${needs.map((n) => {
  const t = n.d.thread;
  const [what, body] = needCard(c, n);
  return html`<article class="need need-${n.kind}" id="${needId(n)}" data-thread="${t.id}" data-attention="${n.kind === "thread" ? n.attention : "decision"}" tabindex="-1" aria-label="${what}: ${t.title}">
<div class="need-head"><span class="need-what">${what}</span><a class="need-thread" href="/threads/${t.id}"><span class="dim">${t.project} /</span> ${t.title}</a><span class="need-at">${ago(n.since, c.now)}</span></div>
${body}
</article>`;
})}</div>`}`;
}

/** What the card is, and what it shows: a review or question as its thread's page shows it, or what stopped the thread and the one action that gets past it. */
function needCard(c: Context, n: Need): [what: string, body: Html] {
  const { d } = n;
  const t = d.thread;
  const button = (action: string, label: string) => html`<button type="button" class="btn btn-xs" data-action="${action}" data-thread="${t.id}">${label}</button>`;
  const fix = (why: Part, act: Part) => html`<p class="land-note">${why}</p><div class="need-act">${act}</div>`;
  switch (n.kind) {
    case "land": {
      const summary = d.pullRequests?.find((p) => p.repo === d.review!.pr.repo && p.number === d.review!.pr.number)?.summary;
      const quote = d.review!.rounds.at(-1)!.verdict?.notCheckedLive ?? null;
      return [d.review!.phase.kind === "needs-person" ? "Held review" : "Approved review", html`${summary !== undefined && summary !== "" && html`<p class="need-summary">${inline(summary)}</p>`}
<div class="need-unchecked"><h3>Not checked live</h3>${quote === null ? html`<p class="land-note">The reviewer quoted nothing.</p>` : prose(quote)}</div>
${landing(c, d, (name) => `${name}-${t.id}`)}`];
    }
    case "question": {
      const q = n.question;
      const judgment = (d.judgments ?? []).filter((j) => j.question === q.id);
      return [q.ask !== undefined ? "Claude asks" : q.proposal !== undefined ? "Proposed item" : judgment.length > 0 ? "Judgment" : "Question",
        html`${judgment.length > 0 && judgmentCards(c, { ...d, judgments: judgment })}${questionCard(c, q)}`];
    }
    case "thread": switch (n.attention) {
      case "waiting": return ["Dialog in its terminal", fix(`${t.sessionWaitingMessage ?? "A dialog waits for input"}, in the pylon's terminal.`, html`<a class="btn btn-xs" href="/threads/${t.id}#terminal">${icon("terminal")}Open terminal</a>`)];
      case "limited": return ["Usage limit", fix(`It ${usageLimitText(t.usageLimit ?? { resetsAt: null }, c.now)}. Nexus has it continue once the limit resets, or archive it to stop it.`, button("archive", "Archive"))];
      case "parked": return ["Stuck", fix(`${d.agent?.parkedTasks ?? 0} ${d.agent?.parkedTasks === 1 ? "task" : "tasks"} hit the restart limit and hold the run.`, button("retry", "Retry"))];
      case "failed": {
        const why = d.pylon.failed?.split("\n")[0] ?? d.claudeWorker?.message ?? "It failed.";
        return ["Failed", d.pylon.failed !== null && d.pylon.retryRefused === null ? fix(`The planner gave up on its pylon: ${why}`, button("retry-pylon", "Retry"))
          : fix(d.pylon.failed !== null ? `The planner gave up on its pylon: ${why} ${d.pylon.retryRefused}.` : `The Claude worker failed: ${why}`, button("archive", "Archive"))];
      }
      case "decision": return ["Needs your decision", fix(d.review?.phase.kind === "needs-person" ? d.review.phase.reasons.join(" ") : c.registry.nudge(t.id)?.state === "person" ? "It stopped short of a pull request after two nudges." : attentions.decision.label,
        html`<a class="btn btn-xs" href="/threads/${t.id}">Open thread</a>`)];
    }
  }
}

/** A phone hides the wide columns of a usage table. */
const usageColumns = tokenColumns.map((col) => ({ ...col, wide: col.field === "cacheWrite" || col.field === "cacheRead" }));
const exact = (n: number) => n.toLocaleString("en-US");
const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Each token count reads as 1.2M, with the exact number in its title and, for a script, in `data-tokens`. */
function usageTable(id: string, keyHead: string, rows: readonly (UsageTotals & { key: Part })[]): Html {
  const wide = (yes: boolean) => yes && html` class="wide"`;
  return html`<table class="ov usage-t" id="${id}">
<thead><tr><th>${keyHead}</th>${usageColumns.map((col) => html`<th${wide(col.wide)}>${col.label}</th>`)}<th class="wide">Calls</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td>${r.key}</td>${usageColumns.map((col) => html`<td${wide(col.wide)} data-column="${col.field}" data-tokens="${r[col.field]}" title="${exact(r[col.field])}">${tokenCount(r[col.field])}</td>`)}<td class="wide">${exact(r.calls)}</td></tr>`)}</tbody>
</table>`;
}

function backfillNote(c: Context, b: UsageBackfill): Html {
  const run = b.state === "never" ? null : b;
  const thread = (id: ThreadId) => html`<a class="link" href="/threads/${id}">${c.registry.thread(id)?.title ?? id}</a>`;
  const recovered = run === null ? "" : `${exact(run.recovered.calls)} calls and ${tokenCount(run.recovered.tokens)} tokens recovered`;
  const read = run === null ? "" : `${run.read} of ${run.of} threads read`;
  const doing = run?.current == null ? run?.waiting == null ? "" : html` It waits: ${run.waiting}.`
    : run.current.phase === "reading" ? html` It reads ${thread(run.current.thread)}.` : html` It waits for the pylon of ${thread(run.current.thread)} to pause.`;
  const said = run === null
    ? html`The calls archived threads made before then are counted once a deployer runs <code>nexus usage backfill</code>, which wakes their pylons one at a time to read them.`
    : run.state === "running" ? html`The backfill reads archived threads' pylons, one at a time: ${read}, ${recovered} so far.${doing}`
    : run.state === "stopped" ? html`The backfill stopped at ${read}, with ${recovered}. A deployer goes on with <code>nexus usage backfill</code>.`
    : html`The backfill read archived threads' pylons and finished <time datetime="${new Date(run.finishedAt!).toISOString()}">${utc(run.finishedAt!)}</time>: ${read}, ${run.skipped.length} skipped, ${recovered}.`;
  return html`<div id="usage-backfill" data-backfill-state="${b.state}"${run !== null && html` data-read="${run.read}" data-of="${run.of}" data-recovered-calls="${run.recovered.calls}" data-recovered-tokens="${run.recovered.tokens}"`}>
<p>${said}</p>
${run !== null && run.skipped.length > 0 && html`<table class="ov" id="usage-backfill-skipped"><thead><tr><th>Skipped thread</th><th>Why</th></tr></thead>
<tbody>${run.skipped.map((t) => html`<tr data-thread="${t.thread}"><td>${thread(t.thread)}</td><td>${t.reason}</td></tr>`)}</tbody></table>`}
</div>`;
}

/** The tokens every agent spent in the period, in all and by each breakdown, as `GET /v1/usage` reports them. */
function usagePage(c: Context, period: Period, project: ProjectId | null): Html {
  const report = c.registry.usageReport({ since: periodStart(period, c.now), project, by: breakdowns });
  const href = (p: Period, of: string | null) => `/usage?period=${p}${of === null ? "" : `&project=${encodeURIComponent(of)}`}`;
  const seg = (label: string, to: string, current: boolean) => html`<a class="seg-tab" href="${to}"${current && html` aria-current="page"`}>${label}</a>`;
  return layout(c, {
    title: "Usage",
    nav: "usage",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Usage</h1></div></header>
<div class="scroll"><div class="page usage" id="usage" data-live>
<div class="usage-filters">
<nav class="seg-bar usage-seg" aria-label="Period">${(Object.keys(periods) as Period[]).map((p) => seg(periods[p], href(p, project), p === period))}</nav>
<nav class="seg-bar usage-seg" aria-label="Project">${seg("All projects", href(period, null), project === null)}${c.registry.projects().map((p) => seg(p.id, href(period, p.id), p.id === project))}</nav>
</div>
<section aria-labelledby="usage-totals-h"><div class="ov-head"><h2 id="usage-totals-h">Tokens${project !== null && ` in ${project}`}</h2></div>
${usageTable("usage-totals", "Period", [{ key: periods[period], ...report.total }])}
<div class="usage-notes">
<p>Counting started <time datetime="${new Date(report.countingSince).toISOString()}">${utc(report.countingSince)}</time>. The calls of threads that ran then were counted from the transcripts their pylons had. Threads deleted before then are not counted, as their Claude and pi transcripts went with their pylons, except for the Nexus agent's calls, which the harness keeps.</p>
${backfillNote(c, report.backfill)}
<p>The summaries the Nexus agent's compactions write, and model calls its tools make, are not counted.</p>
</div>
</section>
${report.total.calls === 0 ? html`<p class="empty">No model calls were counted in this period.</p>` : breakdowns.map((b) => html`<section aria-labelledby="usage-by-${b}-h"><div class="ov-head"><h2 id="usage-by-${b}-h">${breakdownLook[b].title}</h2></div>
${usageTable(`usage-by-${b}`, breakdownLook[b].key, report.by[b]!.map((r) => b === "project" ? { ...r, key: html`<a class="link" href="${href(period, r.key)}">${r.key}</a>` } : r))}
</section>`)}
</div></div>`,
  });
}

const phaseTone: Record<ItemPhase["kind"], Tone> = {
  planned: "idle", queued: "idle", building: "work", reviewing: "work", landing: "busy", landed: "ok", held: "bad", archived: "muted", cancelled: "muted",
};
const pipelineSetting = (p: Project) => p.pipeline == null ? "The pipeline is off for this project, so its items stay planned."
  : p.pipeline.autoStart ? "Each item becomes a queued thread on its own once the items it is after are queued." : "Each item waits for the person to approve it before it becomes a queued thread.";

/** Each project's items in the order they were added, with the phase their records put them in. */
function pipelinePage(c: Context): Html {
  const items = c.registry.items().map((i) => itemView(c.registry, i));
  const title = (id: string) => items.find((i) => i.id === id)?.title ?? id;
  const projects = c.registry.projects().filter((p) => p.pipeline != null || items.some((i) => i.project === p.id));
  const actions = (i: PipelineItem, p: Project) => i.thread === null && i.phase.kind !== "cancelled" && [
    p.pipeline?.autoStart === false && i.approved === null && html`<button type="button" class="btn btn-xs" data-action="approve-item" data-item="${i.id}">Approve</button>`,
    html`<button type="button" class="btn btn-xs btn-ghost" data-action="cancel-item" data-item="${i.id}" data-confirm="Cancel ${i.title}? It never becomes a thread.">Cancel</button>`,
  ];
  return layout(c, {
    title: "Pipeline",
    nav: "pipeline",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Pipeline</h1></div></header>
<div class="scroll"><div class="page pipeline" id="pipeline" data-live>
${projects.length === 0 ? html`<p class="empty">No project runs the pipeline. <code>nexus project edit &lt;id&gt; --pipeline start</code> turns it on, and <code>nexus item add</code> lines up an item.</p>` : projects.map((p) => {
  const own = items.filter((i) => i.project === p.id);
  return html`<section aria-labelledby="pipeline-${p.id}">
<div class="ov-head"><h2 id="pipeline-${p.id}">${p.id}</h2><span class="dim">${pipelineSetting(p)}</span></div>
${own.length === 0 ? html`<p class="empty">No items. <code>nexus item add --project ${p.id}</code> lines one up.</p>` : html`<table class="ov ov-items">
<thead><tr><th>Item</th><th>Phase</th><th class="wide">After</th><th class="wide">Thread</th><th class="ov-act"></th></tr></thead>
<tbody>${own.map((i) => html`<tr data-item="${i.id}" data-phase="${i.phase.kind}">
<td><span class="ov-title">${dot(phaseTone[i.phase.kind], i.phase.kind)}<span>${i.title}</span></span><code class="dim">${i.id}</code></td>
<td>${state(i.phase.kind, phaseTone[i.phase.kind])}<span class="ov-why">${i.phase.why}</span></td>
<td class="wide">${i.after.length === 0 ? html`<span class="dim">nothing</span>` : i.after.map((id) => html`<span class="ov-wait">${title(id)}</span>`)}</td>
<td class="wide">${i.thread === null ? html`<span class="dim">none yet</span>` : html`<a class="link" href="/threads/${i.thread}">${c.registry.thread(i.thread)?.title ?? c.registry.queuedThread(i.thread)?.title ?? i.thread}</a>`}</td>
<td>${actions(i, p)}</td>
</tr>`)}</tbody>
</table>`}
</section>`;
})}
</div></div>
<div class="dock"><p id="action-error" class="error" role="alert" hidden></p></div>`,
  });
}

const unknown = html`<span class="dim">unknown</span>`;

/** What the node's probe reads of its host when the page loads. Nothing here acts on the node. */
function nodePage(c: Context, name: NodeName, health: NodeHealth | Error): Html {
  const pylonOf = new Map(c.registry.pylonsOn(name).map((p) => [p.pylonId, p.thread]));
  const reading = html`<section aria-labelledby="node-health-h"><div class="ov-head"><h2 id="node-health-h">Health</h2></div>
${health instanceof Error ? html`<p class="error" role="alert">${health.message}</p>` : html`<dl class="kv node-health">
<dt>Read</dt><dd><time datetime="${health.readAt}">${utc(Date.parse(health.readAt))}</time></dd>
<dt>Load</dt><dd>${health.load === null ? unknown : `${health.load.one.toFixed(2)} · ${health.load.five.toFixed(2)} · ${health.load.fifteen.toFixed(2)} over 1, 5 and 15 minutes, on ${health.cpus} CPUs`}</dd>
<dt>Memory</dt><dd>${health.memory === null ? unknown : `${gib(health.memory.availableGiB)} of ${gib(health.memory.totalGiB)} GiB available`}</dd>
<dt>Swap</dt><dd>${health.memory === null ? unknown : health.memory.swapTotalGiB === 0 ? "none" : `${gib(health.memory.swapTotalGiB - health.memory.swapFreeGiB)} of ${gib(health.memory.swapTotalGiB)} GiB used`}</dd>
<dt>Disk</dt><dd>${gib(health.disk.freeGiB)} of ${gib(health.disk.totalGiB)} GiB free at <code>${health.disk.path}</code></dd>
<dt>Temperatures</dt><dd>${health.temperatures === null ? unknown : health.temperatures.map((t, i) => html`${i > 0 && html`<br>`}${t.sensor} ${t.celsius.toFixed(1)} °C`)}</dd>
</dl>`}
</section>`;
  const pylons = health instanceof Error ? html`` : html`<section aria-labelledby="node-pylons-h"><div class="ov-head"><h2 id="node-pylons-h">Pylon processes ${health.pylons !== null && html`<span class="count">${health.pylons.length}</span>`}</h2></div>
${health.pylons === null ? html`<p class="empty">This node's backend does not say which processes are its pylons'.</p>` : health.pylons.length === 0 ? html`<p class="empty">No pylon runs on this node.</p>` : html`<table class="ov" id="node-pylons">
<thead><tr><th class="wide">Pylon</th><th>Thread</th><th class="wide">Processes</th><th>CPU</th><th>Resident</th></tr></thead>
<tbody>${health.pylons.map((p) => {
  const thread = pylonOf.get(p.pylonId);
  return html`<tr><td class="wide"><code>${p.pylonId}</code></td><td>${thread === undefined ? html`<span class="dim">${p.pylonId}, not in the registry</span>` : html`<a class="link" href="/threads/${thread}" title="${p.pylonId}">${c.registry.thread(thread as ThreadId)?.title ?? thread}</a>`}</td><td class="wide">${p.processes}</td><td>${p.cpuPercent.toFixed(1)}%</td><td>${gib(p.residentGiB)} GiB</td></tr>`;
})}</tbody>
</table>`}
<p class="dim small">CPU is the percent of one CPU a pylon's processes used over the second the probe sampled, so four busy CPUs read 400%.</p>
</section>`;
  return layout(c, {
    title: `Node ${name}`,
    main: html`<header class="bar">${menu}<div class="crumb"><h1>${name}</h1></div></header>
<div class="scroll"><div class="page" id="node-health" data-live>
${reading}
${pylons}
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

/** `streaming` is a poll from a page whose stream shows the conversation. */
function threadPage(c: Context, d: ThreadDetail, node: NodeRecord, view: AgentView | Error | null, renderedReplyAt: number | null, streaming = false): Html {
  const { thread: t } = d;
  const agent = c.registry.agent(t).kind;
  const read = view === null || view instanceof Error ? null : view;
  const items = read === null ? [] : itemsOf(read, d.questions ?? [], t.id);
  const run = runOf(d, read, items);
  const model = d.claudeWorker !== undefined ? d.claudeWorker.model : read === null || read.kind === "claude" ? null : modelOf(read.view);
  const shows = streaming && read?.kind === "claude" ? shownKey(read.view, model) : null;
  const [label, tone] = threadState({ ...t, attention: d.attention, desired: d.desired, pylon: d.pylon });
  const open = t.status === "active" || t.status === "idle";
  const actions = [
    open && html`<button type="button" class="btn btn-ghost" id="archive" data-action="archive" data-thread="${t.id}">Archive</button>`,
    t.status === "archived" && html`<button type="button" class="btn btn-ghost" id="unarchive" data-action="unarchive" data-thread="${t.id}">Unarchive</button>`,
    t.status !== "deleted" && html`<button type="button" class="btn btn-ghost danger" id="delete" data-action="delete" data-thread="${t.id}" data-confirm="Delete &quot;${t.title}&quot;? Its pylon and disk are removed.">Delete</button>`,
  ].filter((a) => a !== false);
  return layout(c, {
    title: t.title,
    active: t.id,
    ...(open ? { activity: t.id } : {}),
    main: html`<header class="bar" id="bar" data-live>
${menu}
<div class="crumb"><a class="crumb-p" href="/">${t.project}</a><span class="sep" aria-hidden="true">/</span><h1>${t.title}</h1>${d.planning === true && html` <span class="tag" id="planning" title="Its proposed items become cards you accept or reject">planning</span>`}</div>
<span class="chip chip-${tone}">${dot(tone)}<span class="chip-label">${label}</span></span>
${actions.length > 0 && html`<div class="bar-actions" id="thread-actions">${actions}</div><button type="button" class="icon-btn more" data-open="actions" aria-label="Thread actions" aria-controls="thread-actions">⋯</button>`}
</header>
<div class="tabs" id="tabs" role="tablist" aria-label="Open views" data-thread="${t.id}"><button type="button" class="tab active" role="tab" aria-selected="true" aria-controls="scroll" data-tab="convo">${icon("chat")}<span class="tab-name">${t.title}</span></button>${t.status !== "deleted" && html`<button type="button" class="tab tab-term"${!open && " hidden"} role="tab" aria-selected="false" aria-controls="term-view" data-tab="term" title="A terminal in the pylon, as nexus attach ${t.id} gives">${icon("terminal")}<span class="tab-name">Terminal</span></button>`}</div>
<div class="strip" id="strip" data-live>${strip(d)}</div>
<div id="facts" data-live hidden>${facts(d)}</div>
<div class="scroll" id="scroll" role="tabpanel"><div class="convo" id="convo" data-rendered-reply-at="${read === null ? "" : renderedReplyAt ?? ""}"${shows !== null && html` data-shows="${shows}"`} data-live${agent !== "none" && t.status !== "deleted" && html` data-stream="/threads/${t.id}/stream"`}>${shows === null && convo(t, view, items, model, c.now)}</div></div>
<section class="file-view" id="file-view" role="tabpanel" aria-label="File diff" hidden></section>
${t.status !== "deleted" && termView(t, agent)}
<div class="dock">
<p id="action-error" class="error" role="alert" hidden></p>
<p id="action-status" class="comp-note" role="status" hidden></p>
<div id="judgments" data-live>${judgmentCards(c, d)}</div>
<div id="questions" data-live>${questionCards(c, d)}</div>
<div id="landing" data-live>${landing(c, d)}</div>
<div id="run" data-live>${(open || (t.status === "archived" && run.kind === "parked")) && stateBar(t, run, c.now)}</div>
<div id="composer" data-live>${composer(d, agent, run, model, read?.kind === "claude" ? read.view : null, c.now)}</div>
</div>`,
    inspector: inspector(d, node, c.now, c.registry.usageReport({ since: null, thread: t.id }).total),
  });
}

/**
 * The terminal tab, which client.js attaches on its first show, as `nexus attach` does, and shows while the thread is
 * open, so an unarchive brings it back without a reload. A Nexus agent runs on the control plane, so its thread's
 * terminal is the pylon's Herdr session and its conversation stays in the composer.
 */
function termView(t: Thread, agent: ThreadAgent["kind"]): Html {
  return html`<section class="term-view" id="term-view" role="tabpanel" aria-label="Terminal" hidden>
<div class="tv-head"><span class="tv-where">${agent === "claude" ? "Claude Code's pane in the pylon's Herdr session" : "The pylon's Herdr session"}</span><span class="tv-status" id="term-status" role="status"></span><button type="button" class="btn btn-xs" id="term-again" hidden>Attach again</button><button type="button" class="btn btn-xs btn-ghost" id="term-detach" hidden>Detach</button></div>
<div class="tv-host" id="term-host"></div>
</section>`;
}

/** The steps of a landing, in order. */
const landingSteps = [["checking", "Check"], ["verifying", "Live check"], ["merging", "Merge"], ["deploying", "Deploy"], ["landed", "Landed"]] as const;
type Step = typeof landingSteps[number][0];
/**
 * The step a landing is at, and whether it failed there. A landing held after its merge stopped at the deploy, which
 * failed or rolled back. One held before its merge is not on its way anywhere, and is landable again or not at all.
 */
function landingAt(r: Review): { step: Step; failed: boolean } | null {
  switch (r.phase.kind) {
    case "checking": case "verifying": return r.land === null ? null : { step: r.phase.kind, failed: false };
    case "merging": case "deploying": case "landed": return { step: r.phase.kind, failed: false };
    case "rolling-back": return { step: "deploying", failed: true };
    case "needs-person": return r.merged !== null && r.land !== null ? { step: "deploying", failed: true } : null;
    default: return null;
  }
}

const landRefusals: Record<LandRefusal, (caller: TailnetNodeId) => string> = {
  "not a deployer": (caller) => `This device cannot land: landing deploys, so only the control plane's deployers may, and this device (tailnet node ${caller}) is not one. Land it from a deployer, or add this node to deployers in the control plane's config.`,
  "no review loop": () => "Nexus cannot land it now: the review loop needs the control plane's GitHub token (github.tokenFile), which is not configured.",
};

const answerRefusals: Record<AnswerRefusal, (caller: TailnetNodeId) => string> = {
  "not a person": (caller) => `This device cannot answer: tailnet node ${caller} is the control plane or one of its nodes, whose pylons call under its identity, and only a person's device may answer. Answer it from your laptop or phone.`,
  "not a deployer": (caller) => `This device cannot answer: the answer may deploy, so only the control plane's deployers may, and this device (tailnet node ${caller}) is not one. Answer it from a deployer, or add this node to deployers in the control plane's config.`,
};
const answerers: Record<Question["answerer"], string> = { person: "You answer.", deployer: "A deployer answers, as the answer may deploy." };

/**
 * Above the questions, each judgment of the thread's failed pylon: what failed, the verdict and who gave it, and what
 * Nexus did, with what the judgment was asked and what it answered. A question it asks is the question card below.
 */
function judgmentCards(c: Context, d: ThreadDetail): Html[] {
  return (d.judgments ?? []).map((j) => {
    const did = j.outcome !== null ? `Nexus ${j.outcome}.` : j.question !== null ? "It waits for your answer below." : j.verdict === null ? "Nexus acts on its answer." : "Nexus acts on it now.";
    return html`<section class="landing judgment" data-judgment="${j.failure}" aria-label="Judgment of a failure">
<div class="land-top"><h2>Failed on ${j.node}</h2><span class="land-meta">judged ${ago(j.startedAt, c.now)}</span></div>
<p class="land-note">${j.failed.split("\n")[0]}</p>
<p class="land-meta">${j.verdict === null ? "The judgment has not answered yet." : html`<b>${j.verdict.answer}</b>, by the ${j.verdict.by}: ${j.verdict.why}`}</p>
<p class="land-meta">${did}</p>
${j.brief !== null && html`<details><summary>What the judgment was asked and answered</summary><pre>${j.brief}</pre>${j.reply !== null && html`<pre>${j.reply}</pre>`}</details>`}
</section>`;
  });
}

/**
 * Above the landing card, each question the thread asked: open ones as a card with a button per option, and answered
 * ones as a line saying what the answer was. A Claude worker's open ask is a form, and an answered one shows in the
 * conversation instead. As with landing, the page says up front when the answer route would refuse this device.
 */
function questionCards(c: Context, d: ThreadDetail): Html[] {
  return (d.questions ?? []).filter((q) => q.ask === undefined || q.answer === null).map((q) => questionCard(c, q));
}

function questionCard(c: Context, q: Question): Html {
  if (q.ask !== undefined) return askCard(c, q, q.ask.questions);
  if (q.answer !== null) {
    return html`<section class="landing question answered" data-question="${q.id}" aria-label="Answered question"><div class="question-text">${prose(q.text)}</div>
<p class="land-meta">Answered "${q.answer.option}" from ${q.answer.by}, ${ago(q.answer.at, c.now)}</p></section>`;
  }
  const refusal = c.answerRefusal(q);
  const buttons = q.options.map((option) => refusal === null
    ? html`<button type="button" class="btn" data-action="answer" data-thread="${q.thread}" data-question="${q.id}" data-option="${option}" data-confirm="Answer &quot;${option}&quot;? The answer cannot be changed.">${option}</button>`
    : html`<button type="button" class="btn" data-question="${q.id}" data-option="${option}" disabled>${option}</button>`);
  return html`<section class="landing question" data-question="${q.id}" aria-label="Needs your decision">
<div class="land-top"><h2>Needs your decision</h2>${q.reserved !== null && html`<span class="tag">reserved: ${reservedNames[q.reserved]}</span>`}</div>
<div class="question-text">${prose(q.text)}</div>
<p class="land-meta">Asked ${ago(q.askedAt, c.now)}. ${answerers[q.answerer]}</p>
<div class="land-act"><div class="question-options">${buttons}</div>${refusal !== null && html`<p class="error">${answerRefusals[refusal](c.caller)}</p>`}</div>
</section>`;
}

/**
 * A Claude worker's open AskUserQuestion as a form: each question with its options as radios, or checkboxes when it
 * takes several, each option's preview, an answer of the person's own, and notes. client.js sends it as the answer's
 * choices. The terminal's dialog stays open meanwhile, and whichever answers first is the answer.
 */
function askCard(c: Context, q: Question, asked: readonly AskedQuestion[]): Html {
  const refusal = c.answerRefusal(q);
  // Each field has an ID, so a swap of the region keeps the focus in it.
  const field = (i: number, name: string) => `${q.id}-${i}-${name}`;
  return html`<section class="landing question ask" data-question="${q.id}" aria-label="Claude asks">
<div class="land-top"><h2>Claude asks</h2></div>
<form class="ask" data-thread="${q.thread}" data-question="${q.id}">
<fieldset class="ask-all"${refusal !== null && " disabled"}>
${asked.map((aq, i) => html`<fieldset class="ask-q" data-multi="${String(aq.multiSelect)}" data-header="${aq.header}">
<legend><span class="tag">${aq.header}</span> ${aq.question}</legend>
${aq.options.map((o, j) => html`<div class="ask-opt"><label><input type="${aq.multiSelect ? "checkbox" : "radio"}" name="picked-${i}" value="${o.label}" id="${field(i, `o${j}`)}"><span class="ask-label">${o.label}</span>${o.description !== "" && html`<span class="ask-desc">${o.description}</span>`}</label>${o.preview !== undefined && html`<pre class="ask-preview">${o.preview}</pre>`}</div>`)}
<div class="ask-opt ask-own">${aq.multiSelect
  ? html`<label for="${field(i, "own")}"><span class="ask-label">And your own answer</span></label>`
  : html`<label><input type="radio" name="picked-${i}" value="" id="${field(i, "pick-own")}"><span class="ask-label">Your own answer</span></label>`}<input type="text" name="own-${i}" id="${field(i, "own")}" maxlength="4000" aria-label="Your own answer to ${aq.header}"></div>
<input type="text" class="ask-notes" name="notes-${i}" id="${field(i, "notes")}" maxlength="4000" placeholder="Notes for Claude (optional)" aria-label="Notes on ${aq.header}">
</fieldset>`)}
</fieldset>
<p class="land-meta">Asked ${ago(q.askedAt, c.now)}. Answer here or in the pylon's terminal, whichever comes first.</p>
<div class="land-act"><button type="submit" class="btn"${refusal !== null && " disabled"}>Answer</button>${refusal !== null && html`<p class="error">${answerRefusals[refusal](c.caller)}</p>`}</div>
</form>
</section>`;
}

const short = (commit: string) => html`<code title="${commit}">${commit.slice(0, 12)}</code>`;

/** Whether the review's card offers it for landing. A PR closed or merged outside the review leaves it held, but there is nothing left to land. */
function landOffered(d: ThreadDetail): boolean {
  const r = d.review;
  const pr = r == null ? undefined : d.pullRequests?.find((p) => p.repo === r.pr.repo && p.number === r.pr.number);
  return r != null && landable(r) && d.thread.status === "active" && (pr === undefined || pr.state === "open");
}

/**
 * Above the composer, for a builder whose review the person can land or is landing: why it waits for them, with the
 * Land button, and then the landing's steps until it lands or ends for them again. The land route decides who may
 * land, and the page says so up front rather than offer a button that fails. `id` names its elements, so the inbox
 * can show several.
 */
function landing(c: Context, d: ThreadDetail, id = (name: string) => name): Html | null {
  const r = d.review;
  if (r == null) return null;
  const prLink = html`<a href="${r.pr.url}" target="_blank" rel="noreferrer">#${r.pr.number} ${r.pr.title} ↗</a>`;
  const at = landingAt(r);
  if (at !== null) {
    const deploys = c.deploys(r);
    const index = landingSteps.findIndex(([step]) => step === at.step);
    const { live } = r.rounds.at(-1)!;
    // A landing past the live check with none recorded is one from before live checks.
    const unverified = live?.kind === "absent" ? " (no .nexus/verify)" : live === undefined && index > 1 ? " (not run)" : null;
    const stateOf = (step: Step, i: number) => (step === "deploying" && !deploys) || (step === "verifying" && unverified !== null) ? "skipped"
      : i < index || at.step === "landed" ? "done" : i > index ? "todo" : at.failed ? "failed" : "now";
    const title = at.step === "landed" ? "Landed" : r.phase.kind === "needs-person" ? "Merged, not deployed" : r.phase.kind === "rolling-back" ? "Rolling back" : "Landing";
    const phase = r.phase;
    return html`<section class="landing" aria-labelledby="${id("landing-h")}">
<div class="land-top"><h2 id="${id("landing-h")}">${title}</h2>${prLink}</div>
<ol class="land-steps">${landingSteps.map(([step, label], i) => {
  const state = stateOf(step, i);
  return html`<li class="land-step land-${state}"${state === "now" && html` aria-current="step"`}>${label}${state === "skipped" && (step === "verifying" ? unverified : " (nothing to deploy)")}</li>`;
})}</ol>
${phase.kind === "checking" ? html`<p class="land-note">.nexus/check runs at ${short(r.rounds.at(-1)!.head)}, or its kept result for that commit is read.</p>`
  : phase.kind === "verifying" ? html`<p class="land-note">${phase.thread === null && phase.refused !== undefined ? html`No node can take the verify pylon yet: ${phase.refused}` : html`.nexus/verify runs at ${short(r.rounds.at(-1)!.head)} in a verify pylon${phase.thread !== null && html`, <a href="/threads/${phase.thread}">${phase.thread}</a>`}.`}</p>`
  : phase.kind === "merging" ? html`<p class="land-note">Checking the merge policy again with what GitHub says now, then merging ${short(r.rounds.at(-1)!.head)}.</p>`
  : phase.kind === "deploying" ? html`<p class="land-note">Deploying the merge commit ${short(phase.commit)} until every service reports it healthy.</p>`
  : phase.kind === "rolling-back" ? html`<p class="error">${phase.why} Rolling back to ${short(phase.previous)}.</p>`
  : phase.kind === "landed" ? html`<p class="land-note">Merged as ${short(phase.commit)}${deploys && ", deployed, and every service reports it healthy"}.</p>`
  : phase.kind === "needs-person" && html`<ul class="error">${phase.reasons.map((reason) => html`<li>${reason}</li>`)}</ul>`}
</section>`;
  }
  if (!landOffered(d)) return null;
  const pr = d.pullRequests?.find((p) => p.repo === r.pr.repo && p.number === r.pr.number);
  const round = r.rounds.at(-1)!;
  // The PR watch can read a push before the loop's next pass starts a round on it. A stopped watch reads nothing new.
  const moved = d.prWatch?.stopped ? null : pushedHead(r, pr);
  const held = r.phase.kind === "needs-person";
  const reasons = heldBy(r);
  const rules = reasons.map((reason) => ({ reason, ...holdRule(reason) }));
  const waived = rules.filter((h) => h.waivable).map((h) => h.reason);
  // A hold that meets every landing again, and that the person cannot waive, leaves only merging on GitHub.
  const stuck = rules.some((h) => h.holdsAgain && !h.waivable);
  const findings = findingsOf(round);
  const deploys = c.deploys(r) ? " and deploys the merge commit" : "";
  const confirm = waived.length === 0
    ? `Land pull request #${r.pr.number}, "${r.pr.title}", at commit ${round.head.slice(0, 12)}? Nexus checks the merge policy again, merges that commit${deploys}.`
    : `Land pull request #${r.pr.number}, "${r.pr.title}", at commit ${round.head.slice(0, 12)}, waiving ${waived.length === 1 ? "the hold" : `the ${waived.length} holds`} the merge policy reserves for you? Nexus checks everything else again, merges that commit${deploys}.`;
  return html`<section class="landing" aria-labelledby="${id("landing-h")}">
<div class="land-top"><h2 id="${id("landing-h")}">${held ? "Held for you" : "Approved, not landed"}</h2>${prLink}</div>
${roundNote(r) !== null && html`<p class="land-note">${roundNote(r)}</p>`}
<p class="land-meta">Head ${short(round.head)} · approved by ${r.models.reviewer} (${r.reviewerKind}) in round ${roundsSpent(r)} of ${r.maxRounds} · .nexus/check passed · ${round.live === undefined ? "no live check ran" : round.live.kind === "absent" ? "no .nexus/verify, so no live check" : `live check ${round.live.passed ? "passed" : "failed"}`}</p>
<details id="${id("land-why")}" open><summary>Why it waits for you</summary>
${reasons.length === 0 ? html`<p class="land-note">Nothing holds it. The review stopped at approval because it was started without --land.</p>`
  : html`<ul class="land-reasons">${rules.map((h) => html`<li>${h.reason} ${h.waivable ? html`<span class="tag tag-ok">you may waive</span>` : html`<span class="tag">${h.holdsAgain ? "holds again" : "not waivable"}</span>`}<br><span class="dim">${h.why}</span></li>`)}</ul>`}
<h3>The reviewer's findings</h3>
${findings.length === 0 ? html`<p class="land-note">None.</p>` : html`<ul class="land-findings">${findings.map((f) => {
  const answer = r.rounds.flatMap((rd) => rd.answers ?? []).findLast((a) => a.id === f.id);
  return html`<li><span class="tag${blocking(f) ? " tag-bad" : ""}">${f.priority}</span> <b>${f.id}</b>${f.where && html` <code>${f.where}</code>`}: ${f.summary}${answer && html` <span class="dim">(builder: ${answer.action}${answer.reason && `, ${answer.reason}`})</span>`}</li>`;
})}</ul>`}
${round.check !== null && html`<details id="${id("land-check")}"><summary>.nexus/check ${round.check.passed ? "passed" : "failed"} at ${round.head.slice(0, 12)}</summary><pre>${round.check.output}</pre></details>`}
${round.live?.kind === "ran" && html`<details id="${id("land-live")}"><summary>The live check ${round.live.passed ? "passed" : "failed"} at ${round.head.slice(0, 12)}</summary><pre>${round.live.output}</pre></details>`}
</details>
${moved !== null ? html`<p class="land-note">The PR watch last read the pull request at ${short(moved)}, not ${short(round.head)}, so ${short(round.head)} is not offered for landing. Nexus confirms the head with GitHub, and a new head gets a new round, or holds for you when no round is left.</p>`
  : stuck ? html`<p class="land-note">Landing checks the merge policy again, and what is marked "holds again" holds every landing of this commit. Only you can get past it, by merging the pull request on GitHub${c.deploys(r) && " and deploying it with nexus deploy"}.</p>`
  : c.landRefusal === null ? html`<div class="land-act"><button type="button" class="btn btn-primary" id="${id("land")}" data-action="land" data-thread="${d.thread.id}" data-head="${round.head}"${waived.length > 0 && html` data-holds="${JSON.stringify(waived)}"`} data-confirm="${confirm}">Land #${r.pr.number}</button>${waived.length > 0 && html`<p class="land-note">Pressing Land waives what is marked "you may waive", for commit ${short(round.head)} only. Landing checks everything else again.</p>`}</div>`
  : html`<div class="land-act"><button type="button" class="btn" id="${id("land")}" disabled>Land #${r.pr.number}</button><p class="error">${landRefusals[c.landRefusal](c.caller)}</p></div>`}
</section>`;
}

/**
 * A thread that has not started: what it waits for, what it will start with, and the actions a queued thread has. It
 * has no conversation or pylon, so it has no inspector and counts no visit.
 */
function queuedPage(c: Context, q: QueuedThread): Html {
  const [label, tone] = queuedLook(q);
  const { cpus, memoryGiB, diskGiB } = q.resources;
  const actions = [
    q.status === "queued" && html`<button type="button" class="btn" id="start-queued" data-action="start-queued" data-thread="${q.id}">Start now</button>`,
    q.status === "queued" && html`<button type="button" class="btn btn-ghost" id="archive" data-action="archive" data-thread="${q.id}">Archive</button>`,
    q.status === "archived" && html`<button type="button" class="btn btn-ghost" id="unarchive" data-action="unarchive" data-thread="${q.id}">Unarchive</button>`,
  ].filter((a) => a !== false);
  return layout(c, {
    title: q.title,
    active: q.id,
    main: html`<header class="bar" id="bar" data-live>
${menu}
<div class="crumb"><a class="crumb-p" href="/">${q.project}</a><span class="sep" aria-hidden="true">/</span><h1>${q.title}</h1></div>
<span class="chip chip-${tone}">${dot(tone)}<span class="chip-label">${label}</span></span>
${actions.length > 0 && html`<div class="bar-actions" id="thread-actions">${actions}</div><button type="button" class="icon-btn more" data-open="actions" aria-label="Thread actions" aria-controls="thread-actions">⋯</button>`}
</header>
<div class="scroll"><div class="page queued" id="queued" data-live>
<section aria-labelledby="waits-h"><h2 id="waits-h">Starts once these threads' pull requests merge</h2>
<ul class="list">${q.waits.map((w) => html`<li>${state(w.state, waitTone[w.state])} <a class="link" href="/threads/${w.thread}">${predecessor(c, w.thread)}</a>: ${w.why}</li>`)}</ul>
${q.status === "queued" && q.blocked && html`<p class="dim">A blocked thread stays queued. Start it now, or archive it to cancel it.</p>`}
${q.startNow !== null && html`<p class="dim">Start now was asked ${ago(q.startNow.at, c.now)}, so it starts without waiting once it can.</p>`}
</section>
<section aria-labelledby="start-h"><h2 id="start-h">What it starts with</h2>
<dl class="kv">
<dt>${q.worker === "claude" ? "Prompt" : "Message"}</dt><dd>${q.prompt === null ? html`<span class="dim">none</span>` : prose(q.prompt)}</dd>
<dt>Worker</dt><dd>${q.worker === "claude" ? `Claude Code · ${q.model ?? "unknown"}` : "Nexus agent"}</dd>
<dt>Node</dt><dd>${q.node}</dd>
<dt>Size</dt><dd>${cpus} CPUs, ${memoryGiB} GiB memory, ${diskGiB} GiB disk</dd>
${q.branch !== null && html`<dt>Branch</dt><dd><code>${q.branch}</code></dd>`}
${q.commit !== null && html`<dt>Commit</dt><dd><code>${q.commit}</code></dd>`}
</dl>
<code class="id">${q.id}</code>
${q.lastError !== null && html`<p class="error">The last start attempt failed: ${q.lastError}</p>`}
</section>
</div></div>
<div class="dock"><p id="action-error" class="error" role="alert" hidden></p></div>`,
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
function convo(t: Thread, view: AgentView | Error | null, items: readonly Item[], model: string | null, now: number): Html {
  const claude = view !== null && !(view instanceof Error) && view.kind === "claude" ? view.view : null;
  return html`
<p class="convo-meta"><code>${t.id}</code> · started ${ago(t.createdAt, now)}${claude !== null && " · Claude Code"}${model !== null && html` · ${model}`}</p>
${view === null ? html`<p class="empty">${t.status === "deleted" ? "The thread is deleted, so its conversation is gone." : "This thread has no agent conversation."}</p>`
  : view instanceof Error ? html`<p class="error">The conversation could not be read: ${view.message}</p>`
  : claude !== null && items.length === 0 ? html`<p class="empty">${claude.readAt === null ? "Claude's transcript has not been read yet. It is read while the pylon runs." : "Claude has not written a transcript yet."}</p>`
  : items.length === 0 ? html`<p class="empty">No messages yet.</p>`
  : html`${claude !== null && claude.dropped > 0 && html`<p class="note">${claude.dropped} older ${claude.dropped === 1 ? "entry is" : "entries are"} not kept.</p>`}${blocks(items).map((block) => blockView(block, now))}`}
`;
}

/**
 * One event of a thread page's stream: the conversation region's inside, or the new inside of each part that grew,
 * by its place among the region's `data-grow` elements. A Claude worker's frames say which view the region then
 * shows, and a frame with only that comes when the view changed and the region did not.
 */
export type LiveFrame = { convo: string; shows?: string } | { grow: [index: number, inside: string][]; shows?: string } | { shows: string };

const digest = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 22);
const entryDigests = new WeakMap<readonly ClaudeEntry[], string>();
/**
 * Which Claude view a conversation region shows, so a poll from a page whose stream shows it can say so without
 * rendering it. A watched thread's views keep one entries array until an entry changes, so each is digested once.
 */
function shownKey(view: ClaudeConversation, model: string | null): string {
  let entries = entryDigests.get(view.entries);
  if (entries === undefined) entryDigests.set(view.entries, entries = digest(JSON.stringify(view.entries)));
  return digest(JSON.stringify([view.session, view.dropped, entries, view.readAt === null, view.working, view.usageLimit, model]));
}

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
export function liveFrames(t: Thread, claudeModel: string | null = null, now: () => number = Date.now, questions: () => readonly Question[] = () => []): (view: ConversationView | ClaudeConversation) => LiveFrame | null {
  let shape: string | null = null;
  let parts: string[] = [];
  let shown: string | null = null;
  return (served) => {
    const view = agentView(served);
    const region = convo(t, view, itemsOf(view, questions(), t.id), view.kind === "claude" ? claudeModel : modelOf(view.view), now()).text;
    const next = [...region.matchAll(grown)].map((m) => m[1]!);
    const nextShape = region.replace(grown, "<!--grow-->");
    const grew = next.flatMap((inside, i): [number, string][] => inside === parts[i] ? [] : [[i, inside]]);
    const changed = nextShape !== shape;
    shape = nextShape;
    parts = next;
    const key = view.kind === "claude" ? shownKey(view.view, claudeModel) : null;
    const rekeyed = key !== shown;
    shown = key;
    const shows = key === null ? {} : { shows: key };
    if (changed) return { convo: region, ...shows };
    if (grew.length > 0) return { grow: grew, ...shows };
    return rekeyed ? { shows: key! } : null;
  };
}

/**
 * What client.js reads to decide when to read the checkout's changes: once the pylon runs, and again when its
 * agent was active and no turn runs, as that is when the checkout has changed. The agent's last activity catches a
 * turn that began and ended between two polls.
 */
function facts({ thread: t, pylon }: ThreadDetail): Html {
  return html`<span data-pylon="${pylon.actualState}" data-turn="${String(t.working)}" data-agent-at="${t.lastAgentActivityAt}" data-thread-status="${t.status}"></span>`;
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
function inspector(d: ThreadDetail, node: NodeRecord, now: number, usage: UsageTotals): Html {
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
<div class="pane-live" id="inspect" data-live>${inspectorPanes(d, node, now, usage)}</div>
</aside>`;
}

function inspectorPanes(d: ThreadDetail, node: NodeRecord, now: number, usage: UsageTotals): Html {
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
<dt>Tokens</dt><dd id="thread-usage" data-tokens="${usage.total}">${usage.calls === 0 ? "none counted"
  : html`<span title="${exact(usage.total)}">${tokenCount(usage.total)}</span> <span class="dim">(${usageColumns.filter((col) => col.field !== "total").map((col, i) => html`${i > 0 && " · "}<span title="${exact(usage[col.field])}">${col.short} ${tokenCount(usage[col.field])}</span>`)})</span>`}</dd>
</dl>
<code class="id">${pylon.id}</code>
${pylon.failed !== null && html`<p class="error">The planner gave up: ${pylon.failed.split("\n")[0]}</p>`}
</section>
<section aria-labelledby="outputs-h"><h2 id="outputs-h">Outputs ${count(outputs.length + (d.pullRequests?.length ?? 0))}</h2>
${!d.prWatch?.enabled ? html`<p class="empty">PR watch: off (no control-plane GitHub token configured).</p>` : html`<p>PR watch: ${d.prWatch.stopped ? "stopped (10 comment-only wakes)" : "on"}${d.prWatch.error && html` — ${d.prWatch.error}`}</p>`}
${(d.pullRequests ?? []).map((pr) => html`<p><a href="${pr.url}" target="_blank" rel="noreferrer">PR #${pr.number}: ${pr.title}</a> — ${pr.state}, checks ${pr.checks}, review ${pr.review}</p>`)}
${d.review != null && html`<p>Nexus review ${d.review.id}${d.review.auto && ", started on its own"}: ${d.review.phase.kind}, round ${roundsSpent(d.review)} of ${d.review.maxRounds}, by <a href="/threads/${d.review.reviewer}">${d.review.reviewer}</a> on ${d.review.models.reviewer}${d.review.land !== null && ", landing when approved"}${phaseNote(d.review)}</p>${roundNote(d.review) !== null && html`<p class="dim">${roundNote(d.review)}</p>`}${liveNote(d.review) !== null && html`<p class="dim">${liveNote(d.review)}</p>`}${d.review.phase.kind === "needs-person" && html`<ul class="error">${d.review.phase.reasons.map((reason) => html`<li>${reason}</li>`)}</ul>`}${cancellable(d.review) && html`<button type="button" class="btn btn-xs btn-ghost danger" data-action="cancel-review" data-thread="${t.id}" data-confirm="Cancel review ${d.review.id} of pull request #${d.review.pr.number}? Its reviewer thread is archived, and this thread stays as it is.">Cancel review</button>`}`}
${outputs.length === 0 ? html`<p class="empty">No other outputs yet.</p>` : html`<ul class="list outs">${outputs.map((o) => html`<li><span class="o-kind">${outputLabel[o.kind]}</span><code>${o.ref}</code></li>`)}</ul>`}
</section>
${d.claudeWorker === undefined ? "" : html`<section><h2>Claude worker</h2><p>${d.claudeWorker.state} · ${d.claudeWorker.model ?? "unknown"}</p>${d.claudeWorker.message === undefined ? "" : html`<pre>${d.claudeWorker.message}</pre>`}</section>`}
<section aria-labelledby="sessions-h"><h2 id="sessions-h">Sessions ${count(d.sessions.length)}</h2>
${d.sessions.length === 0 ? html`<p class="empty">No sessions.</p>` : html`<ul class="list outs">${d.sessions.map((s) => html`<li>
<span class="o-kind">${harnessNamed(s.harness)?.label}</span>${s.title !== null && html`<span class="s-title">${s.title}</span>`}${s.state === "running" ? state(s.status, sessionTone[s.status])
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
 * the run. A note is a quiet line, such as how long a turn took. A finished call says how long it took when its agent
 * recorded it.
 */
type Item =
  | { kind: "user"; text: string; queued: string | null; at: number; from: PromptFrom; images?: readonly Shot[] }
  | { kind: "agent"; text: string; streaming: boolean; images?: readonly Shot[] }
  | { kind: "tool"; call: { id: string; name: string; arguments: Readonly<Record<string, unknown>> }; result: ToolResult; ms: number | null; task?: Pick<Extract<ClaudeEntry, { kind: "task" }>, "status" | "summary" | "result">; images?: readonly Shot[] }
  /** A Claude worker's AskUserQuestion call, with its question while one was asked for it. */
  | { kind: "ask"; id: string; questions: readonly AskedQuestion[]; result: ToolResult; question: Question | null }
  | { kind: "notice"; text: string; tone: Tone }
  | { kind: "note"; text: string }
  | { kind: "link"; text: string; url: string };
type ToolResult = { state: "done"; output: string; isError: boolean } | { state: "running"; output: string } | { state: "none" };
type ToolItem = Extract<Item, { kind: "tool" }>;
type AskItem = Extract<Item, { kind: "ask" }>;
type UserItem = Extract<Item, { kind: "user" }>;

/** Who a message came from. Nexus's PR watch, review loop and nudge write into a conversation as a user. */
type PromptFrom = PromptSource | "pr-watch" | "review" | "nudge";
/** How a bubble names who a message came from. A person's is said only to a screen reader, as the bubble's side shows it. */
const promptLabel: Record<PromptFrom, string> = {
  person: "You", "pr-watch": "Nexus PR watch", review: "Nexus review", nudge: "Nexus nudge", command: "Slash command", other: "Claude Code",
};

const contentText = (content: UserMessage["content"]) => typeof content === "string" ? content
  : content.map((part: TextContent | ImageContent) => part.type === "text" ? part.text : `[${part.mimeType} image]`).join("");
/** A committed message's text, whose images show as images. */
const textOf = (content: UserMessage["content"]) => typeof content === "string" ? content
  : content.map((part: TextContent | ImageContent) => part.type === "text" ? part.text : "").join("");

/** An image a row shows, linked to its full size. `caption` is a checkout file's path. */
interface Shot { src: string; label: string; caption: string | null }
const imageRoute = (thread: ThreadId, query: Record<string, string | number>) =>
  `/v1/threads/${thread}/image?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`;
const inlineShots = (images: readonly { src: string }[]): Shot[] => images.map(({ src }, i) => ({ src, label: `Image ${i + 1}`, caption: null }));
const transcriptShots = (thread: ThreadId, images: readonly TranscriptImage[] = []): Shot[] => inlineShots(images.map((image) => ({ src: imageRoute(thread, { source: "transcript", ...image }) })));
const fileShots = (thread: ThreadId, paths: readonly string[]): Shot[] => paths.map((path) => ({ src: imageRoute(thread, { source: "file", path }), label: path, caption: path }));
/** A part's hash, once per part, since a page renders the same committed parts again and again. */
const partHashes = new WeakMap<ImageContent, string>();
const partHash = (part: ImageContent) => partHashes.get(part) ?? partHashes.set(part, createHash("sha256").update(part.data).digest("hex")).get(part)!;
/** The image parts of a harness message, each named by its entry's ID, the message's place in the entry, its own place and its hash. */
function harnessShots(thread: ThreadId, entry: number, message: number, content: UserMessage["content"]): Shot[] {
  if (typeof content === "string") return [];
  return inlineShots(content.flatMap((part: TextContent | ImageContent, i) => part.type !== "image" ? []
    : [{ src: imageRoute(thread, { source: "harness", entry, message, part: i, sha256: partHash(part) }) }]));
}

const imageFile = /\.(?:png|jpe?g|gif|webp)$/i;
/** What ends a path in prose: space, quotes, brackets and punctuation, but no period, which a sentence's end strips. */
const pathBreaks = /[\s`'"()<>[\]{}:,;|*!?]+/;
/**
 * The checkout's image files that prose names: bare, in backticks or as a markdown image, relative to the checkout
 * once normalised, at most 6 and each once. A path outside the checkout, as under /tmp, or a URL, is no file the
 * checkout serves.
 */
export function imagePaths(text: string): string[] {
  const paths = new Set<string>();
  for (const word of text.split(pathBreaks)) {
    const token = word.replace(/\.$/, "");
    if (!imageFile.test(token)) continue;
    const path = checkoutPath(token);
    if (path !== null) paths.add(path);
    if (paths.size === 6) break;
  }
  return [...paths];
}
function checkoutPath(path: string): string | null {
  if (path.startsWith("~") || (path.startsWith("/") && !path.startsWith(`${checkoutDir}/`))) return null;
  const relative = posix.normalize(path.startsWith("/") ? path.slice(checkoutDir.length + 1) : path);
  return relative === ".." || relative.startsWith("../") || relative.startsWith("/") ? null : relative;
}
/** The argument naming the file a write tool writes, for pi and for Claude Code. */
const writtenFile: Readonly<Record<string, string>> = { write: "path", Write: "file_path" };
const writtenImages = (name: string, args: Readonly<Record<string, unknown>>): string[] => {
  const path = Object.hasOwn(writtenFile, name) ? args[writtenFile[name]!] : undefined;
  return typeof path === "string" && imageFile.test(path) ? [checkoutPath(path)].filter((p) => p !== null) : [];
};

/**
 * The transcript's messages, then what pi-durable shows of the current run: tool output as it streams, the
 * partial answer and a model request waiting to be retried, then the messages queued behind the run.
 */
function conversationItems(view: ConversationView, thread: ThreadId): Item[] {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const answer = (message: AssistantMessage, streaming: boolean) => {
    for (const part of message.content) {
      if (part.type === "text" && part.text !== "") items.push({ kind: "agent", text: part.text, streaming, ...(streaming ? {} : { images: fileShots(thread, imagePaths(part.text)) }) });
      // A streaming call's arguments are not whole yet. Its committed answer shows it.
      if (part.type === "toolCall" && !streaming) {
        const tool: ToolItem = { kind: "tool", call: part, result: { state: "none" }, ms: null, images: fileShots(thread, writtenImages(part.name, part.arguments)) };
        tools.set(part.id, tool);
        items.push(tool);
      }
    }
    if (message.stopReason === "error") items.push({ kind: "notice", text: `The model failed: ${message.errorMessage ?? "no reason given"}`, tone: "bad" });
    if (message.stopReason === "aborted") items.push({ kind: "notice", text: "Aborted.", tone: "muted" });
  };

  for (const { entry, message, place } of view.entries.flatMap((entry) => (entry.model ?? []).map((message, place) => ({ entry, message, place })))) {
    if (message.role === "user") {
      const text = textOf(message.content);
      items.push({
        kind: "user", text, queued: null, at: message.timestamp, from: entry.kind === "nexus.pr-watch" ? "pr-watch" : entry.kind === "nexus.review" ? "review" : entry.kind === "nexus.nudge" ? "nudge" : "person",
        images: [...harnessShots(thread, entry.id, place, message.content), ...fileShots(thread, imagePaths(text))],
      });
    }
    if (message.role === "assistant") answer(message, false);
    if (message.role === "toolResult") {
      const result: ToolResult = { state: "done", output: textOf(message.content), isError: message.isError };
      const ms = typeof message.durationMs === "number" ? message.durationMs : null;
      const images = harnessShots(thread, entry.id, place, message.content);
      const tool = tools.get(message.toolCallId);
      if (tool === undefined) items.push({ kind: "tool", call: { id: message.toolCallId, name: message.toolName, arguments: {} }, result, ms, images });
      else {
        tool.result = result;
        tool.ms = ms;
        tool.images = [...tool.images ?? [], ...images];
      }
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
    if (queued.mode !== "write") items.push({ kind: "user", text: contentText(queued.content as UserMessage["content"]), queued: queued.mode === "steer" ? "joins after this tool round" : "sends after this run", at: 0, from: "person" });
  }
  return items;
}

const itemsOf = (view: AgentView, questions: readonly Question[], thread: ThreadId): Item[] => view.kind === "claude" ? claudeItems(view.view, questions, thread) : conversationItems(view.view, thread);

/**
 * A Claude worker's transcript as the rows a harness conversation shows. Each result goes on its call, and a
 * background task's finish on the call that started it. A call of the current turn without a result runs while
 * Claude works. An AskUserQuestion call is its own row, with the thread's question for it. A message Claude Code
 * queued and has not taken shows queued at the end. A pull request shows once.
 */
function claudeItems({ entries, working }: ClaudeConversation, questions: readonly Question[], thread: ThreadId): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const calledAt = new Map<string, number>();
  const asks = new Map<string, AskItem>();
  const pullRequests = new Set<string>();
  let turn: ToolItem[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "prompt": items.push({ kind: "user", text: entry.text, queued: null, at: entry.at, from: entry.from, images: [...transcriptShots(thread, entry.images), ...fileShots(thread, imagePaths(entry.text))] }); break;
      case "reply": items.push({ kind: "agent", text: entry.text, streaming: false, images: fileShots(thread, imagePaths(entry.text)) }); break;
      case "tool": {
        const asked = askedIn(entry);
        if (asked !== null) {
          const ask: AskItem = { kind: "ask", id: entry.id, questions: asked, result: { state: "none" }, question: questions.find((q) => q.id === askQuestionId(entry.id)) ?? null };
          asks.set(entry.id, ask);
          items.push(ask);
          break;
        }
        const tool: ToolItem = { kind: "tool", call: { id: entry.id, name: entry.name, arguments: entry.input }, result: { state: "none" }, ms: null, images: fileShots(thread, writtenImages(entry.name, entry.input)) };
        tools.set(entry.id, tool);
        calledAt.set(entry.id, entry.at);
        turn.push(tool);
        items.push(tool);
        break;
      }
      case "result": {
        const result: ToolResult = { state: "done", output: entry.output, isError: entry.isError };
        const images = transcriptShots(thread, entry.images);
        const tool = tools.get(entry.toolUseId) ?? asks.get(entry.toolUseId);
        if (tool === undefined) items.push({ kind: "tool", call: { id: entry.toolUseId, name: "tool", arguments: {} }, result, ms: null, images });
        else {
          tool.result = result;
          if (tool.kind === "tool") tool.images = [...tool.images ?? [], ...images];
        }
        const at = calledAt.get(entry.toolUseId);
        if (tool?.kind === "tool" && at !== undefined && entry.at >= at) tool.ms = entry.at - at;
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
 * while a turn of its session runs, and the harness cannot abort it. An agent waits on the person while a question it
 * asked is open, a Claude worker's dialog waits in its terminal, or a usage limit stopped it. A dialog stops the turn
 * it is in, so it outranks working. A question that does not stop the run, as a planning thread's proposal, does not.
 */
type Run =
  | { kind: "idle"; paused: boolean; repliedAt: number | null }
  | { kind: "working"; since: number | null; tools: number; claude: boolean }
  | { kind: "waiting"; why: string; inTerminal: boolean }
  | { kind: "parked"; tasks: number; busy: boolean };
function runOf(d: ThreadDetail, view: AgentView | null, items: readonly Item[]): Run {
  const claude = view?.kind === "claude";
  const busy = claude ? view.view.working : (view?.view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
  const parked = d.agent?.parkedTasks ?? 0;
  if (parked > 0) return { kind: "parked", tasks: parked, busy };
  const open = (d.questions ?? []).filter((q) => q.answer === null);
  // Attention ranks a reply above a wait, so the session's own state says whether a dialog waits in the terminal.
  const terminal = d.thread.sessionWaiting === true;
  if (terminal || open.some((q) => q.ask !== undefined) || (!busy && (open.length > 0 || d.thread.usageLimit !== undefined))) {
    const why = terminal ? `${d.thread.sessionWaitingMessage ?? "It waits for input"}, in the pylon's terminal.`
      : open.length > 0 ? `${open.length === 1 ? "A question waits" : `${open.length} questions wait`} for your answer, above.`
      : `${usageLimitText(d.thread.usageLimit ?? { resetsAt: null }, Date.now())}.`;
    return { kind: "waiting", why, inTerminal: terminal };
  }
  if (!busy) return { kind: "idle", paused: d.pylon.actualState === "paused", repliedAt: d.lastReplyAt };
  return working(d, items, claude ? (item) => item.from === "person" : () => true, claude);
}

/** A turn's calls are those after the message it answers. Its start is the registry's, so the bar and the rows agree. */
function working(d: ThreadDetail, items: readonly Item[], asks: (item: UserItem) => boolean, claude: boolean): Run {
  const turn = items.slice(items.findLastIndex((item) => item.kind === "user" && item.queued === null && asks(item)) + 1);
  return { kind: "working", since: d.thread.workingSince ?? null, tools: turn.filter((item) => item.kind === "tool").length, claude };
}

/**
 * The agent's state, always in view above the composer, beside the `nexus attach` line to copy. A thread that can
 * attach has a terminal one click away, which a dialog waiting in the terminal offers too.
 */
function stateBar(t: Thread, run: Run, now: number): Html {
  const open = t.status === "active" || t.status === "idle";
  const abort = html`<button type="button" class="btn btn-xs btn-abort" id="abort" data-action="abort" data-thread="${t.id}">Abort</button>`;
  const terminal = html`<button type="button" class="btn btn-xs" data-terminal>${icon("terminal")}Open terminal</button>`;
  const attach = open && html`<span class="attach-line"><code id="attach-line">nexus attach ${t.id}</code><button type="button" class="btn btn-xs btn-ghost" data-copy="attach-line" aria-label="Copy nexus attach ${t.id}">Copy</button></span>`;
  const [label, detail, end] = (() => {
    switch (run.kind) {
      case "idle": return [html`Idle`, html`${run.repliedAt !== null && html`replied ${ago(run.repliedAt, now)}`}${run.paused && html`${run.repliedAt !== null && " · "}the pylon is paused, and a message wakes it`}`, html``];
      case "working": return [html`${run.claude ? "Claude is working" : "Working"}`, html`${run.since !== null && html`<time data-since="${run.since}">${clock(now - run.since)}</time> · `}${run.tools} ${run.tools === 1 ? "tool" : "tools"} this turn`, !run.claude && abort];
      case "waiting": return [html`Waiting for you`, html`${run.why}`, open && run.inTerminal && terminal];
      case "parked": return [html`Stuck`, html`${run.tasks} ${run.tasks === 1 ? "task" : "tasks"} hit the restart limit and hold the run. ${t.status === "archived" ? "Unarchive the thread to retry them." : "Retry runs them again."}`, html`${t.status !== "archived" && html`<button type="button" class="btn btn-xs" id="retry" data-action="retry" data-thread="${t.id}">Retry</button>`}${run.busy && abort}`];
    }
  })();
  return html`<div class="state-bar state-${run.kind}" id="agent-state" data-state="${run.kind}" role="status">${run.kind === "working" ? html`<span class="spin" aria-hidden="true"></span>` : dot(runTone[run.kind])}<span class="state-label">${label}</span><span class="state-detail">${detail}</span>${end}${attach}</div>`;
}
const runTone: Record<Run["kind"], Tone> = { idle: "idle", working: "work", waiting: "busy", parked: "bad" };

/**
 * What the composer's buttons send in each state of the run, the same for both agents: ⌘↵ sends, or steers a run
 * that works, and ⌥↵ queues a message after the run. A Claude worker takes a message at its next step whatever the
 * mode, so only a Nexus agent's run can be queued after.
 */
function sends(run: Run, claude: boolean): { primary: "send" | "steer"; queue: boolean } {
  const steers = run.kind === "working";
  return { primary: steers ? "steer" : "send", queue: steers && !claude };
}
const sendLooks = {
  send: { mode: "followUp", label: "Send", placeholder: "Message the agent…", hint: null },
  steer: { mode: "steer", label: "Steer", placeholder: "Steer the run…", hint: "Steer joins the run after its current tool round." },
} as const;

/**
 * Why a thread takes no messages, or the prompt box. A Claude worker's box is marked for client.js, which tries a
 * send again while the pylon wakes, and says how old the transcript is while the pylon does not run.
 */
function composer(d: ThreadDetail, agent: ThreadAgent["kind"], run: Run, model: string | null, claude: ClaudeConversation | null, now: number): Html {
  const { thread: t } = d;
  if (t.status === "deleted" || (agent !== "harness" && claude === null)) return html``;
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
  const { primary, queue } = sends(run, claude !== null);
  const look = sendLooks[primary];
  const placeholder = claude !== null && primary === "send" ? "Message Claude…" : look.placeholder;
  const hint = claude !== null && primary === "steer" ? "Claude takes it at its next step." : look.hint;
  return html`<form id="prompt" class="composer composer-${primary}" data-thread="${t.id}"${claude !== null && " data-claude"}>
${asOf !== null && html`<p class="comp-note">${asOf} Sending a message wakes it and resumes Claude.</p>`}
<div class="comp-box">
<textarea id="prompt-text" name="text" rows="2" required aria-label="${claude === null ? "Message the agent" : "Message Claude"}" placeholder="${placeholder}"></textarea>
<div class="comp-foot">${model !== null && html`<span class="chip chip-model">${model}</span>`}${hint !== null && html`<span class="dim small comp-hint">${hint}</span>`}<span class="comp-sends">${queue && html`<button type="submit" class="btn btn-ghost send-alt" id="queue" name="mode" value="followUp" title="Queue after this run (⌥↵)">Queue <kbd>⌥↵</kbd></button>`}<button type="submit" class="send send-${primary}" id="send" name="mode" value="${look.mode}" title="${look.label} (⌘↵)">${icon("up")}<span class="send-label">${look.label}</span> <kbd>⌘↵</kbd></button></span></div>
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

function blockView(block: Block, now: number): Html {
  switch (block.kind) {
    case "user": {
      const from: PromptFrom = block.from !== "person" ? block.from : block.text.startsWith("[Nexus PR watch") ? "pr-watch" : block.text.startsWith("[Nexus review") ? "review" : block.text.startsWith("[Nexus nudge") ? "nudge" : "person";
      const named = from !== "person" && from !== "pr-watch" && from !== "review" && from !== "nudge";
      return html`<div class="msg user${block.queued !== null && " queued"}">${!named && unseen(promptLabel[from])}${(named || block.queued !== null) && html`<div class="msg-who">${named && html`<span class="chip chip-from">${promptLabel[from]}</span>`}${block.queued !== null && html`<span class="chip chip-queued">queued, ${block.queued}</span>`}</div>`}<div class="text">${prose(block.text)}</div>${shotsView(block.images)}</div>`;
    }
    case "agent": return block.streaming
      ? html`<div class="msg agent streaming"><div class="text" data-grow>${grows(prose(block.text, html`<span class="caret" aria-hidden="true"></span>`))}</div></div>`
      : html`<div class="msg agent"><div class="text">${prose(block.text)}</div>${shotsView(block.images)}</div>`;
    case "notice": return html`<p class="notice notice-${block.tone}"><span class="notice-mark" aria-hidden="true">!</span>${block.text}</p>`;
    case "note": return html`<p class="note">${block.text}</p>`;
    case "link": return html`<p class="note"><a class="link" href="${block.url}" target="_blank" rel="noopener">${block.text} ↗</a></p>`;
    case "tools": return stepsView(block.tools);
    case "ask": return askView(block, now);
  }
}

/**
 * A Claude worker's AskUserQuestion in the conversation: its questions and options, with what the person picked on
 * the dashboard, their own answer and notes, and from which device, or what Claude got when the terminal answered.
 */
function askView(item: AskItem, now: number): Html {
  const answer = item.question?.answer ?? null;
  const choices = answer?.choices;
  const status = answer !== null ? html`Answered from ${answer.by}, ${ago(answer.at, now)}.`
    : item.result.state === "done" ? (item.result.isError ? "Not answered." : "Answered in the terminal.")
    : item.question !== null ? "Waits for your answer below." : "Not answered.";
  return html`<section class="ask-card" id="ask-${item.id}" aria-label="Claude asked">
<p class="ask-head">Claude asked</p>
${item.questions.map((q, i) => {
  const choice = choices?.[i];
  return html`<div class="ask-q"><p class="ask-question"><span class="tag">${q.header}</span> ${q.question}</p>
<ul class="ask-picks">${q.options.map((o) => {
  const picked = choice?.picked.includes(o.label) === true;
  return html`<li${picked && html` class="picked"`}>${picked && html`<span class="ask-mark">✓ </span>`}<span class="ask-label">${o.label}</span>${o.description !== "" && html` <span class="ask-desc">${o.description}</span>`}${picked && o.preview !== undefined && html`<pre class="ask-preview">${o.preview}</pre>`}</li>`;
})}</ul>
${choice?.own !== undefined && html`<p class="ask-said">Own answer: ${choice.own}</p>`}${choice?.notes !== undefined && html`<p class="ask-said">Notes: ${choice.notes}</p>`}</div>`;
})}
${choices === undefined && item.result.state === "done" && html`<pre class="t-out">${item.result.output}</pre>`}
<p class="land-meta">${status}</p>
</section>`;
}

/** Each image links to its full size in a new tab. A broken one becomes a note, which client.js writes. */
const shotsView = (images: readonly Shot[] = []) => images.length > 0 && html`<div class="shots">${images.map((shot) =>
  html`<a class="shot" href="${shot.src}" target="_blank" rel="noopener"><img src="${shot.src}" alt="${shot.label}" loading="lazy">${shot.caption !== null && html`<span class="shot-cap">${shot.caption}</span>`}</a>`)}</div>`;

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
 * How a tool's calls read, by its name, pi's in lower case and Claude Code's capitalized: the name its row shows, one
 * for both agents, the argument that says what a call did, shown in its row, one shown whole as text, what it
 * changes, the argument naming the file it acts on, so a fold counts a file once, and the action a fold counts it under.
 */
interface ToolLook {
  label: string;
  subject?: string;
  text?: string;
  diff?: (args: Args) => Diff | null;
  file?: string;
  action?: Action;
}
const toolLooks: Readonly<Record<string, ToolLook>> = {
  read: { label: "Read", subject: "path", file: "path", action: "read" },
  bash: { label: "Bash", subject: "command", action: "command" },
  edit: { label: "Edit", subject: "path", file: "path", diff: editsDiff("oldText", "newText"), action: "change" },
  write: { label: "Write", subject: "path", file: "path", diff: contentDiff, action: "change" },
  grep: { label: "Grep", subject: "pattern", action: "search" },
  find: { label: "Find", subject: "pattern", action: "search" },
  ls: { label: "List", subject: "path", action: "search" },
  Read: { label: "Read", subject: "file_path", file: "file_path", action: "read" },
  Bash: { label: "Bash", subject: "command", action: "command" },
  Edit: { label: "Edit", subject: "file_path", file: "file_path", diff: stringDiff, action: "change" },
  MultiEdit: { label: "MultiEdit", subject: "file_path", file: "file_path", diff: editsDiff("old_string", "new_string"), action: "change" },
  Write: { label: "Write", subject: "file_path", file: "file_path", diff: contentDiff, action: "change" },
  Grep: { label: "Grep", subject: "pattern", action: "search" },
  Glob: { label: "Glob", subject: "pattern", action: "search" },
  Agent: { label: "Agent", subject: "description", text: "prompt", action: "subagent" },
  WebFetch: { label: "Fetch", subject: "url", action: "fetch" },
  WebSearch: { label: "Search", subject: "query", action: "web" },
  TodoWrite: { label: "Todos", action: "todo" },
  shell: { label: "Shell", subject: "command", action: "command" },
};
/** The arguments that say what a call of a tool without a look did, the first one it has. */
const subjectKeys = ["command", "pattern", "path", "url"];
/** A tool without a look shows its name, and an MCP server's tool, named mcp__server__tool, its own part of it. */
const lookOfTool = (name: string): ToolLook => Object.hasOwn(toolLooks, name) ? toolLooks[name]! : { label: /^mcp__.+?__(.+)$/.exec(name)?.[1] ?? name };
const textArg = (args: Args, key: string | undefined) => key !== undefined && typeof args[key] === "string" ? { key, value: args[key] as string } : undefined;
const subjectOf = (call: ToolItem["call"]) => {
  const { subject } = lookOfTool(call.name);
  return textArg(call.arguments, subject ?? subjectKeys.find((k) => typeof call.arguments[k] === "string"));
};
/**
 * A subject as its row shows it. Claude Code passes paths in the checkout whole and pi relative to it, so both read
 * relative. A value of many lines, as a heredoc command, shows its first.
 */
const shortSubject = (value: string) => {
  const [first, ...more] = value.split(`${checkoutDir}/`).join("").trim().split("\n");
  return more.length === 0 ? first : `${first} …`;
};
/** How long a call took: 840 ms, 2.4 s, then as a clock reads it. */
const took = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : clock(ms);

const failed = ({ result }: ToolItem) => result.state === "done" && result.isError;
/** pi's bash tool ends a failed command's output with its exit code, and Claude Code's starts with it. */
const exitCode = (output: string) => /exited with code (\d+)|^Exit code (\d+)/.exec(output)?.slice(1).find((code) => code !== undefined);

/** How a row's mark says how its call went, to the eye and to a screen reader. */
const toolMarks = {
  ok: { mark: icon("check"), said: "succeeded" },
  bad: { mark: icon("cross"), said: "failed" },
  run: { mark: html`<span class="spin"></span>`, said: "running" },
  none: { mark: icon("dash"), said: "no result" },
} as const;
/** A finished call's output of more than clipOver lines shows its first clipTo, with the rest one click away. */
const clipOver = 30;
const clipTo = 12;
function clipped<T>(id: string, lines: readonly T[], pre: (lines: readonly T[], part: string) => Html): Html {
  if (lines.length <= clipOver) return pre(lines, "");
  return html`${pre(lines.slice(0, clipTo), " t-head")}<details class="t-more" id="${id}"><summary data-more>Show all ${lines.length} lines</summary>${pre(lines.slice(clipTo), " t-rest")}</details>`;
}

/**
 * One line per call: how it went, its tool, its subject, its size and how long it took. Its body holds the whole
 * subject, the other arguments, the change and the output.
 */
function toolView(tool: ToolItem): Html {
  const { call, result, task, ms } = tool;
  const look = lookOfTool(call.name);
  const subject = subjectOf(call);
  const text = textArg(call.arguments, look.text);
  const diff = look.diff?.(call.arguments) ?? null;
  const rest = Object.fromEntries(Object.entries(call.arguments).filter(([key]) => key !== subject?.key && key !== text?.key && !diff?.keys.includes(key)));
  const output = result.state === "none" ? "" : result.output;
  const outLines = output === "" ? [] : output.trimEnd().split("\n");
  const bad = failed(tool);
  const running = result.state === "running";
  const state = running ? "run" : result.state === "none" ? "none" : result.isError ? "bad" : "ok";
  // Only what needs a look starts open: a failure, an edit's diff, an image and a call still running.
  const open = bad || diff !== null || running || (tool.images?.length ?? 0) > 0;
  const added = diff?.lines.filter(([sign]) => sign === "+").length ?? 0;
  // A running call's line count and output grow in place, so a reader scrolled in its output keeps their place.
  const grow = (inside: Part) => running ? grows(inside) : inside;
  const size = diff !== null ? html`<span class="add">+${added}</span> <span class="del">−${diff.lines.length - added}</span>` : outLines.length > 0 && `${outLines.length} ${outLines.length === 1 ? "line" : "lines"}`;
  const exit = bad && (exitCode(output) === undefined ? "failed" : `exit ${exitCode(output)}`);
  const { mark, said } = toolMarks[state];
  return html`<details class="tool${bad && " failed"}${running && " running"}" id="tool-${call.id}"${open && " open"}>
<summary><span class="t-mark ${state}" role="img" aria-label="${said}" title="${said}">${mark}</span><span class="t-name"${look.label.toLowerCase() !== call.name.toLowerCase() && html` title="${call.name}"`}>${look.label}</span><span class="t-subj">${subject !== undefined && shortSubject(subject.value)}</span><span class="t-meta"><span class="t-size"${running && " data-grow"}>${grow(size)}</span>${exit && html`<span class="t-exit">${exit}</span>`}</span>${ms !== null && html`<span class="t-time">${took(ms)}</span>`}<span class="chev" aria-hidden="true">›</span></summary>
${subject !== undefined && html`<pre class="t-full">${subject.value}</pre>`}
${text !== undefined && html`<div class="t-text">${prose(text.value)}</div>`}
${Object.keys(rest).length > 0 && html`<pre class="t-args">${JSON.stringify(rest, null, 2)}</pre>`}
${diff !== null && clipped(`more-${call.id}-diff`, diff.lines, (lines, part) => html`<pre class="t-out diff${part}">${lines.map(([sign, line]) => html`<span class="d d-${sign === "+" ? "add" : "del"}">${sign === "+" ? "+" : "−"} ${line}</span>`)}</pre>`)}
${(diff === null || bad) && (output === "" ? (tool.images?.length ?? 0) === 0 && html`<p class="t-empty">${running ? "No output yet." : "No output."}</p>`
    : running ? html`<pre class="t-out" data-grow>${grows(output)}</pre>`
    : clipped(`more-${call.id}`, outLines, (lines, part) => html`<pre class="t-out${part}">${lines.join("\n")}</pre>`))}
${shotsView(tool.images)}
${task !== undefined && html`<p class="t-task">Background task ${task.status}: ${task.summary}</p>${task.result !== null && html`<div class="t-text">${prose(task.result)}</div>`}`}
</details>`;
}

/** How many actions a fold names before it counts the tools of the rest. */
const phrasesShown = 3;

/**
 * What a run of calls did: Ran 3 commands, changed 2 files. Calls on the same path count once, so an edit and a
 * write to one file are one changed file. Each tool without a look is its own action, named as its row names it.
 */
function stepsSummary(tools: readonly ToolItem[]): string {
  const done = new Map<string, { phrase: Phrase; seen: Set<string>; names: Set<string> }>();
  for (const { call } of tools) {
    const look = lookOfTool(call.name);
    const key = look.action === undefined ? `tool ${call.name}` : look.action;
    const action = done.get(key) ?? { phrase: look.action === undefined ? unknownTool(look.label) : actions[look.action], seen: new Set(), names: new Set() };
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

/** A fold of more calls than this starts closed, unless one failed or still runs. */
const foldOver = 5;

/**
 * A lone call is its own line. A run of calls folds under a line that says what they did, so a busy turn does not
 * bury the answer around it. A long fold starts closed, and opens itself when a call failed or is still running,
 * which is when the reader needs to see it.
 */
function stepsView(tools: readonly ToolItem[]): Html {
  if (tools.length === 1) return html`<div class="tools">${toolView(tools[0]!)}</div>`;
  const bad = tools.filter(failed).length;
  const running = tools.filter((t) => t.result.state === "running").length;
  return html`<details class="steps${bad > 0 && " has-bad"}" id="steps-${tools[0]!.call.id}"${(tools.length <= foldOver || bad > 0 || running > 0) && " open"}>
<summary><span class="s-names">${stepsSummary(tools)}</span>${bad > 0 && html`<span class="s-bad">${bad} failed</span>`}${running > 0 && html`<span class="s-run"><span class="spin" aria-hidden="true"></span>${running} running</span>`}<span class="s-count">${tools.length} calls</span><span class="chev" aria-hidden="true">›</span></summary>
<div class="tools">${tools.map(toolView)}</div>
</details>`;
}

function notFound(c: Context, message: string): Html {
  return layout(c, {
    title: "Not found",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Not found</h1></div></header>
<div class="scroll"><div class="page"><p>${message}</p><p><a class="link" href="/">All threads</a></p></div></div>`,
  });
}
