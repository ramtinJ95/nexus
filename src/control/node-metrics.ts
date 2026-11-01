/**
 * A node's health over time. Every health read the control plane makes through a probe becomes a sample: one value
 * for each series the read holds. The registry keeps samples whole for the recent past and as buckets of min, sum,
 * max and count after, in tiers, so a range of any length is served from the tier that fits in at most `maxPoints`
 * points per series. Pure, so the store, the API and the node page share it.
 */
import type { PylonId, ThreadId } from "../ids.ts";
import type { NodeHealth, ProbeClient } from "../protocol/client.ts";

/** One series of a node's health. A pylon's are keyed by the pylon and the thread it ran for, null for an orphan. */
export type Series =
  | { kind: "load1" | "load5" | "load15" | "cpus" | "memTotal" | "memAvailable" | "swapTotal" | "swapUsed" | "diskTotal" | "diskFree" }
  | { kind: "temp"; sensor: string }
  | { kind: "pylonCpu" | "pylonResident"; pylon: PylonId; thread: ThreadId | null };

const plain = new Set<string>(["load1", "load5", "load15", "cpus", "memTotal", "memAvailable", "swapTotal", "swapUsed", "diskTotal", "diskFree"]);

/** The series' key in the registry and on the wire. A sensor's name may hold a colon, so it comes last. */
export function seriesKey(s: Series): string {
  switch (s.kind) {
    case "temp": return `temp:${s.sensor}`;
    case "pylonCpu": case "pylonResident": return `${s.kind}:${s.pylon}:${s.thread ?? ""}`;
    default: return s.kind;
  }
}

/** The series of a key, or null for a key this control plane does not know. */
export function seriesOf(key: string): Series | null {
  if (plain.has(key)) return { kind: key as Extract<Series, { kind: "cpus" }>["kind"] };
  const colon = key.indexOf(":");
  if (colon === -1) return null;
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (kind === "temp") return { kind, sensor: rest };
  if (kind !== "pylonCpu" && kind !== "pylonResident") return null;
  const [pylon, thread, ...more] = rest.split(":");
  if (pylon === undefined || pylon === "" || thread === undefined || more.length > 0) return null;
  return { kind, pylon: pylon as PylonId, thread: thread === "" ? null : thread as ThreadId };
}

const plainLabels: Record<Exclude<Series, { kind: "temp" | "pylonCpu" | "pylonResident" }>["kind"], string> = {
  load1: "1-minute load", load5: "5-minute load", load15: "15-minute load", cpus: "CPUs", memTotal: "Memory total", memAvailable: "Memory available",
  swapTotal: "Swap total", swapUsed: "Swap used", diskTotal: "Disk total", diskFree: "Disk free",
};

/** A sensor's name, a pylon's thread title or else its ID, or a plain series' name. */
export function seriesLabel(s: Series, titleOf: (thread: ThreadId) => string | undefined): string {
  switch (s.kind) {
    case "temp": return s.sensor;
    case "pylonCpu": case "pylonResident": return (s.thread === null ? undefined : titleOf(s.thread)) ?? s.pylon;
    default: return plainLabels[s.kind];
  }
}

/** What one health read gave each series, by key, at the time the control plane read it. A reading the node lacks has no value. */
export interface HealthSample { at: number; values: Record<string, number> }

