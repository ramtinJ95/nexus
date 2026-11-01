/**
 * The node metrics store: each node's health samples, in `node_metrics`, one row per tier, time, node and series.
 */
import { setImmediate } from "node:timers/promises";
import type { Db } from "./db.ts";
import { minSampleGapMs, seriesOf, servingOf, tiers, type HealthSample, type MetricSeries, type TierName } from "./node-metrics.ts";

/** A node's series over a range, as the store serves them, before the API labels them. */
export interface StoredMetrics { tier: TierName; bucketMs: number; series: Omit<MetricSeries, "label">[] }

export function nodeMetricsStore(db: Db) {
  const { transaction, sql } = db;
  /** Each node's newest recorded sample, read from the registry the first time the node records one. */
  const lastAt = new Map<string, number>();

  return {
    /** Records the sample in every tier, or nothing when it is under `minSampleGapMs` after the node's last. True when it recorded. */
    recordHealthSample(node: string, sample: HealthSample): boolean {
      return transaction(() => {
        const last = lastAt.get(node) ?? sql("SELECT max(at) AS at FROM node_metrics WHERE tier = 'raw' AND node = ?").get(node)!.at as number | null;
        if (last !== null && sample.at - last < minSampleGapMs) return false;
        const add = sql(`INSERT INTO node_metrics (tier, at, node, series, min, sum, max, n) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT DO UPDATE SET min = min(min, excluded.min), sum = sum + excluded.sum, max = max(max, excluded.max), n = n + excluded.n`);
        for (const tier of tiers) {
          const at = tier.stepMs === 0 ? sample.at : Math.floor(sample.at / tier.stepMs) * tier.stepMs;
          for (const [key, value] of Object.entries(sample.values)) add.run(tier.name, at, node, key, value, value, value);
        }
        lastAt.set(node, sample.at);
        return true;
      });
    },
    /** The node's series from `from` to `to`, from the tier `servingOf` names, in buckets of its width. Keys this control plane does not know are left out. */
    nodeMetrics(node: string, from: number, to: number, now: number): StoredMetrics {
      const { tier, bucketMs } = servingOf(from, to, now);
      // node:sqlite binds a number as a REAL, whose division would give every sample a bucket of its own.
      const rows = sql(`SELECT series, min(at) AS t, min(min) AS min, sum(sum) / sum(n) AS avg, max(max) AS max, sum(n) AS n FROM node_metrics
        WHERE tier = ? AND at >= ? AND at <= ? AND node = ? GROUP BY series, at / CAST(? AS INTEGER) ORDER BY series, t`)
        .all(tier.name, Math.floor(from / bucketMs) * bucketMs, to, node, bucketMs) as { series: string; t: number; min: number; avg: number; max: number; n: number }[];
      const series: StoredMetrics["series"] = [];
      for (const row of rows) {
        let s = series.at(-1);
        if (s?.key !== row.series) {
          const known = seriesOf(row.series);
          if (known === null) continue;
          series.push(s = { key: row.series, series: known, t: [], min: [], avg: [], max: [], n: [] });
        }
        s.t.push(row.t);
        s.min.push(row.min);
        s.avg.push(row.avg);
        s.max.push(row.max);
        s.n.push(row.n);
      }
      return { tier: tier.name, bucketMs, series };
    },
    /** Deletes up to `batch` rows of each tier older than the tier keeps, so one call stays short. The rows it deleted. */
    pruneNodeMetrics(now: number, batch: number): number {
      let deleted = 0;
      for (const tier of tiers) {
        deleted += Number(sql(`DELETE FROM node_metrics WHERE (tier, at, node, series) IN
          (SELECT tier, at, node, series FROM node_metrics WHERE tier = ? AND at < ? LIMIT ?)`).run(tier.name, now - tier.keepMs, batch).changes);
      }
      return deleted;
    },
  };
}

/** Prunes in batches until none is left, yielding between them so the API and the loops run in between. */
export async function drainNodeMetrics(prune: (now: number, batch: number) => number, now: number, batch = 500): Promise<void> {
  while (prune(now, batch) > 0) await setImmediate();
}
