/**
 * Renders a thread's page and a queued thread's page: the conversation, the inspector and the pylon's
 * facts and sessions.
 */
import { desiredPhase } from "../../reconcile.ts";
import { linkedPort } from "../../services-file.ts";
import { harnessNamed, type SessionHarness } from "../../sessions.ts";
import type { ThreadDetail } from "../wire.ts";
import type { NodeRecord, Preview, Thread, ThreadAgent, ThreadId } from "../registry.ts";
import { promptSenders } from "../inbox.ts";
import type { AgentView } from "../conversation-view.ts";
import { liveNote, phaseNote, roundNote, roundsSpent } from "../review-model.ts";
import type { QueuedThread, Wait } from "../queue.ts";
import { tokenCount, type UsageTotals } from "../usage.ts";
import { Html, html, actualBadge, desiredTone, sessionTone, outputLabel, dot, state, icon, menu, threadState, ago, workingFor, type Part, type Tone } from "./view.ts";
import type { Context } from "./context.ts";
import { prose } from "./markdown.ts";
import { itemsOf, modelOf } from "./items.ts";
import { runOf, stateBar, composer } from "./conversation.ts";
import { convo, shownKey } from "./live-frames.ts";
import { judgmentCards, questionCards, landing, cancelReview, nudgeCard } from "./cards.ts";
import { layout, queuedLook, threadTitle } from "./shell.ts";
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
export function threadPage(c: Context, d: ThreadDetail, node: NodeRecord, view: AgentView | Error | null, renderedReplyAt: number | null, streaming = false): Html {
  const { thread: t } = d;
  const agent = c.registry.agent(t).kind;
  const read = view === null || view instanceof Error ? null : view;
  const items = read === null ? [] : itemsOf(read, () => d.questions ?? [], t.id, () => promptSenders(c.registry, t.id));
  const run = runOf(d, read, items, c.now);
  const model = d.claudeWorker !== undefined ? d.claudeWorker.model : read === null || read.kind === "claude" ? null : modelOf(read.view);
  const shows = streaming && read !== null ? shownKey(read, model) : null;
  const open = t.status === "active" || t.status === "idle";
  const bar = threadBar(t, threadState({ ...t, attention: d.attention, desired: d.desired, pylon: d.pylon }, c.now), [
    t.status !== "deleted" && archiveButton(t.id, t.status === "archived"),
    t.status !== "deleted" && html`<button type="button" class="btn btn-ghost danger" id="delete" data-action="delete" data-thread="${t.id}" data-confirm="Delete &quot;${t.title}&quot;? Its pylon and disk are removed.">Delete</button>`,
  ], d.planning === true && html` <span class="tag" id="planning" title="Its proposed items become cards you accept or reject">planning</span>`);
  return layout(c, {
    title: t.title,
    active: t.id,
    ...(open ? { activity: t.id } : {}),
    main: html`${bar}
<div class="tabs" id="tabs" role="tablist" aria-label="Open views" data-thread="${t.id}"><button type="button" class="tab active" role="tab" aria-selected="true" aria-controls="scroll" data-tab="convo">${icon("chat")}<span class="tab-name">${t.title}</span></button>${t.status !== "deleted" && html`<button type="button" class="tab tab-term"${!open && " hidden"} role="tab" aria-selected="false" aria-controls="term-view" data-tab="term" title="A terminal in the pylon, as nexus attach ${t.id} gives">${icon("terminal")}<span class="tab-name">Terminal</span></button>`}</div>
<div class="strip" id="strip" data-live>${strip(d)}</div>
<div id="facts" data-live hidden>${facts(d)}</div>
<div class="scroll" id="scroll" role="tabpanel"><div class="convo" id="convo" data-rendered-reply-at="${read === null ? "" : renderedReplyAt ?? ""}"${shows !== null && html` data-shows="${shows}"`} data-live${agent !== "none" && t.status !== "deleted" && html` data-stream="/threads/${t.id}/stream"`}>${shows === null && convo(t, view, items, model, c.now)}</div></div>
<section class="file-view" id="file-view" role="tabpanel" aria-label="File diff" hidden></section>
${t.status !== "deleted" && termView(t)}
<div class="dock">
<p id="action-error" class="error" role="alert" hidden></p>
<p id="action-status" class="comp-note" role="status" hidden></p>
<div id="judgments" data-live>${judgmentCards(c, d)}</div>
<div id="questions" data-live>${questionCards(c, d)}</div>
<div id="nudge" data-live>${nudgeCard(c, t)}</div>
<div id="landing" data-live>${landing(c, d)}</div>
<div id="run" data-live>${(open || (t.status === "archived" && run.kind === "parked")) && stateBar(t, run, c.now)}</div>
<div id="composer" data-live>${composer(d, agent, run, model, read?.kind === "claude" ? read.view : null, c.now)}</div>
</div>`,
    inspector: inspector(d, node, c.now, c.registry.usageReport({ since: null, thread: t.id }).total, workerSession(c.registry.agent(t))),
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
<div class="tv-host" id="term-host"></div>
</section>`;
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

/** A thread's Archive button while it is open or queued, and its Unarchive button once it is archived. */
const archiveButton = (id: ThreadId, archived: boolean) => archived
  ? html`<button type="button" class="btn btn-ghost" id="unarchive" data-action="unarchive" data-thread="${id}">Unarchive</button>`
  : html`<button type="button" class="btn btn-ghost" id="archive" data-action="archive" data-thread="${id}">Archive</button>`;

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
      q.status === "queued" && html`<button type="button" class="btn" id="start-queued" data-action="start-queued" data-thread="${q.id}">Start now</button>`,
      q.status !== "deleted" && archiveButton(q.id, q.status === "archived"),
    ])}
<div class="scroll"><div class="page queued" id="queued" data-live>
<section aria-labelledby="waits-h"><h2 id="waits-h">Starts once these threads' pull requests merge</h2>
<ul class="list">${q.waits.map((w) => html`<li>${state(w.state, waitTone[w.state])} <a class="link" href="/threads/${w.thread}">${threadTitle(c, w.thread)}</a>: ${w.why}</li>`)}</ul>
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
function inspector(d: ThreadDetail, node: NodeRecord, now: number, usage: UsageTotals, worker: string | null): Html {
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

function inspectorPanes(d: ThreadDetail, node: NodeRecord, now: number, usage: UsageTotals, worker: string | null): Html {
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
${d.review != null && html`<p>Nexus review ${d.review.id}${d.review.auto && ", started on its own"}: ${d.review.phase.kind}, round ${roundsSpent(d.review)} of ${d.review.maxRounds}, by <a href="/threads/${d.review.reviewer}">${d.review.reviewer}</a> on ${d.review.models.reviewer}${d.review.land !== null && ", landing when approved"}${phaseNote(d.review)}</p>${roundNote(d.review) !== null && html`<p class="dim">${roundNote(d.review)}</p>`}${liveNote(d.review) !== null && html`<p class="dim">${liveNote(d.review)}</p>`}${d.review.phase.kind === "needs-person" && html`<ul class="error">${d.review.phase.reasons.map((reason) => html`<li>${reason}</li>`)}</ul>`}${cancelReview(t.id, d.review, "btn-xs btn-ghost danger")}`}
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
${t.status === "active" && sessionActions(t.id, s, worker !== null && s.harness === "claude-code" && s.harnessSessionId === worker)}
</li>`)}</ul>`}
${t.status === "active" && html`<div class="s-new">${newSessions.map(([harness, label]) => html`<button type="button" class="btn btn-xs" data-action="open-session" data-thread="${t.id}" data-harness="${harness}">${label}</button>`)}</div>
<p class="dim small">Show in terminal focuses the pane in Herdr, which moves every terminal attached to the pylon, <code>nexus attach</code> included.</p>`}
<p class="attach-h">Attach from a shell in the pylon</p>
<div class="attach"><code id="attach-command">${d.attach}</code><button type="button" class="btn btn-xs" data-copy="attach-command">Copy</button></div>
</section>
</div>`;
}

