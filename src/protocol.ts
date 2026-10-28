import { pylonEventSchema, type ReportedEvent } from "./events.ts";
/**
 * Probe contract, control-plane side. The control plane decides, and the probe executes and observes.
 *
 * Invariants:
 * - The probe never dials the control plane. The control plane opens every connection, except
 *   probe-to-probe artifact copies.
 * - The probe writes no durable Nexus record. Its only durable state is what the backend keeps on disk
 *   (VMs, checkpoints, templates, images). Everything else is rebuilt from the next job.
 * - Every job converges. Running it twice, or after a run that stopped partway, gives the same end state.
 * - No job can drop a checkpoint. A checkpoint is the only copy of uncommitted work, so it is removed only
 *   by `delete` of its pylon, and the planner sends `delete` only for pylons the registry knows. A wiped
 *   registry therefore knows no pylons and deletes nothing.
 * - The wire encoding (JSON over HTTP, newline-delimited JSON events on observe, and frames on streams) is
 *   private to this module. Callers see the domain types below. The control plane reads through
 *   `parseProbeEvent` and `parseSubmitReply`, and the probe through `parseJobEnvelope`, `encodeSubmitReply`,
 *   `encodeProbeEvent`, `parseStreamRequest` and `serveByteStream`.
 * - A peer of another release may send a field this one does not know, as during a deploy. It is not refused: a
 *   parser that hands its payload on hands the field on with it, and one that builds a value of its own leaves it out.
 *   A reported session event is the exception, checked as strictly as the pylon that sent it is, which only a probe
 *   newer than its control plane could break. Deploys upgrade the control plane first.
 * - A bad payload keeps its status (400, or the `invalid` submit reply) and gets one line that names each wrong field
 *   from the top of the payload, and what is wrong with it: `command.timeoutMs: Too big: expected number to be <=60000`.
 */
