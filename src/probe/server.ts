/**
 * The probe's HTTP server: lifecycle jobs and observations. It keeps job results and applied live hashes in
 * memory only. Everything durable is the backend's, so a restart loses nothing a later job cannot rebuild.
 */
import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import { totalmem } from "node:os";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { JobFailure, runCommand, runJob, type BackendPylon, type ProbeDeps, type SecretSource, type VmBackend } from "../backend.ts";
import type { PortableArtifactId } from "../images.ts";
import {
  artifactHeaders, encodeProbeEvent, encodeSubmitReply, fetchArtifact, jobDeadlineMs, probePort, jobSubject, parseJobEnvelope, parsePylonCommand, parseStreamRequest, routeAuth, serveByteStream, streamUpgradeResponse,
  type Job, type JobEnvelope, type JobId, type JobStatus, type LiveHash, type NodeName, type NodeObservation,
  type DeclaredOutput, type ProbeAuthConfig, type ProbeEvent, type PylonCommand, type PylonId, type PylonObservation, type ServiceFact, type SessionFact, type Subject,
} from "../protocol.ts";
import { sessionFacts } from "../sessions.ts";
import type { Whois } from "../tailscale.ts";
import { listOutputs } from "../outputs.ts";
import { startGateway } from "./gateway.ts";
import { createPylonApi, type HostBridge } from "./pylon-api.ts";
import { createTailscaleServe, parseServeStatus, readRoutes, type HttpsGet, type TailscaleCli } from "./serve.ts";

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
/** Short, because snapshots are read one at a time and a stuck guest would hold up every observer. */
const sessionReadTimeoutMs = 3_000;
/** Longer, because a pylon's supervisor checks each service's health to answer. */
const serviceReadTimeoutMs = 5_000;

/** A probe without a preview gateway. An empty set is already converged. */
const noPreviews: ProbeDeps["serve"] = {
  async converge(_pylonId, previews) {
    if (previews.length > 0) throw new JobFailure("invalid", "this probe was started without a preview gateway");
  },
};

export async function startProbe(options: ProbeOptions): Promise<Probe> {
  const { node, backend, auth, whois } = options;
  const deadlines = options.jobDeadlineMs ?? jobDeadlineMs;
  const peerAddress = options.peerAddress ?? ((peer: NodeName) => ({ host: peer, port: probePort }));
  const bootId = randomUUID();
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
  const deps: ProbeDeps = {
    backend,
    secrets: options.secrets,
    serve: previews === null ? noPreviews : createTailscaleServe({ cli: previews.tailscale, gateway: previews.gateway, routesFile: previews.routesFile, get: previews.get }),
    node,
    fetchPeer: (from, artifact, sha256, signal) => fetchArtifact(peerAddress(from), artifact, sha256, { whois, peers: auth.peers }, signal),
  };
  const jobs = new Map<JobId, { status: JobStatus; finishedAt: number | null }>();
  const busy = new Map<Subject, JobId>();
  const liveHashes = new Map<PylonId, LiveHash>();
  /** The previews of each pylon's last successful spawn in this process, which published and warmed them. */
  const published = new Map<PylonId, Extract<Job, { kind: "spawn" }>["live"]["previews"]>();
  const observers = new Set<{ write(event: ProbeEvent): void; drop(err: Error): void }>();
  const runningJobs = new Set<Promise<void>>();
  const log = options.log ?? console.error;
  /** Upgraded sockets, which the HTTP server no longer tracks, so close() ends them itself. */
  const streamSockets = new Set<Duplex>();
  const ptyStreams = new Map<PylonId, number>();

  const emit = (event: ProbeEvent) => { if (!shutdown.signal.aborted) for (const observer of observers) observer.write(event); };
  const api = createPylonApi({
    guest: (pylonId) => backend.guest(pylonId),
    published: (pylonId) => published.get(pylonId) ?? [],
    changed: () => void publishSnapshot(),
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

  /**
   * Costs one guest exec (`herdr api snapshot`) per running pylon per snapshot, so a snapshot waits for the
   * slowest pylon, up to sessionReadTimeoutMs. A failed read reports null, never "no sessions".
   */
  async function sessions(pylonId: PylonId): Promise<readonly SessionFact[] | null> {
    try {
      return await sessionFacts(backend.guest(pylonId), sessionReadTimeoutMs);
    } catch {
      return null;
    }
  }

  /** A failed or late read reports null, never "no services", and is logged. */
  async function services(pylonId: PylonId): Promise<readonly ServiceFact[] | null> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${serviceReadTimeoutMs} ms`)), serviceReadTimeoutMs);
    });
    try {
      return (await Promise.race([backend.guest(pylonId).services("list"), late])).services;
    } catch (err) {
      log(`${pylonId} services: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Declared outputs only accumulate in the control plane, so a failed read reported as none loses nothing. `nexus output list` shows the failure. */
  async function declaredOutputs(pylonId: PylonId): Promise<readonly DeclaredOutput[]> {
    try {
      return await listOutputs(backend.guest(pylonId), sessionReadTimeoutMs);
    } catch {
      return [];
    }
  }

  async function observation(p: BackendPylon): Promise<PylonObservation> {
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
          // The other guest facts need guest operations, which this slice does not have.
          services: await services(pylonId), previews: (published.get(pylonId) ?? []).map((preview) => ({ ...preview, ready: true })), sessions: await sessions(pylonId), git: null, declaredOutputs: await declaredOutputs(pylonId), attachedClients: ptyStreams.get(pylonId) ?? 0,
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
      pylons: await Promise.all(pylons.map(observation)),
      previewRoutes: previews === null ? [] : [...previews.gateway.routes].map(([httpsPort, route]) => ({ httpsPort, ...route })),
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
    }
    const signal = AbortSignal.any([AbortSignal.timeout(deadlines[job.kind]), shutdown.signal]);
    const run = runJob(job, deps, signal).then(
      () => {
        if (job.kind === "spawn") {
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
      return send(res, 200, JSON.stringify(await runCommand(pylonId, command, deps)), "application/json");
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
    const { pylonId, request } = parsed;
    if ((await backend.list()).find((p) => p.pylonId === pylonId)?.vm !== "running") return refuse(socket, 409, `${pylonId} is not running`);
    if (socket.destroyed || shutdown.signal.aborted) return;
    const guest = await backend.guest(pylonId).stream(request, (text) => log(`${pylonId} stream ${request.argv[0]}: ${text.trimEnd()}`));
    socket.write(streamUpgradeResponse);
    const pty = request.pty !== null;
    if (pty) ptyStreams.set(pylonId, (ptyStreams.get(pylonId) ?? 0) + 1);
    try {
      await serveByteStream(socket, head, guest);
    } finally {
      if (pty) {
        const left = ptyStreams.get(pylonId)! - 1;
        if (left === 0) ptyStreams.delete(pylonId);
        else ptyStreams.set(pylonId, left);
      }
    }
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

  return {
    port: address.port,
    bootId,
    async close() {
      shutdown.abort(new Error("probe closed"));
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of streamSockets) socket.destroy();
      await Promise.allSettled([...runningJobs]);
      await Promise.all([closed, previews?.gateway.close(), bridge?.close()]);
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

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req as AsyncIterable<string>) {
    body += chunk;
    if (body.length > maxBodyBytes) throw new Error(`request body over ${maxBodyBytes} bytes`);
  }
  return body;
}
