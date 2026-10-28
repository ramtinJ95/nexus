import { eventCursor, eventKinds, type EventFilter } from "../events.ts";
import { DeployDraining, isDraining, turnGate } from "./drain.ts";
import { runningCommit } from "../deploy/health.ts";
import { canDeploy, commitSchema, isReporter, releaseView, reportSchema, resolveMain, type DeploymentOptions } from "./releases.ts";
/**
 * The control plane's HTTP API for the dashboard and the CLI. JSON in and out.
 *
 * Each thread's agent is a conversation in the control plane's harness, or a Claude Code worker in its pylon. The API
 * creates a harness conversation with the thread, forwards messages, aborts and retries to it, and serves its view. A
 * Claude worker's messages are typed into its session, and its view is its transcript as claude-conversation.ts reads it.
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
import type { Attention } from "./attention.ts";
import { once } from "node:events";
import { createServer as createHttpsServer } from "node:https";
import { TLSSocket } from "node:tls";
import type { Certificate } from "../tailscale.ts";
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { actualState, desiredPhase, retryRefusal, type ActualState, type DesiredPhase } from "../reconcile.ts";
import { bootSecrets, chatgptTokenGrant, effectiveAllowedHosts, gitIdentitySchema, gitUrl, linkedName, reservedPorts, withHttpsHosts, type BootInputs, type Project, type ProjectId, type SessionHarness } from "../project.ts";
import { isImageId, type CommandResult, type NodeName, type ProbeClient, type ProbeError, type PylonCommand, type PylonId, type TailnetNodeId } from "../protocol.ts";
import type { ConversationView, EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import type { HarnessHost } from "../harness/host.ts";
import { pinsSchema, type ImageId, type ImageManifest } from "../images.ts";
import type { Whois } from "../tailscale.ts";
import type { ClaudeSent, NodeRecord, Output, PortRange, Preview, Registry, Session, Thread, ThreadId } from "./registry.ts";
import { dashboard, liveFrames } from "./dashboard.ts";
import { attachScript, checkoutDir, claudeTextProblem, herdrSession } from "../sessions.ts";
import { claudeConversations, claudeFrames } from "./claude-conversation.ts";
import { usageFilter } from "./usage.ts";
import type { UsageBackfillJob } from "./usage-backfill.ts";
import type { ClaudeConversation } from "../claude-transcript.ts";
import { checkoutReader, CheckoutRefused, contentType, pathsFit, type CheckoutReader, type RefusalKind } from "../checkout-files.ts";
import { attachRoute, parseAttachQuery } from "../attach-wire.ts";
import type { PullRequest } from "./github.ts";
import { openTerminal } from "../guest-terminal.ts";
import { attachTiming, serveAttach, type AttachTiming, type Ending, type PylonDoor } from "./attach.ts";
import { typeIntoClaude } from "./inbox.ts";
import { HttpError } from "./http-error.ts";
import { BodyTooLarge, readBody } from "../request-body.ts";
import { imagesView, type ImageOperation, type ImageRollout } from "./image-rollout.ts";
import type { StartRequest } from "./threads.ts";
import { queuedView, type QueuedRecord, type ThreadQueue } from "./queue.ts";
import { nodePylons, overcommitted, type NodePylons } from "./placement.ts";
import { maxRounds, type Review, type ReviewLoop } from "./review.ts";

export interface ApiOptions {
  https?: { port: number; certificate(): Promise<Certificate>; renewalMs?: number; retryMs?: number };
  prWatchEnabled?: boolean;
  /** Null without a control-plane GitHub token, which the review loop reads and merges with. */
  reviews?: ReviewLoop | null;
  /** Null without a control-plane GitHub token, which tells it when a predecessor's pull request merged. */
  queue?: ThreadQueue | null;
  deployment?: DeploymentOptions;
  turnsStarting?: () => boolean;
  registry: Registry;
  host: string;
  /** 0 picks a free port. */
  port: number;
  whois: Whois;
  allowed: ReadonlySet<TailnetNodeId>;
  /** Names the API answers to in the Host header. Any other name is a DNS rebinding page on an allowed machine. */
  hostnames: ReadonlySet<string>;
  harness: ThreadHarness;
  startThread(request: StartRequest, caller: string): Promise<Thread>;
  /** Asks the loop for a pass over the node's pylons. */
  wake(node: NodeName): void;
  /** One client per registry node, for the guest commands and checkout reads a human asks for. */
  probes: ReadonlyMap<NodeName, Pick<ProbeClient, "command" | "stream">>;
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

/** A session `POST /v1/threads/<id>/sessions` opened. Its observed state shows in ThreadDetail.sessions. */
export interface OpenedSession { herdrPane: string; harness: SessionHarness; title: string }

export type ThreadHarness = Pick<HarnessHost, "startThread" | "send" | "abort" | "retry" | "watch" | "deleteThread" | "activity" | "latestTurn">;

export interface Api {
  readonly port: number;
  readonly httpsPort: number | undefined;
  close(): Promise<void>;
}

