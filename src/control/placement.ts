import type { BootInputs } from "../spawn.ts";
import type { NodeName, PylonId } from "../ids.ts";
import { countedCapacity, heldSecrets, type NodeCapacity, type NodeObservation, type PylonObservation } from "../protocol/observations.ts";
import { desiredPhase } from "../reconcile.ts";
import { HttpError } from "./http-error.ts";
import type { Registry } from "./registry.ts";
import type { NodeRecord } from "./node-store.ts";
import type { Placement, Room, StoredPylon, Weighed } from "./thread-store.ts";

type PlacementRegistry = Pick<Registry, "nodes" | "pylonsWithStatusOn" | "pylonsWithThreadsOn" | "reserved">;

type Need = Pick<BootInputs, "image" | "resources" | "network" | "repo" | "dotfiles">;

export function placeAuto(registry: PlacementRegistry, need: Need): Placement {
  const { best, weighed } = weighNodes(registry, need);
  if (best === null) throw new HttpError(409, `no node can run this pylon: ${refusals(weighed)}`);
  return { how: "auto", node: best, weighed };
}

/**
 * On `near` while it can run the pylon, as the review loop starts a builder's reviewer and checks beside it. Otherwise on
 * the node with the most room left, and on `near` all the same when no node has room, so a review never waits for one.
 */
export function placeNear(registry: PlacementRegistry, need: Need, near: NodeName): Placement {
  const { best, weighed } = weighNodes(registry, need);
  if (best === null || weighed.some((w) => w.node === near && "left" in w)) return { how: "named", node: near };
  return { how: "auto", node: best, weighed };
}

/** Every node but `except` weighed for the pylon, and the one with the most room left once it boots there, if any can run it. */
export function weighNodes(registry: PlacementRegistry, need: Need, except?: NodeName): { best: NodeName | null; weighed: Weighed[] } {
  const weighed = registry.nodes().filter((n) => n.name !== except).map((n) => weigh(registry, n, need));
  const fits = weighed.flatMap((w) => "left" in w ? [w] : [])
    .sort((a, b) => b.left.memoryGiB - a.left.memoryGiB || b.left.cpus - a.left.cpus || b.left.diskGiB - a.left.diskGiB);
  return { best: fits[0]?.node ?? null, weighed };
}

export const refusals = (weighed: readonly Weighed[]) => weighed.flatMap((w) => "refused" in w ? [`${w.node} ${w.refused}`] : []).join("; ");

function weigh(registry: PlacementRegistry, node: NodeRecord, need: Need): Weighed {
  const refused = (why: string): Weighed => ({ node: node.name, refused: why });
  const o = node.observation;
  if (node.state !== "online" || o === null) return refused("is offline");
  const { capacity: c } = o;
  if (c === null) return refused("runs a probe too old to report what its pylons hold");
  if (!o.artifacts.includes(need.image)) return refused(`does not hold image ${need.image}`);
  if (need.resources.nestedVirtualization === true && o.nestedVirtualization !== true) return refused("cannot give a pylon KVM of its own: its probe does not report nested virtualization");
  // A probe gets a held secret soon after it starts, and the planner holds the boot until then.
  const missing = need.network.secrets.map((s) => s.name).filter((name) => !o.grants.secrets.includes(name) && !o.heldSecrets.includes(name));
  const from = (name: string) => heldSecrets.includes(name) ? `${name}, which its probe is too old to take from the control plane` : `${name} in its secret file`;
  if (missing.length > 0) return refused(`has no secret ${missing.map(from).join(", ")}`);
  const ssh = [...need.repo.kind === "clone" ? [need.repo.url] : [], need.dotfiles.repo].filter((url) => !url.startsWith("https://"));
  if (ssh.length > 0 && !o.grants.gitSsh) return refused(`has no git SSH key to reach ${ssh.join(" and ")}`);
  const { left, pending } = roomLeft(registry, node.name, o, c, need.resources);
  const committed = `${gib(c.committedMemoryGiB + pending.memoryGiB)} of ${gib(c.memoryGiB)} GiB of memory committed`;
  if (c.committedMemoryGiB + pending.memoryGiB > c.memoryGiB) return refused(`is overcommitted, with ${committed}`);
  if (left.memoryGiB < 0) return refused(`has ${committed}, and the pylon needs ${need.resources.memoryGiB}`);
  if (left.diskGiB < 0) return refused(`has ${gib(left.diskGiB + need.resources.diskGiB)} GiB of disk free, and the pylon needs ${need.resources.diskGiB}`);
  return { node: node.name, left };
}

