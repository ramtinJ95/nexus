/** A node's health history: the samples a read records, the tiers that keep them, how a range is served and pruned. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName, PylonId, ThreadId } from "../ids.ts";
import type { NodeHealth } from "../protocol/client.ts";
import { DatabaseSync } from "node:sqlite";
import { maxPoints, minSampleGapMs, recordingHealth, sampleOf, servingOf } from "./node-metrics.ts";
import { drainNodeMetrics, regroupedRangeSql, wholeRangeSql } from "./node-metrics-store.ts";
import { migrations } from "./schema.ts";
import { openRegistry } from "./registry.ts";
import { tempDir } from "../test-kit.ts";
import { testRegistry } from "./test-kit.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/** A whole hour, so the tiers' buckets start on it. */
const now = Date.UTC(2026, 10, 1, 12);

const health: NodeHealth = {
  node: "rj-firebat" as NodeName, readAt: "2026-11-01T12:00:00.000Z", cpus: 16, load: { one: 2.5, five: 1.75, fifteen: 1 },
  memory: { totalGiB: 62.8, availableGiB: 40.2, swapTotalGiB: 8, swapFreeGiB: 6 }, disk: { path: "/var/lib/nexus", totalGiB: 457, freeGiB: 180.3 },
  temperatures: [{ sensor: "Composite", celsius: 41 }, { sensor: "Package id 0", celsius: 55 }, { sensor: "Composite", celsius: 44 }],
  pylons: [{ pylonId: "pylon-th-aaaaaaaaaaaa" as PylonId, processes: 2, cpuPercent: 12.5, residentGiB: 6.2 }, { pylonId: "pylon-gone" as PylonId, processes: 1, cpuPercent: 3, residentGiB: 0.5 }],
};
const threadOf = (p: PylonId) => p === "pylon-th-aaaaaaaaaaaa" ? "th-aaaaaaaaaaaa" as ThreadId : null;

/** Each series' points over the range, by key, as [time, min, avg, max, n]. */
function pointsOf(metrics: { series: { key: string; t: number[]; min: number[]; avg: number[]; max: number[]; n: number[] }[] }) {
  return Object.fromEntries(metrics.series.map((s) => [s.key, s.t.map((t, i) => [t, s.min[i], s.avg[i], s.max[i], s.n[i]])]));
}

test("a health read becomes one value per series it holds, a repeated sensor name numbered and a pylon without a thread keyed by the pylon alone", (t) => {
  const registry = testRegistry(t);
  assert.equal(registry.recordHealthSample("rj-firebat", sampleOf(health, now, threadOf)), true);
  const metrics = registry.nodeMetrics("rj-firebat", now - 15 * minute, now, now);
  assert.equal(metrics.tier, "raw");
  assert.deepEqual(Object.fromEntries(metrics.series.map((s) => [s.key, s.avg])), {
    cpus: [16], diskFree: [180.3], diskTotal: [457], load1: [2.5], load15: [1], load5: [1.75], memAvailable: [40.2], memTotal: [62.8],
    "pylonCpu:pylon-gone:": [3], "pylonCpu:pylon-th-aaaaaaaaaaaa:th-aaaaaaaaaaaa": [12.5],
    "pylonResident:pylon-gone:": [0.5], "pylonResident:pylon-th-aaaaaaaaaaaa:th-aaaaaaaaaaaa": [6.2],
    swapTotal: [8], swapUsed: [2], "temp:Composite": [41], "temp:Composite (2)": [44], "temp:Package id 0": [55],
  });
  assert.deepEqual(metrics.series.find((s) => s.key === "pylonCpu:pylon-gone:")!.series, { kind: "pylonCpu", pylon: "pylon-gone", thread: null });
  assert.deepEqual(metrics.series.map((s) => s.t[0]), metrics.series.map(() => now), "every series is at the time the control plane read it");
});

test("a node whose host reads no load, memory, temperatures or pylons records only CPUs and disk", (t) => {
  const registry = testRegistry(t);
  registry.recordHealthSample("rj-firebat", sampleOf({ ...health, load: null, memory: null, temperatures: null, pylons: null }, now, threadOf));
  assert.deepEqual(pointsOf(registry.nodeMetrics("rj-firebat", now - hour, now, now)), { cpus: [[now, 16, 16, 16, 1]], diskFree: [[now, 180.3, 180.3, 180.3, 1]], diskTotal: [[now, 457, 457, 457, 1]] });
  assert.deepEqual(registry.nodeMetrics("other", now - hour, now, now).series, [], "another node's history is its own");
});

