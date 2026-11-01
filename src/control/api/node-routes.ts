/**
 * The nodes and their pylons, and a node's health and its history, which only a deployer reads.
 */
import type { NodeHealth } from "../../protocol/client.ts";
import type { NodeName, TailnetNodeId } from "../../ids.ts";
import type { NodeRecord } from "../node-store.ts";
import type { NodeSummary } from "../wire.ts";
import { HttpError } from "../http-error.ts";
import { foldPylons, seriesLabel, type MetricSeries, type NodeMetrics, type Series } from "../node-metrics.ts";
import { nodePylons, overcommitted } from "../placement.ts";
import { canDeploy, type DeploymentOptions } from "../releases.ts";
import { ok, type RouteEntry, type ApiKit } from "./kit.ts";

/** The node as `GET /v1/nodes` and `nexus doctor` read it: its record without the observation, and what its pylons hold. */
export function nodeSummary(registry: Parameters<typeof nodePylons>[0], record: NodeRecord): NodeSummary {
  const { observation, ...n } = record;
  return { ...n, observedAt: observation?.observedAt ?? null, overcommitted: overcommitted(n.capacity), pylons: nodePylons(registry, record) };
}

const maxSpanMs = 31 * 24 * 60 * 60 * 1000;

function whole(query: URLSearchParams, name: string): number | null {
  const text = query.get(name);
  if (text === null) return null;
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value)) throw new HttpError(400, `${name} must be a whole number of milliseconds since the epoch`);
  return value;
}

export function nodeRoutes(kit: ApiKit, options: { deployment?: DeploymentOptions | undefined }, nodeHealth: (caller: TailnetNodeId, name: NodeName) => Promise<NodeHealth>): readonly RouteEntry[] {
  const { registry } = kit;

  /** History holds what a node's health held, so it takes the same right, and is read from the registry alone. */
  function nodeMetrics(caller: TailnetNodeId, name: NodeName, query: URLSearchParams): NodeMetrics {
    if (!canDeploy(registry, options.deployment, caller)) throw new HttpError(403, "caller may not read a node's metrics: only deployers may, never infrastructure nodes or pylons");
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
    ["GET", /^\/v1\/nodes$/, () => ok(registry.nodes().map((record) => nodeSummary(registry, record)))],
    ["GET", /^\/v1\/nodes\/([^/]+)\/health$/, async ([, name], r) => ok(await nodeHealth(r.caller, name as NodeName))],
    ["GET", /^\/v1\/nodes\/([^/]+)\/metrics$/, ([, name], r) => ok(nodeMetrics(r.caller, name as NodeName, r.query))],
  ];
}
