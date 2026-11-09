/**
 * Reviews in every phase the review loop has, for the golden captures: builder threads added to the demo world after
 * seedDemo, each with a linked pull request and a review, so each phase's note, each reviewer seat, each kind of
 * second reviewer and each failing model shows in the API, `nexus show` and the thread page.
 */
import { createHash } from "node:crypto";
import type { testApi } from "../test-support/api-kit.ts";
import type { PullRequest } from "../control/github.ts";
import { caseOf, personOnly, waivedName, type Hold } from "../control/holds.ts";
import { reservedNames } from "../contract/reserved.ts";
import type { HeldQuestion } from "../control/questions.ts";
import { holdOptions } from "../contract/reviews.ts";
import { personPhase, type ModelFailure, type Review, type Round, type SecondReviewer, type Verdict } from "../control/review-model.ts";
import type { Thread } from "../control/thread-store.ts";
import type { ThreadId } from "../ids.ts";
import { reviewerCaller } from "../control/agent-protocol.ts";

type Demo = Awaited<ReturnType<typeof testApi>>;

const minute = 60_000;
const hour = 60 * minute;
const repos: Record<string, string> = { nexus: "ramtinJ95/nexus", storefront: "ramtinJ95/storefront" };

const head = (seed: string) => seed.repeat(40).slice(0, 40);
const finding = (id: string, priority: "P0" | "P1" | "P2" | "P3", where: string, summary: string) => ({ id, priority, where, summary, detail: null });
const verdict = (...findings: ReturnType<typeof finding>[]): Verdict =>
  ({ token: "t", verdict: findings.some((f) => f.priority !== "P3") ? "changes" : "approve", findings, reserved: [], notCheckedLive: null });
const round = (h: string, over: Partial<Round> = {}): Round => ({ head: head(h), base: "main", verdict: null, check: null, answers: null, ...over });
const passed = { passed: true, output: "ℹ tests 412\nℹ pass 412\nℹ fail 0" };
const failing = (count: number, last: string): ModelFailure => ({ count, last, retryAt: Date.now() + 3 * minute });
const second = (t: Thread, over: Partial<Extract<SecondReviewer, { kind: "claude" }>> = {}): SecondReviewer => ({
  kind: "claude", rule: "the change touches src/control/", thread: `${t.id}-second` as ThreadId, model: "claude-sonnet-5-5",
  expect: "t2", asked: "", since: Date.now() - 12 * minute, nudges: 0, outbox: null, ...over,
});

interface Spec {
  key: string;
  project: "nexus" | "storefront";
  number: number;
  title: string;
  review: (t: Thread) => Partial<Review>;
  /** What happens to the review's threads once it is saved, as the person did it. */
  after?: (d: Demo, t: Thread, r: Review) => Promise<void> | void;
}

