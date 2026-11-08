import type { BootInputs } from "../protocol/spawn.ts";
import type { NodeName, PylonId, ThreadId } from "../ids.ts";
import { diskRefusal } from "../disk-space.ts";
import { heldSecrets, type NodeCapacity, type NodeObservation, type PylonObservation } from "../protocol/observations.ts";
import { desiredPhase } from "./reconcile.ts";
import { Refusal } from "./refusal.ts";
import { gib } from "../util/gib.ts";
import { backgroundReadMs, seriesOf } from "./node-metrics.ts";
import type { Registry } from "./registry.ts";
import type { NodeRecord } from "./node-store.ts";
import type { Placement, Room, StoredPylon, Weighed } from "./thread-store.ts";

type PlacementRegistry = Pick<Registry, "nodes" | "pylonsWithStatusOn" | "pylonsWithThreadsOn" | "reserved">;
type WeighingRegistry = PlacementRegistry & Pick<Registry, "latestHealthSample">;

type Need = Pick<BootInputs, "image" | "resources" | "network" | "repo" | "dotfiles">;

export function placeAuto(registry: WeighingRegistry, need: Need): Placement {
  const { best, weighed } = weighNodes(registry, need);
  if (best === null) throw new Refusal("conflict", `no node can run this pylon: ${refusals(weighed)}`);
  return { how: "auto", node: best, weighed };
}

/**
 * On `near` while it can run the pylon, as the review loop starts a builder's reviewer and checks beside it. Otherwise on
 * the node with the most room left, and on `near` all the same when no node has room, so a review never waits for one,
 * unless `ifRoom`, as for a check that can wait for the reviewer's verdict instead.
 */
export function placeNear(registry: WeighingRegistry, need: Need, near: NodeName, ifRoom = false): Placement {
  const { best, weighed } = weighNodes(registry, need);
  if (best === null && ifRoom) throw new Refusal("conflict", `no node has room for this pylon: ${refusals(weighed)}`);
  if (best === null || weighed.some((w) => w.node === near && "left" in w)) return { how: "named", node: near };
  return { how: "auto", node: best, weighed };
}

/** Every node but `except` weighed for the pylon, and the one with the most room left once it boots there, if any can run it. */
export function weighNodes(registry: WeighingRegistry, need: Need, except?: NodeName): { best: NodeName | null; weighed: Weighed[] } {
  const weighed = registry.nodes().filter((n) => n.name !== except).map((n) => weigh(registry, n, need));
  const fits = weighed.flatMap((w) => "left" in w ? [w] : [])
    .sort((a, b) => b.left.memoryGiB - a.left.memoryGiB || b.left.cpus - a.left.cpus || b.left.diskGiB - a.left.diskGiB);
  return { best: fits[0]?.node ?? null, weighed };
}

export const refusals = (weighed: readonly Weighed[]) => weighed.flatMap((w) => "refused" in w ? [`${w.node} ${w.refused}`] : []).join("; ");

function weigh(registry: WeighingRegistry, node: NodeRecord, need: Need): Weighed {
  const refused = (why: string): Weighed => ({ node: node.name, refused: why });
  const o = node.observation;
  if (node.state !== "online" || o === null) return refused("is offline");
  const { capacity: c } = o;
  if (!o.artifacts.includes(need.image)) return refused(`does not hold image ${need.image}`);
  if (need.resources.nestedVirtualization === true && o.nestedVirtualization !== true) return refused("cannot give a pylon KVM of its own: its probe does not report nested virtualization");
  // A probe gets a held secret soon after it starts, and the planner holds the boot until then.
  const missing = need.network.secrets.map((s) => s.name).filter((name) => !o.grants.secrets.includes(name) && !o.heldSecrets.includes(name));
  const from = (name: string) => heldSecrets.includes(name) ? `${name}, which its probe is too old to take from the control plane` : `${name} in its secret file`;
  if (missing.length > 0) return refused(`has no secret ${missing.map(from).join(", ")}`);
  const ssh = [...need.repo.kind === "clone" ? [need.repo.url] : [], need.dotfiles.repo].filter((url) => !url.startsWith("https://"));
  if (ssh.length > 0 && !o.grants.gitSsh) return refused(`has no git SSH key to reach ${ssh.join(" and ")}`);
  const { left, pending } = roomLeft(registry, node.name, o, c, need.resources);
  const held = heldRoom(registry, node.name, Date.now());
  pending.memoryGiB -= held;
  left.memoryGiB += held;
  const committed = `${gib(c.committedMemoryGiB + pending.memoryGiB)} of ${gib(c.memoryGiB)} GiB of memory committed`;
  if (c.committedMemoryGiB + pending.memoryGiB > c.memoryGiB) return refused(`is overcommitted, with ${committed}`);
  if (left.memoryGiB < 0) return refused(`has ${committed}, and the pylon needs ${need.resources.memoryGiB}`);
  const free = freeMemory(registry, node.name, o, c, Date.now());
  // With no fresh reading of its free memory, the node is weighed by its commitments alone.
  if (free !== null) {
    const freeLeft = free.availableGiB - free.untouchedGiB - pending.memoryGiB - need.resources.memoryGiB;
    if (freeLeft < memoryHeadroomGiB) {
      const less = [free.untouchedGiB > 0 && `${gib(free.untouchedGiB)} GiB its pylons have yet to touch`, pending.memoryGiB > 0 && `${gib(pending.memoryGiB)} GiB for pylons about to boot there`].filter((s) => s !== false);
      return refused(`has ${gib(free.availableGiB)} GiB of memory free${less.length > 0 ? `, less ${less.join(" and ")}` : ""}, and the pylon needs ${need.resources.memoryGiB} GiB with ${memoryHeadroomGiB} GiB to spare`);
    }
    left.memoryGiB = Math.min(left.memoryGiB, freeLeft);
  }
  const short = diskShort(c, left, need.resources);
  if (short !== null) return refused(short);
  return { node: node.name, left };
}

