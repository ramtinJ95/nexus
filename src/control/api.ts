import { DeployDraining, isDraining, turnGate, type TurnGate } from "./drain.ts";
import { runningCommit } from "../deploy/health.ts";
import { version } from "../version.ts";
import { canDeploy, isPerson, isReporter, type DeploymentOptions } from "./releases.ts";
/**
 * The control plane's HTTP API for the dashboard and the CLI. JSON in and out.
 *
 * Each thread's agent is a conversation in the control plane's harness, a Claude Code worker in its pylon, or none, as
 * the registry's `agent` says, and thread-agent.ts holds what each kind does. The API creates a harness conversation
 * with the thread, forwards messages, aborts and retries to it, and serves its view. A Claude worker's messages are
 * typed into its session, and its view is its transcript as claude-conversation.ts reads it.
 *
 * A thread's conversation also streams, as server-sent events: its view, or a Claude worker's transcript, for the
 * CLI, and the thread page's conversation for the dashboard. Each stream holds one watch, on the harness or on a
 * Claude worker's transcript, and sends what changed since its last event, so a slow client gets fewer, larger
 * events and never holds the harness up.
 *
 * A thread's pylon also gives a terminal on its Herdr session, over a WebSocket on the attach route, which
 * control/attach.ts serves.
 *
 * Like the probe, it trusts tailnet identity: each caller's stable node ID, from tailscaled's whois, must be
 * on the allowlist. The API writes only what a human asks for. Every change that can move a pylon
 * wakes the loop for its node, so a start or a dashboard visit acts within one pass rather than 5 seconds.
 */
import { once } from "node:events";
import { createServer as createHttpsServer } from "node:https";
import { TLSSocket } from "node:tls";
import type { Certificate } from "../tailscale.ts";
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { NodeName, TailnetNodeId } from "../ids.ts";
import type { ProbeError } from "../protocol/http.ts";
import type { NodeHealth, ProbeClient } from "../protocol/client.ts";
import type { Whois, WhoisNode } from "../tailscale.ts";
import { joinNode, joinRequestSchema } from "./join.ts";
import type { JoinedNode, PortRange, Registry, StartKey, StoredPylon, Thread, ThreadId } from "./registry.ts";
import { dashboard } from "./dashboard.ts";
import { liveStreams } from "./dashboard/live-frames.ts";
import { attachScript } from "../sessions.ts";
import { claudeConversations } from "./claude-conversation.ts";
import { noConversation, threadAgents, type ThreadAgents, type ThreadHarness } from "./thread-agent.ts";
import type { Whoami } from "./wire.ts";
import type { UsageBackfillJob } from "./usage-backfill.ts";
import { attachRoute, parseAttachQuery } from "../attach-wire.ts";
import { openTerminal } from "../guest-terminal.ts";
import { attachTiming, serveAttach, type AttachTiming, type Ending, type PylonDoor } from "./attach.ts";
import { HttpError, type ApiErrorCode } from "./http-error.ts";
import { ok, parse, type ApiKit, type Policy, type Route, type RouteEntry } from "./api/kit.ts";
import { apiAccess } from "./api/access.ts";
import { pylonAccess } from "./api/pylon-access.ts";
import { eventStreams, maxStreams } from "./api/sse.ts";
import { threadViews } from "./api/thread-view.ts";
import { releaseRoutes } from "./api/release-routes.ts";
import { streamRoutes } from "./api/stream-routes.ts";
import { projectRoutes } from "./api/project-routes.ts";
import { usageRoutes } from "./api/usage-routes.ts";
import { nodeRoutes } from "./api/node-routes.ts";
import { threadRoutes } from "./api/thread-routes.ts";
import { pipelineRoutes } from "./api/pipeline-routes.ts";
import { reviewRoutes } from "./api/review-routes.ts";
import { questionRoutes } from "./api/question-routes.ts";
import { pylonRoutes } from "./api/pylon-routes.ts";
import { imageRoutes } from "./api/image-routes.ts";
import { BodyTooLarge, readBody } from "../request-body.ts";
import type { ImageRollout } from "./image-rollout.ts";
import type { StartRequest } from "./threads.ts";
import type { Pipeline } from "./pipeline.ts";
import type { Planning } from "./planning.ts";
import type { ThreadQueue } from "./queue.ts";
import type { ReviewLoop } from "./review.ts";

