/**
 * Renders the Cluster page: a card for every node with its load, memory, disk, pylons, release and open checks, a line
 * of what each node's latest cleanup freed, and under them the picked node's detail, which `/nodes/<name>` opens: the
 * cleanup the person is asked to confirm, what its probe reads of its host's health and its pylon processes, and graphs
 * of its history.
 */
import type { NodeName } from "../../ids.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import type { NodeRecord } from "../node-store.ts";
import { diskText, lowDisk } from "../../disk-space.ts";
import { overcommitted } from "../placement.ts";
import { gib } from "../../util/gib.ts";
import { seriesKey, seriesLabel, seriesOf, type MetricSeries, type Series } from "../node-metrics.ts";
import { bytesText, lastCleanup } from "../cleanup-model.ts";
import { isOpen } from "../questions.ts";
import { charts, ranges } from "./graph-data.ts";
import { Html, html, menu, dot, icon, ago, localAt, type Part } from "./view.ts";
import { duration } from "../wording.ts";
import type { ClusterView, Context, NodeReading } from "./context.ts";
import { cleanupCard } from "./cards.ts";
import { layout, statusTone } from "./shell.ts";
import { lifeOfThread, miniTrack } from "./lifecycle.ts";

const unknown = html`<span class="dim">unknown</span>`;

/**
 * The node's newest sample as the registry recorded it, with the label the metrics API gives each pylon series, so the
 * graphs append what a reload would show, and nothing when this read was too soon after the last to be recorded.
 */
function sampleAttribute(c: Context, sample: ClusterView["sample"]): Html | false {
  if (sample === null) return false;
  const labels = Object.keys(sample.values).flatMap((key) => {
    const s = seriesOf(key);
    return s?.kind === "pylonCpu" || s?.kind === "pylonResident" ? [[key, seriesLabel(s, (t) => c.thread(t)?.title)] as const] : [];
  });
  return html` data-sample="${JSON.stringify({ ...sample, labels: Object.fromEntries(labels) })}"`;
}

/**
 * The graphs' frame, which node-graphs.js draws into. It is outside the live region, so a poll's swap leaves the
 * charts alone, and each figure has a fixed height, so nothing moves when the data comes.
 */
const graphs = (name: NodeName) => html`<section id="node-graphs" class="graphs" aria-labelledby="node-graphs-h" data-node="${name}"><div class="ov-head"><h2 id="node-graphs-h">Graphs</h2>
<div class="fv-layout graph-ranges" role="group" aria-label="Range">${ranges.map(([range]) => html`<button type="button" data-range="${range}" aria-pressed="false">${range}</button>`)}</div></div>
<p class="error" id="graphs-error" hidden></p>
<div class="graph-grid">${charts.map((chart) => html`<figure class="graph" data-chart="${chart.id}"><figcaption><span class="graph-title">${chart.title}</span>${chart.unit !== "" && html` <span class="graph-unit">${chart.unit}</span>`}</figcaption>
<div class="graph-plot"><p class="empty graph-empty" hidden></p></div><div class="graph-legend"></div></figure>`)}</div>
</section>`;

/** The open cleanup question, which the person answers. What an answered one did is in the cleanup line. */
function cleanup(c: Context, cleanups: ClusterView["nodes"][number]["cleanups"]): Html {
  const open = cleanups.findLast(isOpen);
  return html`<section aria-labelledby="node-cleanup-h"><div class="ov-head"><h2 id="node-cleanup-h">Cleanup</h2></div>
${open === undefined ? html`<p class="empty">No cleanup question waits on you.</p>` : cleanupCard(c, open)}
</section>`;
}

