/**
 * The home page's console: a row of counters over the whole fleet, and the panels beside the inbox with each node's
 * live load and the reviews in flight. Bars and sparklines are SVG, since the page's policy refuses inline styles.
 */
import { countedCapacity } from "../../protocol/observations.ts";
import { lowDisk } from "../../disk-space.ts";
import { itemView, type ItemPhase } from "../pipeline.ts";
import { settledKinds, roundsSpent, type Review } from "../review-model.ts";
import { tokenCount } from "../usage.ts";
import { gib, nodePylons, overcommitted } from "../placement.ts";
import type { NodeRecord } from "../node-store.ts";
import type { ActualState } from "../../reconcile.ts";
import { html, dot, type Html, type Tone } from "./view.ts";
import { span } from "./elapsed.ts";
import type { Context } from "./context.ts";
import { threadTitle } from "./shell.ts";

const settled: ReadonlySet<string> = new Set(settledKinds);
const reviewTone: Record<Review["phase"]["kind"], Tone> = {
  reviewing: "work", fixing: "work", verifying: "work", checking: "work", approved: "ok", "needs-person": "bad", merging: "busy", deploying: "busy",
  "rolling-back": "bad", landed: "ok", merged: "ok", closed: "muted", cancelled: "muted",
};
const inFlight: ReadonlySet<ItemPhase["kind"]> = new Set(["building", "reviewing", "landing"]);

/** A bar of parts that sum to `total`, each in its tone's colour, drawn in a 100-unit box. */
function bar(parts: readonly (readonly [value: number, tone: Tone])[], total: number, label: string): Html {
  let at = 0;
  const scale = total <= 0 ? 0 : 100 / total;
  return html`<svg class="gauge" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${label}"><rect class="gauge-track" width="100" height="4"/>${parts.map(([value, tone]) => {
    const w = Math.min(100 - at, value * scale);
    const rect = html`<rect class="gauge-${tone}" x="${at.toFixed(2)}" width="${Math.max(0, w).toFixed(2)}" height="4"/>`;
    at += Math.max(0, w);
    return rect;
  })}</svg>`;
}

/** A line of the last hours of one series, scaled to `ceiling` or its own peak, whichever is higher. */
function sparkline(t: readonly number[], v: readonly number[], from: number, to: number, ceiling: number, label: string): Html {
  if (v.length < 2) return html`<svg class="spark spark-none" viewBox="0 0 120 28" role="img" aria-label="${label}: no samples"><line x1="0" y1="27" x2="120" y2="27"/></svg>`;
  const top = Math.max(ceiling, ...v) || 1;
  const points = v.map((y, i) => `${(((t[i]! - from) / (to - from)) * 120).toFixed(1)},${(27 - (y / top) * 25).toFixed(1)}`);
  return html`<svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none" role="img" aria-label="${label}"><polyline class="spark-fill" points="${`${points[0]!.split(",")[0]},28 ${points.join(" ")} ${points.at(-1)!.split(",")[0]},28`}"/><polyline class="spark-line" points="${points.join(" ")}"/></svg>`;
}

/** A counter. An alarm's number takes its tone, as a count of things gone wrong; any other keeps the text's colour. */
const kpi = (label: string, value: string | number, tone: Tone, sub: Html | string, href: string, alarm = false) =>
  html`<a class="kpi kpi-${tone}${alarm && tone !== "ok" && " kpi-alarm"}" href="${href}" id="kpi-${label.toLowerCase().replace(/\W+/g, "-")}"><span class="kpi-label">${label}</span><span class="kpi-value">${value}</span><span class="kpi-sub">${sub}</span></a>`;

