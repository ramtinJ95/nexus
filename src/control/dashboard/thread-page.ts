/**
 * Renders a thread's page and a queued thread's page: the conversation, the inspector and the pylon's
 * facts and sessions.
 */
import { desiredPhase, isOpenStatus } from "../reconcile.ts";
import { linkedPort } from "../../services-file.ts";
import { harnessNamed, type SessionHarness } from "../../protocol/agent-kinds.ts";
import type { ServerDetail, ThreadDetail, ThreadRow } from "../wire.ts";
import type { NodeRecord } from "../node-store.ts";
import type { Preview, Thread } from "../thread-store.ts";
import type { ThreadId } from "../../ids.ts";
import { freshVm, liveNote, plannerGaveUp, prWatchText, reviewersNote, reviewLine, roundNote, sessionPaused } from "../wording.ts";
import type { QueuedThread, Wait } from "../../contract/threads.ts";
import { tokenCount, type UsageTotals } from "../../contract/usage.ts";
import { factsData } from "./contract.ts";
import { attentionLabels } from "../plain-wording.ts";
import { Html, html, act, dataset, attentionTone, actualBadge, desiredTone, sessionTone, outputLabel, dot, state, icon, menu, threadState, ago, workingFor, type Part, type Tone } from "./view.ts";
import type { Context, ThreadView } from "./context.ts";
import { prose } from "./markdown.ts";
import { modelOf } from "./items.ts";
import { runOf, stateBar, composer, type Run } from "./conversation.ts";
import { isOpen } from "../questions.ts";
import { convo, shownKey } from "./live-frames.ts";
import { judgmentCards, questionCards, landing, cancelReview, nudgeCard, resumeCard } from "./cards.ts";
import { layout, queuedLook } from "./shell.ts";
import { lifeOfThread, roleLine } from "./lifecycle.ts";
import { lifeTrack, timeline } from "./timeline.ts";
import { usageColumns, exact } from "./usage-page.ts";

