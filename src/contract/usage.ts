/**
 * The usage report as the API answers it, and how a client prints its numbers: the token columns, each breakdown's
 * heading, a time and a token count. The dashboard and the CLI both print it so. It imports nothing at run time.
 */
import type { Tokens } from "../control/agent-usage.ts";
import type { NodeName, ProjectId, ThreadId } from "../ids.ts";

export interface UsageTotals extends Tokens { total: number; calls: number }
export const breakdowns = ["model", "project", "kind", "role", "day"] as const;
export type Breakdown = typeof breakdowns[number];
/** `key` is the model, project, agent kind, thread role, or UTC day as YYYY-MM-DD. */
export type UsageRow = UsageTotals & { key: string };

/** What `GET /v1/usage` answers. Rows are biggest first, except days, which are newest first. */
export interface UsageReport {
  /** The start of the period in Unix milliseconds, or null for all of it. */
  since: number | null;
  /**
   * When this registry started counting. Calls before it are those read from the transcripts still readable then:
   * running pylons' at once, and archived threads' once the backfill reads them.
   */
  countingSince: number;
  project: ProjectId | null;
  thread: ThreadId | null;
  total: UsageTotals;
  by: Partial<Record<Breakdown, UsageRow[]>>;
  backfill: UsageBackfill;
}

/**
 * A thread a run of the usage backfill listed. `calls` and `tokens` are what reading it recovered: the calls no read had
 * counted, and the tokens they added. `reason` says why a skipped one was not read, and `at` when it was done or skipped.
 */
export interface BackfillThread { thread: ThreadId; title: string; state: "pending" | "done" | "skipped"; reason: string | null; calls: number; tokens: number; at: number | null }

/**
 * The usage backfill, which wakes archived threads' pylons one at a time to read their transcripts from the start.
 * `current` is the pylon a run holds: woken to be read, or read or given up on and waiting for its pause. `read` counts
 * the threads done or skipped of `of`, every thread a run listed, and `recovered` sums what the done ones recovered.
 */
export type UsageBackfill =
  | { state: "never" }
  | {
    state: "running" | "stopped" | "done"; startedAt: number; finishedAt: number | null;
    current: { thread: ThreadId; phase: "reading" | "pausing"; since: number } | null;
    /** Why the run waits before the next pylon, such as no room on its node. Null when it does not wait. */
    waiting: string | null;
    read: number; of: number; recovered: { calls: number; tokens: number }; skipped: BackfillThread[];
  };

/** An archived thread a start of the backfill would read, with why a run before skipped it, if one did. */
export interface BackfillPlanRow { thread: ThreadId; project: ProjectId; node: NodeName; title: string; reason: string | null }

/** The token columns of a usage table, with the short name a thread's one-line total gives each. */
export const tokenColumns = [
  { label: "Input", short: "in", field: "input" },
  { label: "Output", short: "out", field: "output" },
  { label: "Cache write", short: "cache write", field: "cacheWrite" },
  { label: "Cache read", short: "cache read", field: "cacheRead" },
  { label: "Total", short: "total", field: "total" },
] as const;
/** Each breakdown's heading, and the name of its key column. */
export const breakdownLook: Readonly<Record<Breakdown, { title: string; key: string }>> = {
  model: { title: "By model", key: "Model" },
  project: { title: "By project", key: "Project" },
  kind: { title: "By agent", key: "Agent" },
  role: { title: "By role", key: "Role" },
  day: { title: "By day (UTC)", key: "Day" },
};

/** A time to the minute, such as 2026-10-27 12:00 UTC. */
export const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** 950, 12.3k, 1.2M, 3.4B. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  for (const [unit, size] of [["B", 1e9], ["M", 1e6], ["k", 1e3]] as const) {
    if (n >= size * 0.9995) {
      const scaled = n / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${unit}`;
    }
  }
  return String(n);
}
