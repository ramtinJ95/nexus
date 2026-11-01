/**
 * The node page's graphs as data, apart from the DOM: the ranges its picker offers, the charts and the lines each
 * draws from a node's series, the history the page holds of a range with each poll's sample appended, and the
 * columns uPlot draws. Pure, so node-page.ts renders the charts' figures from it and a test reads it without a browser.
 */
import { maxPylons, pylonOf, seriesOf, type NodeMetrics, type Series } from "../node-metrics.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export const ranges = [["15m", 15 * minute], ["1h", hour], ["6h", 6 * hour], ["24h", day], ["7d", 7 * day], ["30d", 30 * day]] as const;
export type RangeName = typeof ranges[number][0];
export const defaultRange: RangeName = "1h";
export const rangeOf = (name: string | null): RangeName => ranges.find(([n]) => n === name)?.[0] ?? defaultRange;
export const rangeMs = (name: RangeName): number => ranges.find(([n]) => n === name)![1];

/** What the node page carries in `data-sample`: its health read as a sample, and a label for each pylon series. */
export interface PageSample { at: number; values: Record<string, number>; labels: Record<string, string> }

/** A series' points in time order: each point's time, the min, average and max of its samples, and how many. */
export interface Points { t: number[]; min: number[]; avg: number[]; max: number[]; n: number[] }
export interface Held extends Points { key: string; series: Series; label: string }

/**
 * What the page holds of one range: the points the API served for it and the samples polls appended since. `seen`: the
 * newest sample the points hold, so a sample is counted once however often a poll carries it.
 */
export interface History { rangeMs: number; from: number; to: number; bucketMs: number; seen: number; series: Map<string, Held>; otherPylons: Set<string> }

export const historyOf = (m: NodeMetrics, rangeMs: number): History => ({
  rangeMs, from: m.from, to: m.to, bucketMs: m.bucketMs, seen: m.sampledAt ?? -Infinity, otherPylons: new Set(m.otherPylons),
  series: new Map(m.series.map((s) => [s.key, { key: s.key, series: s.series, label: s.label, t: [...s.t], min: [...s.min], avg: [...s.avg], max: [...s.max], n: [...s.n] }])),
});

/** Whether any point stands for more than one sample, so a line shows its average and a band its min and max. */
export const bucketed = (h: History): boolean => [...h.series.values()].some((s) => s.n.some((n) => n > 1));

/**
 * A sample this long after the newest the page holds means samples between them may be in the registry and not here,
 * as when the tab was hidden or its polls failed while another reader recorded, so the page reads the range again.
 */
export const catchUpMs = 12_500;
export const missed = (h: History, sample: PageSample): boolean => sample.at - h.seen > catchUpMs;

/**
 * Adds a poll's sample to `h`, as the API would have served it: into a series' last point when the sample falls in
 * that point's bucket, else as a point of its own, and as a new series for a key the history lacks, such as a pylon
 * that started. Then the range ends at the sample, and the points before its start go. Says whether `h` changed.
 */
export function appended(h: History, sample: PageSample): boolean {
  if (sample.at <= h.seen) return false;
  h.seen = sample.at;
  for (const [key, value] of Object.entries(folded(h, sample.values))) {
    let held = h.series.get(key);
    const label = sample.labels[key];
    if (held === undefined) {
      const series = seriesOf(key);
      if (series === null) continue;
      held = { key, series, label: label ?? labelOf(series), t: [], min: [], avg: [], max: [], n: [] };
      h.series.set(key, held);
    } else if (label !== undefined) held.label = label;
    const last = held.t.length - 1;
    if (last >= 0 && Math.floor(held.t[last]! / h.bucketMs) === Math.floor(sample.at / h.bucketMs)) {
      const n = held.n[last]!;
      held.avg[last] = (held.avg[last]! * n + value) / (n + 1);
      held.min[last] = Math.min(held.min[last]!, value);
      held.max[last] = Math.max(held.max[last]!, value);
      held.n[last] = n + 1;
    } else {
      held.t.push(sample.at);
      held.min.push(value);
      held.avg.push(value);
      held.max.push(value);
      held.n.push(1);
    }
  }
  h.to = Math.max(h.to, sample.at);
  h.from = h.to - h.rangeMs;
  for (const [key, held] of h.series) {
    const keep = held.t.findIndex((t) => t >= h.from);
    if (keep === -1) h.series.delete(key);
    else if (keep > 0) for (const column of [held.t, held.min, held.avg, held.max, held.n]) column.splice(0, keep);
  }
  return true;
}

