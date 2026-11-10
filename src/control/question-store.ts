/**
 * A write recomputes a thread's attention, in its transaction. Its participant tells the thread core of an open
 * question, drops a closed thread's asks, withdraws an archived thread's open failure questions, and runs
 * `reconcileAsks` when a Claude worker, its transcript or its thread's status changes.
 */
import { json, jsonOrNull, type Db, type Holding } from "./db.ts";
import type { NodeName, ThreadId } from "../ids.ts";
import { isOpenStatus, type ThreadStatus } from "./reconcile.ts";
import { askQuestionId, askRecord, isOpen, type CleanupQuestion, type HoldsQuestion, type Question, type QuestionOf, type ThreadQuestion, type Unanswered, type WaitingAsk } from "./questions.ts";
import type { DeleteOutcome } from "../protocol/cleanup.ts";
import type { Need } from "./attention.ts";

export const holding = { tables: { questions: { record: "id", purge: "thread = $thread" }, waiting_asks: { purge: "thread = $thread" } } } as const satisfies Holding;

/** isOpen, as SQL. */
const openWhere = "json_extract(record, '$.answer') IS NULL AND json_extract(record, '$.withdrawn') IS NULL";

export function questionStore(db: Db, clock: () => number, threadStatus: (id: ThreadId) => ThreadStatus | undefined, updateAttention: (thread: ThreadId) => void) {
  const { transaction, sql } = db;
  const questions = db.hold(holding).records<Question>("questions");
  function questionRecord(id: string): Question | null {
    return questions.get(id);
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
    changes += Number(sql(`DELETE FROM questions WHERE thread = ? AND json_extract(record, '$.kind') = 'ask' AND ${openWhere}
      AND id NOT IN (SELECT value FROM json_each(?))`).run(thread, JSON.stringify(open.map((q) => q.id))).changes);
    return changes > 0;
  }

  const needs = (thread: ThreadId): Need[] => sql(`SELECT record FROM questions WHERE thread = ? AND ${openWhere}
    ORDER BY json_extract(record, '$.askedAt'), rowid`).all(thread).map((r) => { const question = json<ThreadQuestion>(r.record); return { kind: "question", question, since: question.askedAt }; });
  /** An archived thread's failure needs nothing more from the person, so its open question is withdrawn and kept. */
  function closed(thread: ThreadId) {
    sql("DELETE FROM waiting_asks WHERE thread = ?").run(thread);
    if (threadStatus(thread) !== "archived") return;
    sql(`UPDATE questions SET record = json_set(record, '$.withdrawn', json(?)) WHERE thread = ? AND json_extract(record, '$.kind') = 'judgment' AND ${openWhere}`).run(JSON.stringify({ by: "archive", at: clock() }), thread);
  }

  /** An open question still waits for the person's answer. */
  const keeps = (threads: ReadonlyMap<ThreadId, unknown>): ReadonlyMap<ThreadId, string> => new Map(sql(`SELECT thread, id FROM questions
    WHERE thread IN (SELECT value FROM json_each(?)) AND ${openWhere} ORDER BY rowid DESC`).all(JSON.stringify([...threads.keys()])).map((r) => [r.thread as ThreadId, `its question ${r.id as string} is open`]));

  return {
    participant: { needs, closed, reconcile: reconcileAsks, keeps },
    /** Stores the question unless one with its ID exists, and answers the stored one either way. */
    askQuestion<Q extends Unanswered>(question: Q): QuestionOf<Q["kind"]> {
      return transaction(() => {
        const subject = question.kind === "cleanup" ? { thread: null, node: question.node } : { thread: question.thread, node: null };
        sql("INSERT OR IGNORE INTO questions (id, thread, node, record) VALUES (?, ?, ?, ?)").run(question.id, subject.thread, subject.node, JSON.stringify({ ...question, answer: null }));
        if (subject.thread !== null) updateAttention(subject.thread);
        // Asking again under an ID answers the stored question, which is of the same kind, since the ID names it.
        return questionRecord(question.id)! as QuestionOf<Q["kind"]>;
      });
    },
    /**
     * Asks `question` in place of each of the thread's unanswered questions whose ID starts with `prefix`, or with null
     * drops them all, so an answer to one the asker replaced finds no question. Answers whether anything changed.
     */
    replaceQuestions(thread: ThreadId, prefix: string, question: Unanswered<HoldsQuestion> | null): boolean {
      return transaction(() => {
        let changes = Number(sql(`DELETE FROM questions WHERE thread = ? AND substr(id, 1, ?) = ? AND id IS NOT ? AND ${openWhere}`)
          .run(thread, prefix.length, prefix, question?.id ?? null).changes);
        if (question !== null) changes += Number(sql("INSERT OR IGNORE INTO questions (id, thread, record) VALUES (?, ?, ?)").run(question.id, thread, JSON.stringify({ ...question, answer: null })).changes);
        if (changes > 0) updateAttention(thread);
        return changes > 0;
      });
    },
    /** The threads with an open question whose ID starts with `prefix`. */
    threadsAsking: (prefix: string): ThreadId[] => sql(`SELECT DISTINCT thread FROM questions WHERE thread IS NOT NULL AND substr(id, 1, ?) = ? AND ${openWhere}`).all(prefix.length, prefix).map((r) => r.thread as ThreadId),
    question: (id: string): Question | null => questionRecord(id),
    /**
     * Stores the asks the thread's pylon reports waiting, in place of its last report, and asks or withdraws its Claude
     * worker's questions to match. An archived or deleted thread's pylon is paused, so its report is dropped. Answers
     * whether a question was asked or withdrawn.
     */
    setWaitingAsks(thread: ThreadId, asks: readonly WaitingAsk[]): boolean {
      return transaction(() => {
        const status = threadStatus(thread);
        if (!isOpenStatus(status)) return false;
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
    nodeQuestions: (node: NodeName): CleanupQuestion[] => sql("SELECT record FROM questions WHERE node = ? ORDER BY json_extract(record, '$.askedAt'), rowid").all(node).map((r) => json<CleanupQuestion>(r.record)),
    /** Every node's open questions, which wait on the person as a thread's do. */
    openNodeQuestions: (): CleanupQuestion[] => sql(`SELECT record FROM questions WHERE node IS NOT NULL AND ${openWhere} ORDER BY json_extract(record, '$.askedAt'), rowid`).all().map((r) => json<CleanupQuestion>(r.record)),
    /** Records what each delete of an answered cleanup did, beside what earlier deletes reported. The first report of an item stands. */
    recordCleanup(id: string, outcomes: Readonly<Record<string, DeleteOutcome>>): CleanupQuestion {
      return transaction(() => {
        const stored = questionRecord(id);
        if (stored?.kind !== "cleanup") throw new Error(`no node question ${id}`);
        const recorded = { ...stored, cleanup: { ...stored.cleanup, outcomes: { ...outcomes, ...stored.cleanup.outcomes } } };
        sql("UPDATE questions SET record = ? WHERE id = ?").run(JSON.stringify(recorded), id);
        return recorded;
      });
    },
    /**
     * Records the answer to an open question. An answered one keeps its first answer, and a withdrawn one stays
     * unanswered, as this returns. `then` runs in the same transaction once the answer is recorded, and a throw from it
     * records nothing.
     */
    answerQuestion<Q extends Question>(question: Q, answer: NonNullable<Question["answer"]>, then?: (answered: Q) => void): Q {
      return transaction(() => {
        // An ID's question keeps its kind, so the stored one is of the kind of the one the caller read.
        const stored = questionRecord(question.id) as Q | null;
        if (stored === null) throw new Error(`no question ${question.id}`);
        if (!isOpen(stored)) return stored;
        const answered = { ...stored, answer };
        sql("UPDATE questions SET record = ? WHERE id = ?").run(JSON.stringify(answered), question.id);
        then?.(answered);
        if (answered.kind !== "cleanup") updateAttention(answered.thread);
        return answered;
      });
    },
  };
}
