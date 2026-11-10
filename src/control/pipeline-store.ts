/** An item's phase is derived, so it is not stored. */
import { json, type Db, type Holding } from "./db.ts";
import { requestIds, type ItemId, type ProjectId, type ThreadId } from "../ids.ts";
import type { StartRequest } from "./start-request.ts";

export interface ItemRecord {
  id: ItemId;
  project: ProjectId;
  title: string;
  /** What its queued thread starts with, as checked when the item was added. */
  request: StartRequest;
  /** A harness builder's brief, sent as the person's first message. Null for a Claude worker, whose brief is request.claude. */
  message: string | null;
  /** Items of the same project whose threads must merge their pull requests first. Each was added before this one. */
  after: readonly ItemId[];
  addedBy: string;
  addedAt: number;
  /** The person's go-ahead, which an item needs only in a project whose pipeline waits for one. */
  approved: { by: string; at: number } | null;
  /** Cancelled before it became a thread. A queued thread is cancelled by archiving it, as any queued thread is. */
  cancelled: { by: string; at: number } | null;
  /** Why the pass could not queue it last time. Cleared once it is queued. */
  lastError: string | null;
}

export const holding = { tables: { pipeline_items: { record: "id" } } } as const satisfies Holding;

/** `startRequest` is the thread store's, which finds the thread an item became by the item's request ID. */
export function pipelineStore(db: Db, startRequest: (requestId: string) => { thread: ThreadId } | undefined) {
  const { sql } = db;
  const items = db.hold(holding).records<ItemRecord>("pipeline_items");
  const all = (): ItemRecord[] => sql("SELECT record FROM pipeline_items ORDER BY rowid").all().map((r) => json<ItemRecord>(r.record));
  const threadOf = (id: ItemId) => startRequest(requestIds.pipeline(id))?.thread;
  return {
    participant: {
      /** An item not queued yet is queued after the threads of the items it is after, which its queued thread then reads. */
      keeps(threads: ReadonlyMap<ThreadId, unknown>): ReadonlyMap<ThreadId, string> {
        return new Map(all().flatMap((item): [ThreadId, string][] => item.cancelled !== null || threadOf(item.id) !== undefined ? []
          : item.after.flatMap((id): [ThreadId, string][] => {
            const thread = threadOf(id);
            return thread !== undefined && threads.has(thread) ? [[thread, `pipeline item ${item.id}, not queued yet, comes after it`]] : [];
          })));
      },
    },
    items: all,
    item: (id: ItemId): ItemRecord | undefined => items.get(id) ?? undefined,
    saveItem(record: ItemRecord) { items.save(record.id, record); },
  };
}
