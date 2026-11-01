/** What `nexus doctor` and the health alerts say: one verdict per check, grouped by node and the control plane. */
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
/**
 * A check's status changed, as two passes in a row confirmed it: `from` is what it was, and `text` what the pass that
 * set `status` found. `seenAt` is when the person saw the problem on the Health page, null for one not seen yet.
 */
export type HealthChange = Check & { id: number; at: string; from: Status; seenAt: string | null };

/** The health as `GET /v1/checks` serves it. */
export interface HealthView {
  /** When the latest pass ran, or null before this control plane's first. */
  at: string | null;
  /** That pass's checks, the control plane's first and then each node's. */
  checks: readonly Check[];
  /** For each check whose confirmed status is warn or fail, the change that made it so, oldest first. */
  problems: readonly HealthChange[];
  /** How many of those the person has not seen. */
  unseen: number;
}

export const worst = (checks: readonly Pick<Check, "status">[]): Status =>
  statuses[Math.max(0, ...checks.map((c) => statuses.indexOf(c.status)))]!;

/** Which check a verdict is, across passes. */
export const checkKey = (c: Pick<Check, "node" | "name">): string => JSON.stringify([c.node, c.name]);

/** The health from the latest pass, or null before the first, and each check's latest change. */
export function healthView(latest: DoctorReport | null, states: readonly HealthChange[]): HealthView {
  const problems = states.filter((c) => c.status !== "ok");
  return { at: latest?.at ?? null, checks: latest?.checks ?? [], problems, unseen: problems.filter((c) => c.seenAt === null).length };
}
