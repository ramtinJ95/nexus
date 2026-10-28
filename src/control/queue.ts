/**
 * Queued threads: a thread recorded now, with everything its start needs, that starts once each thread it is queued
 * after has merged its pull request, whether the review loop landed it or someone merged it outside the loop.
 *
 * A queued thread has no `threads` row, so the planner, PR watch, the review loop and placement never see it. Its
 * record keeps the ID the thread gets, and the transaction that inserts the thread's row marks the record started,
 * so it starts once whatever crashes, restarts or concurrent passes come between. What blocks it is derived on every
 * pass and read rather than stored, so a reopened or later-merged pull request unblocks it.
 */
import { defaultClaudeModel } from "../claude-state.ts";
import type { BootInputs, ProjectId } from "../project.ts";
import { checkCaller } from "./gate.ts";
import { HttpError } from "./http-error.ts";
import type { Registry, StartKey, Thread, ThreadId } from "./registry.ts";
import { checkStart, newThreadId, type StartRequest } from "./threads.ts";

/** What the queue keeps of a thread until it starts. `request` is frozen when queued, its resources filled field by field from the project's. A request that names no node starts on the project's default when it starts, as any start does. */
export interface QueuedRecord {
  id: ThreadId;
  title: string;
  project: ProjectId;
  startedBy: string;
  createdAt: number;
  after: readonly ThreadId[];
  request: StartRequest & { resources: BootInputs["resources"] };
  /** A harness thread's first message, sent as the person's once it starts. Null for a Claude worker, whose prompt is request.claude. */
  message: string | null;
  status: "queued" | "archived" | "deleted" | "started";
  /** `nexus start-queued`: start without waiting for the predecessors. */
  startNow: { by: string; at: number } | null;
  /** Why the latest start attempt failed, such as no node with room or a deploy drain. Cleared by the start. */
  lastError: string | null;
  startedAt: number | null;
  firstMessage: "pending" | "sent" | null;
}

/** What one predecessor means for the queued thread. */
export interface Wait { thread: ThreadId; state: "waiting" | "landed" | "blocked"; why: string }

/** The API's view of a thread that has not started, which `show` and `threads --queued` print. */
export interface QueuedThread {
  id: ThreadId;
  title: string;
  project: ProjectId;
  startedBy: string;
  createdAt: number;
  /** Archived means cancelled. */
  status: "queued" | "archived" | "deleted";
  after: readonly ThreadId[];
  /** One per predecessor, in `after` order. */
  waits: readonly Wait[];
  /** Some wait is blocked. */
  blocked: boolean;
  /** A node, or "auto". */
  node: string;
  worker: "harness" | "claude";
  model: string | null;
  /** The first message, or the Claude prompt as given, without the `/poteto-mode` a start puts in front. */
  prompt: string | null;
  branch: string | null;
  commit: string | null;
  resources: BootInputs["resources"];
  startNow: { by: string; at: number } | null;
  lastError: string | null;
}

export interface ThreadQueue {
  /** Validates and records, with `key` if given; throws HttpError. Does not start it; the route calls poll() after. */
  add(request: StartRequest, message: string | null, after: readonly string[], caller: string, key?: StartKey): QueuedRecord;
  /**
   * Records startNow, then starts it now and returns the thread, or throws the start's error. The thread then stays
   * queued with startNow, so a later pass starts it once there is room.
   */
  startNow(id: ThreadId, caller: string): Promise<Thread>;
  /** archive: queued to archived. unarchive: archived to queued. delete: any but deleted to deleted. 404 for none, 409 for a move its status refuses. */
  setStatus(id: ThreadId, status: "archived" | "queued" | "deleted"): QueuedRecord;
  poll(): Promise<void>;
  close(): Promise<void>;
}

const waiting = (thread: ThreadId, why: string): Wait => ({ thread, state: "waiting", why });
const landed = (thread: ThreadId, why: string): Wait => ({ thread, state: "landed", why });
const blocked = (thread: ThreadId, why: string): Wait => ({ thread, state: "blocked", why });