/**
 * The room the node has left once a pylon that holds `need` more boots there: what its observation does not count as
 * committed, less what its pylons about to boot or wake and the starts placed there will hold (`pending`).
 */
export function roomLeft(registry: PlacementRegistry, node: NodeName, o: NodeObservation, c: NodeCapacity, need: Room): { left: Room; pending: Room } {
  const now = Date.now();
  const seen = new Map(o.pylons.map((p) => [p.pylonId, p]));
  const pending = [...registry.pylonsWithThreadsOn(node)
    .filter(({ pylon, thread }) => pylon.failed === null && ["running", "reading"].includes(desiredPhase(thread, now)))
    .map(({ pylon }) => uncounted(pylon, seen.get(pylon.pylonId))), ...registry.reserved(node)]
    .reduce((total, r) => ({ cpus: total.cpus + r.cpus, memoryGiB: total.memoryGiB + r.memoryGiB, diskGiB: total.diskGiB + r.diskGiB }), { cpus: 0, memoryGiB: 0, diskGiB: 0 });
  const left: Room = {
    cpus: c.cpus - c.committedCpus - pending.cpus - need.cpus,
    memoryGiB: c.memoryGiB - c.committedMemoryGiB - pending.memoryGiB - need.memoryGiB,
    diskGiB: c.diskFreeGiB - pending.diskGiB - need.diskGiB,
  };
  return { left, pending };
}

/**
 * What a pylon the planner is about to boot or wake will hold that its node's capacity does not count yet. One the node
 * has yet to report will hold all it asked for. A stopped VM, or one whose controller died and a person retried, boots
 * again and holds its CPUs and memory again. A broken VM that is still up already holds them.
 */
export function uncounted(p: StoredPylon, seen: PylonObservation | undefined): Room {
  const { cpus, memoryGiB, diskGiB } = p.boot.resources;
  if (seen === undefined) return { cpus, memoryGiB, diskGiB };
  const reboots = seen.phase === "stopped" || (seen.phase === "broken" && seen.cause === "controller" && p.retrying);
  return reboots ? { cpus, memoryGiB, diskGiB: 0 } : { cpus: 0, memoryGiB: 0, diskGiB: 0 };
}

export const gib = (n: number) => Number(n.toFixed(1));

/** A node's committed memory exceeds its memory. */
export function overcommitted(reported: NodeRecord["capacity"]): boolean {
  const c = countedCapacity(reported);
  return c !== null && c.committedMemoryGiB > c.memoryGiB;
}

export interface Tally { pylons: number; cpus: number; memoryGiB: number }
/**
 * The pylons in a node's latest observation, by what they hold. One that is up holds its CPUs and memory, and a paused
 * one needs them back to wake. A crashed one, broken because its controller exited or failed to boot the VM, holds only
 * its disk, and needs its CPUs and memory back for a retry. An archived one, paused or crashed with its thread archived
 * or deleted, holds only its disk and boots only once the thread is unarchived. An orphaned VM is one the registry has
 * not placed on the node, whose CPUs and memory the control plane does not know.
 */
export interface NodePylons { up: Tally; paused: Tally; archived: Tally; crashed: Tally; orphaned: readonly PylonId[] }

export function nodePylons(registry: PlacementRegistry, node: NodeRecord): NodePylons | null {
  if (node.observation === null) return null;
  const zero = (): Tally => ({ pylons: 0, cpus: 0, memoryGiB: 0 });
  const tallies = { up: zero(), paused: zero(), archived: zero(), crashed: zero() };
  const orphaned: PylonId[] = [];
  const placed = new Map(registry.pylonsWithStatusOn(node.name).map((p) => [p.pylon.pylonId, p]));
  for (const seen of node.observation.pylons) {
    const found = placed.get(seen.pylonId);
    if (found === undefined) {
      orphaned.push(seen.pylonId);
      continue;
    }
    const { pylon: p, status } = found;
    const crashed = seen.phase === "broken" && seen.cause === "controller";
    const tally = tallies[(crashed || seen.phase === "stopped") && (status === "archived" || status === "deleted") ? "archived"
      : crashed ? "crashed" : seen.phase !== "stopped" ? "up" : "paused"];
    tally.pylons += 1;
    tally.cpus += p.boot.resources.cpus;
    tally.memoryGiB += p.boot.resources.memoryGiB;
  }
  return { ...tallies, orphaned };
}
