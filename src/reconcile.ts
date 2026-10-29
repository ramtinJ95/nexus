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
import { heldSecrets, retryable } from "./protocol.ts";
import type { HerdrStatus, Job, JobEnvelope, JobErrorCode, JobId, JobStatus, LiveHash, NodeName, NodeObservation, PausedSession, ProbeEvent, PylonId, PylonObservation, RunningFacts, SessionFact } from "./protocol.ts";
import type { BootInputs, LiveSpec, PylonSource } from "./project.ts";
import { harnessNamed, type SessionHarness } from "./sessions.ts";
import type { ArtifactId, CheckpointId } from "./images.ts";

export type ThreadStatus = "active" | "idle" | "archived" | "deleted";
/** `reading` runs an archived thread's pylon for the usage backfill without bringing its sessions back. */
export type DesiredPhase = "running" | "reading" | "paused" | "deleted";

export interface ActivityFacts {
  status: ThreadStatus;
  sessionTurnRunning?: boolean;
  sessionActiveUntil?: number;
  agentTurnRunning: boolean; // the pi-durable turn for this thread, known locally
  lastAgentActivityAt: number; // pi-durable turns, Claude hooks and other observed sessions in `working`
  lastHumanActivityAt: number; // messages, attached terminals, preview hits, dashboard opens
  /** The usage backfill reads this archived thread's pylon now. */
  readingUsage?: boolean;
}

/** Amp's numbers. */
export const idlePolicy = { agentIdleMs: 5 * 60_000, humanIdleMs: 20 * 60_000 } as const;

export function desiredPhase(a: ActivityFacts, now: number): DesiredPhase {
  if (a.status === "deleted") return "deleted";
  if (a.status === "archived") return a.readingUsage === true ? "reading" : "paused";
  // A preview hit on a paused pylon updates lastHumanActivityAt, which is what wakes it.
  const busy = a.agentTurnRunning || (a.sessionActiveUntil ?? 0) > now
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
  /** The node's gateway routes a preview port to the pylon. A paused pylon keeps its routes, and only a delete removes them. */
  previewsRouted: boolean;
  nodeArtifacts: ReadonlySet<ArtifactId>;
  /** The secrets the node holds: those in its secret file, and the held secrets the control plane has handed its probe. */
  nodeSecrets: ReadonlySet<string>;
  inFlight: JobStatus | null; // for this pylon, or for an artifact this pylon is waiting on
  /** Consecutive failed jobs, and the last one's. A success clears both. */
  attempts: { count: number; last: FailedAttempt | null };
  /** A human retried the pylon after the planner gave up, and no job has succeeded nor the planner finished or given up since. */
  retrying: boolean;
  /** Online nodes other than `node` that hold the artifact. */
  holders(artifact: ArtifactId): readonly NodeName[];
  /** The registry's recorded archive hash, which fetch-artifact verifies the copy against. */
  artifactSha256(artifact: ArtifactId): string;
}

/**
 * `message` is the job's message and the end of its log, bounded by failureMessage. `reading` marks a wake
 * for reading that failed, which only the usage backfill acts on, so the planner counts it only while desired is `reading`.
 */
export interface FailedAttempt { at: number; code: JobErrorCode; message: string; reading?: true }

