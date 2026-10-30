/**
 * The harness's PylonLocator over the registry: a pylon is reachable once its node's latest observation shows it
 * running while the node is online. The registry is in this process, so waiting is a cheap poll of it.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { PylonId } from "../ids.ts";
import { probePort } from "../protocol/routes.ts";
import type { PylonLocator } from "../harness/pylon-env.ts";
import { listsRunning } from "./observed.ts";
import type { Registry } from "./registry.ts";

const pollMs = 250;

export function registryLocator(registry: Registry): PylonLocator {
  return {
    async awaitRunning(pylonId: PylonId, deadline: number) {
      for (;;) {
        const pylon = registry.pylon(pylonId);
        if (pylon === undefined) throw new Error(`the registry has no pylon ${pylonId}`);
        if (registry.threadStatus(pylon.thread) === "deleted") throw new Error(`the thread of ${pylonId} is deleted`);
        const node = registry.node(pylon.node)!;
        if (node.state === "online" && listsRunning(node.observation, pylonId)) {
          return { node: node.name, host: node.tailnetHost, port: probePort, nodeId: node.tailnetNodeId };
        }
        if (Date.now() + pollMs > deadline) throw new Error(`${pylonId} on ${node.name} was not running by ${new Date(deadline).toISOString()}`);
        await delay(pollMs);
      }
    },
  };
}
