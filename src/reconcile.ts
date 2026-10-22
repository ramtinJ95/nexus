/**
 * The control plane's lifecycle policy, as pure functions. The shell around it (the registry, the tick
 * loop, the probe clients) only feeds facts in and sends the returned job out.
 *
 * Single sources of truth:
 * - The desired phase is derived from the thread and its activity on every tick. It is never stored, so
 *   nothing can forget to update it. A wake is just new activity.
 * - The actual state shown in the dashboard is derived from the last observation and the job in flight.
 * - Drift between a running pylon and its LiveSpec is detected by hash, not by a generation counter.
 * - The planner runs only for pylons in the registry. A pylon a node reports that the registry does not
 *   know is an orphan. The dashboard lists it, and only a human deletes it.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { retryable } from "./protocol.ts";
import type { Job, JobEnvelope, JobErrorCode, JobId, JobStatus, LiveHash, NodeName, ProbeEvent, PylonId, PylonObservation, RunningFacts, SessionFact } from "./protocol.ts";
import type { BootInputs, LiveSpec, PylonSource } from "./project.ts";
import type { ArtifactId, CheckpointId } from "./images.ts";

export type ThreadStatus = "active" | "idle" | "archived" | "deleted";
export type DesiredPhase = "running" | "paused" | "deleted";

export interface ActivityFacts {
  status: ThreadStatus;
  agentTurnRunning: boolean; // the pi-durable turn for this thread, known locally
  lastAgentActivityAt: number; // pi-durable turns, and any observed session in `working`
  lastHumanActivityAt: number; // messages, attached terminals, preview hits, dashboard opens
}

/** Amp's numbers. */
export const idlePolicy = { agentIdleMs: 5 * 60_000, humanIdleMs: 20 * 60_000 } as const;

export function desiredPhase(a: ActivityFacts, now: number): DesiredPhase {
  if (a.status === "deleted") return "deleted";
  if (a.status === "archived") return "paused";
  // A preview hit on a paused pylon updates lastHumanActivityAt, which is what wakes it.
  const busy = a.agentTurnRunning
    || now - a.lastAgentActivityAt < idlePolicy.agentIdleMs
    || now - a.lastHumanActivityAt < idlePolicy.humanIdleMs;
  return busy ? "running" : "paused";
}

export interface PlanInput {
  pylonId: PylonId;
  node: NodeName;
  nodeOnline: boolean;
  desired: DesiredPhase;
  /** Everything a boot needs except its source, which the planner picks from the observation. */
  boot: Omit<BootInputs, "source">;
  firstBoot: Extract<PylonSource, { kind: "template" | "fresh" }>;
  live: LiveSpec;
  liveHash: LiveHash;
  nextCheckpoint: CheckpointId; // minted by the registry, used only if this step is a pause
  observed: PylonObservation | "absent";
  nodeArtifacts: ReadonlySet<ArtifactId>;
  inFlight: JobStatus | null; // for this pylon, or for an artifact this pylon is waiting on
  attempts: { count: number; lastFailedAt: number | null; lastCode: JobErrorCode | null };
  /** Online nodes other than `node` that hold the artifact. */
  holders(artifact: ArtifactId): readonly NodeName[];
  /** The registry's recorded archive hash, which fetch-artifact verifies the copy against. */
  artifactSha256(artifact: ArtifactId): string;
}

export type PlanStep =
  | { kind: "done" }
  | { kind: "wait"; reason: "node-offline" | "in-flight" | "backoff" | "transitioning" }
  | { kind: "submit"; job: Job }
  | { kind: "fail"; reason: string }; // the registry marks the pylon failed until a human retries

export const maxAttempts = 5;
const backoffScheduleMs = [5_000, 15_000, 45_000, 120_000, 120_000] as const;
/** Wait after the `attempt`th consecutive failure, counting from 1. */
export function backoffMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  return backoffScheduleMs[Math.min(attempt, backoffScheduleMs.length) - 1]!;
}

/** A rule returns null when it does not apply. planPylon returns the first step a rule gives, in this order. */
type Rule = (input: PlanInput, now: number) => PlanStep | null;

const done: PlanStep = { kind: "done" };
const wait = (reason: Extract<PlanStep, { kind: "wait" }>["reason"]): PlanStep => ({ kind: "wait", reason });
const submit = (job: Job): PlanStep => ({ kind: "submit", job });
const fail = (reason: string): PlanStep => ({ kind: "fail", reason });

function bootSource(input: PlanInput): PylonSource {
  const o = input.observed;
  return o !== "absent" && o.phase === "stopped" && o.checkpoint !== null ? { kind: "resume", checkpoint: o.checkpoint } : input.firstBoot;
}

