/**
 * Queued threads: a thread recorded now, with everything its start needs, that starts once each thread it is queued
 * after has merged its pull request, whether the review loop landed it or someone merged it outside the loop. One
 * queued after no thread, as a pipeline item with no item ahead of it is, starts on the next pass.
 *
 * A queued thread has no `threads` row, so the planner, PR watch, the review loop and placement never see it. Its
 * record keeps the ID the thread gets, and the transaction that inserts the thread's row marks the record started,
 * so it starts once whatever crashes, restarts or concurrent passes come between. What blocks it is derived on every
 * pass and read rather than stored, so a reopened or later-merged pull request unblocks it.
 */
import { defaultClaudeModel } from "../protocol/models.ts";
import { newThreadId, requestIds, type ProjectId, type ThreadId } from "../ids.ts";
import { singleFlight } from "../single-flight.ts";
import { Refusal } from "./refusal.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import { checkStart, resourcesOf } from "./threads.ts";
import type { StartKey, StartRequest } from "./start-request.ts";
import type { QueuedRecord } from "./queue-store.ts";
import type { QueuedThread, Wait } from "../contract/threads.ts";
import { sendWithStandingRules } from "./standing-rules.ts";
import { deliverDurable } from "./durable-message.ts";
import { prLocationOf, servesReview, threadRole } from "./work-model.ts";
import { brokenRule, startRules } from "../contract/threads-parse.ts";
import { isOpenStatus } from "./reconcile.ts";

type QueueRegistry = Pick<Registry, "createThread" | "currentImage" | "isReviewer" | "latestHealthSample" | "node" | "nodes" | "planning" | "prWatch" | "project" | "pylonsWithStatusOn" | "pylonsWithThreadsOn" | "queuedThread" | "queuedThreads" | "reserve" | "reserved" | "review" | "saveQueued" | "saveTemplate" | "templates" | "thread">;

