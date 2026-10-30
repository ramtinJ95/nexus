/**
 * The merge policy, docs/merge-policy.md, as the checks a landing runs before it merges. Each condition answers the
 * reasons it fails, so a held landing tells the person exactly which ones, all at once.
 *
 * Most conditions read what the review loop recorded. The reserved cases come from two places that must both be
 * clear: the reviewer's classification, and, for Nexus's own pull requests, the changed paths. Text in the PR can
 * mislead the reviewer but cannot change its paths, so the path list is drawn wide: a path that might touch a
 * reserved case holds the landing for the person, who can merge it themselves. It is a list, so a reserved change in
 * a file it does not name still rests on the reviewer alone.
 *
 * The holds that always need the person are theirs to waive, by pressing Land on the dashboard. Every other condition
 * is one no person can waive: it clears only when what failed changes.
 */
import type { ChangedFile, PrSnapshot } from "./github.ts";
import { personOnly, reservedNames, waivable, type Hold, type HoldCode, type ReservedCase } from "./holds.ts";
import { answered, blocks, findingsOf, type Review } from "./review-model.ts";

export interface LandingFacts {
  review: Review;
  pr: PrSnapshot;
  files: readonly ChangedFile[];
  /** Whether the PR is Nexus's own, whose paths this module knows. */
  nexus: boolean;
}

/** Whether `path` names `pattern`. Nothing under docs/ deploys, so its names reserve nothing. */
const names = (path: string, pattern: RegExp) => !path.startsWith("docs/") && pattern.test(path);

/**
 * Nexus paths that may touch a reserved case. A registry migration counts as irreversible even when it adds only: a
 * control plane refuses a registry newer than its code, so a rollback past one cannot start.
 */
const reservedPaths: readonly { case: ReservedCase; matches(path: string, patch: string): boolean }[] = [
  { case: "secrets", matches: (p) => names(p, /secret|credential/i) || p.startsWith("deploy/") },
  { case: "egress", matches: (p) => ["src/project.ts", "src/control/threads.ts", "src/control/live.ts"].includes(p) || p.startsWith("src/pylon-vm") || names(p, /network|egress|allowlist/i) },
  { case: "auth", matches: (p) => ["src/control/api.ts", "src/control/main.ts", "src/control/login.ts", "src/control/releases.ts", "src/control/attach.ts", "src/control/policy.ts"].includes(p) || p.startsWith("src/probe/") || p.startsWith("src/deploy/") || names(p, /auth|login|whois/i) },
  { case: "tailnet", matches: (p) => names(p, /tailnet|tailscale/i) },
  { case: "image-rebuild", matches: (p) => p.startsWith("images/") || p === "src/agent-setup.ts" },
  { case: "irreversible", matches: (p, patch) => p === "src/control/registry.ts" && (patch === "" || /^@@.*\bmigrations\b|^\+.*\b(CREATE|ALTER|DROP) (TABLE|INDEX)\b/im.test(patch)) },
  { case: "irreversible", matches: (p, patch) => p === "package.json" && (patch === "" || /^[+-].*@earendil-works\/pi-durable/m.test(patch)) },
];

const hold = (code: HoldCode, text: string): Hold => ({ code, text });

/** The holds the review's record alone decides: they hold every landing of its approved head, whatever GitHub says. */
export const recordedHolds = (review: Review): Hold[] => [
  ...review.reviewerKind === "claude" ? [hold("claude-approved", "A Claude reviewer approved it. Its verdict is read from its transcript in its pylon, where code it runs could write, so only the person can land what it approved.")] : [],
  ...(review.rounds.at(-1)!.verdict?.reserved ?? []).map((r) => hold(`reserved:${r.case}`, `${personOnly}${reservedNames[r.case]}, by the reviewer's reading (${r.why}).`)),
];

/** What the holds currently on a review are: those its landing met, or else those its record alone decides. */
export const heldBy = (review: Review): Hold[] => review.phase.kind === "needs-person" ? review.phase.holds : recordedHolds(review);

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const conditions: readonly ((facts: LandingFacts) => Hold[])[] = [
  ({ review }) => review.models.reviewer === review.models.builder ? [hold("same-model", `The reviewer ran the builder's own model, ${review.models.builder}.`)] : [],
  ({ review }) => {
    const round = review.rounds.at(-1)!;
    if (round.verdict?.verdict !== "approve") return [hold("not-approved", "The reviewer has not approved the latest commits.")];
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
    const quoted = round.verdict?.notCheckedLive ?? null;
    if (quoted === null || squash(quoted).length < 20) return [hold("not-checked-live", "No live check ran, and the pull request does not say what could not be checked live.")];
    return squash(pr.detail.body).includes(squash(quoted)) ? [] : [hold("not-checked-live", "The reviewer's quote of what could not be checked live is not in the pull request's description.")];
  },
  ({ review }) => recordedHolds(review),
  ({ files }) => files.some((f) => f.path === ".nexus/check" || f.previous === ".nexus/check") ? [hold("check-changed", "The pull request changes .nexus/check, the check this policy relies on.")] : [],
  ({ files }) => files.some((f) => f.path === ".nexus/verify" || f.previous === ".nexus/verify") ? [hold("verify-changed", "The pull request changes .nexus/verify, the live check this policy relies on.")] : [],
  ({ files, nexus }) => {
    if (!nexus) return [];
    const hits = new Map<ReservedCase, string[]>();
    for (const file of files) {
      for (const path of [file.path, ...file.previous === null ? [] : [file.previous]]) {
        for (const rule of reservedPaths) if (rule.matches(path, file.patch)) hits.set(rule.case, [...new Set([...hits.get(rule.case) ?? [], path])]);
      }
    }
    return [...hits].map(([c, paths]) => hold(`reserved-path:${c}`, `${personOnly}${reservedNames[c]}, as it changes ${paths.join(", ")}.`));
  },
];

/** Why the policy holds this landing for the person, or nothing when an agent may merge and deploy it. */
export function landingHolds(facts: LandingFacts): Hold[] {
  return conditions.flatMap((condition) => condition(facts));
}

/** The holds that still hold the review's landing once the person's waiver at the approved head lets it past those it names. */
export function unwaived(review: Review, holds: readonly Hold[]): Hold[] {
  const { waiver } = review;
  return holds.filter((h) => !(waiver !== null && waiver.head === review.rounds.at(-1)!.head && waiver.codes.includes(h.code) && waivable(h.code)));
}
