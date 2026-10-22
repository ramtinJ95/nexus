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
 * - The wire encoding (JSON over HTTP, and newline-delimited JSON events on observe) is private to this
 *   module. Callers see the domain types below. The control plane reads through `parseProbeEvent` and
 *   `parseSubmitReply`, and the probe through `parseJobEnvelope`, `encodeSubmitReply` and `encodeProbeEvent`.
 */
import { Agent, request, type IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { localApiWhois, type Whois } from "./tailscale.ts";
import type { BootInputs, LiveSpec, SessionHarness } from "./project.ts";
import type { CheckpointId, ImageId, ImageRecipe, PortableArtifactId, ArtifactId, TemplateBuildInputs, TemplateId } from "./images.ts";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type NodeName = Brand<string, "NodeName">; // "rj-firebat", "infra-testbench"
/** `pylon-${threadId}`. At most 40 characters, the pi-sandbox name limit, so thread IDs are at most 34. */
export type PylonId = Brand<string, "PylonId">;
export type JobId = Brand<string, "JobId">; // UUID minted by the control plane
/** sha256 of the canonical LiveSpec. Observations echo it, so the planner sees drift without a counter. */
export type LiveHash = Brand<string, "LiveHash">;

// Jobs: Amp's spawn, pause and delete, plus the artifact work Amp does on its own servers.

export type Job =
  | { kind: "spawn"; pylonId: PylonId; boot: BootInputs; live: LiveSpec; liveHash: LiveHash }
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
 * so the planner sends spawn again.
 *
 * pause records the open Herdr sessions in /home/user/.nexus/sessions.json, stops services, writes the
 * disk checkpoint and stops the VM. The session list is on the disk, so the checkpoint carries it and a
 * session opened a second before the pause is still relaunched. delete removes the VM, its checkpoint,
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
  node: NodeName;
  observedAt: string;
  /** A new value after every probe restart. It tells the control plane that in-memory job results are gone. */
  probeBootId: string;
  capacity: { memoryGiB: number; committedMemoryGiB: number; diskFreeGiB: number };
  artifacts: readonly ArtifactId[];
  /**
   * Running jobs, plus results from the last 10 minutes. Read before `pylons`, so `pylons` shows the result of
   * every job listed here as finished. The planner relies on that: a job event can arrive before the snapshot
   * that shows its result, and planning against the older snapshot would send the job again.
   */
  jobs: readonly JobStatus[];
  /** A pylon absent from this list does not exist on the node. A listed pylon the registry does not know is an orphan: shown, never deleted. */
  pylons: readonly PylonObservation[];
}

export type PylonObservation =
  | { pylonId: PylonId; phase: "booting" | "stopping" | "deleting" }
  | { pylonId: PylonId; phase: "stopped"; checkpoint: CheckpointId | null }
  | { pylonId: PylonId; phase: "broken"; detail: string } // the backend reports it interrupted or failed
  | ({ pylonId: PylonId; phase: "running" } & RunningFacts);

export interface RunningFacts {
  liveHash: LiveHash | null; // null until the probe has applied a LiveSpec since its own start
  bootedAt: string;
  bootedFrom: { image: ImageId; checkpoint: CheckpointId | null };
  services: readonly ServiceFact[];
  previews: readonly { service: string; httpsPort: number; ready: boolean }[];
  sessions: readonly SessionFact[];
  git: GitFacts | null; // null until the first poll, or when the checkout is missing
  declaredOutputs: readonly DeclaredOutput[];
  attachedClients: number; // open terminal streams, counted as human presence
}

export interface ServiceFact { name: string; state: "starting" | "ready" | "failed" | "stopped"; port: number; declared: boolean; wantsPreview: boolean }
export interface SessionFact { herdrPane: string; harness: SessionHarness; harnessSessionId: string | null; status: "working" | "idle" | "blocked" | "done" }
export interface GitFacts { head: string; branch: string | null; dirty: boolean; branches: readonly { name: string; head: string; pushedAs: string | null }[] }
export type DeclaredOutput =
  | { id: string; kind: "file"; path: string; title: string | null; sha256: string }
  | { id: string; kind: "diff"; base: string; sha256: string; title: string | null };

export type ProbeEvent =
  | { type: "snapshot"; observation: NodeObservation } // on connect, then every 60 s as anti-entropy
  | { type: "pylon"; pylon: PylonObservation }
  | { type: "job"; status: JobStatus }
  /** A preview was requested. A paused pylon keeps its previews, so its browser gets a self-refreshing "waking" page while the control plane decides. */
  | { type: "preview-hit"; pylonId: PylonId; service: string; at: string; login: string | null };