export interface ApiOptions {
  https?: { port: number; certificate(): Promise<Certificate>; renewalMs?: number; retryMs?: number };
  prWatchEnabled?: boolean;
  /** Null without a control-plane GitHub token, which the review loop reads and merges with. */
  reviews?: ReviewLoop | null;
  /** Null without a control-plane GitHub token, which tells it when a predecessor's pull request merged. */
  queue?: ThreadQueue | null;
  /** Null without the queue, which starts its items' threads. */
  pipeline?: Pipeline | null;
  /** Marks planning threads, writes what their messages start with, and adds the items the person accepts from them. */
  planning?: Planning | null;
  deployment?: DeploymentOptions;
  /** The drain gate every turn start passes. Omitted: the API builds one over the registry's drain. */
  gate?: TurnGate;
  registry: Registry;
  host: string;
  /** 0 picks a free port. */
  port: number;
  whois: Whois;
  allowed: ReadonlySet<TailnetNodeId>;
  /** `POST /v1/join`, the one route a machine that is no node or caller yet may call. Omitted: no machine can join. */
  joins?: { whois: WhoisNode; configured: ReadonlySet<TailnetNodeId>; joined(node: JoinedNode): void };
  /** Names the API answers to in the Host header. Any other name is a DNS rebinding page on an allowed machine. */
  hostnames: ReadonlySet<string>;
  harness: ThreadHarness;
  startThread(request: StartRequest, caller: string, queuedId?: ThreadId, key?: StartKey): Promise<Thread>;
  /** Asks the loop for a pass over the node's pylons. */
  wake(node: NodeName): void;
  /** One client per registry node, for the guest commands, checkout reads and node health a human asks for. */
  probes: ReadonlyMap<NodeName, Pick<ProbeClient, "command" | "stream" | "health">>;
  /** The https ports each node's previews are allocated from, the loop's range. */
  previewPorts: PortRange;
  /** Image builds and rollouts. Without it, their routes answer 409. */
  images?: ImageRollout;
  /** The usage backfill. Without it, its routes answer 409. */
  usageBackfill?: UsageBackfillJob;
  /** How long a stream's client may leave what was sent unread before it is dropped. 30 s by default. */
  streamStallMs?: number;
  /** How attached terminals ping and wait. Tests shorten it. */
  attachTiming?: AttachTiming;
  /** How long close() waits for terminals to hang up and upgrades to pass whois. 5 s by default. */
  closeWaitMs?: number;
}

export interface Api {
  readonly port: number;
  readonly httpsPort: number | undefined;
  close(): Promise<void>;
}

/** Every route but the health route, which reports the server's own state. Each feature's module holds its routes. */
export function featureRoutes(kit: ApiKit, options: ApiOptions, nodeHealth: (caller: TailnetNodeId, name: NodeName) => Promise<NodeHealth>): readonly RouteEntry[] {
  return [
    ...releaseRoutes(kit, options),
    ...streamRoutes(kit),
    ...projectRoutes(kit, options),
    ...usageRoutes(kit, options),
    ...nodeRoutes(kit, nodeHealth),
    ...threadRoutes(kit, options),
    ...pipelineRoutes(kit, options),
    ...reviewRoutes(kit, options),
    ...questionRoutes(kit, options),
    ...pylonRoutes(kit, options),
    ...imageRoutes(kit, options),
  ];
}

