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
  | { kind: "pylonCpu" | "pylonResident"; pylon: PylonId; thread: ThreadId | null }
  /** The pylons past `maxPylons` in a range, summed, which only the API serves. */
  | { kind: "otherPylonsCpu" | "otherPylonsResident" };

const plain = new Set<string>(["load1", "load5", "load15", "cpus", "memTotal", "memAvailable", "swapTotal", "swapUsed", "diskTotal", "diskFree", "otherPylonsCpu", "otherPylonsResident"]);

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
  otherPylonsCpu: "Other pylons, summed", otherPylonsResident: "Other pylons, summed",
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
/** How often the control plane reads each online node's health whether or not anyone watches it. */
export const backgroundReadMs = 60_000;
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
 * How many pylons a range shows a line of their own. A busy month runs hundreds, each a series for as long as it ran,
 * so the rest are summed into one line per chart. Eight is the palette's categorical slots.
 */
export const maxPylons = 8;

/** A pylon's identity in a series key: its pylon and thread. */
export const pylonOf = (s: Series): string | null => s.kind === "pylonCpu" || s.kind === "pylonResident" ? `${s.pylon}:${s.thread ?? ""}` : null;

type Served = Omit<MetricSeries, "label">;

/**
 * The series with only the `maxPylons` pylons of the highest CPU peak in the range kept as their own, and the rest
 * summed into `otherPylonsCpu` and `otherPylonsResident`. A bucket's point is the pylons' combined use averaged over
 * every read in it, a pylon that was not running counting 0, so pylons that ran one after the other are not added as
 * if they ran together. Every read has `cpus`, so its count in a bucket is the bucket's reads. A combined min or max
 * cannot be told from each pylon's, so the point claims none: its min and max are its average.
 */
export function foldPylons(series: readonly Served[], bucketMs: number): { series: Served[]; otherPylons: string[] } {
  const peak = new Map<string, number>();
  for (const s of series) {
    const id = pylonOf(s.series);
    if (id !== null) peak.set(id, Math.max(peak.get(id) ?? -Infinity, s.series.kind === "pylonCpu" ? Math.max(...s.max) : -Infinity));
  }
  if (peak.size <= maxPylons) return { series: [...series], otherPylons: [] };
  const kept = new Set([...peak].sort(([a, pa], [b, pb]) => pb - pa || (a < b ? -1 : 1)).slice(0, maxPylons).map(([id]) => id));
  const cpus = series.find((s) => s.key === "cpus");
  const reads = new Map(cpus?.t.map((t, i) => [Math.floor(t / bucketMs), cpus.n[i]!]) ?? []);
  const sums = { pylonCpu: new Map<number, { t: number; sum: number; n: number }>(), pylonResident: new Map<number, { t: number; sum: number; n: number }>() };
  const out: Served[] = [];
  for (const s of series) {
    const id = pylonOf(s.series);
    if (id === null || kept.has(id)) { out.push(s); continue; }
    const sum = sums[s.series.kind as "pylonCpu" | "pylonResident"];
    s.t.forEach((t, i) => {
      const bucket = Math.floor(t / bucketMs);
      const was = sum.get(bucket);
      sum.set(bucket, { t: Math.min(was?.t ?? t, t), sum: (was?.sum ?? 0) + s.avg[i]! * s.n[i]!, n: Math.max(was?.n ?? 0, s.n[i]!) });
    });
  }
  for (const [kind, sum] of [["otherPylonsCpu", sums.pylonCpu], ["otherPylonsResident", sums.pylonResident]] as const) {
    if (sum.size === 0) continue;
    const points = [...sum.entries()].sort(([a], [b]) => a - b).map(([bucket, p]) => {
      const n = Math.max(reads.get(bucket) ?? 0, p.n);
      return { t: p.t, avg: p.sum / n, n };
    });
    const avg = points.map((p) => p.avg);
    out.push({ key: kind, series: { kind }, t: points.map((p) => p.t), min: avg, avg, max: avg, n: points.map((p) => p.n) });
  }
  return { series: out.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), otherPylons: [...peak.keys()].filter((id) => !kept.has(id)).sort() };
}

/**
 * `GET /v1/nodes/<name>/metrics`: the node's series over `from` to `to`, in ms since the epoch. `sampledAt`: the newest
 * sample the points hold, null when none, so a reader that appends later samples counts none twice. `otherPylons`: the
 * pylons, as `<pylon>:<thread>`, summed into the other pylons' series.
 */
export interface NodeMetrics { node: string; from: number; to: number; tier: TierName; bucketMs: number; sampledAt: number | null; series: MetricSeries[]; otherPylons: string[] }

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
