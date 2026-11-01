import { test } from "node:test";
import assert from "node:assert/strict";
import { seriesOf, type MetricSeries, type NodeMetrics } from "../node-metrics.ts";
import { appended, bucketed, catchUpMs, charts, columns, gapMs, historyOf, missed, niceCeil, reading, slotter, yRange, type History } from "./graph-data.ts";

const minute = 60_000;
const hour = 60 * minute;

/** A series as the API serves it, from [time, min, avg, max, n] points. */
function served(key: string, label: string, points: [number, number, number, number, number][]): MetricSeries {
  return { key, series: seriesOf(key)!, label, t: points.map((p) => p[0]), min: points.map((p) => p[1]), avg: points.map((p) => p[2]), max: points.map((p) => p[3]), n: points.map((p) => p[4]) };
}
/** Raw points of one sample each. */
const raw = (key: string, label: string, points: [number, number][]) => served(key, label, points.map(([t, v]) => [t, v, v, v, 1]));
const metrics = (series: MetricSeries[], over: Partial<NodeMetrics> = {}): NodeMetrics =>
  ({ node: "rj-firebat", from: 0, to: hour, tier: "raw", bucketMs: 4_000, sampledAt: Math.max(-Infinity, ...series.flatMap((s) => s.t)), series, ...over });
const chart = (id: string) => charts.find((c) => c.id === id)!;
const linesOf = (id: string, h: History) => chart(id).lines(h, slotter());

test("lines that miss each other's times share one x array, breaking with a null where the node went unread", () => {
  const a = { t: [0, 5_000, 10_000, 60_000], min: [1, 2, 3, 4], avg: [1, 2, 3, 4], max: [1, 2, 3, 4], n: [1, 1, 1, 1] };
  const b = { t: [5_000, 60_000], min: [7, 8], avg: [7, 8], max: [7, 8], n: [1, 1] };
  const { x, lines } = columns([a, b], gapMs(1_000));
  assert.deepEqual(x, [0, 5_000, 5_001, 10_000, 10_001, 60_000]);
  assert.deepEqual(lines[0]!.avg, [1, 2, undefined, 3, null, 4], "a reading 50 s after the last is past the gap of 12.5 s");
  assert.deepEqual(lines[1]!.avg, [undefined, 7, null, undefined, undefined, 8], "b runs on across a's times and breaks after its own 55 s gap");
});

test("a bucket's gap is two and a half buckets, and a raw range's two and a half polls", () => {
  assert.equal(gapMs(1_000), 12_500);
  assert.equal(gapMs(hour), 2.5 * hour);
});

test("load per CPU divides each load by the CPUs read with it, and memory used is the total less what is available", () => {
  const h = historyOf(metrics([
    raw("cpus", "CPUs", [[0, 16], [5_000, 16]]),
    raw("load1", "1-minute load", [[0, 8], [5_000, 24]]),
    raw("load5", "5-minute load", [[0, 4], [5_000, 4]]),
    served("memTotal", "Memory total", [[0, 64, 64, 64, 2]]),
    served("memAvailable", "Memory available", [[0, 10, 24, 40, 2]]),
  ]), hour);
  const load = linesOf("load-per-cpu", h);
  assert.deepEqual(load.map((l) => [l.id, l.points.avg]), [["load1", [0.5, 1.5]], ["load5", [0.25, 0.25]]], "the node read no 15-minute load");
  const [used, available] = linesOf("memory", h);
  assert.deepEqual([used!.label, used!.points.min, used!.points.avg, used!.points.max], ["Used", [24], [40], [54]], "most available is least used");
  assert.deepEqual(available!.points.avg, [24]);
  assert.deepEqual(yRange(chart("memory"), h, [used!, available!], null), [0, 70], "memory's axis holds the total");
});

test("a node that read no memory, load or pylons draws none of their lines", () => {
  const h = historyOf(metrics([raw("cpus", "CPUs", [[0, 4]]), raw("diskFree", "Disk free", [[0, 50]]), raw("diskTotal", "Disk total", [[0, 100]])]), hour);
  for (const id of ["load-per-cpu", "memory", "swap", "temperatures", "pylon-cpu", "pylon-memory"]) assert.deepEqual(linesOf(id, h), [], id);
  assert.deepEqual(linesOf("load", h).map((l) => [l.label, l.look]), [["CPUs", { ref: true }]]);
  assert.deepEqual(linesOf("disk", h).map((l) => l.label), ["Free", "Total"]);
});

