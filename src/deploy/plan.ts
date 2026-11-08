import { busyDrainReason, type DesiredRelease, type ReleaseReport, type Role } from "../protocol/deploy.ts";

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
  return attempts.find((a) => a.commit === desired.commit && (a.state === "rolled-back" || a.state === "failed") && !busyDrainReason(a.reason)) ?? null;
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