const itemCount = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** One line of what each node's latest cleanup freed and when, with any item it could not delete or still waits on. */
function cleanupLine(c: Context, nodes: ClusterView["nodes"]): Html | false {
  const done = nodes.flatMap(({ node, cleanups }) => {
    const last = lastCleanup(cleanups);
    return last === null ? [] : [{ node: node.name, ...last }];
  });
  if (done.length === 0) return false;
  const parts = done.map((d, i) => {
    const left = [d.skipped > 0 && `${itemCount(d.skipped)} could not be deleted`, d.waiting > 0 && `${itemCount(d.waiting)} still to go`].filter((x) => x !== false);
    return html`${i > 0 && (i === done.length - 1 ? " and " : ", ")}${bytesText(d.freed)}${i === 0 && " freed"} on ${d.node} ${ago(d.at, c.now)}${left.length > 0 && html` <span class="bad-text">(${left.join(", ")})</span>`}`;
  });
  return html`<p class="cleanup-line dim">Last cleanup: ${parts}</p>`;
}

const lowDisks = (n: NodeRecord) => n.capacity?.disks?.filter(lowDisk) ?? [];

/** A node's committed and total memory, and what its paused pylons need to wake. */
function memoryLine(n: NodeRecord, tallies: ClusterView["nodes"][number]["pylons"]): Html | false {
  const { capacity } = n;
  if (capacity === null) return false;
  const paused = tallies?.paused.memoryGiB ?? 0;
  return html`<small>${gib(capacity.committedMemoryGiB)}/${gib(capacity.memoryGiB)} GiB memory${paused > 0 && ` · ${gib(paused)} GiB to wake paused`}</small>`;
}

/** A share of something as a meter, quiet until it runs high, with its words beside it so the colour is never all it says. */
function meter(label: string, used: number | null, total: number | null, words: Part): Html {
  const known = used !== null && total !== null && total > 0;
  return html`<div class="meter"><dt>${label}</dt><dd>${known ? html`<meter min="0" max="${total}" low="${total * 0.75}" high="${total * 0.9}" optimum="0" value="${Math.min(used, total)}"></meter>` : html`<span class="meter-none" aria-hidden="true"></span>`}<span class="meter-words">${words}</span></dd></div>`;
}

export function liveReading(h: NodeHealth): NodeReading {
  const disks = h.disks ?? [{ ...h.disk, paths: [h.disk.path] }];
  const disk = disks.find((d) => "pylons" in d && d.pylons === true) ?? disks[0]!;
  return { kind: "read", cpus: h.cpus, load: h.load?.one ?? null, memory: h.memory, disk };
}

/** How old a recorded sample may be for a card to show it. The control plane samples every online node once a minute. */
export const recentMs = 5 * 60_000;

export function recordedReading(m: { sampledAt: number | null; series: readonly Pick<MetricSeries, "key" | "avg">[] }, now: number): NodeReading {
  if (m.sampledAt === null || now - m.sampledAt > recentMs) return { kind: "stale" };
  const last = (s: Series) => m.series.find((x) => x.key === seriesKey(s))?.avg.at(-1) ?? null;
  const [cpus, totalGiB, freeGiB, load, memTotal, memAvailable] = ([{ kind: "cpus" }, { kind: "diskTotal" }, { kind: "diskFree" }, { kind: "load1" }, { kind: "memTotal" }, { kind: "memAvailable" }] as const).map(last);
  if (cpus == null || totalGiB == null || freeGiB == null) return { kind: "stale" };
  return { kind: "read", cpus, load: load ?? null, memory: memTotal == null || memAvailable == null ? null : { totalGiB: memTotal, availableGiB: memAvailable }, disk: { totalGiB, freeGiB } };
}

/** Why a card shows no reading: its probe's read failed, the caller may not read a node's health, or no sample is recent. */
const unread = (reading: Exclude<NodeReading, { kind: "read" }>) => reading.kind === "stale" ? html`<span class="dim">no reading in ${duration(recentMs)}</span>`
  : html`<span class="dim" title="${reading.kind === "failed" ? reading.error : "Only a deployer reads a node's health"}">not read</span>`;

