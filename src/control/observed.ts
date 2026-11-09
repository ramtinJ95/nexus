/** What a pylon's node last reported about it, read the one way every reader of the registry asks. */
import type { PylonObservation } from "../protocol/observations.ts";
import type { Registry } from "./registry.ts";
import type { StoredPylon } from "./thread-store.ts";

/**
 * The pylon as its node's latest observation lists it, "absent" when that observation leaves it out, and null when
 * the node has sent none. An offline node's last observation counts.
 */
export function observedPylon(registry: { nodes: Pick<Registry["nodes"], "node"> }, pylon: Pick<StoredPylon, "node" | "pylonId">): PylonObservation | "absent" | null {
  const observation = registry.nodes.node(pylon.node)?.observation ?? null;
  return observation === null ? null : observation.pylons.find((p) => p.pylonId === pylon.pylonId) ?? "absent";
}
