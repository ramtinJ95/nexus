/** What a pylon's node last reported about it, read the one way every reader of the registry asks. */
import type { NodeName, PylonId } from "../ids.ts";
import type { NodeObservation, PylonObservation } from "../protocol/observations.ts";
import type { Registry } from "./registry.ts";
import type { StoredPylon } from "./thread-store.ts";

/**
 * Whether the observation lists the pylon running on a boot that may run work. The boot `sealedBoot`, whose transcripts a
 * settle sealed, runs none until the planner pauses it, so every path that brings work waits for the next boot.
 */
export const listsRunning = (observation: NodeObservation | null, pylonId: PylonId, sealedBoot?: string): boolean =>
  observation?.pylons.some((p) => p.pylonId === pylonId && p.phase === "running" && p.bootedAt !== sealedBoot) === true;

/** Whether the pylon's node lists it running on the boot a settle sealed. */
export function runsSealed(registry: Pick<Registry, "node" | "sealedBoot">, pylon: Pick<StoredPylon, "node" | "pylonId">): boolean {
  const sealed = registry.sealedBoot(pylon.pylonId);
  const o = observedPylon(registry, pylon);
  return sealed !== undefined && o !== null && o !== "absent" && o.phase === "running" && o.bootedAt === sealed;
}

/**
 * The pylon as its node's latest observation lists it, "absent" when that observation leaves it out, and null when
 * the node has sent none. An offline node's last observation counts.
 */
export function observedPylon(registry: Pick<Registry, "node">, pylon: Pick<StoredPylon, "node" | "pylonId">): PylonObservation | "absent" | null {
  const observation = registry.node(pylon.node)?.observation ?? null;
  return observation === null ? null : observation.pylons.find((p) => p.pylonId === pylon.pylonId) ?? "absent";
}

/**
 * The probe of the thread's pylon's node while that node is online and its latest observation lists the pylon running,
 * on a boot that may run work.
 */
export function runningProbe<P>(registry: Pick<Registry, "pylon" | "node" | "sealedBoot">, probes: ReadonlyMap<NodeName, P>, t: { pylonId: PylonId }): P | null {
  const pylon = registry.pylon(t.pylonId);
  const node = pylon === undefined ? undefined : registry.node(pylon.node);
  return node?.state === "online" && listsRunning(node.observation, t.pylonId, registry.sealedBoot(t.pylonId)) ? probes.get(node.name) ?? null : null;
}

/** As runningProbe, a sealed boot included, for the reads of its usage, which the seal is there for. */
export function readableProbe<P>(registry: Pick<Registry, "pylon" | "node">, probes: ReadonlyMap<NodeName, P>, t: { pylonId: PylonId }): P | null {
  const pylon = registry.pylon(t.pylonId);
  const node = pylon === undefined ? undefined : registry.node(pylon.node);
  return node?.state === "online" && listsRunning(node.observation, t.pylonId) ? probes.get(node.name) ?? null : null;
}
