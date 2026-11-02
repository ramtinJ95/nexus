/**
 * The home page's right column, the work in flight: a stack of the phases work moves through, each with a line for
 * every item, queued thread and thread at it, and the preview of the one the person picked, which the page renders
 * from `?peek=` so a poll keeps it fresh and a link opens it without a script.
 */
import type { Thread } from "../thread-store.ts";
import type { QueuedThread } from "../queue.ts";
import type { Project } from "../project.ts";
import type { ThreadDetail } from "../wire.ts";
import type { PipelineItem, ItemPhase } from "../pipeline.ts";
import { roundsSpent } from "../review-model.ts";
import { Html, html, dot, icon, ago, state, actualBadge, threadState, dims, type Part, type Tone } from "./view.ts";
import type { Context, HeldWork } from "./context.ts";
import { clock, span } from "./elapsed.ts";
import { prose } from "./markdown.ts";
import type { Item } from "./items.ts";
import { itemsOf, lifeOfItem, lifeOfThread, needLabel, roleLine, stages, threadRole, type Life, type Stage } from "./lifecycle.ts";
import { lifeTrack } from "./timeline.ts";
import { lastActive, queuedLook, threadTitle } from "./shell.ts";

const phaseTone: Record<ItemPhase["kind"], Tone> = {
  planned: "idle", queued: "idle", building: "work", reviewing: "work", landing: "busy", landed: "ok", held: "bad", archived: "muted", cancelled: "muted",
};

/** An item's Approve, while its project waits for the person to approve each item, and its Cancel, until it has a thread. */
export const itemActions = (i: PipelineItem, p: Project): Part => i.thread === null && i.phase.kind !== "cancelled" && html`<div class="need-act">${[
  p.pipeline?.autoStart === false && i.approved === null && html`<button type="button" class="btn btn-xs" data-action="approve-item" data-item="${i.id}">Approve</button>`,
  html`<button type="button" class="btn btn-xs btn-ghost" data-action="cancel-item" data-item="${i.id}" data-confirm="Cancel ${i.title}? It never becomes a thread.">Cancel</button>`,
]}</div>`;

/** One line of the stack: what it is, the key its preview goes by, its life, and its state as the sidebar's dot says it. */
export interface Line { key: string; title: string; project: string; life: Life; state: readonly [string, Tone]; when: Part; dim: boolean; order: number }

const threadLine = (c: Context, t: Thread): Line => {
  const r = c.row(t);
  return {
    key: t.id, title: t.title, project: t.project, life: lifeOfThread(c, t.id), state: threadState(r, c.now), dim: dims(r), order: -lastActive(t),
    when: t.working && t.workingSince !== undefined ? html`<time data-since="${t.workingSince}">${clock(c.now - t.workingSince)}</time>` : span(lastActive(t), c.now) ?? "now",
  };
};
const queuedLine = (c: Context, q: QueuedThread): Line => ({ key: q.id, title: q.title, project: q.project, life: lifeOfThread(c, q.id), state: queuedLook(q), when: "queued", dim: false, order: 0 });
const itemLine = (c: Context, i: PipelineItem): Line => ({ key: i.id, title: i.title, project: i.project, life: lifeOfItem(c, i), state: [i.phase.kind, phaseTone[i.phase.kind]], when: "item", dim: false, order: i.addedAt });

/** How long a landed thread stays under Deployed once it is archived, as the review loop archives each builder that lands. */
export const deployedForMs = 24 * 60 * 60 * 1000;

/**
 * Every piece of work once, at its stage: items not yet threads, queued threads, and open builder threads, and an
 * archived one only once it landed, for `deployedForMs` after its archive. A review's reviewer and check threads show
 * on their builder's line.
 */
export function flightLines(c: Context): Map<Stage, Line[]> {
  const recent = (t: Thread) => t.status === "active" || t.status === "idle" || (t.status === "archived" && t.archivedAt !== undefined && c.now - t.archivedAt < deployedForMs);
  const lines = [
    ...itemsOf(c).filter((i) => i.thread === null).map((i) => itemLine(c, i)),
    ...c.registry.projects().flatMap((p) => c.queuedIn(p.id)).map((q) => queuedLine(c, q)),
    ...c.threads().filter((t) => recent(t) && threadRole(c, t.id).kind === "builder").map((t) => [t, threadLine(c, t)] as const).filter(([t, l]) => t.status !== "archived" || l.life.stage === "deployed").map(([, l]) => l),
  ];
  const placed = Map.groupBy(lines.filter((l) => l.life.stage !== null), (l) => l.life.stage!);
  for (const stage of placed.values()) stage.sort((a, b) => a.order - b.order);
  return placed;
}