/**
 * The pylons on `node` that run only because a review holds them up for its findings. Their room is other work's to
 * take: placement counts it as free, and `freeHeldRoom` pauses them once the node needs it.
 */
function heldOnly(registry: PlacementRegistry, node: NodeName, now: number) {
  return registry.pylonsWithThreadsOn(node).filter(({ pylon, thread: { awaitedUntil, ...unheld } }) => pylon.failed === null && awaitedUntil !== undefined
    && desiredPhase({ ...unheld, awaitedUntil }, now) === "running" && desiredPhase(unheld, now) === "paused");
}
const heldRoom = (registry: PlacementRegistry, node: NodeName, now: number) => heldOnly(registry, node, now).reduce((gib, { pylon }) => gib + pylon.boot.resources.memoryGiB, 0);

/**
 * Releases the review holds on `node` while the rest of its work leaves it short of memory: committed past its size,
 * or with less free than the headroom a start keeps, so a held pylon pauses for a start or a wake that took its room.
 * The soonest to end goes first. Returns the threads whose holds it released.
 */
export function freeHeldRoom(registry: WeighingRegistry & Pick<Registry, "releaseHold">, node: NodeName): ThreadId[] {
  const record = registry.nodes().find((n) => n.name === node);
  const o = record?.state === "online" ? record.observation : null;
  if (o == null) return [];
  const now = Date.now();
  const held = heldOnly(registry, node, now).sort((a, b) => a.thread.awaitedUntil! - b.thread.awaitedUntil!);
  if (held.length === 0) return [];
  const { left, pending } = roomLeft(registry, node, o, o.capacity, { cpus: 0, memoryGiB: 0, diskGiB: 0 });
  const free = freeMemory(registry, node, o, o.capacity, now);
  // A pylon still up that is to pause, as one whose hold went on an earlier pass, gives its room back soon.
  const up = new Set(o.pylons.filter((p) => p.phase !== "stopped" && !(p.phase === "broken" && p.cause === "controller")).map((p) => p.pylonId));
  const pausing = registry.pylonsWithThreadsOn(node).filter(({ pylon, thread }) => up.has(pylon.pylonId) && !["running", "reading"].includes(desiredPhase(thread, now)))
    .reduce((gib, { pylon }) => gib + pylon.boot.resources.memoryGiB, 0);
  let short = Math.max(-left.memoryGiB, free === null ? 0 : memoryHeadroomGiB - (free.availableGiB - free.untouchedGiB - pending.memoryGiB)) - pausing;
  const released: ThreadId[] = [];
  for (const { pylon, thread } of held) {
    if (short <= 0) break;
    registry.releaseHold(thread.id, thread.awaitedUntil!);
    released.push(thread.id);
    short -= pylon.boot.resources.memoryGiB;
  }
  return released;
}

/**
 * What a node keeps free past the pylon's memory. The new VM's controller and QEMU hold a few hundred MiB over its guest
 * memory, MemAvailable moves between reads a minute apart, and a host left no page cache stalls every VM on it.
 */
const memoryHeadroomGiB = 1;
/** A health read older than this, as when a node's reads keep failing, no longer says what it has free. */
const freshReadMs = 2 * backgroundReadMs;

