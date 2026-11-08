/**
 * What the API serves of a thread's review beside the stored record: what the person's Land press does now and the
 * holds it reads, so a client renders the merge policy's answer instead of running the policy itself.
 */
import { holdRule, type Hold } from "./holds.ts";
import { heldBy, landPress } from "./policy.ts";
import { isOpen, type Question } from "./questions.ts";
import { ended, type Review } from "./review-model.ts";

export interface ReviewView {
  id: string;
  /** The latest round's head, which a Land press names. */
  head: string;
  ended: boolean;
  /** The holds on the review now, each with whether it meets every landing of the head again and whether the person may waive it. */
  holds: readonly (Hold & ReturnType<typeof holdRule>)[];
  press: ReturnType<typeof landPress>;
  /** The review's open question about its holds, which the person answers Land to waive them, at the head it was asked at. */
  question: { id: string; head: string; holds: readonly Hold[] } | null;
}

export function reviewView(review: Review, questions: readonly Question[]): ReviewView {
  const asking = questions.find((q) => isOpen(q) && q.holds?.review === review.id);
  return {
    id: review.id,
    head: review.rounds.at(-1)!.head,
    ended: ended(review),
    holds: heldBy(review).map((h) => ({ ...h, ...holdRule(h.code) })),
    press: landPress(review),
    question: asking?.holds === undefined ? null : { id: asking.id, head: asking.holds.head, holds: asking.holds.holds },
  };
}