import { once } from "node:events";
import { Agent, request, type IncomingMessage } from "node:http";
import { PassThrough, type Duplex, type Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { localApiWhois, type Whois } from "./tailscale.ts";
import { chatgptTokenGrant, reservedPortMessage, reservedPorts, sessionHarnessSchema, type BootInputs, type LiveSpec, type ProjectId, type SessionHarness } from "./project.ts";
import { claudeTextProblem } from "./sessions.ts";
import { asSent, named, nonEmpty, parse, parseJson, unchecked } from "./parse.ts";
import type {
  ArtifactManifest, CheckpointId, ImageId, ImageManifest, ImageRecipe, PortableArtifactId, ArtifactId, TemplateBuildInputs, TemplateId, TemplateManifest,
} from "./images.ts";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type NodeName = Brand<string, "NodeName">; // "rj-firebat", "infra-testbench"
/** A tailnet machine name, which is one DNS label, so at most 63 characters. */
export const nodeNameSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be a lowercase tailnet machine name of at most 63 characters")
  .refine((name) => name !== "auto", "auto is what `start --node auto` asks for, so no node may be named it")
  .transform((name) => name as NodeName);
/** `pylon-${threadId}`. At most 40 characters, the pi-sandbox name limit, so thread IDs are at most 34. */
export type PylonId = Brand<string, "PylonId">;
export const maxPylonIdLength = 40;
export const pylonIdSchema = z.string().max(maxPylonIdLength).regex(/^[a-z][a-z0-9-]*$/);
/**
 * Image and template IDs as the control plane mints them, a kind and a few lowercase letters or digits. They
 * name directories in a node's artifact store, so an ID with a separator or a dot is refused before it is used.
 */
export const isImageId = (id: unknown): id is ImageId => typeof id === "string" && /^img-[a-z0-9]{1,40}$/.test(id);
export const isTemplateId = (id: unknown): id is TemplateId => typeof id === "string" && /^tpl-[a-z0-9]{1,40}$/.test(id);
export const isPortableArtifactId = (id: unknown): id is PortableArtifactId => isImageId(id) || isTemplateId(id);
export type JobId = Brand<string, "JobId">; // UUID minted by the control plane
/** sha256 of the canonical LiveSpec. Observations echo it, so the planner sees drift without a counter. */
export type LiveHash = Brand<string, "LiveHash">;

// Jobs: Amp's spawn, pause and delete, plus the artifact work Amp does on its own servers.

export type Job =
  | { kind: "spawn"; pylonId: PylonId; boot: BootInputs; live: LiveSpec; liveHash: LiveHash; relaunch?: false }
  | { kind: "pause"; pylonId: PylonId; checkpoint: CheckpointId }
  | { kind: "delete"; pylonId: PylonId }
  | { kind: "build-image"; image: ImageId; recipe: ImageRecipe }
  | { kind: "build-template"; template: TemplateId; inputs: TemplateBuildInputs }
  | { kind: "fetch-artifact"; artifact: ArtifactId; from: NodeName; sha256: string }
  | { kind: "drop-artifact"; artifact: PortableArtifactId };

/**
 * spawn means "make this pylon run and look like `live`". It is Amp's spawn plus wake plus "re-apply the
 * live spec". If the VM already runs, `boot` is ignored and only `live` is applied (previews published,
 * overlay files written). That is how a probe restart heals: its observations report `liveHash: null`,
 * so the planner sends spawn again. Unlinking a port withdraws its preview route at once and heals the same way.
 * `relaunch: false` boots without bringing back the pylon's sessions, and leaves them for the next spawn to bring back.
 *
 * pause records the open Herdr sessions in /home/user/.nexus/sessions.json, stops services, writes the
 * disk checkpoint and stops the VM. The session list is on the disk, so the checkpoint carries it and a
 * session opened a second before the pause is still relaunched. The backend keeps a copy of the list beside the
 * checkpoint, which the stopped pylon's observation reports. delete removes the VM, its checkpoint,
 * and its previews. Deleting an absent pylon succeeds.
 */
export const jobDeadlineMs: { readonly [K in Job["kind"]]: number } = {
  spawn: 5 * 60_000,
  pause: 5 * 60_000,
  delete: 5 * 60_000,
  "build-image": 30 * 60_000,
  "build-template": 30 * 60_000, // 20 min setup, plus clone and checkpoint
  "fetch-artifact": 30 * 60_000,
  "drop-artifact": 60_000,
};

/** The probe refuses an envelope after `notAfter`, so a delayed retry of an old pause cannot land after a newer wake. */
export interface JobEnvelope {
  jobId: JobId;
  node: NodeName;
  issuedAt: string;
  notAfter: string; // issuedAt + 30 s. Nodes run NTP
  job: Job;
}

export type Subject = PylonId | ArtifactId;
export function jobSubject(job: Job): Subject {
  switch (job.kind) {
    case "spawn": case "pause": case "delete": return job.pylonId;
    case "build-image": return job.image;
    case "build-template": return job.template;
    case "fetch-artifact": case "drop-artifact": return job.artifact;
  }
}

export type JobErrorCode =
  | "deadline" | "backend" | "checkpoint-failed" | "artifact-missing" | "capacity"
  | "setup-failed" | "secret-missing" | "invalid";

/** The only retry table. It is never sent on the wire, so the probe cannot disagree with it. */
export const retryable: { readonly [C in JobErrorCode]: boolean } = {
  deadline: true, backend: true, "checkpoint-failed": true, "artifact-missing": true, capacity: true,
  "setup-failed": false, "secret-missing": false, invalid: false,
};

export type JobStatus =
  | { jobId: JobId; subject: Subject; kind: Job["kind"]; state: "running"; startedAt: string }
  | { jobId: JobId; subject: Subject; kind: Job["kind"]; state: "succeeded"; finishedAt: string }
  | { jobId: JobId; subject: Subject; kind: Job["kind"]; state: "failed"; finishedAt: string; code: JobErrorCode; message: string; logTail: string };

export type SubmitReply =
  | { accepted: JobStatus } // also returned for a repeated jobId, with its current status
  | { rejected: "busy"; inFlight: JobId }
  | { rejected: "expired" }
  | { rejected: "invalid"; message: string };

// Observations: facts only. The control plane turns them into records.

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

export type PylonObservation =
  | { pylonId: PylonId; phase: "booting" | "stopping" | "deleting" }
  /**
   * `sessions`: what the wake brings back, as the pause recorded it. Null when the pause recorded nothing, such as with
   * no Herdr server, or the pylon stopped without a pause, or from a probe older than the field. The wake then
   * relaunches what an earlier record holds, which only the checkpoint knows.
   */
  | { pylonId: PylonId; phase: "stopped"; checkpoint: CheckpointId | null; sessions: readonly PausedSession[] | null }
  | { pylonId: PylonId; phase: "broken"; detail: string; cause: BrokenCause | "unknown" } // the backend reports it interrupted or failed
  | ({ pylonId: PylonId; phase: "running" } & RunningFacts);

/**
 * Why a pylon is broken. `setup`: its VM runs with a setup that failed on this boot, and it has no completed checkpoint.
 * Only the running disk holds the failure, and a pause removes the VM, so the next boot runs setup again.
 * `saved-setup`: its VM booted from a disk that already held a failed setup, or has a completed checkpoint a pause
 * would save the failure onto, so every boot of that disk would fail the same way. `services`: its VM runs, but a
 * declared service did not start. `controller`: the VM stopped outside a completed pause, and its disk is its last
 * checkpoint.
 */
export type BrokenCause = "setup" | "saved-setup" | "services" | "controller";
/** `unknown`: a backend that cannot tell why, or a cause this control plane does not know, or none, from a probe older or newer than it. */
const brokenCauses: ReadonlySet<unknown> = new Set(["setup", "saved-setup", "services", "controller", "unknown"] satisfies (BrokenCause | "unknown")[]);

export interface RunningFacts {
  liveHash: LiveHash | null; // null until the probe has applied a LiveSpec since its own start or its last withdrawn preview route
  bootedAt: string;
  bootedFrom: { image: ImageId; checkpoint: CheckpointId | null };
  services: readonly ServiceFact[] | null; // null when the supervisor could not be read
  /** TCP ports the guest listens on that a preview can reach, whether or not one does. Null when they could not be read. */
  listening: readonly ListeningFact[] | null;
  previews: readonly { service: string; httpsPort: number; ready: boolean }[];
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

// Synchronous guest operations. They are not reconciled and not queued behind lifecycle jobs.
// Everything runs as `user`. pi-sandbox fixes the shell user for the life of an instance, and `user`
// has passwordless sudo, so a root command is `["sudo", ...]`. What each kind waits for, whether it publishes a
// snapshot and whether a caller may send it again is commandPolicies in backend.ts.

export type PylonCommand =
  /** When the timeout passes, the probe calls pi-sandbox's exec-kill and returns exitCode null. Timeout at most 60 s. */
  | { kind: "exec"; argv: readonly string[]; cwd: string; timeoutMs: number }
  | { kind: "open-session"; harness: SessionHarness; title: string; resume?: string; prompt?: string; model?: string }
  /**
   * `session` is who the control plane last saw in the pane, so a pane a wake has since given to another session is
   * left open. None for a pane no observation has listed yet, such as one opened a moment ago.
   */
  | { kind: "close-session"; herdrPane: string; session?: SessionIdentity }
  /** Forgets a failed session the last wake left in no pane, so no wake tries it again. */
  | { kind: "drop-failed-session"; id: string }
  /**
   * Types `text` into the Claude Code session `session` as a prompt and submits it, resuming the session first, under
   * `model` if given, when no live pane runs it. `text` holds no control character but newlines (claudeTextProblem).
   * The probe remembers the send under `requestId`, for send-claude-outcome. A control plane older than it sends none.
   */
  | { kind: "send-claude"; session: string; text: string; model?: string; requestId?: string }
  /**
   * What became of the send-claude under `requestId`, answered once it settles. It never types: a send still waiting
   * behind another to the same session is waited for, so a control plane whose wait ran out asks this, not again.
   */
  | { kind: "send-claude-outcome"; requestId: string }
  | { kind: "service"; op: "ensure" | "restart" | "stop" | "logs"; name?: string; lines?: number }
  /** Previews a port that already listens, or will, as `nexus preview <port>` in the pylon does. */
  | { kind: "link-port"; port: number }
  /** Stops previewing a linked port. A port not linked succeeds, and a port a service's preview owns is refused. */
  | { kind: "unlink-port"; port: number };

export type SendClaudeOutcome = "sent" | "queued" | "blocked" | "starting" | "moved";

export type CommandResult =
  | { kind: "exec"; exitCode: number | null; output: string; truncated: boolean }
  | { kind: "open-session"; herdrPane: string }
  /**
   * `not-open`: no such pane is open. `moved`: the pane runs another session than the command names, such as one a wake
   * put there after moving the named one. Both leave every pane as it was. A probe older than the field sends none.
   */
  | { kind: "close-session"; outcome: "closed" | "not-open" | "moved" }
  /** `dropped` is false when the pylon holds no such failed session. */
  | { kind: "drop-failed-session"; dropped: boolean }
  /**
   * `sent`: Claude was idle, so the message starts a turn. `queued`: Claude was working, so Claude Code queues the message
   * as it queues input typed during a turn, and takes it at its next tool boundary or after the turn. Both mean it was
   * typed. `blocked`: Claude waits at a prompt in its terminal, such as a trust or permission dialog, which typing would
   * answer. `starting`: Herdr could not yet tell Claude's state. `moved`: the pane stopped running the session before
   * anything was typed, as when another agent started in it. These mean nothing was typed, so the message can be sent
   * again. A failed command may have typed part of the message.
   * `herdrPane` is the pane Claude runs in, and `resumed` says the session had no live pane and was resumed into it first.
   */
  | { kind: "send-claude"; outcome: SendClaudeOutcome; herdrPane: string; resumed: boolean }
  /**
   * The send's own result, `failed` for a send that failed and so may have typed part of the message, or `unknown`
   * when the probe holds no send under the ID: it never got one, or forgot it in a restart or an hour after it settled.
   */
  | { kind: "send-claude-outcome"; send: { outcome: SendClaudeOutcome; herdrPane: string; resumed: boolean } | "failed" | "unknown" }
  | { kind: "service"; services: readonly ServiceFact[]; logs?: string }
  /** The service the port is previewed under: `port-<port>`, or the service that already owns the port. */
  | { kind: "link-port"; service: string }
  /** `refused` says why the pylon left a port a service's preview owns, for a person to read. Null once the port is not linked. */
  | { kind: "unlink-port"; refused: string | null };

/**
 * A stream is a raw pipe to a process in the guest, such as the pi-env daemon. It carries the process's stdout
 * only, and its stderr goes to the probe's log under the pylon's ID, so a diagnostic can never corrupt a framed
 * protocol on stdout. A terminal is a program on a pipe too: guest-terminal.ts makes its pty in the guest.
 *
 * A pipe runs at most once. If the connection drops, the probe ends the guest process's stdin and `done`
 * resolves to `lost`. The pi-env daemon then kills every command it started. A tool call whose pipe was lost
 * fails with pi-env's "connection lost" error, which the model sees as an ordinary error result. pi-durable's
 * `interrupted` result appears only when the harness process itself died mid-call. A terminal's relay hangs up
 * when its stdin ends, so Herdr's client detaches and the session stays.
 */
export type StreamEnd = { kind: "exited"; code: number } | { kind: "lost" };
export interface ByteStream extends AsyncIterable<Uint8Array> {
  write(chunk: Uint8Array): Promise<void>;
  /** Ends the process's stdin. Its output keeps arriving until it exits. */
  close(): Promise<void>;
  /** Drops the stream at once, without waiting for the process, as for a node that stopped answering. `done` follows. */
  abort(): void;
  readonly done: Promise<StreamEnd>;
}

export type ProbeError = { code: "unreachable" | "not-running" | "forbidden"; message: string };

/** The control plane's handle on one probe. All methods reject with ProbeError. */
export interface ProbeClient {
  readonly node: NodeName;
  /** PUT /v1/jobs/{jobId}. Retry the same envelope on a transport error until it is accepted or expires. */
  submit(env: JobEnvelope): Promise<SubmitReply>;
  job(jobId: JobId): Promise<JobStatus | "unknown">;
  /** Ends when the link drops. The registry marks the node offline after 30 s without a reconnect. */
  observe(signal: AbortSignal): AsyncIterable<ProbeEvent>;
  command(pylonId: PylonId, command: PylonCommand): Promise<CommandResult>;
  stream(pylonId: PylonId, argv: readonly string[]): Promise<ByteStream>;
  /** GET /v1/manifests/{id}: the manifest of an image or template the node holds, or null when it holds none. */
  manifest(artifact: PortableArtifactId): Promise<ArtifactManifest | null>;
  /** PUT /v1/secrets/{name}: the current value of one of heldSecrets. The probe holds it in memory and applies it to its running pylons. */
  putSecret(name: string, value: string): Promise<void>;
}

/** The secrets whose values the control plane holds and hands to every probe, which no node's secret file may set. */
export const heldSecrets: readonly string[] = [chatgptTokenGrant.name];

/** Tailscale's stable node ID, as LocalAPI whois reports it. It survives renames and address changes. */
export type TailnetNodeId = Brand<string, "TailnetNodeId">;
export const tailnetNodeIdSchema = z.string()
  .regex(/^n[A-Za-z0-9]+$/, "must be a Tailscale stable node ID, such as nAbCdEf1CNTRL (tailscale status --json)")
  .transform((id) => id as TailnetNodeId);

export const probePort = 7480;
const requestTimeoutMs = 10_000;
/** A command answers only when it is done: an exec of up to 60 s, or a session open that waits for its agent. */
const commandTimeoutMs = 90_000;

/**
 * `whois` defaults to the local tailscaled. Tests pass a fake one, and `port` exists so they can run
 * a probe on a free loopback port.
 */
export function connectProbe(node: NodeName, tailnetHost: string, expected: TailnetNodeId, options: { port?: number; whois?: Whois } = {}): ProbeClient {
  // Plain HTTP, because WireGuard already encrypts the link. The identity check is whois on the socket we got.
  const port = options.port ?? probePort;
  const whois = options.whois ?? localApiWhois();
  const agent = new Agent({ keepAlive: false });

  /** A silent socket for `requestTimeoutMs` fails the call as unreachable. Observe lifts the limit once its stream starts. */
  function open(method: "GET" | "PUT" | "POST", path: string, body: string | null, signal?: AbortSignal, timeoutMs = requestTimeoutMs, contentType = "application/json"): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request({ host: tailnetHost, port, method, path, agent, timeout: timeoutMs, ...(signal ? { signal } : {}) }, (res) => {
        if (res.statusCode === 403) {
          res.destroy();
          return reject(probeError("forbidden", `${node} refused this caller`));
        }
        resolve(res);
      });
      req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
      req.on("error", (err) => reject(signal?.aborted || isProbeError(err) ? err : probeError("unreachable", `${node}: ${err.message}`)));
      if (body !== null) req.setHeader("content-type", contentType);
      // A body can be a secret, so not even the request line goes out until whois names the connected peer.
      req.once("socket", (socket) => {
        const verify = () => {
          const { remoteAddress, remotePort } = socket;
          if (remoteAddress === undefined || remotePort === undefined) return req.destroy(probeError("unreachable", `${node}: the connection closed before whois`));
          whois(remoteAddress, remotePort).then((id) => {
            if (id !== expected) return req.destroy(probeError("forbidden", `${node}: ${remoteAddress}:${remotePort} is tailnet node ${id ?? "unknown"}, expected ${expected}`));
            req.end(body ?? undefined);
          }, (err: Error) => req.destroy(err));
        };
        if (socket.connecting) socket.once("connect", verify);
        else verify();
      });
    });
  }

  async function call(method: "GET" | "PUT" | "POST", path: string, body: string | null = null, timeoutMs = requestTimeoutMs, contentType?: string): Promise<{ status: number; body: string }> {
    const res = await open(method, path, body, undefined, timeoutMs, contentType);
    try {
      return { status: res.statusCode ?? 0, body: await text(res) };
    } catch (err) {
      throw probeError("unreachable", `${node}: the response broke off: ${(err as Error).message}`);
    }
  }

  return {
    node,
    async submit(env) {
      for (;;) {
        try {
          const res = await call("PUT", `/v1/jobs/${encodeURIComponent(env.jobId)}`, JSON.stringify(env));
          return parseSubmitReply(res.status, res.body);
        } catch (err) {
          if (!isProbeError(err) || err.code !== "unreachable" || Date.now() >= Date.parse(env.notAfter)) throw err;
          await delay(500);
        }
      }
    },
    async job(jobId) {
      const res = await call("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
      if (res.status === 404) return "unknown";
      if (res.status !== 200) throw new Error(`${node}: GET /v1/jobs/${jobId}: HTTP ${res.status}: ${res.body}`);
      return parseJson(asSent(jobStatusSchema), res.body, "status");
    },
    async *observe(signal) {
      const res = await open("GET", "/v1/observe", null, signal);
      if (res.statusCode !== 200) throw new Error(`${node}: GET /v1/observe: HTTP ${res.statusCode}: ${await text(res)}`);
      // The first snapshot arrives with the headers. After that, events can be a minute apart.
      res.socket.setTimeout(0);
      for await (const line of lines(res)) yield parseProbeEvent(line);
    },
    /** Never retried here. commandPolicies in backend.ts says which kinds a caller may send again. */
    async command(pylonId, command) {
      const path = `/v1/pylons/${encodeURIComponent(pylonId)}/commands`;
      const res = await call("POST", path, JSON.stringify(command), commandTimeoutMs);
      if (res.status === 409) throw probeError("not-running", `${node}: ${res.body}`);
      if (res.status !== 200) throw new Error(`${node}: POST ${path}: HTTP ${res.status}: ${res.body}`);
      return parseCommandResult(command, res.body);
    },
    async putSecret(name, value) {
      const path = `/v1/secrets/${encodeURIComponent(name)}`;
      const res = await call("PUT", path, value, requestTimeoutMs, "text/plain; charset=utf-8");
      if (res.status !== 204) throw new Error(`${node}: PUT ${path}: HTTP ${res.status}: ${res.body}`);
    },
    stream(pylonId, argv) {
      const path = streamPath(pylonId, argv);
      return new Promise((resolve, reject) => {
        const req = request({ host: tailnetHost, port, method: "GET", path, agent, timeout: requestTimeoutMs, headers: { connection: "upgrade", upgrade: streamProtocol } });
        req.on("upgrade", (_res, socket, head) => {
          // Node hands over an upgraded socket without its error handler. A reset ends the stream as lost.
          socket.on("error", () => undefined);
          const { remoteAddress, remotePort } = socket;
          if (remoteAddress === undefined || remotePort === undefined) {
            socket.destroy();
            return reject(probeError("unreachable", `${node}: the stream closed before whois`));
          }
          whois(remoteAddress, remotePort).then((id) => {
            if (id !== expected) {
              socket.destroy();
              return reject(probeError("forbidden", `${node}: ${remoteAddress}:${remotePort} is tailnet node ${id ?? "unknown"}, expected ${expected}`));
            }
            // pi-env pings every 5 s, but a terminal can be silent for hours.
            socket.setTimeout(0);
            resolve(clientByteStream(socket, head));
          }, (err: unknown) => { socket.destroy(); reject(err); });
        });
        req.on("response", (res) => {
          text(res).then((body) => reject(
            res.statusCode === 409 ? probeError("not-running", `${node}: ${body}`)
              : res.statusCode === 403 ? probeError("forbidden", `${node} refused this caller`)
              : new Error(`${node}: GET ${path}: HTTP ${res.statusCode}: ${body}`),
          ), reject);
        });
        req.on("timeout", () => req.destroy(new Error(`no answer within ${requestTimeoutMs} ms`)));
        req.on("error", (err) => reject(probeError("unreachable", `${node}: ${err.message}`)));
        req.end();
      });
    },
    async manifest(artifact) {
      const path = `/v1/manifests/${encodeURIComponent(artifact)}`;
      const res = await call("GET", path);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`${node}: GET ${path}: HTTP ${res.status}: ${res.body}`);
      return parseArtifactManifest(JSON.parse(res.body));
    },
  };
}

