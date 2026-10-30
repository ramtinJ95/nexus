/**
 * The review store: each builder's review, in `reviews`, and every pull request a review started for, in
 * `reviewed_prs`. A save archives the threads it names, appends its events and recomputes the builder's attention,
 * in its transaction.
 */
import { json, type Db } from "./db.ts";
import type { ThreadId } from "../ids.ts";
import type { ThreadStatus } from "../reconcile.ts";
import type { EventKind } from "../events.ts";
import { reviewerCaller } from "../agent-protocol.ts";
import { needsPerson, storedReview, type Review } from "./review-model.ts";

export type ReviewStore = ReturnType<typeof reviewStore>;

export function reviewStore(db: Db, core: { setThreadStatus: (id: ThreadId, status: ThreadStatus) => void; appendEvent: (kind: EventKind, thread: ThreadId, payload: Record<string, unknown>) => unknown; updateAttention: (thread: ThreadId) => void }) {
  const { transaction, sql, recordOf } = db;
  const { setThreadStatus, appendEvent, updateAttention } = core;
  const storedReviewOf = (builder: ThreadId): Review | null => {
    const record = recordOf<Review>("reviews", "builder", builder);
    return record === null ? null : storedReview(record);
  };
  const isCurrentReview = (review: Review) => JSON.stringify(storedReviewOf(review.builder)) === JSON.stringify(review);
  return {
    participant: { needsPerson: (thread: ThreadId) => needsPerson(recordOf<Review>("reviews", "builder", thread)) },
    review: storedReviewOf,
    /** Whether `review` is the builder's review as stored, so no other save came since it was read. */
    isCurrentReview,
    reviews: (): Review[] => sql("SELECT record FROM reviews ORDER BY builder").all().map((r) => storedReview(json<Review>(r.record))),
    /** The reviews but those whose phase is one of `settled` with no message left to send. */
    reviewsToStep: (settled: readonly string[]): Review[] => sql(`SELECT record FROM reviews WHERE json_extract(record, '$.phase.kind') NOT IN (SELECT value FROM json_each(?))
      OR json_extract(record, '$.outbox') IS NOT NULL ORDER BY builder`).all(JSON.stringify(settled)).map((r) => storedReview(json<Review>(r.record))),
    /** A thread a review started, whether or not a later review replaced the record that names it. */
    isReviewer: (thread: ThreadId) => sql("SELECT 1 FROM threads WHERE id = ? AND started_by = ? UNION SELECT 1 FROM reviews WHERE reviewer = ?").get(thread, reviewerCaller, thread) !== undefined,
    /** Whether a review ever started for the pull request, including one a later review of its builder replaced. */
    prReviewed: (repo: string, number: number) => sql("SELECT 1 FROM reviewed_prs WHERE repo = ? AND number = ?").get(repo, number) !== undefined,
    /**
     * Replaces the builder's review, and tells the event log when its phase, round or label changed, or the person waived
     * holds. The threads in `archive` are archived in the same transaction. Given `previous`, the review as it was read,
     * false, with nothing written, when the stored review is no longer that: another save came first.
     */
    saveReview(review: Review, archive: readonly ThreadId[] = [], previous?: Review): boolean {
      return transaction(() => {
        if (previous !== undefined && !isCurrentReview(previous)) return false;
        const before = storedReviewOf(review.builder);
        for (const id of archive) setThreadStatus(id, "archived");
        sql("INSERT INTO reviews (builder, reviewer, record) VALUES (?, ?, ?) ON CONFLICT (builder) DO UPDATE SET reviewer = excluded.reviewer, record = excluded.record")
          .run(review.builder, review.reviewer, JSON.stringify(review));
        sql("INSERT OR IGNORE INTO reviewed_prs (repo, number) VALUES (?, ?)").run(review.pr.repo, review.pr.number);
        const label = (r: Review | null) => r?.phase.kind === "needs-person" ? r.phase.label?.state : undefined;
        if (before?.id !== review.id || before.phase.kind !== review.phase.kind || before.rounds.length !== review.rounds.length || label(before) !== label(review)) {
          appendEvent("review.changed", review.builder, { review: review.id, reviewer: review.reviewer, phase: review.phase, round: review.rounds.length });
        }
        if (review.waiver != null && JSON.stringify(before?.waiver ?? null) !== JSON.stringify(review.waiver)) {
          appendEvent("review.waived", review.builder, { review: review.id, repo: review.pr.repo, pr: review.pr.number, ...review.waiver });
        }
        updateAttention(review.builder);
        return true;
      });
    },
  };
}