export interface ThreadQueue {
  /** Validates and records, with `key` if given; throws a Refusal. Does not start it; the caller calls poll() after. */
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

/** A merge wins over an archive, so a predecessor archived after its pull request merged still landed. */
export function waitOf(registry: QueueRegistry, id: ThreadId): Wait {
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
  const where = prLocationOf(registry, id);
  if (where.kind === "merged") return landed(id, `PR #${where.number} merged`);
  if (!isOpenStatus(t.status)) return blocked(id, `is ${t.status} and its pull request did not merge`);
  if (review?.phase.kind === "needs-person") return blocked(id, `its review ended for the person: ${review.phase.holds[0]?.text ?? "no reason given"}`);
  if (where.kind === "closed") return blocked(id, `PR #${where.number} closed without merging`);
  return where.kind === "open" ? waiting(id, `PR #${where.number} is open`) : waiting(id, "has no pull request yet");
}

export function queuedView(registry: QueueRegistry, record: QueuedRecord): QueuedThread {
  if (record.status === "started") throw new Error(`thread ${record.id} has started, so it is no longer queued`);
  const { request } = record;
  const waits = record.after.map((id) => waitOf(registry, id));
  const claude = request.claude !== undefined;
  return {
    id: record.id, title: record.title, project: record.project, startedBy: record.startedBy, createdAt: record.createdAt, status: record.status,
    after: record.after, waits, blocked: record.refused !== undefined || waits.some((w) => w.state === "blocked"), node: request.node ?? registry.project(record.project)?.defaultNode ?? "auto",
    worker: claude ? "claude" : "harness", model: claude ? request.model ?? defaultClaudeModel : null,
    prompt: record.message ?? request.claude ?? null, branch: request.branch ?? null, commit: request.commit ?? null,
    resources: request.resources, startNow: record.startNow, lastError: record.lastError,
  };
}

const statusName = (status: QueuedRecord["status"]) => status === "archived" ? "cancelled" : status;

/** How long a pass leaves a refused start before it reads the branch again. */
export const refusedRetryMs = 10 * 60_000;

export function threadQueue(options: {
  registry: QueueRegistry & Pick<Registry, "standingRulesCarried" | "standingRulesOf">;
  startThread: (request: StartRequest, caller: string, id?: ThreadId) => Promise<Thread>;
  /** A human message, the harness's followUp. A repeated request ID answers with the first submission. */
  send: (thread: ThreadId, text: string, requestId: string) => Promise<unknown>;
  /** The drain gate, which refuses a start while a deploy drains and counts one in flight as a turn starting. */
  gate: { run<T>(action: () => Promise<T>): Promise<T> };
  log?: (message: string) => void;
}): ThreadQueue {
  const { registry, startThread, send, gate, log = () => {} } = options;
  const starting = new Map<ThreadId, Promise<Thread>>();

  function queued(id: ThreadId): QueuedRecord {
    const record = registry.queuedThread(id);
    if (record === undefined) throw new Refusal("missing", `no queued thread ${id}`);
    if (record.status === "started") throw new Refusal("conflict", `thread ${id} has started, so it is no longer queued`);
    return record;
  }

  /** An archived or deleted thread gets its first message once it is unarchived, or never. */
  async function deliver(id: ThreadId) {
    const record = registry.queuedThread(id);
    if (record?.status !== "started" || record.firstMessage !== "pending" || record.message === null) return;
    const t = registry.thread(id);
    if (!isOpenStatus(t?.status)) return;
    await deliverDurable({ id: requestIds.queued(id), text: record.message }, async (m) => {
      await sendWithStandingRules(registry, id, m.id, m.text, (text) => send(id, text, m.id));
      return "delivered";
    }, () => registry.saveQueued({ ...registry.queuedThread(id)!, firstMessage: "sent" }));
  }

  async function attempt(id: ThreadId): Promise<Thread> {
    const record = registry.queuedThread(id);
    if (record?.status !== "queued") throw new Refusal("conflict", `thread ${id} is no longer queued`);
    let t: Thread;
    try {
      t = await gate.run(() => startThread(record.request, record.startedBy, id));
    } catch (err) {
      const message = (err as Error).message;
      const now = registry.queuedThread(id);
      if (now?.status !== "queued") throw err instanceof Refusal ? err : new Refusal("conflict", message);
      if (now.lastError !== message) log(`queued thread ${id} did not start: ${message}`);
      const { refused: _, ...rest } = now;
      registry.saveQueued({ ...rest, lastError: message, ...err instanceof Refusal && (err.code === "no-branch" || err.code === "too-long") ? { refused: { at: Date.now() } } : {} });
      throw err;
    }
    await deliver(id).catch((err: unknown) => log(`queued thread ${id} started, but its first message was not sent yet: ${(err as Error).message}`));
    const revision = registry.thread(id)?.standingRulesRevision;
    return revision === undefined ? t : { ...t, standingRulesRevision: revision };
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
      } else if (record.status === "queued" && (record.refused === undefined || Date.now() - record.refused.at >= refusedRetryMs)
        && (record.startNow !== null || record.after.every((id) => waitOf(registry, id).state === "landed"))) {
        // attempt records and logs why, and the next pass tries again.
        await start(record.id).catch(() => {});
      }
    }
  }

  const passes = singleFlight(pass);
  return {
    add(request, message, after, caller, key) {
      const broken = brokenRule(startRules, { ...request, message });
      if (broken !== undefined) throw new Refusal("invalid", broken);
      const project = checkStart(registry, request, caller);
      const ids = [...new Set(after)] as ThreadId[];
      for (const id of ids) {
        const t = registry.thread(id);
        if (t === undefined && registry.queuedThread(id) === undefined) throw new Refusal("missing", `no thread ${id}`);
        if (t !== undefined && servesReview(threadRole(registry, t))) throw new Refusal("invalid", `thread ${id} is a review loop's reviewer, check or verify thread, which merges no pull request of its own`);
      }
      const record: QueuedRecord = {
        id: newThreadId(), title: request.title, project: project.id, startedBy: caller, createdAt: Date.now(), after: ids,
        request: { ...request, resources: resourcesOf(request.resources, project) },
        message, status: "queued", startNow: null, lastError: null, startedAt: null, firstMessage: null,
      };
      registry.saveQueued(record, key);
      return record;
    },
    async startNow(id, caller) {
      const record = queued(id);
      if (record.status !== "queued") throw new Refusal("conflict", `thread ${id} is ${statusName(record.status)}, not queued`);
      if (record.startNow === null) registry.saveQueued({ ...record, startNow: { by: caller, at: Date.now() } });
      return start(id);
    },
    setStatus(id, status) {
      const record = queued(id);
      const allowed = status === "archived" ? record.status === "queued" : status === "queued" ? record.status === "archived" : record.status !== "deleted";
      if (!allowed) throw new Refusal("conflict", status === "queued" ? `thread ${id} is ${statusName(record.status)}, not cancelled` : `thread ${id} is ${statusName(record.status)}`);
      const next = { ...record, status };
      registry.saveQueued(next);
      return next;
    },
    poll: passes.join,
    async close() {
      await passes.settled();
      await Promise.allSettled([...starting.values()]);
    },
  };
}
