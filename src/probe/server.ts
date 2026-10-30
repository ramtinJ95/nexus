import { dirname } from "node:path";
import { eventJournal } from "./event-journal.ts";
import { runningCommit } from "../deploy/health.ts";
/**
 * The probe's HTTP server: lifecycle jobs and observations. It keeps job results and applied live hashes in
 * memory only. Everything durable is the backend's, so a restart loses nothing a later job cannot rebuild.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type BackendPylon, type VmBackend } from "../backend.ts";
import { commandPolicies, runCommand, runJob, type CommandPolicy, type ProbeDeps } from "./run.ts";
import { isPortableArtifactId, type JobId, type LiveHash, type NodeName, type PylonId, type TailnetNodeId } from "../ids.ts";
import {
  encodeSubmitReply, jobDeadlineMs, JobFailure, jobSubject, parseJobEnvelope, type Job, type JobEnvelope, type JobStatus, type Subject,
} from "../protocol/jobs.ts";
import {
  encodeProbeEvent, heldSecrets, type DeclaredOutput, type GitFacts, type ListeningFact, type NodeObservation, type ProbeEvent,
  type PylonObservation, type ServiceFact, type SessionFact,
} from "../protocol/observations.ts";
import { parsePylonCommand, type CommandResult, type PylonCommand } from "../protocol/commands.ts";
import { parseStreamRequest, serveByteStream, streamUpgradeResponse } from "../protocol/streams.ts";
import { artifactHeaders, fetchArtifact } from "../protocol/artifacts.ts";
import { peersSchema, probePort, routeAuth, type ProbeAuthConfig } from "../protocol/routes.ts";
import { linkedName, type ServiceName } from "../services-file.ts";
import { attachedTerminals, sessionFacts } from "../sessions.ts";
import { onePerClaudeSession } from "../session-wake.ts";
import type { Whois } from "../tailscale.ts";
import { listOutputs } from "../outputs.ts";
import { listeningFacts } from "../listening.ts";
import { readBody } from "../request-body.ts";
import { redact } from "./redact.ts";
import { hostCapacity, readNodeHealth } from "./host.ts";
import { gitFacts, gitPollMs } from "../git-facts.ts";
import { rawResponse, startGateway } from "./gateway.ts";
import { createPylonApi } from "./pylon-api.ts";
import { createTailscaleServe, parseServeStatus, readRoutes, type HttpsGet, type TailscaleCli } from "./serve.ts";
import { serialQueue, singleFlight } from "../single-flight.ts";
import type { NodeSecrets } from "./config.ts";

export interface ProbeOptions {
  node: NodeName;
  host: string;
  /** 0 picks a free port. */
  port: number;
  auth: ProbeAuthConfig;
  whois: Whois;
  backend: VmBackend;
  secrets: NodeSecrets;
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
/** How long node health samples its pylons' CPU for. */
const healthSampleMs = 1_000;
const maxSecretBytes = 16_384;
/** RFC 6750's b64token, the alphabet bearer tokens are written in. */
const tokenAlphabet = /^[A-Za-z0-9\-._~+/]+=*$/;
const sum = (pylons: readonly BackendPylon[], resource: keyof NonNullable<BackendPylon["holds"]>) => pylons.reduce((total, p) => total + (p.holds?.[resource] ?? 0), 0);
/** Short, because snapshots are read one at a time and a stuck guest would hold up every observer. */
const sessionReadTimeoutMs = 3_000;
/** Longer, because a pylon's supervisor checks each service's health to answer. */
const serviceReadTimeoutMs = 5_000;
const claudeSendMemoryMs = 60 * 60_000;

type FactKind = "sessions" | "attached" | "services" | "listening" | "outputs" | "git";

