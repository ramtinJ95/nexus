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
    id: "rv-1", head: "1".repeat(40), ended: false, holds: [], press: landPress(review),
    question: { id: "q-open", head: "a".repeat(40), holds: [{ code: "reserved-path:auth", text: "Always needs the person: changes to login or auth." }] },
  });
  assert.equal(reviewView(review, []).question, null);
  assert.equal(reviewView(testReview({ phase: { kind: "landed", commit: "b".repeat(40) } } as never), []).ended, true);
});