const newSessions = [["shell", "New shell"], ["pi", "New pi"], ["claude-code", "New Claude"]] as const satisfies readonly (readonly [SessionHarness, string])[];

/** The Claude Code session the thread's worker runs in, whose pane the page offers no Close for. */
function workerSession(agent: ThreadAgent): string | null {
  return agent.kind === "claude" ? agent.worker.session : null;
}

/**
 * A running session shows in the terminal. Any but the worker's own closes, and a failed one in no pane is dropped by
 * its ID. A paused one does neither until its pylon wakes.
 */
function sessionActions(thread: string, s: ThreadDetail["sessions"][number], own: boolean): Html {
  const named = `${harnessNamed(s.harness)?.label ?? s.harness} session${s.title === null ? "" : ` "${s.title}"`}`;
  return html`<span class="s-acts">${s.state === "running" && html`<button type="button" class="btn btn-xs" data-action="show-session" data-thread="${thread}" data-pane="${s.herdrPane}">${icon("terminal")}Show in terminal</button>`}${s.state !== "paused" && !own && html`<button type="button" class="btn btn-xs btn-ghost danger" data-action="close-session" data-thread="${thread}" data-session="${s.id}" data-confirm="${`Close the ${named}? ${s.state === "running" ? "Its pane closes, and what runs there ends." : "No wake tries it again."}`}">Close</button>`}</span>`;
}