export interface ThreadDetail {
  claudeWorker?: { model: string | null; state: string; message?: string };
  attention: Attention;
  seenAt: number | null;
  lastReplyAt: number | null;
  thread: Thread;
  /** What the planner wants of the pylon now, from the thread's status and activity. */
  desired: DesiredPhase;
  pylon: {
    grantsOutdated: boolean;
    id: PylonId; node: NodeName; actualState: ActualState; failed: string | null; observedAt: string | null;
    /** The size the pylon boots with, fixed when its thread started. */
    resources: BootInputs["resources"];
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
  prWatch: { enabled: boolean; stopped: boolean; error: string | null };
  pullRequests: readonly PullRequest[];
  /** The thread's latest review as a builder, or null. */
  review: Review | null;
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
export type ThreadRow = Thread & { attention: Attention; desired: DesiredPhase; pylon: Pick<ThreadDetail["pylon"], "node" | "actualState" | "failed"> };

/**
 * One event of `GET /v1/threads/:id/events`. The first carries the whole view. Each later one carries what changed
 * since the one before, each part whole: the active context when any entry changed, and each document that changed,
 * or null for one that is gone.
 */
export interface ViewFrame {
  entries?: readonly EntryRecord[];
  docs?: Record<string, JsonObject | null>;
}

/** Maps each view to what one client has not seen yet, or null when nothing it shows changed. */
export type Frames<V = ConversationView> = (view: V) => unknown;
type EventBatch = ReturnType<Registry["eventBatch"]>;

/** What a stream follows: a harness conversation's watch, or a Claude worker's. */
interface Watch<V> {
  readonly value: V;
  start(listener: (view: V) => void | Promise<void>): void;
  stop(): Promise<unknown>;
  readonly closed: Promise<unknown>;
}

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

/** Streams open at once, across threads and callers. Each holds a watch and renders on every change. */
export const maxStreams = 16;
/**
 * Under the CLI's 30 s idle timeout, so a quiet thread's stream stays open. Each ping renders the latest view again
 * first, so what a frame shows of the time, such as how long ago the thread started, stays true.
 */
const pingMs = 15_000;

/**
 * A node without its probe's latest observation, which thread detail already reports per pylon. `pylons` sorts the
 * observation's pylons by what they hold, and is null for a node never observed.
 */
export type NodeSummary = Omit<NodeRecord, "observation"> & { observedAt: string | null; overcommitted: boolean; pylons: NodePylons | null };

function networkGrantsKey(network: BootInputs["network"]): string {
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  const secrets = new Map<string, Set<string>>();
  for (const grant of network.secrets) {
    const hosts = secrets.get(grant.name) ?? new Set<string>();
    for (const host of grant.hosts) hosts.add(host);
    secrets.set(grant.name, hosts);
  }
  return JSON.stringify({
    allowedHosts: sorted(network.allowedHosts),
    secrets: sorted(secrets.keys()).map((name) => ({ name, hosts: sorted(secrets.get(name)!) })),
  });
}

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const host = z.string().min(1);
const projectSchema = z.strictObject({
  id: name.transform((id) => id as ProjectId),
  repoUrl: gitUrl.nullable(),
  defaultBranch: z.string().min(1),
  defaultNode: z.string().min(1).transform((node) => node as NodeName | "auto"),
  resources: z.strictObject({ cpus: z.int().positive(), memoryGiB: z.int().positive(), diskGiB: z.int().positive() }),
  allowedHosts: z.array(host),
  secrets: z.array(z.strictObject({ name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), hosts: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)).min(1) }))
    .refine((grants) => new Set(grants.map((grant) => grant.name)).size === grants.length, "duplicate secret names: list all of a secret's hosts in one grant")
    .refine((grants) => !grants.some((grant) => grant.name === chatgptTokenGrant.name), `${chatgptTokenGrant.name} comes with the chatgpt login: add the login instead`),
  logins: z.array(z.enum(["claude", "chatgpt"])),
  preSetup: z.string().nullable(),
  gitIdentity: gitIdentitySchema.nullable().optional(),
});
/** Only an edit sets `autoReview`, and the API records its caller in it, so a project's add cannot name someone else. */
const projectEditSchema = projectSchema.omit({ id: true, repoUrl: true, preSetup: true })
  .extend({ resources: projectSchema.shape.resources.partial(), autoReview: z.strictObject({ land: z.boolean() }).nullable() }).partial();
