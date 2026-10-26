import { dirname } from "node:path";
import { eventJournal } from "./event-journal.ts";
import { runningCommit } from "../deploy/health.ts";
/**
 * The probe's HTTP server: lifecycle jobs and observations. It keeps job results and applied live hashes in
 * memory only. Everything durable is the backend's, so a restart loses nothing a later job cannot rebuild.
 */
import { randomUUID } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import { availableParallelism, totalmem } from "node:os";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { JobFailure, runCommand, runJob, type BackendPylon, type ProbeDeps, type VmBackend } from "../backend.ts";
import type { PortableArtifactId } from "../images.ts";
import {
  artifactHeaders, encodeProbeEvent, encodeSubmitReply, fetchArtifact, heldSecrets, isPortableArtifactId, jobDeadlineMs, probePort, jobSubject, parseJobEnvelope, parsePylonCommand, parseStreamRequest, routeAuth, serveByteStream, streamUpgradeResponse,
  type Job, type JobEnvelope, type JobId, type JobStatus, type LiveHash, type NodeName, type NodeObservation,
  type DeclaredOutput, type GitFacts, type ListeningFact, type ProbeAuthConfig, type CommandResult, type ProbeEvent, type PylonCommand, type PylonId, type PylonObservation, type ServiceFact, type SessionFact, type Subject,
} from "../protocol.ts";
import type { ServiceName } from "../project.ts";
import { attachedTerminals, sessionFacts } from "../sessions.ts";
import { onePerClaudeSession } from "../session-wake.ts";
import type { Whois } from "../tailscale.ts";
import { listOutputs } from "../outputs.ts";
import { listeningFacts } from "../listening.ts";
import { gitFacts } from "../git-facts.ts";
import { startGateway } from "./gateway.ts";
import { createPylonApi, type HostBridge } from "./pylon-api.ts";
import { createTailscaleServe, parseServeStatus, readRoutes, type HttpsGet, type TailscaleCli } from "./serve.ts";
import type { NodeSecrets } from "./config.ts";

export interface ProbeOptions {
  eventJournal?: string;
  node: NodeName;
  host: string;
  /** 0 picks a free port. */
  port: number;
  auth: ProbeAuthConfig;
  whois: Whois;
  backend: VmBackend;
  secrets: NodeSecrets;
  /** Whether the backend has a git SSH key, so a pylon can clone over SSH. Default false. */
  gitSsh?: boolean;
  jobDeadlineMs?: { readonly [K in Job["kind"]]: number };
  /** The probe's log, which also receives the stderr of raw pipes. Default console.error. */
  log?: (message: string) => void;
  /** Omitted: the probe publishes no previews, and a spawn that assigns one fails. */
  previews?: {
    /** Keep it fixed across restarts. Serve entries that proxy to this loopback port are the probe's. */
    gatewayPort: number;
    /** A JSON file in the probe's state directory. It keeps paused pylons' routes across probe restarts. */
    routesFile: string;
    tailscale: TailscaleCli;
    /** Tests only. The probe warms each new URL with fetch. */
    get?: HttpsGet;
  };
  /** Tests only. A peer probe is its tailnet machine name on probePort. */
  peerAddress?: (node: NodeName) => { host: string; port: number };
  /** The backend's end of NEXUS_API, which the in-pylon `nexus` CLI calls. Omitted: those calls go unanswered. */
  hostBridge?: HostBridge;
  /** How often each running pylon's listening ports are read for a change between snapshots. Default 10 s. */
  listeningPollMs?: number;
}

export interface Probe {
  readonly port: number;
  readonly bootId: string;
  /** Aborts running jobs, as a crash would, and closes every connection. */
  close(): Promise<void>;
}

const jobRetentionMs = 10 * 60_000;
const snapshotIntervalMs = 60_000;
const maxBodyBytes = 1 << 20;
const maxSecretBytes = 16_384;
/** RFC 6750's b64token, the alphabet bearer tokens are written in. */
const tokenAlphabet = /^[A-Za-z0-9\-._~+/]+=*$/;
const sum = (pylons: readonly BackendPylon[], resource: keyof NonNullable<BackendPylon["holds"]>) => pylons.reduce((total, p) => total + (p.holds?.[resource] ?? 0), 0);
/** Short, because snapshots are read one at a time and a stuck guest would hold up every observer. */
const sessionReadTimeoutMs = 3_000;
/** Longer, because a pylon's supervisor checks each service's health to answer. */
const serviceReadTimeoutMs = 5_000;
const gitPollMs = 60_000;
const claudeSendMemoryMs = 60 * 60_000;

