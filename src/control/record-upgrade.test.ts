import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reviewPrefix } from "./agent-protocol.ts";
import { tempDir } from "../test-support/kit.ts";
import { personOnly, type HoldCode } from "./holds.ts";
import { reservedNames, type ReservedCase } from "../contract/reserved.ts";
import { upgradeAttempts, upgradeReview, upgradeSubmitted } from "./record-upgrade.ts";
import { findingSchema, maxRounds, secondReads, type Review, type SecondReviewer } from "./review-model.ts";
import type { JobId, NodeName, PylonId, ThreadId } from "../ids.ts";
import { addThread, seedRegistry, testRegistry, testReview } from "../test-support/registry-kit.ts";
import { openRegistry } from "./registry.ts";
import { noAttempts, type Attempts, type FailedAttempt } from "./reconcile.ts";

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

/** Stored rounds whose verdict's word its findings contradict, as the reviewer's own word was before findings decided it. */
const p1 = [{ id: "F1", priority: "P1", summary: "The cache never expires" }];
const p3 = [{ id: "N1", priority: "P3", summary: "Name the constant" }];
const word = (verdict: string, findings: unknown[]) => ({ token: "x", verdict, findings, reserved: [], notCheckedLive: null }) as never;
const worded: [string, Review, ("approve" | "changes" | null)[][]][] = [
  ["an approval with a P1 open", testReview({ rounds: [{ head, verdict: word("approve", p1), check: null, answers: null }] }), [["changes", null]]],
  ["changes with only a P3", testReview({ rounds: [{ head, verdict: word("changes", p3), check: null, answers: null }] }), [["changes", null]]],
  ["a second reviewer's approval with a P1 open", testReview({ second, rounds: [{ head, verdict: word("approve", p3), secondVerdict: word("approve", p1), check: null, answers: null }] }), [["approve", "changes"]]],
  ["words that agree with their findings", testReview({ second, rounds: [{ head, verdict: word("approve", []), check: null, answers: null }, { head, verdict: word("changes", p1), secondVerdict: word("approve", p3), check: null, answers: null }] }), [["approve", null], ["changes", "approve"]]],
];

