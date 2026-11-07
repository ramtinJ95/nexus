import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blocks, builderAwaited, cancellable, ended, findingsOf, inLanding, kindsWhere, landingVerb, findingSchema, reviewerApproved, reviewersFindings, roundNote, roundsSpent, secondReads, settled, verdictSchema, waitsOnPerson,
  type Finding, type Phase, type PhaseKind, type Review, type Round, type SecondReviewer, type Verdict,
} from "./review-model.ts";
import type { PrSnapshot } from "./github.ts";
import { landingHolds } from "./policy.ts";
import { upgradeReview } from "./record-upgrade.ts";
import type { ThreadId } from "../ids.ts";
import { testReview } from "../test-support/registry-kit.ts";

// The values the sets and predicates gave before the phase table, per phase.
const before: [string, Phase, Partial<Review>, { ended: boolean; settled: boolean; waitsOnPerson: boolean; landing: boolean; landingVerb: string | null; cancellable: boolean; builderAwaited: boolean }][] = [
  ["reviewing", { kind: "reviewing" }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: true, builderAwaited: true }],
  ["reviewing, the reviewer's model failing", { kind: "reviewing", failing: { count: 1, last: "x", retryAt: 0 } }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: true, builderAwaited: false }],
  ["fixing, findings unsent", { kind: "fixing" }, { outbox: { id: "m", text: "t", attempted: null, to: "builder" } }, { ended: false, settled: false, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: true, builderAwaited: true }],
  ["fixing, findings unsent, the builder's model failing", { kind: "fixing", failing: { count: 1, last: "x", retryAt: 0 } }, { outbox: { id: "m", text: "t", attempted: null, to: "builder" } }, { ended: false, settled: false, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: true, builderAwaited: true }],
  ["fixing, a message to the reviewer unsent", { kind: "fixing" }, { outbox: { id: "m", text: "t", attempted: null, to: "reviewer" } }, { ended: false, settled: false, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: true, builderAwaited: false }],
  ["fixing, findings delivered", { kind: "fixing" }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: true, builderAwaited: false }],
  ["checking", { kind: "checking", startedAt: 0, thread: null }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: true, builderAwaited: false }],
  ["verifying", { kind: "verifying", startedAt: 0, thread: null }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: true, builderAwaited: false }],
  ["quoting", { kind: "quoting", asked: null }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: true, builderAwaited: false }],
  ["approved", { kind: "approved" }, {}, { ended: true, settled: false, waitsOnPerson: true, landing: false, landingVerb: null, cancellable: false, builderAwaited: false }],
  ["merging, not authorized", { kind: "merging", authorized: null }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: true, landingVerb: null, cancellable: true, builderAwaited: false }],
  ["merging, authorized", { kind: "merging", authorized: "abc" }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: true, landingVerb: "merges", cancellable: false, builderAwaited: false }],
  ["deploying", { kind: "deploying", commit: "c", previous: null, requested: false, deadline: 0 }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: true, landingVerb: "deploys", cancellable: false, builderAwaited: false }],
  ["rolling-back", { kind: "rolling-back", commit: "c", previous: "p", why: "w", requested: false, deadline: 0 }, {}, { ended: false, settled: false, waitsOnPerson: false, landing: true, landingVerb: "rolls back", cancellable: false, builderAwaited: false }],
  ["landed", { kind: "landed", commit: "c" }, {}, { ended: true, settled: true, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: false, builderAwaited: false }],
  ["needs-person", { kind: "needs-person", cause: "gate", reasons: [], holds: [] }, {}, { ended: true, settled: false, waitsOnPerson: true, landing: false, landingVerb: null, cancellable: true, builderAwaited: false }],
  ["merged", { kind: "merged" }, {}, { ended: true, settled: true, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: false, builderAwaited: false }],
  ["closed", { kind: "closed" }, {}, { ended: true, settled: true, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: false, builderAwaited: false }],
  ["cancelled", { kind: "cancelled", who: "person", by: "p" }, {}, { ended: true, settled: true, waitsOnPerson: false, landing: false, landingVerb: null, cancellable: false, builderAwaited: false }],
];

test("each phase's row gives the value every old set and predicate gave it", () => {
  for (const [name, phase, extra, was] of before) {
    const r = { since: 10, outbox: null, ...extra, phase } as Review;
    assert.deepEqual({
      ended: ended(r), settled: settled(r), waitsOnPerson: waitsOnPerson(r), landing: inLanding(r), landingVerb: landingVerb(r), cancellable: cancellable(r), builderAwaited: builderAwaited(r) !== null,
    }, was, name);
  }
  assert.equal(waitsOnPerson(null), false, "no review waits on no one");
  assert.deepEqual(builderAwaited({ since: 10, outbox: null, phase: { kind: "reviewing" } } as unknown as Review), { from: 10, until: 10 + 30 * 60_000 }, "a round keeps the builder up for 30 minutes");
  assert.deepEqual(builderAwaited({ since: 20, outbox: { to: "builder" }, phase: { kind: "fixing" } } as unknown as Review), { from: 20, until: 20 + 30 * 60_000 }, "undelivered findings keep the builder up for 30 minutes");
});