/** Work held for the person, as a line of the stack would show it. */
export const heldLine = (c: Context, w: HeldWork): Line => w.kind === "item" ? itemLine(c, w.item) : w.kind === "queued" ? queuedLine(c, w.q) : threadLine(c, w.thread);

export const peekHref = (key: string) => `/?peek=${encodeURIComponent(key)}`;

/** A line of the stack, a link to its preview. */
function line(l: Line, peeked: string | null): Html {
  const [label, tone] = l.state;
  return html`<li><a class="fl-row${l.dim && " dim"}" href="${peekHref(l.key)}" data-peek="${l.key}"${l.key === peeked && html` aria-current="true"`}>${dot(tone, label)}<span class="fl-title">${l.title}</span><span class="fl-why">${l.life.why}</span><span class="fl-when">${l.when}</span></a></li>`;
}

/** The phases in order, each with its lines. Held work is in Needs you, so the stack leaves it out. */
export function flightStack(placed: Map<Stage, Line[]>, peeked: string | null): Html {
  return html`${stages.filter((s) => s.stage !== "held").map((s) => {
    const lines = placed.get(s.stage) ?? [];
    return html`<section class="phase${lines.length === 0 && " phase-empty"}" id="phase-${s.stage}" data-stage="${s.stage}" aria-labelledby="phase-${s.stage}-h">
<h3 class="phase-h" id="phase-${s.stage}-h" title="${s.means}"><span class="col-mark mark-${s.tone}" aria-hidden="true"></span>${s.label}<span class="count">${lines.length}</span></h3>
${lines.length > 0 && html`<ul class="fl-list">${lines.map((l) => line(l, peeked))}</ul>`}
</section>`;
  })}`;
}

/** How many lines the stack shows on their way, which its head and the phone's switch count: held and deployed work is not. */
export const inFlight = (placed: Map<Stage, Line[]>) => [...placed].filter(([stage]) => stage !== "held" && stage !== "deployed").reduce((n, [, lines]) => n + lines.length, 0);

/** What the preview shows, as the route read it: a thread with its conversation's items, a queued thread, or an item. */
export type Peek =
  | { kind: "thread"; d: ThreadDetail; items: readonly Item[] }
  | { kind: "queued"; q: QueuedThread }
  | { kind: "item"; item: PipelineItem };

/** The key a preview goes by, which its close link and the stack's lines name. */
export const peekKey = (p: Peek) => p.kind === "thread" ? p.d.thread.id : p.kind === "queued" ? p.q.id : p.item.id;

const close = html`<a class="icon-btn peek-close" href="/" data-peek="" aria-label="Close the preview" title="Close (Esc)">${icon("cross")}</a>`;

/** What moves the work on next, said once: what of it waits on the person, or what the step it is on does next, or what is given in its place. */
function next(life: Life, said?: Html): Html {
  const held = life.stage === "held";
  const labels = [...new Set(life.needs.map(needLabel))];
  return html`<div class="peek-next${held && " held"}"><span class="peek-k">${held ? "Waits on you" : "Next"}</span>${said ?? html`<p>${held && labels.length > 0 && html`<b>${labels.join(", ")}.</b> `}${life.why.replace(/\.$/, "")}.</p>`}</div>`;
}

/** The latest reply of the thread's agent, or what it was last asked when it has not answered. */
function latest(d: ThreadDetail, items: readonly Item[], now: number): Html {
  const reply = items.findLast((i) => i.kind === "agent" && i.text.trim() !== "");
  const asked = items.findLast((i) => i.kind === "user");
  if (reply?.kind === "agent") {
    return html`<div class="peek-reply"><p class="peek-k">Latest reply${d.thread.lastReplyAt !== null && html` <span class="dim">${ago(d.thread.lastReplyAt, now)}</span>`}</p><div class="peek-text">${prose(reply.text)}</div></div>`;
  }
  if (asked?.kind === "user") return html`<div class="peek-reply"><p class="peek-k">Last asked <span class="dim">${ago(asked.at, now)}</span></p><div class="peek-text">${prose(asked.text)}</div><p class="empty">No reply yet.</p></div>`;
  return html`<p class="empty">No conversation yet.</p>`;
}

