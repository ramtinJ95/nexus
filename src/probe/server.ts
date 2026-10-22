/**
 * The probe's HTTP server: lifecycle jobs and observations. It keeps job results and applied live hashes in
 * memory only. Everything durable is the backend's, so a restart loses nothing a later job cannot rebuild.
 */
import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { totalmem } from "node:os";
import { JobFailure, runJob, type BackendPylon, type ProbeDeps, type SecretSource, type VmBackend } from "../backend.ts";
import {
  encodeProbeEvent, encodeSubmitReply, jobDeadlineMs, jobSubject, parseJobEnvelope, routeAuth,
  type Job, type JobEnvelope, type JobId, type JobStatus, type LiveHash, type NodeName, type NodeObservation,
  type ProbeAuthConfig, type ProbeEvent, type PylonId, type PylonObservation, type Subject,
} from "../protocol.ts";
import type { Whois } from "../tailscale.ts";

export interface ProbeOptions {
  node: NodeName;
  host: string;
  /** 0 picks a free port. */
  port: number;
  auth: ProbeAuthConfig;
  whois: Whois;
  backend: VmBackend;
  secrets: SecretSource;
  jobDeadlineMs?: { readonly [K in Job["kind"]]: number };
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

/** This slice publishes no previews. An empty set is already converged. */
const noPreviews: ProbeDeps["serve"] = {
  async converge(_pylonId, previews) {
    if (previews.length > 0) throw new JobFailure("invalid", "this slice does not publish previews yet");
  },
};

export async function startProbe(options: ProbeOptions): Promise<Probe> {
  const { node, backend, auth, whois } = options;
  const deadlines = options.jobDeadlineMs ?? jobDeadlineMs;
  const deps: ProbeDeps = {
    backend,
    secrets: options.secrets,
    serve: noPreviews,
    fetchPeer: () => Promise.reject(new Error("this slice does not fetch artifacts from peers yet")),
  };
  const bootId = randomUUID();
  const shutdown = new AbortController();
  const jobs = new Map<JobId, { status: JobStatus; finishedAt: number | null }>();
  const busy = new Map<Subject, JobId>();
  const liveHashes = new Map<PylonId, LiveHash>();
  const observers = new Set<{ write(event: ProbeEvent): void; drop(err: Error): void }>();
  const runningJobs = new Set<Promise<void>>();

  const emit = (event: ProbeEvent) => { if (!shutdown.signal.aborted) for (const observer of observers) observer.write(event); };

  function setStatus(status: JobStatus, finishedAt: number | null) {
    jobs.set(status.jobId, { status, finishedAt });
    emit({ type: "job", status });
  }

  function retainedJobs(): JobStatus[] {
    const cutoff = Date.now() - jobRetentionMs;
    for (const [id, job] of jobs) if (job.finishedAt !== null && job.finishedAt < cutoff) jobs.delete(id);
    return [...jobs.values()].map((job) => job.status);
  }

  function observation(p: BackendPylon): PylonObservation {
    const { pylonId } = p;
    switch (p.vm) {
      case "booting": case "stopping": case "deleting": return { pylonId, phase: p.vm };
      case "stopped": return { pylonId, phase: "stopped", checkpoint: p.checkpoint };
      case "broken": return { pylonId, phase: "broken", detail: p.detail ?? "the backend gave no detail" };
      case "running":
        if (p.bootedAt === null) throw new Error(`backend reports ${pylonId} running with no boot time`);
        return {
          pylonId, phase: "running", liveHash: liveHashes.get(pylonId) ?? null, bootedAt: p.bootedAt,
          bootedFrom: { image: p.image, checkpoint: p.checkpoint },
          // Guest facts need guest operations, which this slice does not have.
          services: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
        };
    }
  }

  /**
   * Reads run one at a time, so snapshots resolve, and are published, in the order they were read. Otherwise a
   * slow periodic read could publish a pylon as running after a later read reported it paused.
   */
  let snapshots: Promise<unknown> = Promise.resolve();
  function snapshot(): Promise<NodeObservation> {
    const next = snapshots.then(readSnapshot);
    snapshots = next.catch(() => undefined); // the caller handles the error. The queue only needs to move on
    return next;
  }

  async function readSnapshot(): Promise<NodeObservation> {
    // Jobs before pylons, so the pylons show the result of every job listed as finished. See NodeObservation.jobs.
    const jobs = retainedJobs();
    const [pylons, artifacts, disk] = await Promise.all([backend.list(), backend.artifacts.list(), statfs("/")]);
    return {
      node,
      observedAt: new Date().toISOString(),
      probeBootId: bootId,
      // VmBackend does not report reserved memory yet.
      capacity: { memoryGiB: totalmem() / 2 ** 30, committedMemoryGiB: 0, diskFreeGiB: (disk.bavail * disk.bsize) / 2 ** 30 },
      artifacts,
      jobs,
      pylons: pylons.map(observation),
    };
  }

  function start(env: JobEnvelope, subject: Subject): JobStatus {
    const { job, jobId } = env;
    const base = { jobId, subject, kind: job.kind };
    const running: JobStatus = { ...base, state: "running", startedAt: new Date().toISOString() };
    busy.set(subject, jobId);
    setStatus(running, null);
    if (job.kind === "pause" || job.kind === "delete") liveHashes.delete(job.pylonId);
    const signal = AbortSignal.any([AbortSignal.timeout(deadlines[job.kind]), shutdown.signal]);
    const run = runJob(job, deps, signal).then(
      () => {
        if (job.kind === "spawn") liveHashes.set(job.pylonId, job.liveHash);
        setStatus({ ...base, state: "succeeded", finishedAt: new Date().toISOString() }, Date.now());
      },
      (err: unknown) => {
        if (!(err instanceof JobFailure)) throw err;
        setStatus({ ...base, state: "failed", finishedAt: new Date().toISOString(), code: err.code, message: err.message, logTail: err.logTail }, Date.now());
      },
    ).finally(() => {
      busy.delete(subject);
      runningJobs.delete(run);
    }).then(() => {
      // A full snapshot rather than a pylon event, because a pylon event cannot say that a pylon is gone.
      if (observers.size === 0 || shutdown.signal.aborted) return;
      // Observers that cannot get the new state lose their link, so they reconnect for a fresh snapshot.
      return snapshot().then((observation) => emit({ type: "snapshot", observation }), (err: Error) => { for (const o of observers) o.drop(err); });
    });
    runningJobs.add(run);
    return running;
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
    if (route === "/v1/pylons" || route === "/v1/artifacts") return send(res, 501, `${route} is not implemented in this slice`);
    return send(res, 404, `no route ${req.method} ${path}`);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.destroy(err as Error);
      send(res, 500, (err as Error).message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`unexpected server address ${address}`);

  return {
    port: address.port,
    bootId,
    async close() {
      shutdown.abort(new Error("probe closed"));
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.allSettled([...runningJobs]);
      await closed;
    },
  };
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType }).end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req as AsyncIterable<string>) {
    body += chunk;
    if (body.length > maxBodyBytes) throw new Error(`request body over ${maxBodyBytes} bytes`);
  }
  return body;
}
