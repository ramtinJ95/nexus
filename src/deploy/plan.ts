import type { DesiredRelease, ReleaseReport, Role } from "./model.ts";

export interface ReleaseHealth { commit: string | null; healthy: boolean }
/** An outcome the worker recorded at a commit: its journal's transaction, or the target of its last report. */
export interface Attempt {
  commit: string | null;
  state: ReleaseReport["state"];
  reason: string | null;
}
export interface DeployInput {
  desired: DesiredRelease | null;
  role: Role;
  current: ReleaseHealth;
  control: ReleaseHealth;
  attempts: readonly Attempt[];
  turnRunning: boolean;
  drainStartedAt: number | null;
  drainTimeoutMs: number;
  now: number;
}
export type DeployStep =
  | { kind: "idle" }
  | { kind: "healthy" }
  | { kind: "wait"; reason: "control-first" | "idle" }
  | { kind: "stop"; reason: string }
  | { kind: "install"; commit: string };

/** The first attempt that failed or rolled back at the desired commit, which holds that commit back until another is requested. */
export function quarantined(desired: DesiredRelease | null, attempts: readonly Attempt[]): Attempt | null {
  if (desired === null) return null;
  return attempts.find((a) => a.commit === desired.commit && (a.state === "rolled-back" || a.state === "failed")) ?? null;
}

export function planDeploy(input: DeployInput): DeployStep {
  const { desired, current } = input;
  if (desired === null) return { kind: "idle" };
  const held = quarantined(desired, input.attempts);
  if (held !== null) return { kind: "stop", reason: held.reason ?? held.state };
  if (current.commit === desired.commit && current.healthy) return { kind: "healthy" };
  if (input.role === "probe" && (input.control.commit !== desired.commit || !input.control.healthy)) {
    return { kind: "wait", reason: "control-first" };
  }
  if (input.role === "control" && input.turnRunning) {
    if (input.drainStartedAt !== null && input.now - input.drainStartedAt >= input.drainTimeoutMs) {
      return { kind: "stop", reason: "agent turn still running at drain timeout" };
    }
    return { kind: "wait", reason: "idle" };
  }
  return { kind: "install", commit: desired.commit };
}