/** The preview: where the work is, what moves it on, its latest reply, and the way to its page. */
export function peekView(c: Context, p: Peek | null): Html | false {
  if (p === null) return false;
  if (p.kind === "item") {
    const i = p.item;
    const project = c.registry.project(i.project);
    const life = lifeOfItem(c, i);
    const titleOf = (id: string) => itemsOf(c).find((x) => x.id === id)?.title ?? id;
    return html`<section class="peek" aria-labelledby="peek-h" data-peek-key="${i.id}">
<header class="peek-head"><span class="peek-proj">${i.project}<span class="dim"> item </span><code>${i.id}</code></span><h2 id="peek-h">${dot(phaseTone[i.phase.kind], i.phase.kind)}<span>${i.title}</span></h2>${i.thread !== null && html`<a class="btn btn-xs" href="/threads/${i.thread}">Open thread</a>`}${close}</header>
${lifeTrack(life, false)}
${next(life)}
${i.after.length > 0 && html`<p class="peek-meta">After ${i.after.map((id, n) => html`${n > 0 && ", "}<a class="link" href="${peekHref(id)}" data-peek="${id}">${titleOf(id)}</a>`)}</p>`}
${i.brief === null ? html`<p class="empty">No brief.</p>` : html`<div class="peek-reply"><p class="peek-k">Brief</p><div class="peek-text">${prose(i.brief)}</div></div>`}
<p class="peek-meta">Added by ${i.addedBy} ${ago(i.addedAt, c.now)}, for ${i.worker === "claude" ? `Claude Code${i.model !== null ? `, ${i.model}` : ""}` : "the Nexus agent"}.</p>
${project !== undefined && itemActions(i, project)}
</section>`;
  }
  if (p.kind === "queued") {
    const q = p.q;
    const life = lifeOfThread(c, q.id);
    const [label, tone] = queuedLook(q);
    return html`<section class="peek" aria-labelledby="peek-h" data-peek-key="${q.id}">
<header class="peek-head"><span class="peek-proj">${q.project}</span><h2 id="peek-h">${dot(tone, label)}<span>${q.title}</span></h2><a class="btn btn-xs" href="/threads/${q.id}">Open thread</a>${close}</header>
${lifeTrack(life, false)}
${next(life, q.waits.every((w) => w.state === "landed") ? undefined : html`<ul class="peek-waits">${q.waits.map((w) => html`<li>${state(w.state, w.state === "landed" ? "ok" : w.state === "blocked" ? "bad" : "idle")} <a class="link" href="${peekHref(w.thread)}" data-peek="${w.thread}">${threadTitle(c, w.thread)}</a>: ${w.why}</li>`)}</ul>`)}
<p class="peek-meta">Starts on ${q.node} with ${q.resources.cpus} CPUs, ${q.resources.memoryGiB} GiB of memory and ${q.resources.diskGiB} GiB of disk.</p>
</section>`;
  }
  const { d, items } = p;
  const t = d.thread;
  const role = threadRole(c, t.id);
  const life = role.kind === "builder" ? lifeOfThread(c, t.id) : null;
  const [label, tone] = threadState({ ...t, attention: d.attention, desired: d.desired, pylon: d.pylon }, c.now);
  const r = d.review;
  const pr = d.pullRequests.find((x) => x.state === "open") ?? d.pullRequests.at(-1);
  return html`<section class="peek" aria-labelledby="peek-h" data-peek-key="${t.id}">
<header class="peek-head"><span class="peek-proj">${t.project}</span><h2 id="peek-h">${dot(tone, label)}<span>${t.title}</span></h2><a class="btn btn-xs btn-primary" href="/threads/${t.id}">Open thread</a>${close}</header>
${role.kind === "builder" ? html`${lifeTrack(life!, false)}
${next(life!)}` : roleLine(c, t.id, role)}
<dl class="peek-facts">
<dt>State</dt><dd>${label}</dd>
${pr !== undefined && html`<dt>Pull request</dt><dd><a class="link" href="${pr.url}" target="_blank" rel="noreferrer">#${pr.number} ${pr.title}</a>${r !== null && r.rounds.length > 0 && html` <span class="dim">round ${roundsSpent(r)} of ${r.maxRounds}</span>`}</dd>`}
<dt>Pylon</dt><dd>${state(...actualBadge[d.pylon.actualState])} <span class="dim">on</span> ${d.pylon.node}</dd>
</dl>
${latest(d, items, c.now)}
</section>`;
}
