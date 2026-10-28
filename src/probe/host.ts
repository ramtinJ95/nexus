/**
 * What the probe reads of its host: the capacity every snapshot reports, and the health `GET /v1/node-health` serves on
 * request. Capacity uses Node's portable readings, so a probe on a Mac reports it too. Health adds what only Linux's
 * /proc and /sys expose, and a reading the host does not expose is null, never zero.
 */
import { readdir, readFile, statfs } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { NodeHealth, NodeName, PylonId } from "../protocol.ts";

const gib = 2 ** 30;

/** The free disk is the filesystem that holds `storage`, where the backend keeps its pylons' disks. */
export async function hostCapacity(storage: string): Promise<{ cpus: number; memoryGiB: number; disk: NodeHealth["disk"] }> {
  const disk = await statfs(storage);
  return { cpus: availableParallelism(), memoryGiB: totalmem() / gib, disk: { path: storage, totalGiB: (disk.blocks * disk.bsize) / gib, freeGiB: (disk.bavail * disk.bsize) / gib } };
}

export function parseLoadavg(text: string): NonNullable<NodeHealth["load"]> {
  const [one, five, fifteen] = text.trim().split(/\s+/).map(Number);
  if (![one, five, fifteen].every((n) => Number.isFinite(n))) throw new Error(`/proc/loadavg reads ${JSON.stringify(text)}`);
  return { one: one!, five: five!, fifteen: fifteen! };
}

export function parseMeminfo(text: string): NonNullable<NodeHealth["memory"]> {
  const kib = new Map(text.split("\n").flatMap((line) => {
    const m = /^(\w+):\s+(\d+) kB$/.exec(line.trim());
    return m === null ? [] : [[m[1]!, Number(m[2])]];
  }));
  const giB = (field: string) => {
    const value = kib.get(field);
    if (value === undefined) throw new Error(`/proc/meminfo has no ${field}`);
    return value / 2 ** 20;
  };
  return { totalGiB: giB("MemTotal"), availableGiB: giB("MemAvailable"), swapTotalGiB: giB("SwapTotal"), swapFreeGiB: giB("SwapFree") };
}

/** /proc/<pid>/stat. The command name in parentheses may hold spaces, so fields count from its closing parenthesis. */
export function parseStat(text: string): { pid: number; ppid: number; cpuTicks: number } {
  const after = text.slice(text.lastIndexOf(")") + 2).split(" ");
  // State is field 3, the first after the name. ppid is 4, utime 14 and stime 15.
  return { pid: Number.parseInt(text, 10), ppid: Number(after[1]), cpuTicks: Number(after[11]) + Number(after[12]) };
}

/** VmRSS of /proc/<pid>/status in GiB. A kernel thread, or a process exiting, has none. */
export function parseResident(text: string): number {
  const m = /^VmRSS:\s+(\d+) kB$/m.exec(text);
  return m === null ? 0 : Number(m[1]) / 2 ** 20;
}

/** USER_HZ, which /proc reports CPU times in. Linux fixes it at 100 on every architecture Nexus runs on. */
const ticksPerSecond = 100;

/**
 * A sensor or a process's file. A driver may answer EBUSY or EIO, as an AMD GPU's sensor does while the GPU sleeps, and a
 * process may exit mid-read, so any failure leaves that reading out rather than failing the rest.
 */
const read = (path: string) => readFile(path, "utf8").catch(() => null);
const entries = (dir: string) => readdir(dir).catch(() => []);
/** Load or memory, which only a host without /proc lacks. */
const basic = (reading: string, path: string) => readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
  if (err.code === "ENOENT") return null;
  throw new Error(`cannot read the node's ${reading}: ${err.message}`);
});
const numbered = (names: readonly string[], prefix: string) =>
  names.filter((n) => new RegExp(`^${prefix}\\d+$`).test(n)).sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));

/**
 * hwmon's sensors, or the thermal zones on a host without them, since a zone usually repeats an hwmon sensor. Null when
 * the host exposes neither, as a VM often does.
 */
