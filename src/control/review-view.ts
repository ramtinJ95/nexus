/**
 * What the API serves of a thread's review in place of the stored record: its public facts, what the person's Land
 * press does now and the holds it reads, so a client renders the merge policy's answer instead of running the policy
 * itself. The record's token, its asks and its outbox stay on the control plane.
 */
import type { ThreadId } from "../ids.ts";
import { holdRule, type Hold, type HoldRule } from "./holds.ts";
import { holdsAt, landPress, type LandPress } from "./policy.ts";
import { askingHolds, type Question } from "./questions.ts";
import { ended, roundsSpent, type PhaseKind, type Review } from "./review-model.ts";

export interface ReviewView {
  id: string;
  /** The number of the pull request it reviews. */
  pr: number;
  /** The latest round's head, which a Land press names. */
  head: string;
  ended: boolean;
  /** The review's phase, and while it waits on the person, why. */
  phase: { kind: Exclude<PhaseKind, "needs-person"> } | { kind: "needs-person"; reasons: readonly string[] };
  /** The rounds that count against `maxRounds`, as `nexus show` counts them, so a carried or repeated approval is not one. */
  round: number;
  maxRounds: number;
  reviewer: { thread: ThreadId; model: string };
  /** Whether it lands under the merge policy once approved, as `review --land` and `--auto-review land` ask. */
  landsWhenApproved: boolean;
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
  const { phase } = review;
  return {
    id: review.id,
    pr: review.pr.number,
    head: review.rounds.at(-1)!.head,
    ended: ended(review),
    phase: phase.kind === "needs-person" ? { kind: phase.kind, reasons: phase.reasons } : { kind: phase.kind },
    round: roundsSpent(review),
    maxRounds: review.maxRounds,
    reviewer: { thread: review.reviewer, model: review.models.reviewer },
    landsWhenApproved: review.land !== null,
    holds: holdsAt(review).map((h) => ({ ...h, ...holdRule(h.code) })),
    press: landPress(review),
    question: asking === undefined ? null : { id: asking.id, head: asking.holds.head, holds: asking.holds.holds },
  };
}
