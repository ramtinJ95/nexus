/**
 * Token usage: what every agent Nexus runs spent, one record per model call, kept in the registry so the totals
 * outlive the pylon and the thread. Each record is keyed by an ID the agent's own record gives the call, so reading a
 * transcript again, a restart, or two readers that see the same call never count it twice.
 */
import type { ProjectId } from "../project.ts";
import { tailnetNodeIdSchema, type NodeName } from "../protocol.ts";
import { checkCaller, verifyCaller } from "./gate.ts";
import { HttpError } from "./http-error.ts";
import type { Registry, Thread, ThreadId } from "./registry.ts";
import { reviewerCaller } from "./review.ts";

export type AgentKind = "claude" | "pi";
export type ThreadRole = "builder" | "reviewer" | "check" | "verify" | "other";

/** A reviewer, check or verify thread is one the review loop started, and a builder one a person started from a tailnet node. */
export function roleOf(startedBy: string): ThreadRole {
  if (startedBy === reviewerCaller) return "reviewer";
  if (startedBy === checkCaller) return "check";
  if (startedBy === verifyCaller) return "verify";
  return tailnetNodeIdSchema.safeParse(startedBy).success ? "builder" : "other";
}

/** Whether the review loop started `t`, including a reviewer a later review of the same builder replaced. */
export const startedByNexus = (registry: Pick<Registry, "isReviewer">, t: Pick<Thread, "id" | "startedBy">): boolean => {
  const role = roleOf(t.startedBy);
  return role === "reviewer" || role === "check" || role === "verify" || registry.isReviewer(t.id);
};

export interface Tokens { input: number; output: number; cacheWrite: number; cacheRead: number }

/**
 * One model call as an agent recorded it. `id` names the call wherever it is read from: `claude:<message ID>` for
 * Claude Code, `pi:<response ID>` for pi, or `pi:<entry>@<entry's time>` for a pi entry without one, and
 * `harness:<conversation>/<entry>` for the Nexus agent.
 */
export interface AgentCall extends Tokens { id: string; agent: AgentKind; model: string; at: number }


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

/** The periods the dashboard offers. Days are UTC days. */
export const periods = { today: "Today", "7d": "7 days", "30d": "30 days", all: "All" } as const;
export type Period = keyof typeof periods;

/** The start of `period`'s first UTC day, or null for all: `today` starts at UTC midnight, and `7d` six days before it. */
export function periodStart(period: Period, now: number): number | null {
  if (period === "all") return null;
  const days = period === "today" ? 1 : Number.parseInt(period, 10);
  return now - (now % 86_400_000) - (days - 1) * 86_400_000;
}

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

/**
 * The filter of `GET /v1/usage`: `since` is a period (today, 7d, 30d or all) or the UTC day to start at, such as
 * 2026-10-01; `project` and `thread` narrow it; each `by`, comma-separated or repeated, adds a breakdown, and none adds
 * every one.
 */
export function usageFilter(query: URLSearchParams, now: number): { since: number | null; project: ProjectId | null; thread: ThreadId | null; by: Breakdown[] } {
  const since = query.get("since") ?? "all";
  const by = query.getAll("by").flatMap((b) => b.split(",")).filter((b) => b !== "");
  const unknown = by.find((b) => !(breakdowns as readonly string[]).includes(b));
  if (unknown !== undefined) throw new HttpError(400, `by must be one of ${breakdowns.join(", ")}, not ${JSON.stringify(unknown)}`);
  return {
    since: sinceOf(since, now),
    project: query.get("project") as ProjectId | null,
    thread: query.get("thread") as ThreadId | null,
    by: by.length === 0 ? [...breakdowns] : [...new Set(by)] as Breakdown[],
  };
}

function sinceOf(value: string, now: number): number | null {
  if (Object.hasOwn(periods, value)) return periodStart(value as Period, now);
  const at = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) throw new HttpError(400, `since must be today, 7d, 30d, all or a date such as 2026-10-01, not ${JSON.stringify(value)}`);
  return at;
}