function probeError(code: ProbeError["code"], message: string): Error & ProbeError {
  return Object.assign(new Error(message), { code });
}
function isProbeError(err: unknown): err is Error & ProbeError {
  return err instanceof Error && "code" in err && (err.code === "unreachable" || err.code === "not-running" || err.code === "forbidden");
}

/** Ends quietly when the link drops or the caller aborts: that is how observe reports a lost link. */
async function* lines(res: IncomingMessage): AsyncGenerator<string> {
  res.setEncoding("utf8");
  let buffered = "";
  try {
    for await (const chunk of res as AsyncIterable<string>) {
      buffered += chunk;
      for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line !== "") yield line;
      }
    }
  } catch {
    return;
  } finally {
    res.destroy();
  }
}

async function text(res: IncomingMessage): Promise<string> {
  res.setEncoding("utf8");
  let body = "";
  for await (const chunk of res as AsyncIterable<string>) body += chunk;
  return body;
}

/**
 * Who may call each route. The home tailnet keeps its policy as it is, with no tags and no ACL change,
 * so every one of your devices can open a connection. The probe refuses any caller whose whois node ID
 * is not the one its config names for the route.
 */
export type CallerRole = "control-plane" | "peer-probe";
export const routeAuth = {
  "/v1/jobs": "control-plane",
  "/v1/observe": "control-plane",
  "/v1/pylons": "control-plane",
  "/v1/manifests": "control-plane",
  "/v1/secrets": "control-plane",
  "/v1/artifacts": "peer-probe", // checkpoints hold the pylon's logins, so only the other probe may read them
} as const satisfies Record<string, CallerRole>;

