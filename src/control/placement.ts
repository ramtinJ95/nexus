import type { BootInputs } from "../project.ts";
import { countedCapacity, heldSecrets, type NodeCapacity, type NodeName, type NodeObservation, type PylonId, type PylonObservation } from "../protocol.ts";
import { desiredPhase } from "../reconcile.ts";
import { HttpError } from "./http-error.ts";
import type { NodeRecord, Registry, StoredPylon, ThreadId } from "./registry.ts";

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

type Need = Pick<BootInputs, "image" | "resources" | "network" | "repo" | "dotfiles">;

export function placeAuto(registry: Registry, need: Need): Placement {
  const weighed = registry.nodes().map((n) => weigh(registry, n, need));
  const fits = weighed.flatMap((w) => "left" in w ? [w] : [])
    .sort((a, b) => b.left.memoryGiB - a.left.memoryGiB || b.left.cpus - a.left.cpus || b.left.diskGiB - a.left.diskGiB);
  if (fits.length === 0) throw new HttpError(409, `no node can run this pylon: ${weighed.flatMap((w) => "refused" in w ? [`${w.node} ${w.refused}`] : []).join("; ")}`);
  return { how: "auto", node: fits[0]!.node, weighed };
}

function weigh(registry: Registry, node: NodeRecord, need: Need): Weighed {
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
export function roomLeft(registry: Registry, node: NodeName, o: NodeObservation, c: NodeCapacity, need: Room): { left: Room; pending: Room } {
  const now = Date.now();
  const pending = [...registry.pylonsOn(node)
    .filter((p) => p.failed === null && ["running", "reading"].includes(desiredPhase(registry.thread(p.thread as ThreadId)!, now)))
    .map((p) => uncounted(p, o.pylons.find((seen) => seen.pylonId === p.pylonId))), ...registry.reserved(node)]
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

export function nodePylons(registry: Registry, node: NodeRecord): NodePylons | null {
  if (node.observation === null) return null;
  const zero = (): Tally => ({ pylons: 0, cpus: 0, memoryGiB: 0 });
  const tallies = { up: zero(), paused: zero(), archived: zero(), crashed: zero() };
  const orphaned: PylonId[] = [];
  for (const seen of node.observation.pylons) {
    const p = registry.pylon(seen.pylonId);
    if (p === undefined || p.node !== node.name) {
      orphaned.push(seen.pylonId);
      continue;
    }
    const { status } = registry.thread(p.thread as ThreadId)!;
    const crashed = seen.phase === "broken" && seen.cause === "controller";
    const tally = tallies[(crashed || seen.phase === "stopped") && (status === "archived" || status === "deleted") ? "archived"
      : crashed ? "crashed" : seen.phase !== "stopped" ? "up" : "paused"];
    tally.pylons += 1;
    tally.cpus += p.boot.resources.cpus;
    tally.memoryGiB += p.boot.resources.memoryGiB;
  }
  return { ...tallies, orphaned };
}
