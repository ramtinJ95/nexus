/**
 * The home page's strip board: a bay for each step of work's life, a strip for each item, queued thread and thread in
 * the bay of the step it is at, and the line over it that sums up the fleet. A strip held for the person stays in its
 * bay, pulled out of line. Bars and sparklines are SVG, since the page's policy refuses inline styles.
 */
import { countedCapacity } from "../../protocol/observations.ts";
import { lowDisk } from "../../disk-space.ts";
import type { Thread } from "../thread-store.ts";
import type { QueuedThread } from "../queue.ts";
import type { PipelineItem } from "../pipeline.ts";
import type { NodeRecord } from "../node-store.ts";
import { roundsSpent, settledKinds, type Review } from "../review-model.ts";
import { tokenCount } from "../usage.ts";
import { gib, nodePylons, overcommitted } from "../placement.ts";
import { Html, html, threadState, dims, unseen, type Part, type Tone } from "./view.ts";
import type { Context } from "./context.ts";
import { clock, span } from "./elapsed.ts";
import { itemsOf, lifeOfItem, lifeOfThread, stages, steps, type Life, type Step } from "./lifecycle.ts";
import { lastActive, queuedLook, threadTitle } from "./shell.ts";
import { itemActions, phaseTone } from "./pipeline-page.ts";

/** One strip: what it is, where it links, its life, its state as the sidebar's dot says it, and its review's round. */
export interface Strip { title: string; project: string; href: string; life: Life; state: readonly [string, Tone]; when: Part; round: Part; dim: boolean; actions: Part; order: number }

const settled: ReadonlySet<string> = new Set(settledKinds);
const reviewTone: Record<Review["phase"]["kind"], Tone> = {
  reviewing: "review", fixing: "work", verifying: "review", checking: "review", approved: "ok", "needs-person": "bad", merging: "busy", deploying: "busy",
  "rolling-back": "bad", landed: "ok", merged: "ok", closed: "muted", cancelled: "muted",
};

/** A review's rounds as pips, one per round it may take, filled for each it spent, said once in words. */
function pips(r: Review): Html {
  const spent = roundsSpent(r);
  return html`<span class="pips" role="img" aria-label="round ${spent} of ${r.maxRounds}, ${r.phase.kind}">${Array.from({ length: r.maxRounds }, (_, i) => html`<i${i < spent && html` class="on"`}></i>`)}</span><span class="pips-phase">${r.phase.kind}</span>`;
}

function roundOf(c: Context, id: Thread["id"]): Part {
  const review = c.registry.review(id);
  if (review !== null && review.rounds.length > 0) return pips(review);
  const open = c.registry.prWatch(id)?.links.find((l) => l.pr.state === "open");
  return open === undefined ? null : html`<span class="slip-pr">#${open.pr.number}</span>`;
}

const threadStrip = (c: Context, t: Thread): Strip => {
  const r = c.row(t);
  return {
    title: t.title, project: t.project, href: `/threads/${t.id}`, life: lifeOfThread(c, t.id), state: threadState(r, c.now),
    when: t.working && t.workingSince !== undefined ? html`<time data-since="${t.workingSince}">${clock(c.now - t.workingSince)}</time>` : span(lastActive(t), c.now) ?? "now",
    round: roundOf(c, t.id), dim: dims(r), actions: null, order: -lastActive(t),
  };
};

const queuedStrip = (c: Context, q: QueuedThread): Strip => ({
  title: q.title, project: q.project, href: `/threads/${q.id}`, life: lifeOfThread(c, q.id), state: queuedLook(q), when: null,
  round: q.waits.length > 0 && `after ${q.waits.length} ${q.waits.length === 1 ? "thread" : "threads"}`, dim: false, actions: null, order: 0,
});

function itemStrip(c: Context, i: PipelineItem): Strip {
  const p = c.registry.project(i.project);
  return {
    title: i.title, project: i.project, href: `/pipeline#item-${i.id}`, life: lifeOfItem(c, i), state: [i.phase.kind, phaseTone[i.phase.kind]], when: null,
    round: null, dim: false, actions: p === undefined ? null : itemActions(i, p), order: i.addedAt,
  };
}

/** Every piece of work on the board, each once, in the bay of the step it is at. Work that ended short of landing is off it. */
export function boardStrips(c: Context): Map<Step, Strip[]> {
  const strips = [
    ...itemsOf(c).filter((i) => i.thread === null).map((i) => itemStrip(c, i)),
    ...c.registry.projects().flatMap((p) => c.queuedIn(p.id)).map((q) => queuedStrip(c, q)),
    ...c.threads().filter((t) => t.status !== "deleted").map((t) => threadStrip(c, t)),
  ].filter((s) => s.life.stage !== null);
  const bays = Map.groupBy(strips, (s) => s.life.at);
  // Held strips lead their bay, oldest work first after them.
  for (const bay of bays.values()) bay.sort((a, b) => Number(b.life.stage === "held") - Number(a.life.stage === "held") || a.order - b.order);
  return bays;
}

