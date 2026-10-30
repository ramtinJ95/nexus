/**
 * The usage store: each recorded call, in `usage_records`, their sums per day, in `usage_days`, how far each source
 * was read, in `usage_cursors`, when counting began, in `usage_since`, and the backfill's run and threads, in
 * `usage_backfill` and `usage_backfill_threads`.
 */
import type { Db, Row } from "./db.ts";
import type { ProjectId, ThreadId } from "../ids.ts";
import { roleOf } from "../agent-protocol.ts";
import type { AgentCall } from "../agent-usage.ts";
import type { BackfillThread, Breakdown, UsageBackfill, UsageReport, UsageTotals } from "./usage.ts";

/**
 * How far a source of usage was read: a pylon's transcript, by its path, to a byte offset with the SHA-256 of the up
 * to 4 KiB before it, or a harness conversation to an entry, with no hash.
 */
export interface UsageCursor { source: string; key: string; position: number; before: string }

export type UsageStore = ReturnType<typeof usageStore>;

export function usageStore(db: Db, threadRecord: (id: ThreadId) => Row | undefined) {
  const { transaction, sql } = db;
  /**
   * Each breakdown's grouping, and its order: biggest first, or newest day first. A report over threads reads the
   * calls, and any other the sums per day, which stay few however many calls there are.
   */
  const groupings: Readonly<Record<Breakdown, { key: string; order: string }>> = {
    model: { key: "model", order: "total DESC, key" },
    project: { key: "project", order: "total DESC, key" },
    kind: { key: "agent", order: "total DESC, key" },
    role: { key: "role", order: "total DESC, key" },
    day: { key: "day", order: "key DESC" },
  };
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  const totalsOf = (r: Row): UsageTotals => {
    const [input, output, cacheWrite, cacheRead] = [r.input, r.output, r.cache_write, r.cache_read] as number[];
    return { input: input!, output: output!, cacheWrite: cacheWrite!, cacheRead: cacheRead!, total: input! + output! + cacheWrite! + cacheRead!, calls: r.calls as number };
  };
  function usageBackfillThreads(): BackfillThread[] {
    return sql("SELECT b.*, t.title FROM usage_backfill_threads b JOIN threads t ON t.id = b.thread ORDER BY t.created_at, t.id").all().map((r) => ({
      thread: r.thread as ThreadId, title: r.title as string, state: r.state as BackfillThread["state"], reason: r.reason as string | null,
      calls: r.calls as number, tokens: r.tokens as number, at: r.at as number | null,
    }));
  }

  function usageBackfill(): UsageBackfill {
    const run = sql("SELECT * FROM usage_backfill").get();
    if (run === undefined) return { state: "never" };
    const count = sql("SELECT count(*) AS of, coalesce(sum(state <> 'pending'), 0) AS read, coalesce(sum(calls), 0) AS calls, coalesce(sum(tokens), 0) AS tokens FROM usage_backfill_threads").get()!;
    return {
      state: run.state as "running" | "stopped" | "done", startedAt: run.started_at as number, finishedAt: run.finished_at as number | null,
      current: run.thread === null ? null : { thread: run.thread as ThreadId, phase: run.phase as "reading" | "pausing", since: run.since as number },
      waiting: run.waiting as string | null, read: count.read as number, of: count.of as number,
      recovered: { calls: count.calls as number, tokens: count.tokens as number }, skipped: usageBackfillThreads().filter((t) => t.state === "skipped"),
    };
  }

  function endUsageBackfill(state: "stopped" | "done", now: number) {
    sql("UPDATE usage_backfill SET state = ?, finished_at = ?, thread = NULL, phase = NULL, since = NULL, waiting = NULL WHERE state = 'running'").run(state, now);
  }

  const sums = (calls: string) => `coalesce(sum(input), 0) AS input, coalesce(sum(output), 0) AS output, coalesce(sum(cache_write), 0) AS cache_write,
    coalesce(sum(cache_read), 0) AS cache_read, ${calls} AS calls, coalesce(sum(input + output + cache_write + cache_read), 0) AS total`;

  return {
    /** The thread the usage backfill is reading, for the thread core. */
    readingUsage: () => sql("SELECT thread FROM usage_backfill WHERE state = 'running' AND phase = 'reading'").get()?.thread,
    /**
     * Records each call under the thread it was read from, with the thread's project and role, and moves each cursor
     * to where its read ended. A call recorded before keeps its thread and time, and each count the larger of the two
     * reads, since every record of one call carries the same usage. Returns how many calls were new, and the tokens
     * the recorded counts grew by. `backfill` adds them to the thread's usage backfill row in the same transaction.
     */
    recordUsage(thread: ThreadId, calls: readonly AgentCall[], cursors: readonly UsageCursor[] = [], backfill = false): { calls: number; tokens: number } {
      const t = threadRecord(thread);
      if (t === undefined) throw new Error(`no thread ${thread} to record usage under`);
      const role = roleOf(t.started_by as string);
      const added = { calls: 0, tokens: 0 };
      transaction(() => {
        for (const c of calls) {
          const stored = sql("SELECT * FROM usage_records WHERE id = ?").get(c.id);
          // Another thread's read of a call, as of a session copied into its pylon, changes nothing.
          if (stored !== undefined && stored.thread !== thread) continue;
          const was = stored === undefined ? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } : totalsOf({ ...stored, calls: 1 });
          const now = { input: Math.max(was.input, c.input), output: Math.max(was.output, c.output), cacheWrite: Math.max(was.cacheWrite, c.cacheWrite), cacheRead: Math.max(was.cacheRead, c.cacheRead) };
          const at = (stored?.at as number | undefined) ?? c.at;
          const key = stored === undefined ? [thread, t.project as string, role, c.agent, c.model] : [thread, stored.project, stored.role, stored.agent, stored.model] as string[];
          sql("INSERT OR REPLACE INTO usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(c.id, ...key, at, now.input, now.output, now.cacheWrite, now.cacheRead);
          sql(`INSERT INTO usage_days VALUES ($day, $project, $role, $agent, $model, $input, $output, $cacheWrite, $cacheRead, $calls)
            ON CONFLICT DO UPDATE SET input = input + $input, output = output + $output, cache_write = cache_write + $cacheWrite, cache_read = cache_read + $cacheRead, calls = calls + $calls`).run({
            $day: day(at), $project: key[1]!, $role: key[2]!, $agent: key[3]!, $model: key[4]!, $calls: stored === undefined ? 1 : 0,
            $input: now.input - was.input, $output: now.output - was.output, $cacheWrite: now.cacheWrite - was.cacheWrite, $cacheRead: now.cacheRead - was.cacheRead,
          });
          if (stored === undefined) added.calls++;
          added.tokens += now.input - was.input + now.output - was.output + now.cacheWrite - was.cacheWrite + now.cacheRead - was.cacheRead;
        }
        for (const { source, key, position, before } of cursors) {
          sql("INSERT INTO usage_cursors VALUES (?, ?, ?, ?) ON CONFLICT (source, key) DO UPDATE SET position = excluded.position, before = excluded.before").run(source, key, position, before);
        }
        if (backfill) sql("UPDATE usage_backfill_threads SET calls = calls + ?, tokens = tokens + ? WHERE thread = ?").run(added.calls, added.tokens, thread);
      });
      return added;
    },
    /** Where each of the source's files or conversations was last read to. */
    usageCursor(source: string, key: string): UsageCursor | undefined {
      const r = sql("SELECT * FROM usage_cursors WHERE source = ? AND key = ?").get(source, key);
      return r && { source, key, position: r.position as number, before: r.before as string };
    },
    usageCursors: (source: string): Map<string, UsageCursor> =>
      new Map(sql("SELECT * FROM usage_cursors WHERE source = ?").all(source).map((r) => [r.key as string, { source, key: r.key as string, position: r.position as number, before: r.before as string }])),
    /** `since` is a UTC day's start, or null for all. */
    usageReport(filter: { since: number | null; project?: ProjectId | null; thread?: ThreadId | null; by?: readonly Breakdown[] }): UsageReport {
      const params = { $since: filter.since === null ? null : day(filter.since), $project: filter.project ?? null, $thread: filter.thread ?? null };
      const [from, calls, dayOf] = params.$thread === null ? ["usage_days", "coalesce(sum(calls), 0)", "day"] : ["usage_records", "count(*)", "date(at / 1000, 'unixepoch')"];
      const where = `WHERE ($since IS NULL OR ${dayOf} >= $since) AND ($project IS NULL OR project = $project)${params.$thread === null ? " AND $thread IS NULL" : " AND thread = $thread"}`;
      const by: UsageReport["by"] = {};
      for (const breakdown of filter.by ?? []) {
        const { key, order } = groupings[breakdown];
        by[breakdown] = sql(`SELECT ${key === "day" ? dayOf : key} AS key, ${sums(calls)} FROM ${from} ${where} GROUP BY 1 ORDER BY ${order}`)
          .all(params).map((r) => ({ key: r.key as string, ...totalsOf(r) }));
      }
      return {
        since: filter.since, countingSince: sql("SELECT at FROM usage_since").get()!.at as number, project: params.$project, thread: params.$thread,
        total: totalsOf(sql(`SELECT ${sums(calls)} FROM ${from} ${where}`).get(params)!), by, backfill: usageBackfill(),
      };
    },
    usageBackfill,
    /** Every thread a run of the backfill listed, oldest thread first. */
    usageBackfillThreads,
    /**
     * Starts a run that reads `threads`, unless one runs. Each listed thread with no row gets a pending one, and a
     * skipped one is pending again. A done thread is never read again.
     */
    startUsageBackfill(threads: readonly ThreadId[], now: number): UsageBackfill {
      transaction(() => {
        if (sql("SELECT state FROM usage_backfill").get()?.state === "running") return;
        for (const thread of threads) {
          sql(`INSERT INTO usage_backfill_threads (thread, state, calls, tokens) VALUES (?, 'pending', 0, 0)
            ON CONFLICT (thread) DO UPDATE SET state = 'pending', reason = NULL, at = NULL WHERE state = 'skipped'`).run(thread);
        }
        sql(`INSERT INTO usage_backfill (id, state, started_at) VALUES (1, 'running', ?) ON CONFLICT (id) DO UPDATE SET state = 'running',
          started_at = excluded.started_at, finished_at = NULL, thread = NULL, phase = NULL, since = NULL, waiting = NULL`).run(now);
      });
      return usageBackfill();
    },
    /** A running run stops, and lets go of its pylon, whose desired phase is then paused again. */
    stopUsageBackfill(now: number): UsageBackfill {
      endUsageBackfill("stopped", now);
      return usageBackfill();
    },
    /** A running run has read every thread it listed. */
    finishUsageBackfill(now: number) { endUsageBackfill("done", now); },
    /** Why a running run waits before its next pylon, or null when it does not. */
    waitUsageBackfill(waiting: string | null) {
      sql("UPDATE usage_backfill SET waiting = ? WHERE state = 'running' AND waiting IS NOT ?").run(waiting, waiting);
    },
    /** A running run holds the thread's pylon, which it wants woken to read. */
    holdUsageBackfill(thread: ThreadId, now: number) {
      sql("UPDATE usage_backfill SET thread = ?, phase = 'reading', since = ?, waiting = NULL WHERE state = 'running'").run(thread, now);
    },
    /** The run lets go of the pylon it holds, once it is paused. */
    releaseUsageBackfill() {
      sql("UPDATE usage_backfill SET thread = NULL, phase = NULL, since = NULL").run();
    },
    /**
     * The thread was read, or skipped for `reason`, and keeps what its reads recovered. A run that holds its pylon now
     * waits for its pause.
     */
    finishUsageBackfillThread(thread: ThreadId, state: "done" | "skipped", reason: string | null, now: number) {
      transaction(() => {
        sql("UPDATE usage_backfill_threads SET state = ?, reason = ?, at = ? WHERE thread = ?").run(state, reason, now, thread);
        sql("UPDATE usage_backfill SET phase = 'pausing', since = ? WHERE state = 'running' AND thread = ?").run(now, thread);
      });
    },
  };
}