/** What the probe holds for one pylon, in memory only. A delete drops it all, and named resets in startProbe clear parts. */
interface PylonState {
  /** Cleared, with `published` and `reportedListening`, when a pause starts. */
  liveHash?: LiveHash;
  /** The previews of the pylon's last successful spawn in this process, which published and warmed them. */
  published?: Extract<Job, { kind: "spawn" }>["live"]["previews"];
  /** The listening ports the pylon's last observation reported, so a poll can tell when they changed. */
  reportedListening?: string;
  /**
   * Bumped when the pylon's routes stop matching a spawn's live spec, so a spawn in flight across it does not count as
   * applied. It outlives a pause, so a services read that a withdraw and then a pause overlapped still sees a change.
   */
  diverged: number;
  /**
   * The services that were unlinked and not linked again. No spawn routes them: one that carries them was planned
   * before the unlink, whenever it reaches the probe. Only a delete forgets them.
   */
  unlinked: Set<ServiceName>;
  /** Whether the last snapshot saw the pylon running, which a listening poll reads instead of listing every pylon. */
  running: boolean;
  /** The last git read, which later snapshots reuse for gitPollMs while the pylon stays on the same boot. Cleared, with `logged`, once the pylon is seen not running. */
  git?: { bootedAt: string; at: number; facts: GitFacts | null };
  /** The fact kinds whose failure was logged since their last successful read. */
  logged: Set<FactKind>;
  /**
   * Reads still outstanding, timed out or not, so later snapshots cannot pile up RPCs behind one the controller has yet
   * to answer. Each removes itself when it settles, also across a pause.
   */
  reads: Map<FactKind, Promise<unknown>>;
}

/** A probe without a preview gateway. An empty set is already converged. */
const noPreviews: ProbeDeps["serve"] = {
  async converge(_pylonId, previews) {
    if (previews.length > 0) throw new JobFailure("invalid", "this probe was started without a preview gateway");
  },
  async withdraw() {},
};

