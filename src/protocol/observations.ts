/**
 * Probe contract, observations. Facts only. The control plane turns them into records.
 *
 * The wire encoding (newline-delimited JSON events on GET /v1/observe) is private to this module. Callers see the
 * domain types below. The control plane reads through `parseProbeEvent`, and the probe writes through `encodeProbeEvent`.
 */
import { z } from "zod";
import { pylonEventSchema, type ReportedEvent } from "../events.ts";
import { chatgptTokenGrant } from "../secret-grants.ts";
import type { SessionHarness } from "../session-harness.ts";
import { asSent, parseJson, unchecked } from "../parse.ts";
import type { ArtifactId, CheckpointId, ImageId, LiveHash, NodeName, PylonId } from "../ids.ts";
import { pylonIdField, pylonIdSchema } from "./fields.ts";
import { jobStatusSchema, type JobStatus } from "./jobs.ts";

export interface NodeObservation {
  events: readonly ReportedEvent[];
  node: NodeName;
  observedAt: string;
  /** A new value after every probe restart. It tells the control plane that in-memory job results are gone. */
  probeBootId: string;
  /** Null from a probe from before pylons were counted (upgradeObservation). */
  capacity: NodeCapacity | null;
  /**
   * On pylon-vm, its checkpoints are those of the stopped pylons in `pylons`, taken from the same list. A pylon that
   * stops while the snapshot is read shows as stopped, with its checkpoint, in the next one.
   */
  artifacts: readonly ArtifactId[];
  /**
   * Running jobs, plus results from the last 10 minutes. Read before `pylons`, so `pylons` shows the result of
   * every job listed here as finished. The planner relies on that: a job event can arrive before the snapshot
   * that shows its result, and planning against the older snapshot would send the job again.
   */
  jobs: readonly JobStatus[];
  /** A pylon absent from this list does not exist on the node. A listed pylon the registry does not know is an orphan: shown, never deleted. */
  pylons: readonly PylonObservation[];
  /**
   * The https ports the probe's gateway routes, each to a pylon's service. A paused pylon keeps its routes. The
   * control plane gives none of these ports to another preview, whether or not the registry holds it.
   */
  previewRoutes: readonly PreviewRouteFact[];
  /** What the node can give a pylon: the names of the secrets in its secret file, and whether it has a git SSH key. */
  grants: { secrets: readonly string[]; gitSsh: boolean };
  /**
   * True from a probe that takes a spawn's `relaunch: false`. One older than the field ignores it and relaunches the
   * sessions, so the usage backfill never wakes a pylon on its node.
   */
  spawnsWithoutRelaunch?: true;
  /**
   * True from a probe whose backend can give a pylon KVM of its own: pylon-vm, on a host whose KVM module lets guests
   * nest. Only such a node takes a pylon whose boot asks for nested virtualization, such as a verify pylon.
   */
  nestedVirtualization?: true;
  /** The heldSecrets this probe takes from the control plane. */
  heldSecrets: readonly string[];
}

/**
 * What a node has, and what its pylons reserve of it. A VM that is up holds its CPUs and memory, and every pylon holds
 * its disk size until it is deleted, so a paused pylon counts toward `committedDiskGiB` only.
 */
export interface NodeCapacity { cpus: number; committedCpus: number; memoryGiB: number; committedMemoryGiB: number; diskFreeGiB: number; committedDiskGiB: number }
/**
 * A node's capacity as its probe reported it. A probe from before pylons were counted reports no CPUs and no committed
 * disk, and its committed memory is always 0.
 */
export type ReportedCapacity = NodeCapacity | Pick<NodeCapacity, "memoryGiB" | "committedMemoryGiB" | "diskFreeGiB">;
/** The capacity, or null where its probe was from before pylons were counted. */
export const countedCapacity = (c: ReportedCapacity | null): NodeCapacity | null => c !== null && "committedDiskGiB" in c ? c : null;

export interface PreviewRouteFact { httpsPort: number; pylonId: PylonId; service: string }

/**
 * `wakeAfterBoot` on a stopped or broken pylon: the node's last shutdown or reboot found it running and paused it, or
 * began to, and no spawn or delete of it has succeeded since. The control plane takes it as new activity, so the
 * pylon wakes as if the node had never gone down. A probe older than the field never sends it.
 */