const planRules: readonly Rule[] = [
  // 1. Nothing moves to another node on its own, because the disk lives there.
  (i) => i.nodeOnline ? null : wait("node-offline"),
  // 2.
  (i) => i.inFlight?.state === "running" ? wait("in-flight") : null,
  // 3. Delete ignores the attempt budget.
  (i) => i.desired !== "deleted" ? null : i.observed === "absent" ? done : submit({ kind: "delete", pylonId: i.pylonId }),
  // 4.
  ({ attempts: a }) => a.lastCode !== null && !retryable[a.lastCode] ? fail(`last job failed with ${a.lastCode}, which is not retryable`) : null,
  ({ attempts: a }) => a.count >= maxAttempts ? fail(`gave up after ${a.count} failed attempts, the last with ${a.lastCode ?? "no code"}`) : null,
  ({ attempts: a }, now) => a.count > 0 && a.lastFailedAt !== null && now < a.lastFailedAt + backoffMs(a.count) ? wait("backoff") : null,
  // 5.
  ({ observed: o }) => o !== "absent" && (o.phase === "booting" || o.phase === "stopping" || o.phase === "deleting") ? wait("transitioning") : null,
  // 6.
  (i) => {
    if (i.desired !== "paused") return null;
    if (i.observed === "absent" || i.observed.phase === "stopped") return done;
    return submit({ kind: "pause", pylonId: i.pylonId, checkpoint: i.nextCheckpoint });
  },
  // 7a. A broken disk is never booted over or replaced on its own.
  ({ observed: o }) => o !== "absent" && o.phase === "broken" ? fail(`pylon is broken: ${o.detail}`) : null,
  // 7b. Templates are built before planPylon runs. See chooseTemplate in images.ts.
  // A running VM ignores its boot inputs, so it needs no artifacts, even after its template is collected.
  (i) => {
    if (i.observed !== "absent" && i.observed.phase === "running") return null;
    const missing = requiredArtifacts({ ...i.boot, source: bootSource(i) }).find((id) => !i.nodeArtifacts.has(id));
    if (missing === undefined) return null;
    const from = i.holders(missing)[0];
    if (from === undefined) return fail(`artifact-missing: no online node holds ${missing}`);
    return submit({ kind: "fetch-artifact", artifact: missing, from, sha256: i.artifactSha256(missing) });
  },
  // 7c.
  ({ observed: o, liveHash }) => o !== "absent" && o.phase === "running" && o.liveHash === liveHash ? done : null,
  (i) => submit({ kind: "spawn", pylonId: i.pylonId, boot: { ...i.boot, source: bootSource(i) }, live: i.live, liveHash: i.liveHash }),
];

export function planPylon(input: PlanInput, now: number): PlanStep {
  for (const rule of planRules) {
    const step = rule(input, now);
    if (step !== null) return step;
  }
  throw new Error("unreachable: the last plan rule always returns a step");
}

/** The image first, because a template or checkpoint is an overlay on it. */
export function requiredArtifacts(boot: BootInputs): readonly ArtifactId[] {
  return boot.source.kind === "template" ? [boot.image, boot.source.template] : [boot.image];
}

/**
 * `absent` means only that the node does not have the pylon: not created yet, deleted, or lost. Nothing
 * records a deletion, so the thread's status, not this state, says whether the pylon is gone for good.
 */
export type ActualState = "spawning" | "running" | "pausing" | "paused" | "deleting" | "absent" | "failed" | "unknown";

const inFlightState: Partial<Record<Job["kind"], ActualState>> = { spawn: "spawning", pause: "pausing", delete: "deleting" };
const observedState: { readonly [P in PylonObservation["phase"] | "absent"]: ActualState } = {
  booting: "spawning", running: "running", stopping: "pausing", stopped: "paused", deleting: "deleting", absent: "absent",
  broken: "failed", // the backend says the VM was interrupted or failed. The planner pauses or fails it.
};

/** What the data model calls Pylon.actualState, computed rather than stored. */
export function actualState(observed: PylonObservation | "absent", inFlight: JobStatus | null, nodeOnline: boolean, gaveUp: boolean): ActualState {
  // Offline shows the last observation in the dashboard, marked stale.
  if (!nodeOnline) return "unknown";
  if (gaveUp) return "failed";
  const fromJob = inFlight?.state === "running" ? inFlightState[inFlight.kind] : undefined;
  return fromJob ?? observedState[observed === "absent" ? "absent" : observed.phase];
}

export const envelopeTtlMs = 30_000;
export function envelope(job: Job, node: NodeName, now: number): JobEnvelope {
  return {
    jobId: randomUUID() as JobId,
    node,
    issuedAt: new Date(now).toISOString(),
    notAfter: new Date(now + envelopeTtlMs).toISOString(),
    job,
  };
}

/** Record writes derived from one probe event. The control plane is the only writer of every record. */
export type RegistryWrite =
  | { record: "node"; node: NodeName; state: "online" | "offline"; capacity: NodeCapacity }
  | { record: "session"; pylonId: PylonId; herdrPane: string; fact: SessionFact | null } // null: the pane is gone. Adopts panes opened by hand in Herdr
  | { record: "output"; pylonId: PylonId; kind: "branch" | "diff" | "preview" | "file"; ref: string }
  | { record: "activity"; pylonId: PylonId; human: number | null; agent: number | null }
  | { record: "orphan"; node: NodeName; pylonId: PylonId }
  | { record: "job"; status: JobStatus };
