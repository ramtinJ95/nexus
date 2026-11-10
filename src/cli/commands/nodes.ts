import { gib } from "../../util/gib.ts";
import type { NodeCapacity } from "../../protocol/observations.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import { diskText, lowDisk } from "../../disk-space.ts";
import { type Command, when, request, table } from "../kit.ts";
import { nodeRoutes, type NodePylons } from "../../contract/reports.ts";

/** A probe from before pylons were counted reports no CPUs or committed disk, and always 0 GiB of memory committed. */
function capacityText(c: Partial<NodeCapacity>, overcommitted: boolean): string {
  const counted = c.committedDiskGiB !== undefined;
  const n = (v: number | undefined, known = true) => v === undefined || !known ? "unknown" : gib(v);
  return `${n(c.committedCpus)}/${n(c.cpus)} CPUs, ${n(c.committedMemoryGiB, counted)}/${n(c.memoryGiB)} GiB memory committed${overcommitted ? ", overcommitted" : ""}, ${n(c.committedDiskGiB)} GiB disk committed, ${n(c.diskFreeGiB)} GiB disk free${(c.disks ?? []).filter(lowDisk).map((d) => `, disk low at ${d.paths.join(", ")}`).join("")}`;
}

/**
 * Such as `5 up holding 20 CPUs and 40 GiB, 1 paused needing 8 GiB to wake, 3 archived, 1 crashed needing 8 GiB to retry,
 * 1 orphaned (pylon-x)`. Empty for a node with no pylons, or never observed.
 */
function pylonsText(p: NodePylons | null): string {
  if (p === null) return "";
  return [
    ...p.up.pylons === 0 ? [] : [`${p.up.pylons} up holding ${p.up.cpus} CPUs and ${gib(p.up.memoryGiB)} GiB`],
    ...p.paused.pylons === 0 ? [] : [`${p.paused.pylons} paused needing ${gib(p.paused.memoryGiB)} GiB to wake`],
    ...p.archived.pylons === 0 ? [] : [`${p.archived.pylons} archived`],
    ...p.crashed.pylons === 0 ? [] : [`${p.crashed.pylons} crashed needing ${gib(p.crashed.memoryGiB)} GiB to retry`],
    ...p.orphaned.length === 0 ? [] : [`${p.orphaned.length} orphaned (${p.orphaned.join(", ")})`],
  ].join(", ");
}

/** Null readings are what the node's host does not expose, so they print as unknown, never as zero. */
function healthText(h: NodeHealth): string {
  const { load, memory, temperatures, pylons } = h;
  return [
    `node: ${h.node}, read ${when(Date.parse(h.readAt))}`,
    `load: ${load === null ? "unknown" : `${load.one.toFixed(2)} ${load.five.toFixed(2)} ${load.fifteen.toFixed(2)} (1, 5, 15 min)`} on ${h.cpus} CPUs`,
    `memory: ${memory === null ? "unknown" : `${gib(memory.availableGiB)} of ${gib(memory.totalGiB)} GiB available`}`,
    `swap: ${memory === null ? "unknown" : memory.swapTotalGiB === 0 ? "none" : `${gib(memory.swapTotalGiB - memory.swapFreeGiB)} of ${gib(memory.swapTotalGiB)} GiB used`}`,
    ...h.disks?.map((d) => `disk: ${diskText(d)}`) ?? [`disk: ${gib(h.disk.freeGiB)} of ${gib(h.disk.totalGiB)} GiB free at ${h.disk.path}`],
    `temperatures: ${temperatures === null ? "unknown" : temperatures.map((t) => `${t.sensor} ${t.celsius.toFixed(1)} °C`).join(", ")}`,
    ...pylons === null ? ["pylons: unknown"] : pylons.length === 0 ? ["pylons: none running"]
      : pylons.map((p) => `pylon: ${p.pylonId}, ${p.processes} ${p.processes === 1 ? "process" : "processes"}, ${gib(p.cpuPercent)}% CPU, ${gib(p.residentGiB)} GiB resident`),
  ].join("\n");
}

const node: Command = {
  help: ["  nexus node [show] <name>                     a node's load, memory, disk, temperatures and pylon processes, read now; deployers only"],
  args: [1, 1],
  async run(api, [name]) {
    const health = await request(api, nodeRoutes.health, { node: name! });
    return { json: health, text: healthText(health) };
  },
};

export const nodesCommands: Readonly<Record<string, Command>> = {
  node,
  // A node may be named show, and `nexus node show` has always read its health.
  "node show": { ...node, args: [0, 1], run: (api, [name = "show"], ...rest) => node.run(api, [name], ...rest) },
  nodes: {
    help: ["  nexus nodes"],
    args: [0, 0],
    async run(api) {
      const nodes = await request(api, nodeRoutes.list, {});
      return {
        json: nodes,
        text: nodes.length === 0 ? "No nodes." : table(["Node", "State", "Observed", "Capacity"], nodes.map((n) => [
          n.name, n.state, n.observedAt === null ? "never" : when(Date.parse(n.observedAt)),
          n.capacity === null ? "" : capacityText(n.capacity, n.overcommitted),
        ])).split("\n").flatMap((line, i) => {
          const held = i === 0 ? "" : pylonsText(nodes[i - 1]!.pylons);
          return held === "" ? [line] : [line, `  pylons: ${held}`];
        }).join("\n"),
      };
    },
  },
};
