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
import { answered, blocks, findingsOf, type ReservedCase, type Review } from "./review.ts";

export const reservedNames: Readonly<Record<ReservedCase, string>> = {
  secrets: "changes to secrets", egress: "changes to the egress allowlist", auth: "changes to login or auth", tailnet: "changes to the tailnets",
  "destructive-migration": "database migrations that delete or rewrite existing data", "image-rebuild": "pylon image rebuilds",
  "cli-breaking": "breaking changes to the CLI's contract", irreversible: "anything irreversible",
};

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

const personOnly = "Always needs the person: ";

/**
 * What a hold is, which decides its rule, and its text, which only the person reads. A reserved case the reviewer
 * named and one the paths hit are separate codes, so a waiver of the one the person saw never covers the other.
 * `loop` is a reason of the review loop's own, such as a deploy's failure, and `stale-head` the line a held review
 * gains when its head moves.
 */
export type HoldCode =
  | "same-model" | "not-approved" | "open-findings" | "unanswered" | "check-failed" | "live-failed" | "github-checks"
  | "not-approved-head" | "conflict" | "pr-not-open" | "not-checked-live" | "claude-approved" | "check-changed"
  | "verify-changed" | `reserved:${ReservedCase}` | `reserved-path:${ReservedCase}` | "stale-head" | "loop";
export interface Hold { code: HoldCode; text: string }
const hold = (code: HoldCode, text: string): Hold => ({ code, text });
const cases = Object.keys(reservedNames) as ReservedCase[];

/** The holds the review's record alone decides: they hold every landing of its approved head, whatever GitHub says. */
export const recordedHolds = (review: Review): Hold[] => [
  ...review.reviewerKind === "claude" ? [hold("claude-approved", "A Claude reviewer approved it. Its verdict is read from its transcript in its pylon, where code it runs could write, so only the person can land what it approved.")] : [],
  ...(review.rounds.at(-1)!.verdict?.reserved ?? []).map((r) => hold(`reserved:${r.case}`, `${personOnly}${reservedNames[r.case]}, by the reviewer's reading (${r.why}).`)),
];

/** What the holds currently on a review are: those its landing met, or else those its record alone decides. */
export const heldBy = (review: Review): Hold[] => review.phase.kind === "needs-person" ? review.phase.holds : recordedHolds(review);

/** Whether a hold meets every landing of the same approved head again, and whether the person may waive it, and why. */
export interface HoldRule { holdsAgain: boolean; waivable: boolean; why: string }
const reserved: HoldRule = { holdsAgain: true, waivable: true, why: "The policy reserves this for you, and pressing Land here is you waiving it." };
const notWaivable = (why: string): HoldRule => ({ holdsAgain: false, waivable: false, why });
const loopRule = notWaivable("Only what the policy reserves for you can be waived.");
const holdRules: Record<HoldCode, HoldRule> = {
  ...Object.fromEntries(cases.flatMap((c) => [[`reserved:${c}`, reserved], [`reserved-path:${c}`, reserved]])) as Record<`reserved:${ReservedCase}` | `reserved-path:${ReservedCase}`, HoldRule>,
  "check-changed": { holdsAgain: true, waivable: true, why: "Accepting a new .nexus/check is yours, and pressing Land here is you accepting it." },
  "verify-changed": { holdsAgain: true, waivable: true, why: "Accepting a new .nexus/verify is yours, and pressing Land here is you accepting it." },
  "claude-approved": { holdsAgain: true, waivable: false, why: "Nothing here stands in for a harness reviewer's approval: the Claude reviewer's verdict, its findings and reserved cases included, could have been written by code in its pylon." },
  "not-approved": notWaivable("Open P0 to P2 findings hold every landing until they are fixed and the reviewer approves."),
  "open-findings": notWaivable("Open P0 to P2 findings hold every landing until they are fixed and the reviewer approves."),
  unanswered: notWaivable("Every P0 to P2 finding needs the builder's fix or its reason to reject."),
  "check-failed": notWaivable("Only a .nexus/check that passed at the approved head lands."),
  "live-failed": notWaivable("A repository with a .nexus/verify lands only once its live check passed at the approved head."),
  "github-checks": notWaivable("Failing or pending GitHub checks hold every landing until they pass."),
  "not-approved-head": notWaivable("Only the commit the reviewer approved lands."),
  conflict: notWaivable("A branch that conflicts with its base cannot merge."),
  "pr-not-open": notWaivable("Only an open pull request lands."),
  "same-model": notWaivable("The policy needs a reviewer on another model than the builder's."),
  "not-checked-live": notWaivable("The description must say what could not be checked live, which the builder can add."),
  "stale-head": loopRule,
  loop: loopRule,
};
export const holdRule = (code: HoldCode): HoldRule => holdRules[code];
export const waivable = (code: HoldCode) => holdRule(code).waivable;

/**
 * The code a hold's text had under the text rules, which reads records saved before holds carried codes: a
 * needs-person phase with only reasons, and a waiver with only texts.
 */
export function legacyHoldCode(text: string): HoldCode {
  for (const c of cases) {
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