export async function startApi(options: ApiOptions): Promise<Api> {
  const { registry, whois, allowed, hostnames, harness, startThread, wake, probes, streamStallMs = 30_000, attachTiming: timing = attachTiming, closeWaitMs = 5_000 } = options;
  const access = apiAccess(registry, wake, options);
  const { thread, threadRefusal, guard, current, personOnly, refusalOf } = access;
  const pylon = pylonAccess({ registry, probes, wake, guard, current });
  const { inPylon, whileRunning } = pylon;
  const wakeThread = access.wakeThread;
  const claude = claudeConversations({ registry, probes });
  const agents: ThreadAgents = threadAgents({ registry, harness, claude, inPylon, whileRunning, wake: wakeThread, planning: options.planning ?? null });
  const live = liveStreams();

  const views = threadViews(registry, agents, options);
  const { pylonState, row, detail, conversation } = views;

  /** The agent of a thread that has one. */
  function agentOf(t: Thread): ThreadAgents["harness" | "claude"] {
    const { kind } = registry.agent(t);
    if (kind === "none") throw new HttpError(409, noConversation(t));
    return agents[kind];
  }

  const page = dashboard({
    registry, detail, row, conversation,
    landRefusal: (caller) => !options.reviews ? "no review loop" : canDeploy(registry, options.deployment, caller) ? null : "not a deployer",
    answerRefusal: refusalOf,
    deploys: (r) => options.reviews?.deploys(r) ?? false,
    nodeHealth,
  });

  /** A node's health says what runs on it, so only a deployer reads it. Nothing reached from here acts on the node. */
  async function nodeHealth(caller: TailnetNodeId, name: NodeName): Promise<NodeHealth> {
    if (!canDeploy(registry, options.deployment, caller)) throw new HttpError(403, "caller may not read a node's health: only deployers may, never infrastructure nodes or pylons");
    const probe = registry.node(name) === undefined ? undefined : probes.get(name);
    if (probe === undefined) throw new HttpError(404, `no node ${name}`);
    return probe.health();
  }

  const sse = eventStreams(streamStallMs);
  const { open } = sse;

  const draining = () => isDraining(registry.drain());
  const gate = options.gate ?? turnGate(draining);
  const kit: ApiKit = { ...access, ...pylon, ...views, ...sse, registry, harness, startThread, claude, agents, live, agentOf, draining, gate };

  const routes: readonly RouteEntry[] = [["GET", /^\/v1\/health$/, () => ok(health())], ...featureRoutes(kit, options, nodeHealth)];

  const httpsState: { status: "disabled" | "waiting" | "ready" | "degraded"; error: string | null; nextAttemptAt: number | null } = {
    status: options.https ? "waiting" : "disabled", error: null, nextAttemptAt: null,
  };
  const health = () => ({ commit: runningCommit, version, https: { ...httpsState } });

  const callerOf = <T>(req: IncomingMessage, who: (address: string, port: number) => Promise<T | null>) => {
    const { remoteAddress, remotePort } = req.socket;
    return remoteAddress === undefined || remotePort === undefined ? Promise.resolve(null) : who(remoteAddress, remotePort);
  };
  /**
   * whois names the machine, not the program, so a web page open on an allowed laptop is that laptop too. It can
   * neither send a JSON content type cross-origin without a preflight, which this API never answers, nor reach the
   * API under its own name.
   */
  function checkHost(req: IncomingMessage) {
    const host = req.headers.host;
    let hostname: string | undefined;
    try {
      hostname = typeof host === "string" ? new URL(`http://${host}`).hostname : undefined;
    } catch {
      hostname = undefined;
    }
    if (hostname === undefined || !hostnames.has(hostname)) throw new HttpError(403, `the API does not answer to host ${req.headers.host}`);
  }

  /** The caller, once it is allowed and asked under one of the API's names. Every request and upgrade passes here. */
  async function admit(req: IncomingMessage): Promise<TailnetNodeId> {
    const caller = await callerOf(req, whois);
    const workerRoute = pathOf(req.url)?.startsWith("/v1/deployer/") ?? false;
    if (caller === null || (workerRoute
      ? !isReporter(registry, options.deployment, caller, req.headers.authorization)
      : !allowed.has(caller))) throw new HttpError(403, "caller is not a tailnet node this control plane allows");
    checkHost(req);
    return caller;
  }

  /**
   * Any tailnet node may ask who it is, so a device not yet allowed learns the node ID to allow. It learns only its
   * own ID and its own access, which `tailscale status` and a refused request already tell it.
   */
  async function whoami(req: IncomingMessage): Promise<Whoami> {
    const node = await callerOf(req, whois);
    if (node === null) throw new HttpError(403, "caller is not a tailnet node");
    checkHost(req);
    const person = allowed.has(node) && isPerson(registry, options.deployment, node);
    return { node, allowed: allowed.has(node), person, deployer: person && canDeploy(registry, options.deployment, node) };
  }

  /** A token only root on the control plane's machine mints is what lets a machine that is not yet admitted call this. */
  async function join(req: IncomingMessage, joins: NonNullable<ApiOptions["joins"]>) {
    const caller = await callerOf(req, joins.whois);
    if (caller === null) throw new HttpError(403, "caller is not a tailnet node");
    checkHost(req);
    requireJson(req);
    const node = joinNode(registry, allowed, joins.configured, caller, parse(joinRequestSchema, await readJson(req)));
    joins.joined(node);
    return { node: node.name, tailnetNodeId: node.tailnetNodeId };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/v1/health" && req.socket.remoteAddress !== undefined && req.socket.remoteAddress === req.socket.localAddress) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(health()));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/whoami") return void send(res, 200, await whoami(req));
    if (req.method === "POST" && req.url === "/v1/join" && options.joins !== undefined) return void send(res, 200, await join(req, options.joins));
    const caller = await admit(req);
    if (req.method !== "GET") requireJson(req);

    const path = pathOf(req.url);
    if (path === null) throw new HttpError(400, `the request path ${JSON.stringify(req.url)} is not a valid URL path`);
    const url = new URL(req.url ?? "/", "http://nexus");
    const view = req.method === "GET" ? await page(path, url.searchParams, caller) : undefined;
    if (view !== undefined) return void res.writeHead(view.status, view.headers).end(view.body);
    const matches = routes.flatMap((entry): { method: string; m: RegExpExecArray; policy?: Policy; route: Route }[] => {
      const m = entry[1].exec(path);
      if (m === null) return [];
      return entry[0] === "GET" ? [{ method: entry[0], m, route: entry[2] }] : [{ method: entry[0], m, policy: entry[2], route: entry[3] }];
    });
    if (matches.length === 0) throw new HttpError(404, path.startsWith("/v1/deployer/") ? `no deployer route ${path}` : `no route ${path}`, "no-route");
    const match = matches.find((r) => r.method === req.method);
    if (match === undefined) throw new HttpError(405, `${req.method} is not allowed on ${path}`);
    if (match.policy !== undefined && "person" in match.policy) personOnly(caller, match.policy.person);
    const route = () => match.route(match.m, { query: url.searchParams, caller, body: (empty) => readJson(req, empty) });
    const reply = match.policy?.startsTurn ? await gate.run(async () => route()) : await route();
    if (reply.stream !== undefined) return reply.stream(res);
    if (reply.file !== undefined) sendFile(res, reply.file, reply.type, reply.cache);
    else if (reply.body === undefined) res.writeHead(reply.status).end();
    else send(res, reply.status, reply.body);
  }

  /** The pane a terminal attached to the thread lands in: its Claude worker's, while the node reports it. */
  function agentPane(t: Thread): string | null {
    const session = registry.claudeWorker(t.id)?.session ?? null;
    if (session === null) return null;
    return registry.sessions(t.pylonId).find((s) => s.state === "running" && s.harness === "claude-code" && s.harnessSessionId === session)?.herdrPane ?? null;
  }

  /** The pylon of a thread, as serveAttach asks for it. */
  function door(t: Thread, { pylonId, node }: StoredPylon, probe: Pick<ProbeClient, "stream">): PylonDoor {
    return {
      thread: t.id,
      look() {
        const now = current(t);
        const refused = threadRefusal(now, { status: "active" });
        if (refused !== null) return { kind: "over", error: { kind: "conflict", message: refused } };
        const { pylon, actualState } = pylonState(now);
        if (actualState === "failed") return { kind: "over", error: { kind: "failed", message: `the pylon of ${t.id} failed: ${pylon.failed ?? "no reason given"}` } };
        return { kind: "pylon", state: actualState };
      },
      open({ size, term, pane }) {
        registry.recordActivity(t.id, { human: Date.now() });
        wake(node);
        return openTerminal((argv) => probe.stream(pylonId, argv), size, term, ["sh", "-c", attachScript, "attach", pane ?? agentPane(t) ?? ""]);
      },
    };
  }

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });
  /** Attached terminals, which close() ends, because closeAllConnections does not reach upgraded sockets. */
  const attached = new Set<{ end(why: Ending): void; served: Promise<void> }>();
  /** Set by close(), so an upgrade still waiting on whois opens no terminal close() would miss. */
  let stopping = false;
  /**
   * Every upgraded socket until it closes, from the upgrade on: closeAllConnections does not reach them, and one still
   * at whois has no WebSocket yet, so close() drops what is left of them itself.
   */
  const upgraded = new Set<Duplex>();

  /**
   * GET /v1/threads/<thread>/attach as a WebSocket. Every refusal is an HTTP reply before the 101, so a client maps it
   * as it maps any route's. A terminal takes a place among the streams, so a delete ends it too.
   */
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    personOnly(await admit(req), "attach to a thread's pylon");
    if (stopping) throw new HttpError(503, "the control plane is stopping");
    // CORS does not guard a WebSocket handshake, and previews are served under the API's hostname on other ports, so
    // a preview's page could open a terminal from the browser of anyone allowed. A browser always sends Origin.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `${req.socket instanceof TLSSocket ? "https" : "http"}://${req.headers.host}`) throw new HttpError(403, `the attach route does not answer pages from ${origin}`);
    const t = thread(attachRoute.exec(pathOf(req.url)!)![1]!);
    let request: ReturnType<typeof parseAttachQuery>;
    try {
      request = parseAttachQuery(new URL(req.url ?? "/", "http://nexus").searchParams);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    guard(t, { status: "active" });
    const pylon = registry.pylon(t.pylonId)!;
    const probe = probes.get(pylon.node);
    if (probe === undefined) throw new HttpError(503, `no probe is configured for ${pylon.node}`);
    if (open.size >= maxStreams) throw new HttpError(503, `${maxStreams} streams are open, the most this control plane serves at once`);
    if (socket.destroyed) return;
    const stop = new AbortController();
    const handle = { thread: t.id, end: () => stop.abort("deleted" satisfies Ending) };
    open.add(handle);
    try {
      // ws answers a malformed handshake with a 400 itself and never calls back, so the socket's close ends the wait.
      const ws = await new Promise<WebSocket | null>((resolve) => {
        socket.once("close", () => resolve(null));
        sockets.handleUpgrade(req, socket, head, resolve);
      });
      if (ws === null) return;
      if (stopping) stop.abort("stopping" satisfies Ending);
      const session = { end: (why: Ending) => stop.abort(why), served: serveAttach(ws, door(t, pylon, probe), request, stop.signal, timing) };
      attached.add(session);
      await session.served.finally(() => attached.delete(session));
    } finally {
      open.delete(handle);
    }
  }

  function makeServer(certificate?: Certificate) {
    const serverOptions = {
      // Only a WebSocket to the attach route upgrades. Any other request is handled as one, Upgrade header or not.
      shouldUpgradeCallback: (req: IncomingMessage) => req.headers.upgrade?.toLowerCase() === "websocket" && attachRoute.test(pathOf(req.url) ?? ""),
    };
    const server = certificate ? createHttpsServer({ ...serverOptions, ...certificate }) : createServer(serverOptions);
    server.on("request", (req, res) => {
      handle(req, res).catch((err: unknown) => {
        if (res.headersSent) return res.destroy(err as Error);
        const reply = errorReply(err);
        send(res, reply.status, reply.body);
      });
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Node hands over an upgraded socket without its error handler, and a reset before the 101 would crash the API.
      socket.on("error", () => undefined);
      upgraded.add(socket);
      socket.once("close", () => upgraded.delete(socket));
      upgrade(req, socket, head).catch((err: unknown) => refuseUpgrade(socket, errorReply(err)));
    });
    return server;
  }
  const server = makeServer();
  let secure: ReturnType<typeof makeServer> | null = null;
  server.listen(options.port, options.host);
  await once(server, "listening");
  let renewal: ReturnType<typeof setTimeout> | null = null;
  let retryMs = options.https?.retryMs ?? 1000;
  function scheduleCertificate(delay: number) {
    httpsState.nextAttemptAt = Date.now() + delay;
    renewal = setTimeout(() => { void refreshCertificate(); }, delay);
    renewal.unref();
  }
  async function refreshCertificate() {
    if (stopping || !options.https) return;
    httpsState.nextAttemptAt = null;
    try {
      const certificate = await options.https.certificate();
      if (stopping) return;
      if (secure) {
        (secure as import("node:https").Server).setSecureContext(certificate);
      } else {
        const listener = makeServer(certificate);
        secure = listener;
        try {
          listener.listen(options.https.port, options.host);
          await once(listener, "listening");
        } catch (err) {
          listener.close();
          secure = null;
          throw err;
        }
      }
      if (stopping) { secure?.close(); return; }
      httpsState.status = "ready";
      httpsState.error = null;
      retryMs = options.https.retryMs ?? 1000;
      scheduleCertificate(options.https.renewalMs ?? 12 * 60 * 60 * 1000);
    } catch (err) {
      if (stopping) return;
      httpsState.status = secure ? "degraded" : "waiting";
      httpsState.error = (err as Error).message;
      console.error(`dashboard HTTPS ${secure ? "renewal" : "startup"} failed: ${httpsState.error}; HTTP remains available; retrying in ${retryMs}ms`);
      scheduleCertificate(retryMs);
      retryMs = Math.min(retryMs * 2, 60_000);
    }
  }
  if (options.https) void refreshCertificate();
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`unexpected server address ${address}`);

  return {
    port: address.port,
    get httpsPort() { return secure?.listening ? (secure.address() as import("node:net").AddressInfo).port : undefined; },
    async close() {
      stopping = true;
      claude.close();
      if (renewal) clearTimeout(renewal);
      const closed = Promise.all([server, ...(secure ? [secure] : [])].map((listener) => {
        const done = new Promise<void>((resolve) => listener.close(() => resolve()));
        listener.closeAllConnections();
        return done;
      }));
      for (const session of attached) session.end("stopping");
      // Each hang-up waits for its node's probe, and an upgrade still at admission for whois. A node that stopped
      // answering, or a whois that never returns, would hold the close forever.
      const ends = [...[...attached].map((session) => session.served), ...[...upgraded].map((socket) => new Promise((resolve) => socket.once("close", resolve)))];
      await Promise.race([Promise.all(ends), sleep(closeWaitMs, undefined, { ref: false })]);
      for (const socket of upgraded) socket.destroy();
      await closed;
    },
  };
}

