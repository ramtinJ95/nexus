/**
 * The probe's HTTP server: lifecycle jobs and observations. It keeps job results and applied live hashes in
 * memory only. Everything durable is the backend's, so a restart loses nothing a later job cannot rebuild.
 */
import { dirname } from "node:path";
import { eventJournal } from "./event-journal.ts";
import { answerLocalHealth, runningCommit } from "../deploy/health.ts";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type BackendPylon, type VmBackend } from "../backends/backend.ts";
import { commandPolicies, runCommand, type CommandPolicy, type ProbeDeps } from "./run.ts";
import { createJobTable } from "./jobs.ts";
import { isPortableArtifactId, shutdownCheckpointId, type JobId, type PortableArtifactId, type NodeName, type PylonId, type TailnetNodeId } from "../ids.ts";
import { jobDeadlineMs, JobFailure, type Job } from "../protocol/jobs.ts";
import { encodeProbeEvent, heldSecrets, type NodeObservation, type ProbeEvent } from "../protocol/observations.ts";
import { parsePylonCommand, type CommandResult, type PylonCommand } from "../protocol/commands.ts";
import { notAnswering, parseStreamRequest, serveByteStream, streamUpgradeResponse, type ByteStream } from "../protocol/streams.ts";
import { artifactHeaders, fetchArtifact } from "../protocol/artifacts.ts";
import { dropRequestSchema, type ArtifactUsage, type DeleteOutcome, type DropRequest } from "../protocol/cleanup.ts";
import { peersSchema, probePort, probeRoutes, routeRole, type CallerRole, type GitReadReply, type ParamsOf, type ProbeAuthConfig, type ProbeRoute } from "../protocol/routes.ts";
import { linkedName, type ServiceName } from "../services-file.ts";
import { claudeSessionLock } from "./guest/session-wake.ts";
import type { Whois } from "../protocol/http.ts";
import { readBody } from "../request-body.ts";
import { redact } from "./redact.ts";
import { hostCapacity, readNodeHealth } from "./host.ts";
import { rawResponse, startGateway } from "./gateway.ts";
import { createPylonApi } from "./pylon-api.ts";
import { createTailscaleServe, parseServeStatus, readRoutes, type HttpsGet, type TailscaleCli } from "./serve.ts";
import { serialQueue, singleFlight } from "../single-flight.ts";
import type { NodeSecrets } from "./config.ts";
import { createPylonStates } from "./pylon-facts.ts";
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
  /** Tests only. How long a stream's guest has to start its process, and a process nobody reads to end once its stdin closes. */
  streamTiming?: { startMs: number; hangUpMs: number };
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
  /** The file whose change starts the node's deployer, through deploy/nexus-deployer.path. Omitted: a wake is refused. */
  deployerWakeFile?: string;
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
  // Under the control plane's 10 s, so a slow guest gets an answer that names it, not the control plane's timeout.
  const streamTiming = options.streamTiming ?? { startMs: 8_000, hangUpMs: 10_000 };
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
  /** What leaves the node in a failure, with every value this probe holds, and what looks like a secret, redacted. */
  const redacted = (text: string) => redact(text, options.secrets.names().flatMap((name) => options.secrets.value(name) ?? []));
  const pylons = createPylonStates({ backend, log, redacted });
  const serve = previews === null ? noPreviews : createTailscaleServe({ cli: previews.tailscale, gateway: previews.gateway, routesFile: previews.routesFile, get: previews.get });
  const deps: ProbeDeps = {
    backend,
    secrets: options.secrets,
    serve: {
      converge: (pylonId, assigned, signal) => serve.converge(pylonId, pylons.routed(pylonId, assigned), signal),
      withdraw: (pylonId, service) => pylons.withdraw(pylonId, service, () => serve.withdraw(pylonId, service)),
    },
    ports: { link: linkPort, unlink: unlinkPort },
    node,
    fetchPeer: (from, artifact, sha256, signal) => fetchArtifact(peerAddress(from), artifact, sha256, { whois, peers }, signal),
  };
  /** `flushed` settles once the observer's last write has left the probe, or failed to. */
  const observers = new Set<{ write(event: ProbeEvent): void; drop(err: Error): void; flushed(): Promise<void> }>();
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
    published: pylons.published,
    changed: () => void publishSnapshot(),
    ports: deps.ports,
    async previewUrls() {
      if (previews === null) return new Map();
      const served = parseServeStatus(await previews.tailscale(["serve", "status", "--json"], shutdown.signal), previews.gateway.origin);
      return new Map([...served].flatMap(([httpsPort, entry]) => entry.kind === "nexus" ? [[httpsPort, entry.url]] : []));
    },
  });

  const jobs = createJobTable({
    node, deadlines, deps, closed: shutdown.signal, draining: draining.signal, emit, redacted, publishSnapshot: () => publishSnapshot(),
    effects: { pylons, republished: () => api.republished(), forgetShutdown },
  });

  /** Between snapshots, a change in what a running pylon listens on publishes one. Without observers nobody would see it, so nothing is read. */
  const listeningPoll = singleFlight(async () => {
    if (observers.size === 0) return;
    if (await pylons.listeningChanged()) await publishSnapshot();
  }, () => shutdown.signal.aborted);

  const storage = backend.storage ?? null;
  const watched = options.watched ?? [];
  // An artifact never changes once published, so its size is read once.
  const artifactBytes = new Map<PortableArtifactId, number>();
  // What each cleanup delete freed, so a resent delete whose first reply was lost, as to a timeout, still reports it,
  // and each delete in flight, which a resend that arrives meanwhile waits for.
  const deleted = new Map<PortableArtifactId, number>();
  const deleting = new Map<PortableArtifactId, Promise<DeleteOutcome>>();
  async function dropOnce(id: PortableArtifactId): Promise<DeleteOutcome> {
    const run = (async (): Promise<DeleteOutcome> => {
      // Read as the delete starts, since another request may have deleted it while this one waited on an earlier item.
      // What the node lists is what its observation reported, and what the person was asked about.
      if (!(await backend.artifacts.list()).includes(id)) {
        // A delete a crash cut short left what it set aside, which the backend's drop of an absent artifact removes.
        await backend.artifacts.drop(id).catch(() => undefined);
        const freed = deleted.get(id);
        return freed === undefined ? { state: "gone" } : { state: "deleted", bytes: freed };
      }
      const bytes = await sizeOf(id) ?? 0;
      try {
        await backend.artifacts.drop(id);
      } catch (err) {
        return { state: "skipped", reason: (err as Error).message };
      }
      artifactBytes.delete(id);
      deleted.set(id, bytes);
      log(`artifact ${id}: deleted by the person's cleanup, freeing ${bytes} bytes`);
      return { state: "deleted", bytes };
    })();
    deleting.set(id, run);
    try { return await run; } finally { deleting.delete(id); }
  }
  const sizeOf = async (id: PortableArtifactId): Promise<number | null> => {
    const known = artifactBytes.get(id);
    if (known !== undefined) return known;
    const bytes = await backend.artifacts.bytes?.(id) ?? null;
    if (bytes !== null) artifactBytes.set(id, bytes);
    return bytes;
  };

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
      pylons.relinked(pylonId, service);
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
    const retained = jobs.retained();
    const [listed, host] = await Promise.all([backend.list(), hostCapacity(storage, watched)]);
    // A running pylon's disk has moved on from the checkpoint it booted from, so only stopped disks count.
    const artifacts = [...await backend.artifacts.list(), ...listed.flatMap((p) => p.vm === "stopped" && p.checkpoint !== null ? [p.checkpoint] : [])];
    const present = new Set(listed.map((p) => p.pylonId));
    pylons.missing(present);
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
      jobs: retained,
      pylons: await Promise.all(listed.map(async (p) => afterShutdown(await pylons.observation(p), lastShutdown.get(p.pylonId)))),
      previewRoutes: previews === null ? [] : [...previews.gateway.routes].map(([httpsPort, route]) => ({ httpsPort, ...route })),
      grants: { secrets: options.secrets.names(), gitSsh: backend.gitSsh ?? false },
      ...backend.nestedVirtualization === true ? { nestedVirtualization: true as const } : {},
      heldSecrets,
    };
  }

  /**
   * A full snapshot rather than a pylon event, because a pylon event cannot say that a pylon is gone. Calls while one
   * is read share one more read after it, which runs in the read queue, so it sees each link or unlink queued before it.
   */
  /** The latest published snapshot's time, and how many have been published. */
  let publishedAt: string | null = null;
  let published = 0;
  const publisher = singleFlight(async () => {
    if (observers.size === 0) return;
    // Observers that cannot get the new state lose their link, so they reconnect for a fresh snapshot.
    await snapshot().then((observation) => {
      publishedAt = observation.observedAt;
      published++;
      emit({ type: "snapshot", observation });
    }, (err: Error) => { for (const o of observers) o.drop(err); });
  }, () => shutdown.signal.aborted);
  const publishSnapshot = (): Promise<void> => publisher.rerun();

  let drained: Promise<readonly DrainOutcome[]> | undefined;
  async function drainPylons(withinMs: number): Promise<readonly DrainOutcome[]> {
    const startedAt = Date.now();
    const left = () => Math.max(0, startedAt + withinMs - Date.now());
    const outOfTime = `it did not pause within the shutdown's ${withinMs / 1000} s`;
    draining.abort(new Error("the node is shutting down"));
    // A pause the control plane sent finishes as it would have, and its pylon is then no longer running.
    const onPylons = [...jobs.running].filter(([, job]) => "pylonId" in job).map(([run]) => run);
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
      const status = jobs.busy(pylonId) ? null : await Promise.race([jobs.start({
        jobId: randomUUID() as JobId, node, issuedAt: new Date(pausing).toISOString(), notAfter: new Date(pausing).toISOString(),
        job: { kind: "pause", pylonId, checkpoint: shutdownCheckpointId(pylonId, startedAt) },
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

  async function authorized(req: IncomingMessage, role: CallerRole): Promise<boolean> {
    const { remoteAddress, remotePort } = req.socket;
    if (remoteAddress === undefined || remotePort === undefined) return false;
    const caller = await whois(remoteAddress, remotePort);
    if (caller === null) return false;
    return role === "control-plane" ? caller === auth.controlPlane : peers.includes(caller);
  }

  /**
   * The route a request reaches, or the status it is refused with. A route on a pylon is reached only while the pylon
   * runs. `upgrade` is the protocol an upgrade asks for, which only a route that upgrades to it serves.
   */
  async function routeOf(req: IncomingMessage, path: string, upgrade?: string): Promise<Routed> {
    const role = routeRole(path);
    if (role === undefined) return { status: 404, reason: upgrade === undefined ? `no route ${path}` : `no upgrade route ${path}` };
    if (!await authorized(req, role)) return { status: 403, reason: "caller is not the tailnet node this route allows" };
    const noRoute = { status: 404, reason: upgrade === undefined ? `no route ${req.method} ${path}` : `no upgrade route ${path} for ${upgrade}` };
    const at = tablePaths.find(({ pattern }) => pattern.test(path));
    if (at === undefined) return noRoute;
    const name = at.names.find((n) => probeRoutes[n].method === req.method && (probeRoutes[n] as ProbeRoute).upgrade === upgrade?.toLowerCase());
    if (name === undefined) {
      const suffix = upgrade === undefined ? at.names.map((n) => notAllowed[n]).find((r) => r !== undefined) : undefined;
      return suffix === undefined ? noRoute : { status: 405, reason: `${req.method} is not allowed on ${path}${suffix}` };
    }
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(Object.entries(at.pattern.exec(path)!.groups ?? {}).map(([key, value]) => [key, decodeURIComponent(value)]));
    } catch (err) {
      return { status: 400, reason: (err as Error).message };
    }
    if (params.pylonId !== undefined) {
      const vm = await backend.state(params.pylonId as PylonId);
      if (vm !== "running") return { status: 409, reason: `${params.pylonId} is ${vm}, not running` };
    }
    return { name, params };
  }

  const handlers: { [K in HttpRouteName]: (req: IncomingMessage, res: ServerResponse, params: ParamsOf<(typeof probeRoutes)[K]["path"]>) => Promise<unknown> | void } = {
    async submit(req, res, { jobId }) {
      const reply = jobs.submit(jobId as JobId, await readBody(req));
      return send(res, reply.status, reply.body, "application/json");
    },
    job(_req, res, { jobId }) {
      const status = jobs.status(jobId as JobId);
      return status ? send(res, 200, JSON.stringify(status), "application/json") : send(res, 404, `no job ${jobId}`);
    },
    observe(req, res) {
      // whois is async, so the caller or the probe may be gone by now, and nothing would remove the observer.
      if (req.socket.destroyed || shutdown.signal.aborted) return;
      return observe(res);
    },
    async command(req, res, params) {
      const pylonId = params.pylonId as PylonId;
      let command: PylonCommand;
      try {
        command = parsePylonCommand(await readBody(req));
      } catch (err) {
        return send(res, 400, (err as Error).message);
      }
      const asked = command;
      // Each kind's policy takes its own kind of command and result, which command.kind picks.
      const policy = commandPolicies[command.kind] as CommandPolicy<PylonCommand["kind"]>;
      const run = () => asked.kind === "send-claude-outcome" ? outcomeOf(pylonId, asked.requestId) : runCommand(pylonId, asked, deps);
      const session = typeof policy.lock === "function" ? policy.lock(command) : undefined;
      const running = session !== undefined ? claudeSessionLock(pylonId)([session], run) : run();
      if (policy.remembered && "requestId" in command && command.requestId !== undefined) remember(pylonId, command.requestId, running);
      const result = await running;
      if (typeof policy.publishes === "function" ? policy.publishes(result) : policy.publishes) void publishSnapshot();
      return send(res, 200, JSON.stringify(result), "application/json");
    },
    async readGit(_req, res, params) {
      const pylonId = params.pylonId as PylonId;
      // In the read queue, so no read in flight stores a git read from before the drop, and every snapshot published
      // after it reads git again.
      const before = await betweenReads(async () => { pylons.dropGit(pylonId); return published; });
      await publishSnapshot();
      if (published === before) return send(res, 503, "no snapshot was published, as nothing observes this node or the read failed");
      return send(res, 200, JSON.stringify({ observedAt: publishedAt! } satisfies GitReadReply), "application/json");
    },
    async manifest(_req, res, { artifact }) {
      if (!isPortableArtifactId(artifact)) return send(res, 400, `${JSON.stringify(artifact)} is not an image or template ID`);
      const manifest = await backend.artifacts.manifest(artifact);
      return manifest === null ? send(res, 404, `this node holds no ${artifact}`) : send(res, 200, JSON.stringify(manifest), "application/json");
    },
    async putSecret(req, res, { name }) {
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
    },
    async putPeers(req, res) {
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
    async wakeDeployer(_req, res) {
      if (options.deployerWakeFile === undefined) return send(res, 404, "this probe wakes no deployer");
      try {
        await writeFile(options.deployerWakeFile, `${new Date().toISOString()}\n`);
      } catch (err) {
        return send(res, 503, `the deployer's wake file could not be written: ${(err as Error).message}`);
      }
      return void res.writeHead(204).end();
    },
    async fetchArtifact(req, res, { artifact: id }) {
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
    async artifactUsage(_req, res) {
      const sized = await Promise.all((await backend.artifacts.list()).map(async (id) => ({ id, bytes: await sizeOf(id) })));
      const usage: ArtifactUsage = { artifacts: sized.filter((a): a is { id: PortableArtifactId; bytes: number } => a.bytes !== null) };
      return send(res, 200, JSON.stringify(usage), "application/json");
    },
    /** The backend refuses an artifact a pylon, a template or a create still needs, which leaves it skipped with the refusal. */
    async dropArtifacts(req, res) {
      let asked: DropRequest;
      try {
        asked = dropRequestSchema.parse(JSON.parse(await readBody(req)));
      } catch (err) {
        return send(res, 400, `a cleanup names the artifacts to delete, as {"drop": [...]}: ${(err as Error).message}`);
      }
      const outcomes: Record<string, DeleteOutcome> = {};
      for (const id of new Set(asked.drop)) outcomes[id] = await (deleting.get(id) ?? dropOnce(id));
      void publishSnapshot();
      return send(res, 200, JSON.stringify({ outcomes }), "application/json");
    },
    async health(_req, res) {
      const health = await readNodeHealth(node, { root: "/", storage, watched, pylons: await backend.processes?.() ?? null, sampleMs: healthSampleMs });
      return send(res, 200, JSON.stringify(health), "application/json");
    },
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (answerLocalHealth(req, res, () => ({ commit: runningCommit }))) return;
    const routed = await routeOf(req, new URL(req.url ?? "/", "http://probe").pathname);
    if ("status" in routed) return send(res, routed.status, routed.reason);
    // routeOf reaches an upgrade route only for an upgrade, and gives each route the parameters its path names.
    const handler = handlers[routed.name as HttpRouteName] as (req: IncomingMessage, res: ServerResponse, params: Readonly<Record<string, string>>) => Promise<unknown> | void;
    return handler(req, res, routed.params);
  }

  /** GET /v1/pylons/{id}/stream. The guest process starts before the 101, so a pylon that cannot run it gets an HTTP error instead. */
  async function stream(req: IncomingMessage, socket: Duplex, head: Buffer, left: AbortSignal) {
    const url = new URL(req.url ?? "/", "http://probe");
    const routed = await routeOf(req, url.pathname, req.headers.upgrade ?? "");
    if ("status" in routed) return refuse(socket, routed.status, routed.reason);
    let parsed: ReturnType<typeof parseStreamRequest>;
    try {
      parsed = parseStreamRequest(req.headers.upgrade, url);
    } catch (err) {
      return refuse(socket, 400, (err as Error).message);
    }
    if (parsed === null) return refuse(socket, 404, `no upgrade route ${url.pathname} for ${req.headers.upgrade}`);
    const { pylonId, argv } = parsed;
    const gone = AbortSignal.any([left, shutdown.signal]);
    if (gone.aborted) return void socket.destroy();
    const slow = AbortSignal.timeout(streamTiming.startMs);
    const given = AbortSignal.any([gone, slow]);
    const starting = backend.guest(pylonId).stream(argv, (text) => log(`${pylonId} stream ${argv[0]}: ${text.trimEnd()}`), given);
    const started = await Promise.race([starting.then((guest) => ({ guest }), (err: unknown) => ({ err })), abortedSignal(given)]);
    if (started !== null && "guest" in started && !given.aborted) {
      socket.write(streamUpgradeResponse);
      return await serveByteStream(socket, head, started.guest);
    }
    // A guest that ignores the signal can still start the process, and nobody will read it.
    void starting.then(letGo, () => undefined);
    if (gone.aborted) return void socket.destroy();
    if (slow.aborted) return refuse(socket, 504, notAnswering(pylonId, streamTiming.startMs));
    throw (started as { err: unknown }).err;
  }

  /** Closes the stdin of a process nobody reads, which a relay takes as a hang-up, and drops it unless it exits within hangUpMs. */
  async function letGo(guest: ByteStream) {
    const drained = (async () => { for await (const _ of guest) { /* drained, so the process can exit */ } })().catch(() => undefined);
    const ended = await Promise.race([guest.close().catch(() => undefined).then(() => drained).then(() => guest.done).then(() => true), delay(streamTiming.hangUpMs, false, { ref: false })]);
    if (!ended) guest.abort();
    await drained;
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
    const left = new AbortController();
    // The server keeps a socket half open, so a caller that gave up before the 101 only ends its side.
    socket.once("end", () => left.abort());
    socket.on("close", () => {
      streamSockets.delete(socket);
      left.abort();
    });
    stream(req, socket, head, left.signal).catch((err: unknown) => {
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
      await Promise.allSettled([...jobs.running.keys()]);
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

type RouteName = keyof typeof probeRoutes;
type Routed = { name: RouteName; params: Readonly<Record<string, string>> } | { status: number; reason: string };
type HttpRouteName = { [K in RouteName]: (typeof probeRoutes)[K] extends { upgrade: string } ? never : K }[RouteName];
/** Each path of probeRoutes as a pattern that names its parameters, with the routes that serve it. */
const tablePaths = [...new Set(Object.values(probeRoutes).map((route) => route.path))].map((path) => ({
  pattern: new RegExp(`^${path.split(/\{(\w+)\}/).map((part, i) => i % 2 === 1 ? `(?<${part}>[^/]+)` : RegExp.escape(part)).join("")}$`),
  names: (Object.keys(probeRoutes) as RouteName[]).filter((name) => probeRoutes[name].path === path),
}));
/** A method no route of a path serves answers 405, with the entry after the reason, at these paths, and 404 at the others. */
const notAllowed: Partial<Record<RouteName, string>> = { submit: "", putSecret: "", putPeers: "", wakeDeployer: "", health: ": node health is read-only" };

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType }).end(body);
}

const abortedSignal = (signal: AbortSignal) => new Promise<null>((resolve) => {
  if (signal.aborted) return resolve(null);
  signal.addEventListener("abort", () => resolve(null), { once: true });
});