type NodeCapacity = { memoryGiB: number; committedMemoryGiB: number; diskFreeGiB: number };

/**
 * `node` is the probe the event came from. `known` maps each registry pylon on that node to the last
 * observation ingested for it, or "absent". Every write is an upsert, so ingesting an event twice is harmless.
 *
 * - A pylon missing from `known` is an orphan, and nothing else is written for it, not even a preview hit.
 * - A snapshot is the whole node, so a known pylon it omits is ingested as "absent".
 * - Sessions and outputs are diffed against the previous observation. A pylon that is not running has no
 *   sessions, so a pause closes them all, and the wake that relaunches them reports their new panes.
 *   Sessions the probe could not read (null) write nothing. loop.ts stores the last list read in their
 *   place, so a null previous list means sessions that were never read, and there is nothing to retract.
 * - Outputs are derived here, not reported by the probe as outputs: a branch with pushedAs is "branch" with
 *   that ref, a dirty tree is "diff" with the head as ref (one per head), a ready preview is "preview" with
 *   the service as ref, and a declared output keeps its kind with its declaration id as ref. Outputs are
 *   never retracted, so only new ones are written.
 * - A working session is agent activity and an attached client is human activity, both at `now`, the time
 *   the control plane received the event. A preview hit is human activity at its own time.
 */
export function ingest(event: ProbeEvent, node: NodeName, known: ReadonlyMap<PylonId, PylonObservation | "absent">, now: number): readonly RegistryWrite[] {
  const observed = (pylon: PylonObservation): RegistryWrite[] => {
    const previous = known.get(pylon.pylonId);
    return previous === undefined ? [{ record: "orphan", node, pylonId: pylon.pylonId }] : pylonWrites(pylon.pylonId, previous, pylon, now);
  };
  switch (event.type) {
    case "snapshot": {
      const o = event.observation;
      if (o.node !== node) throw new Error(`a snapshot from ${node}'s probe names node ${o.node}`);
      const listed = new Set(o.pylons.map((p) => p.pylonId));
      return [
        { record: "node", node, state: "online", capacity: o.capacity },
        ...o.jobs.map((status): RegistryWrite => ({ record: "job", status })),
        ...o.pylons.flatMap(observed),
        ...[...known].filter(([id]) => !listed.has(id)).flatMap(([id, previous]) => pylonWrites(id, previous, "absent", now)),
      ];
    }
    case "pylon": return observed(event.pylon);
    case "job": return [{ record: "job", status: event.status }];
    case "preview-hit": return known.has(event.pylonId)
      ? [{ record: "activity", pylonId: event.pylonId, human: Date.parse(event.at), agent: null }]
      : [{ record: "orphan", node, pylonId: event.pylonId }];
  }
}

type Facts = Pick<RunningFacts, "sessions" | "git" | "previews" | "declaredOutputs" | "attachedClients">;
const notRunning: Facts = { sessions: [], git: null, previews: [], declaredOutputs: [], attachedClients: 0 };
const factsOf = (o: PylonObservation | "absent"): Facts => o !== "absent" && o.phase === "running" ? o : notRunning;

function pylonWrites(pylonId: PylonId, previous: PylonObservation | "absent", current: PylonObservation | "absent", now: number): RegistryWrite[] {
  const before = factsOf(previous);
  const after = factsOf(current);
  const writes: RegistryWrite[] = [];

  if (after.sessions !== null) {
    const panes = new Map((before.sessions ?? []).map((s) => [s.herdrPane, s]));
    for (const fact of after.sessions) {
      if (!isDeepStrictEqual(panes.get(fact.herdrPane), fact)) writes.push({ record: "session", pylonId, herdrPane: fact.herdrPane, fact });
      panes.delete(fact.herdrPane);
    }
    for (const herdrPane of panes.keys()) writes.push({ record: "session", pylonId, herdrPane, fact: null });
  }

  const had = new Set(outputsOf(before).map(({ kind, ref }) => `${kind} ${ref}`));
  for (const { kind, ref } of outputsOf(after)) {
    if (!had.has(`${kind} ${ref}`)) writes.push({ record: "output", pylonId, kind, ref });
  }

  const agent = after.sessions?.some((s) => s.status === "working") ? now : null;
  const human = after.attachedClients > 0 ? now : null;
  if (agent !== null || human !== null) writes.push({ record: "activity", pylonId, human, agent });
  return writes;
}

function outputsOf(f: Facts): { kind: Extract<RegistryWrite, { record: "output" }>["kind"]; ref: string }[] {
  return [
    ...(f.git?.branches ?? []).flatMap((b) => b.pushedAs === null ? [] : [{ kind: "branch" as const, ref: b.pushedAs }]),
    ...(f.git?.dirty ? [{ kind: "diff" as const, ref: f.git.head }] : []),
    ...f.previews.filter((p) => p.ready).map((p) => ({ kind: "preview" as const, ref: p.service })),
    ...f.declaredOutputs.map((d) => ({ kind: d.kind, ref: d.id })),
  ];
}