function requireJson(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new HttpError(415, "requests that change state must have content-type application/json");
}

async function readJson(req: IncomingMessage, empty?: unknown): Promise<unknown> {
  const body = await readBody(req);
  if (body === "" && empty !== undefined) return empty;
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new HttpError(400, `body is not JSON: ${(err as Error).message}`);
  }
}

/** The sandbox keeps a file that a browser opens anyway from running as a page of the API's origin. */
function sendFile(res: ServerResponse, content: Buffer, type: string, cache = "no-store") {
  res.writeHead(200, {
    "content-type": type, "content-length": content.length, "cache-control": cache,
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
  }).end(content);
}

/** The path a request's URL names, decoded as `handle` matches it, or null for one that cannot be decoded. */
function pathOf(url: string | undefined): string | null {
  try {
    return decodeURIComponent(new URL(url ?? "/", "http://nexus").pathname);
  } catch {
    return null;
  }
}

/** A node's probe refusing the control plane is a bad gateway, not a refusal of the caller. */
const probeStatus: Record<ProbeError["code"], number> = { unreachable: 503, "not-running": 409, forbidden: 502 };
type ErrorReply = { status: number; body: { error: string; code?: ApiErrorCode } };

function errorReply(err: unknown): ErrorReply {
  const error = (err as Error).message;
  if (err instanceof HttpError) return { status: err.status, body: err.code === undefined ? { error } : { error, code: err.code } };
  if (err instanceof DeployDraining) return { status: 409, body: { error } };
  if (err instanceof BodyTooLarge) return { status: 413, body: { error } };
  const code = (err as Partial<ProbeError>).code;
  if (code !== undefined && Object.hasOwn(probeStatus, code)) return { status: probeStatus[code], body: code === "not-running" ? { error, code } : { error } };
  return { status: 500, body: { error } };
}

/** An API error reply written on a socket that never upgraded. */
function refuseUpgrade(socket: Duplex, { status, body: error }: ErrorReply) {
  if (socket.destroyed) return;
  const body = JSON.stringify(error);
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}
