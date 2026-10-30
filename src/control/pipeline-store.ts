/**
 * The pipeline store: each pipeline item's record, in `pipeline_items`. An item's phase is derived, so it is
 * not stored.
 */
import { json, type Db } from "./db.ts";
import type { ProjectId } from "../ids.ts";
import type { StartRequest } from "./start-request.ts";

declare const brand: unique symbol;
export type ItemId = string & { readonly [brand]: "ItemId" };

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

export type PipelineStore = ReturnType<typeof pipelineStore>;

export function pipelineStore(db: Db) {
  const { sql, recordOf, saveRecord } = db;
  return {
    items: (): ItemRecord[] => sql("SELECT record FROM pipeline_items ORDER BY rowid").all().map((r) => json<ItemRecord>(r.record)),
    item: (id: ItemId): ItemRecord | undefined => recordOf<ItemRecord>("pipeline_items", "id", id) ?? undefined,
    saveItem(record: ItemRecord) { saveRecord("pipeline_items", "id", record.id, record); },
  };
}