/** A node's card: its state, what its probe read of its load, memory and disk, its pylons, release and open checks. */
function nodeCard(c: Context, { node: n, reading, pylons: tallies }: ClusterView["nodes"][number], releases: ClusterView["release"]["nodes"], picked: boolean): Html {
  const read = reading.kind === "read" ? reading : null;
  const disk = read?.disk;
  const problems = c.health.states.filter((s) => s.status !== "ok" && s.node === n.name);
  const asked = c.needs.some((q) => q.kind === "cleanup" && q.question.node === n.name);
  return html`<article class="node-card${picked && " picked"}" data-node="${n.name}" aria-labelledby="node-${n.name}-h">
<header class="node-card-h"><span>${icon("server")}<a class="link" href="/nodes/${encodeURIComponent(n.name)}" id="node-${n.name}-h"${picked && html` aria-current="page"`} title="Health of ${n.name}">${n.name}</a>${dot(n.state === "online" ? "ok" : "muted")}${n.state === "offline" && html`<em>offline</em>`}${overcommitted(n.capacity) && html`<em>overcommitted</em>`}${lowDisks(n).length > 0 && html`<em title="${lowDisks(n).map(diskText).join("; ")}">disk low</em>`}</span>${memoryLine(n, tallies)}${releases.map((r) => html`<small title="${r.reason ?? ""}">${r.role}: ${r.commit?.slice(0, 12) ?? "unknown"} · ${r.state}</small>`)}</header>
<dl class="meters">
${meter("Load", read?.load ?? null, read?.cpus ?? null, reading.kind !== "read" ? unread(reading) : reading.load === null ? html`<span class="dim">unknown</span>` : `${reading.load.toFixed(2)} on ${reading.cpus} CPUs`)}
${meter("Memory", read?.memory === null || read === null ? null : read.memory.totalGiB - read.memory.availableGiB, read?.memory?.totalGiB ?? null, read?.memory == null ? html`<span class="dim">unknown</span>` : `${gib(read.memory.availableGiB)} of ${gib(read.memory.totalGiB)} GiB free`)}
${meter("Disk", disk === undefined ? null : disk.totalGiB - disk.freeGiB, disk?.totalGiB ?? null, disk === undefined ? html`<span class="dim">unknown</span>` : `${gib(disk.freeGiB)} of ${gib(disk.totalGiB)} GiB free`)}
</dl>
<p class="node-facts">${tallies === null ? html`<span class="dim">No observation yet</span>` : html`<span>${tallies.up.pylons} running</span><span>${tallies.paused.pylons} paused</span>${tallies.crashed.pylons > 0 && html`<span class="bad-text">${tallies.crashed.pylons} crashed</span>`}`}<a class="link node-checks" href="/health">${problems.length === 0 ? "Every check ok" : `${problems.length} ${problems.length === 1 ? "check" : "checks"} failing`}</a>${asked && html`<a class="link" href="/#needs-you">Cleanup waits on you</a>`}</p>
${problems.length > 0 && html`<ul class="node-problems">${problems.map((p) => html`<li>${dot(statusTone[p.status], p.status)}<span>${p.name}</span></li>`)}</ul>`}
</article>`;
}

/**
 * Every node's card, then the picked node's cleanup, health, pylon processes and graphs. The picked node's card shows
 * the read this page made, and every other node's its newest recorded sample, which a reader that may read health
 * sees, so the page asks one probe.
 */
