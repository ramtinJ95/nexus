import { test } from "node:test";
import assert from "node:assert/strict";
import { builderAwaited, cancellable, ended, inLanding, kindsWhere, landingVerb, settled, waitsOnPerson, type Phase, type PhaseKind, type Review } from "./review-model.ts";

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
