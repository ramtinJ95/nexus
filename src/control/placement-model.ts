/**
 * Placement's records and the state it keeps in this process, apart from its rules (placement.ts), so the thread store
 * and the registry hold them without importing the rules.
 */
import type { NodeName, PylonId, ThreadId } from "../ids.ts";

/**
 * The node a thread's pylon boots on, and why. An `auto` placement keeps every node it weighed: the room a node that
 * could run the pylon has left once it boots there, or why the node could not.
 */
export type Placement =
  | { how: "default" | "named"; node: NodeName }
  | { how: "auto"; node: NodeName; weighed: readonly Weighed[] };
export type Weighed = { node: NodeName; left: Room } | { node: NodeName; refused: string };
/** Uncommitted CPUs and memory, and free disk. CPUs may go below zero, because VMs share a node's CPUs. */
export interface Room { cpus: number; memoryGiB: number; diskGiB: number }

/**
 * Placement's state that lives in this process only. A reservation is room a start placed a pylon in before its row
 * exists, so an overlapping start sees it taken; a start that a crash ended took no room. A released hold is kept by the
 * `until` it had, so a later hold of the thread counts again; a restart that loses them only holds the pylons until
 * placement releases them again.
 */
export function placementMemory(clock: () => number) {
  const reservations = new Map<PylonId, { node: NodeName; resources: Room }>();
  const releasedHolds = new Map<ThreadId, number>();
  return {
    /** Returns what releases it, once the pylon's row counts it or the start failed. */
    reserve(pylonId: PylonId, node: NodeName, resources: Room): () => void {
      reservations.set(pylonId, { node, resources });
      return () => { reservations.delete(pylonId); };
    },
    reserved: (node: NodeName) => [...reservations.values()].filter((r) => r.node === node).map((r) => r.resources),
    /** Ends the thread's hold that lasts until `until`, so its pylon pauses for room other work needs. */
    releaseHold(thread: ThreadId, until: number) {
      for (const [id, at] of releasedHolds) if (at <= clock()) releasedHolds.delete(id);
      releasedHolds.set(thread, until);
    },
    holdReleased: (thread: ThreadId, until: number) => releasedHolds.get(thread) === until,
  };
}
