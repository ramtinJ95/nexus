/**
 * A save archives the threads it names, appends its events and recomputes the builder's attention, in its
 * transaction.
 */
import { json, type Db, type Holding } from "./db.ts";
import type { ThreadId } from "../ids.ts";
import type { ThreadStatus } from "./reconcile.ts";
import type { EventFilter, EventKind, NexusEvent } from "./events.ts";
import { reviewerCaller } from "./agent-protocol.ts";
import { builderAwaited, ended, kindsWhere, reviewThreads, roundsSpent, waitsOnPerson, type Review, type Waiver } from "./review-model.ts";
import type { Removal } from "./retention.ts";
import { upgradeReview } from "./record-upgrade.ts";
import type { Need } from "./attention.ts";

/** A purged builder's review goes with it, and the pull requests its reviews read and the rounds they spent stay counted. */
export const holding = { tables: { reviews: { record: "builder", purge: "builder = $thread" }, reviewed_prs: {}, review_rounds: {} } } as const satisfies Holding;

export function reviewStore(db: Db, core: { setThreadStatus: (id: ThreadId, status: ThreadStatus) => void; appendEvent: (kind: EventKind, thread: ThreadId, payload: Record<string, unknown>) => unknown; updateAttention: (thread: ThreadId) => void; events: (since: string, filter: EventFilter) => NexusEvent[] }) {
  const { transaction, sql } = db;
  const reviews = db.hold(holding).records<Review>("reviews");
  const { setThreadStatus, appendEvent, updateAttention, events } = core;
  /** A review whose reviewer never started read nothing, so it spent no round. */
  const spend = (review: Review) => sql("INSERT INTO review_rounds (review, repo, number, rounds) VALUES (?, ?, ?, ?) ON CONFLICT (review) DO UPDATE SET rounds = excluded.rounds")
    .run(review.id, review.pr.repo, review.pr.number, review.reviewerStarted ? roundsSpent(review) : 0);
  // Each record an older control plane saved is upgraded once, with no event, so every read below gets this code's shape.
  transaction(() => {
    for (const row of sql("SELECT builder, record FROM reviews").all()) {
      const review = upgradeReview(json<Review>(row.record));
      const upgraded = JSON.stringify(review);
      if (upgraded !== row.record) sql("UPDATE reviews SET record = ? WHERE builder = ?").run(upgraded, row.builder as string);
      spend(review);
    }
  });
  const reviewOf = (builder: ThreadId): Review | null => reviews.get(builder);
  const awaitedKinds = JSON.stringify(kindsWhere((row) => row.awaitsBuilder));
  const settledKinds = JSON.stringify(kindsWhere((row) => row.settled));
  const isCurrentReview = (review: Review) => reviews.isCurrent(review.builder, review);
  /**
   * When the review entered the phase it is in, from the oldest of the `review.changed` events in a row that record it
   * there, as a label change records one again. The review's own `since` stands in once those events are gone.
   */
  function heldSince(r: Review): number {
    const changes = events("0", { thread: r.builder, kinds: ["review.changed"] });
    const at = changes.findLastIndex((e) => e.payload.review !== r.id || (e.payload.phase as Review["phase"] | undefined)?.kind !== r.phase.kind);
    return changes[at + 1]?.time ?? r.since;
  }
  const allReviews = (): Review[] => sql("SELECT record FROM reviews ORDER BY builder").all().map((r) => json<Review>(r.record));
  return {
    participant: {
      /**
       * A review that has not ended reads every thread it names. A stored one names its reviewers and gate threads until
       * its builder's purge takes it, so those stay in the registry until then, though they may be deleted.
       */
      keeps(threads: ReadonlyMap<ThreadId, Removal>): ReadonlyMap<ThreadId, string> {
        const kept = new Map<ThreadId, string>();
        for (const r of allReviews()) {
          for (const [thread, part] of reviewThreads(r)) {
            const removal = threads.get(thread);
            if (removal === undefined || kept.has(thread)) continue;
            const of = part === "builder" ? `its review ${r.id}` : `review ${r.id} of ${r.builder}, whose ${part} it is,`;
            if (!ended(r)) kept.set(thread, `${of} has not ended`);
            else if (removal === "purge" && part !== "builder") kept.set(thread, `review ${r.id} of ${r.builder} names it as its ${part} until ${r.builder} is purged`);
          }
        }
        return kept;
      },
      needs(thread: ThreadId): Need[] {
        const r = reviewOf(thread);
        return r !== null && waitsOnPerson(r) ? [{ kind: "review", review: r.id, since: heldSince(r) }] : [];
      },
      awaited: (threads: readonly ThreadId[]) => new Map(sql(`SELECT record FROM reviews WHERE builder IN (SELECT value FROM json_each(?))
        AND json_extract(record, '$.phase.kind') IN (SELECT value FROM json_each(?))`).all(JSON.stringify(threads), awaitedKinds).map((r) => json<Review>(r.record))
        .flatMap((r) => { const hold = builderAwaited(r); return hold === null ? [] : [[r.builder, hold] as const]; })),
    },
    review: reviewOf,
    /** Whether `review` is the builder's review as stored, so no other save came since it was read. */
    isCurrentReview,
    reviews: allReviews,
    /** The reviews but those settled with no message left to send. */
    reviewsToStep: (): Review[] => sql(`SELECT record FROM reviews WHERE json_extract(record, '$.phase.kind') NOT IN (SELECT value FROM json_each(?))
      OR json_extract(record, '$.outbox') IS NOT NULL ORDER BY builder`).all(settledKinds).map((r) => json<Review>(r.record)),
    /** The landed reviews whose builder was in a turn as they landed. */
    landedInTurn: (): Review[] => sql("SELECT record FROM reviews WHERE json_extract(record, '$.phase.inTurn') IS NOT NULL ORDER BY builder").all().map((r) => json<Review>(r.record)),
    /** A thread a review started, whether or not a later review replaced the record that names it. */
    isReviewer: (thread: ThreadId) => sql("SELECT 1 FROM threads WHERE id = ? AND started_by = ? UNION SELECT 1 FROM reviews WHERE reviewer = ?").get(thread, reviewerCaller, thread) !== undefined,
    /** Whether a review ever started for the pull request, including one a later review of its builder replaced. */
    prReviewed: (repo: string, number: number) => sql("SELECT 1 FROM reviewed_prs WHERE repo = ? AND number = ?").get(repo, number) !== undefined,
    /** The rounds every review of the pull request spent, including ones a later review of its builder replaced. */
    roundsSpentOn: (repo: string, number: number) => Number(sql("SELECT coalesce(sum(rounds), 0) AS n FROM review_rounds WHERE repo = ? AND number = ?").get(repo, number)!.n),
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
        spend(review);
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
