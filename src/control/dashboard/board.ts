/**
 * The home page's board: a column for each stage of work's life, a card for each item, queued thread and thread in
 * it, and the column held for the person, whose cards are what waits on them.
 */
import type { Thread } from "../thread-store.ts";
import type { QueuedThread } from "../queue.ts";
import type { PipelineItem } from "../pipeline.ts";
import { roundsSpent } from "../review-model.ts";
import { Html, html, dot, threadState, dims, type Part, type Tone } from "./view.ts";
import type { Context } from "./context.ts";
import { clock, span } from "./elapsed.ts";
import { itemsOf, lifeOfItem, lifeOfThread, miniTrack, stages, type Life, type Stage } from "./lifecycle.ts";
import { lastActive, queuedLook } from "./shell.ts";
import { itemActions, phaseTone } from "./pipeline-page.ts";

/** One card: what it is, where it links, its life, and its state as the sidebar's dot says it. */
export interface Card { title: string; project: string; href: string; life: Life; state: readonly [string, Tone]; when: Part; meta: Part[]; dim: boolean; actions: Part; order: number }

/** The review's round and its pull request, or an open pull request before a review. */
function threadMeta(c: Context, id: Thread["id"]): Part[] {
  const review = c.registry.review(id);
  if (review !== null) return [html`<span class="card-pr" title="${review.pr.title}">#${review.pr.number}</span>`, review.rounds.length > 0 && html`<span>round ${roundsSpent(review)}/${review.maxRounds}</span>`];
  const open = c.registry.prWatch(id)?.links.find((l) => l.pr.state === "open");
  return open === undefined ? [] : [html`<span class="card-pr">#${open.pr.number}</span>`];
}

const threadCard = (c: Context, t: Thread): Card => {
  const r = c.row(t);
  return {
    title: t.title, project: t.project, href: `/threads/${t.id}`, life: lifeOfThread(c, t.id), state: threadState(r, c.now),
    when: t.working && t.workingSince !== undefined ? html`<time data-since="${t.workingSince}">${clock(c.now - t.workingSince)}</time>` : span(lastActive(t), c.now) ?? "now",
    meta: threadMeta(c, t.id), dim: dims(r), actions: null, order: -lastActive(t),
  };
};

const queuedCard = (c: Context, q: QueuedThread): Card => ({
  title: q.title, project: q.project, href: `/threads/${q.id}`, life: lifeOfThread(c, q.id), state: queuedLook(q), when: "queued",
  meta: q.waits.length > 0 ? [html`<span>after ${q.waits.length} ${q.waits.length === 1 ? "thread" : "threads"}</span>`] : [], dim: false, actions: null, order: 0,
});

function itemCard(c: Context, i: PipelineItem, title: (id: string) => string): Card {
  const p = c.registry.project(i.project);
  return {
    title: i.title, project: i.project, href: `/pipeline#item-${i.id}`, life: lifeOfItem(c, i), state: [i.phase.kind, phaseTone[i.phase.kind]], when: "item",
    meta: i.after.map((id) => html`<span title="Waits for ${title(id)}">after ${title(id)}</span>`), dim: false, actions: p === undefined ? null : itemActions(i, p), order: i.addedAt,
  };
}

/** Every piece of work on the board: items not yet threads, queued threads, and threads, each once, in its column. */
export function boardCards(c: Context): Map<Stage, Card[]> {
  const items = itemsOf(c);
  const title = (id: string) => items.find((i) => i.id === id)?.title ?? id;
  const cards = [
    ...items.filter((i) => i.thread === null).map((i) => itemCard(c, i, title)),
    ...c.registry.projects().flatMap((p) => c.queuedIn(p.id)).map((q) => queuedCard(c, q)),
    ...c.threads().filter((t) => t.status !== "deleted").map((t) => threadCard(c, t)),
  ];
  const placed = Map.groupBy(cards.filter((card) => card.life.stage !== null), (card) => card.life.stage!);
  for (const column of placed.values()) column.sort((a, b) => a.order - b.order);
  return placed;
}

export function card(k: Card): Html {
  const [label, tone] = k.state;
  return html`<li class="card${k.dim && " dim"}" data-stage="${k.life.stage}" data-at="${k.life.at}">
<a class="card-main" href="${k.href}">
<span class="card-top"><span class="card-proj">${k.project}</span><span class="card-when">${k.when}</span></span>
<span class="card-title">${dot(tone, label)}<span>${k.title}</span></span>
${miniTrack(k.life)}
<span class="card-why">${k.life.why}</span>
${k.meta.some((m) => m !== false && m !== null) && html`<span class="card-meta">${k.meta}</span>`}
</a>
${k.actions !== null && k.actions !== false && html`<div class="card-act">${k.actions}</div>`}
</li>`;
}

/** A column's head: its marker, its name and how many cards it holds, with what it means for a pointer to read. */
export const columnHead = (stage: Stage, count: number, id = `col-${stage}-h`) => {
  const s = stages.find((x) => x.stage === stage)!;
  return html`<header class="col-h" title="${s.means}"><span class="col-mark mark-${s.tone}" aria-hidden="true"></span><h2 id="${id}">${s.label}</h2><span class="col-n">${count}</span></header>`;
};

/** The phone's way across the board: a chip per column with its count, each a link to its column. */
export function boardNav(placed: Map<Stage, Card[]>, held: number): Html {
  return html`${stages.map((s) => {
    const n = s.stage === "held" ? held : placed.get(s.stage)?.length ?? 0;
    return html`<a class="bn bn-${s.stage}${n === 0 && " bn-empty"}" href="#${s.stage === "held" ? "needs-you" : `col-${s.stage}`}"><span class="col-mark mark-${s.tone}" aria-hidden="true"></span>${s.label}<b>${n}</b></a>`;
  })}`;
}