const specs: Spec[] = [
  {
    key: "rv-reviewing-starting", project: "nexus", number: 410, title: "feat(cli): nexus threads --watch",
    review: () => ({
      rounds: [round("1a", { secondVerdict: null })],
      second: { kind: "starting", rule: "the change touches src/cli/", model: "claude-sonnet-5-5", since: Date.now() - 2 * minute, tried: null, why: null },
      phase: { kind: "reviewing", check: { startedAt: Date.now() - minute, thread: null } },
    }),
  },
  {
    key: "rv-reviewing-failing", project: "nexus", number: 411, title: "fix(probe): report a full disk before a boot fails",
    review: () => ({
      rounds: [round("2b", { secondVerdict: null })],
      second: { kind: "starting", rule: "the change touches src/probe/", model: "claude-sonnet-5-5", since: Date.now() - 15 * minute, tried: Date.now() - 5 * minute, why: "no node had room for a 4 GiB pylon" },
      phase: { kind: "reviewing", failing: failing(2, "429 Too Many Requests: rate limit reached for gpt-6-astra") },
    }),
  },
  {
    key: "rv-reviewing-second", project: "nexus", number: 412, title: "refactor(control): one module per node phase",
    review: (t) => ({
      reviewerKind: "claude", models: { builder: "claude-opus-5-5", reviewer: "claude-sonnet-5-5" },
      rounds: [
        round("3c", {
          verdict: verdict(finding("F1", "P1", "src/control/loop.ts:310", "The pause pass now runs before placement, so a pylon placed this pass pauses at once.")),
          secondVerdict: verdict(finding("F1", "P2", "src/control/boots.ts", "The boot module re-exports placement's types.")),
          answers: [{ id: "F1", action: "fixed", reason: "Placement runs first again." }, { id: "2.F1", action: "fixed", reason: "Imported from placement directly." }],
        }),
        round("3d", { verdict: verdict(), secondVerdict: null }),
      ],
      second: second(t, { model: "claude-haiku-5-5", failing: failing(3, "overloaded_error: Overloaded") }),
      phase: { kind: "reviewing" },
    }),
  },
  {
    key: "rv-fixing-failing", project: "storefront", number: 92, title: "fix(checkout): keep the shipping quote across a reload",
    review: (t) => ({
      rounds: [round("4e", {
        verdict: verdict(finding("F1", "P2", "src/checkout/Shipping.tsx:58", "The quote is read from sessionStorage before the cart loads.")),
        secondVerdict: verdict(finding("F1", "P1", "src/checkout/quote.ts:22", "A stale quote outlives a changed address."), finding("F2", "P3", "src/checkout/quote.ts", "Name the 15-minute expiry.")),
      })],
      second: second(t, { rule: "the change touches checkout" }),
      phase: { kind: "fixing", failing: failing(1, "500 Internal Server Error from claude-opus-5-5") },
    }),
  },
  {
    key: "rv-checking", project: "storefront", number: 93, title: "feat(search): rank exact SKU matches first",
    review: (t) => ({
      rounds: [round("5f", { verdict: verdict(finding("N1", "P3", "src/search/rank.ts", "The boost could be a named constant.")), secondVerdict: verdict() })],
      second: second(t, { rule: "the change touches search ranking" }),
      phase: { kind: "checking", startedAt: Date.now() - 3 * minute, thread: `${t.id}-check` as ThreadId },
    }),
  },
  {
    key: "rv-verifying", project: "storefront", number: 94, title: "feat(cart): save the cart for a signed-out shopper",
    review: () => ({
      rounds: [round("6a", { verdict: verdict(), check: passed })],
      phase: { kind: "verifying", startedAt: Date.now() - 2 * minute, thread: null, refused: "rj-firebat has 2 GiB free, under the 4 GiB a verify pylon needs" },
    }),
  },
  {
    key: "rv-quoting-failing", project: "storefront", number: 95, title: "fix(orders): show refunds on the order page",
    review: () => ({
      land: { requestedBy: "laptop" },
      rounds: [round("7b", { verdict: verdict(), check: passed, live: { kind: "absent" } })],
      phase: { kind: "quoting", asked: null, failing: failing(4, "429 Too Many Requests: rate limit reached for gpt-6-astra") },
    }),
  },
  {
    key: "rv-approved", project: "storefront", number: 96, title: "chore(deps): bump stripe-js to 5.2",
    review: () => ({
      reviewerKind: "claude", models: { builder: "claude-opus-5-5", reviewer: "claude-sonnet-5-5" },
      rounds: [round("8c", { verdict: verdict(), check: passed, live: { kind: "absent" } })],
      phase: { kind: "approved" },
    }),
  },
  {
    key: "rv-merging", project: "nexus", number: 413, title: "fix(secrets): rotate the broker's signing key on deploy",
    review: () => ({
      land: { requestedBy: "laptop" },
      rounds: [round("9d", { verdict: verdict(), check: passed, live: { kind: "ran", thread: "th-verify-413" as ThreadId, passed: true, output: "ok rotate: new key in 0.8 s" } })],
      waiver: { head: head("9d"), holds: [`${personOnly}${reservedNames.secrets}, as it changes src/control/secrets.ts.`], codes: ["reserved-path:secrets"], by: "laptop", at: Date.now() - 4 * minute, change: null },
      phase: { kind: "merging", authorized: head("9d") },
    }),
  },
  {
    key: "rv-merging-waiting", project: "nexus", number: 414, title: "feat(dashboard): show each node's release",
    review: () => ({
      land: { requestedBy: "laptop" },
      rounds: [round("ae", { verdict: verdict(), check: passed, live: { kind: "absent" } })],
      phase: { kind: "merging", authorized: null, waiting: "another landing that deploys is under way, #413" },
    }),
  },
  {
    key: "rv-deploying", project: "nexus", number: 415, title: "fix(control): close idle SSE streams after 10 minutes",
    review: () => ({
      land: { requestedBy: "laptop" }, merged: head("c1"),
      rounds: [round("bf", { verdict: verdict(), check: passed, live: { kind: "absent" } })],
      phase: { kind: "deploying", commit: head("c1"), previous: null, requested: false, deadline: Date.now() + 10 * minute },
    }),
  },
  {
    key: "rv-rolling-back", project: "nexus", number: 416, title: "perf(registry): index events by thread",
    review: () => ({
      land: { requestedBy: "laptop" }, merged: head("c2"),
      rounds: [round("c0", { verdict: verdict(), check: passed, live: { kind: "absent" } })],
      phase: { kind: "rolling-back", commit: head("c2"), previous: head("fa"), why: "rj-firebat's control plane did not turn healthy in 5 minutes: the migration timed out", requested: true, deadline: Date.now() + 6 * minute },
    }),
  },
  {
    key: "rv-landed", project: "nexus", number: 417, title: "docs: the review loop's phases",
    review: () => ({
      land: { requestedBy: "laptop" }, merged: head("c3"),
      rounds: [round("d0", { verdict: verdict(), check: passed, live: { kind: "absent" } })],
      phase: { kind: "landed", commit: head("c3") },
    }),
  },
  {
    key: "rv-needs-person-holds", project: "storefront", number: 97, title: "feat(db): drop the legacy carts table",
    review: () => ({
      rounds: [round("e0", { verdict: { ...verdict(), notCheckedLive: "## Not checked live\n\nThe drop against production's 2 million rows." }, check: passed, live: { kind: "absent" } })],
      second: { kind: "none", rule: "the change touches migrations/", why: "no Claude model other than the builder's and the reviewer's could run" },
      phase: personPhase("policy", ...holds),
    }),
    after(d, t, r) {
      const { head: at, base } = r.rounds.at(-1)!;
      const asked: HeldQuestion = { review: r.id, head: at, base: base ?? null, holds };
      // The ID as review.ts's holdsQuestion makes it, which sorts the holds by code then text first.
      const sorted = holds.toSorted((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
      const id = `holds-${r.id}-${createHash("sha256").update(JSON.stringify([at, base ?? null, sorted])).digest("hex").slice(0, 16)}`;
      const short = at.slice(0, 12);
      const text = `Land pull request #${r.pr.number}, "${r.pr.title}", at ${short}, waiving ${[...new Set(holds.map((h) => waivedName(h.code)))].join(" and ")}?
${holds.map((h) => `- ${h.text}`).join("\n")}
Land waives these at ${short}, and at a rebase of it that leaves the change as it is. Nexus still lands it only once the reviewer approves it and its checks pass. Leave it, and nothing is waived.`;
      d.registry.questions.askQuestion({
        kind: "holds", id, thread: t.id, text, options: holdOptions, reserved: holds.map((h) => caseOf(h.code)).find((c) => c !== null) ?? null,
        answerer: "deployer", askedAt: Date.now() - 8 * minute, holds: asked,
      });
    },
  },
  {
    key: "rv-merged", project: "storefront", number: 98, title: "fix(emails): the receipt's VAT line",
    review: () => ({ rounds: [round("f0", { verdict: verdict(finding("F1", "P2", "src/emails/receipt.tsx", "VAT rounds per line.")) })], phase: { kind: "merged" } }),
  },
  {
    key: "rv-closed", project: "storefront", number: 99, title: "feat(home): autoplay the hero video",
    review: () => ({ rounds: [round("f1")], phase: { kind: "closed" } }),
  },
  {
    key: "rv-cancelled-person", project: "nexus", number: 418, title: "feat(cli): nexus logs --follow",
    review: () => ({ rounds: [round("f2")], phase: { kind: "cancelled", who: "person", by: "laptop" } }),
  },
  {
    key: "rv-cancelled-builder", project: "nexus", number: 419, title: "chore: drop the v1 attach route",
    review: () => ({ rounds: [round("f3", { verdict: verdict() })], phase: { kind: "cancelled", who: "builder", status: "archived" } }),
    async after(d, t) {
      const res = await d.call("POST", `/v1/threads/${t.id}/archive`);
      if (res.status !== 200) throw new Error(`archiving ${t.id}: ${JSON.stringify(res.body)}`);
    },
  },
  {
    key: "rv-cancelled-reviewer", project: "storefront", number: 100, title: "fix(cart): a coupon applies once per cart",
    review: () => ({ rounds: [round("f4")], phase: { kind: "cancelled", who: "reviewer", status: "deleted" } }),
    async after(d, _, r) {
      const res = await d.call("DELETE", `/v1/threads/${r.reviewer}`);
      if (res.status !== 200) throw new Error(`deleting ${r.reviewer}: ${JSON.stringify(res.body)}`);
    },
  },
];

/** A policy hold the paths decide, and one for the second reviewer the project asks for but that could not run. */
const holds: Hold[] = [
  { code: "reserved-path:destructive-migration", text: `${personOnly}${reservedNames["destructive-migration"]}, as it changes migrations/0042_drop_legacy_carts.sql.` },
  { code: "no-second-reviewer", text: "The project asks for a second reviewer here, but none ran: no Claude model other than the builder's and the reviewer's could run." },
];

export async function seedReviews(d: Demo): Promise<[key: string, thread: Thread][]> {
  const out: [string, Thread][] = [];
  for (const spec of specs) {
    const res = await d.call("POST", "/v1/threads", { project: spec.project, title: spec.title });
    if (res.status !== 201) throw new Error(`starting ${spec.key}: ${JSON.stringify(res.body)}`);
    const t = res.body as Thread;
    const repo = repos[spec.project]!;
    const pr: PullRequest = { repo, number: spec.number, title: spec.title, url: `https://github.com/${repo}/pull/${spec.number}`, state: "open", checks: "passing", review: "none", conflict: false };
    d.registry.prWatches.savePrWatch(t.id, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
    // A review whose reviewer thread the person deletes needs that thread to exist.
    const reviewer = spec.key === "rv-cancelled-reviewer"
      ? (await d.startThread({ request: { project: spec.project, title: `Review of #${spec.number}: ${spec.title}` }, caller: reviewerCaller, role: "reviewer" })).id
      : `${t.id}-review` as ThreadId;
    const r: Review = {
      id: `rv-${spec.number}`, builder: t.id, reviewer, pr: { repo, number: spec.number, url: pr.url, title: spec.title, branch: `nexus/${spec.number}` },
      reviewerKind: "harness", models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, maxRounds: 5, land: null, auto: true, merged: null, waiver: null,
      expect: `rv-${spec.number}:t`, sent: 2, outbox: null, asked: "", since: Date.now() - 10 * minute, nudges: 0, startedAt: Date.now() - 2 * hour,
      rounds: [], phase: { kind: "reviewing" }, ...spec.review(t),
    };
    d.registry.reviews.saveReview(r);
    await spec.after?.(d, t, r);
    out.push([spec.key, d.registry.threads.thread(t.id)!]);
  }
  return out;
}