export async function startProbe(options: ProbeOptions): Promise<Probe> {
  const { node, backend, auth, whois } = options;
  /** probe.json's peers until the control plane puts its list, which a restart forgets until the next put. */
  let peers = auth.peers;
  const deadlines = options.jobDeadlineMs ?? jobDeadlineMs;
  const peerAddress = options.peerAddress ?? ((peer: NodeName) => ({ host: peer, port: probePort }));
  const bootId = randomUUID();
  if (backend.eventJournal !== undefined) await mkdir(dirname(backend.eventJournal), { recursive: true, mode: 0o700 });
  const journal = eventJournal(backend.eventJournal ?? ":memory:");
  const shutdown = new AbortController();
  const log = options.log ?? console.error;
  const previews = options.previews === undefined ? null : {
    ...options.previews,
    gateway: await startGateway({
      port: options.previews.gatewayPort,
      routes: await readRoutes(options.previews.routesFile),
      origin: ({ pylonId, service }) => backend.guest(pylonId).previewOrigin(service),
      onHit: (hit) => emit({ type: "preview-hit", ...hit }),
      log,
    }),
  };
  const pylons = new Map<PylonId, PylonState>();
  function pylon(pylonId: PylonId): PylonState {
    let state = pylons.get(pylonId);
    if (state === undefined) pylons.set(pylonId, state = { diverged: 0, unlinked: new Set(), running: false, logged: new Set(), reads: new Map() });
    return state;
  }
  /** A pause ends the pylon's run, so nothing it applied or reported still holds. */
  function runEnded(state: PylonState) {
    delete state.liveHash;
    delete state.published;
    delete state.reportedListening;
  }
  /** Observed not running, or missing from the backend's list: the next boot's reads start fresh, and log a failure again. */
  function notRunning(state: PylonState) {
    state.running = false;
    delete state.git;
    state.logged.clear();
  }
  const relinked = (pylonId: PylonId, service: ServiceName) => pylons.get(pylonId)?.unlinked.delete(service);
  const serve = previews === null ? noPreviews : createTailscaleServe({ cli: previews.tailscale, gateway: previews.gateway, routesFile: previews.routesFile, get: previews.get });
  const deps: ProbeDeps = {
    backend,
    secrets: options.secrets,
    serve: {
      converge(pylonId, assigned, signal) {
        const gone = pylons.get(pylonId)?.unlinked;
        const routed = assigned.filter((p) => !gone?.has(p.service));
        if (routed.length < assigned.length) pylon(pylonId).diverged++;
        return serve.converge(pylonId, routed, signal);
      },
      // The pylon no longer has what its last spawn applied, so the planner spawns again. A port linked again before
      // a snapshot saw it unlinked gets its route back that way, as its registry row and live hash did not change.
      // Recorded first, so a converge that starts while the route is withdrawn leaves the service out.
      async withdraw(pylonId, service) {
        const state = pylon(pylonId);
        state.unlinked.add(service);
        state.diverged++;
        await serve.withdraw(pylonId, service);
        const current = pylons.get(pylonId);
        if (current === undefined) return;
        delete current.liveHash;
        if (current.published !== undefined) current.published = current.published.filter((p) => p.service !== service);
      },
    },
    ports: { link: linkPort, unlink: unlinkPort },
    node,
    fetchPeer: (from, artifact, sha256, signal) => fetchArtifact(peerAddress(from), artifact, sha256, { whois, peers }, signal),
  };
  const jobs = new Map<JobId, { status: JobStatus; finishedAt: number | null }>();
  const busy = new Map<Subject, JobId>();
  const observers = new Set<{ write(event: ProbeEvent): void; drop(err: Error): void }>();
  const runningJobs = new Set<Promise<void>>();
  /** Upgraded sockets, which the HTTP server no longer tracks, so close() ends them itself. */
  const streamSockets = new Set<Duplex>();

  const emit = (event: ProbeEvent) => { if (!shutdown.signal.aborted) for (const observer of observers) observer.write(event); };
  const api = createPylonApi({
    event: (pylon, event) => emit({ type: "session-event", report: journal.append(pylon, event) }),
    guest: (pylonId) => backend.guest(pylonId),
    published: (pylonId) => pylons.get(pylonId)?.published ?? [],
    changed: () => void publishSnapshot(),
    ports: deps.ports,
    async previewUrls() {
      if (previews === null) return new Map();
      const served = parseServeStatus(await previews.tailscale(["serve", "status", "--json"], shutdown.signal), previews.gateway.origin);
      return new Map([...served].flatMap(([httpsPort, entry]) => entry.kind === "nexus" ? [[httpsPort, entry.url]] : []));
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

  /**
   * A failed, late or still outstanding read answers `fallback`. `log.line` is logged once until a read succeeds, or on
   * every failure with `log.every`. Without `log` nothing is.
   */
  async function readFact<T>(pylonId: PylonId, kind: FactKind, timeoutMs: number, read: () => Promise<T>, options: {
    fallback: T; log?: { line: (reason: string) => string; every?: true };
  }): Promise<T> {
    const { reads, logged } = pylon(pylonId);
    let timer: NodeJS.Timeout | undefined;
    try {
      if (reads.has(kind)) throw new Error(`${kind} read is still outstanding`);
      const pending = Promise.resolve().then(read);
      reads.set(kind, pending);
      void pending.then(() => reads.delete(kind), () => reads.delete(kind));
      const facts = await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${kind} read exceeded ${timeoutMs} ms`)), timeoutMs);
      })]);
      logged.delete(kind);
      return facts;
    } catch (err) {
      if (options.log !== undefined && (options.log.every === true || !logged.has(kind))) log(options.log.line((err as Error).message));
      logged.add(kind);
      return options.fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Costs one guest exec (`herdr api snapshot`) per running pylon per snapshot, so a snapshot waits for the
   * slowest pylon, up to sessionReadTimeoutMs. A failed read reports null, never "no sessions".
   */
  const sessions = (pylonId: PylonId): Promise<readonly SessionFact[] | null> =>
    readFact(pylonId, "sessions", sessionReadTimeoutMs, () => sessionFacts(backend.guest(pylonId), sessionReadTimeoutMs), {
      fallback: null, log: { line: (reason) => `${pylonId} sessions: ${reason}. The control plane keeps the last list read until a read succeeds` },
    });

  /**
   * Terminals attached to the pylon's Herdr session. A count that fails reads as none, so it never keeps a pylon
   * awake nor fails the rest of the observation.
   */
  const attached = (pylonId: PylonId): Promise<number> =>
    readFact(pylonId, "attached", sessionReadTimeoutMs, () => attachedTerminals(backend.guest(pylonId), sessionReadTimeoutMs), {
      fallback: 0, log: { line: (reason) => `${pylonId} attached terminals: ${reason}. They count as none until a count succeeds` },
    });

  /** A failed or late read reports null, never "no services". */
  async function services(pylonId: PylonId): Promise<readonly ServiceFact[] | null> {
    const since = pylon(pylonId).diverged;
    const facts = await readFact(pylonId, "services", serviceReadTimeoutMs, async () => (await backend.guest(pylonId).services("list")).services, {
      fallback: null, log: { line: (reason) => `${pylonId} services: ${reason}`, every: true },
    });
    // A service that wants a preview under an unlinked name, linked again or declared, may be routed again. Not
    // from a read that a withdraw overlapped, which may predate the unlink.
    if (facts !== null && pylons.get(pylonId)?.diverged === since) for (const fact of facts) if (fact.wantsPreview) relinked(pylonId, fact.name);
    return facts;
  }

  /** A failed read reports null, never "nothing listens". */
  const listening = (pylonId: PylonId): Promise<readonly ListeningFact[] | null> =>
    readFact(pylonId, "listening", sessionReadTimeoutMs, () => listeningFacts(backend.guest(pylonId), sessionReadTimeoutMs), { fallback: null });

  /**
   * An app that starts or stops listening gives the probe no event, so the ports of every pylon the last snapshot saw
   * running are read again between snapshots, and a change publishes one. Without observers nobody would see it, so
   * nothing is read.
   */
  const listeningPoll = singleFlight(async () => {
    if (observers.size === 0) return;
    const changed = await Promise.all([...pylons].filter(([, state]) => state.running).map(async ([pylonId, state]) => {
      const ports = await listening(pylonId);
      return ports !== null && JSON.stringify(ports) !== state.reportedListening;
    }));
    if (changed.some(Boolean)) await publishSnapshot();
  }, () => shutdown.signal.aborted);

  /** Declared outputs only accumulate in the control plane, so a failed read reported as none loses nothing. `nexus output list` shows the failure. */
  const declaredOutputs = (pylonId: PylonId): Promise<readonly DeclaredOutput[]> =>
    readFact(pylonId, "outputs", sessionReadTimeoutMs, () => listOutputs(backend.guest(pylonId), sessionReadTimeoutMs), { fallback: [] });

  const storage = backend.storage ?? "/";

  /** What leaves the node in a failure, with every value this probe holds, and what looks like a secret, redacted. */
  const redacted = (text: string) => redact(text, options.secrets.names().flatMap((name) => options.secrets.value(name) ?? []));

  async function git(pylonId: PylonId, bootedAt: string): Promise<GitFacts | null> {
    const state = pylon(pylonId);
    const previous = state.git;
    const at = Date.now();
    if (previous?.bootedAt === bootedAt && at - previous.at < gitPollMs) return previous.facts;
    const facts = await readFact(pylonId, "git", sessionReadTimeoutMs, () => gitFacts(backend.guest(pylonId)), {
      fallback: null, log: { line: () => `${pylonId} git: checkout facts unavailable; retrying on the next git poll` },
    });
    state.git = { bootedAt, at, facts };
    return facts;
  }

  async function observation(p: BackendPylon): Promise<PylonObservation> {
    const { pylonId } = p;
    const state = pylon(pylonId);
    if (p.vm === "running") state.running = true;
    else notRunning(state);
    switch (p.vm) {
      case "booting": case "stopping": case "deleting": return { pylonId, phase: p.vm };
      case "stopped":
        return { pylonId, phase: "stopped", checkpoint: p.checkpoint, sessions: p.sessions };
      case "broken":
        return { pylonId, phase: "broken", detail: redacted(p.detail), cause: p.cause, logTail: redacted(p.logTail ?? "") };
      case "running": {
        const [ports, serviceFacts, sessionFacts, checkout, outputs, attachedClients] = await Promise.all([
          listening(pylonId), services(pylonId), sessions(pylonId), git(pylonId, p.bootedAt), declaredOutputs(pylonId), attached(pylonId),
        ]);
        // Looked up again, as a delete may have started while the guest was read.
        const current = pylons.get(pylonId);
        if (ports !== null && current !== undefined) current.reportedListening = JSON.stringify(ports);
        return {
          pylonId, phase: "running", liveHash: current?.liveHash ?? null, bootedAt: p.bootedAt,
          bootedFrom: { image: p.image, checkpoint: p.checkpoint },
          services: serviceFacts, listening: ports, previews: current?.published ?? [], sessions: sessionFacts, git: checkout, declaredOutputs: outputs,
          attachedClients,
        };
      }
    }
  }

  /**
   * Reads run one at a time, so snapshots resolve, and are published, in the order they were read. Otherwise a
   * slow periodic read could publish a pylon as running after a later read reported it paused.
   */
  function snapshot(): Promise<NodeObservation> {
    return betweenReads(readSnapshot);
  }

  /** Runs `work` in the read queue, so no read overlaps it, and each read queued before it is published before it starts. */
  const betweenReads = serialQueue().run;

  /*
   * A link or unlink, with its route bookkeeping, runs in the read queue: the control plane writes its preview as soon
   * as the call answers, and a read from before the call, published after that, would undo the write until the next read.
   */
  function linkPort(pylonId: PylonId, port: number, title?: string): Promise<ServiceName> {
    return betweenReads(async () => {
      const service = await backend.guest(pylonId).linkPort(port, title);
      relinked(pylonId, service);
      return service;
    });
  }
  function unlinkPort(pylonId: PylonId, port: number): Promise<string | null> {
    return betweenReads(async () => {
      const refused = await backend.guest(pylonId).unlinkPort(port);
      if (refused === null) await deps.serve.withdraw(pylonId, linkedName(port));
      return refused;
    });
  }

  /**
   * Each send to a Claude session by its request ID, until an hour after it settles, so a control plane whose wait for
   * one ran out, as behind a slow send to the same session, learns what became of it instead of typing it again. They
   * are held in memory, so a restarted probe knows none.
   */
  const claudeSendsById = new Map<string, Promise<CommandResult>>();
  function remember(pylonId: PylonId, requestId: string, sending: Promise<CommandResult>) {
    const key = `${pylonId} ${requestId}`;
    claudeSendsById.set(key, sending);
    void sending.catch(() => undefined).then(() => setTimeout(() => { if (claudeSendsById.get(key) === sending) claudeSendsById.delete(key); }, claudeSendMemoryMs).unref());
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
    const [listed, host] = await Promise.all([backend.list(), hostCapacity(storage)]);
    // A running pylon's disk has moved on from the checkpoint it booted from, so only stopped disks count.
    const artifacts = [...await backend.artifacts.list(), ...listed.flatMap((p) => p.vm === "stopped" && p.checkpoint !== null ? [p.checkpoint] : [])];
    const present = new Set(listed.map((p) => p.pylonId));
    // Not dropped: a spawn in flight compares `diverged` at its start and its end, and a list can miss its pylon.
    for (const [id, state] of pylons) if (!present.has(id)) notRunning(state);
    return {
      node,
      observedAt: new Date().toISOString(),
      probeBootId: bootId,
      events: journal.recent(),
      capacity: {
        cpus: host.cpus, committedCpus: sum(listed, "cpus"),
        memoryGiB: host.memoryGiB, committedMemoryGiB: sum(listed, "memoryGiB"),
        diskFreeGiB: host.disk.freeGiB, committedDiskGiB: sum(listed, "diskGiB"),
      },
      artifacts,
      jobs,
      pylons: await Promise.all(listed.map(observation)),
      previewRoutes: previews === null ? [] : [...previews.gateway.routes].map(([httpsPort, route]) => ({ httpsPort, ...route })),
      grants: { secrets: options.secrets.names(), gitSsh: backend.gitSsh ?? false },
      spawnsWithoutRelaunch: true,
      ...backend.nestedVirtualization === true ? { nestedVirtualization: true as const } : {},
      heldSecrets,
    };
  }

  function start(env: JobEnvelope, subject: Subject): JobStatus {
    const { job, jobId } = env;
    const base = { jobId, subject, kind: job.kind };
    const running: JobStatus = { ...base, state: "running", startedAt: new Date().toISOString() };
    busy.set(subject, jobId);
    setStatus(running, null);
    if (job.kind === "pause") runEnded(pylon(job.pylonId));
    if (job.kind === "delete") pylons.delete(job.pylonId);
    const signal = AbortSignal.any([AbortSignal.timeout(deadlines[job.kind]), shutdown.signal]);
    const seen = job.kind === "spawn" ? pylon(job.pylonId).diverged : undefined;
    const run = runJob(job, deps, signal).then(
      () => {
        if (job.kind === "spawn") {
          const state = pylon(job.pylonId);
          // A withdraw while it ran may have come after its converge, so the planner spawns again.
          if (state.diverged === seen) {
            // A pylon whose sessions this spawn left out does not yet look like `live`, so the next spawn brings them back.
            if (job.relaunch !== false) state.liveHash = job.liveHash;
            state.published = job.live.previews;
            api.republished();
          }
        }
        setStatus({ ...base, state: "succeeded", finishedAt: new Date().toISOString() }, Date.now());
      },
      (err: unknown) => {
        if (!(err instanceof JobFailure)) throw err;
        setStatus({ ...base, state: "failed", finishedAt: new Date().toISOString(), code: err.code, message: redacted(err.message), logTail: redacted(err.logTail) }, Date.now());
      },
    ).finally(() => {
      busy.delete(subject);
      runningJobs.delete(run);
    }).then(publishSnapshot);
    runningJobs.add(run);
    return running;
  }

  /**
   * A full snapshot rather than a pylon event, because a pylon event cannot say that a pylon is gone. Calls while one
   * is read share one more read after it, which runs in the read queue, so it sees each link or unlink queued before it.
   */
  const publisher = singleFlight(async () => {
    if (observers.size === 0) return;
    // Observers that cannot get the new state lose their link, so they reconnect for a fresh snapshot.
    await snapshot().then((observation) => emit({ type: "snapshot", observation }), (err: Error) => { for (const o of observers) o.drop(err); });
  }, () => shutdown.signal.aborted);
  const publishSnapshot = (): Promise<void> => publisher.rerun();

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
    return routeAuth[route] === "control-plane" ? caller === auth.controlPlane : peers.includes(caller);
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
      const vm = await backend.state(pylonId);
      if (vm !== "running") return send(res, 409, `${pylonId} is ${vm}, not running`);
      const asked = command;
      // Each kind's policy takes its own kind of command and result, which command.kind picks.
      const policy = commandPolicies[command.kind] as CommandPolicy<PylonCommand["kind"]>;
      const run = () => asked.kind === "send-claude-outcome" ? outcomeOf(pylonId, asked.requestId) : runCommand(pylonId, asked, deps);
      const session = typeof policy.lock === "function" ? policy.lock(command) : undefined;
      const running = session !== undefined ? onePerClaudeSession(pylonId, [session], run) : run();
      if (policy.remembered && "requestId" in command && command.requestId !== undefined) remember(pylonId, command.requestId, running);
      const result = await running;
      if (typeof policy.publishes === "function" ? policy.publishes(result) : policy.publishes) void publishSnapshot();
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
      const first = !options.secrets.names().includes(name);
      options.secrets.hold(name, value);
      for (const { pylonId, reason } of await backend.updateSecret(name, value)) log(`${pylonId}: ${name} was not updated: ${reason}`);
      res.writeHead(204).end();
      // Boots that need it wait for a snapshot that lists it.
      if (first) void publishSnapshot();
      return;
    }
    if (path === "/v1/peers") {
      if (req.method !== "PUT") return send(res, 405, `${req.method} is not allowed on ${path}`);
      let next: readonly TailnetNodeId[];
      try {
        next = peersSchema.parse(JSON.parse(await readBody(req)));
      } catch (err) {
        return send(res, 400, `the peers are a JSON array of tailnet node IDs: ${(err as Error).message}`);
      }
      if (next.join() !== peers.join()) log(`peers: ${next.join(", ") || "none"}, from the control plane`);
      peers = next;
      return void res.writeHead(204).end();
    }
    const artifactMatch = /^\/v1\/artifacts\/([^/]+)$/.exec(path);
    if (artifactMatch && req.method === "GET") {
      const id = decodeURIComponent(artifactMatch[1]!);
      const wanted = new URL(req.url ?? "/", "http://probe").searchParams.get("sha256");
      if (wanted === null) return send(res, 400, "name the sha256 the copy must have, as ?sha256=");
      if (!isPortableArtifactId(id) || !await backend.artifacts.has(id)) return send(res, 404, `this node holds no image or template ${id}. A checkpoint never leaves its node`);
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
    if (path === "/v1/node-health") {
      if (req.method !== "GET") return send(res, 405, `${req.method} is not allowed on ${path}: node health is read-only`);
      const health = await readNodeHealth(node, { root: "/", storage, pylons: await backend.processes?.() ?? null, sampleMs: healthSampleMs });
      return send(res, 200, JSON.stringify(health), "application/json");
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
    if (await backend.state(pylonId) !== "running") return refuse(socket, 409, `${pylonId} is not running`);
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
  try {
    server.listen(options.port, options.host);
    await once(server, "listening");
  } catch (err) {
    await previews?.gateway.close(); // its port is fixed, so a retry in this process needs it free
    throw err;
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`unexpected server address ${address}`);
  const bridge = await backend.hostBridge?.(api.answer).catch(async (err: unknown) => {
    await Promise.all([new Promise((resolve) => server.close(resolve)), previews?.gateway.close()]);
    throw err;
  });
  const listeningTimer = setInterval(() => void listeningPoll.join(), options.listeningPollMs ?? 10_000);

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
  if (!socket.destroyed) socket.end(rawResponse(status, { "content-type": "text/plain; charset=utf-8", connection: "close" }, body));
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType }).end(body);
}