const otherKeys = { pylonCpu: "otherPylonsCpu", pylonResident: "otherPylonsResident" } as const;

/**
 * The sample's values with the pylons the range sums summed as the API sums them: those it named, and a pylon that
 * starts once `maxPylons` pylons have lines of their own. The other pylons' labels follow their count.
 */
function folded(h: History, values: Record<string, number>): Record<string, number> {
  const own = new Set([...h.series.values()].flatMap((s) => pylonOf(s.series) ?? []));
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    const series = seriesOf(key);
    const id = series === null ? null : pylonOf(series);
    if (id === null || own.has(id) || (!h.otherPylons.has(id) && own.size < maxPylons)) {
      out[key] = value;
      if (id !== null) own.add(id);
      continue;
    }
    h.otherPylons.add(id);
    const other = otherKeys[series!.kind as keyof typeof otherKeys];
    out[other] = (out[other] ?? 0) + value;
  }
  for (const other of Object.values(otherKeys)) {
    const held = h.series.get(other);
    if (held !== undefined || other in out) {
      const label = `${h.otherPylons.size} other pylons, summed`;
      if (held !== undefined) held.label = label;
      else h.series.set(other, { key: other, series: { kind: other }, label, t: [], min: [], avg: [], max: [], n: [] });
    }
  }
  return out;
}

const labelOf = (s: Series): string => s.kind === "temp" ? s.sensor : s.kind === "pylonCpu" || s.kind === "pylonResident" ? s.pylon : s.kind;

const none = (): Points => ({ t: [], min: [], avg: [], max: [], n: [] });

/**
 * `a`'s points in the buckets `b` has a point in too, each made from `a`'s and `b`'s values in that bucket by `f`, which
 * takes which of `a`'s values it makes. A point's time is its bucket's first sample of its own series, so two series
 * meet by bucket, not by time: a bucket whose first read had CPUs and no load still has a load per CPU.
 */
function joined(a: Points, b: Points, bucketMs: number, f: (a: number, b: number, which: "min" | "avg" | "max") => number): Points {
  const at = new Map(b.t.map((t, i) => [Math.floor(t / bucketMs), i]));
  const out = none();
  a.t.forEach((t, i) => {
    const j = at.get(Math.floor(t / bucketMs));
    if (j === undefined) return;
    out.t.push(t);
    out.n.push(a.n[i]!);
    for (const which of ["min", "avg", "max"] as const) out[which].push(f(a[which][i]!, b.avg[j]!, which));
  });
  return out;
}

/** How a line is drawn: a categorical colour by its slot, or `ref` for a reference such as a total, dashed and muted. */
export type Look = { slot: number } | { ref: true };
export interface Line { id: string; label: string; points: Points; look: Look; step?: boolean }

/**
 * Hands out colour slots by identity, in the order identities first appear, so a pylon keeps its colour while
 * others start and stop, and in both pylon charts. One per page, kept across ranges.
 */
export function slotter() {
  const families = new Map<string, Map<string, number>>();
  return (family: string, id: string): number => {
    const slots = families.get(family) ?? families.set(family, new Map()).get(family)!;
    return slots.get(id) ?? slots.set(id, slots.size).get(id)!;
  };
}
export type Slots = ReturnType<typeof slotter>;

export interface Chart {
  id: string;
  title: string;
  /** The unit the caption names, if any. */
  unit: string;
  /** Whether the y-axis starts at 0, as a quantity's does, rather than near the data, as a temperature's does. */
  zero: boolean;
  /** A level drawn as a faint guide, which the y range always holds. */
  guide?: number;
  /** A value's decimals and unit in the legend, and a tick of the y-axis, which is narrower. */
  digits: number;
  suffix: string;
  tick(v: number): string;
  lines(h: History, slots: Slots): Line[];
  /** Values the y range holds besides the lines', such as the memory the lines add up to. */
  holds?(h: History): number[];
  /** What the chart says in place of its lines, when it has a reason that is not a lack of readings. */
  note?(h: History): string | null;
}

