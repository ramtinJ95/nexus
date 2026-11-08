import { json, type Db, type Holding } from "./db.ts";
import type { NodeName, ThreadId } from "../ids.ts";

export const answers = ["retry", "retry-elsewhere", "person"] as const;
export type Answer = typeof answers[number];

/** What was decided and by whom: the judgment's answer, or the control plane's own rule when no judgment ran or its answer could not stand. */
export interface Verdict { answer: Answer; why: string; by: "judgment" | "control plane" }

/** What Nexus did, on the verdict or on the person's answer to the question. */
export type Outcome =
  | { kind: "retried"; node: NodeName; on: "verdict" | "answer" }
  | { kind: "moved"; from: NodeName; to: NodeName; on: "verdict" | "answer" }
  /** Nothing, for `why`. */
  | { kind: "left"; why: string };

export type Phase =
  /** The brief is saved, and once it is sent the answer is due at `deadline`. */
  | { kind: "judging"; deadline: number | null }
  /** Saved before the control plane acts, so a pass after a crash acts again. Each action converges. */
  | { kind: "acting"; verdict: Verdict }
  /** The person decides on question `judgment:<failure>`. */
  | { kind: "asked"; verdict: Verdict }
  | { kind: "done"; verdict: Verdict; outcome: Outcome };

export interface Judgment {
  /** The thread.failed event of the failure. */
  failure: number;
  thread: ThreadId;
  /** Where the pylon failed. */
  node: NodeName;
  /** The failure's reason as the registry held it. */
  failed: string;
  startedAt: number;
  /** What the judgment was asked and the token its answer echoes. Null when the control plane decided without one. */
  request: { brief: string; token: string } | null;
  /** The judgment's conversation, null until it is created. */
  conversation: number | null;
  /** The judgment's reply, its last maxReply characters, once read. */
  reply: string | null;
  phase: Phase;
}

export const holding = { tables: { judgments: { record: "failure" }, judgment_since: {} } } as const satisfies Holding;

export function judgmentStore(db: Db) {
  const { transaction, sql } = db;
  const judgments = db.hold(holding).records<Judgment>("judgments");
  return {
    judgment: (failure: number): Judgment | null => judgments.get(failure),
    /** The thread's judgments, oldest failure first. */
    judgments: (thread: ThreadId): Judgment[] => sql("SELECT record FROM judgments WHERE thread = ? ORDER BY failure").all(thread).map((r) => json<Judgment>(r.record)),
    /** Every judgment not done, whatever its thread's status, oldest failure first. */
    unfinishedJudgments: (): Judgment[] => sql("SELECT record FROM judgments WHERE json_extract(record, '$.phase.kind') != 'done' ORDER BY failure").all().map((r) => json<Judgment>(r.record)),
    /**
     * Replaces the judgment as it was read, `previous`, or adds it when that is null, and runs `alongside` in the same
     * transaction. False, with nothing written or run, when the stored record is not `previous`: another pass saved first.
     */
    saveJudgment(next: Judgment, previous: Judgment | null, alongside: () => void = () => {}): boolean {
      return transaction(() => {
        if (!judgments.isCurrent(next.failure, previous)) return false;
        sql("INSERT INTO judgments (failure, thread, record) VALUES (?, ?, ?) ON CONFLICT (failure) DO UPDATE SET record = excluded.record").run(next.failure, next.thread, JSON.stringify(next));
        alongside();
        return true;
      });
    },
    /** The newest event when judgments began. No failure at or below it is judged. */
    judgmentSince: (): number => sql("SELECT event FROM judgment_since").get()!.event as number,
  };
}