export type PylonObservation =
  | { pylonId: PylonId; phase: "booting" | "stopping" | "deleting" }
  /**
   * `sessions`: what the wake brings back, as the pause recorded it. Null when the pause recorded nothing, such as with
   * no Herdr server, or the pylon stopped without a pause, or from a probe older than the field. The wake then
   * relaunches what an earlier record holds, which only the checkpoint knows.
   */
  | { pylonId: PylonId; phase: "stopped"; checkpoint: CheckpointId | null; sessions: readonly PausedSession[] | null; wakeAfterBoot?: true }
  /**
   * The backend reports it interrupted or failed. `logTail`: the last lines of its controller's log, at most 60 lines
   * and 8 KiB, with what looks like a secret redacted on the node. Empty when the backend keeps no such log.
   */
  | { pylonId: PylonId; phase: "broken"; detail: string; cause: BrokenCause | "unknown"; logTail: string; wakeAfterBoot?: true }
  | ({ pylonId: PylonId; phase: "running" } & RunningFacts);

/**
 * Why a pylon is broken. `setup`: its VM runs with a setup that failed on this boot, and it has no completed checkpoint.
 * Only the running disk holds the failure, and a pause removes the VM, so the next boot runs setup again.
 * `saved-setup`: its VM booted from a disk that already held a failed setup, or has a completed checkpoint a pause
 * would save the failure onto, so every boot of that disk would fail the same way. `services`: its VM runs, but a
 * declared service did not start. `controller`: the VM stopped outside a completed pause, and its disk is its last
 * checkpoint.
 */
export const brokenCauses = ["setup", "saved-setup", "services", "controller"] as const;
export type BrokenCause = typeof brokenCauses[number];
/** `unknown`: a backend that cannot tell why, or a cause this control plane does not know, or none, from a probe older or newer than it. */
const reportedCauses: readonly unknown[] = [...brokenCauses, "unknown"];

export interface RunningFacts {
  liveHash: LiveHash | null; // null until the probe has applied a LiveSpec since its own start or its last withdrawn preview route
  bootedAt: string;
  bootedFrom: { image: ImageId; checkpoint: CheckpointId | null };
  services: readonly ServiceFact[] | null; // null when the supervisor could not be read
  /** TCP ports the guest listens on that a preview can reach, whether or not one does. Null when they could not be read. */
  listening: readonly ListeningFact[] | null;
  /** Listed once the probe has published the preview and warmed its URL. */
  previews: readonly { service: string; httpsPort: number }[];
  sessions: readonly SessionFact[] | null; // null when Herdr could not be read. No Herdr server is an empty list
  git: GitFacts | null; // null until the first poll, or when the checkout is missing
  declaredOutputs: readonly DeclaredOutput[];
  /** The Herdr clients attached to the pylon's session, such as `nexus attach`, counted as human presence. */
  attachedClients: number;
}

/**
 * `unrouted` says why a preview's port has no route into the pylon while it has none, such as a pylon VM relay port
 * that something else holds (src/pylon-vm/relay.ts). A probe from before it sends none.
 */
export interface ServiceFact { name: string; state: "starting" | "ready" | "failed" | "stopped"; port: number; declared: boolean; wantsPreview: boolean; unrouted?: string }
export interface ListeningFact { port: number }
/** `unknown` is Herdr's word for a pane it cannot classify, which every plain shell is. */
export type HerdrStatus = "working" | "idle" | "blocked" | "done" | "unknown";
/**
 * A session in a running pylon. `id` names it: its Herdr pane, or `failed-` and a hash of its record for a session
 * the last wake left in no pane (sessions.ts). `failed` is one the last wake did not bring back, which the next wake
 * tries again: `message` says why, and `herdrPane` is the pane it left behind, such as a shell its agent would not
 * start in, or null. `status` is Herdr's for the pane, unknown with none: a control plane older than session states
 * stores one for every session. It cannot store a session in no pane, so the control plane is upgraded before the
 * probes (deploy/README.md).
 */
export type SessionFact =
  | {
    id: string; state: "running"; herdrPane: string; harness: SessionHarness; harnessSessionId: string | null; status: HerdrStatus;
    /** The session's title, its Herdr workspace's label. A probe from before titles were reported sends none. */
    title?: string;
  }
  | { id: string; state: "failed"; herdrPane: string | null; harness: SessionHarness; harnessSessionId: string | null; status: HerdrStatus; title: string; message: string };
