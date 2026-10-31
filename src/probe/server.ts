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
import { setTimeout as delay } from "node:timers/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type BackendPylon, type VmBackend } from "../backend.ts";
import { commandPolicies, runCommand, runJob, type CommandPolicy, type ProbeDeps } from "./run.ts";
import { isPortableArtifactId, type JobId, type NodeName, type PylonId, type TailnetNodeId } from "../ids.ts";
import {
  encodeSubmitReply, jobDeadlineMs, JobFailure, jobSubject, parseJobEnvelope, type Job, type JobEnvelope, type JobStatus, type Subject,
} from "../protocol/jobs.ts";
import { encodeProbeEvent, heldSecrets, type NodeObservation, type ProbeEvent } from "../protocol/observations.ts";
import { parsePylonCommand, type CommandResult, type PylonCommand } from "../protocol/commands.ts";
import { parseStreamRequest, serveByteStream, streamUpgradeResponse } from "../protocol/streams.ts";
import { artifactHeaders, fetchArtifact } from "../protocol/artifacts.ts";
import { peersSchema, probePort, routeAuth, type ProbeAuthConfig } from "../protocol/routes.ts";
import { linkedName, type ServiceName } from "../services-file.ts";
import { onePerClaudeSession } from "../session-wake.ts";
import type { Whois } from "../tailscale.ts";
import { readBody } from "../request-body.ts";
import { redact } from "./redact.ts";
import { hostCapacity, readNodeHealth } from "./host.ts";
import { rawResponse, startGateway } from "./gateway.ts";
import { createPylonApi } from "./pylon-api.ts";
import { createTailscaleServe, parseServeStatus, readRoutes, type HttpsGet, type TailscaleCli } from "./serve.ts";
import { serialQueue, singleFlight } from "../single-flight.ts";
import type { NodeSecrets } from "./config.ts";
import { createFactReader, notRunning, type PylonState } from "./pylon-facts.ts";
import { afterShutdown, readShutdownRecord, saveShutdownRecord, type DrainOutcome, type ShutdownRecord } from "./shutdown.ts";

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
  /** The node's shutdown record, in the probe's state directory (see shutdown.ts). Omitted: it lives in memory only. */
  shutdownFile?: string;
  /** The paths Nexus writes to besides the backend's storage, whose filesystems the node reports. */
  watched?: readonly string[];
}

export interface Probe {
  readonly port: number;
  readonly bootId: string;
  /**
   * For the node's shutdown: refuses every new job until close, stops the spawns that run and waits for every other
   * job on a pylon, then pauses each running pylon, all within `withinMs`. The shutdown record names each of them
   * before the first pause starts, so the probe of the next boot marks them for a wake even after a crash. A second
   * call gets the first one's outcomes.
   */
  drain(withinMs: number): Promise<readonly DrainOutcome[]>;
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
const claudeSendMemoryMs = 60 * 60_000;
/** How long a drain waits for its last events to leave for each observer. */
const observerFlushMs = 1_000;

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
  /**
   * The node's last shutdown, as its record says: each pylon it found running that no spawn or delete has dealt with
   * since. Snapshots mark these for a wake. A drain writes a record of its own, which only the next boot's probe loads.
   */
  const lastShutdown: ShutdownRecord = options.shutdownFile === undefined ? new Map() : await readShutdownRecord(options.shutdownFile);
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
  /** `flushed` settles once the observer's last write has left the probe, or failed to. */
  const observers = new Set<{ write(event: ProbeEvent): void; drop(err: Error): void; flushed(): Promise<void> }>();
  /** Each running job's run, which settles once its result is published. */
  const runningJobs = new Map<Promise<JobStatus>, Job>();
  /** Aborted once the node's shutdown drains the probe, which then starts no job but the drain's own pauses. */
  const draining = new AbortController();

  /** Saves run in the order they were asked for, so the drain's record, asked for last, is the one the file keeps. */
  const recordSaves = serialQueue();
  function saveRecord(record: ShutdownRecord): Promise<void> {
    const copy = new Map(record);
    return recordSaves.run(async () => { if (options.shutdownFile !== undefined) await saveShutdownRecord(options.shutdownFile, copy); })
      .catch((err: Error) => log(`shutdown record: ${err.message}`));
  }
  function forgetShutdown(pylonId: PylonId) {
    if (lastShutdown.delete(pylonId) && !draining.signal.aborted) void saveRecord(lastShutdown);
  }
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