/** Memory, swap and disk in GiB, CPU in percent of one CPU, temperatures in °C. Disk is the pylons' filesystem. */
export function sampleOf(health: NodeHealth, at: number, threadOf: (pylon: PylonId) => ThreadId | null): HealthSample {
  const series: [Series, number][] = [[{ kind: "cpus" }, health.cpus], [{ kind: "diskTotal" }, health.disk.totalGiB], [{ kind: "diskFree" }, health.disk.freeGiB]];
  if (health.load !== null) series.push([{ kind: "load1" }, health.load.one], [{ kind: "load5" }, health.load.five], [{ kind: "load15" }, health.load.fifteen]);
  const m = health.memory;
  if (m !== null) series.push([{ kind: "memTotal" }, m.totalGiB], [{ kind: "memAvailable" }, m.availableGiB], [{ kind: "swapTotal" }, m.swapTotalGiB], [{ kind: "swapUsed" }, m.swapTotalGiB - m.swapFreeGiB]);
  const sensors = new Map<string, number>();
  for (const t of health.temperatures ?? []) {
    // Two sensors may share a name, such as two NVMe drives' Composite.
    const seen = sensors.get(t.sensor) ?? 0;
    sensors.set(t.sensor, seen + 1);
    series.push([{ kind: "temp", sensor: seen === 0 ? t.sensor : `${t.sensor} (${seen + 1})` }, t.celsius]);
  }
  for (const p of health.pylons ?? []) {
    const thread = threadOf(p.pylonId);
    series.push([{ kind: "pylonCpu", pylon: p.pylonId, thread }, p.cpuPercent], [{ kind: "pylonResident", pylon: p.pylonId, thread }, p.residentGiB]);
  }
  return { at, values: Object.fromEntries(series.filter(([, v]) => Number.isFinite(v)).map(([s, v]) => [seriesKey(s), v])) };
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/**
 * How the registry keeps samples. `raw` keeps each sample. Each other tier keeps one bucket per series per `stepMs`,
 * which every sample in it adds to. Every tier holds the newest data, and each drops what is older than `keepMs`. Each
 * range of the node page's picker is served at a tier's own step, 15 min and 1 h raw, 6 h by the minute, 24 h by two
 * minutes, 7 d by 15 minutes and 30 d by the hour, so reading one regroups nothing.
 */
export const tiers = [
  { name: "raw", stepMs: 0, keepMs: 2 * hour },
  { name: "1m", stepMs: minute, keepMs: 7 * hour },
  { name: "2m", stepMs: 2 * minute, keepMs: 25 * hour },
  { name: "15m", stepMs: 15 * minute, keepMs: 8 * day },
  { name: "1h", stepMs: hour, keepMs: 31 * day },
] as const satisfies readonly { name: string; stepMs: number; keepMs: number }[];
export type Tier = typeof tiers[number];
export type TierName = Tier["name"];

/**
 * A read sooner than this after the node's last recorded sample is not recorded, so pages open in two tabs, or a
 * judgment as the page polls, add no more rows than one page every 5 s. A raw bucket of this width holds one sample.
 */
export const minSampleGapMs = 4_000;
export const maxPoints = 1_000;

/**
 * The tier a range is served from and the width of its buckets. Of the tiers that still hold the range's start, the
 * coarsest whose step fits `maxPoints` buckets, or the finest when none does. Buckets start at multiples of their
 * width, so a range meets at most two more of them than it spans whole, and the width leaves room for both.
 */
export function servingOf(from: number, to: number, now: number): { tier: Tier; bucketMs: number } {
  const width = Math.ceil((to - from) / (maxPoints - 2));
  const holding = tiers.filter((t) => now - t.keepMs <= from);
  const pool: readonly Tier[] = holding.length > 0 ? holding : [tiers.at(-1)!];
  const tier = pool.findLast((t) => t.stepMs <= width) ?? pool[0]!;
  const unit = tier.stepMs === 0 ? 1_000 : tier.stepMs;
  return { tier, bucketMs: Math.max(unit, Math.ceil(width / unit) * unit) };
}

/** A bucket of one series. A raw sample is a bucket of one, whose min, sum and max are its value. */
export interface Bucket { min: number; sum: number; max: number; n: number }

export const bucketOf = (value: number): Bucket => ({ min: value, sum: value, max: value, n: 1 });
export const merged = (a: Bucket, b: Bucket): Bucket => ({ min: Math.min(a.min, b.min), sum: a.sum + b.sum, max: Math.max(a.max, b.max), n: a.n + b.n });

/** A series as the API serves it: its points in time order, each the time of its first sample and its bucket's min, average and max. */
export interface MetricSeries { key: string; series: Series; label: string; t: number[]; min: number[]; avg: number[]; max: number[]; n: number[] }

/**
 * `GET /v1/nodes/<name>/metrics`: the node's series over `from` to `to`, in ms since the epoch. `sampledAt`: the newest
 * sample the points hold, null when none, so a reader that appends later samples counts none twice.
 */
export interface NodeMetrics { node: string; from: number; to: number; tier: TierName; bucketMs: number; sampledAt: number | null; series: MetricSeries[] }

/**
 * The probe client with each health read recorded. A read that fails records nothing, and a record that fails is
 * logged, never the read's failure, so recording never costs a reader its health.
 */
export function recordingHealth<P extends Pick<ProbeClient, "health">>(probe: P, record: (health: NodeHealth) => void, log: (message: string) => void): P {
  return Object.assign(Object.create(probe) as P, {
    async health() {
      const health = await probe.health();
      try { record(health); } catch (err) { log(`${health.node}: recording its health failed: ${(err as Error).message}`); }
      return health;
    },
  });
}