test("the store's SQL filters read the kinds they filtered before", () => {
  const sorted = (kinds: PhaseKind[]) => [...kinds].sort();
  assert.deepEqual(sorted(kindsWhere((row) => row.settled)), ["cancelled", "closed", "landed", "merged"]);
  assert.deepEqual(sorted(kindsWhere((row) => row.awaitsBuilder)), ["fixing", "reviewing"]);
});

test("every phase kind has a row", () => {
  assert.deepEqual(new Set(kindsWhere(() => true)), new Set(before.map(([, phase]) => phase.kind)));
});

/** The approval rules as main had them at d9f4085, before seats, kept as the proof's baseline. */
const secondApprovedBefore = (round: Round) => round.secondVerdict === undefined || (round.secondVerdict?.verdict === "approve" && !round.secondVerdict.findings.some(blocks));
const approvedBefore = (round: Round) => round.verdict?.verdict === "approve" && !round.verdict.findings.some(blocks) && secondApprovedBefore(round);
const spentBefore = (r: Review) => r.rounds.filter((round, i) => {
  const previous = r.rounds[i - 1];
  return round.carried === undefined && !(previous?.head === round.head && previous.base === round.base && previous.verdict?.verdict === "approve" && secondApprovedBefore(previous) && approvedBefore(round));
}).length;
const noteBefore = (r: Review) => {
  const [previous, round] = r.rounds.slice(-2);
  if (round === undefined || previous!.answers !== null || previous!.verdict?.verdict !== "approve" || !secondApprovedBefore(previous!)) return null;
  return roundNote(r);
};
/** The rounds as main's upgrade read them at d9f4085: findings with priorities, and a seat for a second reviewer at the latest round. */
const upgradedBefore = (r: Review): Review => ({
  ...r, rounds: r.rounds.map((round) => round.verdict === null ? round : { ...round, verdict: { ...round.verdict, findings: round.verdict.findings.map((f) => findingSchema.parse(f)) } })
    .map((round, i) => secondReads(r) && i === r.rounds.length - 1 && round.secondVerdict === undefined ? { ...round, secondVerdict: null } : round),
});
/** A verdict saved before its findings decided its word, which said approve with a P0 to P2 finding open. */
const contradicted = (r: Review) => r.rounds.some((round) => [round.verdict, round.secondVerdict].some((v) => v?.verdict === "approve" && v.findings.some(blocks)));
const findingsBefore = (round: Round) => [...reviewersFindings(round).map((f) => f.id), ...round.check?.passed === false && approvedBefore(round) ? ["CHECK"] : []];
const conditionOneBefore = (review: Review) => {
  const round = review.rounds.at(-1)!;
  if (round.verdict?.verdict !== "approve") return ["not-approved: The reviewer has not approved the latest commits."];
  if (secondReads(review) && round.secondVerdict?.verdict !== "approve") return ["not-approved: The second reviewer has not approved the latest commits."];
  const open = findingsOf(round).filter(blocks);
  return open.length ? [`open-findings: Findings P0 to P2 are open: ${open.map((f) => f.id).join(", ")}.`] : [];
};

const parsed = (verdict: string, ...priorities: Finding["priority"][]) =>
  verdictSchema.parse({ token: "t", verdict, findings: priorities.map((priority, i) => ({ id: `F${i}`, priority, summary: "s" })), reserved: [], notCheckedLive: null });
const verdicts: [string, Verdict | null][] = [
  ["no verdict", null],
  ["an approval", parsed("approve")],
  ["an approval with a P3 note", parsed("approve", "P3")],
  ["changes for a P1", parsed("approve", "P1", "P3")],
  ["a stored approval with a P1 open", { ...parsed("approve"), findings: parsed("changes", "P1").findings }],
  ["stored changes with only a P3", { ...parsed("approve", "P3"), verdict: "changes" }],
];
const seconds: [string, Verdict | null | undefined][] = [["no second seat", undefined], ...verdicts];
const secondReviewers: [string, SecondReviewer | undefined][] = [
  ["no second reviewer", undefined],
  ["none could run", { kind: "none", rule: "r", why: "w" }],
  ["one starting", { kind: "starting", rule: "r", model: "m", since: 0, tried: null, why: null }],
  ["one running", { kind: "claude", rule: "r", thread: "th-second" as ThreadId, model: "m", expect: "e", asked: "", since: 0, nudges: 0, outbox: null }],
];
const head = "1".repeat(40);
const pr = { pr: { number: 7, state: "open", checks: "passing" }, detail: { head, body: "" } } as unknown as PrSnapshot;

