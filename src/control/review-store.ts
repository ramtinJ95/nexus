/**
 * The review store: each builder's review, in `reviews`, and every pull request a review started for, in
 * `reviewed_prs`. A save archives the threads it names, appends its events and recomputes the builder's attention,
 * in its transaction.
 */
import { json, type Db } from "./db.ts";
import type { ThreadId } from "../ids.ts";
import type { ThreadStatus } from "./reconcile.ts";
import type { EventKind } from "../events.ts";
import { reviewerCaller } from "./agent-protocol.ts";
import { builderAwaited, kindsWhere, waitsOnPerson, type Review, type Waiver } from "./review-model.ts";
import { upgradeReview } from "./record-upgrade.ts";

export function reviewStore(db: Db, core: { setThreadStatus: (id: ThreadId, status: ThreadStatus) => void; appendEvent: (kind: EventKind, thread: ThreadId, payload: Record<string, unknown>) => unknown; updateAttention: (thread: ThreadId) => void }) {
  const { transaction, sql, recordOf } = db;
  const { setThreadStatus, appendEvent, updateAttention } = core;
  // Each record an older control plane saved is upgraded once, with no event, so every read below gets this code's shape.
  transaction(() => {
    for (const row of sql("SELECT builder, record FROM reviews").all()) {
      const upgraded = JSON.stringify(upgradeReview(json<Review>(row.record)));
      if (upgraded !== row.record) sql("UPDATE reviews SET record = ? WHERE builder = ?").run(upgraded, row.builder as string);
    }
  });
  const reviewOf = (builder: ThreadId): Review | null => recordOf<Review>("reviews", "builder", builder);
  const awaitedKinds = JSON.stringify(kindsWhere((row) => row.awaitsBuilder !== undefined));
  const settledKinds = JSON.stringify(kindsWhere((row) => row.settled));
  const isCurrentReview = (review: Review) => JSON.stringify(reviewOf(review.builder)) === JSON.stringify(review);
  return {
    participant: {
      needsPerson: (thread: ThreadId) => waitsOnPerson(recordOf<Review>("reviews", "builder", thread)),
      awaited: (threads: readonly ThreadId[]) => new Map(sql(`SELECT record FROM reviews WHERE builder IN (SELECT value FROM json_each(?))
        AND json_extract(record, '$.phase.kind') IN (SELECT value FROM json_each(?))`).all(JSON.stringify(threads), awaitedKinds).map((r) => json<Review>(r.record))
        .flatMap((r) => { const hold = builderAwaited(r); return hold === null ? [] : [[r.builder, hold] as const]; })),
    },
    review: reviewOf,
    /** Whether `review` is the builder's review as stored, so no other save came since it was read. */
    isCurrentReview,
    reviews: (): Review[] => sql("SELECT record FROM reviews ORDER BY builder").all().map((r) => json<Review>(r.record)),
    /** The reviews but those settled with no message left to send. */
    reviewsToStep: (): Review[] => sql(`SELECT record FROM reviews WHERE json_extract(record, '$.phase.kind') NOT IN (SELECT value FROM json_each(?))
      OR json_extract(record, '$.outbox') IS NOT NULL ORDER BY builder`).all(settledKinds).map((r) => json<Review>(r.record)),
    /** A thread a review started, whether or not a later review replaced the record that names it. */
    isReviewer: (thread: ThreadId) => sql("SELECT 1 FROM threads WHERE id = ? AND started_by = ? UNION SELECT 1 FROM reviews WHERE reviewer = ?").get(thread, reviewerCaller, thread) !== undefined,
    /** Whether a review ever started for the pull request, including one a later review of its builder replaced. */
    prReviewed: (repo: string, number: number) => sql("SELECT 1 FROM reviewed_prs WHERE repo = ? AND number = ?").get(repo, number) !== undefined,
    /**
     * Replaces the builder's review, and tells the event log when its phase, round or label changed, the person waived
     * holds, or the reviewer's approval or the person's waiver carried to a later head with the same change. The
     * threads in `archive` are archived in the same transaction. Given `previous`, the review as it was read, false,
     * with nothing written, when the stored review is no longer that: another save came first.
     */
    saveReview(review: Review, archive: readonly ThreadId[] = [], previous?: Review): boolean {
      return transaction(() => {
        if (previous !== undefined && !isCurrentReview(previous)) return false;
        const before = reviewOf(review.builder);
        for (const id of archive) setThreadStatus(id, "archived");
        sql("INSERT INTO reviews (builder, reviewer, record) VALUES (?, ?, ?) ON CONFLICT (builder) DO UPDATE SET reviewer = excluded.reviewer, record = excluded.record")
          .run(review.builder, review.reviewer, JSON.stringify(review));
        sql("INSERT OR IGNORE INTO reviewed_prs (repo, number) VALUES (?, ?)").run(review.pr.repo, review.pr.number);
        const label = (r: Review | null) => r?.phase.kind === "needs-person" ? r.phase.label?.state : undefined;
        if (before?.id !== review.id || before.phase.kind !== review.phase.kind || before.rounds.length !== review.rounds.length || label(before) !== label(review)) {
          appendEvent("review.changed", review.builder, { review: review.id, reviewer: review.reviewer, ...review.second?.kind === "claude" && { second: review.second.thread }, phase: review.phase, round: review.rounds.length });
        }
        const pr = { review: review.id, repo: review.pr.repo, pr: review.pr.number };
        const round = review.rounds.at(-1)!;
        if (before?.id === review.id && before.rounds.length < review.rounds.length && round.carried !== undefined && round.carried.held === undefined) {
          appendEvent("review.approval-carried", review.builder, { ...pr, from: round.carried.from, to: round.head });
        }
        // Reading the change a waiver is for, or carrying it to a later head, is not the person waiving again.
        const pressed = (w: Waiver | null | undefined) => w == null ? null : JSON.stringify({ ...w, head: w.from ?? w.head, change: undefined, from: undefined });
        if (review.waiver !== null && pressed(before?.waiver) !== pressed(review.waiver)) {
          const { change: _, ...waiver } = review.waiver;
          appendEvent("review.waived", review.builder, { ...pr, ...waiver });
        } else if (review.waiver !== null && before?.waiver != null && before.waiver.head !== review.waiver.head) {
          appendEvent("review.waiver-carried", review.builder, { ...pr, from: before.waiver.head, to: review.waiver.head, by: review.waiver.by });
        }
        updateAttention(review.builder);
        return true;
      });
    },
  };
}