/** The counters across the top of the home page, each a link to where its count lives. */
export function board(c: Context): Html {
  const open = c.threads().filter((t) => t.status === "active" || t.status === "idle");
  const states = new Map<ActualState, number>();
  for (const t of open) {
    const s = c.row(t).pylon.actualState;
    states.set(s, (states.get(s) ?? 0) + 1);
  }
  const n = (s: ActualState) => states.get(s) ?? 0;
  const changing = n("spawning") + n("pausing") + n("deleting");
  const working = open.filter((t) => t.working).length;
  const needs = c.needs();
  const items = c.registry.items().map((i) => itemView(c.registry, i));
  const phase = (k: ItemPhase["kind"]) => items.filter((i) => i.phase.kind === k).length;
  const flying = items.filter((i) => inFlight.has(i.phase.kind)).length;
  const reviews = c.registry.reviews().filter((r) => !settled.has(r.phase.kind));
  const held = reviews.filter((r) => r.phase.kind === "needs-person").length;
  const problems = c.registry.healthStates().filter((s) => s.status !== "ok");
  const failing = problems.filter((s) => s.status === "fail").length;
  const nodes = c.registry.nodes();
  const online = nodes.filter((x) => x.state === "online").length;
  const tokens = c.registry.usageReport({ since: c.now - 24 * 3_600_000 }).total;
  const oldest = needs.length === 0 ? undefined : span(Math.min(...needs.map((x) => x.since)), c.now);
  return html`<div class="board" id="board" data-live aria-label="Fleet at a glance">
${kpi("Needs you", needs.length, needs.length > 0 ? "bad" : "ok", oldest === undefined ? "nothing waits" : `oldest waited ${oldest ?? "under a minute"}`, "/#needs-you", true)}
${kpi("Agents", working, working > 0 ? "work" : "idle", `working of ${open.length} open`, "/#overview")}
${kpi("Pylons", n("running"), n("failed") > 0 ? "bad" : "ok", html`${bar([[n("running"), "ok"], [changing, "busy"], [n("paused"), "idle"], [n("failed"), "bad"]], open.length, "Pylons by state")}<span>${n("paused")} paused · ${changing} changing · <span class="${n("failed") > 0 ? "num-bad" : ""}">${n("failed")} failed</span></span>`, "/#overview")}
${kpi("Pipeline", flying, flying > 0 ? "work" : "idle", `${phase("queued")} queued · ${phase("planned")} planned · ${phase("held")} held`, "/pipeline")}
${kpi("Reviews", reviews.length, held > 0 ? "bad" : reviews.length > 0 ? "work" : "idle", `${held} held for you`, "/#fleet-reviews")}
${kpi("Health", problems.length, failing > 0 ? "bad" : problems.length > 0 ? "busy" : "ok", problems.length === 0 ? "every check ok" : `${failing} failing · ${problems.length - failing} warning`, "/health", true)}
${kpi("Nodes", `${online}/${nodes.length}`, online < nodes.length ? "busy" : "ok", online < nodes.length ? `${nodes.length - online} offline` : "all online", "/#fleet-nodes")}
${kpi("Tokens 24 h", tokenCount(tokens.total), "idle", `${tokens.calls.toLocaleString("en-US")} calls`, "/usage?period=today")}
</div>`;
}

