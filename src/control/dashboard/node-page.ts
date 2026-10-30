/** Renders a node's page: what its probe reads of its host's health and its pylon processes. */
import type { NodeName, ThreadId } from "../../ids.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import { gib } from "../placement.ts";
import { utc } from "../usage.ts";
import { Html, html, menu } from "./view.ts";
import type { Context } from "./context.ts";
import { layout } from "./shell.ts";

const unknown = html`<span class="dim">unknown</span>`;

/** What the node's probe reads of its host when the page loads. Nothing here acts on the node. */
export function nodePage(c: Context, name: NodeName, health: NodeHealth | Error): Html {
  const pylonOf = new Map(c.registry.pylonsOn(name).map((p) => [p.pylonId, p.thread]));
  const reading = html`<section aria-labelledby="node-health-h"><div class="ov-head"><h2 id="node-health-h">Health</h2></div>
${health instanceof Error ? html`<p class="error" role="alert">${health.message}</p>` : html`<dl class="kv node-health">
<dt>Read</dt><dd><time datetime="${health.readAt}">${utc(Date.parse(health.readAt))}</time></dd>
<dt>Load</dt><dd>${health.load === null ? unknown : `${health.load.one.toFixed(2)} · ${health.load.five.toFixed(2)} · ${health.load.fifteen.toFixed(2)} over 1, 5 and 15 minutes, on ${health.cpus} CPUs`}</dd>
<dt>Memory</dt><dd>${health.memory === null ? unknown : `${gib(health.memory.availableGiB)} of ${gib(health.memory.totalGiB)} GiB available`}</dd>
<dt>Swap</dt><dd>${health.memory === null ? unknown : health.memory.swapTotalGiB === 0 ? "none" : `${gib(health.memory.swapTotalGiB - health.memory.swapFreeGiB)} of ${gib(health.memory.swapTotalGiB)} GiB used`}</dd>
<dt>Disk</dt><dd>${gib(health.disk.freeGiB)} of ${gib(health.disk.totalGiB)} GiB free at <code>${health.disk.path}</code></dd>
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
<div class="scroll"><div class="page" id="node-health" data-live>
${reading}
${pylons}
</div></div>`,
  });
}