/** Read from /etc/nexus/probe.json on each node. */
export interface ProbeAuthConfig {
  controlPlane: TailnetNodeId; // rj-firebat
  peers: readonly TailnetNodeId[]; // every other node
}

// The wire encoding: JSON bodies, and newline-delimited JSON events on GET /v1/observe.

const submitStatus = { accepted: 200, busy: 409, expired: 410, invalid: 400 } as const;

export function encodeSubmitReply(reply: SubmitReply): { status: number; body: string } {
  return { status: "accepted" in reply ? submitStatus.accepted : submitStatus[reply.rejected], body: JSON.stringify(reply) };
}

/**
 * GET /v1/pylons/{id}/stream?request={"argv": [...]} upgrades the connection to `nexus-stream`, a sequence of
 * frames: a type byte, a 4-byte big-endian length, then the payload. The control plane sends stdin and end of
 * stdin. The probe sends output, then the exit code as its last frame. A connection that closes without an exit
 * frame is a lost stream. The probe answers 409 instead of upgrading when the pylon is not running.
 */
const streamProtocol = "nexus-stream";
// 2 was a resize, which nothing sends since streams lost their pty, so the other numbers stay as older peers know them.
const frameType = { data: 0, eof: 1, exit: 3 } as const;
const maxFrameBytes = 16 << 20;