// Synchronous guest operations. They are not reconciled and not queued behind lifecycle jobs.
// Everything runs as `user`. pi-sandbox fixes the shell user for the life of an instance, and `user`
// has passwordless sudo, so a root command is `["sudo", ...]`.

export type PylonCommand =
  /** When the timeout passes, the probe calls pi-sandbox's exec-kill and returns exitCode null. Timeout at most 60 s. */
  | { kind: "exec"; argv: readonly string[]; cwd: string; timeoutMs: number }
  | { kind: "open-session"; harness: SessionHarness; title: string; resume?: string }
  | { kind: "close-session"; herdrPane: string }
  | { kind: "service"; op: "ensure" | "restart" | "stop" | "logs"; name?: string; lines?: number };

export type CommandResult =
  | { kind: "exec"; exitCode: number | null; output: string; truncated: boolean }
  | { kind: "open-session"; herdrPane: string }
  | { kind: "close-session" }
  | { kind: "service"; services: readonly ServiceFact[]; logs?: string };

export interface StreamRequest {
  pty: { cols: number; rows: number } | null; // null for raw stdio, such as the pi-env daemon
  argv: readonly string[];
}

/**
 * A pipe runs at most once. If the connection drops, the guest process gets SIGHUP and `done` resolves
 * to `lost`, which pi-durable reports to the model as an interrupted tool. Dropping a pty only detaches,
 * and Herdr keeps the session.
 */
export type StreamEnd = { kind: "exited"; code: number } | { kind: "lost" };
export interface ByteStream extends AsyncIterable<Uint8Array> {
  write(chunk: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): void; // no-op without a pty
  close(): Promise<void>;
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
  stream(pylonId: PylonId, request: StreamRequest): Promise<ByteStream>;
}

/** Tailscale's stable node ID, as LocalAPI whois reports it. It survives renames and address changes. */
export type TailnetNodeId = Brand<string, "TailnetNodeId">;

export const probePort = 7480;
const requestTimeoutMs = 10_000;

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
  function open(method: "GET" | "PUT", path: string, body: string | null, signal?: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request({ host: tailnetHost, port, method, path, agent, timeout: requestTimeoutMs, ...(signal ? { signal } : {}) }, (res) => {
        const { remoteAddress, remotePort } = res.socket;
        if (remoteAddress === undefined || remotePort === undefined) {
          res.destroy();
          return reject(probeError("unreachable", `${node}: the connection closed before whois`));
        }
        whois(remoteAddress, remotePort).then((id) => {
          if (id !== expected) {
            res.destroy();
            return reject(probeError("forbidden", `${node}: ${remoteAddress}:${remotePort} is tailnet node ${id ?? "unknown"}, expected ${expected}`));
          }
          if (res.statusCode === 403) {
            res.destroy();
            return reject(probeError("forbidden", `${node} refused this caller`));
          }
          resolve(res);
        }, (err: unknown) => { res.destroy(); reject(err); });
      });
      req.on("timeout", () => req.destroy(new Error(`no answer within ${requestTimeoutMs} ms`)));
      req.on("error", (err) => reject(signal?.aborted ? err : probeError("unreachable", `${node}: ${err.message}`)));
      if (body !== null) req.setHeader("content-type", "application/json");
      req.end(body ?? undefined);
    });
  }

  async function call(method: "GET" | "PUT", path: string, body: string | null = null): Promise<{ status: number; body: string }> {
    const res = await open(method, path, body);
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
      return parseJobStatus(JSON.parse(res.body));
    },
    async *observe(signal) {
      const res = await open("GET", "/v1/observe", null, signal);
      if (res.statusCode !== 200) throw new Error(`${node}: GET /v1/observe: HTTP ${res.statusCode}: ${await text(res)}`);
      // The first snapshot arrives with the headers. After that, events can be a minute apart.
      res.socket.setTimeout(0);
      for await (const line of lines(res)) yield parseProbeEvent(line);
    },
    command() { return Promise.reject(new Error("POST /v1/pylons/{id}/commands is not implemented in this slice")); },
    stream() { return Promise.reject(new Error("GET /v1/pylons/{id}/stream is not implemented in this slice")); },
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

