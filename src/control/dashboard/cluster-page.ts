/**
 * Renders the Cluster page: a tile for each node with its load, memory, disk, pylons, release and open problems, the
 * latest pass of `nexus doctor`'s checks, and the picked node in full: its cleanup, what its probe reads of its host,
 * its pylon processes and graphs of its history. `/nodes/<name>` is this page with that node picked, and `/health` is
 * this page too.
 */
import type { NodeName, ThreadId } from "../../ids.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import type { NodeRecord } from "../node-store.ts";
import { diskText, lowDisk } from "../../disk-space.ts";
import { countedCapacity } from "../../protocol/observations.ts";
import { gib, nodePylons, overcommitted } from "../placement.ts";
import { releaseView } from "../releases.ts";
import { utc } from "../usage.ts";
import { seriesLabel, seriesOf } from "../node-metrics.ts";
import { checkKey, healthView, worst, type Check, type DoctorReport } from "../doctor-model.ts";
import { charts, ranges } from "./graph-data.ts";
import { Html, html, dot, icon, menu, state } from "./view.ts";
import type { Context } from "./context.ts";
import { cleanupCard } from "./cards.ts";
import { layout, statusTone as tone } from "./shell.ts";
import { lifeOfThread, miniTrack } from "./lifecycle.ts";

const unknown = html`<span class="dim">unknown</span>`;
const at = (iso: string) => html`<time datetime="${iso}">${utc(Date.parse(iso))}</time>`;
const checkName = (c: Pick<Check, "node" | "name">) => `${c.node ?? "Control plane"} ${c.name}`;

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

/** A share as a bar, which says its numbers in words beside it. */
const meter = (used: number, total: number, low = false) => html`<meter class="meter${low && " meter-low"}" min="0" max="${Math.max(total, used)}" value="${used}" aria-hidden="true"></meter>`;

/** A node's tile: what it is, how full it is, what runs on it and at which release, and its open problems. */
function tile(c: Context, n: NodeRecord, health: NodeHealth | Error, picked: boolean, problems: number, releases: ReturnType<typeof releaseLines>): Html {
  const capacity = countedCapacity(n.capacity);
  const paused = nodePylons(c.registry, n)?.paused.memoryGiB ?? 0;
  const read = health instanceof Error ? null : health;
  const disk = read === null ? null : read.disks?.[0] ?? { ...read.disk, paths: [read.disk.path] };
  const flags = [n.state === "offline" && "offline", overcommitted(n.capacity) && "overcommitted", lowDisks(n).length > 0 && "disk low"].filter((f) => f !== false);
  return html`<li><a class="tile${picked && " picked"}" href="/nodes/${encodeURIComponent(n.name)}"${picked && html` aria-current="page"`} data-node="${n.name}">
<span class="tile-h">${icon("server")}<span class="tile-name">${n.name}</span>${dot(n.state === "online" ? "ok" : "muted", n.state)}${flags.map((f) => html`<em title="${f === "disk low" ? lowDisks(n).map(diskText).join("; ") : ""}">${f}</em>`)}${problems > 0 && html`<span class="tile-bad">${problems} ${problems === 1 ? "problem" : "problems"}</span>`}</span>
<span class="tile-row"><span class="tile-k">Load</span>${read?.load == null ? unknown : html`${meter(read.load.one, read.cpus)}<span>${read.load.one.toFixed(2)} on ${read.cpus} CPUs</span>`}</span>
<span class="tile-row"><span class="tile-k">Memory</span>${capacity === null ? unknown : html`${meter(capacity.committedMemoryGiB, capacity.memoryGiB)}<small>${gib(capacity.committedMemoryGiB)}/${gib(capacity.memoryGiB)} GiB memory${paused > 0 && ` · ${gib(paused)} GiB to wake paused`}</small>`}</span>
<span class="tile-row"><span class="tile-k">Disk</span>${disk === null ? unknown : html`${meter(disk.totalGiB - disk.freeGiB, disk.totalGiB, lowDisk(disk))}<span>${gib(disk.freeGiB)} of ${gib(disk.totalGiB)} GiB free</span>`}</span>
<span class="tile-row"><span class="tile-k">Pylons</span><span>${read?.pylons == null ? c.registry.pylonsOn(n.name).length : read.pylons.length} running</span></span>
<span class="tile-row tile-rel"><span class="tile-k">Release</span><span class="tile-lines">${releases.map((r) => html`<small title="${r.reason ?? ""}">${r.role}: ${r.commit?.slice(0, 12) ?? "unknown"} · ${r.state}</small>`)}</span></span>
</a></li>`;
}

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
${shown.length === 0 ? html`<p class="empty">Nothing on this node waits to be deleted.</p>` : html`<div class="cleanups">${shown.map((q) => cleanupCard(c, q))}</div>`}
</section>`;
}

/** What the picked node's probe reads of its host when the page loads, and its pylons' processes. */
function reading(c: Context, name: NodeName, health: NodeHealth | Error): Html {
  const pylonOf = new Map(c.registry.pylonsOn(name).map((p) => [p.pylonId, p.thread]));
  const kv = html`<section aria-labelledby="node-health-h"><div class="ov-head"><h2 id="node-health-h">Health</h2></div>