function streamPath(pylonId: PylonId, argv: readonly string[]): string {
  return `/v1/pylons/${encodeURIComponent(pylonId)}/stream?request=${encodeURIComponent(JSON.stringify({ argv }))}`;
}

const streamRequestSchema = z.object({
  argv: z.array(z.string()).min(1),
  pty: z.null({ error: "streams are raw pipes only, so a stream request has no pty. A terminal's pty is made in the guest, as guest-terminal.ts does" }).optional(),
});

/** The probe's side of the stream route: `null` unless the request asks to upgrade to `nexus-stream`. Throws with a message for a 400. */
export function parseStreamRequest(upgrade: string | undefined, url: URL): { pylonId: PylonId; argv: readonly string[] } | null {
  const match = /^\/v1\/pylons\/([^/]+)\/stream$/.exec(url.pathname);
  if (match === null || upgrade?.toLowerCase() !== streamProtocol) return null;
  const { argv } = parseJson(streamRequestSchema, url.searchParams.get("request") ?? "null", "request");
  return { pylonId: decodeURIComponent(match[1]!) as PylonId, argv };
}

export const streamUpgradeResponse = `HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: ${streamProtocol}\r\n\r\n`;

/**
 * The probe's side of an upgraded stream: frames from the socket go into `stream`, and its output and exit code
 * go back. When the socket drops first, the process's stdin ends. Resolves once both directions are done.
 */
export async function serveByteStream(socket: Duplex, head: Buffer, stream: ByteStream): Promise<void> {
  const output = (async () => {
    let linked = true;
    // Output keeps being read after the link drops, so a process writing to a full pipe can still see its stdin end.
    for await (const chunk of stream) if (linked) await send(socket, frame(frameType.data, chunk)).catch(() => { linked = false; });
    const end = await stream.done;
    if (end.kind === "exited" && linked) {
      const code = Buffer.alloc(4);
      code.writeInt32BE(end.code);
      await send(socket, frame(frameType.exit, code)).catch(() => undefined);
      socket.end();
    } else {
      socket.destroy();
    }
  })();
  // A process can close its stdin and keep writing output, so a failed write drops input and keeps the socket:
  // leaving the loop would destroy it, and the output and exit code with it.
  let stdin = true;
  try {
    for await (const f of frames(socket, head)) {
      if (f.type === frameType.data) {
        if (stdin) await stream.write(f.payload).catch(() => { stdin = false; });
      } else if (f.type === frameType.eof) {
        await stream.close();
      } else {
        throw new Error(`unexpected stream frame type ${f.type}`);
      }
    }
  } catch {
    // The link broke or broke the protocol, so the input side is over.
  }
  await stream.close();
  await output;
}

