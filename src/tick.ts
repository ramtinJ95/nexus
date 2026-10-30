/**
 * One reconcile tick for one pylon. It settles the job in flight, asks planPylon for the next step against
 * the node's latest observation, and submits it. The caller owns where the record lives: the control
 * plane's loop saves it to the registry, and the slice test keeps it in memory.
 */
import { envelope, failureMessage, planPylon, type Attempts, type DesiredPhase, type FailedAttempt, type PlanInput, type PlanStep } from "./reconcile.ts";
import type { CheckpointId, JobId, NodeName } from "./ids.ts";
import type { Job, JobEnvelope, JobStatus } from "./protocol/jobs.ts";
import type { NodeObservation } from "./protocol/observations.ts";
import type { ProbeError } from "./protocol/http.ts";
import type { ProbeClient } from "./protocol/client.ts";

export interface PylonRecord {
  thread: string;
  pylonId: PlanInput["pylonId"];
  node: PlanInput["node"];
  /** Derived from the thread on every tick. The registry never stores it. */
  desired: DesiredPhase;
  boot: PlanInput["boot"];
  firstBoot: PlanInput["firstBoot"];
  live: PlanInput["live"];
  liveHash: PlanInput["liveHash"];
  /** Completed pauses. The next checkpoint is numbered after them. */
  pauses: number;
  /**
   * Saved before it is sent, so a control plane that restarts mid-submit still asks the probe about it. `reading` marks
   * a job the planner sent to wake the pylon for reading, which the envelope the probe gets does not carry.
   */
  submitted: (JobEnvelope & { reading?: true }) | null;
  attempts: PlanInput["attempts"];
  /** Set when the planner gives up. Only a human clears it, through the API's pylon retry. */
  failed: string | null;
  /**
   * Set by the API's pylon retry. Cleared when a job succeeds or the planner finishes or gives up, so one retry
   * settles a broken instance at most once, and a later breakage still waits for a human.
   */
  retrying: PlanInput["retrying"];
}

export function newPylonRecord(fields: Omit<PylonRecord, "pauses" | "submitted" | "attempts" | "failed" | "retrying">): PylonRecord {
  return { ...fields, pauses: 0, submitted: null, attempts: { count: 0, last: null }, failed: null, retrying: false };
}

export const nextCheckpoint = (pylon: PylonRecord): CheckpointId => `ckpt-${pylon.thread}-${pylon.pauses + 1}`;

export interface TickContext {
  probe: ProbeClient;
  /** The node's latest observation, or null while its probe is unreachable. */
  observation: NodeObservation | null;
  holders: PlanInput["holders"];
  artifactSha256: PlanInput["artifactSha256"];
  /** Called after every change to the record, including just before a submit. */
  save(pylon: PylonRecord): void;
}

export async function tick(pylon: PylonRecord, ctx: TickContext): Promise<PlanStep> {
  const attempts = upgradeAttempts(pylon.attempts);
  if (attempts !== pylon.attempts) {
    pylon.attempts = attempts;
    ctx.save(pylon);
  }
  // Delete still reaches the planner, whose rule 3 ignores failures.
  if (pylon.failed !== null && pylon.desired !== "deleted") return { kind: "fail", code: pylon.attempts.last?.code ?? "backend", reason: pylon.failed };

  const { probe } = ctx;
  let { observation } = ctx;
  let inFlight: JobStatus | null = null;
  if (observation !== null && pylon.submitted !== null) {
    try {
      const settled = await settle(pylon, probe, observation);
      if (settled === "wait") return { kind: "wait", reason: "in-flight" };
      if (settled === null) ctx.save(pylon);
      inFlight = settled;
    } catch (err) {
      if ((err as ProbeError).code !== "unreachable") throw err;
      observation = null;
    }
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
    previewsRouted: observation?.previewRoutes.some((r) => r.pylonId === pylon.pylonId) ?? false,
    nodeArtifacts: new Set(observation?.artifacts ?? []),
    nodeSecrets: new Set(observation?.grants.secrets ?? []),
    inFlight,
    attempts: pylon.attempts,
    retrying: pylon.retrying,
    holders: ctx.holders,
    artifactSha256: ctx.artifactSha256,
  }, Date.now());

  if (step.kind === "fail" && pylon.desired === "reading") {
    // A pylon woken only to be read is never failed. The backfill skips its thread with the reason and clears the attempt.
    pylon.attempts = failedAttempt(pylon, step.code, step.reason, true);
    ctx.save(pylon);
    return { kind: "wait", reason: "backoff" };
  }
  if (step.kind === "fail") {
    pylon.failed = step.reason;
    pylon.retrying = false;
    ctx.save(pylon);
  }
  if (step.kind === "done" && pylon.retrying) {
    pylon.retrying = false;
    ctx.save(pylon);
  }
  if (step.kind !== "submit") return step;

  const sent = await submitJob(probe, step.job, pylon.node, (env) => {
    pylon.submitted = pylon.desired === "reading" ? { ...env, reading: true } : env;
    ctx.save(pylon);
  });
  if (sent === "accepted") return step;
  pylon.submitted = null;
  if (sent !== "retry") pylon.attempts = failedAttempt(pylon, "invalid", failureMessage(sent.invalid, ""), pylon.desired === "reading");
  ctx.save(pylon);
  return step;
}

