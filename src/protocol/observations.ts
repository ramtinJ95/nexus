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
import { asSent, parse, parseJson, unchecked } from "../parse.ts";
import type { ArtifactId, CheckpointId, ImageId, LiveHash, NodeName, PylonId } from "../ids.ts";
import { pylonIdField, pylonIdSchema } from "./fields.ts";
import { jobStatusSchema, type JobStatus } from "./jobs.ts";

export interface NodeObservation {
  events: readonly ReportedEvent[];
  node: NodeName;
  observedAt: string;
  /** A new value after every probe restart. It tells the control plane that in-memory job results are gone. */
  probeBootId: string;
  capacity: NodeCapacity;
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
   * True from a probe whose backend can give a pylon KVM of its own: pylon-vm, on a host whose KVM module lets guests
   * nest. Only such a node takes a pylon whose boot asks for nested virtualization, such as a verify pylon.
   */
  nestedVirtualization?: true;
  /** The heldSecrets this probe takes from the control plane. */
  heldSecrets: readonly string[];
}

/**
 * What a node has, and what its pylons reserve of it. A VM that is up holds its CPUs and memory, and every pylon holds
 * its disk size until it is deleted, so a paused pylon counts toward `committedDiskGiB` only. `disks`: each filesystem
 * Nexus writes to, absent from a probe older than the field.
 */
export interface NodeCapacity { cpus: number; committedCpus: number; memoryGiB: number; committedMemoryGiB: number; diskFreeGiB: number; committedDiskGiB: number; disks?: readonly DiskFact[] }
/** A filesystem, once, with the paths Nexus writes to on it. `pylons`: it holds the pylons' disks and their overlays. */
export interface DiskFact { paths: readonly string[]; totalGiB: number; freeGiB: number; pylons?: true }

export interface PreviewRouteFact { httpsPort: number; pylonId: PylonId; service: string }

/**
 * `wakeAfterBoot` on a stopped or broken pylon: the node's last shutdown or reboot found it running and paused it, or
 * began to, and no spawn or delete of it has succeeded since. The control plane takes it as new activity, so the
 * pylon wakes as if the node had never gone down.
 */
export type PylonObservation =
  | { pylonId: PylonId; phase: "booting" | "stopping" | "deleting" }
  /**
   * `sessions`: what the wake brings back, as the pause recorded it. Null when the pause recorded nothing, such as with
   * no Herdr server, or the pylon stopped without a pause. The wake then
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
/** `unknown`: a backend that cannot tell why, or a cause this control plane does not know, from a probe newer than it. */
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
  /** Set while the pylon's guest gives no answer to its guest commands. Absent while it answers, and from a probe that predates it. */
  notAnswering?: GuestNotAnswering;
}
/** Since when the guest's last guest commands, `timeouts` of them in a row and at least 3, got no answer. */
export interface GuestNotAnswering { since: string; timeouts: number }

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
/** How long the probe reuses a pylon's git read, so a snapshot holds the branches pushed that long before it was taken. */
export const gitPollMs = 60_000;
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

/**
 * The probe-to-control contract this probe speaks, sent with every snapshot. The control plane refuses a snapshot below
 * `minProbeContract`, and reads every field from one at or above it as sent. A probe that starts sending something the
 * control plane will rely on raises `probeContract`. Once every probe runs it, `minProbeContract` follows, and the code
 * that read older probes goes.
 */
export const probeContract = 1;
export const minProbeContract = 1;

/** One line of the observe stream, newline included. */
export function encodeProbeEvent(event: ProbeEvent): string {
  return JSON.stringify(event.type === "snapshot" ? { ...event, contract: probeContract } : event) + "\n";
}

const reportedEventSchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pylon: pylonIdSchema.pipe(z.custom<PylonId>()),
  event: pylonEventSchema,
  time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}) satisfies z.ZodType<ReportedEvent>;

const pylonSchema = z.discriminatedUnion("phase", [
  z.looseObject({ pylonId: pylonIdField, phase: z.enum(["booting", "stopping", "deleting"]) }),
  z.looseObject({
    pylonId: pylonIdField, phase: z.literal("stopped"), checkpoint: unchecked<CheckpointId | null>(), sessions: unchecked<readonly PausedSession[] | null>(),
    wakeAfterBoot: unchecked<true>(),
  }),
  z.looseObject({ pylonId: pylonIdField, phase: z.literal("broken"), detail: unchecked<string>(), cause: unchecked<BrokenCause | "unknown">(), logTail: unchecked<string>(), wakeAfterBoot: unchecked<true>() }),
  z.looseObject({
    pylonId: pylonIdField, phase: z.literal("running"), liveHash: unchecked<LiveHash | null>(), bootedAt: unchecked<string>(),
    bootedFrom: unchecked<RunningFacts["bootedFrom"]>(), services: unchecked<RunningFacts["services"]>(), listening: unchecked<RunningFacts["listening"]>(),
    previews: unchecked<RunningFacts["previews"]>(), sessions: unchecked<RunningFacts["sessions"]>(), git: unchecked<GitFacts | null>(),
    declaredOutputs: unchecked<readonly DeclaredOutput[]>(), attachedClients: unchecked<number>(), notAnswering: unchecked<GuestNotAnswering>().exactOptional(),
  }),
]) satisfies z.ZodType<PylonObservation>;

const observationSchema = z.looseObject({
  node: unchecked<NodeName>(), observedAt: unchecked<string>(), probeBootId: unchecked<string>(),
  events: z.array(reportedEventSchema).max(100),
  capacity: unchecked<NodeCapacity>(),
  artifacts: z.array(unchecked<ArtifactId>()),
  jobs: z.array(jobStatusSchema),
  pylons: z.array(pylonSchema),
  previewRoutes: z.array(unchecked<PreviewRouteFact>()),
  grants: unchecked<NodeObservation["grants"]>(),
  nestedVirtualization: unchecked<true>(),
  heldSecrets: unchecked<readonly string[]>(),
}) satisfies z.ZodType<NodeObservation>;

const probeEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("snapshot"), contract: unchecked<unknown>(), observation: unchecked<unknown>() }),
  z.looseObject({ type: z.literal("session-event"), report: reportedEventSchema }),
  z.looseObject({ type: z.literal("pylon"), pylon: pylonSchema }),
  z.looseObject({ type: z.literal("job"), status: jobStatusSchema }),
  z.looseObject({ type: z.literal("preview-hit"), pylonId: pylonIdField, service: unchecked<string>(), at: unchecked<string>(), login: unchecked<string | null>() }),
]);

export function parseProbeEvent(frame: string): ProbeEvent {
  const event = parseJson(asSent(probeEventSchema), frame, "event");
  switch (event.type) {
    case "snapshot": {
      const { contract } = event;
      if (!(typeof contract === "number" && contract >= minProbeContract)) {
        const node = (event.observation as { node?: unknown } | null)?.node;
        throw new Error(`${typeof node === "string" ? node : "the node"} runs a probe of ${typeof contract === "number" ? `contract ${contract}` : "no contract"}, older than the ${minProbeContract} this control plane reads. Upgrade it with nexus deploy`);
      }
      const observation = parse(asSent(observationSchema), event.observation, "event.observation");
      return { type: "snapshot", observation: { ...observation, pylons: observation.pylons.map(knownCause) } };
    }
    case "pylon": return { type: "pylon", pylon: knownCause(event.pylon) };
    default: return event;
  }
}

function knownCause(p: PylonObservation): PylonObservation {
  return p.phase === "broken" && !reportedCauses.includes(p.cause) ? { ...p, cause: "unknown" } : p;
}
