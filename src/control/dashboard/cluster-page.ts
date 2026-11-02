/**
 * Renders the Cluster page: a card for every node with its load, memory, disk, pylons, release and open checks, and
 * under them the picked node's detail, which `/nodes/<name>` opens: the cleanup the person is asked to confirm, what its
 * probe reads of its host's health and its pylon processes, and graphs of its history.
 */
import type { NodeName, ThreadId } from "../../ids.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import type { NodeRecord } from "../node-store.ts";
import { diskText, lowDisk } from "../../disk-space.ts";
import { countedCapacity } from "../../protocol/observations.ts";
import { gib, nodePylons, overcommitted } from "../placement.ts";
import { releaseView } from "../releases.ts";
import { utc } from "../usage.ts";
import { seriesKey, seriesLabel, seriesOf, type Series } from "../node-metrics.ts";
import { charts, ranges } from "./graph-data.ts";
import { Html, html, menu, dot, icon, type Part } from "./view.ts";
import type { Context } from "./context.ts";
import { cleanupCard } from "./cards.ts";
import { layout, statusTone } from "./shell.ts";
import { lifeOfThread, miniTrack, threadRole } from "./lifecycle.ts";

const unknown = html`<span class="dim">unknown</span>`;

/**
 * The node's newest sample as the registry recorded it, with the label the metrics API gives each pylon series, so the
 * graphs append what a reload would show, and nothing when this read was too soon after the last to be recorded.
 */
