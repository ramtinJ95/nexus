/**
 * The harness's PylonLocator over the registry: a pylon is reachable once its node's latest observation shows it
 * running while the node is online. The registry is in this process, so waiting is a cheap poll of it.
 */
import { setTimeout as delay } from "node:timers/promises";
import { probePort, type PylonId } from "../protocol.ts";
import type { PylonLocator } from "../harness/pylon-env.ts";
import type { Registry, ThreadId } from "./registry.ts";

const pollMs = 250;

export function registryLocator(registry: Registry): PylonLocator {
  return {
    async awaitRunning(pylonId: PylonId, deadline: number) {
      for (;;) {
        const pylon = registry.pylon(pylonId);
        if (pylon === undefined) throw new Error(`the registry has no pylon ${pylonId}`);
        if (registry.thread(pylon.thread as ThreadId)?.status === "deleted") throw new Error(`the thread of ${pylonId} is deleted`);
        const node = registry.node(pylon.node)!;
        const observed = node.observation?.pylons.find((p) => p.pylonId === pylonId);
        if (node.state === "online" && observed?.phase === "running") {
          return { node: node.name, host: node.tailnetHost, port: probePort, nodeId: node.tailnetNodeId };
        }
        if (Date.now() + pollMs > deadline) throw new Error(`${pylonId} on ${node.name} was not running by ${new Date(deadline).toISOString()}`);
        await delay(pollMs);
      }
    },
  };
}
