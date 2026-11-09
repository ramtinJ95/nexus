import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewView } from "./review-view.ts";
import { landPress } from "./policy.ts";
import type { HoldsQuestion } from "./questions.ts";
import type { ThreadId } from "../ids.ts";
import { testReview } from "../test-support/registry-kit.ts";

const holdsQuestion = (id: string, review: string, answered: boolean) => ({
  kind: "holds", id, thread: "th-builder" as ThreadId, text: "Land pull request #7?", options: ["Land", "Leave it"], reserved: "auth", answerer: "deployer", askedAt: 1,
  answer: answered ? { option: "Land", by: "nLAPTOP", at: 2 } : null,
  holds: { review, head: "a".repeat(40), base: "main", holds: [{ code: "reserved-path:auth", text: "Always needs the person: changes to login or auth." }] },
}) as HoldsQuestion;

test("a review's view gives the merge policy's Land press and its open question about the review's holds, not an answered one or another review's", () => {
  const review = testReview();
  const view = reviewView(review, [holdsQuestion("q-answered", "rv-1", true), holdsQuestion("q-other", "rv-2", false), holdsQuestion("q-open", "rv-1", false)]);
  assert.deepEqual(view, {
    id: "rv-1", pr: 7, head: "1".repeat(40), ended: false, phase: { kind: "reviewing" }, round: 1, maxRounds: 5,
    reviewer: { thread: "th-reviewer", model: review.models.reviewer }, landsWhenApproved: false, holds: [], press: landPress(review),
    question: { id: "q-open", head: "a".repeat(40), holds: [{ code: "reserved-path:auth", text: "Always needs the person: changes to login or auth." }] },
  });
  assert.equal(reviewView(review, []).question, null);
  assert.equal(reviewView(testReview({ phase: { kind: "landed", commit: "b".repeat(40) } } as never), []).ended, true);
  const held = reviewView(testReview({ land: { requestedBy: "nLAPTOP" }, phase: { kind: "needs-person", cause: "gate", reasons: ["The check failed."], holds: [{ code: "loop", text: "The check failed." }] } } as never), []);
  assert.deepEqual([held.phase, held.landsWhenApproved], [{ kind: "needs-person", reasons: ["The check failed."] }, true], "a held review's view says why, and that it lands once approved");
  assert.ok(!("expect" in held) && !("asked" in held) && !("outbox" in held), "the view carries no token, ask or outbox");
});
