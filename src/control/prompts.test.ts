import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadId } from "../ids.ts";
import type { Finding, Review, Round, Verdict } from "./review-model.ts";
import { testReview } from "../test-support/registry-kit.ts";
import { builderFindings, builderNotes, nextRound, quoteRequest, reminder, reviewerRequest } from "./prompts.ts";

const [h1, h2] = ["1".repeat(40), "2".repeat(40)];
const f1: Finding = { id: "F1", priority: "P1", where: "src/a.ts:3", summary: "Off by one", detail: "The loop stops early.\nStart at 0." };
const f2: Finding = { id: "F2", priority: "P3", summary: "Rename x" };
const verdict = (findings: Finding[]): Verdict => ({ token: "rv-1:t", verdict: findings.some((f) => f.priority !== "P3") ? "changes" : "approve", findings, reserved: [], notCheckedLive: null });
const second: Review["second"] = { kind: "claude", rule: "always", thread: "th-second" as ThreadId, model: "claude-sonnet-5-5", expect: "rv-1:s", asked: "", since: 0, nudges: 0, outbox: null };
const detail = { head: h1, base: "main", body: "Adds a cache.\n\nNot checked live: the eviction under load." };
const at = (round: Partial<Round>, over: Partial<Review> = {}) => testReview({ rounds: [{ head: h1, verdict: null, check: null, answers: null, ...round }], ...over });
const twoRounds = (previous: Partial<Round>, head: string, over: Partial<Review> = {}) =>
  testReview({ rounds: [{ head: h1, base: "main", verdict: null, check: null, answers: null, ...previous }, { head, verdict: null, check: null, answers: null }], ...over });

test("reviewers are warned about template dependency freshness on initial and later checkouts", () => {
  const previous: Round = { head: h1, base: "main", verdict: verdict([f1]), check: null, answers: [{ id: "F1", action: "fixed", reason: "Done." }] };
  const review = twoRounds(previous, h2);
  for (const message of [
    reviewerRequest(review, detail, "rv-1:a", "gpt-6-astra"),
    reviewerRequest(review, detail, "rv-1:a", "claude-opus-5-5"),
    ...(["first", "second"] as const).map((seat) => nextRound(review, previous, "rv-1:b", "main", seat)),
  ]) {
    assert.match(message, /dependencies match this commit's lockfiles/);
    assert.match(message, /\.nexus\/resume/);
    assert.match(message, /10 seconds/);
    assert.match(message, /report the tests as blocked/);
  }
});

test("every review prompt keeps its text", (t) => {
  const prompts: Record<string, string> = {
    "reviewer request": reviewerRequest(testReview(), detail, "rv-1:a", "gpt-6-astra"),
    "reviewer request with a brief": reviewerRequest(testReview({ brief: "Cache the lookups." }), detail, "rv-1:a", "claude-sonnet-5-5"),
    "builder findings": builderFindings(at({ verdict: verdict([f1, f2]) }), "rv-1:b"),
    "builder findings from two reviewers": builderFindings(at({ verdict: verdict([f1]), secondVerdict: verdict([f1, f2]) }, { second }), "rv-1:b"),
    "builder findings of a failed check": builderFindings(at({ verdict: verdict([f2]), check: { passed: false, output: "1 failing" } }), "rv-1:b"),
    "builder findings beside a failed check": builderFindings(at({ verdict: verdict([f1]), check: { passed: false, output: "1 failing" } }), "rv-1:b"),
    "builder notes": builderNotes(at({ verdict: verdict([f2]) })),
    "builder notes from two reviewers": builderNotes(at({ verdict: verdict([f2]), secondVerdict: verdict([f2]) }, { second })),
    "next round after answers": nextRound(twoRounds({ verdict: verdict([f1]), answers: [{ id: "F1", action: "fixed", reason: "Started at 0." }] }, h2), { head: h1, base: "main", verdict: verdict([f1]), check: null, answers: [{ id: "F1", action: "fixed", reason: "Started at 0." }] }, "rv-1:c", "main", "first"),
    "next round to the second reviewer": nextRound(twoRounds({}, h2, { second }), { head: h1, base: "main", verdict: verdict([f1]), secondVerdict: verdict([f2, f1]), check: null, answers: [{ id: "F1", action: "fixed", reason: "Done." }, { id: "2.F1", action: "rejected", reason: "Not a bug." }] }, "rv-1:c", "main", "second"),
    "next round with none of yours answered": nextRound(twoRounds({}, h2, { second }), { head: h1, base: "main", verdict: verdict([f1]), secondVerdict: verdict([]), check: null, answers: [{ id: "F1", action: "fixed", reason: "Done." }] }, "rv-1:c", "main", "second"),
    "next round after a retarget": nextRound(twoRounds({}, h1), { head: h1, base: "main", verdict: verdict([]), check: null, answers: null }, "rv-1:c", "next", "first"),
    "next round after new commits": nextRound(twoRounds({}, h2), { head: h1, base: "main", verdict: verdict([]), check: null, answers: null }, "rv-1:c", "main", "first"),
    "next round after answers and a retarget": nextRound(twoRounds({}, h2), { head: h1, base: "main", verdict: verdict([f1]), check: null, answers: [{ id: "F1", action: "rejected", reason: "Fine as is." }] }, "rv-1:c", "next", "first"),
    "next round at an unmoved head": nextRound(twoRounds({}, h1), { head: h1, base: "main", verdict: verdict([f1]), check: null, answers: [{ id: "F1", action: "rejected", reason: "Fine as is." }] }, "rv-1:c", "main", "first"),
    "next round after a conflict": nextRound(twoRounds({}, h2), { head: h1, base: "main", verdict: verdict([]), check: null, answers: [], conflict: { base: "main" } }, "rv-1:c", "main", "first"),
    "quote request": quoteRequest(at({ verdict: verdict([]) }), { ...detail, branch: "cache" } as never, "rv-1:d"),
  };
  for (const phase of ["reviewing", "fixing", "quoting"] as const) {
    prompts[`reminder while ${phase}`] = reminder(phase, null, "rv-1:e");
    prompts[`reminder while ${phase}, with what is missing`] = reminder(phase, "Your answers leave F1 without a fix or a reason to reject.", "rv-1:e");
  }
  t.assert.snapshot(prompts);
});