export type PlanStep =
  | { kind: "done" }
  | { kind: "wait"; reason: "node-offline" | "in-flight" | "backoff" | "transitioning" | "held-secret" }
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
  // 3. Delete ignores the attempt budget. A pylon removed by hand is absent but may still have previews published.
  (i) => i.desired !== "deleted" ? null : i.observed === "absent" && !i.previewsRouted ? done : submit({ kind: "delete", pylonId: i.pylonId }),
  // A failed wake for reading is tried once and never fails the pylon. The backfill gives up on it and clears the attempt.
  (i) => i.desired === "reading" && i.attempts.last !== null ? wait("backoff") : null,
  // 4.
  ({ attempts: { last } }) => last !== null && !retryable[last.code] ? fail(`last job failed with ${last.code}, which is not retryable: ${last.message}`) : null,
  ({ attempts: { count, last } }) => last !== null && count >= maxAttempts ? fail(`gave up after ${count} failed attempts, the last with ${last.code}: ${last.message}`) : null,
  ({ attempts: { count, last } }, now) => last !== null && now < last.at + backoffMs(count) ? wait("backoff") : null,
  // 5.
  ({ observed: o }) => o !== "absent" && (o.phase === "booting" || o.phase === "stopping" || o.phase === "deleting") ? wait("transitioning") : null,
  // 6. A broken pylon that retryRefusal refuses is never paused either, because the pause could save what broke it.
  (i) => {
    if (i.desired !== "paused") return null;
    if (i.observed === "absent" || i.observed.phase === "stopped") return done;
    const refused = retryRefusal(i.observed);
    if (i.observed.phase === "broken" && refused !== null) return brokenFailure(i.observed, refused);
    return submit({ kind: "pause", pylonId: i.pylonId, checkpoint: i.nextCheckpoint });
  },
  // 7a. A broken disk is never booted over or replaced on its own. After a human retry it is paused as 6 pauses an idle
  // one: the pause settles it on its newest disk and discards the broken VM, and the next spawn resumes that disk. A VM
  // whose setup failed on this boot is removed by the pause, as it has no checkpoint, so the next spawn boots fresh.
  (i) => {
    if (i.observed === "absent" || i.observed.phase !== "broken") return null;
    const refused = retryRefusal(i.observed);
    if (!i.retrying || refused !== null) return brokenFailure(i.observed, refused);
    return submit({ kind: "pause", pylonId: i.pylonId, checkpoint: i.nextCheckpoint });
  },
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
  // 7c. A pylon woken for reading needs nothing of `live`, and its probe reports no liveHash for a spawn that did not
  // bring the sessions back, so the spawn once its thread runs again brings them back.
  ({ observed: o, liveHash, desired }) => o !== "absent" && o.phase === "running" && (o.liveHash === liveHash || desired === "reading") ? done : null,
  // 7d. A probe older than a held secret fails the spawn for good, as in a deploy that upgrades the control plane first,
  // and one that has not been handed it yet, as after a restart, would boot a pylon whose first requests are refused.
  (i) => i.boot.network.secrets.some((s) => heldSecrets.includes(s.name) && !i.nodeSecrets.has(s.name)) ? wait("held-secret") : null,
  (i) => submit({ kind: "spawn", pylonId: i.pylonId, boot: { ...i.boot, source: bootSource(i) }, live: i.live, liveHash: i.liveHash, ...(i.desired === "reading" ? { relaunch: false } : {}) }),
];

/**
 * Why a human retry of a pylon observed this way cannot help, or null when it can. A disk that holds a failed setup
 * would fail its resume the same way, and a cause this control plane does not know gives it nothing to decide on.
 */
export function retryRefusal(observed: PylonObservation | "absent"): string | null {
  if (observed === "absent" || observed.phase !== "broken") return null;
  switch (observed.cause) {
    case "saved-setup": return "Its disk holds the failed setup, and every boot of that disk fails the same way, so a retry cannot help. Start again from the project";
    case "unknown": return "The node did not say why the pylon broke in a way this control plane understands. Upgrade Nexus on the node and the control plane, or start again from the project";
    default: return null;
  }
}

const brokenFailure = (observed: Extract<PylonObservation, { phase: "broken" }>, refused: string | null): PlanStep =>
  fail(failureMessage(`pylon is broken: ${observed.detail}${refused === null ? "" : `. ${refused}`}`, observed.logTail));

const maxMessageChars = 500;
const maxLogLines = 60;
const maxLogChars = 8_192;

/**
 * A failure's message and the last lines of its log, trimmed and bounded as the node reads a controller log. The record
 * carries it into the planner's reason, so the API, the dashboard and the loop's log say why without the node's logs.
 */
export function failureMessage(message: string, logTail: string): string {
  const log = logTail.trim().split("\n").slice(-maxLogLines).join("\n").slice(-maxLogChars);
  return [message.trim().slice(0, maxMessageChars), log].filter((part) => part !== "").join("\n");
}

const noAttempts: PlanInput["attempts"] = { count: 0, last: null };