test("a read within 4 s of the node's last recorded one is not recorded, across a reopen of the registry too", async (t) => {
  const path = `${await tempDir("nexus-node-metrics-", t)}/registry.db`;
  const one = (at: number, load: number) => ({ at, values: { load1: load } });
  const first = openRegistry(path);
  assert.equal(first.recordHealthSample("a", one(now, 1)), true);
  assert.equal(first.recordHealthSample("a", one(now + 3_999, 2)), false);
  assert.equal(first.recordHealthSample("b", one(now + 1_000, 3)), true, "each node has its own gap");
  first.close();
  const reopened = testRegistry(t, path);
  assert.equal(reopened.recordHealthSample("a", one(now + 3_000, 4)), false, "the gap holds from the registry's newest sample");
  assert.equal(reopened.recordHealthSample("a", one(now + 4_000, 5)), true);
  assert.deepEqual(pointsOf(reopened.nodeMetrics("a", now - minute, now + 5_000, now + 5_000)).load1, [[now, 1, 1, 1, 1], [now + 4_000, 5, 5, 5, 1]]);
});

test("a bucket holds its samples' min, average and max, and a wider bucket weighs each smaller one by its samples", (t) => {
  const registry = testRegistry(t);
  for (const [at, load] of [[now, 1], [now + 5_000, 2], [now + 10_000, 6], [now + minute, 12]] as const) registry.recordHealthSample("a", { at, values: { load1: load } });
  const at = now + 2 * minute;
  const sixHours = registry.nodeMetrics("a", at - 6 * hour, at, at);
  assert.deepEqual([sixHours.tier, sixHours.bucketMs], ["1m", minute]);
  assert.deepEqual(pointsOf(sixHours).load1, [[now, 1, 3, 6, 3], [now + minute, 12, 12, 12, 1]]);
  const day1 = registry.nodeMetrics("a", at - 24 * hour, at, at);
  assert.deepEqual([day1.tier, day1.bucketMs], ["2m", 2 * minute]);
  assert.deepEqual(pointsOf(day1).load1, [[now, 1, 21 / 4, 12, 4]], "(1 + 2 + 6 + 12) / 4, not the average of 3 and 12");
  assert.deepEqual(pointsOf(registry.nodeMetrics("a", at - 30 * day, at, at)).load1, [[now, 1, 21 / 4, 12, 4]], "the hour tier holds the same");
  const twoHours = registry.nodeMetrics("a", at - 2 * hour, at, at);
  assert.deepEqual([twoHours.tier, twoHours.bucketMs], ["raw", 8_000], "raw samples regrouped in 8-s buckets");
  assert.deepEqual(pointsOf(twoHours).load1, [[now, 1, 1.5, 2, 2], [now + 10_000, 6, 6, 6, 1], [now + minute, 12, 12, 12, 1]]);
});

test("a range is served from the coarsest tier that still holds its start and fits the point limit", () => {
  const tierOf = (span: number, end = now) => servingOf(end - span, end, now).tier.name;
  assert.deepEqual([15 * minute, hour, 6 * hour, 24 * hour, 7 * day, 30 * day].map((span) => tierOf(span)), ["raw", "raw", "1m", "2m", "15m", "1h"]);
  assert.equal(tierOf(15 * minute, now - 3 * hour), "1m", "raw keeps 2 h, so a quarter hour from 3 h ago comes from the minutes");
  assert.equal(tierOf(hour, now - 9 * day), "1h", "past the 15-minute tier's 8 days");
  assert.equal(tierOf(hour, now - 40 * day), "1h", "past every tier's keep, the one that keeps longest");
});

test("each range of the page's picker is one range of the node's rows, read in key order with no sort, and is served at its tier's own step", (t) => {
  const registry = testRegistry(t);
  for (const [span, step] of [[15 * minute, 1_000], [hour, 4_000], [6 * hour, minute], [24 * hour, 2 * minute], [7 * day, 15 * minute], [30 * day, hour]] as const) {
    const { tier, bucketMs } = servingOf(now - span, now, now);
    assert.equal(bucketMs, step);
    assert.ok(tier.stepMs === bucketMs || (tier.stepMs === 0 && bucketMs <= minSampleGapMs), `${span / minute} min regroups nothing`);
  }
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const sql of migrations) db.exec(sql);
  const plan = (sql: string, ...args: (string | number)[]) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail);
  assert.deepEqual(plan(wholeRangeSql, "a", "2m", 0, 1), ["SEARCH node_metrics USING PRIMARY KEY (node=? AND tier=? AND at>? AND at<?)"]);
  assert.deepEqual(plan(regroupedRangeSql, 7_000, "a", "2m", 0, 1), ["SEARCH node_metrics USING PRIMARY KEY (node=? AND tier=? AND at>? AND at<?)", "USE TEMP B-TREE FOR GROUP BY"],
    "a range off the picker still reads only the node's rows");
});

