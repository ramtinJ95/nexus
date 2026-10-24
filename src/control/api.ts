/**
 * The control plane's HTTP API for the dashboard and the CLI. JSON in and out.
 *
 * Each thread's agent is a conversation in the control plane's harness. The API creates it with the thread,
 * forwards messages, aborts and retries to it, and serves its view.
 *
 * A thread's conversation also streams, as server-sent events: its view for the CLI, and the thread page's
 * conversation for the dashboard. Each stream holds one watch on the harness and sends what changed since its
 * last event, so a slow client gets fewer, larger events and never holds the harness up.
 *
 * Like the probe, it trusts tailnet identity: each caller's stable node ID, from tailscaled's whois, must be
 * on the allowlist. The API writes only what a human asks for. Every change that can move a pylon
 * wakes the loop for its node, so a start or a dashboard visit acts within one pass rather than 5 seconds.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { actualState, desiredPhase, retryRefusal, type ActualState, type DesiredPhase } from "../reconcile.ts";
import { effectiveAllowedHosts, gitUrl, linkedName, liveHashOf, reservedPorts, withHttpsHosts, type BootInputs, type Project, type ProjectId, type PylonOverlay, type SessionHarness } from "../project.ts";
import type { CommandResult, NodeName, ProbeClient, ProbeError, PylonCommand, PylonId, TailnetNodeId } from "../protocol.ts";
import type { ConversationView, ConversationWatch, EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import type { HarnessHost } from "../harness/host.ts";
import { pinsSchema, type ImageId, type ImageManifest } from "../images.ts";
import type { Whois } from "../tailscale.ts";
import { newPylonRecord } from "../tick.ts";
import type { NodeRecord, Output, PortRange, Preview, Registry, Session, Thread, ThreadId } from "./registry.ts";
import { dashboard, liveFrames } from "./dashboard.ts";
import { pylonLive } from "./live.ts";
import { herdrSession } from "../sessions.ts";

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
  /** One client per registry node, for the guest commands a human asks for. */
  probes: ReadonlyMap<NodeName, Pick<ProbeClient, "command">>;
  /** The https ports each node's previews are allocated from, the loop's range. */
  previewPorts: PortRange;
  /** How long a stream's client may leave what was sent unread before it is dropped. 30 s by default. */
  streamStallMs?: number;
}

/** A session `POST /v1/threads/<id>/sessions` opened. Its observed state shows in ThreadDetail.sessions. */
export interface OpenedSession { herdrPane: string; harness: SessionHarness; title: string }

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
  /**
   * The TCP ports the pylon listens on that a preview can reach, as its node last reported them, in order. Empty
   * while the pylon is not running, and null when its node could not read them.
   */
  ports: readonly ListeningPort[] | null;
  outputs: readonly Output[];
  /** The command that attaches to the pylon's Herdr sessions from a shell in the pylon. */
  attach: string;
  /** Null for a thread that has no conversation. A parked task holds the run until it is retried. */
  agent: { parkedTasks: number } | null;
}

/**
 * `service` is the service the port belongs to: declared, ad hoc, or `port-<port>` once it is linked. `preview` is
 * that service's preview, or null while it has none, which `POST /v1/threads/<id>/previews` gives it.
 */
export interface ListeningPort { port: number; service: string | null; preview: Preview | null }

/** A thread as the list reports it, with what the planner wants of its pylon and what its node last reported. */
export type ThreadRow = Thread & { desired: DesiredPhase; pylon: Pick<ThreadDetail["pylon"], "node" | "actualState" | "failed"> };

/**
 * One event of `GET /v1/threads/:id/events`. The first carries the whole view. Each later one carries what changed
 * since the one before, each part whole: the active context when any entry changed, and each document that changed,
 * or null for one that is gone.
 */
export interface ViewFrame {
  entries?: readonly EntryRecord[];
  docs?: Record<string, JsonObject | null>;
}