test("the upgrade gives each stored verdict the word for the approval an older control plane read from it", () => {
  for (const [name, record, words] of worded) {
    const upgraded = upgradeReview(structuredClone(record));
    assert.deepEqual(upgraded.rounds.map((r) => [r.verdict?.verdict ?? null, r.secondVerdict?.verdict ?? null]), words, name);
    assert.deepEqual(upgraded.rounds.map((r) => ({ ...r, verdict: null, secondVerdict: null })), storedReview(structuredClone(record)).rounds.map((r) => ({ ...r, verdict: null, secondVerdict: null })), `${name}: nothing else changes`);
  }
});

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
  for (const [name, record] of [...fixtures, ...worded]) {
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

/** upgradeAttempts as tick.ts had it at 9f7b5a5, run on every tick before the startup upgrade replaced it, kept as the proof's baseline. */
function tickUpgradeAttempts(attempts: Attempts): Attempts {
  const last: (FailedAttempt & { reading?: true }) | null = attempts.last;
  if (last?.reading !== true) return attempts;
  const { reading: _, ...readFailure } = last;
  return { ...noAttempts, readFailure } as Attempts;
}

/** What the upgrade gives since failed wakes for reading went to the usage hold: tickUpgradeAttempts, without the failure it kept apart. */
function droppingReadFailure(attempts: Attempts): Attempts {
  const { readFailure: _, ...kept } = tickUpgradeAttempts(attempts) as Attempts & { readFailure?: FailedAttempt };
  return kept;
}

const failure: FailedAttempt = { at: 1, code: "setup-failed", message: "the disk is full" };
const readFailure: FailedAttempt = { at: 2, code: "backend", message: "an earlier wake for reading" };
/** Every shape stored attempts take: each as this code saves them, and a failed wake for reading kept in `last`. */
const attemptFixtures: [string, Attempts][] = [
  ["no attempts", { count: 0, last: null }],
  ["a failed job", { count: 2, last: failure }],
  ["a failed wake for reading kept apart", { count: 0, last: null, readFailure } as Attempts],
  ["a failed job and a failed wake for reading kept apart", { count: 1, last: failure, readFailure } as Attempts],
  ["a failed wake for reading kept in last", { count: 1, last: { ...failure, reading: true } as FailedAttempt }],
  ["a failed wake for reading kept in last after failed jobs", { count: 3, last: { ...failure, reading: true } as FailedAttempt }],
];

test("the upgrade gives every stored-attempts fixture what tick's upgradeAttempts gave it, less a failed wake for reading, which an older tick and the upgrade leave as it is", () => {
  for (const [name, attempts] of attemptFixtures) {
    const { attempts: upgraded, readFailure: taken } = upgradeAttempts(structuredClone(attempts));
    assert.deepEqual(upgraded, droppingReadFailure(structuredClone(attempts)), name);
    const kept = (tickUpgradeAttempts(structuredClone(attempts)) as Attempts & { readFailure?: FailedAttempt }).readFailure;
    assert.deepEqual(taken, kept ?? null, `${name}: the failed wake for reading it drops is the one it hands the hold`);
    assert.deepEqual(tickUpgradeAttempts(structuredClone(upgraded)), upgraded, `${name}: an older control plane reads it unchanged`);
    assert.deepEqual(upgradeAttempts(structuredClone(upgraded)), { attempts: upgraded, readFailure: null }, `${name}: it upgrades no further`);
  }
});

test("a registry opened over a pylon's older attempts rewrites them upgraded once, with no event, and leaves current ones as they were", async (t) => {
  const path = join(await tempDir("record-upgrade", t), "registry.db");
  const first = seedRegistry(openRegistry(path));
  const older = addThread(first);
  const current = addThread(first);
  const legacy = attemptFixtures.at(-1)![1];
  const kept = attemptFixtures[1]![1];
  first.savePylon({ ...first.pylon(older.pylonId)!, attempts: legacy });
  first.savePylon({ ...first.pylon(current.pylonId)!, attempts: kept });
  const events = first.events("0", {}).length;
  first.close();

  const registry = testRegistry(t, path);
  assert.deepEqual(registry.pylon(older.pylonId)!.attempts, droppingReadFailure(structuredClone(legacy)));
  assert.deepEqual(registry.pylon(current.pylonId)!.attempts, kept);
  assert.equal(registry.events("0", {}).length, events, "the upgrade tells the event log nothing");
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const stored = (id: string) => JSON.parse((db.prepare("SELECT attempts FROM pylons WHERE id = ?").get(id) as { attempts: string }).attempts);
  assert.deepEqual(stored(older.pylonId), droppingReadFailure(structuredClone(legacy)), "the upgraded attempts are what the registry holds");
  assert.deepEqual(stored(current.pylonId), kept);
});

test("a registry opened over a failed wake for reading an older control plane kept on the pylon gives up the run's hold on it with the reason it gave", async (t) => {
  const path = join(await tempDir("record-upgrade", t), "registry.db");
  const first = seedRegistry(openRegistry(path));
  const held = addThread(first);
  first.setThreadStatus(held.id, "archived");
  first.startUsageBackfill([held.id], 1);
  first.holdUsageBackfill(held.id, 1);
  first.savePylon({ ...first.pylon(held.pylonId)!, attempts: { count: 0, last: null, readFailure: { at: 2, code: "setup-failed", message: "the disk is full" } } as Attempts });
  first.close();

  const opened = Date.now();
  const registry = testRegistry(t, path);
  assert.deepEqual(registry.pylon(held.pylonId)!.attempts, noAttempts);
  const hold = registry.usageHold();
  assert.deepEqual([hold?.by, hold?.thread, hold?.phase], ["run", held.id, "pausing"], "the hold waits for the pause, so the planner wakes the pylon no more");
  assert.ok(hold!.since >= opened, "the hold waits from the open, not from the old failure");
  const row = registry.usageBackfillThreads().find((r) => r.thread === held.id)!;
  assert.deepEqual([row.state, row.reason], ["skipped", "the pylon did not boot: setup-failed: the disk is full"]);
});

test("a job sent for reading that an older control plane marked `reading` is marked uncounted, and every other is left as it is", () => {
  const env = { jobId: "job-1" as JobId, node: "rj-firebat" as NodeName, issuedAt: "2026-11-08T00:00:00.000Z", notAfter: "2026-11-08T00:00:30.000Z", job: { kind: "delete", pylonId: "pylon-th-1" as PylonId } } as const;
  assert.deepEqual(upgradeSubmitted({ ...env, reading: true }), { ...env, uncounted: true });
  assert.deepEqual(upgradeSubmitted({ ...env, uncounted: true }), { ...env, uncounted: true });
  assert.deepEqual(upgradeSubmitted(env), env);
  assert.equal(upgradeSubmitted(null), null);
});
