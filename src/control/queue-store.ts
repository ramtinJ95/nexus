/**
 * The queue store: each queued thread's record, in `queued_threads`. A save with a start's key stores the key,
 * in its transaction.
 */
import { json, type Db } from "./db.ts";
import type { ProjectId, ThreadId } from "../ids.ts";
import type { BootInputs } from "../spawn.ts";
import type { StartKey, StartRequest } from "./start-request.ts";

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

export type QueueStore = ReturnType<typeof queueStore>;

export function queueStore(db: Db, saveStartKey: (key: StartKey, thread: ThreadId) => void) {
  const { transaction, sql, recordOf, saveRecord } = db;
  const queuedThread = (id: ThreadId): QueuedRecord | undefined => recordOf<QueuedRecord>("queued_threads", "id", id) ?? undefined;

  function saveQueued(record: QueuedRecord, key?: StartKey) {
    transaction(() => {
      saveRecord("queued_threads", "id", record.id, record);
      if (key !== undefined) saveStartKey(key, record.id);
    });
  }

  return {
    queuedThreads: (): QueuedRecord[] => sql("SELECT record FROM queued_threads ORDER BY rowid").all().map((r) => json<QueuedRecord>(r.record)),
    queuedThread,
    saveQueued,
  };
}