/** A probe without a preview gateway. An empty set is already converged. */
const noPreviews: ProbeDeps["serve"] = {
  async converge(_pylonId, previews) {
    if (previews.length > 0) throw new JobFailure("invalid", "this probe was started without a preview gateway");
  },
  async withdraw() {},
};

export async function startProbe(options: ProbeOptions): Promise<Probe> {
  const { node, backend, auth, whois } = options;
  const deadlines = options.jobDeadlineMs ?? jobDeadlineMs;
  const peerAddress = options.peerAddress ?? ((peer: NodeName) => ({ host: peer, port: probePort }));
  const bootId = randomUUID();
  if (options.eventJournal !== undefined) await mkdir(dirname(options.eventJournal), { recursive: true, mode: 0o700 });
  const journal = eventJournal(options.eventJournal ?? ":memory:");
  const shutdown = new AbortController();
  const previews = options.previews === undefined ? null : {
    ...options.previews,
    gateway: await startGateway({
      port: options.previews.gatewayPort,
      routes: await readRoutes(options.previews.routesFile),
      origin: ({ pylonId, service }) => backend.guest(pylonId).previewOrigin(service),
      onHit: (hit) => emit({ type: "preview-hit", ...hit }),
    }),
  };
  const liveHashes = new Map<PylonId, LiveHash>();
  /** The previews of each pylon's last successful spawn in this process, which published and warmed them. */
  const published = new Map<PylonId, Extract<Job, { kind: "spawn" }>["live"]["previews"]>();
  /**
   * Each pylon's services that were unlinked and not linked again. No spawn routes them: one that carries them was
   * planned before the unlink, whenever it reaches the probe.
   */
  const unlinked = new Map<PylonId, Set<ServiceName>>();
  /** Bumped when a pylon's routes stop matching a spawn's live spec, so a spawn in flight across it does not count as applied. */
  const diverged = new Map<PylonId, number>();
  const diverge = (pylonId: PylonId) => diverged.set(pylonId, (diverged.get(pylonId) ?? 0) + 1);
  const relinked = (pylonId: PylonId, service: ServiceName) => unlinked.get(pylonId)?.delete(service);
  const serve = previews === null ? noPreviews : createTailscaleServe({ cli: previews.tailscale, gateway: previews.gateway, routesFile: previews.routesFile, get: previews.get });
  const deps: ProbeDeps = {
    backend,
    secrets: options.secrets,
    serve: {
      converge(pylonId, assigned, signal) {
        const gone = unlinked.get(pylonId);
        const routed = assigned.filter((p) => !gone?.has(p.service));
        if (routed.length < assigned.length) diverge(pylonId);
        return serve.converge(pylonId, routed, signal);
      },
      // The pylon no longer has what its last spawn applied, so the planner spawns again. A port linked again before
      // a snapshot saw it unlinked gets its route back that way, as its registry row and live hash did not change.
      // Recorded first, so a converge that starts while the route is withdrawn leaves the service out.
      async withdraw(pylonId, service) {
        let gone = unlinked.get(pylonId);
        if (gone === undefined) unlinked.set(pylonId, gone = new Set());
        gone.add(service);
        diverge(pylonId);
        await serve.withdraw(pylonId, service);
        liveHashes.delete(pylonId);
        const kept = published.get(pylonId)?.filter((p) => p.service !== service);
        if (kept !== undefined) published.set(pylonId, kept);
      },
    },
    node,
    fetchPeer: (from, artifact, sha256, signal) => fetchArtifact(peerAddress(from), artifact, sha256, { whois, peers: auth.peers }, signal),
  };
  const jobs = new Map<JobId, { status: JobStatus; finishedAt: number | null }>();
  const busy = new Map<Subject, JobId>();
  const observers = new Set<{ write(event: ProbeEvent): void; drop(err: Error): void }>();
  const runningJobs = new Set<Promise<void>>();
  const log = options.log ?? console.error;
  /** Upgraded sockets, which the HTTP server no longer tracks, so close() ends them itself. */
  const streamSockets = new Set<Duplex>();
  /** The listening ports each pylon's last observation reported, so a poll can tell when they changed. */
  const reportedListening = new Map<PylonId, string>();

  const emit = (event: ProbeEvent) => { if (!shutdown.signal.aborted) for (const observer of observers) observer.write(event); };
  const api = createPylonApi({
    event: (pylon, event) => emit({ type: "session-event", report: journal.append(pylon, event) }),
    guest: (pylonId) => backend.guest(pylonId),
    published: (pylonId) => published.get(pylonId) ?? [],
    changed: () => void publishSnapshot(),
    withdraw: (pylonId, service) => deps.serve.withdraw(pylonId, service),
    linked: relinked,
    async previewUrl(httpsPort) {
      if (previews === null) return null;
      const served = parseServeStatus(await previews.tailscale(["serve", "status", "--json"], shutdown.signal), previews.gateway.origin).get(httpsPort);
      return served?.kind === "nexus" ? served.url : null;
    },
  });

  function setStatus(status: JobStatus, finishedAt: number | null) {
    jobs.set(status.jobId, { status, finishedAt });
    emit({ type: "job", status });
  }

  function retainedJobs(): JobStatus[] {
    const cutoff = Date.now() - jobRetentionMs;
    for (const [id, job] of jobs) if (job.finishedAt !== null && job.finishedAt < cutoff) jobs.delete(id);
    return [...jobs.values()].map((job) => job.status);
  }

  // Keep timed-out reads registered until the controller answers, so later snapshots cannot pile up RPCs.
  const factReads = new Map<string, Promise<unknown>>();
  async function readFact<T>(pylonId: PylonId, kind: string, timeoutMs: number, read: () => Promise<T>): Promise<T> {
    const key = `${pylonId}:${kind}`;
    if (factReads.has(key)) throw new Error(`${kind} read is still outstanding`);
    const pending = Promise.resolve().then(read);
    factReads.set(key, pending);
    void pending.then(() => factReads.delete(key), () => factReads.delete(key));
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${kind} read exceeded ${timeoutMs} ms`)), timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The pylons whose last sessions read failed, so each failure is logged once, not on every read. */
  const unreadSessions = new Set<PylonId>();
  /**
   * Costs one guest exec (`herdr api snapshot`) per running pylon per snapshot, so a snapshot waits for the
   * slowest pylon, up to sessionReadTimeoutMs. A failed read reports null, never "no sessions", and is logged once,
   * until a read succeeds again.
   */
  async function sessions(pylonId: PylonId): Promise<readonly SessionFact[] | null> {
    try {
      const facts = await readFact(pylonId, "sessions", sessionReadTimeoutMs, () => sessionFacts(backend.guest(pylonId), sessionReadTimeoutMs));
      unreadSessions.delete(pylonId);
      return facts;
    } catch (err) {
      if (!unreadSessions.has(pylonId)) log(`${pylonId} sessions: ${(err as Error).message}. The control plane keeps the last list read until a read succeeds`);
      unreadSessions.add(pylonId);
      return null;
    }
  }

  /** The pylons whose last count of attached terminals failed, so each failure is logged once, not on every read. */
  const uncounted = new Set<PylonId>();
  /**
   * Terminals attached to the pylon's Herdr session. A count that fails reads as none, so it never keeps a pylon
   * awake nor fails the rest of the observation. It is logged once, until a count succeeds again.
   */
  async function attached(pylonId: PylonId): Promise<number> {
    try {
      const count = await readFact(pylonId, "attached", sessionReadTimeoutMs, () => attachedTerminals(backend.guest(pylonId), sessionReadTimeoutMs));
      uncounted.delete(pylonId);
      return count;
    } catch (err) {
      if (!uncounted.has(pylonId)) log(`${pylonId} attached terminals: ${(err as Error).message}. They count as none until a count succeeds`);
      uncounted.add(pylonId);
      return 0;
    }
  }

  /** A failed or late read reports null, never "no services", and is logged. */
  async function services(pylonId: PylonId): Promise<readonly ServiceFact[] | null> {
    const since = diverged.get(pylonId);
    try {
      const facts = (await readFact(pylonId, "services", serviceReadTimeoutMs, () => backend.guest(pylonId).services("list"))).services;
      // A service that wants a preview under an unlinked name, linked again or declared, may be routed again. Not
      // from a read that a withdraw overlapped, which may predate the unlink.
      if (diverged.get(pylonId) === since) for (const fact of facts) if (fact.wantsPreview) relinked(pylonId, fact.name);
      return facts;
    } catch (err) {
      log(`${pylonId} services: ${(err as Error).message}`);
      return null;
    }
  }

  /** A failed read reports null, never "nothing listens". */
  async function listening(pylonId: PylonId): Promise<readonly ListeningFact[] | null> {
    try {
      return await readFact(pylonId, "listening", sessionReadTimeoutMs, () => listeningFacts(backend.guest(pylonId), sessionReadTimeoutMs));
    } catch {
      return null;
    }
  }

  /**
   * An app that starts or stops listening gives the probe no event, so every running pylon's ports are read again
   * between snapshots, and a change publishes one. Without observers nobody would see it, so nothing is read.
   */
  let polling = false;
  async function pollListening() {
    if (polling || observers.size === 0) return;
    polling = true;
    try {
      const changed = await Promise.all((await backend.list()).filter((p) => p.vm === "running").map(async (p) => {
        const ports = await listening(p.pylonId);
        return ports !== null && JSON.stringify(ports) !== reportedListening.get(p.pylonId);
      }));
      if (changed.some(Boolean)) await publishSnapshot();
    } catch (err) {
      log(`listening ports: ${(err as Error).message}`);
    } finally {
      polling = false;
    }
  }

  /** Declared outputs only accumulate in the control plane, so a failed read reported as none loses nothing. `nexus output list` shows the failure. */
  async function declaredOutputs(pylonId: PylonId): Promise<readonly DeclaredOutput[]> {
    try {
      return await readFact(pylonId, "outputs", sessionReadTimeoutMs, () => listOutputs(backend.guest(pylonId), sessionReadTimeoutMs));
    } catch {
      return [];
    }
  }

  const gitReads = new Map<PylonId, { bootedAt: string; at: number; facts: GitFacts | null }>();
  const unreadGit = new Set<PylonId>();
  async function git(pylonId: PylonId, bootedAt: string): Promise<GitFacts | null> {
    const previous = gitReads.get(pylonId);
    const at = Date.now();
    if (previous?.bootedAt === bootedAt && at - previous.at < gitPollMs) return previous.facts;
    let facts: GitFacts | null = null;
    try {
      facts = await readFact(pylonId, "git", sessionReadTimeoutMs, () => gitFacts(backend.guest(pylonId)));
      unreadGit.delete(pylonId);
    } catch {
      if (!unreadGit.has(pylonId)) log(`${pylonId} git: checkout facts unavailable; retrying on the next git poll`);
      unreadGit.add(pylonId);
    }
    gitReads.set(pylonId, { bootedAt, at, facts });
    return facts;
  }

  async function observation(p: BackendPylon): Promise<PylonObservation> {
    const { pylonId } = p;
    if (p.vm !== "running") {
      gitReads.delete(pylonId);
      unreadSessions.delete(pylonId);
    }
    switch (p.vm) {
      case "booting": case "stopping": case "deleting": return { pylonId, phase: p.vm };
      case "stopped":
        if (p.sessions === undefined) throw new Error(`backend reports ${pylonId} stopped without saying what its pause recorded`);
        return { pylonId, phase: "stopped", checkpoint: p.checkpoint, sessions: p.sessions };
      case "broken":
        if (p.cause === undefined) throw new Error(`backend reports ${pylonId} broken with no cause`);
        return { pylonId, phase: "broken", detail: p.detail ?? "the backend gave no detail", cause: p.cause };
      case "running": {
        if (p.bootedAt === null) throw new Error(`backend reports ${pylonId} running with no boot time`);
        const [ports, serviceFacts, sessionFacts, checkout, outputs, attachedClients] = await Promise.all([
          listening(pylonId), services(pylonId), sessions(pylonId), git(pylonId, p.bootedAt), declaredOutputs(pylonId), attached(pylonId),
        ]);
        if (ports !== null) reportedListening.set(pylonId, JSON.stringify(ports));
        return {
          pylonId, phase: "running", liveHash: liveHashes.get(pylonId) ?? null, bootedAt: p.bootedAt,
          bootedFrom: { image: p.image, checkpoint: p.checkpoint },
          services: serviceFacts, listening: ports, previews: (published.get(pylonId) ?? []).map((preview) => ({ ...preview, ready: true })), sessions: sessionFacts, git: checkout, declaredOutputs: outputs,
          attachedClients,
        };
      }
    }
  }

  /**
   * Reads run one at a time, so snapshots resolve, and are published, in the order they were read. Otherwise a
   * slow periodic read could publish a pylon as running after a later read reported it paused.
   */
  let snapshots: Promise<unknown> = Promise.resolve();
  function snapshot(): Promise<NodeObservation> {
    return betweenReads(readSnapshot);
  }

  /**
   * Runs `work` in the read queue, so no read overlaps it, and each read queued before it is published before it
   * starts. A link or unlink runs here: the control plane writes its preview as soon as the command answers, and a
   * read from before the command, published after that, would undo the write until the next read.
   */
  function betweenReads<T>(work: () => Promise<T>): Promise<T> {
    const next = snapshots.then(work);
    snapshots = next.catch(() => undefined); // the caller handles the error. The queue only needs to move on
    return next;
  }

  /**
   * Each send to a Claude session by its request ID, until an hour after it settles, so a control plane whose wait for
   * one ran out, as behind a slow send to the same session, learns what became of it instead of typing it again. They
   * are held in memory, so a restarted probe knows none.
   */
  const claudeSendsById = new Map<string, Promise<CommandResult>>();
  function sendClaude(pylonId: PylonId, command: Extract<PylonCommand, { kind: "send-claude" }>, run: () => Promise<CommandResult>): Promise<CommandResult> {
    const sending = onePerClaudeSession(pylonId, [command.session], run);
    if (command.requestId === undefined) return sending;
    const key = `${pylonId} ${command.requestId}`;
    claudeSendsById.set(key, sending);
    void sending.catch(() => undefined).then(() => setTimeout(() => { if (claudeSendsById.get(key) === sending) claudeSendsById.delete(key); }, claudeSendMemoryMs).unref());
    return sending;
  }
  async function outcomeOf(pylonId: PylonId, requestId: string): Promise<CommandResult> {
    const sending = claudeSendsById.get(`${pylonId} ${requestId}`);
    if (sending === undefined) return { kind: "send-claude-outcome", send: "unknown" };
    try {
      const { outcome, herdrPane, resumed } = await sending as Extract<CommandResult, { kind: "send-claude" }>;
      return { kind: "send-claude-outcome", send: { outcome, herdrPane, resumed } };
    } catch {
      return { kind: "send-claude-outcome", send: "failed" };
    }
  }

  async function readSnapshot(): Promise<NodeObservation> {
    // Jobs before pylons, so the pylons show the result of every job listed as finished. See NodeObservation.jobs.
    const jobs = retainedJobs();
    const [pylons, artifacts, disk] = await Promise.all([backend.list(), backend.artifacts.list(), statfs("/")]);
    const present = new Set(pylons.map((p) => p.pylonId));
    for (const id of gitReads.keys()) if (!present.has(id)) gitReads.delete(id);
    for (const id of unreadGit) if (!present.has(id)) unreadGit.delete(id);
    return {
      node,
      observedAt: new Date().toISOString(),
      probeBootId: bootId,
      events: journal.recent(),
      capacity: {
        cpus: availableParallelism(), committedCpus: sum(pylons, "cpus"),
        memoryGiB: totalmem() / 2 ** 30, committedMemoryGiB: sum(pylons, "memoryGiB"),
        diskFreeGiB: (disk.bavail * disk.bsize) / 2 ** 30, committedDiskGiB: sum(pylons, "diskGiB"),
      },
      artifacts,
      jobs,
      pylons: await Promise.all(pylons.map(observation)),
      previewRoutes: previews === null ? [] : [...previews.gateway.routes].map(([httpsPort, route]) => ({ httpsPort, ...route })),
      grants: { secrets: options.secrets.names(), gitSsh: options.gitSsh ?? false },
      claudeLaunchRepeatable: true,
    };
  }

  function start(env: JobEnvelope, subject: Subject): JobStatus {
    const { job, jobId } = env;
    const base = { jobId, subject, kind: job.kind };
    const running: JobStatus = { ...base, state: "running", startedAt: new Date().toISOString() };
    busy.set(subject, jobId);
    setStatus(running, null);
    if (job.kind === "pause" || job.kind === "delete") {
      liveHashes.delete(job.pylonId);
      published.delete(job.pylonId);
      reportedListening.delete(job.pylonId);
      // The counter outlives a pause, so a services read that a withdraw and then a pause overlapped still sees a change.
      if (job.kind === "delete") {
        diverged.delete(job.pylonId);
        unlinked.delete(job.pylonId);
      }
    }
    const signal = AbortSignal.any([AbortSignal.timeout(deadlines[job.kind]), shutdown.signal]);
    const seen = job.kind === "spawn" ? diverged.get(job.pylonId) : undefined;
    const run = runJob(job, deps, signal).then(
      () => {
        // A withdraw while it ran may have come after its converge, so the planner spawns again.
        if (job.kind === "spawn" && diverged.get(job.pylonId) === seen) {
          liveHashes.set(job.pylonId, job.liveHash);
          published.set(job.pylonId, job.live.previews);
          api.republished();
        }
        setStatus({ ...base, state: "succeeded", finishedAt: new Date().toISOString() }, Date.now());
      },
      (err: unknown) => {
        if (!(err instanceof JobFailure)) throw err;
        setStatus({ ...base, state: "failed", finishedAt: new Date().toISOString(), code: err.code, message: err.message, logTail: err.logTail }, Date.now());
      },
    ).finally(() => {
      busy.delete(subject);
      runningJobs.delete(run);
    }).then(publishSnapshot);
    runningJobs.add(run);
    return running;
  }

  /** A full snapshot rather than a pylon event, because a pylon event cannot say that a pylon is gone. */
  function publishSnapshot(): Promise<void> | undefined {
    if (observers.size === 0 || shutdown.signal.aborted) return;
    // Observers that cannot get the new state lose their link, so they reconnect for a fresh snapshot.
    return snapshot().then((observation) => emit({ type: "snapshot", observation }), (err: Error) => { for (const o of observers) o.drop(err); });
  }

  function submit(jobId: JobId, body: string) {
    const known = jobs.get(jobId);
    if (known) return encodeSubmitReply({ accepted: known.status });
    let env: JobEnvelope;
    try {
      env = parseJobEnvelope(body);
    } catch (err) {
      return encodeSubmitReply({ rejected: "invalid", message: (err as Error).message });
    }
    if (env.jobId !== jobId) return encodeSubmitReply({ rejected: "invalid", message: `envelope jobId ${env.jobId} differs from the path` });
    if (env.node !== node) return encodeSubmitReply({ rejected: "invalid", message: `envelope is for ${env.node}, this probe is ${node}` });
    if (Date.now() > Date.parse(env.notAfter)) return encodeSubmitReply({ rejected: "expired" });
    const subject = jobSubject(env.job);
    const inFlight = busy.get(subject);
    if (inFlight !== undefined) return encodeSubmitReply({ rejected: "busy", inFlight });
    return encodeSubmitReply({ accepted: start(env, subject) });
  }

  async function observe(res: ServerResponse) {
    // Events that arrive while the first snapshot is built go out after it, in order, except older snapshots.
    const queued: ProbeEvent[] = [];
    let write = (event: ProbeEvent) => { queued.push(event); };
    const observer = { write: (event: ProbeEvent) => write(event), drop: (err: Error) => res.destroy(err) };
    observers.add(observer);
    const timer = setInterval(() => { snapshot().then((observation) => write({ type: "snapshot", observation }), observer.drop); }, snapshotIntervalMs);
    res.on("close", () => { observers.delete(observer); clearInterval(timer); });
    const first = await snapshot();
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    res.write(encodeProbeEvent({ type: "snapshot", observation: first }));
    write = (event) => { res.write(encodeProbeEvent(event)); };
    // Reads run in order, so a queued snapshot was read before `first`. Sent after it, it would undo newer state.
    for (const event of queued) if (event.type !== "snapshot") write(event);
  }

  async function authorized(req: IncomingMessage, route: keyof typeof routeAuth): Promise<boolean> {
    const { remoteAddress, remotePort } = req.socket;
    if (remoteAddress === undefined || remotePort === undefined) return false;
    const caller = await whois(remoteAddress, remotePort);
    if (caller === null) return false;
    return routeAuth[route] === "control-plane" ? caller === auth.controlPlane : auth.peers.includes(caller);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/v1/health" && req.socket.remoteAddress === req.socket.localAddress) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ commit: runningCommit }));
      return;
    }
    const path = new URL(req.url ?? "/", "http://probe").pathname;
    const route = (Object.keys(routeAuth) as (keyof typeof routeAuth)[]).find((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    if (route === undefined) return send(res, 404, `no route ${path}`);
    if (!await authorized(req, route)) return send(res, 403, "caller is not the tailnet node this route allows");

    const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(path);
    if (jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]!) as JobId;
      if (req.method === "PUT") {
        const reply = submit(jobId, await readBody(req));
        return send(res, reply.status, reply.body, "application/json");
      }
      if (req.method === "GET") {
        const job = jobs.get(jobId);
        return job ? send(res, 200, JSON.stringify(job.status), "application/json") : send(res, 404, `no job ${jobId}`);
      }
      return send(res, 405, `${req.method} is not allowed on ${path}`);
    }
    if (path === "/v1/observe" && req.method === "GET") {
      // whois is async, so the caller or the probe may be gone by now, and nothing would remove the observer.
      if (req.socket.destroyed || shutdown.signal.aborted) return;
      return observe(res);
    }
    const commandMatch = /^\/v1\/pylons\/([^/]+)\/commands$/.exec(path);
    if (commandMatch && req.method === "POST") {
      const pylonId = decodeURIComponent(commandMatch[1]!) as PylonId;
      let command: PylonCommand;
      try {
        command = parsePylonCommand(await readBody(req));
      } catch (err) {
        return send(res, 400, (err as Error).message);
      }
      const pylon = (await backend.list()).find((p) => p.pylonId === pylonId);
      if (pylon?.vm !== "running") return send(res, 409, `${pylonId} is ${pylon?.vm ?? "absent"}, not running`);
      if (command.kind === "send-claude-outcome") return send(res, 200, JSON.stringify(await outcomeOf(pylonId, command.requestId)), "application/json");
      const guestCommand = command;
      const links = guestCommand.kind === "link-port" || guestCommand.kind === "unlink-port";
      const run = () => runCommand(pylonId, guestCommand, deps);
      const launch = guestCommand.kind === "open-session" && guestCommand.prompt !== undefined ? guestCommand.resume : undefined;
      const result = await (links ? betweenReads(run) : guestCommand.kind === "send-claude" ? sendClaude(pylonId, guestCommand, run) : launch !== undefined ? onePerClaudeSession(pylonId, [launch], run) : run());
      if (result.kind === "link-port") relinked(pylonId, result.service);
      // A linked port is a new service that wants a preview, and an unlinked one a service gone, which the control plane sees in the next read.
      // An opened or closed session is listed in it too, as is one a message resumed.
      if (links || command.kind === "open-session" || command.kind === "close-session" || (result.kind === "send-claude" && result.resumed)) void publishSnapshot();
      return send(res, 200, JSON.stringify(result), "application/json");
    }
    const manifestMatch = /^\/v1\/manifests\/([^/]+)$/.exec(path);
    if (manifestMatch && req.method === "GET") {
      const id = decodeURIComponent(manifestMatch[1]!);
      if (!isPortableArtifactId(id)) return send(res, 400, `${JSON.stringify(id)} is not an image or template ID`);
      const manifest = await backend.artifacts.manifest(id);
      return manifest === null ? send(res, 404, `this node holds no ${id}`) : send(res, 200, JSON.stringify(manifest), "application/json");
    }
    const secretMatch = /^\/v1\/secrets\/([^/]+)$/.exec(path);
    if (secretMatch) {
      if (req.method !== "PUT") return send(res, 405, `${req.method} is not allowed on ${path}`);
      const name = decodeURIComponent(secretMatch[1]!);
      if (!heldSecrets.includes(name)) return send(res, 404, `${name} is not a secret the control plane hands over`);
      // No reply or log carries the value, so a refusal says what a value must be, never what this one was.
      let value: string;
      try {
        value = await readBody(req, maxSecretBytes);
      } catch {
        return send(res, 400, `a secret value is at most ${maxSecretBytes} bytes`);
      }
      if (!tokenAlphabet.test(value)) return send(res, 400, "a secret value is a token: letters, digits and -._~+/ with optional = padding");
      options.secrets.hold(name, value);
      for (const { pylonId, reason } of await backend.updateSecret(name, value)) log(`${pylonId}: ${name} was not updated: ${reason}`);
      res.writeHead(204).end();
      return;
    }
    const artifactMatch = /^\/v1\/artifacts\/([^/]+)$/.exec(path);
    if (artifactMatch && req.method === "GET") {
      const id = decodeURIComponent(artifactMatch[1]!) as PortableArtifactId;
      const wanted = new URL(req.url ?? "/", "http://probe").searchParams.get("sha256");
      if (wanted === null) return send(res, 400, "name the sha256 the copy must have, as ?sha256=");
      if (id.startsWith("ckpt-") || !(await backend.artifacts.list()).includes(id)) return send(res, 404, `this node holds no image or template ${id}. A checkpoint never leaves its node`);
      const held = await backend.artifacts.manifest(id);
      if (held !== null && held.sha256 !== wanted) {
        const reason = `this node holds ${id} with sha256 ${held.sha256}, and the fetch asks for ${wanted}`;
        log(`artifact ${id}: refused a copy: ${reason}`);
        return send(res, 409, reason);
      }
      const { manifest, stream } = await backend.artifacts.export(id);
      res.writeHead(200, artifactHeaders(manifest));
      // A failed archive destroys the response, so the peer's copy breaks off instead of ending as if complete.
      return pipeline(stream, res).catch((err: Error) => log(`artifact ${id}: ${err.message}`));
    }
    if (route === "/v1/pylons") return send(res, 501, `${route} is not implemented in this slice`);
    return send(res, 404, `no route ${req.method} ${path}`);
  }

  /** GET /v1/pylons/{id}/stream. The guest process starts before the 101, so a pylon that cannot run it gets an HTTP error instead. */
  async function stream(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://probe");
    if (!url.pathname.startsWith("/v1/pylons/")) return refuse(socket, 404, `no upgrade route ${url.pathname}`);
    if (!await authorized(req, "/v1/pylons")) return refuse(socket, 403, "caller is not the tailnet node this route allows");
    let parsed: ReturnType<typeof parseStreamRequest>;
    try {
      parsed = parseStreamRequest(req.headers.upgrade, url);
    } catch (err) {
      return refuse(socket, 400, (err as Error).message);
    }
    if (parsed === null) return refuse(socket, 404, `no upgrade route ${url.pathname} for ${req.headers.upgrade}`);
    const { pylonId, argv } = parsed;
    if ((await backend.list()).find((p) => p.pylonId === pylonId)?.vm !== "running") return refuse(socket, 409, `${pylonId} is not running`);
    if (socket.destroyed || shutdown.signal.aborted) return;
    const guest = await backend.guest(pylonId).stream(argv, (text) => log(`${pylonId} stream ${argv[0]}: ${text.trimEnd()}`));
    socket.write(streamUpgradeResponse);
    await serveByteStream(socket, head, guest);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.destroy(err as Error);
      send(res, 500, (err as Error).message);
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node hands over an upgraded socket without its error handler, and a reset during whois would crash the probe.
    socket.on("error", (err) => log(`stream ${req.url}: ${err.message}`));
    streamSockets.add(socket);
    socket.on("close", () => streamSockets.delete(socket));
    stream(req, socket, head).catch((err: unknown) => {
      log(`stream ${req.url}: ${(err as Error).message}`);
      refuse(socket, 502, (err as Error).message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); });
  }).catch(async (err: unknown) => {
    await previews?.gateway.close(); // its port is fixed, so a retry in this process needs it free
    throw err;
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`unexpected server address ${address}`);
  const bridge = await options.hostBridge?.(api.answer).catch(async (err: unknown) => {
    await Promise.all([new Promise((resolve) => server.close(resolve)), previews?.gateway.close()]);
    throw err;
  });
  const listeningTimer = setInterval(() => void pollListening(), options.listeningPollMs ?? 10_000);

  return {
    port: address.port,
    bootId,
    async close() {
      shutdown.abort(new Error("probe closed"));
      clearInterval(listeningTimer);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of streamSockets) socket.destroy();
      await Promise.allSettled([...runningJobs]);
      await Promise.all([closed, previews?.gateway.close(), bridge?.close()]);
      journal.close();
    },
  };
}

/** An HTTP error on a socket that asked to upgrade, which has no ServerResponse. Does nothing once the socket is gone. */
function refuse(socket: Duplex, status: number, body: string) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType }).end(body);
}

async function readBody(req: IncomingMessage, limit = maxBodyBytes): Promise<string> {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req as AsyncIterable<string>) {
    body += chunk;
    if (body.length > limit) throw new Error(`request body over ${limit} bytes`);
  }
  return body;
}