export function planPylon(input: PlanInput, now: number): PlanStep {
  // A wake for reading can fail after the backfill let go of the pylon, as when it stopped or gave up waiting.
  const i = input.desired !== "reading" && input.attempts.last?.reading === true ? { ...input, attempts: noAttempts } : input;
  for (const rule of planRules) {
    const step = rule(i, now);
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
  | { record: "node"; node: NodeName; state: "online" | "offline"; capacity: NodeObservation["capacity"] }
  /** The pylon's whole list: a session it does not list is gone. Adopts panes opened by hand in Herdr. */
  | { record: "sessions"; pylonId: PylonId; sessions: readonly SessionRow[] }
  /** The pylon paused without saying what its wake brings back, so every session it had is paused. */
  | { record: "sessions-paused"; pylonId: PylonId }
  /**
   * The pylon runs again, but its sessions are not read yet. Each paused one runs in the pane it had, with its status
   * unknown, and one that had no pane, which its last wake failed to bring back, is failed until a read says otherwise.
   */
  | { record: "sessions-resumed"; pylonId: PylonId }
  | { record: "output"; pylonId: PylonId; kind: "branch" | "diff" | "preview" | "file"; ref: string }
  | { record: "preview"; pylonId: PylonId; service: string; httpsPort: number; ready: boolean }
  | { record: "activity"; pylonId: PylonId; human: number | null; agent: number | null }
  | { record: "orphan"; node: NodeName; pylonId: PylonId }
  | { record: "job"; status: JobStatus };

/**
 * A session as the registry keeps it, but its pylon: running in a pane, paused with its pylon, or failed to come back
 * from the last wake (SessionFact). `status` is null where the observation has none, so the row keeps the Herdr
 * status it last had.
 */
export type SessionRow = { id: string; harness: SessionHarness; harnessSessionId: string | null; title: string | null } & (
  | { state: "running"; herdrPane: string; status: HerdrStatus; message: null }
  | { state: "paused"; herdrPane: string | null; status: null; message: null }
  | { state: "failed"; herdrPane: string | null; status: null; message: string });

/**
 * `node` is the probe the event came from. `known` maps each registry pylon on that node the pass would tick to the
 * last observation ingested for it, or "absent". A deleted thread's pylon that the node neither lists nor routes is
 * left out once nothing is left to tear down. Every write is an upsert, so ingesting an event twice is harmless.
 *
 * - A pylon missing from `known` is an orphan, and nothing else is written for it, not even a preview hit.
 * - A snapshot is the whole node, so a known pylon it omits is ingested as "absent".
 * - Sessions are written as the pylon's whole list whenever it differs from the previous observation's, and whenever
 *   the pylon is in `unlisted`, as loop.ts names each pylon whose list this control plane has not written since it
 *   started or since it was last left out of `known`. The previous observation may be one an older control plane stored, whose rows do not match it: one from
 *   before paused sessions deleted a paused pylon's rows. A running
 *   pylon lists its panes and the sessions its last wake failed to bring back. A stopped one lists, as paused, what
 *   its pause recorded, under the IDs they ran under, or says nothing (null), and then every session it had is
 *   paused. A booting, stopping, deleting or broken pylon says nothing, so its rows stand until the next list. An
 *   absent pylon has none. Running sessions the probe could not read (null) write nothing, and loop.ts stores the last
 *   list read in their place, except on the pylon's first running observation, or its first since this control plane
 *   started: a pylon that runs has no paused session, so that one resumes them (sessions-resumed) until the first list
 *   after the wake replaces them.
 * - Outputs are diffed against the previous observation, and derived here, not reported by the probe as outputs: a branch with pushedAs is "branch" with
 *   that ref, a dirty tree is "diff" with the head as ref (one per head), a ready preview is "preview" with
 *   the service as ref, and a declared output keeps its kind with its declaration id as ref. Outputs are
 *   never retracted, so only new ones are written.
 * - A preview is ready while a running pylon reports it published and warmed on its port. It stops being ready
 *   when the report drops it or the pylon stops running.
 * - A working session is agent activity, unless its harness's hooks report its activity, as Claude Code's do. One of a
 *   harness this build does not know counts. An attached client is human activity. Both are at `now`, the time the
 *   control plane received the event. A preview hit is human activity at its own time.
 */
export function ingest(event: ProbeEvent, node: NodeName, known: ReadonlyMap<PylonId, PylonObservation | "absent">, now: number, unlisted: ReadonlySet<PylonId> = new Set()): readonly RegistryWrite[] {
  const observed = (pylon: PylonObservation): RegistryWrite[] => {
    const previous = known.get(pylon.pylonId);
    return previous === undefined ? [{ record: "orphan", node, pylonId: pylon.pylonId }] : pylonWrites(pylon.pylonId, previous, pylon, now, unlisted.has(pylon.pylonId));
  };
  switch (event.type) {
    case "session-event": return [];
    case "snapshot": {
      const o = event.observation;
      if (o.node !== node) throw new Error(`a snapshot from ${node}'s probe names node ${o.node}`);
      const listed = new Set(o.pylons.map((p) => p.pylonId));
      return [
        { record: "node", node, state: "online", capacity: o.capacity },
        ...o.jobs.map((status): RegistryWrite => ({ record: "job", status })),
        ...o.pylons.flatMap(observed),
        ...[...known].filter(([id]) => !listed.has(id)).flatMap(([id, previous]) => pylonWrites(id, previous, "absent", now, unlisted.has(id))),
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

/** The pylon's sessions as the observation says, `paused` for a stopped pylon that says nothing, and null when it says nothing. */
function sessionsOf(o: PylonObservation | "absent"): readonly SessionRow[] | "paused" | null {
  if (o === "absent") return [];
  const common = (s: SessionFact | PausedSession) => ({ id: s.id, harness: s.harness, harnessSessionId: s.harnessSessionId, title: s.title ?? null });
  switch (o.phase) {
    case "running": return o.sessions?.map((s): SessionRow => s.state === "failed"
      ? { ...common(s), state: "failed", herdrPane: s.herdrPane, status: null, message: s.message }
      : { ...common(s), state: "running", herdrPane: s.herdrPane, status: s.status, message: null }) ?? null;
    case "stopped": {
      const paused = o.sessions;
      return paused === null ? "paused" : paused.map((s): SessionRow => ({ ...common(s), state: "paused", herdrPane: s.herdrPane, status: null, message: null }));
    }
    default: return null;
  }
}

function pylonWrites(pylonId: PylonId, previous: PylonObservation | "absent", current: PylonObservation | "absent", now: number, unlisted: boolean): RegistryWrite[] {
  const before = factsOf(previous);
  const after = factsOf(current);
  const writes: RegistryWrite[] = [];

  const sessions = sessionsOf(current);
  if (sessions !== null && (unlisted || !isDeepStrictEqual(sessionsOf(previous), sessions))) {
    writes.push(sessions === "paused" ? { record: "sessions-paused", pylonId } : { record: "sessions", pylonId, sessions });
  } else if (current !== "absent" && current.phase === "running" && current.sessions === null && (unlisted || previous === "absent" || previous.phase !== "running")) {
    writes.push({ record: "sessions-resumed", pylonId });
  }

  const had = new Set(outputsOf(before).map(({ kind, ref }) => `${kind} ${ref}`));
  for (const { kind, ref } of outputsOf(after)) {
    if (!had.has(`${kind} ${ref}`)) writes.push({ record: "output", pylonId, kind, ref });
  }

  const wasReady = readyPreviews(before);
  const isReady = readyPreviews(after);
  for (const [key, p] of isReady) if (!wasReady.has(key)) writes.push({ record: "preview", pylonId, ...p, ready: true });
  for (const [key, p] of wasReady) if (!isReady.has(key)) writes.push({ record: "preview", pylonId, ...p, ready: false });

  const agent = after.sessions?.some((s) => harnessNamed(s.harness)?.activity !== "hooks" && s.state === "running" && s.status === "working") ? now : null;
  const human = after.attachedClients > 0 ? now : null;
  if (agent !== null || human !== null) writes.push({ record: "activity", pylonId, human, agent });
  return writes;
}

const readyPreviews = (f: Facts) => new Map(f.previews.filter((p) => p.ready).map(({ service, httpsPort }) => [`${service} ${httpsPort}`, { service, httpsPort }]));

function outputsOf(f: Facts): { kind: Extract<RegistryWrite, { record: "output" }>["kind"]; ref: string }[] {
  return [
    ...(f.git?.branches ?? []).flatMap((b) => b.pushedAs === null ? [] : [{ kind: "branch" as const, ref: b.pushedAs }]),
    ...(f.git?.dirty ? [{ kind: "diff" as const, ref: f.git.head }] : []),
    ...f.previews.filter((p) => p.ready).map((p) => ({ kind: "preview" as const, ref: p.service })),
    ...f.declaredOutputs.map((d) => ({ kind: d.kind, ref: d.id })),
  ];
}
