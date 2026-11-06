import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reviewPrefix } from "../agent-protocol.ts";
import { tempDir } from "../test-kit.ts";
import { personOnly, reservedNames, type HoldCode, type ReservedCase } from "./holds.ts";
import { upgradeReview } from "./record-upgrade.ts";
import { findingSchema, maxRounds, secondReads, type Review, type SecondReviewer } from "./review-model.ts";
import type { ThreadId } from "../ids.ts";
import { addThread, seedRegistry, testRegistry, testReview } from "./test-kit.ts";
import { openRegistry } from "./registry.ts";

/** storedReview and legacyHoldCode as main had them at c22d002, before the upgrade replaced them, kept as the proof's baseline. */
function storedReview(record: Review): Review {
  const { phase, waiver } = record;
  return {
    ...record, maxRounds: Math.min(record.maxRounds, maxRounds), auto: record.auto ?? false,
    waiver: waiver == null ? null : { ...waiver, codes: waiver.codes ?? waiver.holds.map(legacyHoldCode) },
    phase: phase.kind === "needs-person" ? {
      ...phase, cause: phase.cause ?? (phase.label === undefined ? "unrecorded" : "rounds"),
      holds: phase.holds ?? phase.reasons.map((text) => ({ code: legacyHoldCode(text), text })),
    } : phase,
    asked: record.asked ?? `${reviewPrefix}\nYour last turn ended because your model failed. Carry out Nexus's last request again, and end your reply with the block it asks for, with the token "${record.expect}".`,
    rounds: record.rounds.map((round) => round.verdict === null ? round : { ...round, verdict: { ...round.verdict, findings: round.verdict.findings.map((f) => findingSchema.parse(f)) } })
      .map((round, i) => secondReads(record) && i === record.rounds.length - 1 && round.secondVerdict === undefined ? { ...round, secondVerdict: null } : round),
  };
}
function legacyHoldCode(text: string): HoldCode {
  for (const c of Object.keys(reservedNames) as ReservedCase[]) {
    if (text.startsWith(`${personOnly}${reservedNames[c]}, by the reviewer's reading (`)) return `reserved:${c}`;
    if (text.startsWith(`${personOnly}${reservedNames[c]}, as it changes `)) return `reserved-path:${c}`;
  }
  const rules: readonly [HoldCode, (t: string) => boolean][] = [
    ["check-changed", (t) => t === "The pull request changes .nexus/check, the check this policy relies on."],
    ["verify-changed", (t) => t === "The pull request changes .nexus/verify, the live check this policy relies on."],
    ["claude-approved", (t) => t.startsWith("A Claude reviewer approved it.")],
    ["open-findings", (t) => t.startsWith("Findings P0 to P2 are open")],
    ["not-approved", (t) => t.startsWith("The reviewer has not approved")],
    ["unanswered", (t) => t.startsWith("The builder neither fixed nor rejected")],
    ["check-failed", (t) => t.startsWith(".nexus/check ")],
    ["live-failed", (t) => t.startsWith("The live check ")],
    ["github-checks", (t) => /GitHub checks are/.test(t)],
    ["not-approved-head", (t) => /, not the approved /.test(t)],
    ["conflict", (t) => t === "The branch conflicts with its base."],
    ["pr-not-open", (t) => /^Pull request #\d+ is /.test(t)],
    ["same-model", (t) => t.startsWith("The reviewer ran the builder's own model")],
    ["not-checked-live", (t) => /could not be checked live/.test(t)],
    ["stale-head", (t) => /^The pull request's head moved to \S+ after this review was held/.test(t)],
  ];
  return rules.find(([, matches]) => matches(text))?.[0] ?? "loop";
}

const head = "1".repeat(40);
const holdTexts = [
  ...(Object.keys(reservedNames) as ReservedCase[]).flatMap((c) => [`${personOnly}${reservedNames[c]}, by the reviewer's reading (it adds a token).`, `${personOnly}${reservedNames[c]}, as it changes src/control/api.ts.`]),
  "The pull request changes .nexus/check, the check this policy relies on.", "The pull request changes .nexus/verify, the live check this policy relies on.",
  "A Claude reviewer approved it. Its verdict could have been written by code in its pylon.", "Findings P0 to P2 are open: F1.", "The reviewer has not approved the latest commits.",
  "The builder neither fixed nor rejected with a reason finding F1 of round 1.", `.nexus/check failed at ${head}.`, `The live check failed at ${head}.`,
  "The pull request's GitHub checks are failing.", `The pull request's head is ${"2".repeat(40)}, not the approved ${head}.`, "The branch conflicts with its base.",
  "Pull request #7 is closed.", "The reviewer ran the builder's own model, claude-opus-5-5.", "No live check ran, and the pull request does not say what could not be checked live.",
  `The pull request's head moved to ${"2".repeat(40)} after this review was held.`, "The deploy failed.", "Always needs the person: anything irreversible, in words an older control plane used.",
];
const severity = { token: "x", verdict: "changes", findings: [{ id: "F1", severity: "serious", where: "src/cache.ts:1", summary: "The cache never expires" }, { id: "M1", severity: "minor", summary: "Name the constant" }], reserved: [], notCheckedLive: null };
const second: SecondReviewer = { kind: "claude", rule: "the project gives every pull request one", thread: "th-second" as ThreadId, model: "gpt-6-astra", expect: "rv-1:s", asked: "", since: 0, nudges: 0, outbox: null };
const { asked: _, auto: __, ...unasked } = testReview();

/** Every shape a stored review takes: each phase as this code saves it, and each older shape a shim reads. */
const fixtures: [string, unknown][] = [
  ["a current review", testReview()],
  ...(["approved", "landed", "merged", "closed"] as const).map((kind): [string, unknown] => [`a current ${kind} review`, testReview({ phase: kind === "landed" ? { kind, commit: head } : { kind } })]),
  ["a current held review", testReview({ phase: { kind: "needs-person", cause: "policy", reasons: ["The deploy failed."], holds: [{ code: "loop", text: "The deploy failed." }] } })],
  ["a current waiver", testReview({ waiver: { head, holds: [holdTexts[0]!], codes: ["reserved:secrets"], by: "nLAPTOP", at: 1, change: null } })],
  ["a carried waiver", testReview({ waiver: { head, holds: [holdTexts[0]!], codes: ["reserved:secrets"], by: "nLAPTOP", at: 1, change: { kind: "known", base: "main", files: [{ path: "a.ts", id: "x" }] }, from: "2".repeat(40) } })],
  ["more rounds than the cap", testReview({ maxRounds: 10 })],
  ["findings with a severity", testReview({ rounds: [{ head, verdict: severity as never, check: null, answers: null }] })],
  ["no auto and no asked", unasked],
  ["no waiver field", { ...testReview(), waiver: undefined }],
  ["a waiver before hold codes and changes", testReview({ waiver: { head, holds: holdTexts, by: "nLAPTOP", at: 1 } as never })],
  ["a waiver before changes", testReview({ waiver: { head, holds: [holdTexts[0]!], codes: ["reserved:secrets"], by: "nLAPTOP", at: 1 } as never })],
  ["a hold before causes and codes", testReview({ phase: { kind: "needs-person", reasons: holdTexts } as never })],
  ["a labelled hold before causes", testReview({ phase: { kind: "needs-person", reasons: ["The reviewer still requests changes after 5 rounds."], holds: [{ code: "loop", text: "The reviewer still requests changes after 5 rounds." }], label: { state: "added" } } as never })],
  ["a second reviewer's round without its verdict", testReview({ second, rounds: [{ head: "0".repeat(40), verdict: null, check: null, answers: null }, { head, verdict: null, check: null, answers: null }] })],
  ["a second reviewer's round with its verdict", testReview({ second, rounds: [{ head, verdict: null, secondVerdict: null, check: null, answers: null }] })],
  ["no second reviewer could run", testReview({ second: { kind: "none", rule: "the project gives every pull request one", why: "no model" } })],
];

const unrecordedChange = { kind: "unknown", why: "the waiver was saved before Nexus recorded the change it waives" };

test("the upgrade gives every stored-review fixture what storedReview read, and a waiver saved before changes an unknown one", () => {
  for (const [name, record] of fixtures) {
    const before = storedReview(structuredClone(record) as Review);
    const lacksChange = before.waiver !== null && !("change" in before.waiver);
    const expected = lacksChange ? { ...before, waiver: { ...before.waiver!, change: unrecordedChange } } : before;
    assert.deepEqual(upgradeReview(structuredClone(record) as Review), expected, name);
  }
});

test("an upgraded record reads the same through storedReview, so an older control plane reads it, and upgrades no further", () => {
  for (const [name, record] of fixtures) {
    const upgraded = upgradeReview(structuredClone(record) as Review);
    assert.deepEqual(storedReview(structuredClone(upgraded)), upgraded, name);
    assert.deepEqual(upgradeReview(structuredClone(upgraded)), upgraded, name);
  }
});

test("a registry opened over an older record rewrites it upgraded once, with no event, and leaves a current one as it was", async (t) => {
  const path = join(await tempDir("record-upgrade", t), "registry.db");
  const first = seedRegistry(openRegistry(path));
  const older = addThread(first);
  const current = addThread(first);
  const legacy = { ...unasked, builder: older.id, reviewer: older.id, maxRounds: 10, waiver: { head, holds: [holdTexts[0]!], by: "nLAPTOP", at: 1 }, phase: { kind: "needs-person", reasons: [holdTexts[0]!] } };
  const kept = testReview({ builder: current.id, reviewer: current.id });
  first.saveReview(legacy as never);
  first.saveReview(kept);
  const events = first.events("0", {}).length;
  first.close();

  const registry = testRegistry(t, path);
  assert.deepEqual(registry.review(older.id), upgradeReview(structuredClone(legacy) as never));
  assert.deepEqual(registry.review(current.id), kept);
  assert.equal(registry.events("0", {}).length, events, "the upgrade tells the event log nothing");
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const stored = (id: string) => JSON.parse((db.prepare("SELECT record FROM reviews WHERE builder = ?").get(id) as { record: string }).record);
  assert.deepEqual(stored(older.id), upgradeReview(structuredClone(legacy) as never), "the upgraded record is what the registry holds");
  assert.deepEqual(stored(current.id), kept);
});
