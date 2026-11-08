/** The registry composes it, so its members are the registry's. */
import { json, type Db, type Holding } from "./db.ts";
import type { ThreadId } from "../ids.ts";

interface PlanningRecord {
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

export const holding = { tables: { planning_threads: { record: "thread" } } } as const satisfies Holding;

export function planningStore(db: Db) {
  const { sql } = db;
  const records = db.hold(holding).records<PlanningRecord>("planning_threads");
  return {
    planning: (thread: ThreadId): PlanningRecord | null => records.get(thread),
    planningThreads: (): PlanningRecord[] => sql("SELECT record FROM planning_threads ORDER BY rowid").all().map((r) => json<PlanningRecord>(r.record)),
    savePlanning(record: PlanningRecord) {
      records.save(record.thread, record);
    },
  };
}