/** What tells sessions apart. `title` is null where it is not known, as from a probe before titles were reported. */
export interface SessionIdentity { harness: SessionHarness; harnessSessionId: string | null; title: string | null }
/** A session a stopped pylon's wake brings back, under the `id` it had while the pylon ran. */
export interface PausedSession { id: string; herdrPane: string | null; harness: SessionHarness; harnessSessionId: string | null; title: string }
export interface GitFacts { head: string; branch: string | null; dirty: boolean; branches: readonly { name: string; head: string; pushedAs: string | null }[] }
export type DeclaredOutput =
  | { id: string; kind: "file"; path: string; title: string | null; sha256: string }
  /** base is HEAD's commit, or the empty tree's ID while the repository has no commit. The diff applies to base. */
  | { id: string; kind: "diff"; base: string; sha256: string; title: string | null };

export type ProbeEvent =
  | { type: "session-event"; report: ReportedEvent }
  | { type: "snapshot"; observation: NodeObservation } // on connect, then every 60 s as anti-entropy
  | { type: "pylon"; pylon: PylonObservation }
  | { type: "job"; status: JobStatus }
  /** A preview was requested. A paused pylon keeps its previews, so its browser gets a self-refreshing "waking" page while the control plane decides. */
  | { type: "preview-hit"; pylonId: PylonId; service: string; at: string; login: string | null };

/** The secrets whose values the control plane holds and hands to every probe, which no node's secret file may set. */
export const heldSecrets: readonly string[] = [chatgptTokenGrant.name];

/** One line of the observe stream, newline included. */
export function encodeProbeEvent(event: ProbeEvent): string {
  return JSON.stringify(event) + "\n";
}

const reportedEventSchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pylon: pylonIdSchema.pipe(z.custom<PylonId>()),
  event: pylonEventSchema,
  time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}) satisfies z.ZodType<ReportedEvent>;

const olderPylonSchema = z.discriminatedUnion("phase", [
  z.looseObject({ pylonId: pylonIdField, phase: z.enum(["booting", "stopping", "deleting"]) }),
  z.looseObject({
    pylonId: pylonIdField, phase: z.literal("stopped"), checkpoint: unchecked<CheckpointId | null>(), sessions: unchecked<readonly PausedSession[] | null>(),
    wakeAfterBoot: unchecked<true>(),
  }),
  z.looseObject({ pylonId: pylonIdField, phase: z.literal("broken"), detail: unchecked<string>(), cause: unchecked<string>(), logTail: unchecked<string>(), wakeAfterBoot: unchecked<true>() }),
  z.looseObject({
    pylonId: pylonIdField, phase: z.literal("running"), liveHash: unchecked<LiveHash | null>(), bootedAt: unchecked<string>(),
    bootedFrom: unchecked<RunningFacts["bootedFrom"]>(), services: unchecked<RunningFacts["services"]>(), listening: unchecked<RunningFacts["listening"]>(),
    previews: unchecked<readonly OlderPreview[]>(), sessions: unchecked<readonly (SessionFact | OlderSession)[] | null>(), git: unchecked<GitFacts | null>(),
    declaredOutputs: unchecked<readonly DeclaredOutput[]>(), attachedClients: unchecked<number>(),
  }),
]) satisfies z.ZodType<OlderPylonObservation>;

const olderObservationSchema = z.looseObject({
  node: unchecked<NodeName>(), observedAt: unchecked<string>(), probeBootId: unchecked<string>(),
  events: z.array(reportedEventSchema).max(100).exactOptional(),
  capacity: unchecked<ReportedCapacity | null>(),
  artifacts: z.array(unchecked<ArtifactId>()),
  jobs: z.array(jobStatusSchema),
  pylons: z.array(olderPylonSchema),
  previewRoutes: z.array(unchecked<PreviewRouteFact>()).nullable().exactOptional(),
  grants: unchecked<NodeObservation["grants"] | null>(),
  spawnsWithoutRelaunch: unchecked<true>(),
  nestedVirtualization: unchecked<true>(),
  heldSecrets: unchecked<readonly string[]>(),
}) satisfies z.ZodType<OlderObservation>;

const probeEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("snapshot"), observation: olderObservationSchema }),
  z.looseObject({ type: z.literal("session-event"), report: reportedEventSchema }),
  z.looseObject({ type: z.literal("pylon"), pylon: olderPylonSchema }),
  z.looseObject({ type: z.literal("job"), status: jobStatusSchema }),
  z.looseObject({ type: z.literal("preview-hit"), pylonId: pylonIdField, service: unchecked<string>(), at: unchecked<string>(), login: unchecked<string | null>() }),
]);

export function parseProbeEvent(frame: string): ProbeEvent {
  const event = parseJson(asSent(probeEventSchema), frame, "event");
  switch (event.type) {
    case "snapshot": return { type: "snapshot", observation: upgradeObservation(event.observation) };
    case "pylon": return { type: "pylon", pylon: upgradePylon(event.pylon) };
    default: return event;
  }
}

/** An observation as a probe older than some of its fields sent it, which the registry may still hold, or an upgraded one. */
export type OlderObservation = Omit<NodeObservation, "events" | "capacity" | "previewRoutes" | "grants" | "heldSecrets" | "pylons"> & {
  events?: readonly ReportedEvent[];
  capacity: ReportedCapacity | null;
  previewRoutes?: readonly PreviewRouteFact[] | null;
  grants?: NodeObservation["grants"] | null;
  heldSecrets?: readonly string[];
  pylons: readonly OlderPylonObservation[];
};
type OlderPylonObservation =
  | Exclude<PylonObservation, { phase: "running" | "stopped" | "broken" }>
  | (Omit<Extract<PylonObservation, { phase: "running" }>, "listening" | "previews" | "sessions"> & { listening?: readonly ListeningFact[] | null; previews: readonly OlderPreview[]; sessions: readonly (SessionFact | OlderSession)[] | null })
  | (Omit<Extract<PylonObservation, { phase: "stopped" }>, "sessions"> & { sessions?: readonly PausedSession[] | null })
  | (Omit<Extract<PylonObservation, { phase: "broken" }>, "cause" | "logTail"> & { cause?: string; logTail?: string });
/** A session from a probe older than session states, which reported only sessions in panes. */
type OlderPreview = RunningFacts["previews"][number] & { ready?: boolean };
type OlderSession = Omit<Extract<SessionFact, { state: "running" }>, "id" | "state"> & { state?: undefined };

/**
 * The only place that reads an observation from an older probe, at parse and on every registry read. What such a probe
 * left out reads as what it meant:
 * - No event backlog: none to replay.
 * - No preview routes: it routes none the registry does not know, so allocation goes by the registry alone, and a
 *   deleted pylon the node reports absent counts as gone.
 * - No grants, or no committed disk: it was from before pylons were counted, so its capacity is null, and placement
 *   never chooses its node.
 * - No held secrets: it takes none from the control plane. It would look for one in its secret file and fail the
 *   spawn for good, so the planner holds a boot that needs one (reconcile.ts).
 * - A running pylon's listening ports unknown, and sessions from before session states as running in their panes.
 * - A running pylon's previews without the `ready` an older probe sent, which was always true.
 * - A stopped pylon's sessions null, as from a pause that recorded nothing.
 * - A broken pylon's cause unknown, as is one this control plane does not know, and its log tail empty.
 * An observation it returned comes back unchanged.
 */
export function upgradeObservation(o: OlderObservation): NodeObservation {
  return {
    ...o,
    events: o.events ?? [],
    capacity: o.grants == null ? null : countedCapacity(o.capacity),
    previewRoutes: o.previewRoutes ?? [],
    grants: o.grants ?? { secrets: [], gitSsh: false },
    heldSecrets: o.heldSecrets ?? [],
    pylons: o.pylons.map(upgradePylon),
  };
}

function upgradePylon(p: OlderPylonObservation): PylonObservation {
  switch (p.phase) {
    case "running": return {
      ...p, listening: p.listening ?? null,
      previews: p.previews.map(({ service, httpsPort }) => ({ service, httpsPort })),
      sessions: p.sessions?.map((s): SessionFact => s.state === undefined ? { ...s, state: "running", id: s.herdrPane } : s) ?? null,
    };
    case "stopped": return { ...p, sessions: p.sessions ?? null };
    case "broken": return { ...p, cause: reportedCauses.includes(p.cause) ? p.cause as BrokenCause | "unknown" : "unknown", logTail: p.logTail ?? "" };
    default: return p;
  }
}