/**
 * Sends the job in a new envelope, which `record` saves first, so a send that throws leaves it recorded and the next
 * pass asks the probe about it. "retry" is a busy or expired refusal, which a later pass sends again.
 */
export async function submitJob(probe: Pick<ProbeClient, "submit">, job: Job, node: NodeName, record: (env: JobEnvelope) => void): Promise<"accepted" | { invalid: string } | "retry"> {
  const env = envelope(job, node, Date.now());
  record(env);
  const reply = await probe.submit(env);
  if ("accepted" in reply) return "accepted";
  return reply.rejected === "invalid" ? { invalid: reply.message } : "retry";
}

/**
 * The status of a sent job: `listed`, the one the node's observation lists, or else the probe's. When the probe does
 * not know the job it is "wait" while the envelope may still be accepted, and "expired" once it never can be: it was
 * never accepted, or was lost in a probe restart.
 */
export async function jobOutcome(probe: Pick<ProbeClient, "job">, jobId: JobId, notAfter: string, listed?: JobStatus): Promise<JobStatus | "wait" | "expired"> {
  // Only a lookup that began after notAfter proves the envelope can no longer be accepted.
  const askedAt = Date.now();
  const status = listed ?? await probe.job(jobId);
  if (status !== "unknown") return status;
  return askedAt > Date.parse(notAfter) ? "expired" : "wait";
}

/**
 * Folds the submitted job's outcome into the record, and returns its status while it still runs. Returns
 * "wait" when nothing may be planned yet:
 * - The job finished after the observation was read. Planning against that observation would send the job
 *   again, so the tick waits for one that lists the result (see NodeObservation.jobs).
 * - The probe does not know the job, but its envelope has not expired. A control plane that died mid-submit
 *   may have a request still on its way, and a new job planned now could land before it.
 */
async function settle(pylon: PylonRecord, probe: ProbeClient, observation: NodeObservation): Promise<JobStatus | "wait" | null> {
  const env = pylon.submitted!;
  const listed = observation.jobs.find((j) => j.jobId === env.jobId);
  const status = await jobOutcome(probe, env.jobId, env.notAfter, listed);
  if (status === "wait") return "wait";
  if (status === "expired") {
    // It did not fail, so no attempt is counted.
    pylon.submitted = null;
    return null;
  }
  if (status.state === "running") return status;
  if (listed === undefined) return "wait";
  pylon.submitted = null;
  if (status.state === "failed") {
    pylon.attempts = failedAttempt(pylon, status.code, failureMessage(status.message, status.logTail), env.reading === true);
    return null;
  }
  pylon.attempts = { count: 0, last: null };
  pylon.retrying = false;
  if (status.kind === "pause") pylon.pauses += 1;
  return null;
}

/** A wake for reading's failure is not one of a normal wake's tries, so it is kept apart from them. */
function failedAttempt(pylon: PylonRecord, code: FailedAttempt["code"], message: string, reading: boolean): Attempts {
  const failure = { at: Date.now(), code, message };
  return reading ? { ...pylon.attempts, readFailure: failure } : { ...pylon.attempts, count: pylon.attempts.count + 1, last: failure };
}

/**
 * A record saved before `readFailure` kept a failed wake for reading in `last`, marked `reading: true`, and the planner
 * read it as no attempts unless desired was `reading`.
 */
function upgradeAttempts(attempts: Attempts): Attempts {
  const last: (FailedAttempt & { reading?: true }) | null = attempts.last;
  if (last?.reading !== true) return attempts;
  const { reading: _, ...readFailure } = last;
  return { count: 0, last: null, readFailure };
}

/** One snapshot from a new observe stream, whose first event is always a snapshot. Null when the probe is unreachable. */
export async function snapshot(probe: ProbeClient): Promise<NodeObservation | null> {
  const abort = new AbortController();
  try {
    for await (const event of probe.observe(abort.signal)) {
      if (event.type !== "snapshot") throw new Error(`observe began with a ${event.type} event, not a snapshot`);
      return event.observation;
    }
  } catch (err) {
    if ((err as ProbeError).code !== "unreachable") throw err;
    return null;
  } finally {
    abort.abort();
  }
  return null;
}