/**
 * A merge wins over an archive, so a predecessor archived after its pull request merged still landed. A review that
 * saw its PR merged outside it counts as the merge it is.
 */
export function waitOf(registry: Registry, id: ThreadId): Wait {
  const t = registry.thread(id);
  if (t === undefined) {
    switch (registry.queuedThread(id)?.status) {
      case "queued": return waiting(id, "is queued");
      case "archived": return blocked(id, "was cancelled while queued");
      case "deleted": return blocked(id, "was deleted while queued");
      default: return blocked(id, "does not exist");
    }
  }
  const review = registry.review(id);
  if (review !== null && (review.merged !== null || review.phase.kind === "merged")) return landed(id, `PR #${review.pr.number} merged`);
  const links = registry.prWatch(id)?.links.map((l) => l.pr) ?? [];
  const merged = links.find((pr) => pr.state === "merged");
  const open = links.find((pr) => pr.state === "open");
  if (merged !== undefined && open === undefined) return landed(id, `PR #${merged.number} merged`);
  if (t.status === "archived" || t.status === "deleted") return blocked(id, `is ${t.status} and its pull request did not merge`);
  if (review?.phase.kind === "needs-person") return blocked(id, `its review ended for the person: ${review.phase.reasons[0] ?? "no reason given"}`);
  if (links.length > 0 && links.every((pr) => pr.state === "closed")) return blocked(id, `PR #${links.at(-1)!.number} closed without merging`);
  return open !== undefined ? waiting(id, `PR #${open.number} is open`) : waiting(id, "has no pull request yet");
}

export function queuedView(registry: Registry, record: QueuedRecord): QueuedThread {
  if (record.status === "started") throw new Error(`thread ${record.id} has started, so it is no longer queued`);
  const { request } = record;
  const waits = record.after.map((id) => waitOf(registry, id));
  const claude = request.claude !== undefined;
  return {
    id: record.id, title: record.title, project: record.project, startedBy: record.startedBy, createdAt: record.createdAt, status: record.status,
    after: record.after, waits, blocked: waits.some((w) => w.state === "blocked"), node: request.node ?? registry.project(record.project)?.defaultNode ?? "auto",
    worker: claude ? "claude" : "harness", model: claude ? request.model ?? defaultClaudeModel : null,
    prompt: record.message ?? request.claude ?? null, branch: request.branch ?? null, commit: request.commit ?? null,
    resources: request.resources, startNow: record.startNow, lastError: record.lastError,
  };
}

const statusName = (status: QueuedRecord["status"]) => status === "archived" ? "cancelled" : status;