  const storage = backend.storage ?? null;
  const watched = options.watched ?? [];

  /** What leaves the node in a failure, with every value this probe holds, and what looks like a secret, redacted. */
  const redacted = (text: string) => redact(text, options.secrets.names().flatMap((name) => options.secrets.value(name) ?? []));
  const { listening, observation } = createFactReader({ backend, log, redacted, pylons, pylon, relinked });

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
    const [listed, host] = await Promise.all([backend.list(), hostCapacity(storage, watched)]);
    // A running pylon's disk has moved on from the checkpoint it booted from, so only stopped disks count.
    const artifacts = [...await backend.artifacts.list(), ...listed.flatMap((p) => p.vm === "stopped" && p.checkpoint !== null ? [p.checkpoint] : [])];
    const present = new Set(listed.map((p) => p.pylonId));
    // Not dropped: a spawn in flight compares `diverged` at its start and its end, and a list can miss its pylon.
    for (const [id, state] of pylons) if (!present.has(id)) notRunning(state);
    for (const id of lastShutdown.keys()) if (!present.has(id)) forgetShutdown(id);
    return {
      node,
      observedAt: new Date().toISOString(),
      probeBootId: bootId,
      events: journal.recent(),
      capacity: {
        cpus: host.cpus, committedCpus: sum(listed, "cpus"),
        memoryGiB: host.memoryGiB, committedMemoryGiB: sum(listed, "memoryGiB"),
        diskFreeGiB: host.disk.freeGiB, committedDiskGiB: sum(listed, "diskGiB"), disks: host.disks,
      },
      artifacts,
      jobs,
      pylons: await Promise.all(listed.map(async (p) => afterShutdown(await observation(p), lastShutdown.get(p.pylonId)))),
      previewRoutes: previews === null ? [] : [...previews.gateway.routes].map(([httpsPort, route]) => ({ httpsPort, ...route })),
      grants: { secrets: options.secrets.names(), gitSsh: backend.gitSsh ?? false },
      spawnsWithoutRelaunch: true,
      ...backend.nestedVirtualization === true ? { nestedVirtualization: true as const } : {},
      heldSecrets,
    };
  }

  /** `ended` settles with the job's result once it is published. */
  function start(env: JobEnvelope, subject: Subject, deadlineMs = deadlines[env.job.kind]): { running: JobStatus; ended: Promise<JobStatus> } {
    const { job, jobId } = env;
    const base = { jobId, subject, kind: job.kind };
    const running: JobStatus = { ...base, state: "running", startedAt: new Date().toISOString() };
    busy.set(subject, jobId);
    setStatus(running, null);
    if (job.kind === "pause") runEnded(pylon(job.pylonId));
    if (job.kind === "delete") pylons.delete(job.pylonId);
    // A drain stops a boot rather than wait for it, as it pauses the pylon next.
    const signal = AbortSignal.any([AbortSignal.timeout(deadlineMs), shutdown.signal, ...job.kind === "spawn" ? [draining.signal] : []]);
    const seen = job.kind === "spawn" ? pylon(job.pylonId).diverged : undefined;
    const end = (status: JobStatus): JobStatus => {
      setStatus(status, Date.now());
      return status;
    };
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
        if (job.kind === "spawn" || job.kind === "delete") forgetShutdown(job.pylonId);
        return end({ ...base, state: "succeeded", finishedAt: new Date().toISOString() });
      },
      (err: unknown) => {
        if (!(err instanceof JobFailure)) throw err;
        return end({ ...base, state: "failed", finishedAt: new Date().toISOString(), code: err.code, message: redacted(err.message), logTail: redacted(err.logTail) });
      },
    ).finally(() => {
      busy.delete(subject);
      runningJobs.delete(run);
    }).then(async (status) => {
      await publishSnapshot();
      return status;
    });
    runningJobs.set(run, job);
    return { running, ended: run };
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
    if (draining.signal.aborted) return encodeSubmitReply({ rejected: "draining" });
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
    return encodeSubmitReply({ accepted: start(env, subject).running });
  }

  let drained: Promise<readonly DrainOutcome[]> | undefined;
  async function drainPylons(withinMs: number): Promise<readonly DrainOutcome[]> {
    const startedAt = Date.now();
    const left = () => Math.max(0, startedAt + withinMs - Date.now());
    const outOfTime = `it did not pause within the shutdown's ${withinMs / 1000} s`;
    draining.abort(new Error("the node is shutting down"));
    // A pause the control plane sent finishes as it would have, and its pylon is then no longer running.
    const onPylons = [...runningJobs].filter(([, job]) => "pylonId" in job).map(([run]) => run);
    await Promise.race([Promise.allSettled(onPylons), delay(left(), undefined, { ref: false })]);
    const listed = await backend.list();
    const present = new Set(listed.map((p) => p.pylonId));
    // A broken disk is left as it is, as the planner leaves it (see retryRefusal in reconcile.ts).
    const targets = listed.filter((p) => p.vm === "running" || p.vm === "booting" || p.vm === "stopping").map((p) => p.pylonId);
    const record: ShutdownRecord = new Map([...lastShutdown].filter(([id]) => present.has(id)));
    for (const pylonId of targets) record.set(pylonId, {});
    await saveRecord(record);
    const outcomes = await Promise.all(targets.map(async (pylonId): Promise<DrainOutcome> => {
      const pausing = Date.now();
      const budget = left();
      // Busy only with a job the wait above gave up on, as it ran past the shutdown's time. The race bounds a backend
      // that does not stop at the abort, as pylon-vm's stop does not.
      const status = busy.has(pylonId) ? null : await Promise.race([start({
        jobId: randomUUID() as JobId, node, issuedAt: new Date(pausing).toISOString(), notAfter: new Date(pausing).toISOString(),
        job: { kind: "pause", pylonId, checkpoint: `ckpt-${pylonId.replace(/^pylon-/, "")}-shutdown-${startedAt}` },
      }, pylonId, budget).ended, delay(budget, null, { ref: false })]);
      if (status?.state === "succeeded") return { pylonId, pausedInMs: Date.now() - pausing };
      const failed = status?.state === "failed" && status.code !== "deadline" ? status.message : outOfTime;
      record.set(pylonId, { failed });
      await saveRecord(record);
      return { pylonId, failed };
    }));
    // close() destroys the observe streams at once, which would drop the snapshot that shows the pylons paused.
    await Promise.race([Promise.all([...observers].map((o) => o.flushed())), delay(observerFlushMs, undefined, { ref: false })]);
    return outcomes;
  }

  async function observe(res: ServerResponse) {
    // Events that arrive while the first snapshot is built go out after it, in order, except older snapshots.
    const queued: ProbeEvent[] = [];
    let write = (event: ProbeEvent) => { queued.push(event); };
    let sent = Promise.resolve();
    const observer = { write: (event: ProbeEvent) => write(event), drop: (err: Error) => res.destroy(err), flushed: () => sent };
    observers.add(observer);
    const timer = setInterval(() => { snapshot().then((observation) => write({ type: "snapshot", observation }), observer.drop); }, snapshotIntervalMs);
    res.on("close", () => { observers.delete(observer); clearInterval(timer); });
    const first = await snapshot();
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    res.write(encodeProbeEvent({ type: "snapshot", observation: first }));
    write = (event) => { sent = new Promise((resolve) => res.write(encodeProbeEvent(event), () => resolve())); };
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

  const routes: readonly ProbeRoute[] = [{
    path: /^\/v1\/jobs\/([^/]+)$/, notAllowed: "",
    async PUT(req, res, match) {
      const jobId = decodeURIComponent(match[1]!) as JobId;
      const reply = submit(jobId, await readBody(req));
      return send(res, reply.status, reply.body, "application/json");
    },
    GET(_req, res, match) {
      const jobId = decodeURIComponent(match[1]!) as JobId;
      const job = jobs.get(jobId);
      return job ? send(res, 200, JSON.stringify(job.status), "application/json") : send(res, 404, `no job ${jobId}`);
    },
  }, {
    path: /^\/v1\/observe$/,
    GET(req, res) {
      // whois is async, so the caller or the probe may be gone by now, and nothing would remove the observer.
      if (req.socket.destroyed || shutdown.signal.aborted) return;
      return observe(res);
    },
  }, {
    path: /^\/v1\/pylons\/([^/]+)\/commands$/,
    async POST(req, res, match) {
      const pylonId = decodeURIComponent(match[1]!) as PylonId;
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
    },
  }, {
    path: /^\/v1\/manifests\/([^/]+)$/,
    async GET(_req, res, match) {
      const id = decodeURIComponent(match[1]!);
      if (!isPortableArtifactId(id)) return send(res, 400, `${JSON.stringify(id)} is not an image or template ID`);
      const manifest = await backend.artifacts.manifest(id);
      return manifest === null ? send(res, 404, `this node holds no ${id}`) : send(res, 200, JSON.stringify(manifest), "application/json");
    },
  }, {
    path: /^\/v1\/secrets\/([^/]+)$/, notAllowed: "",
    async PUT(req, res, match) {
      const name = decodeURIComponent(match[1]!);
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
    },
  }, {
    path: /^\/v1\/peers$/, notAllowed: "",
    async PUT(req, res) {
      let next: readonly TailnetNodeId[];
      try {
        next = peersSchema.parse(JSON.parse(await readBody(req)));
      } catch (err) {
        return send(res, 400, `the peers are a JSON array of tailnet node IDs: ${(err as Error).message}`);
      }
      if (next.join() !== peers.join()) log(`peers: ${next.join(", ") || "none"}, from the control plane`);
      peers = next;
      return void res.writeHead(204).end();
    },
  }, {
    path: /^\/v1\/artifacts\/([^/]+)$/,
    async GET(req, res, match) {
      const id = decodeURIComponent(match[1]!);
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
    },
  }, {
    path: /^\/v1\/node-health$/, notAllowed: ": node health is read-only",
    async GET(_req, res) {
      const health = await readNodeHealth(node, { root: "/", storage, watched, pylons: await backend.processes?.() ?? null, sampleMs: healthSampleMs });
      return send(res, 200, JSON.stringify(health), "application/json");
    },
  }];

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/v1/health" && req.socket.remoteAddress === req.socket.localAddress) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ commit: runningCommit }));
      return;
    }
    const path = new URL(req.url ?? "/", "http://probe").pathname;
    const route = (Object.keys(routeAuth) as (keyof typeof routeAuth)[]).find((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    if (route === undefined) return send(res, 404, `no route ${path}`);
    if (!await authorized(req, route)) return send(res, 403, "caller is not the tailnet node this route allows");

    for (const entry of routes) {
      const match = entry.path.exec(path);
      if (match === null) continue;
      const handler = req.method === "GET" || req.method === "PUT" || req.method === "POST" ? entry[req.method] : undefined;
      if (handler !== undefined) return handler(req, res, match);
      if (entry.notAllowed !== undefined) return send(res, 405, `${req.method} is not allowed on ${path}${entry.notAllowed}`);
      break;
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
    drain: (withinMs) => drained ??= drainPylons(withinMs),
    async close() {
      shutdown.abort(new Error("probe closed"));
      clearInterval(listeningTimer);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of streamSockets) socket.destroy();
      await Promise.allSettled([...runningJobs.keys()]);
      // A spawn that woke a pylon drops its mark, which a restart right after must not read back.
      await recordSaves.run(async () => {});
      await Promise.all([closed, previews?.gateway.close(), bridge?.close()]);
      journal.close();
    },
  };
}

/** An HTTP error on a socket that asked to upgrade, which has no ServerResponse. Does nothing once the socket is gone. */
function refuse(socket: Duplex, status: number, body: string) {
  if (!socket.destroyed) socket.end(rawResponse(status, { "content-type": "text/plain; charset=utf-8", connection: "close" }, body));
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray) => Promise<unknown> | void;
/**
 * A route under routeAuth: its whole path and a handler per method. With `notAllowed`, any other method answers 405
 * with it after the reason. Without it, another method falls through to the 501 or 404 below.
 */
interface ProbeRoute { path: RegExp; GET?: RouteHandler; PUT?: RouteHandler; POST?: RouteHandler; notAllowed?: string }

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType }).end(body);
}
