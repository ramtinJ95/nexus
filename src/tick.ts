/**
 * The smallest reconcile tick: one pylon, its registry state in memory, one probe. It reads the job in
 * flight and a fresh snapshot, asks planPylon for the next step, and submits it. SQLite, the observe
 * subscription and several nodes come later.
 */
import { envelope, planPylon, type DesiredPhase, type PlanInput, type PlanStep } from "./reconcile.ts";
import type { JobEnvelope, JobStatus, NodeObservation, ProbeClient, ProbeError } from "./protocol.ts";
import type { CheckpointId } from "./images.ts";

export interface PylonRecord {
  thread: string;
  pylonId: PlanInput["pylonId"];
  node: PlanInput["node"];
  desired: DesiredPhase;
  boot: PlanInput["boot"];
  firstBoot: PlanInput["firstBoot"];
  live: PlanInput["live"];
  liveHash: PlanInput["liveHash"];
  /** Completed pauses. The next checkpoint is numbered after them. */
  pauses: number;
  submitted: JobEnvelope | null;
  attempts: PlanInput["attempts"];
  /** Set when the planner gives up. Only a human clears it. */
  failed: string | null;
}

export function newPylonRecord(fields: Omit<PylonRecord, "pauses" | "submitted" | "attempts" | "failed">): PylonRecord {
  return { ...fields, pauses: 0, submitted: null, attempts: { count: 0, lastFailedAt: null, lastCode: null }, failed: null };
}

export const nextCheckpoint = (pylon: PylonRecord): CheckpointId => `ckpt-${pylon.thread}-${pylon.pauses + 1}`;

export async function tick(pylon: PylonRecord, probe: ProbeClient): Promise<PlanStep> {
  // Delete still reaches the planner, whose rule 3 ignores failures.
  if (pylon.failed !== null && pylon.desired !== "deleted") return { kind: "fail", reason: pylon.failed };

  let inFlight: JobStatus | null = null;
  let observation: NodeObservation | null = null;
  try {
    // The job first, so a job that just finished is seen together with the state it left.
    if (pylon.submitted !== null) inFlight = await settle(pylon, probe);
    observation = await snapshot(probe);
  } catch (err) {
    if ((err as ProbeError).code !== "unreachable") throw err;
  }

  const step = planPylon({
    pylonId: pylon.pylonId,
    node: pylon.node,
    nodeOnline: observation !== null,
    desired: pylon.desired,
    boot: pylon.boot,
    firstBoot: pylon.firstBoot,
    live: pylon.live,
    liveHash: pylon.liveHash,
    nextCheckpoint: nextCheckpoint(pylon),
    observed: observation?.pylons.find((p) => p.pylonId === pylon.pylonId) ?? "absent",
    nodeArtifacts: new Set(observation?.artifacts ?? []),
    inFlight,
    attempts: pylon.attempts,
    // One node, so nothing can be fetched from a peer.
    holders: () => [],
    artifactSha256: (id) => { throw new Error(`no node holds ${id}, so it has no recorded sha256`); },
  }, Date.now());

  if (step.kind === "fail") pylon.failed = step.reason;
  if (step.kind !== "submit") return step;

  const env = envelope(step.job, pylon.node, Date.now());
  const reply = await probe.submit(env);
  if ("accepted" in reply) pylon.submitted = env;
  else if (reply.rejected === "invalid") pylon.attempts = failedAttempt(pylon, "invalid");
  // busy and expired wait for the next tick.
  return step;
}

/** Folds the submitted job's outcome into the record. Returns its status while it still runs. */
async function settle(pylon: PylonRecord, probe: ProbeClient): Promise<JobStatus | null> {
  const status = await probe.job(pylon.submitted!.jobId);
  if (status !== "unknown" && status.state === "running") return status;
  pylon.submitted = null;
  // "unknown": the probe restarted and lost the job. The job did not fail, so no attempt is counted.
  if (status === "unknown") return null;
  if (status.state === "failed") {
    pylon.attempts = failedAttempt(pylon, status.code);
    return null;
  }
  pylon.attempts = { count: 0, lastFailedAt: null, lastCode: null };
  if (status.kind === "pause") pylon.pauses += 1;
  return null;
}

function failedAttempt(pylon: PylonRecord, code: NonNullable<PylonRecord["attempts"]["lastCode"]>): PylonRecord["attempts"] {
  return { count: pylon.attempts.count + 1, lastFailedAt: Date.now(), lastCode: code };
}

/** The first event of a new observe stream is always a snapshot. */
async function snapshot(probe: ProbeClient): Promise<NodeObservation> {
  const abort = new AbortController();
  try {
    for await (const event of probe.observe(abort.signal)) {
      if (event.type !== "snapshot") throw new Error(`observe began with a ${event.type} event, not a snapshot`);
      return event.observation;
    }
  } finally {
    abort.abort();
  }
  throw Object.assign(new Error(`${probe.node}: observe ended before its snapshot`), { code: "unreachable" });
}