async function temperatures(sys: string): Promise<NodeHealth["temperatures"]> {
  const found: { sensor: string; celsius: number }[] = [];
  const hwmon = join(sys, "class", "hwmon");
  for (const dir of numbered(await entries(hwmon), "hwmon")) {
    const name = (await read(join(hwmon, dir, "name")))?.trim() ?? dir;
    for (const input of (await entries(join(hwmon, dir))).filter((f) => /^temp\d+_input$/.test(f)).sort()) {
      const value = await read(join(hwmon, dir, input));
      if (value === null || !/^-?\d+$/.test(value.trim())) continue;
      const label = (await read(join(hwmon, dir, input.replace("_input", "_label"))))?.trim() ?? input.replace("_input", "");
      found.push({ sensor: `${name} ${label}`, celsius: Number(value) / 1000 });
    }
  }
  if (found.length > 0) return found;
  const thermal = join(sys, "class", "thermal");
  for (const dir of numbered(await entries(thermal), "thermal_zone")) {
    const value = await read(join(thermal, dir, "temp"));
    if (value === null || !/^-?\d+$/.test(value.trim())) continue;
    found.push({ sensor: (await read(join(thermal, dir, "type")))?.trim() ?? dir, celsius: Number(value) / 1000 });
  }
  return found.length > 0 ? found : null;
}

/**
 * Each pylon's process and its descendants, such as a controller and its QEMU. CPU is the percent of one CPU the tree
 * used over the sample of about `sampleMs`, so a tree that keeps four CPUs busy reads 400.
 */
async function pylonProcesses(proc: string, roots: readonly { pylonId: PylonId; pid: number }[], sampleMs: number, wait: (ms: number) => Promise<unknown>, now: () => number): Promise<NonNullable<NodeHealth["pylons"]>> {
  const stats = async (pids: Iterable<number>) => new Map((await Promise.all([...pids].map(async (pid) => {
    const text = await read(join(proc, String(pid), "stat"));
    return text === null ? [] : [parseStat(text)];
  }))).flat().map((s) => [s.pid, s]));
  const all = await stats((await entries(proc)).filter((n) => /^\d+$/.test(n)).map(Number));
  const children = new Map<number, number[]>();
  for (const s of all.values()) children.set(s.ppid, [...children.get(s.ppid) ?? [], s.pid]);
  const trees = roots.filter((r) => all.has(r.pid)).map((r) => {
    const pids = [r.pid];
    for (let i = 0; i < pids.length; i++) pids.push(...children.get(pids[i]!) ?? []);
    return { ...r, pids };
  });
  const sampled = now();
  await wait(sampleMs);
  const after = await stats(trees.flatMap((t) => t.pids));
  // A stalled event loop or a slow /proc read stretches the sample, so CPU is over the time it took.
  const seconds = (now() - sampled) / 1000;
  return (await Promise.all(trees.map(async ({ pylonId, pid: root, pids }) => {
    const statuses = await Promise.all(pids.filter((pid) => after.has(pid)).map(async (pid) => ({ pid, status: await read(join(proc, String(pid), "status")) })));
    const living = statuses.flatMap(({ pid, status }) => status === null ? [] : [{ pid, residentGiB: parseResident(status) }]);
    if (!living.some(({ pid }) => pid === root)) return [];
    const ticks = living.reduce((sum, { pid }) => sum + after.get(pid)!.cpuTicks - all.get(pid)!.cpuTicks, 0);
    return [{ pylonId, processes: living.length, cpuPercent: seconds > 0 ? (ticks / ticksPerSecond) / seconds * 100 : 0, residentGiB: living.reduce((sum, p) => sum + p.residentGiB, 0) }];
  }))).flat();
}

export interface HealthSources {
  /** Where /proc and /sys are read from. Tests point it at fixture files. */
  root: string;
  storage: string;
  /** Null from a backend that cannot name its pylons' processes. */
  pylons: readonly { pylonId: PylonId; pid: number }[] | null;
  sampleMs: number;
  /** Tests only, with `now`, to stand in for the sample's time passing. */
  wait?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

export async function readNodeHealth(node: NodeName, sources: HealthSources): Promise<NodeHealth> {
  const proc = join(sources.root, "proc");
  const [capacity, loadavg, meminfo, temps, pylons] = await Promise.all([
    hostCapacity(sources.storage), basic("load", join(proc, "loadavg")), basic("memory", join(proc, "meminfo")), temperatures(join(sources.root, "sys")),
    sources.pylons === null ? null : pylonProcesses(proc, sources.pylons, sources.sampleMs, sources.wait ?? delay, sources.now ?? performance.now.bind(performance)),
  ]);
  return {
    node, readAt: new Date().toISOString(), cpus: capacity.cpus,
    load: loadavg === null ? null : parseLoadavg(loadavg), memory: meminfo === null ? null : parseMeminfo(meminfo),
    disk: capacity.disk, temperatures: temps, pylons,
  };
}