test("approval by seat gives every verdict combination of two rounds the approval, rounds, note and landing hold it had", () => {
  let combinations = 0;
  let changed = 0;
  for (const [reviewerName, second] of secondReviewers) for (const [prevName, prevFirst] of verdicts) for (const [prevSecondName, prevSecond] of seconds)
    for (const [firstName, first] of verdicts) for (const [secondName, latest] of seconds) for (const moved of [false, true]) for (const passed of [true, false]) {
      // Only a review with a second reviewer has a latest round with its seat.
      if (!secondReads(second === undefined ? {} : { second }) && latest !== undefined) continue;
      const round = (h: string, verdict: Verdict | null, secondVerdict: Verdict | null | undefined, check: Round["check"]): Round =>
        ({ head: h, base: "main", verdict: structuredClone(verdict), ...secondVerdict !== undefined && { secondVerdict: structuredClone(secondVerdict) }, check, answers: null });
      const stored = testReview({ ...second && { second }, rounds: [
        round(head, prevFirst, prevSecond, { passed: true, output: "" }),
        round(moved ? "2".repeat(40) : head, first, latest, { passed, output: "" }),
      ] });
      const r = upgradeReview(structuredClone(stored));
      const was = upgradedBefore(structuredClone(stored));
      const name = `${reviewerName}; round 1: ${prevName}, second ${prevSecondName}; round 2${moved ? " at a new head" : ""}: ${firstName}, second ${secondName}, check ${passed ? "passed" : "failed"}`;
      assert.deepEqual(r.rounds.map(reviewerApproved), was.rounds.map(approvedBefore), `${name}: approval`);
      assert.deepEqual(r.rounds.map((x) => findingsOf(x).map((f) => f.id)), was.rounds.map(findingsBefore), `${name}: findings`);
      const held = landingHolds({ review: r, pr, heldAt: { base: "main", holds: [] } }).filter((h) => h.code === "not-approved" || h.code === "open-findings");
      assert.equal(held.length, conditionOneBefore(was).length, `${name}: landing condition one holds`);
      if (contradicted(was)) {
        changed++;
        continue;
      }
      assert.equal(roundsSpent(r), spentBefore(was), `${name}: rounds spent`);
      assert.equal(roundNote(r), noteBefore(was), `${name}: round note`);
      assert.deepEqual(held.map((h) => `${h.code}: ${h.text}`), conditionOneBefore(was), `${name}: landing condition one`);
      combinations++;
    }
  assert.ok(combinations > 5_000, `${combinations} combinations`);
  assert.ok(changed > 0 && changed < combinations, `${changed} combinations with a contradicted verdict`);
});

test("a stored approval with a P1 open is no approval to the rounds spent, the round note and the landing either", () => {
  const stored = { ...parsed("approve"), findings: parsed("changes", "P1").findings };
  const r = upgradeReview(testReview({ rounds: [
    { head, base: "main", verdict: stored, check: { passed: true, output: "" }, answers: null },
    { head, base: "main", verdict: parsed("approve"), check: { passed: true, output: "" }, answers: null },
  ] }));
  const was = upgradedBefore(testReview({ rounds: [{ head, base: "main", verdict: stored, check: { passed: true, output: "" }, answers: null }, { head, base: "main", verdict: parsed("approve"), check: { passed: true, output: "" }, answers: null }] }));
  assert.equal(reviewerApproved(r.rounds[0]!), approvedBefore(was.rounds[0]!), "approval stays as main read it");
  assert.deepEqual([roundsSpent(r), spentBefore(was)], [2, 1], "main counted a round after it as one that reviewed nothing new");
  assert.deepEqual([roundNote(r), noteBefore(was) !== null], [null, true], "main said the round after it followed an approval");
  const latest = upgradeReview(testReview({ rounds: [{ head, base: "main", verdict: stored, check: { passed: true, output: "" }, answers: null }] }));
  assert.deepEqual(landingHolds({ review: latest, pr, heldAt: { base: "main", holds: [] } }).filter((h) => h.code === "not-approved" || h.code === "open-findings").map((h) => h.code), ["not-approved"],
    "a landing holds on it as not approved, where main held it as open findings, a hold with the same rule");
});