test("a pylon keeps its colour in both pylon charts and while others start, and its line takes its thread's title", () => {
  const slots = slotter();
  const h = historyOf(metrics([
    raw("pylonCpu:pylon-b:th-b", "Beta", [[0, 50]]), raw("pylonResident:pylon-b:th-b", "Beta", [[0, 2]]),
    raw("pylonCpu:pylon-a:", "pylon-a", [[0, 10]]),
  ]), hour);
  const look = (id: string) => Object.fromEntries(chart(id).lines(h, slots).map((l) => [l.label, l.look]));
  assert.deepEqual(look("pylon-cpu"), { Beta: { slot: 0 }, "pylon-a": { slot: 1 } });
  appended(h, { at: 5_000, values: { "pylonCpu:pylon-c:th-c": 5, "pylonResident:pylon-c:th-c": 1 }, labels: { "pylonCpu:pylon-c:th-c": "Alpha", "pylonResident:pylon-c:th-c": "Alpha" } });
  assert.deepEqual(look("pylon-cpu"), { Alpha: { slot: 2 }, Beta: { slot: 0 }, "pylon-a": { slot: 1 } });
  assert.deepEqual(look("pylon-memory"), { Alpha: { slot: 2 }, Beta: { slot: 0 } });
});

test("a poll's sample merges into the last point's bucket, starts a point past it, adds a new series and drops what left the range", () => {
  const h = historyOf(metrics([
    served("load1", "1-minute load", [[0, 1, 1, 1, 1], [3 * minute + 5_000, 2, 3, 4, 2]]),
    served("cpus", "CPUs", [[0, 8, 8, 8, 1], [3 * minute + 5_000, 8, 8, 8, 2]]),
  ], { from: 0, to: 4 * minute, tier: "1m", bucketMs: minute }), 4 * minute);
  assert.equal(bucketed(h), true);
  assert.equal(appended(h, { at: 3 * minute + 30_000, values: { load1: 6, cpus: 8 }, labels: {} }), true);
  assert.deepEqual(h.series.get("load1"), { ...h.series.get("load1")!, t: [0, 3 * minute + 5_000], min: [1, 2], avg: [1, 4], max: [1, 6], n: [1, 3] }, "same minute: merged");
  appended(h, { at: 4 * minute + 10_000, values: { load1: 0.5, cpus: 8, "temp:Composite": 41 }, labels: {} });
  const load = h.series.get("load1")!;
  assert.deepEqual([load.t, load.avg, load.n], [[3 * minute + 5_000, 4 * minute + 10_000], [4, 0.5], [3, 1]], "next minute: a point of its own, and the first point is out of range");
  assert.deepEqual([h.from, h.to], [10_000, 4 * minute + 10_000], "the range ends at the sample");
  const temp = h.series.get("temp:Composite")!;
  assert.deepEqual([temp.label, temp.t, temp.avg], ["Composite", [4 * minute + 10_000], [41]]);
  assert.equal(appended(h, { at: 4 * minute + 10_000, values: { load1: 9 }, labels: {} }), false, "a sample no newer than the last point changes nothing");
  assert.deepEqual(h.series.get("load1")!.avg, [4, 0.5]);
});

test("a series whose every point left the range goes, and a key this page does not know is skipped", () => {
  const h = historyOf(metrics([raw("swapUsed", "Swap used", [[0, 1]])], { to: 60_000 }), 60_000);
  appended(h, { at: 2 * minute, values: { load1: 1, "mystery:x": 3 }, labels: {} });
  assert.deepEqual([...h.series.keys()], ["load1"]);
  assert.equal(bucketed(h), false);
});

test("the y range rounds up from 0, holds the guide, and only widens while live", () => {
  const h = historyOf(metrics([raw("load1", "1-minute load", [[0, 2]]), raw("cpus", "CPUs", [[0, 4]])]), hour);
  const perCpu = chart("load-per-cpu");
  const first = yRange(perCpu, h, perCpu.lines(h, slotter()), null);
  assert.deepEqual(first, [0, 1.2], "a load of 0.5 per CPU still shows the guide at 1");
  appended(h, { at: 5_000, values: { load1: 12, cpus: 4 }, labels: {} });
  const grown = yRange(perCpu, h, perCpu.lines(h, slotter()), first);
  assert.deepEqual(grown, [0, 4]);
  appended(h, { at: 10_000, values: { load1: 1, cpus: 4 }, labels: {} });
  assert.deepEqual(yRange(perCpu, h, perCpu.lines(h, slotter()), grown), [0, 4]);
  assert.deepEqual([niceCeil(62.8), niceCeil(100), niceCeil(0), niceCeil(0.3)], [70, 120, 1, 0.4]);
});