const waitTone: Record<Wait["state"], Tone> = { waiting: "idle", landed: "ok", blocked: "bad" };

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
export function threadPage(c: Context, page: ThreadView, streaming = false): Html {
  const { d, row, node, role, agent, usage, view, items, renderedReplyAt, nudged, lands } = page;
  const { thread: t } = d;
  const read = view === null || view instanceof Error ? null : view;
  const run = runOf(d, read, items, c.now);
  const model = d.claudeWorker !== undefined ? d.claudeWorker.model : read === null || read.kind === "claude" ? null : modelOf(read.view);
  const shows = streaming && read !== null ? shownKey(read, model) : null;
  const open = isOpenStatus(t.status);
  const life = role === "builder" ? lifeOfThread(c, t.id) : null;
  const bar = threadBar(t, headState(d, row, run, c.now), [
    t.status !== "deleted" && archiveButton(t.id, t.status === "archived", archiveLoses(d, run)),
    t.status !== "deleted" && html`<button type="button" class="btn btn-ghost danger" id="delete"${act("delete")} data-thread="${t.id}" data-confirm="Delete &quot;${t.title}&quot;? Its pylon and disk are removed.">Delete</button>`,
  ], d.planning === true && html` <span class="tag" id="planning" title="Its proposed items become cards you accept or reject">planning</span>`);
  return layout(c, {
    title: t.title,
    active: t.id,
    ...(open ? { activity: t.id } : {}),
    main: html`${bar}
${role === "builder" ? html`<nav class="life-bar" id="life" data-live aria-label="Stages">${lifeTrack(life!)}</nav>` : html`<div class="life-bar" id="life" data-live>${roleLine(c, t.id, role)}</div>`}
<div class="tabs" id="tabs" role="tablist" aria-label="Open views" data-thread="${t.id}"><button type="button" class="tab active" role="tab" aria-selected="true" aria-controls="scroll" data-tab="convo">${icon("chat")}<span class="tab-name">${t.title}</span></button>${life !== null && html`<button type="button" class="tab tab-tl" role="tab" aria-selected="false" aria-controls="timeline-view" data-tab="timeline">${icon("timeline")}<span class="tab-name">Timeline</span></button>`}${t.status !== "deleted" && html`<button type="button" class="tab tab-term"${!open && " hidden"} role="tab" aria-selected="false" aria-controls="term-view" data-tab="term" title="A terminal in the pylon, as nexus attach ${t.id} gives">${icon("terminal")}<span class="tab-name">Terminal</span></button>`}</div>
<div class="strip" id="strip" data-live>${strip(d)}</div>
<div id="facts" data-live hidden>${facts(d)}</div>
${life !== null && html`<section class="timeline-view" id="timeline-view" role="tabpanel" aria-label="Timeline" hidden><div class="tl-wrap" id="timeline" data-live>${timeline(c, page, life)}</div></section>`}
<div class="scroll" id="scroll" role="tabpanel"><div class="convo" id="convo" data-rendered-reply-at="${read === null ? "" : renderedReplyAt ?? ""}"${shows !== null && html` data-shows="${shows}"`} data-live${agent.kind !== "none" && t.status !== "deleted" && html` data-stream="/threads/${t.id}/stream"`}>${shows === null && convo(t, view, items, model, c.now)}</div></div>
<section class="file-view" id="file-view" role="tabpanel" aria-label="File diff" hidden></section>
${t.status !== "deleted" && termView(t)}
<div class="dock">
<p id="action-status" class="comp-note" role="status" hidden></p>
<div id="judgments" data-live>${judgmentCards(c, d)}</div>
<div id="questions" data-live>${questionCards(c, d)}</div>
<div id="nudge" data-live>${nudged && nudgeCard(t)}</div>
<div id="resume" data-live>${d.resume?.state === "person" && resumeCard(t, d.resume.why)}</div>
<div id="landing" data-live>${landing(c, d, lands)}</div>
<div id="run" data-live>${(open || (t.status === "archived" && run.kind === "parked")) && stateBar(t, run, c.now)}</div>
<div id="composer" data-live>${composer(d, agent.kind, run, model, read?.kind === "claude" ? read.view : null, c.now)}</div>
</div>`,
    inspector: inspector(d, node, c.now, usage, agent.kind === "claude" ? agent.worker.session : null),
  });
}

/**
 * The terminal tab, which client.js attaches on its first show, as `nexus attach` does, and shows while the thread is
 * open, so an unarchive brings it back without a reload. A Nexus agent runs on the control plane, so its thread's
 * terminal is the pylon's Herdr session and its conversation stays in the composer. A Claude worker's lands in its
 * pane, but Show in terminal moves it to any session's, so the head names the whole session.
 */
function termView(t: Thread): Html {
  return html`<section class="term-view" id="term-view" role="tabpanel" aria-label="Terminal" hidden>
<div class="tv-head"><span class="tv-where">The pylon's Herdr session</span><span class="tv-status" id="term-status" role="status"></span><button type="button" class="btn btn-xs" id="term-again" hidden>Attach again</button><button type="button" class="btn btn-xs btn-ghost" id="term-detach" hidden>Detach</button></div>
<p class="tv-clip" id="term-copied" role="status" hidden></p><p class="tv-clip" id="term-refused" role="status" hidden></p>
<div class="tv-host" id="term-host"></div>
</section>`;
}

/**
 * The header's state never contradicts the dock's. While the pylon runs and nothing outranks the agent, it is the
 * agent's state, in the dock's words, since a running pylon above an idle agent reads as a contradiction. Otherwise it
 * is the thread's attention, its archive or its pylon's state, which the dock either agrees with or does not say.
 */
function headState(d: ThreadDetail, row: ThreadRow, run: Run, now: number): readonly [string, Tone] {
  const own = threadState(row, now);
  const open = isOpenStatus(d.thread.status);
  if (!open || d.pylon.actualState !== "running" || (d.attention !== null && d.attention !== "working")) return own;
  return run.kind === "working" ? [attentionLabels.working, attentionTone.working] : run.kind === "idle" ? ["agent idle", "idle"] : own;
}

