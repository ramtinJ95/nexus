/** What a pylon's node last reported about it, read the one way every reader of the registry asks. */
import type { NodeName, PylonId } from "../ids.ts";
import type { NodeObservation, PylonObservation } from "../protocol/observations.ts";
import type { Registry } from "./registry.ts";
import type { StoredPylon } from "./thread-store.ts";

export const listsRunning = (observation: NodeObservation | null, pylonId: PylonId): boolean =>
  observation?.pylons.some((p) => p.pylonId === pylonId && p.phase === "running") === true;

/**
 * The pylon as its node's latest observation lists it, "absent" when that observation leaves it out, and null when
 * the node has sent none. An offline node's last observation counts.
 */
export function observedPylon(registry: Pick<Registry, "node">, pylon: Pick<StoredPylon, "node" | "pylonId">): PylonObservation | "absent" | null {
  const observation = registry.node(pylon.node)?.observation ?? null;
  return observation === null ? null : observation.pylons.find((p) => p.pylonId === pylon.pylonId) ?? "absent";
}

/** The probe of the thread's pylon's node while that node is online and its latest observation lists the pylon running. */
export function runningProbe<P>(registry: Pick<Registry, "pylon" | "node">, probes: ReadonlyMap<NodeName, P>, t: { pylonId: PylonId }): P | null {
  const pylon = registry.pylon(t.pylonId);
  const node = pylon === undefined ? undefined : registry.node(pylon.node);
  return node?.state === "online" && listsRunning(node.observation, t.pylonId) ? probes.get(node.name) ?? null : null;
}
