/**
 * Renders the console every page shares: the layout, the sidebar of threads by project, the start and add-project
 * dialogs, and the not-found page.
 */
import { diskText, lowDisk } from "../../disk-space.ts";
import { countedCapacity } from "../../protocol/observations.ts";
import { defaultProjectResources } from "../project.ts";
import { githubTokenGrant } from "../../secret-grants.ts";
import { defaultClaudeModel } from "../../claude-state.ts";
import type { NodeRecord } from "../node-store.ts";
import type { Thread } from "../thread-store.ts";
import type { ThreadId } from "../../ids.ts";
import { gib, nodePylons, overcommitted } from "../placement.ts";
import type { QueuedThread } from "../queue.ts";
import { releaseView } from "../releases.ts";
import { span } from "./elapsed.ts";
import { themeScript, Html, html, dot, icon, clonedIcons, menu, threadState, dims, workingFor, type Tone } from "./view.ts";
import type { Context } from "./context.ts";
import { assetUrl } from "./assets.ts";

/** How often the client refetches a page. The loop ticks every 5 s, so polling faster shows nothing new. */
export const pollMs = 5_000;

/** The themes the sidebar's picker offers. Each but System is a block of style.css, and System is the device's light or dark. */
export const themes = [["system", "System"], ["light", "Light"], ["dark", "Dark"], ["tokyo-night", "Tokyo Night"], ["catppuccin-mocha", "Catppuccin Mocha"], ["kanagawa-wave", "Kanagawa Wave"]] as const;

export interface Shell {
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

export function layout(c: Context, page: Shell): Html {
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
<template id="icons">${clonedIcons.map(icon)}</template>
${startDialog(c, page.start)}
${projectDialog(c, page.addProject === true)}
<noscript><p class="noscript">Adding projects, starting, archiving and deleting threads, sending messages and live updates need JavaScript.</p></noscript>
</body>
</html>
`;
}

/** A project's threads, newest first: the open ones, and the archived or deleted ones folded below them. */
export function threadsOf(c: Context, project: string) {
  const threads = c.threadsIn(project).toReversed();
  const closed = (t: Thread) => t.status === "archived" || t.status === "deleted";
  return { open: threads.filter((t) => !closed(t)), closed: threads.filter(closed) };
}
/** A blocked thread waits for the person, as a review that ended for them does. */
export function queuedLook(q: QueuedThread): [label: string, tone: Tone] {
  if (q.status !== "queued") return [q.status === "archived" ? "cancelled" : "deleted", "muted"];
  return q.blocked ? ["blocked", "bad"] : ["queued", "idle"];
}

/** A thread's title, started or queued. */
export const threadTitle = (c: Context, id: ThreadId) => c.registry.thread(id)?.title ?? c.registry.queuedThread(id)?.title ?? id;
const lastActive = (t: Thread) => Math.max(t.createdAt, t.lastHumanActivityAt, t.lastAgentActivityAt);
export function closedLabel(threads: readonly Thread[]): string {
  const deleted = threads.filter((t) => t.status === "deleted").length;
  const archived = threads.length - deleted;
  return [archived > 0 && `${archived} archived`, deleted > 0 && `${deleted} deleted`].filter(Boolean).join(", ");
}

function sidebar(c: Context, active: ThreadId | undefined, nav: Shell["nav"]): Html {
  const projects = c.registry.projects();
  const releases = Map.groupBy(releaseLines(c), (r) => r.node);
  // A thread works in its own checkout, as a Jetline workspace does, so its row shows a branch with its state as a badge.
  const row = (t: Thread) => {
    const r = c.row(t);
    const [label, tone] = threadState(r, c.now);
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
  const queued = c.queuedIn(p.id);
  // A project folds like a folder. client.js remembers which ones the reader folded.
  return html`<details class="group" id="group-${p.id}" open>
<summary class="group-h">${icon("chevron")}${icon("folder")}<span class="group-name"><span>${p.id}</span><span class="group-branch">${p.defaultBranch}</span></span></summary>
<a class="group-new" href="/threads/new?project=${encodeURIComponent(p.id)}" data-start="${p.id}" aria-label="New thread in ${p.id}" title="New thread in ${p.id}">${icon("plus")}</a>
${open.length + queued.length > 0 && html`<ul>${open.map(row)}${queued.map(queuedRow)}</ul>`}
${closed.length > 0 && html`<details class="archived" id="archived-${p.id}"${closed.some((t) => t.id === active) && " open"}><summary>${closedLabel(closed)}</summary><ul>${closed.map(row)}</ul></details>`}
</details>`;
})}
</nav>
<div class="nodes" id="side-nodes" data-live aria-label="Nodes"><h2>Nodes</h2><small>Desired release: ${c.registry.desiredRelease()?.commit.slice(0, 12) ?? "manual"}</small>${c.registry.nodes().map((n) => html`<span>${icon("server")}<a class="link" href="/nodes/${encodeURIComponent(n.name)}" title="Health of ${n.name}">${n.name}</a>${dot(n.state === "online" ? "ok" : "muted")}${n.state === "offline" && html`<em>offline</em>`}${overcommitted(n.capacity) && html`<em>overcommitted</em>`}${lowDisks(n).length > 0 && html`<em title="${lowDisks(n).map(diskText).join("; ")}">disk low</em>`}</span>${memoryLine(c, n)}${releases.get(n.name)?.map((r) => html`<small title="${r.reason ?? ""}">${r.role}: ${r.commit?.slice(0, 12) ?? "unknown"} · ${r.state}</small>`)}`)}</div>
<div class="side-theme"><label class="theme-pick" title="Theme">${icon("palette")}<span class="vh">Theme</span><select id="theme">${themes.map(([name, label]) => html`<option value="${name}">${label}</option>`)}</select></label><button type="button" class="icon-btn" id="theme-toggle" aria-label="Switch between light and dark" title="Switch between light and dark">${icon("contrast")}</button></div>
<a class="btn side-add" href="/projects/new" data-new-project>New project</a>
</aside>`;
}

/**
 * Each node's release as `GET /v1/release` reports it. The dashboard is not told which node is the control node, but
 * the API takes a control report only from the control node, so the node that holds one is it, and the view gives a
 * control line to that node alone, as it does to the control node.
 */
function releaseLines(c: Context) {
  const control = c.registry.releaseReports().find((r) => r.role === "control")?.node;
  return releaseView(c.registry, c.registry.nodes().find((n) => n.name === control)?.tailnetNodeId, c.now).nodes;
}

const lowDisks = (n: NodeRecord) => countedCapacity(n.capacity)?.disks?.filter(lowDisk) ?? [];

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
<input id="start-model" name="model" autocomplete="off" placeholder="${defaultClaudeModel}">
<p class="hint"><code>${defaultClaudeModel}</code> unless you name another.</p>
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
${nodeOptions(nodes)}
</select></div>
<div><label for="start-branch">Branch</label><input id="start-branch" name="branch" autocomplete="off" placeholder="${chosen.defaultBranch}"></div>
</div>
<div class="two three">
<div><label for="start-cpus">CPUs</label><input id="start-cpus" name="cpus" type="number" min="1" step="1" inputmode="numeric" placeholder="${chosen.resources.cpus}"></div>
<div><label for="start-memory">Memory (GiB)</label><input id="start-memory" name="memoryGiB" type="number" min="1" step="1" inputmode="numeric" placeholder="${chosen.resources.memoryGiB}"></div>
<div><label for="start-disk">Disk (GiB)</label><input id="start-disk" name="diskGiB" type="number" min="1" step="1" inputmode="numeric" placeholder="${chosen.resources.diskGiB}"></div>
</div>
<p class="hint" id="start-hint" data-image="${image ?? ""}"></p>
<p id="start-error" class="error" role="alert" hidden></p>
<footer><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Start thread<kbd>⌘↵</kbd></button></footer>
</form>`}
</div>
</dialog>`;
}

