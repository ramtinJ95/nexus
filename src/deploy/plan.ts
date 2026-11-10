import type { DesiredRelease, ReleaseReport, Role } from "../protocol/deploy.ts";

export interface ReleaseHealth { commit: string | null; healthy: boolean }
/** An outcome the worker recorded at a commit: its journal's transaction, or the target of its last report. */
export interface Attempt {
  commit: string | null;
  /** The requestedAt of the desired release it was made for, so a new request for the same commit tries it again. */
  requestedAt: number;
  state: ReleaseReport["state"];
  reason: string | null;
  /** When a failure before the link switch may be tried again, by the node's clock. */
  retryAt?: number;
}
export interface DeployInput {
  desired: DesiredRelease | null;
  role: Role;
  current: ReleaseHealth;
  control: ReleaseHealth;
  attempts: readonly Attempt[];
  turnRunning: boolean;
  /** The node's clock, which `retryAt` is read against. */
  now: number;
}
export type DeployStep =
  | { kind: "idle" }
  | { kind: "healthy" }
  | { kind: "wait"; reason: "control-first" | "idle" }
  | { kind: "stop"; reason: string }
  | { kind: "retry"; attempt: Attempt }
  | { kind: "install"; commit: string };

/** How many tries of one request may fail before the link switch, and the wait after the first, which doubles after each. */
export const prepareTries = 5;
export const retryBaseMs = 60_000;

/** When to try again after the `failed`th failure before the link switch, or null once that quarantines the request. */
export function retryAfter(failed: number, now: number): number | null {
  return failed >= prepareTries ? null : now + retryBaseMs * 2 ** (failed - 1);
}

const forRequest = (desired: DesiredRelease, a: Attempt) => a.commit === desired.commit && a.requestedAt === desired.requestedAt;

/** The first attempt at the desired request that failed or rolled back, which holds it back until the commit is requested again. */
export function quarantined(desired: DesiredRelease | null, attempts: readonly Attempt[]): Attempt | null {
  if (desired === null) return null;
  return attempts.find((a) => forRequest(desired, a) && (a.state === "rolled-back" || a.state === "failed")) ?? null;
}

/** Control runs `commit` and is healthy there, which a probe waits for before it installs `commit`. */
export function controlReady(commit: string, control: ReleaseHealth): boolean {
  return control.commit === commit && control.healthy;
}

export function planDeploy(input: DeployInput): DeployStep {
  const { desired, current } = input;
  if (desired === null) return { kind: "idle" };
  const held = quarantined(desired, input.attempts);
  if (held !== null) return { kind: "stop", reason: held.reason ?? held.state };
  if (current.commit === desired.commit && current.healthy) return { kind: "healthy" };
  const waiting = input.attempts.find((a) => forRequest(desired, a) && a.retryAt !== undefined && a.retryAt > input.now);
  if (waiting !== undefined) return { kind: "retry", attempt: waiting };
  if (input.role === "probe" && !controlReady(desired.commit, input.control)) {
    return { kind: "wait", reason: "control-first" };
  }
  if (input.role === "control" && input.turnRunning) {
    return { kind: "wait", reason: "idle" };
  }
  return { kind: "install", commit: desired.commit };
}

/**
 * The registry's user_version, and how many migrations a release's code applies. Either is null before the control
 * plane has made a registry, or for a release from before src/control/schema.ts.
 */
export interface SchemaVersions { registry: number | null; release: number | null }

/**
 * What a release's control plane does to the registry as db.ts opens it: migrates one behind it, refuses one ahead. A
 * release from before schema.ts kept the same refusal in registry.ts, so one whose count is unknown counts as refusing.
 */
export function schemaStep({ registry, release }: SchemaVersions): "starts" | "migrates" | "refuses" {
  if (registry === null) return "starts";
  if (release === null || registry > release) return "refuses";
  return registry < release ? "migrates" : "starts";
}