function sampleAttribute(c: Context, name: NodeName): Html | false {
  const sample = c.registry.latestHealthSample(name);
  if (sample === null) return false;
  const labels = Object.keys(sample.values).flatMap((key) => {
    const s = seriesOf(key);
    return s?.kind === "pylonCpu" || s?.kind === "pylonResident" ? [[key, seriesLabel(s, (t) => c.registry.thread(t)?.title)] as const] : [];
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

/** The open cleanup question, and the newest answered one with what its deletes did. */
function cleanup(c: Context, name: NodeName): Html {
  const asked = c.registry.nodeQuestions(name);
  const shown = [asked.findLast((q) => q.answer === null), asked.findLast((q) => q.answer !== null)].filter((q) => q !== undefined);
  return html`<section aria-labelledby="node-cleanup-h"><div class="ov-head"><h2 id="node-cleanup-h">Cleanup</h2></div>
<p id="action-error" class="error" role="alert" hidden></p>
${shown.length === 0 ? html`<p class="empty">Nothing on this node waits to be deleted.</p>` : html`<div class="cleanups">${shown.map((q) => cleanupCard(c, q))}</div>`}
</section>`;
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

/** A share of something as a meter, quiet until it runs high, with its words beside it so the colour is never all it says. */
function meter(label: string, used: number | null, total: number | null, words: Part): Html {
  const known = used !== null && total !== null && total > 0;
  return html`<div class="meter"><dt>${label}</dt><dd>${known ? html`<meter min="0" max="${total}" low="${total * 0.75}" high="${total * 0.9}" optimum="0" value="${Math.min(used, total)}"></meter>` : html`<span class="meter-none" aria-hidden="true"></span>`}<span class="meter-words">${words}</span></dd></div>`;
}

/** What a node's card shows of its host. */
interface Reading { cpus: number; load: number | null; memory: { totalGiB: number; availableGiB: number } | null; disk: { totalGiB: number; freeGiB: number } }

function liveReading(h: NodeHealth): Reading {
  const disks = h.disks ?? [{ ...h.disk, paths: [h.disk.path] }];
  const disk = disks.find((d) => "pylons" in d && d.pylons === true) ?? disks[0]!;
  return { cpus: h.cpus, load: h.load?.one ?? null, memory: h.memory, disk };
}

/** How old a recorded sample may be for a card to show it. The control plane samples every online node once a minute. */
const recentMs = 5 * 60_000;

/** A node's newest recorded sample, or null when it has none from the last `recentMs`. */
function recordedReading(c: Context, name: NodeName): Reading | null {
  const m = c.registry.nodeMetrics(name, c.now - recentMs, c.now, c.now);
  if (m.sampledAt === null || c.now - m.sampledAt > recentMs) return null;
  const last = (s: Series) => m.series.find((x) => x.key === seriesKey(s))?.avg.at(-1) ?? null;
  const [cpus, totalGiB, freeGiB, load, memTotal, memAvailable] = ([{ kind: "cpus" }, { kind: "diskTotal" }, { kind: "diskFree" }, { kind: "load1" }, { kind: "memTotal" }, { kind: "memAvailable" }] as const).map(last);
  if (cpus == null || totalGiB == null || freeGiB == null) return null;
  return { cpus, load: load ?? null, memory: memTotal == null || memAvailable == null ? null : { totalGiB: memTotal, availableGiB: memAvailable }, disk: { totalGiB, freeGiB } };
}

/** A node's card: its state, what its probe read of its load, memory and disk, its pylons, release and open checks. */
function nodeCard(c: Context, n: NodeRecord, reading: Reading | Error | null, releases: ReturnType<typeof releaseLines>, picked: boolean): Html {
  const read = reading instanceof Error ? null : reading;
  const disk = read?.disk;
  const problems = c.registry.healthStates().filter((s) => s.status !== "ok" && s.node === n.name);
  const tallies = nodePylons(c.registry, n);
  const asked = c.registry.openNodeQuestions().some((q) => q.node === n.name);
  return html`<article class="node-card${picked && " picked"}" data-node="${n.name}" aria-labelledby="node-${n.name}-h">
<header class="node-card-h"><span>${icon("server")}<a class="link" href="/nodes/${encodeURIComponent(n.name)}" id="node-${n.name}-h"${picked && html` aria-current="page"`} title="Health of ${n.name}">${n.name}</a>${dot(n.state === "online" ? "ok" : "muted")}${n.state === "offline" && html`<em>offline</em>`}${overcommitted(n.capacity) && html`<em>overcommitted</em>`}${lowDisks(n).length > 0 && html`<em title="${lowDisks(n).map(diskText).join("; ")}">disk low</em>`}</span>${memoryLine(c, n)}${releases.map((r) => html`<small title="${r.reason ?? ""}">${r.role}: ${r.commit?.slice(0, 12) ?? "unknown"} · ${r.state}</small>`)}</header>
<dl class="meters">
${meter("Load", read?.load ?? null, read?.cpus ?? null, read === null ? html`<span class="dim"${reading instanceof Error && html` title="${reading.message}"`}>${reading instanceof Error ? "not read" : "no reading in 5 minutes"}</span>` : read.load === null ? html`<span class="dim">unknown</span>` : `${read.load.toFixed(2)} on ${read.cpus} CPUs`)}
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
export function clusterPage(c: Context, name: NodeName, health: NodeHealth | Error, mayRead: boolean): Html {
  const releases = Map.groupBy(releaseLines(c), (r) => r.node);
  const nodes = c.registry.nodes();
  const pylonOf = new Map(c.registry.pylonsOn(name).map((p) => [p.pylonId, p.thread]));
  const reading = html`<section aria-labelledby="node-health-h"><div class="ov-head"><h2 id="node-health-h">Health</h2></div>
${health instanceof Error ? html`<p class="error" role="alert">${health.message}</p>` : html`<dl class="kv node-health"${sampleAttribute(c, name)}>
<dt>Read</dt><dd><time datetime="${health.readAt}">${utc(Date.parse(health.readAt))}</time></dd>
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
  const thread = pylonOf.get(p.pylonId);
  return html`<tr><td class="wide"><code>${p.pylonId}</code></td><td>${thread === undefined ? html`<span class="dim">${p.pylonId}, not in the registry</span>` : html`<a class="link" href="/threads/${thread}" title="${p.pylonId}">${c.registry.thread(thread as ThreadId)?.title ?? thread}</a>${threadRole(c, thread as ThreadId).kind === "builder" && miniTrack(lifeOfThread(c, thread as ThreadId))}`}</td><td class="wide">${p.processes}</td><td>${p.cpuPercent.toFixed(1)}%</td><td>${gib(p.residentGiB)} GiB</td></tr>`;
})}</tbody>
</table>`}
<p class="dim small">CPU is the percent of one CPU a pylon's processes used over the second the probe sampled, so four busy CPUs read 400%.</p>
</section>`;
  return layout(c, {
    title: `Cluster: ${name}`,
    nav: "cluster",
    main: html`<header class="bar">${menu}<div class="crumb"><a class="crumb-p" href="/cluster">Cluster</a><span class="sep" aria-hidden="true">/</span><h1>${name}</h1></div></header>
<div class="scroll"><div class="page page-cluster"><section class="cluster" id="cluster-nodes" aria-label="Nodes" data-live>
<div class="ov-head"><h2>Nodes</h2><span class="count">${nodes.length}</span><span class="dim">Desired release ${c.registry.desiredRelease()?.commit.slice(0, 12) ?? "manual"}</span></div>
<div class="node-cards">${nodes.map((n) => nodeCard(c, n, n.name === name ? (health instanceof Error ? health : liveReading(health)) : mayRead ? recordedReading(c, n.name) : new Error("Only a deployer reads a node's health"), releases.get(n.name) ?? [], n.name === name))}</div>
</section>
<div class="node-detail"><h2 class="node-detail-h">${name}</h2><div class="node-live" id="node-cleanup" data-live>${cleanup(c, name)}</div><div class="node-live" id="node-health" data-live>
${reading}
${pylons}
</div>
${graphs(name)}
</div></div></div>`,
  });
}