const nodeOptions = (nodes: readonly NodeRecord[]) => nodes.map((n) => html`<option value="${n.name}">${n.name}${n.state === "offline" && ", offline"}</option>`);

export const newProjectButton = html`<a class="btn btn-primary" href="/projects/new" data-new-project>New project</a>`;

/**
 * The fields `nexus project add` asks for. The node is `auto` unless changed to one of the known nodes, as `nexus
 * project add` without --node, and the API's own checks, such as for an ID that exists, answer in the dialog. GitHub
 * access is the one secret grant the dialog offers, githubTokenGrant, which the form carries for client.js to send.
 * Nodes come from the control plane's config and change only with a restart, so the dialog is not refreshed with the page.
 */
function projectDialog(c: Context, open: boolean): Html {
  const nodes = c.registry.nodes();
  const { cpus, memoryGiB, diskGiB } = defaultProjectResources;
  return html`<dialog id="project-dialog" class="modal" aria-labelledby="project-h"${open && " data-autoopen"}>
<header><h2 id="project-h">New project</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
${nodes.length === 0 ? html`<p class="empty modal-empty">No nodes yet, so a project has nowhere to run.</p>` : html`<form id="project" class="form" data-resources="${JSON.stringify(defaultProjectResources)}" data-github-grant="${JSON.stringify(githubTokenGrant)}">
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
${nodeOptions(nodes)}
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

export function notFound(c: Context, message: string): Html {
  return layout(c, {
    title: "Not found",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Not found</h1></div></header>
<div class="scroll"><div class="page"><p>${message}</p><p><a class="link" href="/">All threads</a></p></div></div>`,
  });
}
