/**
 * The control plane's HTTP API for the dashboard and the CLI. JSON in and out.
 *
 * Like the probe, it trusts tailnet identity: each caller's stable node ID, from tailscaled's whois, must be
 * on the allowlist. The API writes only what a human asks for. Every change that can move a pylon
 * wakes the loop for its node, so a start or a dashboard visit acts within one pass rather than 5 seconds.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { actualState, type ActualState } from "../reconcile.ts";
import { effectiveAllowedHosts, type LiveSpec, type Project, type ProjectId } from "../project.ts";
import type { LiveHash, NodeName, PylonId, TailnetNodeId } from "../protocol.ts";
import type { ImageId, ImageManifest } from "../images.ts";
import type { Whois } from "../tailscale.ts";
import { newPylonRecord } from "../tick.ts";
import type { Output, Preview, Registry, Session, Thread, ThreadId } from "./registry.ts";

export interface ApiOptions {
  registry: Registry;
  host: string;
  /** 0 picks a free port. */
  port: number;
  whois: Whois;
  allowed: ReadonlySet<TailnetNodeId>;
  /** Names the API answers to in the Host header. Any other name is a DNS rebinding page on an allowed machine. */
  hostnames: ReadonlySet<string>;
  /** Asks the loop for a pass over the node's pylons. */
  wake(node: NodeName): void;
}

export interface Api {
  readonly port: number;
  close(): Promise<void>;
}

export interface ThreadDetail {
  thread: Thread;
  pylon: { id: PylonId; node: NodeName; actualState: ActualState; failed: string | null; observedAt: string | null };
  sessions: readonly Session[];
  previews: readonly Preview[];
  outputs: readonly Output[];
}

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
  repoUrl: z.string().min(1),
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
const activitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  // Fed by hand until pi-durable runs threads on the control plane.
  z.strictObject({ kind: z.literal("agent"), turnRunning: z.boolean() }),
]);
const imageSchema = z.strictObject({
  id: z.string().regex(/^img-[0-9a-f]{12}$/).transform((id) => id as ImageId),
  gondolinBuildId: z.string().min(1),
  pins: z.strictObject({
    debianDigest: z.string(), node: z.string(), claudeCode: z.string(), pi: z.string(), herdr: z.string(),
    gondolin: z.string(), alpineKernel: z.string(), dotfilesCommon: z.string(),
  }),
  builtOn: z.string().min(1).transform((node) => node as NodeName),
  builtAt: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const currentImageSchema = z.strictObject({ image: z.string().min(1) });

/** `pylon-<id>` must fit in 40 characters. */
const newThreadId = () => `th-${randomBytes(6).toString("hex")}` as ThreadId;

/** sha256 of the LiveSpec with sorted keys, so equal specs hash equally however they were built. */
export function liveHashOf(live: LiveSpec): LiveHash {
  const canonical = (value: unknown): unknown => typeof value !== "object" || value === null ? value
    : Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return createHash("sha256").update(JSON.stringify(canonical(live))).digest("hex") as LiveHash;
}

export async function startApi(options: ApiOptions): Promise<Api> {
  const { registry, whois, allowed, hostnames, wake } = options;

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

  /** Templates come later, so every pylon boots fresh from the current image and runs setup inline. */
  function startThread(body: unknown, caller: TailnetNodeId): Thread {
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
    const live: LiveSpec = { previews: [], overlay: [] };
    const t: Thread = {
      id, title: request.title, project: project.id, pylonId, status: "active", conversationId: null, startedBy: caller, createdAt: now,
      // Starting a thread is human activity, so its pylon is wanted at once.
      agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: now,
    };
    const { desired: _, ...pylon } = newPylonRecord({
      thread: id, pylonId, node, desired: "running",
      boot: {
        pylonId, image, resources: project.resources,
        network: { allowedHosts: effectiveAllowedHosts(project), secrets: project.secrets },
        repo: { url: project.repoUrl, checkout: { branch, commit: request.commit ?? `origin/${branch}` } },
      },
      firstBoot: { kind: "fresh", preSetup: project.preSetup },
      live,
      liveHash: liveHashOf(live),
    });
    registry.createThread(t, pylon);
    wake(node);
    return t;
  }

  function detail(t: Thread): ThreadDetail {
    const pylon = registry.pylon(t.pylonId)!;
    const node = registry.node(pylon.node)!;
    const observation = node.observation;
    const observed = observation?.pylons.find((p) => p.pylonId === pylon.pylonId) ?? "absent";
    const inFlight = registry.job(pylon.pylonId) ?? null;
    return {
      thread: t,
      pylon: {
        id: pylon.pylonId, node: pylon.node, failed: pylon.failed, observedAt: observation?.observedAt ?? null,
        actualState: actualState(observed, inFlight, node.state === "online", pylon.failed !== null),
      },
      sessions: registry.sessions(pylon.pylonId),
      previews: registry.previews(pylon.pylonId),
      outputs: registry.outputs(t.id),
    };
  }

  function setStatus(t: Thread, status: "archived" | "deleted"): Thread {
    if (t.status === "deleted") throw new HttpError(409, `thread ${t.id} is deleted`);
    registry.setThreadStatus(t.id, status);
    wakeThread(t);
    return { ...t, status };
  }

  function recordActivity(t: Thread, body: unknown) {
    const activity = parse(activitySchema, body);
    const now = Date.now();
    if (activity.kind === "human") registry.recordActivity(t.id, { human: now });
    else registry.recordActivity(t.id, { agent: now, agentTurnRunning: activity.turnRunning });
    wakeThread(t);
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
    ["GET", /^\/v1\/threads$/, (_, r) => ok(registry.threads((r.query.get("project") ?? undefined) as ProjectId | undefined))],
    ["POST", /^\/v1\/threads$/, async (_, r) => created(startThread(await r.body(), r.caller))],
    ["GET", /^\/v1\/threads\/([^/]+)$/, (m) => ok(detail(thread(m[1]!)))],
    ["DELETE", /^\/v1\/threads\/([^/]+)$/, (m) => ok(setStatus(thread(m[1]!), "deleted"))],
    ["POST", /^\/v1\/threads\/([^/]+)\/archive$/, (m) => ok(setStatus(thread(m[1]!), "archived"))],
    ["POST", /^\/v1\/threads\/([^/]+)\/activity$/, async (m, r) => { recordActivity(thread(m[1]!), await r.body()); return noContent; }],
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