${health instanceof Error ? html`<p class="error" role="alert">${health.message}</p>` : html`<dl class="kv node-health"${sampleAttribute(c, name)}>
<dt>Read</dt><dd>${at(health.readAt)}</dd>
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
  return html`<tr><td class="wide"><code>${p.pylonId}</code></td><td>${thread === undefined ? html`<span class="dim">${p.pylonId}, not in the registry</span>` : html`<a class="link" href="/threads/${thread}" title="${p.pylonId}">${c.registry.thread(thread as ThreadId)?.title ?? thread}</a>${miniTrack(lifeOfThread(c, thread as ThreadId))}`}</td><td class="wide">${p.processes}</td><td>${p.cpuPercent.toFixed(1)}%</td><td>${gib(p.residentGiB)} GiB</td></tr>`;
})}</tbody>
</table>`}
<p class="dim small">CPU is the percent of one CPU a pylon's processes used over the second the probe sampled, so four busy CPUs read 400%.</p>
</section>`;
  return html`${kv}${pylons}`;
}

/**
 * The latest pass's checks grouped by the control plane and each node, or before a start's first pass the problems
 * recorded. `data-health-through` names the newest problem shown, which the page marks seen once the person looks at it.
 */
function checks(view: ReturnType<typeof healthView>, latest: DoctorReport | null): Html {
  const open = new Map(view.problems.map((p) => [checkKey(p), p]));
  const shown = latest?.checks ?? view.problems;
  const groups = [...Map.groupBy(shown, (check) => check.node ?? "Control plane")];
  return html`<div class="ov-head"><h2 id="checks-h">Checks</h2></div>
<p data-health-through="${Math.max(0, ...view.problems.map((p) => p.id))}">${state(view.problems.length === 0 ? "Every check is ok" : `${view.problems.length} open ${view.problems.length === 1 ? "problem" : "problems"}`, tone[worst(view.problems)])}${latest === null ? html` No pass since the control plane started. It runs <code>nexus doctor</code>'s checks every 5 minutes from 5 minutes after a start, and <code>nexus doctor</code> runs them now.` : html` Checked at ${at(latest.at)}.`}</p>
${groups.map(([group, list]) => html`<section class="check-group" aria-label="${group}"><h3 class="ov-sub">${group}</h3>
<table class="ov ov-report"><thead><tr><th>Check</th><th class="wide">What it found</th><th>Since</th></tr></thead>
<tbody>${list.map((check) => {
  const problem = open.get(checkKey(check));
  const since = problem !== undefined ? html`${problem.status} since ${at(problem.at)}${problem.seenAt === null && html` <em>new</em>`}`
    : check.status !== "ok" ? "this pass only, so it alerts if the next agrees" : "";
  return html`<tr data-check="${check.name}" data-status="${check.status}"><td><span class="ov-title">${dot(tone[check.status], check.status)}<span>${check.name}</span></span></td><td class="wide">${check.text}</td><td>${since}</td></tr>`;
})}</tbody>
</table></section>`)}`;
}

export function clusterPage(c: Context, picked: NodeName | null, healths: ReadonlyMap<NodeName, NodeHealth | Error>, latest: DoctorReport | null): Html {
  const nodes = c.registry.nodes();
  const view = healthView(latest, c.registry.healthStates());
  const releases = Map.groupBy(releaseLines(c), (r) => r.node);
  const changes = c.registry.healthChanges();
  const node = nodes.find((n) => n.name === picked) ?? nodes[0];
  return layout(c, {
    title: node !== undefined && picked !== null ? `Cluster: ${node.name}` : "Cluster",
    nav: "cluster",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Cluster</h1></div></header>
<div class="scroll"><div class="page cluster">
<p id="action-error" class="error" role="alert" hidden></p>
<section aria-labelledby="nodes-h"><div class="ov-head"><h2 id="nodes-h">Nodes</h2><span class="dim">Desired release ${c.registry.desiredRelease()?.commit.slice(0, 12) ?? "manual"}</span></div>
${nodes.length === 0 ? html`<p class="empty">No nodes yet. A node joins once its probe reaches the control plane.</p>` : html`<ul class="tiles" id="cluster-nodes" data-live>${nodes.map((n) => tile(c, n, healths.get(n.name) ?? new Error("not read"), n === node, view.problems.filter((p) => p.node === n.name).length, releases.get(n.name) ?? []))}</ul>`}
</section>
<section class="report" id="health" aria-labelledby="checks-h" data-live>${checks(view, latest)}</section>
${node !== undefined && html`<div class="node-detail" aria-label="${node.name}"><h2 class="node-title">${icon("server")}${node.name}</h2>
<div class="node-live" id="node-cleanup" data-live>${cleanup(c, node.name)}</div>
<div class="node-live" id="node-health" data-live>${reading(c, node.name, healths.get(node.name) ?? new Error("not read"))}</div>
${graphs(node.name)}</div>`}
<section aria-labelledby="changes-h" id="health-changes" data-live><div class="ov-head"><h2 id="changes-h">Changes in the last 30 days</h2></div>
${changes.length === 0 ? html`<p class="empty">No check has changed.</p>` : html`<ul class="report-list">${changes.map((change) => html`<li data-change="${change.id}" data-status="${change.status}">${at(change.at)} ${checkName(change)} ${state(change.from, tone[change.from])} to ${state(change.status, tone[change.status])}: ${change.text}</li>`)}</ul>`}
</section>
</div></div>`,
  });
}