const startSchema = z.strictObject({
  model: z.string().trim().min(1).max(200).optional(),
  claude: z.string().trim().min(1).max(16_384).refine((prompt) => !prompt.includes("\0"), "a Claude prompt cannot hold a NUL character, which no command-line argument can").optional(),
  project: z.string().min(1),
  title: z.string().min(1),
  node: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  /**
   * Until the control plane mirrors repos, the caller may pin a commit. The default is the branch tip at clone time.
   * A scratch project has none to pin.
   */
  commit: z.string().min(1).optional(),
  /** The thread's size where it differs from its project's. Its pylon boots this size on every wake. */
  resources: projectSchema.shape.resources.partial().optional(),
  /** Queue the thread to start once each of these threads' pull requests has merged. */
  after: z.array(z.string().min(1)).min(1).max(32).optional(),
  /** A queued Nexus agent thread's first message, sent once it starts. */
  message: z.string().min(1).optional(),
});
// Agent activity comes from the harness.
const seenSchema = z.strictObject({ lastReplyAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional() });
const activitySchema = z.strictObject({ kind: z.literal("human") });
const messageSchema = z.strictObject({
  text: z.string().min(1),
  /** Minted by the client per message, such as msg:<uuid>. A retry with the same ID is the same message. */
  requestId: z.string().min(1),
  /** followUp waits for the current run. steer joins it after its current tool round. */
  mode: z.enum(["followUp", "steer"]).default("followUp"),
});
const reviewSchema = z.strictObject({
  pr: z.int().positive().optional(),
  rounds: z.int().min(1).max(maxRounds).optional(),
  /** Land the PR under the merge policy once the review approves it and its checks pass. */
  land: z.boolean().default(false),
});
const imageSchema = z.strictObject({
  id: z.custom<ImageId>(isImageId, "must be an image ID"),
  gondolinBuildId: z.string().min(1),
  pins: pinsSchema,
  builtOn: z.string().min(1).transform((node) => node as NodeName),
  builtAt: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const rolloutSchema = z.strictObject({ image: imageSchema.shape.id });
const noFields = z.strictObject({});
const previewSchema = z.strictObject({ port: z.int().min(1).max(65535).refine((port) => !reservedPorts.has(port), "is Nexus's own") });
const sessionSchema = z.strictObject({
  harness: z.enum(["claude-code", "pi", "shell"]).default("claude-code"),
  /** The Herdr workspace's label. The harness's name by default. */
  title: z.string().trim().min(1).max(80).optional(),
});

/** A path in the checkout, relative to it. Empty is the checkout itself. */
const checkoutPath = z.string().refine((path) => !path.includes("\0"), "has a NUL byte").refine((path) => pathsFit([path]), "is too long");
/** A diff's paths, which the probe's request must carry together. */
const diffPaths = z.array(checkoutPath.min(1)).max(100).refine(pathsFit, "are too long together");
const changesBaseSchema = z.enum(["start", "head", "turn"]).default("start");
/** What each refusal of a checkout read answers. A missing base is a 422, not a 409, because waiting cannot change it. */
const refusalStatus: Readonly<Record<RefusalKind, number>> = { missing: 404, outside: 400, kind: 400, large: 413, "no-base": 422, slow: 504, busy: 503, long: 400 };

/** How long a read of a Claude worker's conversation waits for its transcript before answering what is stored. */
const claudeReadMs = 5_000;


export async function startApi(options: ApiOptions): Promise<Api> {
  const { registry, whois, allowed, hostnames, harness, startThread, wake, probes, previewPorts, streamStallMs = 30_000, attachTiming: timing = attachTiming, closeWaitMs = 5_000 } = options;
  const claude = claudeConversations({ registry, probes });

  function thread(id: string): Thread {
    const found = registry.thread(id as ThreadId);
    if (found !== undefined) return found;
    const queued = queuedRecord(id);
    if (queued !== undefined) throw new HttpError(409, queued.status === "queued" ? `thread ${id} is queued, so it has no pylon or conversation yet` : `thread ${id} was ${queued.status === "archived" ? "cancelled" : "deleted"} while queued, so it has no pylon or conversation`);
    throw new HttpError(404, `no thread ${id}`);
  }

  /** A thread that has not started, which has a queue record and no row. */
  function queuedRecord(id: string): QueuedRecord | undefined {
    if (registry.thread(id as ThreadId) !== undefined) return undefined;
    const record = registry.queuedThread(id as ThreadId);
    return record?.status === "started" ? undefined : record;
  }

  function queueOrRefuse(): ThreadQueue {
    if (!options.queue) throw new HttpError(409, "queued threads need the control plane's GitHub token (github.tokenFile), which is not configured");
    return options.queue;
  }

  const queuedStatus = (id: string, status: "archived" | "queued" | "deleted") => queuedView(registry, queueOrRefuse().setStatus(id as ThreadId, status));

  function wakeThread(t: Thread) {
    wake(registry.pylon(t.pylonId)!.node);
  }

  function refuseUnknownNode(project: Project) {
    if (project.defaultNode !== "auto" && registry.node(project.defaultNode) === undefined) throw new HttpError(400, `no node ${project.defaultNode}`);
  }

  function createProject(body: unknown): Project {
    const project: Project = parse(projectSchema, body);
    refuseUnknownNode(project);
    if (registry.project(project.id) !== undefined) throw new HttpError(409, `project ${project.id} exists`);
    registry.createProject(project);
    return project;
  }

  function refuseDeleted(t: Thread): Thread {
    if (t.status === "deleted") throw new HttpError(409, `thread ${t.id} is deleted`);
    return t;
  }

  /** Threads from before the harness ran on the control plane have no conversation, and a deleted thread's is gone. */
  function conversing(t: Thread): Thread {
    refuseDeleted(t);
    if (t.conversationId === null) throw new HttpError(409, `thread ${t.id} has no conversation`);
    return t;
  }

  /** A Claude worker thread has no harness conversation, so nothing for it ever reaches the harness. */
  const isClaude = (t: Thread) => registry.claudeWorker(t.id) !== undefined;

  function claudeWorker(t: Thread): Thread {
    refuseDeleted(t);
    if (!isClaude(t)) throw new HttpError(409, `thread ${t.id} has no Claude worker`);
    return t;
  }

  /** An archived thread's pylon stays paused, so its agent could not run a tool. */
  function runnable(t: Thread): Thread {
    if (t.status === "archived") throw new HttpError(409, `thread ${t.id} is archived`);
    return conversing(t);
  }

  function reviewsOrRefuse(): ReviewLoop {
    if (!options.reviews) throw new HttpError(409, "the review loop needs the control plane's GitHub token (github.tokenFile), which is not configured");
    return options.reviews;
  }

  /** Landing merges and may deploy, so it takes the same right as `nexus deploy`, whatever the repository. */
  function mayLand(caller: TailnetNodeId) {
    if (!canDeploy(registry, options.deployment, caller)) throw new HttpError(403, "caller may not land a pull request: landing deploys, and only deployers may, never infrastructure nodes or pylons");
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
      grantsOutdated: networkGrantsKey(pylon.boot.network) !== networkGrantsKey({
        allowedHosts: withHttpsHosts(effectiveAllowedHosts(registry.project(t.project)!), [pylon.boot.dotfiles.repo]),
        secrets: bootSecrets(registry.project(t.project)!),
      }),
      id: pylon.pylonId, node: pylon.node, failed: pylon.failed, observedAt: node.observation?.observedAt ?? null, resources: pylon.boot.resources,
      actualState: actualState(observed, inFlight, node.state === "online", gaveUp), retryRefused: retryRefusal(observed),
    };
  }

  function portsOf(pylonId: PylonId, previews: readonly Preview[]): ThreadDetail["ports"] {
    const observed = observedPylon(pylonId);
    if (observed === "absent" || observed.phase !== "running") return [];
    if (observed.listening === null) return null;
    return observed.listening.map(({ port }) => {
      // A port linked a moment ago has its preview before the node's next read lists its service.
      const service = observed.services?.find((s) => s.port === port)?.name
        ?? (previews.some((p) => p.service === linkedName(port)) ? linkedName(port) : null);
      return { port, service, preview: previews.find((p) => p.service === service) ?? null };
    });
  }

  function row(t: Thread): ThreadRow {
    const { node, actualState, failed } = pylonOf(t);
    return { ...t, attention: registry.attention(t.id), desired: desiredPhase(t, Date.now()), pylon: { node, actualState, failed } };
  }

  function detail(t: Thread): ThreadDetail {
    const pylon = registry.pylon(t.pylonId)!;
    const previews = registry.previews(pylon.pylonId);
    const watch = registry.prWatch(t.id);
    const worker = registry.claudeWorker(t.id);
    return {
      thread: t,
      ...(worker === undefined ? {} : { claudeWorker: { model: worker.model, state: worker.state, ...(worker.message === undefined ? {} : { message: worker.message }) } }),
      attention: registry.attention(t.id), seenAt: t.seenAt, lastReplyAt: t.lastReplyAt,
      desired: desiredPhase(t, Date.now()),
      pylon: pylonOf(t),
      sessions: registry.sessions(pylon.pylonId),
      previews,
      ports: portsOf(pylon.pylonId, previews),
      outputs: registry.outputs(t.id),
      prWatch: { enabled: options.prWatchEnabled ?? false, stopped: (watch?.commentWakes ?? 0) >= 10, error: watch?.error ?? null },
      pullRequests: watch?.links.map((l) => l.pr) ?? [],
      review: registry.review(t.id),
      attach: `herdr --session ${herdrSession}`,
      agent: t.conversationId === null || t.status === "deleted" ? null : { parkedTasks: harness.activity.parked(t.id).length },
    };
  }

  const page = dashboard({
    registry, detail, row, conversation,
    landRefusal: (caller) => !options.reviews ? "no review loop" : canDeploy(registry, options.deployment, caller) ? null : "not a deployer",
    deploys: (r) => options.reviews?.deploys(r) ?? false,
  });

  /**
   * Each open stream's and terminal's thread and how to end it, so a delete ends its thread's streams. The event log's
   * followers belong to no thread.
   */
  const open = new Set<{ thread: ThreadId | null; end(): void }>();

  /**
   * Takes one of the streams' places for a server-sent event stream, or refuses with `full`. A client that leaves
   * bytes unread for `streamStallMs` is dropped, and one that still listens connects again. `end` runs once, whichever
   * comes first: the client leaves, `thread` is deleted, or the source ends. The source's `onEnd`, the timer and the
   * place go at once, and the response ends once the client reads what it holds, or is dropped after the stall limit.
   */
  function eventStream(res: ServerResponse, thread: ThreadId | null, full: string, onEnd: () => void = () => {}) {
    if (open.size >= maxStreams) throw new HttpError(503, full);
    let timer: NodeJS.Timeout | undefined;
    let stalled: NodeJS.Timeout | undefined;
    let ended = false;
    const stall = () => { stalled ??= setTimeout(() => res.destroy(), streamStallMs); };
    const end = () => {
      if (ended) return;
      ended = true;
      open.delete(handle);
      clearInterval(timer);
      onEnd();
      res.end();
      if (!res.closed) stall();
    };
    const handle = { thread, end };
    open.add(handle);
    res.on("close", () => {
      clearTimeout(stalled);
      end();
    });
    return {
      get ended() { return ended; },
      end,
      /** For a source that failed to open. Its error reply ends the response. */
      abandon() {
        ended = true;
        open.delete(handle);
      },
      send(text: string) { if (!res.write(text)) stall(); },
      /** Sends the headers, then calls `tick` every `everyMs`, and `drained` each time a client that fell behind catches up. */
      begin(everyMs: number, tick: () => void, drained: () => void) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.on("drain", () => {
          clearTimeout(stalled);
          stalled = undefined;
          drained();
        });
        timer = setInterval(tick, everyMs);
      },
    };
  }

  /**
   * Sends `frames` of each commit to the thread's conversation. A client that reads slowly leaves bytes in the socket:
   * until it drains, commits only replace the view to send, and the next event carries everything since the last one.
   * So the harness's listener never waits on a client.
   */
  async function stream<V>(res: ServerResponse, t: Thread, follow: () => Promise<Watch<V>>, frames: Frames<V>) {
    let watch: Watch<V> | null = null;
    const sse = eventStream(res, t.id, `${maxStreams} streams are open, the most this control plane serves at once`, () => void watch?.stop());
    try {
      watch = await follow();
    } catch (err) {
      sse.abandon();
      throw err;
    }
    if (sse.ended) return void watch.stop();
    let latest = watch.value;
    let framed: V | undefined;
    /**
     * Whether bytes are on their way, so the stream needs no ping. A view already framed has nothing to send. A view
     * that cannot be rendered ends the stream.
     */
    const flush = () => {
      if (sse.ended || res.writableNeedDrain) return true;
      if (latest === framed) return false;
      framed = latest;
      let frame: unknown;
      try {
        frame = frames(latest);
      } catch (err) {
        res.destroy(err as Error);
        return true;
      }
      if (frame !== null) sse.send(`data: ${JSON.stringify(frame)}\n\n`);
      return frame !== null;
    };
    sse.begin(pingMs, () => { if (!flush()) sse.send(": ping\n\n"); }, flush);
    flush();
    watch.start(async (view) => {
      latest = view;
      flush();
    });
    void watch.closed.then(sse.end);
  }

  /**
   * Sends each event of `first`, then of each later read, as its ID and its data, then the ID of the newest event read
   * as a ping, every second. A client that reads slowly gets the rest of a batch on the first tick after it caught up,
   * from the last event it was sent.
   */
  function followEvents(res: ServerResponse, first: EventBatch, read: (since: string) => EventBatch) {
    const sse = eventStream(res, null, "too many streams");
    let since: string;
    const flush = (batch = read(since)) => {
      for (const event of batch.events) {
        sse.send(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        since = event.id;
        if (res.writableNeedDrain) return;
      }
      since = batch.watermark;
      sse.send(`id: ${since}\n: ping\n\n`);
    };
    sse.begin(1000, () => {
      if (res.writableNeedDrain) return;
      try { flush(); }
      catch { res.destroy(); }
    }, () => {});
    flush(first);
  }

  async function setStatus(t: Thread, status: "archived" | "deleted"): Promise<Thread> {
    if (t.status === "deleted") throw new HttpError(409, `thread ${t.id} is deleted`);
    registry.setThreadStatus(t.id, status);
    wakeThread(t);
    if (status === "deleted") for (const s of open) if (s.thread === t.id) s.end();
    // A read that finds the thread deleted lets its reader go.
    if (status === "deleted" && isClaude(t)) void claude.refresh(t);
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
   * Types a message into the Claude worker's session in the pylon, through inPylon, so it wakes a paused pylon and
   * resumes Claude, and is refused with a 409 until the pylon runs. Both modes go into Claude's prompt, which takes
   * a message sent during a turn at its next step. Claude receives the text exactly, so text that cannot be typed as
   * it is, such as one with a tab, is refused rather than changed.
   *
   * The request ID is recorded as sending before the probe is asked, and as sent with the answer, which a resend of
   * the ID answers again without typing. A send whose answer never came, as one queued in the pylon behind a slow send
   * past the probe's wait, may still be typed, so a resend of it asks the probe what became of it and answers that. A
   * send that failed partway, or that the probe no longer knows, may have typed part of the message, so a resend of it
   * is refused with a 422 for the person to check the conversation. A send that typed nothing, as when the pylon was
   * not running or Claude waits at a prompt in its terminal, is forgotten, so a resend of its ID types it.
   */
  async function sendClaude(t: Thread, session: string | null, model: string | null, body: unknown): Promise<{ claude: ClaudeSent }> {
    const message = parse(messageSchema, body);
    const text = message.text.replace(/\r\n?/g, "\n").trim();
    const problem = claudeTextProblem(text);
    if (problem !== null) throw new HttpError(400, `Claude cannot take this message as typed: ${problem}`);
    if (session === null) throw new HttpError(409, `the Claude worker of ${t.id} has not started a session yet, so it takes no messages. Send it once it has started`);
    const stored = registry.claudeMessage(t.id, message.requestId);
    if (stored?.state === "sent") return { claude: stored.result };
    const typed = await inPylon(t, (probe, pylonId) => typeIntoClaude(registry, t.id, session, model, message.requestId, text, (command) => probe.command(pylonId, command)).catch((err: Partial<ProbeError>) => {
      if (err.code !== "unreachable") throw err;
      throw Object.assign(new Error(`${err.message}. The message may still reach Claude, as one queued in the pylon behind an earlier send does, and reaches it at most once. Send it again under request ID ${message.requestId} to learn what became of it`), { code: "unreachable" });
    }));
    if (typed.kind === "uncertain") throw new HttpError(422, `an earlier send of request ${message.requestId} failed partway, or its pylon no longer knows how far it got, so Claude may have some or all of it. Check the conversation before sending it again under a new request ID`);
    if (typed.kind === "nothing") {
      throw new HttpError(409, {
        blocked: `Claude waits at a prompt in its terminal, so nothing was typed. Attach to the pylon (\`nexus attach ${t.id}\`) and answer it, then send again`,
        starting: `Claude is not ready to take a message yet, so nothing was typed. Ask again in a moment`,
        moved: `Herdr pane ${typed.herdrPane} stopped running Claude session ${session} before the message was typed, so nothing was typed. Send again to resume the session`,
      }[typed.outcome]);
    }
    void claude.refresh(t);
    return { claude: typed.sent };
  }

  /**
   * Runs what a human asked for in the thread's pylon, such as a link, a session open or a checkout read. Asking is
   * human activity, as a message is, so a paused pylon is woken, but the request itself needs the pylon running and
   * is refused with a 409 until it is.
   */
  async function inPylon<T>(t: Thread, act: (probe: Pick<ProbeClient, "command" | "stream">, pylonId: PylonId) => Promise<T>): Promise<T> {
    refuseClosed(t);
    const pylon = registry.pylon(t.pylonId)!;
    const probe = probes.get(pylon.node);
    if (probe === undefined) throw new HttpError(503, `no probe is configured for ${pylon.node}`);
    registry.recordActivity(t.id, { human: Date.now() });
    wake(pylon.node);
    let result: T;
    try {
      result = await act(probe, pylon.pylonId);
    } catch (err) {
      // A delete or archive that landed meanwhile stopped the pylon, so the thread's state answers, not the node's failure.
      refuseClosed(registry.thread(t.id)!);
      const code = (err as Partial<ProbeError>).code;
      if (code === "not-running") throw new HttpError(409, `pylon ${pylon.pylonId} is not running yet. This request wakes it, so ask again once it runs`);
      if (code === "unreachable") throw new HttpError(503, (err as Error).message);
      if (err instanceof CheckoutRefused) throw new HttpError(refusalStatus[err.kind], err.message);
      throw err;
    }
    // A delete that landed meanwhile may have released the pylon's ports already.
    if (registry.thread(t.id)!.status === "deleted") throw new HttpError(409, `thread ${t.id} is deleted`);
    return result;
  }

  function refuseClosed(t: Thread) {
    if (t.status === "deleted" || t.status === "archived") throw new HttpError(409, `thread ${t.id} is ${t.status}, so its pylon stays paused`);
  }

  async function pylonCommand<K extends "link-port" | "unlink-port" | "open-session" | "close-session" | "drop-failed-session">(t: Thread, command: Extract<PylonCommand, { kind: K }>): Promise<Extract<CommandResult, { kind: K }>> {
    // The client checks that the result is the command's kind.
    return await inPylon(t, (probe, pylonId) => probe.command(pylonId, command)) as Extract<CommandResult, { kind: K }>;
  }

  /** Reads the pylon's checkout for the Files and Changes views, over one raw pipe per read. */
  async function inCheckout<T>(t: Thread, read: (checkout: CheckoutReader) => Promise<T>): Promise<T> {
    const turn = t.conversationId === null ? registry.latestClaudeTurn(t.id) : await harness.latestTurn(t.id);
    return inPylon(t, (probe, pylonId) => read(checkoutReader((argv) => probe.stream(pylonId, argv), checkoutDir, undefined, turn)));
  }

  async function checkoutFile(t: Thread, path: string): Promise<Reply> {
    const content = await inCheckout(t, (c) => c.read(path));
    return { status: 200, file: content, type: contentType(path, content) };
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

  /**
   * Closes a session by its ID. A paused one is refused without waking its pylon, since the wake brings it back and
   * it closes once it runs. A failed one in no pane is forgotten, so no wake tries it again. Any other ID is a pane,
   * perhaps one opened a moment ago that no observation lists yet. A pane that is not open, or that runs another
   * session than the one listed there, is a 404, never a success: a caller may hold a pane from before a wake that
   * brought its session back in another one, and gave this one to another session.
   */
  async function closeSession(t: Thread, id: string): Promise<void> {
    const session = registry.session(t.pylonId, id);
    if (session?.state === "paused" && t.status !== "deleted") {
      const resumes = t.status === "archived" ? `when \`nexus unarchive ${t.id}\` wakes its pylon` : "when its pylon wakes";
      throw new HttpError(409, `session ${id} is paused with its pylon and resumes ${resumes}. Close it once it runs`);
    }
    if (session?.state === "failed" && session.herdrPane === null) {
      const { dropped } = await pylonCommand(t, { kind: "drop-failed-session", id });
      if (!dropped) throw new HttpError(404, `pylon ${t.pylonId} holds no failed session ${id}`);
      return;
    }
    const listed = session === undefined ? {} : { session: { harness: session.harness, harnessSessionId: session.harnessSessionId, title: session.title } };
    const { outcome } = await pylonCommand(t, { kind: "close-session", herdrPane: id, ...listed });
    if (outcome === "not-open") throw new HttpError(404, `no session is open in pane ${id} of pylon ${t.pylonId}. A wake may have moved it to another pane, which the thread's sessions list`);
    if (outcome === "moved") throw new HttpError(404, `pane ${id} of pylon ${t.pylonId} runs another session now, so it was left open. A wake moved session ${id} to another pane, which the thread's sessions list`);
  }

  /** What a thread page shows: a Claude worker's transcript as last read, or the harness conversation's view. */
  async function conversation(t: Thread): Promise<ConversationView | ClaudeConversation> {
    if (isClaude(t)) return claude.view(t);
    const watch = await harness.watch(t.id);
    try {
      return watch.value;
    } finally {
      await watch.stop();
    }
  }

  function recordImage(body: unknown): ImageManifest {
    const manifest: ImageManifest = parse(imageSchema, body);
    registry.saveImage(manifest, null);
    return manifest;
  }

  /** An image becomes what every new pylon boots, so building and rolling one out takes the same right as `nexus deploy`. */
  function imageRollout(caller: TailnetNodeId): ImageRollout {
    if (!canDeploy(registry, options.deployment, caller)) throw new HttpError(403, "caller may not build, roll out or roll back an image: only deployers may, never infrastructure nodes or pylons");
    if (options.images === undefined) throw new HttpError(409, "image builds are not configured");
    return options.images;
  }
  const started = (operation: ImageOperation): Reply => ({ status: operation.state === "running" ? 202 : 200, body: operation });
  function usageBackfill(): UsageBackfillJob {
    if (options.usageBackfill === undefined) throw new HttpError(409, "the usage backfill is not configured");
    return options.usageBackfill;
  }
  /** The backfill wakes archived threads' pylons, so starting or stopping it takes the same right as `nexus deploy`. */
  function steerUsageBackfill(caller: TailnetNodeId): UsageBackfillJob {
    if (!canDeploy(registry, options.deployment, caller)) throw new HttpError(403, "caller may not start or stop the usage backfill: only deployers may, never infrastructure nodes or pylons");
    return usageBackfill();
  }

  /** A file is served as its bytes, everything else as JSON. */
  type Reply =
    | { status: number; body?: unknown; file?: never; stream?: never }
    | { status: number; file: Buffer; type: string; stream?: never }
    | { stream(res: ServerResponse): Promise<void> | void; status?: never; file?: never };
  type Route = (match: RegExpExecArray, req: { query: URLSearchParams; body(empty?: unknown): Promise<unknown>; caller: TailnetNodeId }) => Reply | Promise<Reply>;
  const ok = (body: unknown): Reply => ({ status: 200, body });
  const created = (body: unknown): Reply => ({ status: 201, body });
  const noContent: Reply = { status: 204 };

  const draining = () => isDraining(registry.drain());
  const turnRequests = turnGate(draining);
  async function turnsRunning(): Promise<boolean> {
    if (turnRequests.busy() || options.turnsStarting?.()) return true;
    for (const t of registry.threads()) {
      if (t.status === "deleted" || t.conversationId === null) continue;
      const watch = await harness.watch(t.id);
      try {
        const live = watch.value.docs["pi.live"];
        const inbox = watch.value.docs["pi.inbox"];
        if (live?.run !== undefined || (Array.isArray(inbox?.items) && inbox.items.length > 0)) return true;
      } finally { await watch.stop(); }
    }
    return turnRequests.busy() || (options.turnsStarting?.() ?? false);
  }

  const routes: readonly [string, RegExp, Route][] = [
    ["GET", /^\/v1\/health$/, () => ok(health())],
    ["GET", /^\/v1\/release$/, () => ok(releaseView(registry, options.deployment?.self))],
    ["PUT", /^\/v1\/release$/, async (_, r) => {
      if (!canDeploy(registry, options.deployment, r.caller)) throw new HttpError(403, "caller may not deploy; infrastructure nodes and pylons cannot deploy");
      const input = parse(z.strictObject({ commit: z.union([z.literal("main"), commitSchema]) }), await r.body());
      const commit = input.commit === "main" ? await (options.deployment?.resolveMain ?? resolveMain)() : input.commit;
      if (draining()) throw new HttpError(409, "control plane is draining; wait for this deployment to finish");
      registry.setDesiredRelease({ commit: commitSchema.parse(commit), requestedBy: r.caller, requestedAt: Date.now() });
      return ok(releaseView(registry, options.deployment?.self));
    }],
    // admit lets only a node with its deployer key reach these.
    ["GET", /^\/v1\/deployer\/release$/, () => ok(releaseView(registry, options.deployment?.self))],
    ["POST", /^\/v1\/deployer\/report$/, async (_, r) => {
      const node = registry.nodes().find((n) => n.tailnetNodeId === r.caller)!;
      const report = parse(reportSchema, await r.body());
      if (report.role === "control" && r.caller !== options.deployment?.self) throw new HttpError(403, "only the control node reports control health");
      registry.reportRelease({ ...report, node: node.name, observedAt: Date.now() });
      return ok({ ok: true });
    }],
    ["POST", /^\/v1\/deployer\/drain$/, async (_, r) => {
      if (r.caller !== options.deployment?.self) throw new HttpError(403, "only the control node drains");
      const body = parse(z.strictObject({ commit: commitSchema, release: z.boolean().optional(), hold: z.boolean().optional() }), await r.body());
      if (body.commit !== registry.desiredRelease()?.commit) throw new HttpError(409, "release was superseded");
      registry.setDrain(body.release ? null : { commit: body.commit, expiresAt: Date.now() + 120_000, locked: registry.drain()?.locked ?? false });
      const idle = body.release ? false : !await turnsRunning();
      if (body.hold && idle) registry.setDrain({ commit: body.commit, expiresAt: Date.now() + 120_000, locked: true });
      return ok({ idle, expiresAt: registry.drain()?.expiresAt ?? null });
    }],
    ["GET", /^\/v1\/events$/, (_, r) => {
      const since = r.query.get("since") ?? "0";
      try { eventCursor(since); } catch { throw new HttpError(400, "invalid event cursor"); }
      const kinds = r.query.getAll("kind");
      if (kinds.some((k) => !(eventKinds as readonly string[]).includes(k))) throw new HttpError(400, "unknown event kind");
      const filter: EventFilter = { kinds, ...(r.query.has("thread") ? { thread: r.query.get("thread")! } : {}), ...(r.query.has("project") ? { project: r.query.get("project")! } : {}) };
      const read = (from: string) => {
        try { return registry.eventBatch(from, filter); }
        catch (err) { throw new HttpError(409, (err as Error).message); }
      };
      const first = read(since);
      if (r.query.get("follow") !== "true") return ok(first.events);
      return { stream: (res) => followEvents(res, first, read) };
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/events$/, ([, id]) => {
      const t = thread(id!);
      return { stream: (res) => stream(res, conversing(t), () => harness.watch(t.id), viewFrames()) };
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/claude\/events$/, ([, id]) => {
      const t = thread(id!);
      return { stream: (res) => stream(res, claudeWorker(t), () => claude.watch(t), claudeFrames()) };
    }],
    ["GET", /^\/threads\/([^/]+)\/stream$/, ([, id]) => {
      const t = thread(id!);
      return { stream: (res) => isClaude(t)
        ? stream<ClaudeConversation>(res, refuseDeleted(t), () => claude.watch(t), liveFrames(t, registry.claudeWorker(t.id)?.model ?? null))
        : stream<ConversationView>(res, conversing(t), () => harness.watch(t.id), liveFrames(t)) };
    }],
    ["PATCH", /^\/v1\/projects\/([^/]+)$/, async ([, id], r) => {
      const { autoReview, ...patch } = parse(projectEditSchema, await r.body());
      if (autoReview?.land) mayLand(r.caller);
      const project = registry.editProject(id as ProjectId, ({ autoReview: kept, ...previous }) => {
        const updated: Project = parse(projectSchema, { ...previous, ...patch, resources: { ...previous.resources, ...patch.resources } });
        refuseUnknownNode(updated);
        const review = autoReview === undefined ? kept : autoReview === null ? null : { land: autoReview.land, enabledBy: r.caller };
        return review == null ? updated : { ...updated, autoReview: review };
      });
      if (project === undefined) throw new HttpError(404, `no project ${id}`);
      return ok(project);
    }],
    ["GET", /^\/v1\/usage$/, (_, r) => ok(registry.usageReport(usageFilter(r.query, Date.now())))],
    ["GET", /^\/v1\/usage\/backfill$/, () => ok({ backfill: usageBackfill().status(), plan: usageBackfill().plan() })],
    ["POST", /^\/v1\/usage\/backfill$/, (_, r) => ok(steerUsageBackfill(r.caller).start())],
    ["DELETE", /^\/v1\/usage\/backfill$/, (_, r) => ok(steerUsageBackfill(r.caller).stop())],
    ["GET", /^\/v1\/projects$/, () => ok(registry.projects())],
    ["POST", /^\/v1\/projects$/, async (_, r) => created(createProject(await r.body()))],
    ["GET", /^\/v1\/nodes$/, () => ok(registry.nodes().map((record): NodeSummary => {
      const { observation, ...n } = record;
      return { ...n, observedAt: observation?.observedAt ?? null, overcommitted: overcommitted(n.capacity), pylons: nodePylons(registry, record) };
    }))],
    ["GET", /^\/v1\/threads$/, (_, r) => {
      const threads = registry.threads((r.query.get("project") ?? undefined) as ProjectId | undefined);
      return ok((r.query.get("deleted") === "false" ? threads.filter((t) => t.status !== "deleted") : threads).map(row));
    }],
    ["POST", /^\/v1\/threads$/, async (_, r) => {
      const { after, message, ...request } = parse(startSchema, await r.body());
      if (request.model !== undefined && request.claude === undefined) throw new HttpError(400, "model requires claude");
      if (after === undefined) {
        if (message !== undefined) throw new HttpError(400, "message is only for a queued start; send it with POST /v1/threads/<id>/messages");
        return created(await startThread(request, r.caller));
      }
      const queue = queueOrRefuse();
      const record = queue.add(request, message ?? null, after, r.caller);
      void queue.poll();
      return created(queuedView(registry, record));
    }],
    ["GET", /^\/v1\/queued$/, (_, r) => {
      const project = r.query.get("project");
      return ok(registry.queuedThreads().filter((q) => q.status !== "started" && (project === null || q.project === project)).map((q) => queuedView(registry, q)));
    }],
    ["GET", /^\/v1\/queued\/([^/]+)$/, (m) => {
      const queued = queuedRecord(m[1]!);
      if (queued === undefined) throw new HttpError(404, `no queued thread ${m[1]!}`);
      return ok(queuedView(registry, queued));
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/start$/, async (m, r) => created(await queueOrRefuse().startNow(m[1]! as ThreadId, r.caller))],
    ["GET", /^\/v1\/threads\/([^/]+)$/, (m) => ok(detail(thread(m[1]!)))],
    ["DELETE", /^\/v1\/threads\/([^/]+)$/, async (m) => ok(queuedRecord(m[1]!) === undefined ? await setStatus(thread(m[1]!), "deleted") : queuedStatus(m[1]!, "deleted"))],
    ["POST", /^\/v1\/threads\/([^/]+)\/(seen|unseen)$/, async (m, r) => {
      const t = thread(m[1]!);
      const body = parse(seenSchema, await r.body({}));
      registry.markSeen(t.id, m[2] === "unseen", Date.now(), body.lastReplyAt);
      return noContent;
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/archive$/, async (m) => ok(queuedRecord(m[1]!) === undefined ? await setStatus(thread(m[1]!), "archived") : queuedStatus(m[1]!, "archived"))],
    ["POST", /^\/v1\/threads\/([^/]+)\/unarchive$/, (m) => ok(queuedRecord(m[1]!) === undefined ? unarchive(thread(m[1]!)) : queuedStatus(m[1]!, "queued"))],
    ["POST", /^\/v1\/threads\/([^/]+)\/activity$/, async (m, r) => { recordActivity(thread(m[1]!), await r.body()); return noContent; }],
    // The body first, so the thread's status is read after the last await before the message is submitted.
    ["POST", /^\/v1\/threads\/([^/]+)\/messages$/, async (m, r) => {
      const body = await r.body();
      const t = thread(m[1]!);
      const worker = registry.claudeWorker(t.id);
      if (worker === undefined) return { status: 202, body: await sendMessage(runnable(t), body) };
      if (t.status === "archived") throw new HttpError(409, `thread ${t.id} is archived`);
      return { status: 202, body: await sendClaude(refuseDeleted(t), worker.session, worker.model, body) };
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/review$/, async (m, r) => {
      const body = parse(reviewSchema, await r.body({}));
      const t = thread(m[1]!);
      if (body.land) mayLand(r.caller);
      return created(await reviewsOrRefuse().start(t.id, { pr: body.pr, rounds: body.rounds, land: body.land ? r.caller : null }));
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/land$/, async (m, r) => {
      const body = parse(landSchema, await r.body({}));
      const t = thread(m[1]!);
      mayLand(r.caller);
      return ok(reviewsOrRefuse().land(t.id, r.caller, body.head, body.waive));
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
    ["DELETE", /^\/v1\/threads\/([^/]+)\/sessions\/([^/]+)$/, async (m) => {
      await closeSession(thread(m[1]!), m[2]!);
      return noContent;
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/files$/, async (m, r) => {
      const path = parse(checkoutPath, r.query.get("path") ?? "");
      return ok(await inCheckout(thread(m[1]!), (c) => c.list(path)));
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/files\/content$/, async (m, r) => checkoutFile(thread(m[1]!), parse(checkoutPath.min(1), r.query.get("path") ?? ""))],
    ["GET", /^\/v1\/threads\/([^/]+)\/changes$/, async (m, r) => {
      const base = parse(changesBaseSchema, r.query.get("base") ?? undefined);
      return ok(await inCheckout(thread(m[1]!), (c) => c.changes(base)));
    }],
    // Each `path` is a pathspec, so a renamed file needs its old path too.
    ["GET", /^\/v1\/threads\/([^/]+)\/diff$/, async (m, r) => {
      const base = parse(changesBaseSchema, r.query.get("base") ?? undefined);
      const paths = parse(diffPaths, r.query.getAll("path"));
      return ok(await inCheckout(thread(m[1]!), (c) => c.diff(base, paths)));
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/conversation$/, async (m) => {
      const t = thread(m[1]!);
      if (!isClaude(t)) return ok(await conversation(conversing(t)));
      await Promise.race([claude.refresh(refuseDeleted(t)), sleep(claudeReadMs, undefined, { ref: false })]);
      return ok(claude.view(t));
    }],
    ["GET", /^\/v1\/images$/, () => ok(imagesView(registry))],
    ["POST", /^\/v1\/images$/, async (_, r) => created(recordImage(await r.body()))],
    ["GET", /^\/v1\/images\/current$/, () => {
      const view = imagesView(registry);
      const entry = (id: ImageId | null) => view.images.find((image) => image.id === id) ?? null;
      return ok({ current: entry(view.current), previous: entry(view.previous) });
    }],
    ["POST", /^\/v1\/images\/build$/, async (_, r) => {
      const images = imageRollout(r.caller);
      parse(noFields, await r.body({}));
      return started(await images.build(r.caller));
    }],
    ["POST", /^\/v1\/images\/rollout$/, async (_, r) => {
      const images = imageRollout(r.caller);
      return started(images.rollout(parse(rolloutSchema, await r.body()).image, r.caller));
    }],
    ["POST", /^\/v1\/images\/rollback$/, async (_, r) => {
      const images = imageRollout(r.caller);
      parse(noFields, await r.body({}));
      return started(images.rollback(r.caller));
    }],
  ];

  const httpsState: { status: "disabled" | "waiting" | "ready" | "degraded"; error: string | null; nextAttemptAt: number | null } = {
    status: options.https ? "waiting" : "disabled", error: null, nextAttemptAt: null,
  };
  const health = () => ({ commit: runningCommit, https: { ...httpsState } });

  /** The caller, once it is allowed and asked under one of the API's names. Every request and upgrade passes here. */
  async function admit(req: IncomingMessage): Promise<TailnetNodeId> {
    const { remoteAddress, remotePort } = req.socket;
    const caller = remoteAddress === undefined || remotePort === undefined ? null : await whois(remoteAddress, remotePort);
    const workerRoute = decodeURIComponent(new URL(req.url ?? "/", "http://nexus").pathname).startsWith("/v1/deployer/");
    if (caller === null || (workerRoute
      ? !isReporter(registry, options.deployment, caller, req.headers.authorization)
      : !allowed.has(caller))) throw new HttpError(403, "caller is not a tailnet node this control plane allows");
    // whois names the machine, not the program, so a web page open on an allowed laptop is that laptop too.
    // It can neither send a JSON content type cross-origin without a preflight, which this API never answers,
    // nor reach the API under its own name.
    const host = req.headers.host;
    const hostname = typeof host === "string" ? new URL(`http://${host}`).hostname : undefined;
    if (hostname === undefined || !hostnames.has(hostname)) throw new HttpError(403, `the API does not answer to host ${req.headers.host}`);
    return caller;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/v1/health" && req.socket.remoteAddress !== undefined && req.socket.remoteAddress === req.socket.localAddress) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(health()));
      return;
    }
    const caller = await admit(req);
    if (req.method !== "GET" && req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      throw new HttpError(415, "requests that change state must have content-type application/json");
    }

    const url = new URL(req.url ?? "/", "http://nexus");
    const path = decodeURIComponent(url.pathname);
    const view = req.method === "GET" ? await page(path, url.searchParams, caller) : undefined;
    if (view !== undefined) return void res.writeHead(view.status, view.headers).end(view.body);
    const matches = routes.flatMap(([method, pattern, route]) => {
      const m = pattern.exec(path);
      return m === null ? [] : [{ method, m, route }];
    });
    if (matches.length === 0) throw new HttpError(404, path.startsWith("/v1/deployer/") ? `no deployer route ${path}` : `no route ${path}`);
    const match = matches.find((r) => r.method === req.method);
    if (match === undefined) throw new HttpError(405, `${req.method} is not allowed on ${path}`);
    const startsTurn = req.method === "POST" && (path === "/v1/threads" || /^\/v1\/threads\/[^/]+\/(messages|retry|start)$/.test(path));
    const route = () => match.route(match.m, { query: url.searchParams, caller, body: (empty) => readJson(req, empty) });
    const reply = startsTurn ? await turnRequests.run(async () => route()) : await route();
    if (reply.stream !== undefined) return reply.stream(res);
    if (reply.file !== undefined) sendFile(res, reply.file, reply.type);
    else if (reply.body === undefined) res.writeHead(reply.status).end();
    else send(res, reply.status, reply.body);
  }

  /** The pylon of a thread, as serveAttach asks for it. */
  function door(t: Thread, probe: Pick<ProbeClient, "stream">): PylonDoor {
    const { pylonId, node } = registry.pylon(t.pylonId)!;
    return {
      thread: t.id,
      look() {
        const now = registry.thread(t.id)!;
        if (now.status !== "active") return { kind: "over", error: { kind: "conflict", message: `thread ${t.id} is ${now.status}, so its pylon stays paused` } };
        const pylon = pylonOf(now);
        if (pylon.actualState === "failed") return { kind: "over", error: { kind: "failed", message: `the pylon of ${t.id} failed: ${pylon.failed ?? "no reason given"}` } };
        return { kind: "pylon", state: pylon.actualState };
      },
      open({ size, term }) {
        registry.recordActivity(t.id, { human: Date.now() });
        wake(node);
        return openTerminal((argv) => probe.stream(pylonId, argv), size, term, ["sh", "-c", attachScript]);
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
    await admit(req);
    if (stopping) throw new HttpError(503, "the control plane is stopping");
    // CORS does not guard a WebSocket handshake, and previews are served under the API's hostname on other ports, so
    // a preview's page could open a terminal from the browser of anyone allowed. A browser always sends Origin.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `${req.socket instanceof TLSSocket ? "https" : "http"}://${req.headers.host}`) throw new HttpError(403, `the attach route does not answer pages from ${origin}`);
    const t = thread(attachRoute.exec(pathOf(req.url))![1]!);
    let request: ReturnType<typeof parseAttachQuery>;
    try {
      request = parseAttachQuery(new URL(req.url ?? "/", "http://nexus").searchParams);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    if (t.status !== "active") throw new HttpError(409, `thread ${t.id} is ${t.status}, so its pylon stays paused`);
    const { node } = registry.pylon(t.pylonId)!;
    const probe = probes.get(node);
    if (probe === undefined) throw new HttpError(503, `no probe is configured for ${node}`);
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
      const session = { end: (why: Ending) => stop.abort(why), served: serveAttach(ws, door(t, probe), request, stop.signal, timing) };
      attached.add(session);
      await session.served.finally(() => attached.delete(session));
    } finally {
      open.delete(handle);
    }
  }

  function makeServer(certificate?: Certificate) {
    const serverOptions = {
      // Only a WebSocket to the attach route upgrades. Any other request is handled as one, Upgrade header or not.
      shouldUpgradeCallback: (req: IncomingMessage) => req.headers.upgrade?.toLowerCase() === "websocket" && attachRoute.test(pathOf(req.url)),
    };
    const server = certificate ? createHttpsServer({ ...serverOptions, ...certificate }) : createServer(serverOptions);
    server.on("request", (req, res) => {
      handle(req, res).catch((err: unknown) => {
        if (res.headersSent) return res.destroy(err as Error);
        send(res, errorStatus(err), { error: (err as Error).message });
      });
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Node hands over an upgraded socket without its error handler, and a reset before the 101 would crash the API.
      socket.on("error", () => undefined);
      upgraded.add(socket);
      socket.once("close", () => upgraded.delete(socket));
      upgrade(req, socket, head).catch((err: unknown) => refuseUpgrade(socket, errorStatus(err), (err as Error).message));
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

const holdsSchema = z.array(z.string().min(1).max(4_000)).min(1).max(20);
/** A waiver names the commit the person saw, so a review that moved on is not landed past holds they did not see. */
const landSchema = z.strictObject({ head: commitSchema.optional(), waive: holdsSchema.optional() })
  .refine((b) => b.waive === undefined || b.head !== undefined, "a waiver needs the head it confirmed");

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
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
function sendFile(res: ServerResponse, content: Buffer, type: string) {
  res.writeHead(200, {
    "content-type": type, "content-length": content.length, "cache-control": "no-store",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
  }).end(content);
}

/** The path a request's URL names, decoded as `handle` matches it, or "" for one that cannot be decoded. */
function pathOf(url: string | undefined): string {
  try {
    return decodeURIComponent(new URL(url ?? "/", "http://nexus").pathname);
  } catch {
    return "";
  }
}

const errorStatus = (err: unknown) => err instanceof HttpError ? err.status : err instanceof DeployDraining ? 409 : err instanceof BodyTooLarge ? 413 : 500;

/** An API error reply written on a socket that never upgraded. */
function refuseUpgrade(socket: Duplex, status: number, message: string) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}
