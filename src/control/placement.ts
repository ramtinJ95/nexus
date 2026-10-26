import type { BootInputs } from "../project.ts";
import type { NodeName } from "../protocol.ts";
import { desiredPhase } from "../reconcile.ts";
import { HttpError } from "./http-error.ts";
import type { NodeRecord, Registry, ThreadId } from "./registry.ts";

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
  if (o.grants === null) return refused("runs a probe too old to report what its pylons hold");
  if (!o.artifacts.includes(need.image)) return refused(`does not hold image ${need.image}`);
  const missing = need.network.secrets.map((s) => s.name).filter((name) => !o.grants!.secrets.includes(name));
  if (missing.length > 0) return refused(`has no secret ${missing.join(", ")} in its secret file`);
  const ssh = [...need.repo.kind === "clone" ? [need.repo.url] : [], need.dotfiles.repo].filter((url) => !url.startsWith("https://"));
  if (ssh.length > 0 && !o.grants.gitSsh) return refused(`has no git SSH key to reach ${ssh.join(" and ")}`);
  // Pylons the planner is about to boot or wake. One the node has yet to report will hold all it asked for, and a
  // stopped one its CPUs and memory again, which the node's capacity does not count yet.
  const now = Date.now();
  const coming = registry.pylonsOn(node.name).flatMap((p) => p.failed === null && desiredPhase(registry.thread(p.thread as ThreadId)!, now) === "running"
    ? [{ ...p.boot.resources, phase: o.pylons.find((seen) => seen.pylonId === p.pylonId)?.phase }] : []);
  const pending = (resource: keyof Room) => coming
    .filter((p) => p.phase === undefined || (p.phase === "stopped" && resource !== "diskGiB"))
    .reduce((total, p) => total + p[resource], 0);
  const { capacity: c } = o;
  const left: Room = {
    cpus: c.cpus - c.committedCpus - pending("cpus") - need.resources.cpus,
    memoryGiB: c.memoryGiB - c.committedMemoryGiB - pending("memoryGiB") - need.resources.memoryGiB,
    diskGiB: c.diskFreeGiB - pending("diskGiB") - need.resources.diskGiB,
  };
  if (left.memoryGiB < 0) return refused(`has ${gib(c.committedMemoryGiB + pending("memoryGiB"))} of ${gib(c.memoryGiB)} GiB of memory committed, and the pylon needs ${need.resources.memoryGiB}`);
  if (left.diskGiB < 0) return refused(`has ${gib(left.diskGiB + need.resources.diskGiB)} GiB of disk free, and the pylon needs ${need.resources.diskGiB}`);
  return { node: node.name, left };
}

const gib = (n: number) => Number(n.toFixed(1));
