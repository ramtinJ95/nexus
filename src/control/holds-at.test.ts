import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrSnapshot } from "./github.ts";
import { holdRule, personOnly, remedyOf, waivable, waivedName, type Hold, type HoldCode } from "./holds.ts";
import { reservedCases, reservedNames } from "../contract/reserved.ts";
import { holdsAt, landPress } from "./policy.ts";
import { answered, blocks, findingsOf, seatsFor, unapprovedSeat, type HeldAt, type Review, type Round } from "./review-model.ts";
import { testPr, testReview } from "../test-support/registry-kit.ts";

/*
 * The derivations of a review's holds as policy.ts had them before holdsAt, copied from it unchanged, which the
 * fixtures below hold holdsAt and landPress to.
 */
const hold = (code: HoldCode, text: string): Hold => ({ code, text });

const sameModel = (review: Review): Hold[] => review.models.reviewer === review.models.builder ? [hold("same-model", `The reviewer ran the builder's own model, ${review.models.builder}.`)] : [];

const recordedHolds = (review: Review): Hold[] => [
  ...review.reviewerKind === "claude" ? [hold("claude-approved", "A Claude reviewer approved it. Its verdict is read from its transcript in its pylon, where code it runs could write, so only the person can land what it approved.")] : [],
  ...review.second?.kind === "none" ? [hold("no-second-reviewer", `The project asks for a second reviewer on another model, since ${review.second.rule}, and none could run: ${review.second.why}.`)] : [],
  ...(review.rounds.at(-1)!.verdict?.reserved ?? []).map((r) => hold(`reserved:${r.case}`, `${personOnly}${reservedNames[r.case]}, by the reviewer's reading (${r.why}).`)),
  ...(review.rounds.at(-1)!.secondVerdict?.reserved ?? []).map((r) => hold(`reserved:${r.case}`, `${personOnly}${reservedNames[r.case]}, by the second reviewer's reading (${r.why}).`)),
];

const headHeld = (review: Review): Hold[] => review.rounds.at(-1)!.heldAt?.holds ?? [...sameModel(review), ...recordedHolds(review)];

const oldHeldBy = (review: Review): Hold[] => {
  if (review.phase.kind !== "needs-person") return headHeld(review);
  const codes = new Set(review.phase.holds.map((h) => h.code));
  return [...review.phase.holds, ...(review.rounds.at(-1)!.heldAt?.holds ?? []).filter((h) => !codes.has(h.code))];
};

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** The reviewer's quote of what could not be checked live at the round, or null when it quoted nothing long enough to count. */
const quoteOf = (round: Round) => {
  const quoted = round.verdict?.notCheckedLive ?? null;
  return quoted === null || squash(quoted).length < 20 ? null : quoted;
};

type LandPress = { kind: "stuck"; holds: Hold[] } | { kind: "lands"; waives: Hold[]; quotes: boolean };
function oldLandPress(review: Review): LandPress {
  const holds = oldHeldBy(review);
  const stuck = holds.filter((h) => holdRule(h.code).holdsAgain && !holdRule(h.code).waivable);
  if (stuck.length) return { kind: "stuck", holds: stuck };
  const round = review.rounds.at(-1)!;
  const quotes = round.live?.kind === "absent" && (quoteOf(round) === null || holds.some((h) => h.code === "not-checked-live"));
  return { kind: "lands", waives: holds.filter((h) => waivable(h.code)), quotes };
}

function oldAskedHolds(review: Review, early: readonly Hold[] | null): Hold[] {
  const round = review.rounds.at(-1)!;
  const read = round.heldAt !== undefined || early === null ? review : { ...review, rounds: [...review.rounds.slice(0, -1), { ...round, heldAt: { base: round.base ?? "", holds: [...early] } }] };
  const press = oldLandPress(read);
  return press.kind === "lands" ? press.waives : [];
}

