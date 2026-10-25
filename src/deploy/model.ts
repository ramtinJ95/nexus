import type { DesiredRelease, Role } from "./plan.ts";

export interface ReleaseReport {
  node: string;
  role: Role;
  commit: string | null;
  target: string | null;
  state: "pending" | "waiting-for-control" | "waiting-for-idle" | "installing" | "healthy" | "rolled-back" | "failed";
  reason: string | null;
  observedAt: number;
}
export interface ReleaseView {
  desired: DesiredRelease | null;
  nodes: ReleaseReport[];
}
export interface Drain { commit: string; expiresAt: number; locked?: boolean }

export function releaseOutcome(view: ReleaseView, commit: string, now = Date.now()): "pending" | "healthy" | "failed" | "superseded" {
  if (view.desired?.commit !== commit) return "superseded";
  if (view.nodes.some((r) => r.target === commit && (r.state === "failed" || r.state === "rolled-back"))) return "failed";
  return view.nodes.length > 0 && view.nodes.every((r) => r.commit === commit && r.state === "healthy" && now - r.observedAt < 90_000) ? "healthy" : "pending";
}
