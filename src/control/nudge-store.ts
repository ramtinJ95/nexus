/**
 * The nudge store: each builder's nudge record, in `nudges`. A save recomputes the thread's attention, in its
 * transaction.
 */
import type { Db } from "./db.ts";
import type { ThreadId } from "../ids.ts";

export type Nudge =
  /** `turn` is the end (the thread's lastReplyAt) of the stalled turn the latest nudge answered; `count` nudges in a row. */
  | { state: "nudged"; turn: number; count: number }
  /**
   * The nudge that makes `count` for the turn that ended at `turn`, saved before it is sent. A crash after the send
   * may let the thread end another turn first, so the next pass finishes this one under its own request ID.
   */
  | { state: "sending"; turn: number; count: number }
  /** The turn after the last nudge stalled too, so the thread waits on the person. */
  | { state: "person"; turn: number }
  /**
   * GitHub found a pull request on the thread's branches after the turn that ended at `turn`, which the PR watch has
   * not linked yet. It may never link one that merged or closed first, so the turn is not searched again.
   */
  | { state: "opened"; turn: number }
  /**
   * The person wrote to the thread after its first reply, which makes it theirs for good. It is kept, since the
   * transcript that showed the message may drop it.
   */
  | { state: "left-alone" };

export type NudgeStore = ReturnType<typeof nudgeStore>;

export function nudgeStore(db: Db, updateAttention: (thread: ThreadId) => void) {
  const { transaction, sql, recordOf, saveRecord } = db;
  return {
    nudge: (thread: ThreadId): Nudge | null => recordOf<Nudge>("nudges", "thread", thread),
    /** The threads with a nudge record that a later pass may still change or clear, which is every one but left-alone. */
    nudgedThreads: (): ThreadId[] => sql("SELECT thread FROM nudges WHERE json_extract(record, '$.state') != 'left-alone' ORDER BY thread").all().map((r) => r.thread as ThreadId),
    /** Replaces the builder's nudge record, or with null deletes it. */
    saveNudge(thread: ThreadId, nudge: Nudge | null) {
      transaction(() => {
        if (nudge === null) sql("DELETE FROM nudges WHERE thread = ?").run(thread);
        else saveRecord("nudges", "thread", thread, nudge);
        updateAttention(thread);
      });
    },
  };
}