/**
 * The node's MemAvailable in its newest health read, and how much of it the node's up pylons are yet to take: a guest
 * takes its memory from the host only as it touches it, so a pylon whose processes hold less than its size will take
 * the rest. An up pylon the read did not name booted since the read, so it is yet to take all of it, on a node whose
 * probe names its pylons' processes. Only pylon-vm's does, and only its probe reports a filesystem of pylons' disks. On
 * any other node, such as a Docker node, such a pylon counts as all touched, since no read could say. On a pylon-vm
 * node, orphaned VMs, which the registry has not placed there, are yet to take what the probe commits beyond the placed
 * up pylons, less what the read found their processes hold. One the
 * observation does not count yet is left out, since `roomLeft` counts all it asked for. Null without a read in the
 * last `freshReadMs`, or from a host that reports no memory.
 */
function freeMemory(registry: WeighingRegistry, node: NodeName, o: NodeObservation, c: NodeCapacity, now: number): { availableGiB: number; untouchedGiB: number } | null {
  const read = registry.latestHealthSample(node);
  const availableGiB = read?.values.memAvailable;
  if (read == null || now - read.at > freshReadMs || availableGiB === undefined) return null;
  const resident = new Map(Object.entries(read.values).flatMap(([key, value]) => {
    const s = seriesOf(key);
    return s?.kind === "pylonResident" ? [[s.pylon, value] as const] : [];
  }));
  const namesProcesses = c.disks?.some((d) => d.pylons === true) === true;
  const seen = new Map(o.pylons.map((p) => [p.pylonId, p]));
  const placed = registry.pylonsWithStatusOn(node).map(({ pylon }) => pylon);
  let placedUpGiB = 0;
  let untouchedGiB = 0;
  for (const pylon of placed) {
    const p = seen.get(pylon.pylonId);
    const up = p !== undefined && p.phase !== "stopped" && !(p.phase === "broken" && p.cause === "controller");
    if (!up || uncounted(pylon, p).memoryGiB > 0) continue;
    const size = pylon.boot.resources.memoryGiB;
    const held = resident.get(pylon.pylonId);
    placedUpGiB += size;
    untouchedGiB += held !== undefined ? Math.max(0, size - held) : namesProcesses ? size : 0;
  }
  // The probe commits an orphaned VM's memory, but the registry does not know its size, so the orphans count together.
  const ids = new Set(placed.map((p) => p.pylonId));
  const orphansHeldGiB = [...resident].reduce((sum, [id, held]) => ids.has(id) ? sum : sum + held, 0);
  if (namesProcesses) untouchedGiB += Math.max(0, c.committedMemoryGiB - placedUpGiB - orphansHeldGiB);
  return { availableGiB, untouchedGiB };
}

/** A probe from before filesystems were reported is held only to the disk fitting. */
function diskShort(c: NodeCapacity, left: Room, need: Room): string | null {
  const pylons = c.disks?.find((d) => d.pylons === true);
  if (pylons !== undefined) return diskRefusal(pylons, left.diskGiB + need.diskGiB, need.diskGiB);
  return left.diskGiB < 0 ? `has ${gib(left.diskGiB + need.diskGiB)} GiB of disk free, and the pylon needs ${need.diskGiB}` : null;
}

/**
 * Why a start on a node it names cannot boot the pylon there for want of disk, or null. Also null for a node it cannot
 * weigh, and for one that reports no pylons' filesystem, such as a Docker node or one with an older probe.
 */
export function namedDiskShort(registry: PlacementRegistry, name: NodeName, need: Room): string | null {
  const node = registry.nodes().find((n) => n.name === name);
  const o = node?.state === "online" ? node.observation : null;
  if (o == null || !o.capacity.disks?.some((d) => d.pylons === true)) return null;
  return diskShort(o.capacity, roomLeft(registry, name, o, o.capacity, need).left, need);
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

export function overcommitted(c: NodeRecord["capacity"]): boolean {
  return c !== null && c.committedMemoryGiB > c.memoryGiB;
}

export interface Tally { pylons: number; cpus: number; memoryGiB: number }
/**
 * The pylons in a node's latest observation, by what they hold. One that is up, in any phase but stopped, or broken by
 * anything but a controller that exited, holds its CPUs and memory, and a paused one, stopped with its thread not
 * archived or deleted, needs them back to wake. A crashed one, broken because its controller exited or failed to boot
 * the VM, holds only its disk, and needs its CPUs and memory back for a retry. An archived one, paused or crashed with
 * its thread archived or deleted, holds only its disk and boots only once the thread is unarchived. An orphaned VM is
 * one the registry has not placed on the node, whose CPUs and memory the control plane does not know.
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

/** The node as `GET /v1/nodes` and `nexus doctor` read it: its record without the observation, and what its pylons hold. */
export function nodeSummary(registry: PlacementRegistry, record: NodeRecord) {
  const { observation, ...n } = record;
  return { ...n, observedAt: observation?.observedAt ?? null, overcommitted: overcommitted(n.capacity), pylons: nodePylons(registry, record) };
}