export function parseSubmitReply(status: number, body: string): SubmitReply {
  const reply = record(JSON.parse(body), "submit reply");
  if (status === submitStatus.accepted) return { accepted: parseJobStatus(reply.accepted) };
  if (status === submitStatus.busy && reply.rejected === "busy") return { rejected: "busy", inFlight: string(reply.inFlight, "inFlight") as JobId };
  if (status === submitStatus.expired && reply.rejected === "expired") return { rejected: "expired" };
  if (status === submitStatus.invalid && reply.rejected === "invalid") return { rejected: "invalid", message: string(reply.message, "message") };
  throw new Error(`unexpected submit reply, HTTP ${status}: ${body}`);
}

/** One line of the observe stream, newline included. */
export function encodeProbeEvent(event: ProbeEvent): string {
  return JSON.stringify(event) + "\n";
}

export function parseProbeEvent(frame: string): ProbeEvent {
  const event = record(JSON.parse(frame), "probe event");
  switch (event.type) {
    case "snapshot": {
      const o = record(event.observation, "observation");
      for (const key of ["artifacts", "jobs", "pylons"] as const) {
        if (!Array.isArray(o[key])) throw new Error(`observation.${key} is not an array`);
      }
      (o.jobs as unknown[]).forEach(parseJobStatus);
      (o.pylons as unknown[]).forEach(parsePylonObservation);
      return event as ProbeEvent;
    }
    case "pylon": parsePylonObservation(event.pylon); return event as ProbeEvent;
    case "job": parseJobStatus(event.status); return event as ProbeEvent;
    case "preview-hit": string(event.pylonId, "pylonId"); return event as ProbeEvent;
    default: throw new Error(`unknown probe event type ${JSON.stringify(event.type)}`);
  }
}

/** The probe's side of PUT /v1/jobs/{jobId}. Throws with a message for the `invalid` reply. */
export function parseJobEnvelope(body: string): JobEnvelope {
  const env = record(JSON.parse(body), "envelope");
  for (const key of ["issuedAt", "notAfter"] as const) {
    if (Number.isNaN(Date.parse(string(env[key], key)))) throw new Error(`${key} is not a timestamp`);
  }
  string(env.jobId, "jobId");
  string(env.node, "node");
  const job = record(env.job, "job");
  switch (job.kind) {
    case "spawn": {
      const pylonId = string(job.pylonId, "job.pylonId");
      const boot = record(job.boot, "job.boot");
      if (boot.pylonId !== pylonId) throw new Error("job.boot.pylonId differs from job.pylonId");
      if (!string(boot.image, "job.boot.image").startsWith("img-")) throw new Error("job.boot.image is not an image ID");
      const source = record(boot.source, "job.boot.source");
      if (source.kind !== "template" && source.kind !== "resume" && source.kind !== "fresh") throw new Error("job.boot.source.kind is not template, resume or fresh");
      if (source.kind === "fresh" && source.preSetup !== null) string(source.preSetup, "job.boot.source.preSetup");
      const live = record(job.live, "job.live");
      if (!Array.isArray(live.previews) || !Array.isArray(live.overlay)) throw new Error("job.live needs previews and overlay arrays");
      string(job.liveHash, "job.liveHash");
      break;
    }
    case "pause":
      string(job.pylonId, "job.pylonId");
      if (!string(job.checkpoint, "job.checkpoint").startsWith("ckpt-")) throw new Error("job.checkpoint is not a checkpoint ID");
      break;
    case "delete":
      string(job.pylonId, "job.pylonId");
      break;
    case "build-image": case "build-template": case "fetch-artifact": case "drop-artifact":
      break;
    default: throw new Error(`unknown job kind ${JSON.stringify(job.kind)}`);
  }
  return env as unknown as JobEnvelope;
}

function parseJobStatus(value: unknown): JobStatus {
  const s = record(value, "job status");
  string(s.jobId, "status.jobId");
  string(s.subject, "status.subject");
  string(s.kind, "status.kind");
  if (s.state !== "running" && s.state !== "succeeded" && s.state !== "failed") throw new Error(`unknown job state ${JSON.stringify(s.state)}`);
  if (s.state === "failed" && !(string(s.code, "status.code") in retryable)) throw new Error(`unknown job error code ${JSON.stringify(s.code)}`);
  return s as unknown as JobStatus;
}

const pylonPhases: ReadonlySet<unknown> = new Set(["booting", "stopping", "deleting", "stopped", "broken", "running"] satisfies PylonObservation["phase"][]);
function parsePylonObservation(value: unknown): PylonObservation {
  const p = record(value, "pylon observation");
  string(p.pylonId, "pylon.pylonId");
  if (!pylonPhases.has(p.phase)) throw new Error(`unknown pylon phase ${JSON.stringify(p.phase)}`);
  return p as unknown as PylonObservation;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${what} is not a non-empty string`);
  return value;
}