function clientByteStream(socket: Duplex, head: Buffer): ByteStream {
  const output = new PassThrough();
  const done = (async (): Promise<StreamEnd> => {
    let code: number | null = null;
    try {
      for await (const f of frames(socket, head)) {
        if (f.type === frameType.data) {
          if (!output.write(f.payload)) await once(output, "drain");
        } else if (f.type === frameType.exit && f.payload.length === 4) {
          code = f.payload.readInt32BE(0);
        } else {
          throw new Error(`unexpected stream frame type ${f.type}`);
        }
      }
    } catch {
      // The link broke. Without an exit frame that is a lost stream.
    } finally {
      socket.destroy();
      output.end();
    }
    return code === null ? { kind: "lost" } : { kind: "exited", code };
  })();
  return {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>,
    write: (chunk) => send(socket, frame(frameType.data, chunk)),
    close: () => send(socket, frame(frameType.eof, Buffer.alloc(0))),
    abort: () => socket.destroy(),
    done,
  };
}

function frame(type: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function* frames(source: AsyncIterable<Buffer>, head: Buffer): AsyncGenerator<{ type: number; payload: Buffer }> {
  let buffered = head;
  function* complete() {
    while (buffered.length >= 5) {
      const length = buffered.readUInt32BE(1);
      if (length > maxFrameBytes) throw new Error(`stream frame of ${length} bytes is over ${maxFrameBytes}`);
      if (buffered.length < 5 + length) return;
      yield { type: buffered[0]!, payload: buffered.subarray(5, 5 + length) };
      buffered = buffered.subarray(5 + length);
    }
  }
  yield* complete();
  for await (const chunk of source) {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    yield* complete();
  }
  if (buffered.length > 0) throw new Error("the stream ended inside a frame");
}

/** Resolves once the bytes are handed to the kernel, which is the stream's backpressure. */
function send(socket: Duplex, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => { socket.write(bytes, (err) => err ? reject(err) : resolve()); });
}

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

const imageId = z.string().pipe(z.custom<ImageId>(isImageId, "expected an image ID"));
const templateId = z.string().pipe(z.custom<TemplateId>(isTemplateId, "expected a template ID"));
const checkpointId = z.string().startsWith("ckpt-", "expected a checkpoint ID").pipe(z.custom<CheckpointId>());
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a hex sha256");
/** An object, whatever it holds, which the receiver hands on as `T`. */
const objectAs = <T>() => z.custom<T>((value) => typeof value === "object" && value !== null && !Array.isArray(value), "expected an object");

const jobStatusFields = { jobId: named<JobId>(), subject: named<Subject>(), kind: named<Job["kind"]>() };
const jobStatusSchema = z.discriminatedUnion("state", [
  z.looseObject({ ...jobStatusFields, state: z.literal("running"), startedAt: unchecked<string>() }),
  z.looseObject({ ...jobStatusFields, state: z.literal("succeeded"), finishedAt: unchecked<string>() }),
  z.looseObject({
    ...jobStatusFields, state: z.literal("failed"), finishedAt: unchecked<string>(),
    code: z.enum(Object.keys(retryable) as JobErrorCode[]), message: unchecked<string>(), logTail: unchecked<string>(),
  }),
]) satisfies z.ZodType<JobStatus>;

const submitReplySchemas: Partial<Record<number, z.ZodType<SubmitReply>>> = {
  [submitStatus.accepted]: z.object({ accepted: asSent(jobStatusSchema) }),
  [submitStatus.busy]: z.object({ rejected: z.literal("busy"), inFlight: named<JobId>() }),
  [submitStatus.expired]: z.object({ rejected: z.literal("expired") }),
  [submitStatus.invalid]: z.object({ rejected: z.literal("invalid"), message: nonEmpty }),
};

export function parseSubmitReply(status: number, body: string): SubmitReply {
  const schema = submitReplySchemas[status];
  if (schema === undefined) throw new Error(`unexpected submit reply, HTTP ${status}: ${body}`);
  return parseJson(schema, body, "reply");
}

const pylonIdField = named<PylonId>();
const olderPylonSchema = z.discriminatedUnion("phase", [
  z.looseObject({ pylonId: pylonIdField, phase: z.enum(["booting", "stopping", "deleting"]) }),
  z.looseObject({ pylonId: pylonIdField, phase: z.literal("stopped"), checkpoint: unchecked<CheckpointId | null>(), sessions: unchecked<readonly PausedSession[] | null>() }),
  z.looseObject({ pylonId: pylonIdField, phase: z.literal("broken"), detail: unchecked<string>(), cause: unchecked<string>() }),
  z.looseObject({
    pylonId: pylonIdField, phase: z.literal("running"), liveHash: unchecked<LiveHash | null>(), bootedAt: unchecked<string>(),
    bootedFrom: unchecked<RunningFacts["bootedFrom"]>(), services: unchecked<RunningFacts["services"]>(), listening: unchecked<RunningFacts["listening"]>(),
    previews: unchecked<RunningFacts["previews"]>(), sessions: unchecked<readonly (SessionFact | OlderSession)[] | null>(), git: unchecked<GitFacts | null>(),
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

const fresh = z.looseObject({ kind: z.literal("fresh"), preSetup: nonEmpty.nullable() });
const bootSchema = z.looseObject({
  gitIdentity: unchecked<BootInputs["gitIdentity"]>(),
  pylonId: pylonIdField,
  image: imageId,
  source: z.discriminatedUnion("kind", [
    z.looseObject({ kind: z.literal("template"), template: templateId }),
    z.looseObject({ kind: z.literal("resume"), checkpoint: unchecked<CheckpointId>() }),
    fresh,
  ]),
  resources: unchecked<BootInputs["resources"]>(),
  network: unchecked<BootInputs["network"]>(),
  repo: z.discriminatedUnion("kind", [
    z.looseObject({ kind: z.literal("clone"), url: nonEmpty, checkout: z.looseObject({ branch: nonEmpty, commit: nonEmpty }) }),
    z.looseObject({ kind: z.literal("empty"), branch: nonEmpty }),
  ], {
    error: (issue) => issue.code === "invalid_union" && (issue.input as { kind?: unknown }).kind === undefined
      ? "missing, so the control plane that sent it is older than this probe. Upgrade the control plane, then its probes" : undefined,
  }),
  dotfiles: unchecked<BootInputs["dotfiles"]>(),
}) satisfies z.ZodType<BootInputs>;

const jobSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("spawn"), pylonId: pylonIdField, boot: bootSchema,
    live: z.looseObject({ previews: z.array(unchecked<LiveSpec["previews"][number]>()), overlay: z.array(unchecked<LiveSpec["overlay"][number]>()) }),
    liveHash: named<LiveHash>(), relaunch: z.literal(false).exactOptional(),
  }).refine((job) => job.boot.pylonId === job.pylonId, { path: ["boot", "pylonId"], message: "differs from job.pylonId" }),
  z.looseObject({ kind: z.literal("pause"), pylonId: pylonIdField, checkpoint: checkpointId }),
  z.looseObject({ kind: z.literal("delete"), pylonId: pylonIdField }),
  z.looseObject({ kind: z.literal("build-image"), image: imageId, recipe: objectAs<ImageRecipe>() }),
  z.looseObject({ kind: z.literal("build-template"), template: templateId, inputs: objectAs<TemplateBuildInputs>() }),
  z.looseObject({
    kind: z.literal("fetch-artifact"),
    // A checkpoint passes, for runJob to refuse with its reason.
    artifact: z.string().refine((id) => isPortableArtifactId(id) || id.startsWith("ckpt-"), "expected an artifact ID").pipe(z.custom<ArtifactId>()),
    from: named<NodeName>(), sha256,
  }),
  z.looseObject({ kind: z.literal("drop-artifact"), artifact: z.string().pipe(z.custom<PortableArtifactId>(isPortableArtifactId, "expected an image or template ID, and no job drops a checkpoint")) }),
]) satisfies z.ZodType<Job>;