/** One node's tile: its state, load against its CPUs over the last six hours, memory and disk, and its pylons. */
function nodeTile(c: Context, node: NodeRecord): Html {
  const sample = c.registry.latestHealthSample(node.name)?.values ?? {};
  const capacity = countedCapacity(node.capacity);
  const pylons = nodePylons(c.registry, node);
  const to = c.now;
  const from = to - 6 * 3_600_000;
  const load = c.registry.nodeMetrics(node.name, from, to, c.now).series.find((s) => s.key === "load1");
  const cpus = sample.cpus ?? capacity?.cpus ?? 0;
  const load1 = sample.load1;
  const loadTone: Tone = load1 === undefined ? "muted" : load1 > cpus ? "bad" : load1 > cpus * 0.7 ? "busy" : "ok";
  const memTotal = sample.memTotal;
  const memUsed = memTotal === undefined || sample.memAvailable === undefined ? null : memTotal - sample.memAvailable;
  const diskTotal = sample.diskTotal;
  const diskUsed = diskTotal === undefined || sample.diskFree === undefined ? null : diskTotal - sample.diskFree;
  const pct = (used: number, total: number) => total <= 0 ? 0 : Math.round((used / total) * 100);
  const tone = (p: number): Tone => p >= 90 ? "bad" : p >= 75 ? "busy" : "ok";
  const low = capacity?.disks?.some(lowDisk) === true;
  const flags = [node.state === "offline" && "offline", overcommitted(node.capacity) && "overcommitted", low && "disk low"].filter((f) => f !== false);
  return html`<a class="node-tile node-${node.state}" href="/nodes/${encodeURIComponent(node.name)}" id="tile-${node.name}">
<span class="nt-head">${dot(node.state === "online" ? "ok" : "muted", node.state)}<span class="nt-name">${node.name}</span>${flags.map((f) => html`<span class="tag tag-bad">${f}</span>`)}</span>
<span class="nt-load"><span class="nt-big num-${loadTone}">${load1 === undefined ? "–" : load1.toFixed(2)}</span><span class="nt-unit">load · ${cpus} CPU</span>${sparkline(load?.t ?? [], load?.avg ?? [], from, to, cpus, `1-minute load over 6 hours on ${node.name}`)}</span>
<span class="nt-meter"><span class="nt-k">mem</span>${memUsed === null ? html`<span class="dim">unknown</span>` : html`${bar([[memUsed, tone(pct(memUsed, memTotal!))]], memTotal!, `Memory ${pct(memUsed, memTotal!)}% used`)}<span class="nt-v">${gib(memUsed)}/${gib(memTotal!)} G</span>`}</span>
<span class="nt-meter"><span class="nt-k">disk</span>${diskUsed === null ? html`<span class="dim">unknown</span>` : html`${bar([[diskUsed, tone(pct(diskUsed, diskTotal!))]], diskTotal!, `Disk ${pct(diskUsed, diskTotal!)}% used`)}<span class="nt-v">${gib(diskUsed)}/${gib(diskTotal!)} G</span>`}</span>
<span class="nt-foot"><span><b>${pylons?.up.pylons ?? 0}</b> up</span><span><b>${pylons?.paused.pylons ?? 0}</b> paused</span>${(pylons?.crashed.pylons ?? 0) > 0 && html`<span class="num-bad"><b>${pylons!.crashed.pylons}</b> crashed</span>`}${capacity !== null && html`<span>${gib(capacity.committedMemoryGiB)}/${gib(capacity.memoryGiB)} G committed</span>`}</span>
</a>`;
}

/** The panels beside the inbox: every node's load, and every review that has not settled with its round and phase. */
export function fleet(c: Context): Html {
  const nodes = c.registry.nodes();
  const reviews = c.registry.reviews().filter((r) => !settled.has(r.phase.kind)).toSorted((a, b) => b.since - a.since);
  return html`<div class="fleet" id="fleet" data-live>
<section class="panel" aria-labelledby="fleet-nodes"><div class="ov-head"><h2 id="fleet-nodes">Nodes</h2><span class="count">${nodes.length}</span><span class="ov-note">load 1 min · 6 h</span></div>
${nodes.length === 0 ? html`<p class="empty">No nodes yet.</p>` : html`<div class="node-tiles">${nodes.map((n) => nodeTile(c, n))}</div>`}
</section>
<section class="panel" aria-labelledby="fleet-reviews"><div class="ov-head"><h2 id="fleet-reviews">Reviews in flight</h2><span class="count">${reviews.length}</span></div>
${reviews.length === 0 ? html`<p class="empty">No review runs.</p>` : html`<table class="ov ov-dense"><thead><tr><th>Builder</th><th>Phase</th><th class="num">Round</th></tr></thead>
<tbody>${reviews.map((r) => html`<tr class="tone-${reviewTone[r.phase.kind]}"><td><span class="ov-title">${dot(reviewTone[r.phase.kind], r.phase.kind)}<a href="/threads/${r.builder}">${threadTitle(c, r.builder)}</a></span></td><td><span class="phase phase-${reviewTone[r.phase.kind]}">${r.phase.kind}</span></td><td class="num">${roundsSpent(r)}/${r.maxRounds}</td></tr>`)}</tbody></table>`}
</section>
</div>`;
}