test("no range gives a series more than 1,000 points, even with a sample every 4 s", (t) => {
  const registry = testRegistry(t);
  for (let at = now - 31 * day; at < now - 25 * hour; at += minute) registry.recordHealthSample("a", { at, values: { load1: 1 } });
  for (let at = now - 25 * hour; at <= now; at += 4_000) registry.recordHealthSample("a", { at, values: { load1: 1 } });
  const counts: Record<string, number> = {};
  for (const span of [15 * minute, hour, 2 * hour, 6 * hour, 24 * hour, 25 * hour, 7 * day, 8 * day, 30 * day, 31 * day]) {
    for (const end of [now, now - 7_777]) {
      const m = registry.nodeMetrics("a", end - span, end, now);
      const points = m.series[0]!.t.length;
      assert.ok(points <= maxPoints, `${span / minute} min to ${end}: ${points} points from ${m.tier} in ${m.bucketMs} ms buckets`);
      counts[`${span / minute}`] ??= points;
    }
  }
  assert.deepEqual([counts["60"], counts["1440"]], [901, 721], "an hour of 4-s samples in 4-s buckets, and a day of minutes in 2-min buckets, both ends kept");
});

test("pruning drops what each tier keeps no longer, at most a batch per tier a call", (t) => {
  const registry = testRegistry(t);
  registry.recordHealthSample("a", { at: now, values: { load1: 1 } });
  const kept = [["raw", 2 * hour], ["1m", 7 * hour], ["2m", 25 * hour], ["15m", 8 * day], ["1h", 31 * day]] as const;
  for (const [tier, keep] of kept) {
    assert.equal(registry.pruneNodeMetrics(now + keep, 500), 0, `${tier} keeps a sample exactly its keep old`);
    assert.equal(registry.pruneNodeMetrics(now + keep + 1, 500), 1, `${tier} drops it after`);
  }
  assert.deepEqual(registry.nodeMetrics("a", now - 1, now + 1, now + 32 * day).series, [], "past 31 days nothing is left");

  const old = now - 2 * hour - 1_200 * 4_000;
  for (let i = 0; i < 1_200; i++) registry.recordHealthSample("b", { at: old + i * 4_000, values: { load1: 1 } });
  for (let at = now - hour; at <= now; at += 4 * minute) registry.recordHealthSample("b", { at, values: { load1: 2 } });
  assert.deepEqual([500, 500, 200, 0].map(() => registry.pruneNodeMetrics(now, 500)), [500, 500, 200, 0]);
  assert.deepEqual(pointsOf(registry.nodeMetrics("b", now - 2 * hour, now, now)).load1!.map(([, , avg]) => avg), Array(16).fill(2), "the last hour's raw samples stay");
  assert.equal(registry.nodeMetrics("b", now - 6 * hour, now, now).series[0]!.n.reduce((a, b) => a + b), 1_216, "the minutes still hold the pruned samples");
});

test("the drain prunes until a call deletes nothing, yielding between calls", async () => {
  const deleted = [500, 500, 200, 0];
  const calls: number[] = [];
  const drained = drainNodeMetrics((at, batch) => { calls.push(at, batch); return deleted[calls.length / 2 - 1]!; }, now);
  assert.deepEqual(calls, [now, 500], "the first call runs at once, and the next waits for the event loop");
  let between = 0;
  setImmediate(() => { between = calls.length / 2; });
  await drained;
  assert.equal(calls.length / 2, 4);
  assert.ok(between > 0 && between < 4, `other work ran after call ${between}`);
});

test("the probe client records each health read it makes, nothing for a failed read, and returns health when recording fails", async () => {
  const recorded: NodeHealth[] = [];
  const logged: string[] = [];
  let read: () => Promise<NodeHealth> = async () => health;
  let record = (h: NodeHealth) => { recorded.push(h); };
  const probe = recordingHealth({ health: () => read(), node: "rj-firebat" }, (h) => record(h), (m) => logged.push(m));
  assert.equal(probe.node, "rj-firebat", "the rest of the client is the probe's own");
  assert.equal(await probe.health(), health);
  assert.deepEqual(recorded, [health]);
  read = async () => { throw new Error("rj-firebat: connect ECONNREFUSED"); };
  await assert.rejects(probe.health(), /ECONNREFUSED/);
  assert.equal(recorded.length, 1);
  read = async () => health;
  record = () => { throw new Error("database is locked"); };
  assert.equal(await probe.health(), health);
  assert.deepEqual(logged, ["rj-firebat: recording its health failed: database is locked"]);
});