const conditions: readonly ((facts: { review: Review; pr: PrSnapshot; heldAt: HeldAt }) => Hold[])[] = [
  ({ review }) => {
    const round = review.rounds.at(-1)!;
    // The seats are the review's, so a round that lost its second verdict has no approval.
    const seat = unapprovedSeat(round, seatsFor(review));
    if (seat !== null) return [hold("not-approved", `The ${seat === "first" ? "reviewer" : "second reviewer"} has not approved the latest commits.`)];
    const open = findingsOf(round).filter(blocks);
    return open.length ? [hold("open-findings", `Findings P0 to P2 are open: ${open.map((f) => f.id).join(", ")}.`)] : [];
  },
  ({ review }) => review.rounds.flatMap((round, i) => findingsOf(round).filter(blocks)
    .filter((f) => !answered(f, round.answers ?? []))
    .map((f) => hold("unanswered", `The builder neither fixed nor rejected with a reason finding ${f.id} of round ${i + 1}.`))),
  ({ review }) => {
    const round = review.rounds.at(-1)!;
    if (round.check === null) return [hold("check-failed", `.nexus/check has not run at ${round.head}.`)];
    return round.check.passed ? [] : [hold("check-failed", `.nexus/check failed at ${round.head}.`)];
  },
  ({ review, pr }) => {
    const head = review.rounds.at(-1)!.head;
    // A PR merged outside the review is held on what can still be judged: which head merged.
    if (pr.pr.state === "merged") return pr.detail.head === head ? [] : [hold("not-approved-head", `Pull request #${pr.pr.number} merged at ${pr.detail.head}, not the approved ${head}.`)];
    if (pr.pr.state !== "open") return [hold("pr-not-open", `Pull request #${pr.pr.number} is ${pr.pr.state}.`)];
    return [
      ...pr.detail.head === head ? [] : [hold("not-approved-head", `The pull request's head is ${pr.detail.head}, not the approved ${head}.`)],
      ...pr.pr.conflict === true ? [hold("conflict", "The branch conflicts with its base.")] : [],
      ...pr.pr.checks === "failed" || pr.pr.checks === "pending" ? [hold("github-checks", `The pull request's GitHub checks are ${pr.pr.checks}.`)] : [],
    ];
  },
  // A live check that ran decides. A head with no .nexus/verify ran none, and lands on the statement of what it could not check live.
  ({ review, pr }) => {
    const round = review.rounds.at(-1)!;
    if (round.live === undefined) return [hold("live-failed", `The live check has not run at ${round.head}.`)];
    if (round.live.kind === "ran") return round.live.passed ? [] : [hold("live-failed", `The live check failed at ${round.head}.`)];
    const quoted = quoteOf(round);
    if (quoted === null) return [hold("not-checked-live", "No live check ran, and the pull request does not say what could not be checked live.")];
    return squash(pr.detail.body).includes(squash(quoted)) ? [] : [hold("not-checked-live", "The reviewer's quote of what could not be checked live is not in the pull request's description.")];
  },
  ({ heldAt }) => heldAt.holds,
];

function oldLandingHolds(facts: { review: Review; pr: PrSnapshot; heldAt: HeldAt }): Hold[] {
  return conditions.flatMap((condition) => condition(facts));
}

const oldWaivedName = (code: HoldCode): string => {
  const c = /^reserved(-path)?:/.test(code) ? code.slice(code.indexOf(":") + 1) as keyof typeof reservedNames : null;
  return c !== null ? reservedNames[c] : code === "check-changed" ? "a change to .nexus/check" : code === "verify-changed" ? "a change to .nexus/verify" : code === "no-second-reviewer" ? "a review without its second reviewer" : code;
};
/** What the landing did with what its waiver left, before remedies were rows: rebase, ask for the quote again, or hold. */
const oldRemedy = (left: readonly Hold[]) => left.length === 1 && left[0]!.code === "conflict" ? "rebase" : left.length === 1 && left[0]!.code === "not-checked-live" ? "quote" : null;

