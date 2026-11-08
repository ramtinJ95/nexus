import type { ProjectId, ThreadId } from "../ids.ts";
import { breakdowns, type Breakdown } from "../contract/usage.ts";
import { Refusal } from "./refusal.ts";

/** The periods the dashboard offers. Days are UTC days. */
export const periods = { today: "Today", "7d": "7 days", "30d": "30 days", all: "All" } as const;
export type Period = keyof typeof periods;

/** The start of `period`'s first UTC day, or null for all: `today` starts at UTC midnight, and `7d` six days before it. */
export function periodStart(period: Period, now: number): number | null {
  if (period === "all") return null;
  const days = period === "today" ? 1 : Number.parseInt(period, 10);
  return now - (now % 86_400_000) - (days - 1) * 86_400_000;
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
  if (unknown !== undefined) throw new Refusal("invalid", `by must be one of ${breakdowns.join(", ")}, not ${JSON.stringify(unknown)}`);
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
  if (Number.isNaN(at)) throw new Refusal("invalid", `since must be today, 7d, 30d, all or a date such as 2026-10-01, not ${JSON.stringify(value)}`);
  return at;
}