test("a temperature's axis sits around its readings, not at 0", () => {
  const h = historyOf(metrics([raw("temp:Tctl", "Tctl", [[0, 52], [5_000, 61]])]), hour);
  const temps = chart("temperatures");
  const [lo, hi] = yRange(temps, h, temps.lines(h, slotter()), null);
  assert.ok(lo > 0 && lo < 52 && hi > 61 && hi < 100, `${lo} to ${hi}`);
});

test("the legend reads a point's average, with its samples' range only when they differ", () => {
  assert.equal(reading(chart("memory"), 25.24, 24.5, 26), "25.2 GiB (24.5–26.0)");
  assert.equal(reading(chart("pylon-cpu"), 12.34), "12.3%");
  assert.equal(reading(chart("load"), 1.001, 0.999, 1.003), "1.00", "a range that rounds to one value is not shown");
});

test("swap says the node has none when its total is 0", () => {
  const swap = chart("swap");
  assert.equal(swap.note!(historyOf(metrics([raw("swapTotal", "Swap total", [[0, 0]])]), hour)), "This node has no swap.");
  assert.equal(swap.note!(historyOf(metrics([raw("swapTotal", "Swap total", [[0, 8]])]), hour)), null);
});

test("temperatures and pylon charts say why they are empty when the node was read but reported none", () => {
  const read = historyOf(metrics([raw("cpus", "CPUs", [[0, 4]])]), hour);
  assert.match(chart("temperatures").note!(read)!, /reported no temperatures/);
  for (const id of ["pylon-cpu", "pylon-memory"]) assert.match(chart(id).note!(read)!, /No pylon's processes were reported/);
  assert.equal(chart("temperatures").note!(historyOf(metrics([]), hour)), null, "a range with no reading at all keeps the general note");
  assert.equal(chart("temperatures").note!(historyOf(metrics([raw("temp:Tctl", "Tctl", [[0, 50]])]), hour)), null);
});

test("a sample the served points already hold is not counted again, and one long after them asks for the range again", () => {
  const h = historyOf(metrics([served("load1", "1-minute load", [[3 * minute + 5_000, 2, 3, 4, 2]])], { from: 0, to: 4 * minute, tier: "1m", bucketMs: minute, sampledAt: 3 * minute + 40_000 }), 4 * minute);
  assert.equal(appended(h, { at: 3 * minute + 40_000, values: { load1: 4 }, labels: {} }), false, "the bucket's newest sample, carried by a poll after the fetch");
  assert.deepEqual(h.series.get("load1")!.n, [2]);
  assert.equal(missed(h, { at: 3 * minute + 40_000 + catchUpMs, values: {}, labels: {} }), false);
  assert.equal(missed(h, { at: 3 * minute + 40_001 + catchUpMs, values: {}, labels: {} }), true, "a hidden tab or failed polls may have missed samples another reader recorded");
});

test("load per CPU meets the CPUs by bucket, so a bucket whose first read had no load still has a point, served or appended", () => {
  const two = 2 * minute;
  const h = historyOf(metrics([
    served("cpus", "CPUs", [[0, 8, 8, 8, 2]]),
    served("load1", "1-minute load", [[minute, 4, 4, 4, 1]]),
  ], { from: 0, to: two, tier: "1m", bucketMs: two, sampledAt: minute }), 24 * hour);
  assert.deepEqual(linesOf("load-per-cpu", h).find((l) => l.id === "load1")!.points.avg, [0.5], "the load came a minute after the bucket's first CPU count");
  appended(h, { at: two + 10_000, values: { cpus: 8 }, labels: {} });
  appended(h, { at: two + 70_000, values: { cpus: 8, load1: 2 }, labels: {} });
  assert.deepEqual(linesOf("load-per-cpu", h).find((l) => l.id === "load1")!.points.avg, [0.5, 0.25], "live, the load arrives within a bucket the CPUs began");
});