const head = "1".repeat(40);
const h = (code: HoldCode): Hold => ({ code, text: `held by ${code}` });
const quote = "the cache under real traffic, which no test reaches";
const approve = (over: Partial<NonNullable<Round["verdict"]>> = {}): NonNullable<Round["verdict"]> => ({ token: "t", verdict: "approve", findings: [], reserved: [], notCheckedLive: null, ...over });
const rounds: Round[] = [
  { head, base: "main", verdict: null, check: null, answers: null },
  { head, base: "main", verdict: approve(), check: { passed: true, output: "" }, live: { kind: "ran", thread: "th-v" as never, passed: true, output: "" }, answers: null },
  { head, base: "main", verdict: approve({ notCheckedLive: quote }), check: { passed: true, output: "" }, live: { kind: "absent" }, answers: null },
  { head, base: "main", verdict: approve(), check: { passed: true, output: "" }, live: { kind: "absent" }, answers: null },
  { head, base: "main", verdict: approve({ reserved: [{ case: "auth", why: "it changes the login" }] }), check: { passed: false, output: "" }, live: { kind: "ran", thread: "th-v" as never, passed: false, output: "" }, answers: null },
  { head, verdict: approve({ verdict: "changes", findings: [{ id: "F1", priority: "P1", where: "a.ts", summary: "s", detail: null }] }), check: { passed: true, output: "" }, answers: [] },
];
const recorded: (HeldAt | undefined)[] = [undefined, { base: "main", holds: [] }, { base: "main", holds: [h("verify-changed"), h("reserved-path:egress"), h("same-model")] }, { base: "main", holds: [h("not-checked-live")] }];
const phases: Review["phase"][] = [
  { kind: "approved" }, { kind: "merging", authorized: null }, { kind: "reviewing" },
  { kind: "needs-person", cause: "policy", reasons: [], holds: [] },
  { kind: "needs-person", cause: "policy", reasons: ["a", "b"], holds: [h("conflict"), h("reserved-path:egress")] },
  { kind: "needs-person", cause: "gate", reasons: ["c"], holds: [h("loop")] },
];
const reviewers: Partial<Review>[] = [
  {}, { reviewerKind: "claude" }, { models: { builder: "m", reviewer: "m" } },
  { second: { kind: "none", rule: "the change touches src/control/", why: "no other model could run" } },
];
const earlies: (Hold[] | null)[] = [null, [], [h("check-changed"), h("claude-approved")], [h("not-checked-live")]];
const snapshot = (pr: Partial<PrSnapshot["pr"]>, detail: Partial<PrSnapshot["detail"]> = {}): PrSnapshot =>
  ({ pr: testPr({ number: 7, ...pr }), detail: { head, branch: "cache", base: "main", body: "", mergeCommit: null, ...detail }, failures: [], comments: [] });
const prs = [
  snapshot({}), snapshot({}, { body: `Not checked live: ${quote}.` }), snapshot({ conflict: true, checks: "pending" }), snapshot({ checks: "failed" }, { head: "2".repeat(40) }),
  snapshot({ state: "merged" }, { head: "2".repeat(40) }), snapshot({ state: "closed" }),
];
const reviews = rounds.flatMap((round) => recorded.flatMap((heldAt) => phases.flatMap((phase) => reviewers.map((over) =>
  testReview({ ...over, phase, rounds: [{ ...rounds[0]!, verdict: approve() }, heldAt === undefined ? round : { ...round, heldAt }] })))));

test("holdsAt is what each derivation of a review's holds was, on every fixture", () => {
  for (const review of reviews) {
    const at = JSON.stringify({ phase: review.phase, round: review.rounds.at(-1), reviewerKind: review.reviewerKind, second: review.second });
    assert.deepEqual(holdsAt(review), oldHeldBy(review), `heldBy, as the card and a Land press read it: ${at}`);
    assert.deepEqual(landPress(review), oldLandPress(review), `landPress: ${at}`);
    for (const early of earlies) {
      const press = landPress(review, early);
      assert.deepEqual(press.kind === "lands" ? press.waives : [], oldAskedHolds(review, early), `askedHolds with ${JSON.stringify(early)}: ${at}`);
    }
    // A landing runs while merging, once the loop recorded the head's holds, and a test may pass the record's alone.
    if (review.phase.kind === "needs-person") continue;
    const heldAt = review.rounds.at(-1)!.heldAt ?? { base: "main", holds: [...sameModel(review), ...recordedHolds(review)] };
    for (const pr of prs) assert.deepEqual(holdsAt(review, { pr }), oldLandingHolds({ review, pr, heldAt }), `landingHolds at ${JSON.stringify(pr)}: ${at}`);
  }
});

test("each code's row names its waiver and remedy as the if-chains did", () => {
  const codes: HoldCode[] = [
    "same-model", "not-approved", "open-findings", "unanswered", "check-failed", "live-failed", "github-checks", "not-approved-head", "conflict", "pr-not-open",
    "not-checked-live", "claude-approved", "check-changed", "verify-changed", "no-second-reviewer", "stale-head", "waiver-not-carried", "loop",
    ...reservedCases.flatMap((c) => [`reserved:${c}`, `reserved-path:${c}`] as const),
  ];
  for (const code of codes) {
    assert.equal(waivedName(code), oldWaivedName(code), code);
    assert.equal(remedyOf(code), oldRemedy([h(code)]), code);
  }
});
