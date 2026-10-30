/**
 * The wire contract between the deploy worker and the control plane. The bootstrap deployer copies src/deploy/*.ts and
 * runs without node_modules, so this module imports only builtins.
 */
import { createHash } from "node:crypto";

export const fullCommit = /^[0-9a-f]{40}$/;
export const digestPattern = /^[0-9a-f]{64}$/;
export const tsNet = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/;

/** The deploy key a deployer's token gives: what the control plane keeps and compares a reporter's bearer token against. */
export const tokenDigest = (token: string): string => createHash("sha256").update(token).digest("hex");

export type Role = "control" | "probe";
export interface DesiredRelease { commit: string; requestedBy: string; requestedAt: number }

export const reportStates = ["pending", "waiting-for-control", "waiting-for-idle", "installing", "healthy", "rolled-back", "failed"] as const;

export interface ReleaseReport {
  node: string;
  role: Role;
  commit: string | null;
  target: string | null;
  state: (typeof reportStates)[number];
  reason: string | null;
  observedAt: number;
}
/** What the worker posts to /v1/deployer/report. */
export type ReportBody = Omit<ReleaseReport, "node" | "observedAt">;
/** What the control plane answers, which has already turned a stale report into a pending one. */
export interface ReleaseView {
  desired: DesiredRelease | null;
  nodes: ReleaseReport[];
}
export interface Drain { commit: string; expiresAt: number; locked?: boolean }
/** What the control node posts to /v1/deployer/drain. */
export interface DrainBody { commit: string; release?: boolean; hold?: boolean }
/** `expiresAt` is null once a release has cleared the drain. */
export interface DrainReply { idle: boolean; expiresAt: number | null }

export function releaseOutcome(view: ReleaseView, commit: string): "pending" | "healthy" | "failed" | "superseded" {
  if (view.desired?.commit !== commit) return "superseded";
  if (view.nodes.some((r) => r.target === commit && (r.state === "failed" || r.state === "rolled-back"))) return "failed";
  return view.nodes.length > 0 && view.nodes.every((r) => r.commit === commit && r.state === "healthy") ? "healthy" : "pending";
}
