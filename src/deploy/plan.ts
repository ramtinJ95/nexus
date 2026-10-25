export type Role = "control" | "probe";
export interface DesiredRelease { commit: string; requestedBy: string; requestedAt: number }
export interface ReleaseHealth { commit: string | null; healthy: boolean }
export interface Attempt {
  commit: string;
  state: "installing" | "healthy" | "rolled-back" | "failed";
  reason: string | null;
}
export interface DeployInput {
  desired: DesiredRelease | null;
  role: Role;
  current: ReleaseHealth;
  control: ReleaseHealth;
  attempt: Attempt | null;
  turnRunning: boolean;
  drainStartedAt: number | null;
  drainTimeoutMs: number;
  now: number;
}
export type DeployStep =
  | { kind: "idle" }
  | { kind: "healthy" }
  | { kind: "recover" }
  | { kind: "wait"; reason: "control-first" | "idle" }
  | { kind: "stop"; reason: string }
  | { kind: "install"; commit: string };

export function planDeploy(input: DeployInput): DeployStep {
  const { desired, attempt, current } = input;
  // Recover a previous link switch even when somebody has requested a different release since.
  if (attempt?.state === "installing") return { kind: "recover" };
  if (desired === null) return { kind: "idle" };
  if (attempt?.commit === desired.commit && (attempt.state === "rolled-back" || attempt.state === "failed")) {
    return { kind: "stop", reason: attempt.reason ?? attempt.state };
  }
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