export function clusterPage(c: Context, view: ClusterView): Html {
  const { name, health, nodes } = view;
  const releases = Map.groupBy(view.release.nodes, (r) => r.node);
  const reading = html`<section aria-labelledby="node-health-h"><div class="ov-head"><h2 id="node-health-h">Health</h2></div>
${health instanceof Error ? html`<p class="error" role="alert">${health.message}</p>` : html`<dl class="kv node-health"${sampleAttribute(c, view.sample)}>
<dt>Read</dt><dd>${localAt(Date.parse(health.readAt))}</dd>
<dt>Load</dt><dd>${health.load === null ? unknown : `${health.load.one.toFixed(2)} · ${health.load.five.toFixed(2)} · ${health.load.fifteen.toFixed(2)} over 1, 5 and 15 minutes, on ${health.cpus} CPUs`}</dd>
<dt>Memory</dt><dd>${health.memory === null ? unknown : `${gib(health.memory.availableGiB)} of ${gib(health.memory.totalGiB)} GiB available`}</dd>
<dt>Swap</dt><dd>${health.memory === null ? unknown : health.memory.swapTotalGiB === 0 ? "none" : `${gib(health.memory.swapTotalGiB - health.memory.swapFreeGiB)} of ${gib(health.memory.swapTotalGiB)} GiB used`}</dd>
<dt>Disk</dt><dd>${health.disks === undefined ? html`${gib(health.disk.freeGiB)} of ${gib(health.disk.totalGiB)} GiB free at <code>${health.disk.path}</code>`
  : health.disks.map((d, i) => html`${i > 0 && html`<br>`}${gib(d.freeGiB)} of ${gib(d.totalGiB)} GiB free at ${d.paths.map((p, j) => html`${j > 0 && ", "}<code>${p}</code>`)}${lowDisk(d) && html` <em>low</em>`}`)}</dd>
<dt>Temperatures</dt><dd>${health.temperatures === null ? unknown : health.temperatures.map((t, i) => html`${i > 0 && html`<br>`}${t.sensor} ${t.celsius.toFixed(1)} °C`)}</dd>
</dl>`}
</section>`;
  const pylons = health instanceof Error ? html`` : html`<section aria-labelledby="node-pylons-h"><div class="ov-head"><h2 id="node-pylons-h">Pylon processes ${health.pylons !== null && html`<span class="count">${health.pylons.length}</span>`}</h2></div>
${health.pylons === null ? html`<p class="empty">This node's backend does not say which processes are its pylons'.</p>` : health.pylons.length === 0 ? html`<p class="empty">No pylon runs on this node.</p>` : html`<table class="ov" id="node-pylons">
<thead><tr><th class="wide">Pylon</th><th>Thread</th><th class="wide">Processes</th><th>CPU</th><th>Resident</th></tr></thead>
<tbody>${health.pylons.map((p) => {
  const of = view.pylonThreads.get(p.pylonId);
  return html`<tr><td class="wide"><code>${p.pylonId}</code></td><td>${of === undefined ? html`<span class="dim">${p.pylonId}, not in the registry</span>` : html`<a class="link" href="/threads/${of.thread}" title="${p.pylonId}">${c.thread(of.thread)?.title ?? of.thread}</a>${of.builder && miniTrack(lifeOfThread(c, of.thread))}`}</td><td class="wide">${p.processes}</td><td>${p.cpuPercent.toFixed(1)}%</td><td>${gib(p.residentGiB)} GiB</td></tr>`;
})}</tbody>
</table>`}
<p class="dim small">CPU is the percent of one CPU a pylon's processes used over the second the probe sampled, so four busy CPUs read 400%.</p>
</section>`;
  return layout(c, {
    title: `Cluster: ${name}`,
    nav: "cluster",
    page: "cluster",
    main: html`<header class="bar">${menu}<div class="crumb"><a class="crumb-p" href="/cluster">Cluster</a><span class="sep" aria-hidden="true">/</span><h1>${name}</h1></div></header>
<div class="scroll"><div class="page page-cluster"><section class="cluster" id="cluster-nodes" aria-label="Nodes" data-live>
<div class="ov-head"><h2>Nodes</h2><span class="count">${nodes.length}</span><span class="dim">Desired release ${view.release.desired?.commit.slice(0, 12) ?? "manual"}</span></div>
${cleanupLine(c, nodes)}
<div class="node-cards">${nodes.map((n) => nodeCard(c, n, releases.get(n.node.name) ?? [], n.node.name === name))}</div>
</section>
<div class="node-detail"><h2 class="node-detail-h">${name}</h2><div class="node-live" id="node-cleanup" data-live>${cleanup(c, nodes.find((n) => n.node.name === name)?.cleanups ?? [])}</div><div class="node-live" id="node-health" data-live>
${reading}
${pylons}
</div>
${graphs(name)}
</div></div></div>`,
  });
}
