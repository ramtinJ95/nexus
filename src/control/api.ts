/**
 * The control plane's HTTP API for the dashboard and the CLI. JSON in and out.
 *
 * Each thread's agent is a conversation in the control plane's harness. The API creates it with the thread,
 * forwards messages, aborts and retries to it, and serves its view.
 *
 * Like the probe, it trusts tailnet identity: each caller's stable node ID, from tailscaled's whois, must be
 * on the allowlist. The API writes only what a human asks for. Every change that can move a pylon
 * wakes the loop for its node, so a start or a dashboard visit acts within one pass rather than 5 seconds.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { actualState, desiredPhase, retryRefusal, type ActualState, type DesiredPhase } from "../reconcile.ts";
import { effectiveAllowedHosts, gitUrl, liveHashOf, withHttpsHosts, type BootInputs, type Project, type ProjectId, type PylonOverlay } from "../project.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../protocol.ts";
import type { HarnessHost } from "../harness/host.ts";
import type { ImageId, ImageManifest } from "../images.ts";
import type { Whois } from "../tailscale.ts";
import { newPylonRecord } from "../tick.ts";
import type { NodeRecord, Output, Preview, Registry, Session, Thread, ThreadId } from "./registry.ts";
import { dashboard } from "./dashboard.ts";
import { pylonLive } from "./live.ts";

export interface ApiOptions {
  registry: Registry;
  host: string;
  /** 0 picks a free port. */
  port: number;
  whois: Whois;
  allowed: ReadonlySet<TailnetNodeId>;
  /** Names the API answers to in the Host header. Any other name is a DNS rebinding page on an allowed machine. */
  hostnames: ReadonlySet<string>;
  /** The common dotfiles layer every new pylon pulls on boot. */
  dotfiles: PylonOverlay["dotfiles"];
  harness: ThreadHarness;
  /** Asks the loop for a pass over the node's pylons. */
  wake(node: NodeName): void;
}

export type ThreadHarness = Pick<HarnessHost, "startThread" | "send" | "abort" | "retry" | "watch" | "deleteThread" | "activity">;

export interface Api {
  readonly port: number;
  close(): Promise<void>;
}

export interface ThreadDetail {
  thread: Thread;
  /** What the planner wants of the pylon now, from the thread's status and activity. */
  desired: DesiredPhase;
  pylon: {
    id: PylonId; node: NodeName; actualState: ActualState; failed: string | null; observedAt: string | null;
    /** Why a retry of the pylon, as its node last reported it, cannot help. Null when a retry can. */
    retryRefused: string | null;
  };
  sessions: readonly Session[];
  previews: readonly Preview[];
  outputs: readonly Output[];
  /** Null for a thread that has no conversation. A parked task holds the run until it is retried. */
  agent: { parkedTasks: number } | null;
}

/** A thread as the list reports it, with what the planner wants of its pylon and what its node last reported. */
export type ThreadRow = Thread & { desired: DesiredPhase; pylon: Pick<ThreadDetail["pylon"], "node" | "actualState" | "failed"> };