/** A tick in at most three figures, so it fits the axis's fixed width. */
const short = (v: number) => Math.abs(v) >= 1000 ? `${Number((v / 1000).toPrecision(3))}K` : String(Number(v.toPrecision(3)));
const gibs = { digits: 1, suffix: " GiB" };
const held = (h: History, key: string) => h.series.get(key) ?? none();
const line = (h: History, key: string, label: string, look: Look, extra: Partial<Line> = {}): Line[] =>
  h.series.has(key) ? [{ id: key, label, points: held(h, key), look, ...extra }] : [];
const lastOf = (h: History, key: string) => h.series.get(key)?.avg.at(-1);
/** The node was read in the range, but no read held a series of the kind, so the chart says why it is empty. */
const noneOf = (h: History, kind: string, why: string) => h.series.size > 0 && ![...h.series.keys()].some((key) => key.startsWith(`${kind}:`)) ? why : null;
/** A line for each series of a kind, ordered by label, coloured by the identity `id` names. */
const each = (h: History, slots: Slots, family: string, kind: Series["kind"], id: (s: Series) => string): Line[] =>
  [...h.series.values()].filter((s) => s.series.kind === kind).sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
    .map((s) => ({ id: id(s.series), label: s.label, points: s, look: { slot: slots(family, id(s.series)) } }));
const pylonId = (s: Series) => s.kind === "pylonCpu" || s.kind === "pylonResident" ? `${s.pylon}:${s.thread ?? ""}` : "";

const perCpu = (h: History, key: string) => joined(held(h, key), held(h, "cpus"), h.bucketMs, (load, cpus) => load / cpus);
const memoryUsed = (h: History) => joined(held(h, "memAvailable"), held(h, "memTotal"), h.bucketMs, (available, total) => total - available);
/** Memory used is the total less what is available, so its lowest is the total less the most available. */
const usedOf = (p: Points): Points => ({ ...p, min: p.max, max: p.min });

export const charts: readonly Chart[] = [
  {
    id: "load-per-cpu", title: "Load per CPU", unit: "", zero: true, guide: 1, digits: 2, suffix: "", tick: short,
    lines: (h) => [["load1", "1 minute"], ["load5", "5 minutes"], ["load15", "15 minutes"]].flatMap(([key, label], slot) =>
      h.series.has(key!) && h.series.has("cpus") ? [{ id: key!, label: label!, points: perCpu(h, key!), look: { slot } }] : []),
  },
  {
    id: "load", title: "Load against CPUs", unit: "", zero: true, digits: 2, suffix: "", tick: short,
    lines: (h) => [...line(h, "load1", "1-minute load", { slot: 0 }), ...line(h, "cpus", "CPUs", { ref: true }, { step: true })],
  },
  {
    id: "memory", title: "Memory", unit: "GiB", zero: true, ...gibs, tick: short,
    lines: (h) => [
      ...h.series.has("memAvailable") && h.series.has("memTotal") ? [{ id: "memUsed", label: "Used", points: usedOf(memoryUsed(h)), look: { slot: 0 } }] : [],
      ...line(h, "memAvailable", "Available", { slot: 1 }),
    ],
    holds: (h) => held(h, "memTotal").max,
  },
  {
    id: "swap", title: "Swap", unit: "GiB", zero: true, ...gibs, tick: short,
    lines: (h) => [...line(h, "swapUsed", "Used", { slot: 0 }), ...line(h, "swapTotal", "Total", { ref: true })],
    note: (h) => lastOf(h, "swapTotal") === 0 ? "This node has no swap." : null,
  },
  {
    id: "disk", title: "Disk free", unit: "GiB", zero: true, ...gibs, tick: short,
    lines: (h) => [...line(h, "diskFree", "Free", { slot: 0 }), ...line(h, "diskTotal", "Total", { ref: true })],
  },
  {
    id: "temperatures", title: "Temperatures", unit: "°C", zero: false, digits: 1, suffix: " °C", tick: (v) => `${short(v)}°`,
    lines: (h, slots) => each(h, slots, "temp", "temp", (s) => s.kind === "temp" ? s.sensor : ""),
    note: (h) => noneOf(h, "temp", "This node reported no temperatures in this range. A VM often exposes none."),
  },
  {
    id: "pylon-cpu", title: "Pylon CPU", unit: "% of one CPU", zero: true, digits: 1, suffix: "%", tick: (v) => `${short(v)}%`,
    lines: (h, slots) => [...each(h, slots, "pylon", "pylonCpu", pylonId), ...line(h, "otherPylonsCpu", h.series.get("otherPylonsCpu")?.label ?? "", { ref: true })],
    note: (h) => noneOf(h, "pylonCpu", "No pylon's processes were reported in this range, as none ran or the node's backend does not say which are its pylons'."),
  },
  {
    id: "pylon-memory", title: "Pylon memory", unit: "GiB resident", zero: true, ...gibs, tick: short,
    lines: (h, slots) => [...each(h, slots, "pylon", "pylonResident", pylonId), ...line(h, "otherPylonsResident", h.series.get("otherPylonsResident")?.label ?? "", { ref: true })],
    note: (h) => noneOf(h, "pylonResident", "No pylon's processes were reported in this range, as none ran or the node's backend does not say which are its pylons'."),
  },
];

