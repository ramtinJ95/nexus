/**
 * The nodes and their pylons, and a node's health, which only a deployer reads.
 */
import type { NodeHealth } from "../../protocol/client.ts";
import type { NodeName, TailnetNodeId } from "../../ids.ts";
import type { NodeRecord } from "../node-store.ts";
import type { NodeSummary } from "../wire.ts";
import { nodePylons, overcommitted } from "../placement.ts";
import { ok, type RouteEntry, type ApiKit } from "./kit.ts";

/** The node as `GET /v1/nodes` and `nexus doctor` read it: its record without the observation, and what its pylons hold. */
export function nodeSummary(registry: Parameters<typeof nodePylons>[0], record: NodeRecord): NodeSummary {
  const { observation, ...n } = record;
  return { ...n, observedAt: observation?.observedAt ?? null, overcommitted: overcommitted(n.capacity), pylons: nodePylons(registry, record) };
}

export function nodeRoutes(kit: ApiKit, nodeHealth: (caller: TailnetNodeId, name: NodeName) => Promise<NodeHealth>): readonly RouteEntry[] {
  const { registry } = kit;

  return [
    ["GET", /^\/v1\/nodes$/, () => ok(registry.nodes().map((record) => nodeSummary(registry, record)))],
    ["GET", /^\/v1\/nodes\/([^/]+)\/health$/, async ([, name], r) => ok(await nodeHealth(r.caller, name as NodeName))],
  ];
}
