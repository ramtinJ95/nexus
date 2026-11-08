import type { NodeHealth } from "../../protocol/client.ts";
import type { NodeName } from "../../ids.ts";
import { HttpError } from "../http-error.ts";
import { foldPylons, seriesLabel, type MetricSeries, type NodeMetrics, type Series } from "../node-metrics.ts";
import { nodeSummary } from "../placement.ts";
import { ok, on, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, type Policy } from "./access.ts";
import { nodeRoutes as routes } from "../../contract/reports.ts";

/** A node's health says what runs on it, so only a deployer reads it. */
export const readHealth = { role: "deployer", action: "read a node's health" } satisfies Policy;

const maxSpanMs = 31 * 24 * 60 * 60 * 1000;

function whole(query: URLSearchParams, name: string): number | null {
  const text = query.get(name);
  if (text === null) return null;
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value)) throw new HttpError(400, `${name} must be a whole number of milliseconds since the epoch`);
  return value;
}

export function nodeRoutes(kit: ApiKit, nodeHealth: (name: NodeName) => Promise<NodeHealth>): readonly RouteEntry[] {
  const { registry } = kit;

  /** Read from the registry alone. */
  function nodeMetrics(name: NodeName, query: URLSearchParams): NodeMetrics {
    if (registry.node(name) === undefined) throw new HttpError(404, `no node ${name}`);
    const now = Date.now();
    const from = whole(query, "from");
    if (from === null) throw new HttpError(400, "from must be a whole number of milliseconds since the epoch");
    const to = whole(query, "to") ?? now;
    if (from >= to) throw new HttpError(400, "from must be before to");
    if (to - from > maxSpanMs) throw new HttpError(400, "the range must span at most 31 days, as long as the registry keeps a node's metrics");
    const stored = registry.nodeMetrics(name, from, to, now);
    const { series, otherPylons } = foldPylons(stored.series, stored.bucketMs);
    const label = (s: Series) => s.kind === "otherPylonsCpu" || s.kind === "otherPylonsResident" ? `${otherPylons.length} other pylons, summed` : seriesLabel(s, (t) => registry.thread(t)?.title);
    return { node: name, from, to, tier: stored.tier, bucketMs: stored.bucketMs, sampledAt: stored.sampledAt, series: series.map((s): MetricSeries => ({ ...s, label: label(s.series) })), otherPylons };
  }

  return [
    on(routes.list, anyAllowed, () => ok(registry.nodes().map((record) => nodeSummary(registry, record)))),
    on(routes.health, readHealth, async ({ node }) => ok(await nodeHealth(node as NodeName))),
    // History holds what a node's health held, so it takes the same right.
    on(routes.metrics, { role: "deployer", action: "read a node's metrics" }, ({ node }, r) => ok(nodeMetrics(node as NodeName, r.query))),
  ];
}