const timestamp = z.string().min(1).refine((t) => !Number.isNaN(Date.parse(t)), "expected a timestamp");
const jobEnvelopeSchema = z.looseObject({
  jobId: named<JobId>(), node: named<NodeName>(), issuedAt: timestamp, notAfter: timestamp, job: jobSchema,
}) satisfies z.ZodType<JobEnvelope>;

/** The probe's side of PUT /v1/jobs/{jobId}. Throws with a message for the `invalid` reply. */
export function parseJobEnvelope(body: string): JobEnvelope {
  return parseJson(asSent(jobEnvelopeSchema), body, "envelope");
}

const port = z.int().min(1).max(65535).refine((p) => !reservedPorts.has(p), reservedPortMessage);
const claudeOnly = z.never({ error: "only a Claude Code session takes it" }).exactOptional();
const openSession = { kind: z.literal("open-session"), title: nonEmpty };
const pylonCommandSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("exec"), argv: z.array(z.string()).min(1), cwd: z.string().startsWith("/", "expected an absolute path"), timeoutMs: z.int().min(1).max(60_000) }),
  z.discriminatedUnion("harness", [
    z.looseObject({ ...openSession, harness: z.literal("claude-code"), resume: nonEmpty.exactOptional(), prompt: nonEmpty.max(16_384).exactOptional(), model: nonEmpty.max(200).exactOptional() }),
    z.looseObject({ ...openSession, harness: z.literal("pi"), resume: nonEmpty.exactOptional(), prompt: claudeOnly, model: claudeOnly }),
    z.looseObject({ ...openSession, harness: z.literal("shell"), resume: z.never({ error: "a shell session has nothing to resume" }).exactOptional(), prompt: claudeOnly, model: claudeOnly }),
  ]),
  z.looseObject({
    kind: z.literal("close-session"), herdrPane: nonEmpty,
    session: z.looseObject({ harness: sessionHarnessSchema, harnessSessionId: nonEmpty.nullable(), title: nonEmpty.nullable() }).exactOptional(),
  }),
  z.looseObject({ kind: z.literal("drop-failed-session"), id: nonEmpty }),
  z.looseObject({
    kind: z.literal("send-claude"),
    session: z.string().regex(/^[A-Za-z0-9-]{1,200}$/, "expected a Claude Code session ID"),
    text: nonEmpty.max(16_384).superRefine((t, ctx) => {
      const problem = claudeTextProblem(t);
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
    }),
    model: nonEmpty.max(200).exactOptional(),
    requestId: nonEmpty.exactOptional(),
  }),
  z.looseObject({ kind: z.literal("send-claude-outcome"), requestId: nonEmpty }),
  z.looseObject({
    kind: z.literal("service"), op: z.enum(["ensure", "restart", "stop", "logs"]), name: nonEmpty.exactOptional(),
    lines: z.number().min(1).refine(Number.isInteger, "expected an integer").exactOptional(),
  }),
  z.looseObject({ kind: z.literal("link-port"), port }),
  z.looseObject({ kind: z.literal("unlink-port"), port }),
]) satisfies z.ZodType<PylonCommand>;

/**
 * The probe's side of POST /v1/pylons/{id}/commands. Throws with a message for a 400. A pylon that is
 * not running gets a 409, which the client reports as not-running.
 */
export function parsePylonCommand(body: string): PylonCommand {
  return parseJson(asSent(pylonCommandSchema), body, "command");
}

const sendSchema = z.looseObject({ outcome: z.enum(["sent", "queued", "blocked", "starting", "moved"] satisfies SendClaudeOutcome[]), herdrPane: nonEmpty, resumed: z.boolean() });
const commandResultSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("exec"), exitCode: unchecked<number | null>(), output: unchecked<string>(), truncated: unchecked<boolean>() }),
  z.looseObject({ kind: z.literal("open-session"), herdrPane: nonEmpty }),
  z.looseObject({ kind: z.literal("close-session"), outcome: z.enum(["closed", "not-open", "moved"]).nullish() }),
  z.looseObject({ kind: z.literal("drop-failed-session"), dropped: z.boolean() }),
  z.looseObject({ kind: z.literal("send-claude"), ...sendSchema.shape }),
  z.looseObject({ kind: z.literal("send-claude-outcome"), send: z.union([z.enum(["failed", "unknown"]), sendSchema], { error: "expected failed, unknown or what the send became" }) }),
  z.looseObject({ kind: z.literal("service"), services: unchecked<readonly ServiceFact[]>(), logs: unchecked<string>() }),
  z.looseObject({ kind: z.literal("link-port"), service: nonEmpty }),
  z.looseObject({ kind: z.literal("unlink-port"), refused: nonEmpty.nullable() }),
]);

