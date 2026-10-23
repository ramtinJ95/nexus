/**
 * One reconcile tick for one pylon. It settles the job in flight, asks planPylon for the next step against
 * the node's latest observation, and submits it. The caller owns where the record lives: the control
 * plane's loop saves it to the registry, and the slice test keeps it in memory.
 */
import { envelope, planPylon, type DesiredPhase, type FailedAttempt, type PlanInput, type PlanStep } from "./reconcile.ts";
import type { JobEnvelope, JobStatus, NodeObservation, ProbeClient, ProbeError } from "./protocol.ts";
import type { CheckpointId } from "./images.ts";

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
  /** Saved before it is sent, so a control plane that restarts mid-submit still asks the probe about it. */
  submitted: JobEnvelope | null;
  attempts: PlanInput["attempts"];
  /** Set when the planner gives up. Only a human clears it. */
  failed: string | null;
}

export function newPylonRecord(fields: Omit<PylonRecord, "pauses" | "submitted" | "attempts" | "failed">): PylonRecord {
  return { ...fields, pauses: 0, submitted: null, attempts: { count: 0, last: null }, failed: null };
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
  // Delete still reaches the planner, whose rule 3 ignores failures.
  if (pylon.failed !== null && pylon.desired !== "deleted") return { kind: "fail", reason: pylon.failed };

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
    nodeArtifacts: new Set(observation?.artifacts ?? []),
    inFlight,
    attempts: pylon.attempts,
    holders: ctx.holders,
    artifactSha256: ctx.artifactSha256,
  }, Date.now());

  if (step.kind === "fail") {
    pylon.failed = step.reason;
    ctx.save(pylon);
  }
  if (step.kind !== "submit") return step;

  const env = envelope(step.job, pylon.node, Date.now());
  pylon.submitted = env;
  ctx.save(pylon);
  // A throw leaves the envelope recorded. The next tick asks the probe about it.
  const reply = await probe.submit(env);
  if ("accepted" in reply) return step;
  pylon.submitted = null;
  if (reply.rejected === "invalid") pylon.attempts = failedAttempt(pylon, "invalid", failureMessage(reply.message, ""));
  // busy and expired wait for the next tick.
  ctx.save(pylon);
  return step;
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
  // Only a lookup that began after notAfter proves the envelope can no longer be accepted.
  const askedAt = Date.now();
  const status = listed ?? await probe.job(env.jobId);
  if (status === "unknown") {
    if (askedAt <= Date.parse(env.notAfter)) return "wait";
    // Never accepted, or lost in a probe restart. Either way it did not fail, so no attempt is counted.
    pylon.submitted = null;
    return null;
  }
  if (status.state === "running") return status;
  if (listed === undefined) return "wait";
  pylon.submitted = null;
  if (status.state === "failed") {
    pylon.attempts = failedAttempt(pylon, status.code, failureMessage(status.message, status.logTail));
    return null;
  }
  pylon.attempts = { count: 0, last: null };
  if (status.kind === "pause") pylon.pauses += 1;
  return null;
}

function failedAttempt(pylon: PylonRecord, code: FailedAttempt["code"], message: string): PylonRecord["attempts"] {
  return { count: pylon.attempts.count + 1, last: { at: Date.now(), code, message } };
}

const maxMessageChars = 500;
const maxLogLines = 20;
const maxLogChars = 1_500;

/**
 * A failed job's message and the last lines of its log, trimmed and bounded. The record carries it into
 * the planner's reason, so the API, the dashboard and the loop's log say why without the probe's logs.
 */
function failureMessage(message: string, logTail: string): string {
  const log = logTail.trim().split("\n").slice(-maxLogLines).join("\n").slice(-maxLogChars);
  return [message.trim().slice(0, maxMessageChars), log].filter((part) => part !== "").join("\n");
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
