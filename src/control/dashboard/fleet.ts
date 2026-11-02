/**
 * The home page's fleet pane: each node's load over the last six hours, its memory and disk, and its pylons, after
 * Mission control's node tiles. Lines and bars are SVG, since the page's policy refuses inline styles.
 */
import { countedCapacity } from "../../protocol/observations.ts";
import { lowDisk } from "../../disk-space.ts";
import { gib, nodePylons, overcommitted } from "../placement.ts";
import type { NodeRecord } from "../node-store.ts";
import { html, dot, type Html, type Tone } from "./view.ts";
import type { Context } from "./context.ts";

/** How full a used share of a whole is, as a bar of 100 units with the used part in its tone. */
function meter(used: number, total: number, label: string): Html {
  const share = total <= 0 ? 0 : Math.min(1, used / total);
  const tone: Tone = share >= 0.9 ? "bad" : share >= 0.75 ? "busy" : "ok";
  return html`<svg class="meter meter-${tone}" viewBox="0 0 100 2" preserveAspectRatio="none" role="img" aria-label="${label}"><rect class="meter-track" width="100" height="2"/><rect class="meter-used" width="${(share * 100).toFixed(2)}" height="2"/></svg>`;
}

/** A line of one series over [from, to], scaled to `ceiling` or its own peak, whichever is higher. */
function trace(t: readonly number[], v: readonly number[], from: number, to: number, ceiling: number, label: string): Html {
  if (v.length < 2) return html`<svg class="trace trace-none" viewBox="0 0 120 24" preserveAspectRatio="none" role="img" aria-label="${label}: no samples yet"><line x1="0" y1="23" x2="120" y2="23"/></svg>`;
  const top = Math.max(ceiling, ...v) || 1;
  const points = v.map((y, i) => `${(((t[i]! - from) / (to - from)) * 120).toFixed(1)},${(23 - (y / top) * 21).toFixed(1)}`).join(" ");
  return html`<svg class="trace" viewBox="0 0 120 24" preserveAspectRatio="none" role="img" aria-label="${label}"><line class="trace-base" x1="0" y1="23.5" x2="120" y2="23.5"/><polyline points="${points}"/></svg>`;
}

const share = (used: number, total: number) => `${gib(used)} of ${gib(total)} GiB`;

function node(c: Context, n: NodeRecord): Html {
  const sample = c.registry.latestHealthSample(n.name)?.values ?? {};
  const capacity = countedCapacity(n.capacity);
  const pylons = nodePylons(c.registry, n);
  const from = c.now - 6 * 3_600_000;
  const load = c.registry.nodeMetrics(n.name, from, c.now, c.now).series.find((s) => s.key === "load1");
  const cpus = sample.cpus ?? capacity?.cpus ?? 0;
  const memUsed = sample.memTotal === undefined || sample.memAvailable === undefined ? null : sample.memTotal - sample.memAvailable;
  const diskUsed = sample.diskTotal === undefined || sample.diskFree === undefined ? null : sample.diskTotal - sample.diskFree;
  const flags = [n.state === "offline" && "offline", overcommitted(n.capacity) && "overcommitted", capacity?.disks?.some(lowDisk) === true && "disk low"].filter((f) => f !== false);
  const crashed = pylons?.crashed.pylons ?? 0;
  return html`<section class="fl-node" aria-labelledby="fl-${n.name}">
<h3 class="fl-name" id="fl-${n.name}">${dot(n.state === "online" ? "ok" : "muted", n.state)}<a href="/nodes/${encodeURIComponent(n.name)}">${n.name}</a></h3>
${flags.length > 0 && html`<p class="fl-flag">${flags.join(", ")}</p>`}
<div class="fl-load"><span class="fl-big">${sample.load1 === undefined ? "–" : sample.load1.toFixed(2)}</span><span class="fl-unit">load on ${cpus} CPUs</span></div>
${trace(load?.t ?? [], load?.avg ?? [], from, c.now, cpus, `1-minute load on ${n.name} over the last 6 hours`)}
<dl class="fl-kv">
<dt>Memory</dt><dd>${memUsed === null ? html`<span class="dim">not reported</span>` : html`${meter(memUsed, sample.memTotal!, `Memory ${share(memUsed, sample.memTotal!)} used`)}<span>${share(memUsed, sample.memTotal!)}</span>`}</dd>
<dt>Disk</dt><dd>${diskUsed === null ? html`<span class="dim">not reported</span>` : html`${meter(diskUsed, sample.diskTotal!, `Disk ${share(diskUsed, sample.diskTotal!)} used`)}<span>${share(diskUsed, sample.diskTotal!)}</span>`}</dd>
<dt>Pylons</dt><dd>${pylons === null ? html`<span class="dim">not reported</span>` : html`${pylons.up.pylons} up, ${pylons.paused.pylons} paused${crashed > 0 && html`, <span class="fl-bad">${crashed} crashed</span>`}`}</dd>
</dl>
</section>`;
}

/** The fleet pane: every node, or what to do when there is none. */
export function fleet(c: Context): Html {
  const nodes = c.registry.nodes();
  return html`<h2 class="pane-h">Fleet</h2>
${nodes.length === 0 ? html`<p class="empty">No node has joined yet. A node joins once its probe reaches the control plane.</p>` : nodes.map((n) => node(c, n))}`;
}
