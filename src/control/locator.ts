/**
 * Where the control plane finds a pylon's probe: at the pylon's node, while that node is online and its latest
 * observation lists the pylon running. The boot a settle sealed runs no work until the planner pauses it, so every
 * path that brings work waits for the next boot, and only a read of its usage, which the seal is there for, reaches it.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { NodeName, PylonId } from "../ids.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import { probePort } from "../protocol/routes.ts";
import type { PylonLocator } from "./harness/pylon-env.ts";
import { observedPylon } from "./observed.ts";
import type { NodeRecord } from "./node-store.ts";
import type { Registry } from "./registry.ts";
import type { StoredPylon } from "./thread-store.ts";

/** "work" for every path that brings the pylon work, "usage" for the reads of its usage. */
export type Reach = "work" | "usage";

export function listsRunning(registry: Pick<Registry, "sealedBoot">, observation: NodeObservation | null, pylonId: PylonId, reach: Reach): boolean {
  const sealed = reach === "work" ? registry.sealedBoot(pylonId) : undefined;
  return observation?.pylons.some((p) => p.pylonId === pylonId && p.phase === "running" && p.bootedAt !== sealed) === true;
}

/** Whether the pylon's node lists it running on the boot a settle sealed. */
export function runsSealed(registry: Pick<Registry, "node" | "sealedBoot">, pylon: Pick<StoredPylon, "node" | "pylonId">): boolean {
  const sealed = registry.sealedBoot(pylon.pylonId);
  const o = observedPylon(registry, pylon);
  return sealed !== undefined && o !== null && o !== "absent" && o.phase === "running" && o.bootedAt === sealed;
}

export function runningNode(registry: Pick<Registry, "pylon" | "node" | "sealedBoot">, pylonId: PylonId, reach: Reach): NodeRecord | null {
  const pylon = registry.pylon(pylonId);
  const node = pylon === undefined ? undefined : registry.node(pylon.node);
  return node?.state === "online" && listsRunning(registry, node.observation, pylonId, reach) ? node : null;
}

export function runningProbe<P>(registry: Pick<Registry, "pylon" | "node" | "sealedBoot">, probes: ReadonlyMap<NodeName, P>, t: { pylonId: PylonId }, reach: Reach): P | null {
  const node = runningNode(registry, t.pylonId, reach);
  return node === null ? null : probes.get(node.name) ?? null;
}

/**
 * The harness's PylonLocator. It checks again each time the loop wakes, which it does after each event it ingests,
 * each wake a thread change asks for, and every few seconds. It gives up `waitMs` after it was asked.
 */
export function registryLocator<P>(options: {
  registry: Pick<Registry, "node" | "pylon" | "sealedBoot" | "threadStatus">;
  probes: ReadonlyMap<NodeName, P>;
  woken: () => Promise<void>;
  waitMs: number;
}): PylonLocator<P> {
  const { registry, probes, woken, waitMs } = options;
  return {
    async awaitRunning(pylonId) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const pylon = registry.pylon(pylonId);
        if (pylon === undefined) throw new Error(`the registry has no pylon ${pylonId}`);
        if (registry.threadStatus(pylon.thread) === "deleted") throw new Error(`the thread of ${pylonId} is deleted`);
        const node = runningNode(registry, pylonId, "work");
        const client = node === null ? undefined : probes.get(node.name);
        if (node !== null && client !== undefined) {
          return { address: { node: node.name, host: node.tailnetHost, port: probePort, nodeId: node.tailnetNodeId }, client };
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`${pylonId} on ${pylon.node} was not running by ${new Date(deadline).toISOString()}`);
        const timeout = new AbortController();
        await Promise.race([woken(), delay(left, undefined, { signal: timeout.signal })]);
        timeout.abort();
      }
    },
  };
}
