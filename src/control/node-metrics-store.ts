/**
 * The node metrics store: each node's health samples, in `node_metrics`, one row per tier, time, node and series.
 */
import { setImmediate } from "node:timers/promises";
import type { Db } from "./db.ts";
import { minSampleGapMs, seriesOf, servingOf, tiers, type HealthSample, type MetricSeries, type TierName } from "./node-metrics.ts";

/** A node's series over a range, as the store serves them, before the API labels them. */
export interface StoredMetrics { tier: TierName; bucketMs: number; sampledAt: number | null; series: Omit<MetricSeries, "label">[] }

type Row = [series: string, t: number, min: number, avg: number, max: number, n: number];

/**
 * A range whose buckets are its tier's own rows, read in key order, the time and then the series, with no sort. A raw
 * bucket no wider than `minSampleGapMs` holds one sample, so it is a tier's own row too.
 */
export const wholeRangeSql = "SELECT series, at, min, sum / n, max, n FROM node_metrics WHERE node = ? AND tier = ? AND at >= ? AND at <= ?";
// node:sqlite binds a number as a REAL, whose division would give every sample a bucket of its own.
export const regroupedRangeSql = `SELECT series, min(at), min(min), sum(sum) / sum(n), max(max), sum(n), at / CAST(? AS INTEGER) AS bucket FROM node_metrics
  WHERE node = ? AND tier = ? AND at >= ? AND at <= ? GROUP BY series, bucket ORDER BY series, bucket`;

export function nodeMetricsStore(db: Db) {
  const { transaction, sql } = db;
  // Rows as arrays, since a range is up to 1,000 points of every series, and an object per row costs more than reading it.
  const whole = db.db.prepare(wholeRangeSql);
  whole.setReturnArrays(true);
  const regrouped = db.db.prepare(regroupedRangeSql);
  regrouped.setReturnArrays(true);
  /** Each node's newest recorded sample, read from the registry the first time the node records one. */
  const lastAt = new Map<string, number>();
  /** Each node's newest sample this process recorded, which the node page carries so its graphs append what the registry holds. */
  const latest = new Map<string, HealthSample>();

  return {
    /** Records the sample in every tier, or nothing when it is under `minSampleGapMs` after the node's last. True when it recorded. */
    recordHealthSample(node: string, sample: HealthSample): boolean {
      return transaction(() => {
        const last = lastAt.get(node) ?? sql("SELECT max(at) AS at FROM node_metrics WHERE node = ? AND tier = 'raw'").get(node)!.at as number | null;
        if (last !== null && sample.at - last < minSampleGapMs) return false;
        const add = sql(`INSERT INTO node_metrics (node, tier, at, series, min, sum, max, n) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT DO UPDATE SET min = min(min, excluded.min), sum = sum + excluded.sum, max = max(max, excluded.max), n = n + excluded.n`);
        for (const tier of tiers) {
          const at = tier.stepMs === 0 ? sample.at : Math.floor(sample.at / tier.stepMs) * tier.stepMs;
          for (const [key, value] of Object.entries(sample.values)) add.run(node, tier.name, at, key, value, value, value);
        }
        lastAt.set(node, sample.at);
        latest.set(node, sample);
        return true;
      });
    },
    latestHealthSample: (node: string): HealthSample | null => latest.get(node) ?? null,
    /** The node's series from `from` to `to`, from the tier `servingOf` names, in buckets of its width. Keys this control plane does not know are left out. */
    nodeMetrics(node: string, from: number, to: number, now: number): StoredMetrics {
      const { tier, bucketMs } = servingOf(from, to, now);
      const range = [node, tier.name, Math.floor(from / bucketMs) * bucketMs, to] as const;
      const own = tier.stepMs === bucketMs || (tier.stepMs === 0 && bucketMs <= minSampleGapMs);
      const rows = (own ? whole.all(...range) : regrouped.all(bucketMs, ...range)) as unknown as Row[];
      const bySeries = new Map<string, StoredMetrics["series"][number] | null>();
      for (const [key, t, min, avg, max, n] of rows) {
        let s = bySeries.get(key);
        if (s === undefined) {
          const known = seriesOf(key);
          bySeries.set(key, s = known === null ? null : { key, series: known, t: [], min: [], avg: [], max: [], n: [] });
        }
        if (s === null) continue;
        s.t.push(t);
        s.min.push(min);
        s.avg.push(avg);
        s.max.push(max);
        s.n.push(n);
      }
      const series = [...bySeries.values()].filter((s) => s !== null).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const sampledAt = sql("SELECT max(at) AS at FROM node_metrics WHERE node = ? AND tier = 'raw' AND at <= ?").get(node, to)!.at as number | null;
      return { tier: tier.name, bucketMs, sampledAt, series };
    },
    /**
     * Deletes up to `batch` rows of each node's tier older than the tier keeps, so one call stays short. Each node is
     * found by a seek past the last, so a node no longer in the registry is pruned too. The rows it deleted.
     */
    pruneNodeMetrics(now: number, batch: number): number {
      let deleted = 0;
      for (let node = sql("SELECT min(node) AS node FROM node_metrics").get()!.node as string | null; node !== null;
        node = sql("SELECT min(node) AS node FROM node_metrics WHERE node > ?").get(node)!.node as string | null) {
        for (const tier of tiers) {
          deleted += Number(sql(`DELETE FROM node_metrics WHERE (node, tier, at, series) IN
            (SELECT node, tier, at, series FROM node_metrics WHERE node = ? AND tier = ? AND at < ? LIMIT ?)`).run(node, tier.name, now - tier.keepMs, batch).changes);
        }
      }
      return deleted;
    },
  };
}

/** Prunes in batches until none is left, yielding between them so the API and the loops run in between. */
export async function drainNodeMetrics(prune: (now: number, batch: number) => number, now: number, batch = 500): Promise<void> {
  while (prune(now, batch) > 0) await setImmediate();
}
