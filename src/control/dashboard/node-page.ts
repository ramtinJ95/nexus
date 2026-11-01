/**
 * Renders a node's page: the cleanup the person is asked to confirm, what its probe reads of its host's health and its
 * pylon processes, and graphs of its history.
 */
import type { NodeName, ThreadId } from "../../ids.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import { lowDisk } from "../../disk-space.ts";
import { gib } from "../placement.ts";
import { utc } from "../usage.ts";
import { seriesLabel, seriesOf } from "../node-metrics.ts";
import { charts, ranges } from "./graph-data.ts";
import { Html, html, menu } from "./view.ts";
import type { Context } from "./context.ts";
import { cleanupCard } from "./cards.ts";
import { layout } from "./shell.ts";

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

/** What the node's probe reads of its host when the page loads, and its cleanup, which acts on the node only once the person answers. */
export function nodePage(c: Context, name: NodeName, health: NodeHealth | Error): Html {
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
  return html`<tr><td class="wide"><code>${p.pylonId}</code></td><td>${thread === undefined ? html`<span class="dim">${p.pylonId}, not in the registry</span>` : html`<a class="link" href="/threads/${thread}" title="${p.pylonId}">${c.registry.thread(thread as ThreadId)?.title ?? thread}</a>`}</td><td class="wide">${p.processes}</td><td>${p.cpuPercent.toFixed(1)}%</td><td>${gib(p.residentGiB)} GiB</td></tr>`;
})}</tbody>
</table>`}
<p class="dim small">CPU is the percent of one CPU a pylon's processes used over the second the probe sampled, so four busy CPUs read 400%.</p>
</section>`;
  return layout(c, {
    title: `Node ${name}`,
    main: html`<header class="bar">${menu}<div class="crumb"><h1>${name}</h1></div></header>
<div class="scroll"><div class="page"><div class="node-live" id="node-cleanup" data-live>${cleanup(c, name)}</div><div class="node-live" id="node-health" data-live>
${reading}
${pylons}
</div>
${graphs(name)}
</div></div>`,
  });
}