/** Maps each committed view to what one client has not seen yet, or null when nothing it shows changed. */
export type Frames = (view: ConversationView) => unknown;

/** The frames of one client of a thread's event stream. pi-durable's views share every part a commit left alone. */
export function viewFrames(): Frames {
  let sent: ConversationView | null = null;
  return (view) => {
    const kinds = new Set([...Object.keys(view.docs), ...Object.keys(sent?.docs ?? {})]);
    const docs = Object.fromEntries([...kinds].flatMap((kind) => view.docs[kind] === sent?.docs[kind] ? [] : [[kind, view.docs[kind] ?? null]]));
    const frame: ViewFrame = {
      ...view.entries === sent?.entries ? {} : { entries: view.entries },
      ...Object.keys(docs).length === 0 ? {} : { docs },
    };
    sent = view;
    return Object.keys(frame).length === 0 ? null : frame;
  };
}

/** Streams open at once, across threads and callers. Each holds a harness watch and renders on every commit. */
export const maxStreams = 16;
/**
 * Under the CLI's 30 s idle timeout, so a quiet thread's stream stays open. Each ping renders the latest view again
 * first, so what a frame shows of the time, such as how long ago the thread started, stays true.
 */
const pingMs = 15_000;

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
  pins: pinsSchema,
  builtOn: z.string().min(1).transform((node) => node as NodeName),
  builtAt: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const currentImageSchema = z.strictObject({ image: z.string().min(1) });
const previewSchema = z.strictObject({ port: z.int().min(1).max(65535).refine((port) => !reservedPorts.has(port), "is Nexus's own") });
const sessionSchema = z.strictObject({
  harness: z.enum(["claude-code", "pi", "shell"]).default("claude-code"),
  /** The Herdr workspace's label. The harness's name by default. */
  title: z.string().trim().min(1).max(80).optional(),
});

/** `pylon-<id>` must fit in 40 characters. */
const newThreadId = () => `th-${randomBytes(6).toString("hex")}` as ThreadId;