/** A point as the legend reads it: its average, and the range of its samples when they differ, as in 25.2 GiB (24.5–26.0). */
export function reading(chart: Chart, avg: number, min = avg, max = avg): string {
  const [a, lo, hi] = [avg, min, max].map((v) => v.toFixed(chart.digits));
  return lo === hi ? `${a}${chart.suffix}` : `${a}${chart.suffix} (${lo}–${hi})`;
}

/** Points further apart than this have no reading between them, so the line breaks. The page polls every 5 s. */
export const gapMs = (bucketMs: number): number => 2.5 * Math.max(bucketMs, 5_000);

/**
 * A value of a line at an x of the columns: a number, null where its line breaks, and undefined where it has no point
 * but its line runs on, as uPlot reads them.
 */
export type Cell = number | null | undefined;
export interface Columns { x: number[]; lines: { min: Cell[]; avg: Cell[]; max: Cell[] }[] }

/**
 * The lines' points on one x array, as uPlot takes them. A line breaks just after a point that the next is more than
 * `gap` after, with a null there.
 */
export function columns(lines: readonly Points[], gap: number): Columns {
  const breaks = lines.map((p) => p.t.flatMap((t, i) => i > 0 && t - p.t[i - 1]! > gap ? [p.t[i - 1]! + 1] : []));
  const x = [...new Set([...lines.flatMap((p) => p.t), ...breaks.flat()])].sort((a, b) => a - b);
  const index = new Map(x.map((t, i) => [t, i]));
  return {
    x,
    lines: lines.map((p, l) => {
      const column = (values: number[]) => {
        const cells: Cell[] = Array.from({ length: x.length }, () => undefined);
        for (const t of breaks[l]!) cells[index.get(t)!] = null;
        p.t.forEach((t, i) => { cells[index.get(t)!] = values[i]; });
        return cells;
      };
      return { min: column(p.min), avg: column(p.avg), max: column(p.max) };
    }),
  };
}

const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10];
/** The smallest round number at least `v` with a little room, so a line at its peak does not run along the top. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const room = v * 1.04;
  const scale = 10 ** Math.floor(Math.log10(room));
  return Number((steps.find((s) => s * scale >= room)! * scale).toPrecision(6));
}

/**
 * The y range of a chart's lines, which holds every value, its guide and what it `holds`, from 0 for a quantity, and
 * which only widens from `prev`, so a live chart's axis stays put. Hidden lines count too, so toggling one keeps it.
 */
export function yRange(chart: Chart, h: History, lines: readonly Line[], prev: readonly [number, number] | null): [number, number] {
  const values = [...lines.flatMap((l) => [...l.points.min, ...l.points.max]), ...chart.holds?.(h) ?? [], ...chart.guide === undefined ? [] : [chart.guide]].filter(Number.isFinite);
  let range: [number, number];
  if (values.length === 0) range = prev === null ? [0, 1] : [prev[0], prev[1]];
  else if (chart.zero) range = [0, niceCeil(Math.max(...values))];
  else {
    const [lo, hi] = [Math.min(...values), Math.max(...values)];
    const step = niceCeil(Math.max(hi - lo, Math.abs(hi) * 0.1, 1) / 4);
    range = [Math.floor(lo / step) * step - step, Math.ceil(hi / step) * step + step];
  }
  return prev === null ? range : [Math.min(prev[0], range[0]), Math.max(prev[1], range[1])];
}
