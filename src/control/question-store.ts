/**
 * The question store: each question asked about a thread or a node, in `questions`, and the asks each thread's pylon
 * last reported waiting, in `waiting_asks`. A write recomputes a thread's attention, in its transaction. Its
 * participant tells the thread core of an unanswered question, drops a closed thread's asks, and runs `reconcileAsks`
 * when a Claude worker, its transcript or its thread's status changes.
 */
import { json, jsonOrNull, type Db } from "./db.ts";
import type { NodeName, ThreadId } from "../ids.ts";
import type { ThreadStatus } from "../reconcile.ts";
import { askQuestionId, askRecord, isNodeQuestion, type NodeQuestion, type Question, type ThreadQuestion, type Unanswered, type WaitingAsk } from "./questions.ts";
import type { DeleteOutcome } from "../protocol/cleanup.ts";

export type QuestionStore = ReturnType<typeof questionStore>;

export function questionStore(db: Db, threadStatus: (id: ThreadId) => ThreadStatus | undefined, updateAttention: (thread: ThreadId) => void) {
  const { transaction, sql, recordOf } = db;
  function questionRecord(id: string): Question | null {
    return recordOf<Question>("questions", "id", id);
  }

  function waitingAsks(thread: ThreadId): WaitingAsk[] {
    return jsonOrNull<WaitingAsk[]>(sql("SELECT report FROM waiting_asks WHERE thread = ?").get(thread)?.report ?? null) ?? [];
  }

  /**
   * Asks a question for each ask the thread's pylon last reported waiting for its Claude worker's current session, and
   * withdraws each unanswered ask that is not one. The transcript only closes one, once it holds the call's result,
   * since Claude may write the call itself only once the dialog is answered. Other sessions' asks, such as the
   * person's own Claude's in the pylon, ask nothing. Answers whether it asked or withdrew any.
   */
  function reconcileAsks(thread: ThreadId): boolean {
    const session = sql("SELECT session FROM claude_workers WHERE thread = ?").get(thread)?.session;
    const answered = sql("SELECT 1 FROM claude_entries WHERE thread = ? AND json_extract(entry, '$.kind') = 'result' AND json_extract(entry, '$.toolUseId') = ?");
    const open = waitingAsks(thread).filter(({ ask }) => ask.session === session && answered.get(thread, ask.toolUseId) === undefined).map(({ ask, at }) => askRecord(thread, ask, at));
    let changes = 0;
    for (const question of open) {
      changes += Number(sql("INSERT OR IGNORE INTO questions (id, thread, record) VALUES (?, ?, ?)").run(question.id, thread, JSON.stringify({ ...question, answer: null })).changes);
    }
    changes += Number(sql(`DELETE FROM questions WHERE thread = ? AND json_extract(record, '$.ask') IS NOT NULL AND json_extract(record, '$.answer') IS NULL
      AND id NOT IN (SELECT value FROM json_each(?))`).run(thread, JSON.stringify(open.map((q) => q.id))).changes);
    return changes > 0;
  }

  const needsPerson = (thread: ThreadId) => sql("SELECT 1 FROM questions WHERE thread = ? AND json_extract(record, '$.answer') IS NULL").get(thread) !== undefined;
  const closed = (thread: ThreadId) => { sql("DELETE FROM waiting_asks WHERE thread = ?").run(thread); };

  return {
    participant: { needsPerson, closed, reconcile: reconcileAsks },
    /** Stores the question unless one with its ID exists, and answers the stored one either way. */
    askQuestion<Q extends Unanswered>(question: Q): Q extends Omit<NodeQuestion, "answer"> ? NodeQuestion : ThreadQuestion {
      return transaction(() => {
        sql("INSERT OR IGNORE INTO questions (id, thread, node, record) VALUES (?, ?, ?, ?)").run(question.id, question.thread ?? null, question.node ?? null, JSON.stringify({ ...question, answer: null }));
        if (question.thread !== undefined) updateAttention(question.thread);
        return questionRecord(question.id)! as never;
      });
    },
    question: (id: string): Question | null => questionRecord(id),
    /**
     * Stores the asks the thread's pylon reports waiting, in place of its last report, and asks or withdraws its Claude
     * worker's questions to match. An archived or deleted thread's pylon is paused, so its report is dropped. Answers
     * whether a question was asked or withdrawn.
     */
    setWaitingAsks(thread: ThreadId, asks: readonly WaitingAsk[]): boolean {
      return transaction(() => {
        const status = threadStatus(thread);
        if (status === undefined || status === "archived" || status === "deleted") return false;
        sql("INSERT INTO waiting_asks (thread, report) VALUES (?, ?) ON CONFLICT (thread) DO UPDATE SET report = excluded.report").run(thread, JSON.stringify(asks));
        const changed = reconcileAsks(thread);
        updateAttention(thread);
        return changed;
      });
    },
    /**
     * Withdraws an ask whose dialog no hook waits on any more, such as one its terminal answered, and drops it from the
     * stored report, so nothing before the pylon's next report asks it again. An answered one stays.
     */
    withdrawAsk(id: string) {
      transaction(() => {
        const thread = sql("SELECT thread FROM questions WHERE id = ?").get(id)?.thread as ThreadId | undefined;
        if (thread === undefined) return;
        const report = waitingAsks(thread).filter(({ ask }) => askQuestionId(ask.toolUseId) !== id);
        sql("UPDATE waiting_asks SET report = ? WHERE thread = ?").run(JSON.stringify(report), thread);
        reconcileAsks(thread);
        updateAttention(thread);
      });
    },
    questions: (thread: ThreadId): ThreadQuestion[] => sql("SELECT record FROM questions WHERE thread = ? ORDER BY json_extract(record, '$.askedAt'), rowid").all(thread).map((r) => json<ThreadQuestion>(r.record)),
    /** The node's questions, in the order they were asked. */
    nodeQuestions: (node: NodeName): NodeQuestion[] => sql("SELECT record FROM questions WHERE node = ? ORDER BY json_extract(record, '$.askedAt'), rowid").all(node).map((r) => json<NodeQuestion>(r.record)),
    /** Every node's open questions, which wait on the person as a thread's do. */
    openNodeQuestions: (): NodeQuestion[] => sql("SELECT record FROM questions WHERE node IS NOT NULL AND json_extract(record, '$.answer') IS NULL ORDER BY json_extract(record, '$.askedAt'), rowid").all().map((r) => json<NodeQuestion>(r.record)),
    /** Withdraws an open node question that a later one replaces. An answered one stays, with its answer. */
    withdrawNodeQuestion(id: string) { sql("DELETE FROM questions WHERE id = ? AND node IS NOT NULL AND json_extract(record, '$.answer') IS NULL").run(id); },
    /** Records what each delete of an answered cleanup did, beside what earlier deletes reported. The first report of an item stands. */
    recordCleanup(id: string, outcomes: Readonly<Record<string, DeleteOutcome>>): NodeQuestion {
      return transaction(() => {
        const stored = questionRecord(id);
        if (stored === null || !isNodeQuestion(stored)) throw new Error(`no node question ${id}`);
        const recorded = { ...stored, cleanup: { ...stored.cleanup, outcomes: { ...outcomes, ...stored.cleanup.outcomes } } };
        sql("UPDATE questions SET record = ? WHERE id = ?").run(JSON.stringify(recorded), id);
        return recorded;
      });
    },
    /**
     * Records the answer to an open question. An answered one keeps its first answer, which this returns. `then` runs
     * in the same transaction once the answer is recorded, and a throw from it records nothing.
     */
    answerQuestion(id: string, answer: NonNullable<Question["answer"]>, then?: (answered: Question) => void): Question {
      return transaction(() => {
        const stored = questionRecord(id);
        if (stored === null) throw new Error(`no question ${id}`);
        if (stored.answer !== null) return stored;
        const answered = { ...stored, answer };
        sql("UPDATE questions SET record = ? WHERE id = ?").run(JSON.stringify(answered), id);
        then?.(answered);
        if (answered.thread !== undefined) updateAttention(answered.thread);
        return answered;
      });
    },
  };
}