export function threadQueue(options: {
  registry: Registry;
  startThread: (request: StartRequest, caller: string, id?: ThreadId) => Promise<Thread>;
  /** A human message, the harness's followUp. A repeated request ID answers with the first submission. */
  send: (thread: ThreadId, text: string, requestId: string) => Promise<unknown>;
  /** The drain gate, which refuses a start while a deploy drains and counts one in flight as a turn starting. */
  gate: { run<T>(action: () => Promise<T>): Promise<T> };
  log?: (message: string) => void;
}): ThreadQueue {
  const { registry, startThread, send, gate, log = () => {} } = options;
  const starting = new Map<ThreadId, Promise<Thread>>();
  let running: Promise<void> | null = null;

  function queued(id: ThreadId): QueuedRecord {
    const record = registry.queuedThread(id);
    if (record === undefined) throw new HttpError(404, `no queued thread ${id}`);
    if (record.status === "started") throw new HttpError(409, `thread ${id} has started, so it is no longer queued`);
    return record;
  }

  /** An archived or deleted thread gets its first message once it is unarchived, or never. */
  async function deliver(id: ThreadId) {
    const record = registry.queuedThread(id);
    if (record?.status !== "started" || record.firstMessage !== "pending" || record.message === null) return;
    const t = registry.thread(id);
    if (t === undefined || t.status === "archived" || t.status === "deleted") return;
    await send(id, record.message, `queued:${id}`);
    registry.saveQueued({ ...registry.queuedThread(id)!, firstMessage: "sent" });
  }

  async function attempt(id: ThreadId): Promise<Thread> {
    const record = registry.queuedThread(id);
    if (record?.status !== "queued") throw new HttpError(409, `thread ${id} is no longer queued`);
    let t: Thread;
    try {
      t = await gate.run(() => startThread(record.request, record.startedBy, id));
    } catch (err) {
      const message = (err as Error).message;
      const now = registry.queuedThread(id);
      if (now?.status !== "queued") throw err instanceof HttpError ? err : new HttpError(409, message);
      if (now.lastError !== message) log(`queued thread ${id} did not start: ${message}`);
      registry.saveQueued({ ...now, lastError: message });
      throw err;
    }
    await deliver(id).catch((err: unknown) => log(`queued thread ${id} started, but its first message was not sent yet: ${(err as Error).message}`));
    return t;
  }

  /** A start in flight is shared, so two passes and a start-queued start the thread once. */
  function start(id: ThreadId): Promise<Thread> {
    let pending = starting.get(id);
    if (pending === undefined) {
      pending = attempt(id).finally(() => starting.delete(id));
      starting.set(id, pending);
    }
    return pending;
  }

  async function pass() {
    for (const record of registry.queuedThreads()) {
      if (record.status === "started") {
        await deliver(record.id).catch((err: unknown) => log(`queued thread ${record.id} started, but its first message was not sent yet: ${(err as Error).message}`));
      } else if (record.status === "queued" && (record.startNow !== null || record.after.every((id) => waitOf(registry, id).state === "landed"))) {
        // attempt records and logs why, and the next pass tries again.
        await start(record.id).catch(() => {});
      }
    }
  }

  return {
    add(request, message, after, caller, key) {
      if (message !== null && request.claude !== undefined) throw new HttpError(400, "message is for a Nexus agent thread. A Claude worker's first prompt is its claude");
      const project = checkStart(registry, request);
      const ids = [...new Set(after)] as ThreadId[];
      if (ids.length === 0) throw new HttpError(400, "after names no thread");
      for (const id of ids) {
        const t = registry.thread(id);
        if (t === undefined && registry.queuedThread(id) === undefined) throw new HttpError(404, `no thread ${id}`);
        if (t !== undefined && (registry.isReviewer(id) || t.startedBy === checkCaller)) throw new HttpError(400, `thread ${id} is a review loop's reviewer or check thread, which merges no pull request of its own`);
      }
      const size = request.resources ?? {};
      const record: QueuedRecord = {
        id: newThreadId(), title: request.title, project: project.id, startedBy: caller, createdAt: Date.now(), after: ids,
        request: {
          ...request,
          resources: { cpus: size.cpus ?? project.resources.cpus, memoryGiB: size.memoryGiB ?? project.resources.memoryGiB, diskGiB: size.diskGiB ?? project.resources.diskGiB },
        },
        message, status: "queued", startNow: null, lastError: null, startedAt: null, firstMessage: null,
      };
      registry.saveQueued(record, key);
      return record;
    },
    async startNow(id, caller) {
      const record = queued(id);
      if (record.status !== "queued") throw new HttpError(409, `thread ${id} is ${statusName(record.status)}, not queued`);
      if (record.startNow === null) registry.saveQueued({ ...record, startNow: { by: caller, at: Date.now() } });
      return start(id);
    },
    setStatus(id, status) {
      const record = queued(id);
      const allowed = status === "archived" ? record.status === "queued" : status === "queued" ? record.status === "archived" : record.status !== "deleted";
      if (!allowed) throw new HttpError(409, status === "queued" ? `thread ${id} is ${statusName(record.status)}, not cancelled` : `thread ${id} is ${statusName(record.status)}`);
      const next = { ...record, status };
      registry.saveQueued(next);
      return next;
    },
    poll(): Promise<void> {
      if (running === null) running = pass().finally(() => { running = null; });
      return running;
    },
    async close() {
      await running;
      await Promise.allSettled([...starting.values()]);
    },
  };
}