/** The bar atop a thread's page or a queued thread's: where it is, its state, and its actions, which a phone folds under ⋯. */
function threadBar(t: { project: string; title: string }, [label, tone]: readonly [string, Tone], actions: readonly Part[], tag: Part = null): Html {
  const shown = actions.filter((a) => a !== false);
  return html`<header class="bar" id="bar" data-live>
${menu}
<div class="crumb"><a class="crumb-p" href="/">${t.project}</a><span class="sep" aria-hidden="true">/</span><h1>${t.title}</h1>${tag}</div>
<span class="chip chip-${tone}">${dot(tone)}<span class="chip-label">${label}</span></span>
${shown.length > 0 && html`<div class="bar-actions" id="thread-actions">${shown}</div><button type="button" class="icon-btn more" data-open="actions" aria-label="Thread actions" aria-controls="thread-actions">⋯</button>`}
</header>`;
}

/** Archive asks first only when `confirm` says what it loses. */
const archiveButton = (id: ThreadId, archived: boolean, confirm: string | null = null) => archived
  ? html`<button type="button" class="btn btn-ghost" id="unarchive"${act("unarchive")} data-thread="${id}">Unarchive</button>`
  : html`<button type="button" class="btn btn-ghost" id="archive"${act("archive")} data-thread="${id}"${confirm !== null && html` data-confirm="${confirm}"`}>Archive</button>`;

/**
 * What archiving the thread loses, or null when nothing: the open questions an archive withdraws, a failed pylon's
 * judgment and a Claude worker's asks, and the turn its agent is in, whose pylon goes to sleep at once.
 */
function archiveLoses(d: ThreadDetail, run: Run): string | null {
  const questions = d.questions.filter((q) => (q.kind === "judgment" || q.kind === "ask") && isOpen(q));
  const named = questions.map((q) => `"${q.text.split("\n")[0]}"`).join(", ");
  const lost = [
    questions.length > 0 && (questions.length === 1 ? `Its open question ${named} is withdrawn.` : `Its ${questions.length} open questions ${named} are withdrawn.`),
    (run.kind === "working" || (run.kind === "parked" && run.busy)) && "Its agent is in a turn, and its pylon goes to sleep at once.",
  ].filter((part) => part !== false);
  return lost.length === 0 ? null : `Archive "${d.thread.title}"? ${lost.join(" ")}`;
}

/**
 * A thread that has not started: what it waits for, what it will start with, and the actions a queued thread has. It
 * has no conversation or pylon, so it has no inspector and counts no visit.
 */
export function queuedPage(c: Context, q: QueuedThread): Html {
  const { cpus, memoryGiB, diskGiB } = q.resources;
  return layout(c, {
    title: q.title,
    active: q.id,
    main: html`${threadBar(q, queuedLook(q), [
      q.status === "queued" && html`<button type="button" class="btn" id="start-queued"${act("start-queued")} data-thread="${q.id}">Start now</button>`,
      q.status !== "deleted" && archiveButton(q.id, q.status === "archived"),
    ])}
<nav class="life-bar" id="life" data-live aria-label="Stages">${lifeTrack(lifeOfThread(c, q.id), false)}</nav>
<div class="scroll"><div class="page queued" id="queued" data-live>
<section aria-labelledby="waits-h"><h2 id="waits-h">Starts once these threads' pull requests merge</h2>
<ul class="list">${q.waits.map((w) => html`<li>${state(w.state, waitTone[w.state])} <a class="link" href="/threads/${w.thread}">${c.title(w.thread)}</a>: ${w.why}</li>`)}</ul>
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
</div></div>`,
  });
}

/**
 * Each preview is listed once, under Previews, so the outputs leave out those it lists. A preview output stays for
 * one the control plane no longer has.
 */
const outputsOf = (d: ThreadDetail) => d.outputs.filter((o) => o.kind !== "pull-request" && (o.kind !== "preview" || !d.previews.some((p) => p.service === o.ref)));

function facts({ thread: t, pylon }: ThreadDetail): Html {
  return html`<span${dataset(factsData({ pylon: pylon.actualState, turn: t.working, agentAt: t.lastAgentActivityAt, status: t.status, open: isOpenStatus(t.status) }))}></span>`;
}