function strip(s: Strip): Html {
  const [label, tone] = s.state;
  const held = s.life.stage === "held";
  return html`<li class="slip tone-${held ? "bad" : tone}${held && " held"}${s.dim && " dim"}" data-at="${s.life.at}">
<a class="slip-main" href="${s.href}">
<span class="slip-title">${s.title}</span>${unseen(`, ${held ? "held for you" : label}`)}
<span class="slip-meta"><span class="slip-proj">${s.project}</span>${s.round !== null && s.round !== false && html`<span class="slip-round">${s.round}</span>`}${s.when !== null && html`<span class="slip-when">${s.when}</span>`}</span>
${s.life.why !== "" && html`<span class="slip-why"><span>${s.life.why}</span></span>`}
</a>
${s.actions !== null && s.actions !== false && html`<div class="slip-act">${s.actions}</div>`}
</li>`;
}

/** What an empty bay says, so an empty board still reads as the path work takes. */
const emptyBay: Record<Step, string> = {
  planned: "Nothing lined up", queued: "Nothing waits", building: "No agent building",
  review: "Nothing in review", landing: "Nothing landing", deployed: "Nothing landed yet",
};

/** How many of a bay's strips show before the rest fold: every held one, and the bay filled to five. */
const shown = (strips: readonly Strip[]) => Math.max(5, strips.filter((s) => s.life.stage === "held").length);

/** The bays, left to right in the order work moves, each a live region the poll swaps on its own. */
export function board(c: Context): Html {
  const bays = boardStrips(c);
  const held = (step: Step) => (bays.get(step) ?? []).filter((x) => x.life.stage === "held").length;
  return html`<nav class="bay-index" id="bay-index" aria-label="Steps" data-live>${steps.map((step) => html`<a href="#bay-${step}"${(bays.get(step)?.length ?? 0) === 0 && html` class="none"`}>${stages.find((x) => x.stage === step)!.label} <b>${bays.get(step)?.length ?? 0}</b>${held(step) > 0 && html`<span class="bi-held">${unseen(", ")}${held(step)} held</span>`}</a>`)}</nav>
<div class="board" id="board" role="list" aria-label="Work by step">
${steps.map((step) => {
  const s = stages.find((x) => x.stage === step)!;
  const strips = bays.get(step) ?? [];
  const held = strips.filter((x) => x.life.stage === "held").length;
  return html`<section class="bay" id="bay-${step}" role="listitem" aria-labelledby="bay-${step}-h" data-live>
<header class="bay-h" title="${s.means}"><h2 id="bay-${step}-h">${s.label}</h2><span class="bay-n">${strips.length}</span>${held > 0 && html`<span class="bay-held">${held} held</span>`}</header>
${strips.length === 0 ? html`<p class="bay-empty">${emptyBay[step]}</p>` : html`<ol class="slips">${strips.slice(0, shown(strips)).map(strip)}</ol>`}
${strips.length > shown(strips) && html`<details class="bay-more" id="more-${step}"><summary>${strips.length - shown(strips)} more</summary><ol class="slips">${strips.slice(shown(strips)).map(strip)}</ol></details>`}
</section>`;
})}
</div>`;
}

/** A bar of parts that sum to `total`, each in its tone's colour, drawn in a 100-unit box. */
function bar(parts: readonly (readonly [value: number, tone: Tone])[], total: number, label: string): Html {
  let at = 0;
  const scale = total <= 0 ? 0 : 100 / total;
  return html`<svg class="gauge" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${label}"><rect class="gauge-track" width="100" height="4"/>${parts.map(([value, tone]) => {
    const w = Math.max(0, Math.min(100 - at, value * scale));
    const rect = html`<rect class="gauge-${tone}" x="${at.toFixed(2)}" width="${w.toFixed(2)}" height="4"/>`;
    at += w;
    return rect;
  })}</svg>`;
}

/** A line of the last hours of one series, scaled to `ceiling` or its own peak, whichever is higher. */
function sparkline(t: readonly number[], v: readonly number[], from: number, to: number, ceiling: number, label: string): Html {
  if (v.length < 2) return html`<svg class="spark" viewBox="0 0 120 24" role="img" aria-label="${label}: no samples"><line class="spark-line" x1="0" y1="23" x2="120" y2="23"/></svg>`;
  const top = Math.max(ceiling, ...v) || 1;
  const points = v.map((y, i) => `${(((t[i]! - from) / (to - from)) * 120).toFixed(1)},${(23 - (y / top) * 21).toFixed(1)}`).join(" ");
  return html`<svg class="spark" viewBox="0 0 120 24" preserveAspectRatio="none" role="img" aria-label="${label}"><polyline class="spark-line" points="${points}"/></svg>`;
}

const pct = (used: number, total: number) => total <= 0 ? 0 : Math.round((used / total) * 100);
const fill = (p: number): Tone => p >= 90 ? "bad" : p >= 75 ? "busy" : "ok";