export async function startApi(options: ApiOptions): Promise<Api> {
  const { registry, whois, allowed, hostnames, dotfiles, harness, wake, probes, previewPorts, streamStallMs = 30_000 } = options;

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
    const live = pylonLive({ pylonId, thread: id, node, boot }, project, []);
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

  function portsOf(pylonId: PylonId, previews: readonly Preview[]): ThreadDetail["ports"] {
    const observed = observedPylon(pylonId);
    if (observed === "absent" || observed.phase !== "running") return [];
    // An observation stored before the field existed has none.
    const listening = observed.listening ?? null;
    if (listening === null) return null;
    return listening.map(({ port }) => {
      // A port linked a moment ago has its preview before the node's next read lists its service.
      const service = observed.services?.find((s) => s.port === port)?.name
        ?? (previews.some((p) => p.service === linkedName(port)) ? linkedName(port) : null);
      return { port, service, preview: previews.find((p) => p.service === service) ?? null };
    });
  }

  function row(t: Thread): ThreadRow {
    const { node, actualState, failed } = pylonOf(t);
    return { ...t, desired: desiredPhase(t, Date.now()), pylon: { node, actualState, failed } };
  }

  function detail(t: Thread): ThreadDetail {
    const pylon = registry.pylon(t.pylonId)!;
    const previews = registry.previews(pylon.pylonId);
    return {
      thread: t,
      desired: desiredPhase(t, Date.now()),
      pylon: pylonOf(t),
      sessions: registry.sessions(pylon.pylonId),
      previews,
      ports: portsOf(pylon.pylonId, previews),
      outputs: registry.outputs(t.id),
      attach: `herdr --session ${herdrSession}`,
      agent: t.conversationId === null || t.status === "deleted" ? null : { parkedTasks: harness.activity.parked(t.id).length },
    };
  }

  const page = dashboard({ registry, detail, conversation });

  /** Each open stream's thread and how to end it, so a delete ends its thread's streams. */
  const open = new Set<{ thread: ThreadId; end(): void }>();

  /**
   * Sends `frames` of each commit to the thread's conversation as server-sent events. A client that reads slowly
   * leaves bytes in the socket: until it drains, commits only replace the view to send, and the next event carries
   * everything since the last one. So the harness's listener never waits on a client. A client that leaves bytes
   * unread for `streamStallMs` is dropped, and one that still listens connects again.
   */
  async function stream(res: ServerResponse, t: Thread, frames: Frames) {
    if (open.size >= maxStreams) throw new HttpError(503, `${maxStreams} streams are open, the most this control plane serves at once`);
    let watch: ConversationWatch | null = null;
    let ping: NodeJS.Timeout | undefined;
    let stalled: NodeJS.Timeout | undefined;
    let ended = false;
    const stall = () => { stalled ??= setTimeout(() => res.destroy(), streamStallMs); };
    const send = (text: string) => { if (!res.write(text)) stall(); };
    /**
     * Once, whichever comes first: the client leaves, the thread is deleted, or the harness ends the watch. The
     * watch, the ping and the stream's place go at once. The response ends once the client reads what it holds,
     * or is dropped after the stall limit.
     */
    const end = () => {
      if (ended) return;
      ended = true;
      open.delete(handle);
      clearInterval(ping);
      void watch?.stop();
      res.end();
      if (!res.closed) stall();
    };
    const handle = { thread: t.id, end };
    open.add(handle);
    res.on("close", () => {
      clearTimeout(stalled);
      end();
    });
    try {
      watch = await harness.watch(t.id);
    } catch (err) {
      // The error reply ends the response.
      ended = true;
      open.delete(handle);
      throw err;
    }
    if (ended) return void watch.stop();
    let latest = watch.value;
    /** Whether bytes are on their way, so the stream needs no ping. A view that cannot be rendered ends the stream. */
    const flush = () => {
      if (ended || res.writableNeedDrain) return true;
      let frame: unknown;
      try {
        frame = frames(latest);
      } catch (err) {
        res.destroy(err as Error);
        return true;
      }
      if (frame !== null) send(`data: ${JSON.stringify(frame)}\n\n`);
      return frame !== null;
    };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    flush();
    res.on("drain", () => {
      clearTimeout(stalled);
      stalled = undefined;
      flush();
    });
    ping = setInterval(() => { if (!flush()) send(": ping\n\n"); }, pingMs);
    watch.start(async (view) => {
      latest = view;
      flush();
    });
    void watch.closed.then(end);
  }

  const streams: readonly [RegExp, (t: Thread) => Frames][] = [
    [/^\/v1\/threads\/([^/]+)\/events$/, () => viewFrames()],
    [/^\/threads\/([^/]+)\/stream$/, (t) => liveFrames(t)],
  ];

  async function setStatus(t: Thread, status: "archived" | "deleted"): Promise<Thread> {
    if (t.status === "deleted") throw new HttpError(409, `thread ${t.id} is deleted`);
    registry.setThreadStatus(t.id, status);
    wakeThread(t);
    if (status === "deleted") for (const s of open) if (s.thread === t.id) s.end();
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

  /**
   * Runs a command a human asked for in the thread's pylon, such as a link or a session open. Asking is human
   * activity, as a message is, so a paused pylon is woken, but the command itself needs the pylon running and is
   * refused with a 409 until it is.
   */
  async function pylonCommand<K extends "link-port" | "unlink-port" | "open-session" | "close-session">(t: Thread, command: Extract<PylonCommand, { kind: K }>): Promise<Extract<CommandResult, { kind: K }>> {
    if (t.status === "deleted" || t.status === "archived") throw new HttpError(409, `thread ${t.id} is ${t.status}, so its pylon stays paused`);
    const pylon = registry.pylon(t.pylonId)!;
    const probe = probes.get(pylon.node);
    if (probe === undefined) throw new HttpError(503, `no probe is configured for ${pylon.node}`);
    registry.recordActivity(t.id, { human: Date.now() });
    wake(pylon.node);
    let result: CommandResult;
    try {
      result = await probe.command(pylon.pylonId, command);
    } catch (err) {
      const code = (err as Partial<ProbeError>).code;
      if (code === "not-running") throw new HttpError(409, `pylon ${pylon.pylonId} is not running yet. This request wakes it, so ask again once it runs`);
      if (code === "unreachable") throw new HttpError(503, (err as Error).message);
      throw err;
    }
    // A delete that landed meanwhile may have released the pylon's ports already.
    if (registry.thread(t.id)!.status === "deleted") throw new HttpError(409, `thread ${t.id} is deleted`);
    // The client checks that the result is the command's kind.
    return result as Extract<CommandResult, { kind: K }>;
  }

  /**
   * Links the port in the pylon, then gives its service an https port at once, as the loop would at the next
   * observation, so the reply names the URL. The URL serves once the loop's next spawn publishes it, which `ready`
   * reports. Linking a port again answers its preview again.
   */
  async function linkPort(t: Thread, body: unknown): Promise<Preview> {
    const { port } = parse(previewSchema, body);
    const { service } = await pylonCommand(t, { kind: "link-port", port });
    try {
      registry.allocatePreviews(t.pylonId, [service], previewPorts);
    } catch (err) {
      throw new HttpError(503, (err as Error).message);
    }
    wakeThread(t);
    return registry.previews(t.pylonId).find((p) => p.service === service)!;
  }

  /**
   * Unlinks the port in the pylon, which stops forwarding it at once, then drops its preview, as the loop would at
   * the next observation. Tailscale stops serving the URL once the loop's next spawn publishes the previews without
   * it. A port that is not linked succeeds. A port a service's preview owns is refused with a 422, not a 409, because
   * waiting cannot change it, and the CLI and dashboard try a 409 again.
   */
  async function unlinkPort(t: Thread, port: number): Promise<void> {
    const { refused } = await pylonCommand(t, { kind: "unlink-port", port });
    if (refused !== null) throw new HttpError(422, refused);
    registry.releasePreview(t.pylonId, linkedName(port));
    wakeThread(t);
  }

  /**
   * Opens a Herdr session in the pylon's checkout, with the harness's agent in it, and answers once the agent is
   * ready or waits for its human, such as at Claude Code's login. The node publishes its sessions again at once,
   * so ThreadDetail lists it within moments.
   */
  async function openSession(t: Thread, body: unknown): Promise<OpenedSession> {
    const { harness, title = harness } = parse(sessionSchema, body);
    const { herdrPane } = await pylonCommand(t, { kind: "open-session", harness, title });
    return { herdrPane, harness, title };
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
    ["POST", /^\/v1\/threads\/([^/]+)\/previews$/, async (m, r) => {
      const body = await r.body();
      return ok(await linkPort(thread(m[1]!), body));
    }],
    ["DELETE", /^\/v1\/threads\/([^/]+)\/previews\/([^/]+)$/, async (m) => {
      const { port } = parse(previewSchema, { port: /^\d+$/.test(m[2]!) ? Number(m[2]) : m[2] });
      await unlinkPort(thread(m[1]!), port);
      return noContent;
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/sessions$/, async (m, r) => {
      const body = await r.body();
      return created(await openSession(thread(m[1]!), body));
    }],
    // A pane that is already closed succeeds.
    ["DELETE", /^\/v1\/threads\/([^/]+)\/sessions\/([^/]+)$/, async (m) => {
      await pylonCommand(thread(m[1]!), { kind: "close-session", herdrPane: m[2]! });
      return noContent;
    }],
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
    for (const [pattern, frames] of streams) {
      const m = pattern.exec(path);
      if (m === null) continue;
      if (req.method !== "GET") throw new HttpError(405, `${req.method} is not allowed on ${path}`);
      const t = conversing(thread(m[1]!));
      return stream(res, t, frames(t));
    }
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
