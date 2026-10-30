/**
 * The planning store: each planning thread's record, in `planning_threads`. The registry composes it, so its
 * members are the registry's.
 */
import { json, type Db } from "./db.ts";
import type { ThreadId } from "../ids.ts";

export interface PlanningRecord {
  thread: ThreadId;
  /** The token a block must echo. Only the thread is told it, so a block quoted from elsewhere is never read. */
  token: string;
  /** The thread's lastReplyAt when its replies were last read through. */
  read: number;
  /**
   * Each message composed for the thread, by request ID: whether it carries the guide, the answered proposals it tells
   * of, and whether the harness took it. Only a taken message counts as telling, so one that failed is told again.
   */
  sent: readonly { requestId: string; guide: boolean; told: readonly string[]; delivered: boolean }[];
}

export type PlanningStore = ReturnType<typeof planningStore>;

export function planningStore(db: Db) {
  const { sql, recordOf, saveRecord } = db;
  return {
    planning: (thread: ThreadId): PlanningRecord | null => recordOf<PlanningRecord>("planning_threads", "thread", thread),
    planningThreads: (): PlanningRecord[] => sql("SELECT record FROM planning_threads ORDER BY rowid").all().map((r) => json<PlanningRecord>(r.record)),
    savePlanning(record: PlanningRecord) {
      saveRecord("planning_threads", "thread", record.thread, record);
    },
  };
}