/** One node on the fleet line: its load against its CPUs, and on hover, focus or tap its memory, disk and pylons. */
function nodePart(c: Context, node: NodeRecord): Html {
  const sample = c.registry.latestHealthSample(node.name)?.values ?? {};
  const capacity = countedCapacity(node.capacity);
  const pylons = nodePylons(c.registry, node);
  const to = c.now;
  const from = to - 6 * 3_600_000;
  const load = c.registry.nodeMetrics(node.name, from, to, c.now).series.find((s) => s.key === "load1");
  const cpus = sample.cpus ?? capacity?.cpus ?? 0;
  const load1 = sample.load1;
  const memUsed = sample.memTotal === undefined || sample.memAvailable === undefined ? null : sample.memTotal - sample.memAvailable;
  const diskUsed = sample.diskTotal === undefined || sample.diskFree === undefined ? null : sample.diskTotal - sample.diskFree;
  const flags = [node.state === "offline" && "offline", overcommitted(node.capacity) && "overcommitted", capacity?.disks?.some(lowDisk) === true && "disk low"].filter((f) => f !== false);
  const running = c.threads().filter((t) => c.row(t).pylon.node === node.name && c.row(t).pylon.actualState === "running");
  const meter = (name: string, used: number | null, total: number | undefined) => html`<span class="fp-k">${name}</span>${used === null || total === undefined
    ? html`<span class="fp-v dim">not reported</span>`
    : html`${bar([[used, fill(pct(used, total))]], total, `${name} ${pct(used, total)}% used`)}<span class="fp-v">${gib(used)} of ${gib(total)} GiB</span>`}`;
  return html`<div class="fl fl-node${flags.length > 0 && " fl-flag"}">
<button type="button" class="fl-sum" id="fl-${node.name}" aria-describedby="fp-${node.name}"><span class="fl-dot dot-${node.state === "online" ? "ok" : "muted"}" aria-hidden="true"></span><span class="fl-name">${node.name}</span>${sparkline(load?.t ?? [], load?.avg ?? [], from, to, cpus, `1-minute load over 6 hours on ${node.name}`)}<span class="fl-num">${load1 === undefined ? "no load" : html`<b>${load1.toFixed(1)}</b> of ${cpus}`}</span>${flags.map((f) => html`<span class="fl-warn">${f}</span>`)}</button>
<div class="fl-pop" id="fp-${node.name}" role="tooltip">
<p class="fp-head"><a class="link" href="/nodes/${encodeURIComponent(node.name)}">${node.name}</a> <span class="dim">${node.state}${load1 !== undefined && `, load ${load1.toFixed(2)} on ${cpus} CPUs over the last minute`}</span></p>
<div class="fp-meters">${meter("Memory", memUsed, sample.memTotal)}${meter("Disk", diskUsed, sample.diskTotal)}</div>
<p class="fp-line">${pylons?.up.pylons ?? 0} up, ${pylons?.paused.pylons ?? 0} paused${(pylons?.crashed.pylons ?? 0) > 0 && html`, <span class="num-bad">${pylons!.crashed.pylons} crashed</span>`}${capacity !== null && `, ${gib(capacity.committedMemoryGiB)} of ${gib(capacity.memoryGiB)} GiB committed`}</p>
${running.length > 0 && html`<ul class="fp-list">${running.map((t) => html`<li><a href="/threads/${t.id}">${t.title}</a></li>`)}</ul>`}
</div>
</div>`;
}

/** The fleet in one line: each node's load, the reviews in flight, open health problems and today's tokens. */
export function fleetLine(c: Context): Html {
  const reviews = c.registry.reviews().filter((r) => !settled.has(r.phase.kind)).toSorted((a, b) => b.since - a.since);
  const held = reviews.filter((r) => r.phase.kind === "needs-person").length;
  const problems = c.registry.healthStates().filter((s) => s.status !== "ok");
  const failing = problems.filter((s) => s.status === "fail").length;
  const tokens = c.registry.usageReport({ since: c.now - 24 * 3_600_000 }).total;
  return html`<div class="fleet" id="fleet" data-live aria-label="The fleet">
${c.registry.nodes().map((n) => nodePart(c, n))}
<div class="fl fl-reviews">
<button type="button" class="fl-sum" id="fl-reviews" aria-describedby="fp-reviews"><span class="fl-name"><b>${reviews.length}</b> ${reviews.length === 1 ? "review" : "reviews"} in flight</span>${held > 0 && html`<span class="fl-warn">${held} held</span>`}</button>
<div class="fl-pop" id="fp-reviews" role="tooltip">
${reviews.length === 0 ? html`<p class="fp-line dim">No review is running.</p>` : html`<ul class="fp-reviews">${reviews.map((r) => html`<li class="tone-${reviewTone[r.phase.kind]}"><a href="/threads/${r.builder}">${threadTitle(c, r.builder)}</a>${pips(r)}</li>`)}</ul>`}
</div>
</div>
<a class="fl-link${failing > 0 && " fl-flag"}" href="/health">${problems.length === 0 ? "Every check passes" : html`<b>${problems.length}</b> ${problems.length === 1 ? "check needs" : "checks need"} a look`}</a>
<a class="fl-link" href="/usage"><b>${tokenCount(tokens.total)}</b> tokens in 24 hours</a>
</div>`;
}
