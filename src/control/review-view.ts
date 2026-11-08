/**
 * What the API serves of a thread's review beside the stored record: what the person's Land press does now and the
 * holds it reads, so a client renders the merge policy's answer instead of running the policy itself.
 */
import { holdRule, type Hold, type HoldRule } from "./holds.ts";
import { holdsAt, landPress, type LandPress } from "./policy.ts";
import { askingHolds, type Question } from "./questions.ts";
import { ended, type Review } from "./review-model.ts";

export interface ReviewView {
  id: string;
  /** The latest round's head, which a Land press names. */
  head: string;
  ended: boolean;
  /** The holds on the review now, each with whether it meets every landing of the head again and whether the person may waive it. */
  holds: readonly (Hold & HoldRule)[];
  press: LandPress;
  /**
   * The review's open question about its holds, which the person answers Land to waive them, at the head it was asked
   * at. Between a push and the loop's next pass that head is older than `head`, and Land on it is refused.
   */
  question: { id: string; head: string; holds: readonly Hold[] } | null;
}

export function reviewView(review: Review, questions: readonly Question[]): ReviewView {
  const asking = askingHolds(questions, review.id);
  return {
    id: review.id,
    head: review.rounds.at(-1)!.head,
    ended: ended(review),
    holds: holdsAt(review).map((h) => ({ ...h, ...holdRule(h.code) })),
    press: landPress(review),
    question: asking === undefined ? null : { id: asking.id, head: asking.holds.head, holds: asking.holds.holds },
  };
}
