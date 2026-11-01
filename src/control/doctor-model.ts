/** What `nexus doctor` and the daily report say: one verdict per check, grouped by node and the control plane. */
import type { NodeName } from "../ids.ts";

export const statuses = ["ok", "warn", "fail"] as const;
export type Status = (typeof statuses)[number];

export type NodeCheckName = "online" | "release" | "disk" | "pylons";
export type ControlCheckName = "release" | "backup" | "login" | "certificate";

/** `text` is one line: what is wrong and what to do, or what was found when nothing is. */
export interface Verdict { status: Status; text: string }
/** A check of a node, or of the control plane where `node` is null. */
export type Check = Verdict & ({ node: NodeName; name: NodeCheckName } | { node: null; name: ControlCheckName });

export interface DoctorReport {
  at: string;
  /** The worst of the checks' statuses. */
  status: Status;
  checks: readonly Check[];
}
/** A daily report as the registry keeps it. */
export interface StoredReport extends DoctorReport { id: number }
export interface ReportSummary { id: number; at: string; status: Status; counts: Readonly<Record<Status, number>> }

export const worst = (checks: readonly Pick<Check, "status">[]): Status =>
  statuses[Math.max(0, ...checks.map((c) => statuses.indexOf(c.status)))]!;

export function summary(report: StoredReport): ReportSummary {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of report.checks) counts[check.status]++;
  return { id: report.id, at: report.at, status: report.status, counts };
}