/** A node without its probe's latest observation, which thread detail already reports per pylon. */
export type NodeSummary = Omit<NodeRecord, "observation"> & { observedAt: string | null };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const host = z.string().min(1);
const projectSchema = z.strictObject({
  id: name.transform((id) => id as ProjectId),
  repoUrl: gitUrl,
  defaultBranch: z.string().min(1),
  defaultNode: z.string().min(1).transform((node) => node as NodeName),
  resources: z.strictObject({ cpus: z.int().positive(), memoryGiB: z.int().positive(), diskGiB: z.int().positive() }),
  allowedHosts: z.array(host),
  secrets: z.array(z.strictObject({ name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), hosts: z.array(host) })),
  logins: z.array(z.enum(["claude", "chatgpt"])),
  preSetup: z.string().nullable(),
});
const startSchema = z.strictObject({
  project: z.string().min(1),
  title: z.string().min(1),
  node: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  /** Until the control plane mirrors repos, the caller may pin a commit. The default is the branch tip at clone time. */
  commit: z.string().min(1).optional(),
});
// Agent activity comes from the harness.
const activitySchema = z.strictObject({ kind: z.literal("human") });
const messageSchema = z.strictObject({
  text: z.string().min(1),
  /** Minted by the client per message, such as msg:<uuid>. A retry with the same ID is the same message. */
  requestId: z.string().min(1),
  /** followUp waits for the current run. steer joins it after its current tool round. */
  mode: z.enum(["followUp", "steer"]).default("followUp"),
});
const imageSchema = z.strictObject({
  id: z.string().regex(/^img-[0-9a-f]{12}$/).transform((id) => id as ImageId),
  gondolinBuildId: z.string().min(1),
  pins: z.strictObject({
    debianDigest: z.string(), node: z.string(), nodeSha256: z.string(), claudeCode: z.string(), pi: z.string(), herdr: z.string(),
    piEnv: z.string(), piEnvSha256: z.string(), gondolin: z.string(), alpineKernel: z.string(), dotfilesCommon: z.string(),
  }),
  builtOn: z.string().min(1).transform((node) => node as NodeName),
  builtAt: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const currentImageSchema = z.strictObject({ image: z.string().min(1) });

/** `pylon-<id>` must fit in 40 characters. */
const newThreadId = () => `th-${randomBytes(6).toString("hex")}` as ThreadId;

export async function startApi(options: ApiOptions): Promise<Api> {
  const { registry, whois, allowed, hostnames, dotfiles, harness, wake } = options;

  function thread(id: string): Thread {
    const found = registry.thread(id as ThreadId);
    if (found === undefined) throw new HttpError(404, `no thread ${id}`);
    return found;
  }

  function wakeThread(t: Thread) {
    wake(registry.pylon(t.pylonId)!.node);
  }

  function createProject(body: unknown): Project {
    const project: Project = parse(projectSchema, body);
    if (registry.node(project.defaultNode) === undefined) throw new HttpError(400, `no node ${project.defaultNode}`);
    if (registry.project(project.id) !== undefined) throw new HttpError(409, `project ${project.id} exists`);
    registry.createProject(project);
    return project;
  }

  /** Threads from before the harness ran on the control plane have no conversation, and a deleted thread's is gone. */
  function conversing(t: Thread): Thread {
    if (t.status === "deleted") throw new HttpError(409, `thread ${t.id} is deleted`);
    if (t.conversationId === null) throw new HttpError(409, `thread ${t.id} has no conversation`);
    return t;
  }

  /** An archived thread's pylon stays paused, so its agent could not run a tool. */
  function runnable(t: Thread): Thread {
    if (t.status === "archived") throw new HttpError(409, `thread ${t.id} is archived`);
    return conversing(t);
  }

  /**
   * Templates come later, so every pylon boots fresh from the current image and runs setup inline. The
   * conversation is created before the registry row, as HarnessHost.startThread requires.
   */
  async function startThread(body: unknown, caller: TailnetNodeId): Promise<Thread> {
    const request = parse(startSchema, body);
    const project = registry.project(request.project as ProjectId);
    if (project === undefined) throw new HttpError(404, `no project ${request.project}`);
    const node = (request.node ?? project.defaultNode) as NodeName;
    if (registry.node(node) === undefined) throw new HttpError(400, `no node ${node}`);
    const image = registry.currentImage();
    if (image === null) throw new HttpError(409, "no image is current yet, so a pylon has nothing to boot");

    const now = Date.now();
    const id = newThreadId();
    const pylonId = `pylon-${id}` as PylonId;
    const branch = request.branch ?? project.defaultBranch;
    const conversationId = await harness.startThread({ threadId: id, pylonId });
    const t: Thread = {
      id, title: request.title, project: project.id, pylonId, status: "active", conversationId: String(conversationId), startedBy: caller, createdAt: now,
      // Starting a thread is human activity, so its pylon is wanted at once.
      agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: now,
    };
    const boot: Omit<BootInputs, "source"> = {
      pylonId, image, resources: project.resources,
      // Every boot pulls the dotfiles through the allowlist. A template build pulls none, so their host stays out of the setup hash.
      network: { allowedHosts: withHttpsHosts(effectiveAllowedHosts(project), [dotfiles.repo]), secrets: project.secrets },
      repo: { url: project.repoUrl, checkout: { branch, commit: request.commit ?? `origin/${branch}` } },
      dotfiles,
    };
    // Ports are allocated once the pylon reports the services that want a preview.
    const live = pylonLive({ pylonId, thread: id, node, boot }, project, registry.node(node)!, []);
    const { desired: _, ...pylon } = newPylonRecord({
      thread: id, pylonId, node, desired: "running",
      boot,
      firstBoot: { kind: "fresh", preSetup: project.preSetup },
      live,
      liveHash: liveHashOf(live),
    });
    registry.createThread(t, pylon);
    wake(node);
    return t;
  }

  /** The pylon as its node's last observation reports it. */
  function observedPylon(pylonId: PylonId) {
    const node = registry.node(registry.pylon(pylonId)!.node)!;
    return node.observation?.pylons.find((p) => p.pylonId === pylonId) ?? "absent";
  }

  function pylonOf(t: Thread): ThreadDetail["pylon"] {
    const pylon = registry.pylon(t.pylonId)!;
    const node = registry.node(pylon.node)!;
    const observed = observedPylon(pylon.pylonId);
    const inFlight = registry.job(pylon.pylonId) ?? null;
    // The planner deletes a failed pylon all the same, so a deleted thread's pylon shows the delete.
    const gaveUp = pylon.failed !== null && t.status !== "deleted";
    return {
      id: pylon.pylonId, node: pylon.node, failed: pylon.failed, observedAt: node.observation?.observedAt ?? null,
      actualState: actualState(observed, inFlight, node.state === "online", gaveUp), retryRefused: retryRefusal(observed),
    };
  }

  function row(t: Thread): ThreadRow {
    const { node, actualState, failed } = pylonOf(t);
    return { ...t, desired: desiredPhase(t, Date.now()), pylon: { node, actualState, failed } };
  }

  function detail(t: Thread): ThreadDetail {
    const pylon = registry.pylon(t.pylonId)!;
    return {
      thread: t,
      desired: desiredPhase(t, Date.now()),
      pylon: pylonOf(t),
      sessions: registry.sessions(pylon.pylonId),
      previews: registry.previews(pylon.pylonId),
      outputs: registry.outputs(t.id),
      agent: t.conversationId === null || t.status === "deleted" ? null : { parkedTasks: harness.activity.parked(t.id).length },
    };
  }

  const page = dashboard({ registry, detail, conversation });

  async function setStatus(t: Thread, status: "archived" | "deleted"): Promise<Thread> {
    if (t.status === "deleted") throw new HttpError(409, `thread ${t.id} is deleted`);
    registry.setThreadStatus(t.id, status);
    wakeThread(t);
    // After the status, so the run's wait for a pylon ends: the locator refuses a deleted thread's pylon.
    if (status === "deleted" && t.conversationId !== null) await harness.deleteThread({ threadId: t.id, pylonId: t.pylonId });
    return { ...t, status };
  }

  /** Activity never unarchives a thread, because opening its page is activity too. */
  function unarchive(t: Thread): Thread {
    if (t.status !== "archived") throw new HttpError(409, `thread ${t.id} is ${t.status}, not archived`);
    registry.setThreadStatus(t.id, "active");
    registry.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
    return registry.thread(t.id)!;
  }

  /**
   * Clears the planner's verdict and the attempt count, so the next pass plans the pylon afresh. A human retries
   * on purpose, so a failure the planner may not retry is cleared too, such as setup that failed on git access
   * the user has since fixed. A fresh pylon whose setup failed has no instance left, so it boots fresh and runs
   * setup again. A broken one is paused onto its newest disk and resumed (planner rule 7a), unless that disk
   * records a failed setup, which every resume repeats. The retry is human activity, so the pylon is wanted at once.
   * An archived thread's pylon stays paused, so its retry only settles the pylon. A deleted thread's pylon is
   * deleted all the same.
   */
  function retryPylon(t: Thread) {
    if (t.status === "deleted") throw new HttpError(409, `thread ${t.id} is deleted`);
    const refused = retryRefusal(observedPylon(t.pylonId));
    if (refused !== null) throw new HttpError(409, `pylon ${t.pylonId} cannot be retried. ${refused}`);
    if (!registry.retryPylon(t.pylonId)) throw new HttpError(409, `pylon ${t.pylonId} has not failed`);
    registry.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
  }

  function recordActivity(t: Thread, body: unknown) {
    parse(activitySchema, body);
    registry.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
  }

  /** A message is human activity, so the pylon wakes while the model answers. */
  async function sendMessage(t: Thread, body: unknown) {
    const message = parse(messageSchema, body);
    registry.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
    const submission = await harness.send(t.id, message.text, message.requestId, message.mode);
    return { submission: submission.id };
  }

  async function conversation(t: Thread) {
    const watch = await harness.watch(t.id);
    try {
      return watch.value;
    } finally {
      await watch.stop();
    }
  }

  function recordImage(body: unknown): ImageManifest {
    const manifest: ImageManifest = parse(imageSchema, body);
    registry.saveImage(manifest);
    return manifest;
  }

  function setCurrentImage(body: unknown) {
    const { image } = parse(currentImageSchema, body);
    if (registry.image(image as ImageId) === undefined) throw new HttpError(404, `no image ${image}`);
    registry.setCurrentImage(image as ImageId);
  }

  type Reply = { status: number; body?: unknown };
  type Route = (match: RegExpExecArray, req: { query: URLSearchParams; body(): Promise<unknown>; caller: TailnetNodeId }) => Reply | Promise<Reply>;
  const ok = (body: unknown): Reply => ({ status: 200, body });
  const created = (body: unknown): Reply => ({ status: 201, body });
  const noContent: Reply = { status: 204 };

  const routes: readonly [string, RegExp, Route][] = [
    ["GET", /^\/v1\/projects$/, () => ok(registry.projects())],
    ["POST", /^\/v1\/projects$/, async (_, r) => created(createProject(await r.body()))],
    ["GET", /^\/v1\/nodes$/, () => ok(registry.nodes().map(({ observation, ...n }): NodeSummary => ({ ...n, observedAt: observation?.observedAt ?? null })))],
    ["GET", /^\/v1\/threads$/, (_, r) => ok(registry.threads((r.query.get("project") ?? undefined) as ProjectId | undefined).map(row))],
    ["POST", /^\/v1\/threads$/, async (_, r) => created(await startThread(await r.body(), r.caller))],
    ["GET", /^\/v1\/threads\/([^/]+)$/, (m) => ok(detail(thread(m[1]!)))],
    ["DELETE", /^\/v1\/threads\/([^/]+)$/, async (m) => ok(await setStatus(thread(m[1]!), "deleted"))],
    ["POST", /^\/v1\/threads\/([^/]+)\/archive$/, async (m) => ok(await setStatus(thread(m[1]!), "archived"))],
    ["POST", /^\/v1\/threads\/([^/]+)\/unarchive$/, (m) => ok(unarchive(thread(m[1]!)))],
    ["POST", /^\/v1\/threads\/([^/]+)\/activity$/, async (m, r) => { recordActivity(thread(m[1]!), await r.body()); return noContent; }],
    // The body first, so the thread's status is read after the last await before the message is submitted.
    ["POST", /^\/v1\/threads\/([^/]+)\/messages$/, async (m, r) => {
      const body = await r.body();
      return { status: 202, body: await sendMessage(runnable(thread(m[1]!)), body) };
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/abort$/, async (m) => { await harness.abort(conversing(thread(m[1]!)).id); return noContent; }],
    ["POST", /^\/v1\/threads\/([^/]+)\/retry$/, async (m) => { await harness.retry(runnable(thread(m[1]!)).id); return noContent; }],
    ["POST", /^\/v1\/threads\/([^/]+)\/pylon\/retry$/, (m) => { retryPylon(thread(m[1]!)); return noContent; }],
    ["GET", /^\/v1\/threads\/([^/]+)\/conversation$/, async (m) => ok(await conversation(conversing(thread(m[1]!))))],
    ["POST", /^\/v1\/images$/, async (_, r) => created(recordImage(await r.body()))],
    ["PUT", /^\/v1\/images\/current$/, async (_, r) => { setCurrentImage(await r.body()); return noContent; }],
  ];

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const { remoteAddress, remotePort } = req.socket;
    const caller = remoteAddress === undefined || remotePort === undefined ? null : await whois(remoteAddress, remotePort);
    if (caller === null || !allowed.has(caller)) throw new HttpError(403, "caller is not a tailnet node this control plane allows");
    // whois names the machine, not the program, so a web page open on an allowed laptop is that laptop too.
    // It can neither send a JSON content type cross-origin without a preflight, which this API never answers,
    // nor reach the API under its own name.
    const hostname = req.headers.host === undefined ? undefined : new URL(`http://${req.headers.host}`).hostname;
    if (hostname === undefined || !hostnames.has(hostname)) throw new HttpError(403, `the API does not answer to host ${req.headers.host}`);
    if (req.method !== "GET" && req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      throw new HttpError(415, "requests that change state must have content-type application/json");
    }

    const url = new URL(req.url ?? "/", "http://nexus");
    const path = decodeURIComponent(url.pathname);
    const view = req.method === "GET" ? await page(path, url.searchParams) : undefined;
    if (view !== undefined) return void res.writeHead(view.status, view.headers).end(view.body);
    const matches = routes.flatMap(([method, pattern, route]) => {
      const m = pattern.exec(path);
      return m === null ? [] : [{ method, m, route }];
    });
    if (matches.length === 0) throw new HttpError(404, `no route ${path}`);
    const match = matches.find((r) => r.method === req.method);
    if (match === undefined) throw new HttpError(405, `${req.method} is not allowed on ${path}`);
    const reply = await match.route(match.m, { query: url.searchParams, caller, body: () => readJson(req) });
    if (reply.body === undefined) res.writeHead(reply.status).end();
    else send(res, reply.status, reply.body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.destroy(err as Error);
      send(res, err instanceof HttpError ? err.status : 500, { error: (err as Error).message });
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
    close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      return closed;
    },
  };
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

const maxBodyBytes = 1 << 20;
async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req as AsyncIterable<string>) {
    body += chunk;
    if (body.length > maxBodyBytes) throw new HttpError(413, `request body over ${maxBodyBytes} bytes`);
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new HttpError(400, `body is not JSON: ${(err as Error).message}`);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}
