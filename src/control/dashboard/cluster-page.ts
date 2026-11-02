/**
 * Renders the Cluster page: every node in one table with its load, memory, disk, pylons and release, the health checks
 * of `nexus doctor` with their changes, and the picked node in full, with its cleanup, what its probe reads of its host,
 * its pylon processes and graphs of its history. `/nodes/<name>` is this page with that node picked.
 */
import type { NodeName, ThreadId } from "../../ids.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import { countedCapacity } from "../../protocol/observations.ts";
import { diskText, lowDisk } from "../../disk-space.ts";
import type { NodeRecord } from "../node-store.ts";
import { gib, nodePylons, overcommitted } from "../placement.ts";
import { releaseView } from "../releases.ts";
import { utc } from "../usage.ts";
import { seriesLabel, seriesOf } from "../node-metrics.ts";
import { checkKey, healthView, worst, type Check, type DoctorReport } from "../doctor-model.ts";
import { charts, ranges } from "./graph-data.ts";
import { Html, html, dot, menu, state } from "./view.ts";
import type { Context } from "./context.ts";
import { cleanupCard } from "./cards.ts";
import { layout, statusTone as tone } from "./shell.ts";

const unknown = html`<span class="dim">unknown</span>`;
const at = (iso: string) => html`<time datetime="${iso}">${utc(Date.parse(iso))}</time>`;

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
function memoryCell(c: Context, n: NodeRecord): Html {
  const capacity = countedCapacity(n.capacity);
  if (capacity === null) return unknown;
  const paused = nodePylons(c.registry, n)?.paused.memoryGiB ?? 0;
  return html`${gib(capacity.committedMemoryGiB)}/${gib(capacity.memoryGiB)} GiB${paused > 0 && html`<small>${gib(paused)} GiB to wake paused</small>`}`;
}

/** Each node on one row: whether it is up and what marks it, its load and disk as its probe read them, and its release. */
function nodesTable(c: Context, picked: NodeName | null, healths: ReadonlyMap<NodeName, NodeHealth | Error>): Html {
  const releases = Map.groupBy(releaseLines(c), (r) => r.node);
  return html`<section aria-labelledby="nodes-h"><div class="ov-head"><h2 id="nodes-h">Nodes</h2><span class="dim">Desired release ${c.registry.desiredRelease()?.commit.slice(0, 12) ?? "manual"}</span></div>
<table class="ov ov-nodes">
<thead><tr><th>Node</th><th>Load</th><th class="wide">Memory committed</th><th class="wide">Disk</th><th class="wide">Pylons</th><th class="wide">Release</th></tr></thead>
<tbody>${c.registry.nodes().map((n) => {
  const health = healths.get(n.name);
  const read = health instanceof Error || health === undefined ? null : health;
  const pylons = nodePylons(c.registry, n);
  const low = lowDisks(n);
  return html`<tr data-node="${n.name}"${n.name === picked && html` class="picked"`}>
<td><span class="ov-title">${dot(n.state === "online" ? "ok" : "muted", n.state)}<a href="/nodes/${encodeURIComponent(n.name)}"${n.name === picked && html` aria-current="page"`}>${n.name}</a>${n.state === "offline" && html`<span class="tag">offline</span>`}${overcommitted(n.capacity) && html`<span class="tag tag-bad">overcommitted</span>`}${low.length > 0 && html`<span class="tag tag-bad" title="${low.map(diskText).join("; ")}">disk low</span>`}</span></td>
<td>${read?.load == null ? unknown : html`${(read.load.one / read.cpus).toFixed(2)}<small>per CPU, ${read.cpus} CPUs</small>`}</td>
<td class="wide">${memoryCell(c, n)}</td>
<td class="wide">${read === null ? unknown : html`${gib(read.disk.freeGiB)} of ${gib(read.disk.totalGiB)} GiB free`}</td>
<td class="wide">${pylons === null ? unknown : html`${pylons.up.pylons} up${pylons.paused.pylons > 0 && html`<small>${pylons.paused.pylons} paused</small>`}`}</td>
<td class="wide ov-release">${releases.get(n.name)?.map((r) => html`<small title="${r.reason ?? r.commit ?? ""}">${r.role} ${r.commit?.slice(0, 12) ?? "unknown"}, ${r.state}</small>`)}</td>
</tr>`;
})}</tbody>
</table></section>`;
}

const checkName = (c: Pick<Check, "node" | "name">) => `${c.node ?? "Control plane"} ${c.name}`;