/** The phone's stand-in for the inspector: the pylon, each preview as a link where it has one, and the outputs. */
function strip(d: ThreadDetail): Html {
  const outputs = outputsOf(d).length + d.pullRequests.length;
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
function inspector(d: ServerDetail, node: NodeRecord, now: number, usage: UsageTotals, worker: string | null): Html {
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
<div class="pane-live" id="inspect" data-live>${inspectorPanes(d, node, now, usage, worker)}</div>
</aside>`;
}

function inspectorPanes(d: ServerDetail, node: NodeRecord, now: number, usage: UsageTotals, worker: string | null): Html {
  const { thread: t, pylon } = d;
  const count = (n: number) => html`<span class="count">${n}</span>`;
  const desired = desiredPhase(t, now);
  const outputs = outputsOf(d);
  // A port with a preview is listed under Previews. Ports lists the rest, which are published only when someone opens one.
  const unpublished = d.ports?.filter((l) => l.preview === null) ?? null;
  const host = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");
  // Only a linked port's preview can be unpublished. A service's preview is part of its declaration.
  const open = isOpenStatus(t.status);
  return html`<div class="ipane" id="pane-previews">
<section aria-labelledby="previews-h"><h2 id="previews-h">Previews ${count(d.previews.length)}</h2>
${d.previews.length === 0 ? html`<p class="empty">No previews.</p>` : html`<ul class="list">${d.previews.map((p) => {
  const look = lookOf(d, p);
  return html`<li class="pv pv-${look.tone}">
<div class="pv-top">${dot(look.tone)}<span class="pv-name">${p.service}</span>${look.label !== null && html`<span class="pv-note">${look.label}</span>`}${look.linked && html`<a class="btn btn-xs" href="${p.url}" target="_blank" rel="noopener" aria-label="Open ${p.service}">Open ↗</a>`}${open && linkedPort(p.service) !== null && html`<button type="button" class="btn btn-xs btn-ghost"${act("unpublish")} data-thread="${t.id}" data-port="${linkedPort(p.service)}" aria-label="Unpublish ${p.service}">Unpublish</button>`}</div>
<div class="pv-url">${host(p.url)}</div>
${look.hint !== null && html`<div class="pv-hint">${look.hint}</div>`}
</li>`;
})}</ul>`}
</section>
<section aria-labelledby="ports-h"><h2 id="ports-h">Ports ${count(unpublished?.length ?? 0)}</h2>
${unpublished === null ? html`<p class="empty">The pylon's ports could not be read.</p>`
  : unpublished.length > 0 ? html`<ul class="list">${unpublished.map((l) => html`<li class="pv pv-muted">
<div class="pv-top">${dot("muted")}<span class="pv-name">${l.port}</span>${l.service === null
  ? html`<button type="button" class="btn btn-xs"${act("link-port")} data-thread="${t.id}" data-port="${l.port}" aria-label="Open port ${l.port}">Open</button>`
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
${pylon.failed !== null && html`<p class="error">${plannerGaveUp(pylon.failed)}</p>`}
${pylon.notAnswering !== undefined && html`<p class="error">The guest has not answered its last ${pylon.notAnswering.timeouts} commands, since ${ago(Date.parse(pylon.notAnswering.since), now)}. ${freshVm()}</p>`}
</section>
<section aria-labelledby="outputs-h"><h2 id="outputs-h">Outputs ${count(outputs.length + d.pullRequests.length)}</h2>
${!d.prWatch.enabled ? html`<p class="empty">${prWatchText(d.prWatch)}.</p>` : html`<p>${prWatchText(d.prWatch)}${d.prWatch.error && html` — ${d.prWatch.error}`}</p>`}
${d.pullRequests.map((pr) => html`<p><a href="${pr.url}" target="_blank" rel="noreferrer">PR #${pr.number}: ${pr.title}</a> — ${pr.state}, checks ${pr.checks}, review ${pr.review}</p>`)}
${d.review != null && html`<p>Nexus ${reviewLine(d.review).lead}<a href="/threads/${d.review.reviewer}">${d.review.reviewer}</a>${reviewLine(d.review).tail}</p>${reviewersNote(d.review) !== null && html`<p class="dim">${reviewersNote(d.review)}</p>`}${roundNote(d.review) !== null && html`<p class="dim">${roundNote(d.review)}</p>`}${liveNote(d.review) !== null && html`<p class="dim">${liveNote(d.review)}</p>`}${d.review.phase.kind === "needs-person" && html`<ul class="error">${d.review.phase.holds.map((h) => html`<li>${h.text}</li>`)}</ul>`}${cancelReview(t.id, d.review, "btn-xs btn-ghost danger")}`}
${outputs.length === 0 ? html`<p class="empty">No other outputs yet.</p>` : html`<ul class="list outs">${outputs.map((o) => html`<li><span class="o-kind">${outputLabel[o.kind]}</span><code>${o.ref}</code></li>`)}</ul>`}
</section>
${d.claudeWorker === undefined ? "" : html`<section><h2>Claude worker</h2><p>${d.claudeWorker.state} · ${d.claudeWorker.model ?? "unknown"}</p>${d.claudeWorker.message === undefined ? "" : html`<pre>${d.claudeWorker.message}</pre>`}</section>`}
<section aria-labelledby="sessions-h"><h2 id="sessions-h">Sessions ${count(d.sessions.length)}</h2>
${d.sessions.length === 0 ? html`<p class="empty">No sessions.</p>` : html`<ul class="list outs">${d.sessions.map((s) => html`<li>
<span class="o-kind">${harnessNamed(s.harness)?.label}</span>${s.title !== null && html`<span class="s-title">${s.title}</span>`}${s.state === "running" ? state(s.status, sessionTone[s.status])
  : s.state === "paused" ? state(sessionPaused(t), "idle")
  : state("failed", "bad")}${s.herdrPane !== null && html`<code class="dim pane">${s.herdrPane}</code>`}
${s.harnessSessionId !== null && html`<code class="dim sid" title="${s.harnessSessionId}">session ${s.harnessSessionId}</code>`}
${s.state === "failed" && html`<p class="error s-why">It did not come back from the last wake, which the next tries again: ${s.message}</p>`}
${t.status === "active" && sessionActions(t.id, s, worker !== null && s.harness === "claude-code" && s.harnessSessionId === worker)}
</li>`)}</ul>`}
${t.status === "active" && html`<div class="s-new">${newSessions.map(([harness, label]) => html`<button type="button" class="btn btn-xs"${act("open-session")} data-thread="${t.id}" data-harness="${harness}">${label}</button>`)}</div>
<p class="dim small">Show in terminal focuses the pane in Herdr, which moves every terminal attached to the pylon, <code>nexus attach</code> included.</p>`}
<p class="attach-h">Attach from a shell in the pylon</p>
<div class="attach"><code id="attach-command">${d.attach}</code><button type="button" class="btn btn-xs" data-copy="attach-command">Copy</button></div>
</section>
</div>`;
}

const newSessions = [["shell", "New shell"], ["pi", "New pi"], ["claude-code", "New Claude"]] as const satisfies readonly (readonly [SessionHarness, string])[];

/**
 * A running session shows in the terminal. Any but the worker's own closes, and a failed one in no pane is dropped by
 * its ID. A paused one does neither until its pylon wakes.
 */
function sessionActions(thread: string, s: ThreadDetail["sessions"][number], own: boolean): Html {
  const named = `${harnessNamed(s.harness)?.label ?? s.harness} session${s.title === null ? "" : ` "${s.title}"`}`;
  return html`<span class="s-acts">${s.state === "running" && html`<button type="button" class="btn btn-xs"${act("show-session")} data-thread="${thread}" data-pane="${s.herdrPane}">${icon("terminal")}Show in terminal</button>`}${s.state !== "paused" && !own && html`<button type="button" class="btn btn-xs btn-ghost danger"${act("close-session")} data-thread="${thread}" data-session="${s.id}" data-confirm="${`Close the ${named}? ${s.state === "running" ? "Its pane closes, and what runs there ends." : "No wake tries it again."}`}">Close</button>`}</span>`;
}