function parseCommandResult(command: PylonCommand, body: string): CommandResult {
  const result = parseJson(asSent(commandResultSchema), body, "result");
  if (result.kind !== command.kind) throw new Error(`a ${command.kind} command got a ${result.kind} result`);
  // A probe that reported every close as done sends no outcome.
  return result.kind === "close-session" ? { ...result, outcome: result.outcome ?? "closed" } : result;
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
  | (Omit<Extract<PylonObservation, { phase: "running" }>, "listening" | "sessions"> & { listening?: readonly ListeningFact[] | null; sessions: readonly (SessionFact | OlderSession)[] | null })
  | (Omit<Extract<PylonObservation, { phase: "stopped" }>, "sessions"> & { sessions?: readonly PausedSession[] | null })
  | (Omit<Extract<PylonObservation, { phase: "broken" }>, "cause"> & { cause?: string });
/** A session from a probe older than session states, which reported only sessions in panes. */
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
 * - A stopped pylon's sessions null, as from a pause that recorded nothing.
 * - A broken pylon's cause unknown, as is one this control plane does not know.
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
      sessions: p.sessions?.map((s): SessionFact => s.state === undefined ? { ...s, state: "running", id: s.herdrPane } : s) ?? null,
    };
    case "stopped": return { ...p, sessions: p.sessions ?? null };
    case "broken": return { ...p, cause: brokenCauses.has(p.cause) ? p.cause as BrokenCause | "unknown" : "unknown" };
    default: return p;
  }
}

// Probe-to-probe artifact copies: GET /v1/artifacts/{id} answers with the manifest in a header and the archive as the body.

const manifestHeader = "x-nexus-manifest";
/** A copy that sends nothing for this long has broken off. tar can be slow to start on a large sparse file. */
const artifactIdleMs = 60_000;

/** The probe's side of GET /v1/artifacts/{id}: the headers ahead of the archive. */
export function artifactHeaders(manifest: ArtifactManifest): Record<string, string> {
  return { "content-type": "application/octet-stream", [manifestHeader]: Buffer.from(JSON.stringify(manifest)).toString("base64url") };
}

/** A peer's copy of an artifact, or why the peer refused it: it holds another sha256 under that ID. */
export type ArtifactCopy = { manifest: ArtifactManifest; stream: Readable } | { refused: string };

/**
 * fetch-artifact's side: GET /v1/artifacts/{id}?sha256= from a peer probe, which whois must name as one of
 * `peers`. A peer that holds other bytes under the ID refuses before it sends any. The stream is unverified:
 * ArtifactStore.import checks it against the manifest's sha256 before anything uses it.
 */
export function fetchArtifact(peer: { host: string; port: number }, artifact: PortableArtifactId, sha256: string, check: { whois: Whois; peers: readonly TailnetNodeId[] }, signal: AbortSignal): Promise<ArtifactCopy> {
  const path = `/v1/artifacts/${encodeURIComponent(artifact)}?sha256=${encodeURIComponent(sha256)}`;
  const where = `${peer.host}:${peer.port}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: peer.host, port: peer.port, method: "GET", path, agent: false, timeout: artifactIdleMs, signal }, (res) => {
      const { remoteAddress, remotePort } = res.socket;
      if (remoteAddress === undefined || remotePort === undefined) {
        res.destroy();
        return reject(probeError("unreachable", `${where}: the connection closed before whois`));
      }
      check.whois(remoteAddress, remotePort).then((id) => {
        if (id === null || !check.peers.includes(id)) {
          res.destroy();
          return reject(probeError("forbidden", `${where} is tailnet node ${id ?? "unknown"}, which is not a configured peer`));
        }
        if (res.statusCode === 409) return text(res).then((refused) => resolve({ refused }), reject);
        if (res.statusCode !== 200) return text(res).then((body) => reject(new Error(`${where}: GET ${path}: HTTP ${res.statusCode}: ${body}`)), reject);
        let manifest: ArtifactManifest;
        try {
          manifest = parseArtifactManifest(JSON.parse(Buffer.from(String(res.headers[manifestHeader]), "base64url").toString("utf8")));
        } catch (err) {
          res.destroy();
          return reject(new Error(`${where}: GET ${path} sent no readable manifest: ${(err as Error).message}`));
        }
        resolve({ manifest, stream: res });
      }, (err: unknown) => { res.destroy(); reject(err); });
    });
    req.on("timeout", () => req.destroy(new Error(`${where} sent nothing for ${artifactIdleMs} ms`)));
    req.on("error", (err) => reject(signal.aborted ? err : probeError("unreachable", `${where}: ${err.message}`)));
    req.end();
  });
}

const imageManifestSchema = z.looseObject({
  id: imageId, gondolinBuildId: nonEmpty, pins: objectAs<ImageRecipe["pins"]>(), builtOn: named<NodeName>(), builtAt: nonEmpty, sha256,
}) satisfies z.ZodType<ImageManifest>;
const templateManifestSchema = z.looseObject({
  id: templateId, key: z.looseObject({ project: named<ProjectId>(), image: imageId, setupHash: nonEmpty }), commit: nonEmpty, builtAt: nonEmpty, sha256,
}) satisfies z.ZodType<TemplateManifest>;

/** A manifest from a peer's header or from an artifact directory. */
export function parseArtifactManifest(value: unknown): ArtifactManifest {
  const { id } = parse(z.looseObject({ id: nonEmpty }), value, "manifest");
  if (isImageId(id)) return parse(asSent(imageManifestSchema), value, "manifest");
  if (isTemplateId(id)) return parse(asSent(templateManifestSchema), value, "manifest");
  throw new Error(`manifest.id: ${id} is neither an image nor a template ID`);
}