/**
 * The latest pass's checks grouped by the control plane and each node, or before a start's first pass the problems
 * recorded, and every change kept, newest first. `data-health-through` names the newest problem shown, which the page
 * marks seen once the person looks at it.
 */
function checks(c: Context, latest: DoctorReport | null): Html {
  const view = healthView(latest, c.registry.healthStates());
  const open = new Map(view.problems.map((p) => [checkKey(p), p]));
  const shown = latest?.checks ?? view.problems;
  const groups = [...Map.groupBy(shown, (check) => check.node ?? "Control plane")];
  const changes = c.registry.healthChanges();
  return html`<div class="ov-head"><h2 id="health-h">Health checks</h2></div>
<p class="report-status" data-health-through="${Math.max(0, ...view.problems.map((p) => p.id))}">${state(view.problems.length === 0 ? "Every check is ok" : `${view.problems.length} open ${view.problems.length === 1 ? "problem" : "problems"}`, tone[worst(view.problems)])}${latest === null ? html` No pass since the control plane started. It runs <code>nexus doctor</code>'s checks every 5 minutes from 5 minutes after a start, and <code>nexus doctor</code> runs them now.` : html` Checked at ${at(latest.at)}.`}</p>
${groups.map(([group, checks]) => html`<section class="report-group" aria-label="${group}"><h3>${group}</h3>
<table class="ov ov-report"><thead><tr><th>Check</th><th class="wide">What it found</th><th>Since</th></tr></thead>
<tbody>${checks.map((check) => {
  const problem = open.get(checkKey(check));
  const since = problem !== undefined ? html`${problem.status} since ${at(problem.at)}${problem.seenAt === null && html` <em>new</em>`}`
    : check.status !== "ok" ? "this pass only, so it alerts if the next agrees" : "";
  return html`<tr data-check="${check.name}" data-status="${check.status}"><td><span class="ov-title">${dot(tone[check.status], check.status)}<span>${check.name}</span></span></td><td class="wide">${check.text}</td><td>${since}</td></tr>`;
})}</tbody>
</table></section>`)}
<details class="ov-closed" id="health-changes"><summary>Changes in the last 30 days${changes.length > 0 && `, ${changes.length}`}</summary>
${changes.length === 0 ? html`<p class="empty">No check has changed.</p>` : html`<ul class="report-list">${changes.map((change) => html`<li data-change="${change.id}" data-status="${change.status}">${at(change.at)} ${checkName(change)} ${state(change.from, tone[change.from])} to ${state(change.status, tone[change.status])}: ${change.text}</li>`)}</ul>`}
</details>`;
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
const graphs = (name: NodeName) => html`<section id="node-graphs" class="graphs" aria-labelledby="node-graphs-h" data-node="${name}"><div class="ov-head"><h3 id="node-graphs-h">Graphs</h3>
<div class="fv-layout graph-ranges" role="group" aria-label="Range">${ranges.map(([range]) => html`<button type="button" data-range="${range}" aria-pressed="false">${range}</button>`)}</div></div>
<p class="error" id="graphs-error" hidden></p>
<div class="graph-grid">${charts.map((chart) => html`<figure class="graph" data-chart="${chart.id}"><figcaption><span class="graph-title">${chart.title}</span>${chart.unit !== "" && html` <span class="graph-unit">${chart.unit}</span>`}</figcaption>
<div class="graph-plot"><p class="empty graph-empty" hidden></p></div><div class="graph-legend"></div></figure>`)}</div>
</section>`;

/** The open cleanup question, and the newest answered one with what its deletes did. */
function cleanup(c: Context, name: NodeName): Html | false {
  const asked = c.registry.nodeQuestions(name);
  const shown = [asked.findLast((q) => q.answer === null), asked.findLast((q) => q.answer !== null)].filter((q) => q !== undefined);
  return html`<p id="action-error" class="error" role="alert" hidden></p>
${shown.length === 0 ? html`<p class="empty">Nothing on ${name} waits to be deleted.</p>` : html`<div class="cleanups">${shown.map((q) => cleanupCard(c, q))}</div>`}`;
}

/** What the node's probe reads of its host when the page loads, and its pylon processes. */
function reading(c: Context, name: NodeName, health: NodeHealth | Error): Html {
  const pylonOf = new Map(c.registry.pylonsOn(name).map((p) => [p.pylonId, p.thread]));
  return html`<section aria-labelledby="node-health-h"><h3 id="node-health-h">Host</h3>
${health instanceof Error ? html`<p class="error" role="alert">${health.message}</p>` : html`<dl class="kv node-health"${sampleAttribute(c, name)}>
<dt>Read</dt><dd><time datetime="${health.readAt}">${utc(Date.parse(health.readAt))}</time></dd>
<dt>Load</dt><dd>${health.load === null ? unknown : `${health.load.one.toFixed(2)} · ${health.load.five.toFixed(2)} · ${health.load.fifteen.toFixed(2)} over 1, 5 and 15 minutes, on ${health.cpus} CPUs`}</dd>
<dt>Memory</dt><dd>${health.memory === null ? unknown : `${gib(health.memory.availableGiB)} of ${gib(health.memory.totalGiB)} GiB available`}</dd>
<dt>Swap</dt><dd>${health.memory === null ? unknown : health.memory.swapTotalGiB === 0 ? "none" : `${gib(health.memory.swapTotalGiB - health.memory.swapFreeGiB)} of ${gib(health.memory.swapTotalGiB)} GiB used`}</dd>
<dt>Disk</dt><dd>${health.disks === undefined ? html`${gib(health.disk.freeGiB)} of ${gib(health.disk.totalGiB)} GiB free at <code>${health.disk.path}</code>`
  : health.disks.map((d, i) => html`${i > 0 && html`<br>`}${gib(d.freeGiB)} of ${gib(d.totalGiB)} GiB free at ${d.paths.map((p, j) => html`${j > 0 && ", "}<code>${p}</code>`)}${lowDisk(d) && html` <em>low</em>`}`)}</dd>
<dt>Temperatures</dt><dd>${health.temperatures === null ? unknown : health.temperatures.map((t, i) => html`${i > 0 && html`<br>`}${t.sensor} ${t.celsius.toFixed(1)} °C`)}</dd>
</dl>`}
</section>
${!(health instanceof Error) && html`<section aria-labelledby="node-pylons-h"><h3 id="node-pylons-h">Pylon processes ${health.pylons !== null && html`<span class="count">${health.pylons.length}</span>`}</h3>
${health.pylons === null ? html`<p class="empty">This node's backend does not say which processes are its pylons'.</p>` : health.pylons.length === 0 ? html`<p class="empty">No pylon runs on this node.</p>` : html`<table class="ov" id="node-pylons">
<thead><tr><th class="wide">Pylon</th><th>Thread</th><th class="wide">Processes</th><th>CPU</th><th>Resident</th></tr></thead>
<tbody>${health.pylons.map((p) => {
  const thread = pylonOf.get(p.pylonId);
  return html`<tr><td class="wide"><code>${p.pylonId}</code></td><td>${thread === undefined ? html`<span class="dim">${p.pylonId}, not in the registry</span>` : html`<a class="link" href="/threads/${thread}" title="${p.pylonId}">${c.registry.thread(thread as ThreadId)?.title ?? thread}</a>`}</td><td class="wide">${p.processes}</td><td>${p.cpuPercent.toFixed(1)}%</td><td>${gib(p.residentGiB)} GiB</td></tr>`;
})}</tbody>
</table>`}
<p class="dim small">CPU is the percent of one CPU a pylon's processes used over the second the probe sampled, so four busy CPUs read 400%.</p>
</section>`}`;
}

/** Every node, the checks, and the picked node in full. `healths` holds each node's read, or why it failed. */
export function clusterPage(c: Context, picked: NodeName | null, healths: ReadonlyMap<NodeName, NodeHealth | Error>, latest: DoctorReport | null): Html {
  const nodes = c.registry.nodes();
  return layout(c, {
    title: "Cluster",
    nav: "cluster",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Cluster</h1></div></header>
<div class="scroll"><div class="page cluster">
<div id="cluster-nodes" data-live>${nodesTable(c, picked, healths)}</div>
<section class="report" id="health" aria-labelledby="health-h" data-live>${checks(c, latest)}</section>
${picked === null ? html`<p class="empty">No nodes yet. A node joins once its probe reports to the control plane.</p>` : html`<section class="node-detail" id="node-${picked}" aria-labelledby="node-h">
<div class="ov-head"><h2 id="node-h">${picked}</h2>${nodes.length > 1 && html`<nav class="node-pick" aria-label="Nodes">${nodes.map((n) => html`<a href="/nodes/${encodeURIComponent(n.name)}#node-${n.name}"${n.name === picked && html` aria-current="page"`}>${n.name}</a>`)}</nav>`}</div>
<div class="node-live" id="node-cleanup" data-live>${cleanup(c, picked)}</div>
<div class="node-live" id="node-health" data-live>${reading(c, picked, healths.get(picked)!)}</div>
${graphs(picked)}
</section>`}
</div></div>`,
  });
}
