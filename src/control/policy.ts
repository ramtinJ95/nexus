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
import { blocks, findingsOf, type ReservedCase, type Review } from "./review.ts";

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

/**
 * Nexus paths that may touch a reserved case. A registry migration counts as irreversible even when it adds only: a
 * control plane refuses a registry newer than its code, so a rollback past one cannot start.
 */
const reservedPaths: readonly { case: ReservedCase; matches(path: string, patch: string): boolean }[] = [
  { case: "secrets", matches: (p) => /secret|credential/i.test(p) || p.startsWith("deploy/") },
  { case: "egress", matches: (p) => ["src/project.ts", "src/control/threads.ts", "src/control/live.ts"].includes(p) || p.startsWith("src/pylon-vm") || /network|egress|allowlist/i.test(p) },
  { case: "auth", matches: (p) => ["src/control/api.ts", "src/control/main.ts", "src/control/login.ts", "src/control/releases.ts", "src/control/attach.ts", "src/control/policy.ts"].includes(p) || p.startsWith("src/probe/") || p.startsWith("src/deploy/") || /auth|login|whois/i.test(p) },
  { case: "tailnet", matches: (p) => /tailnet|tailscale/i.test(p) },
  { case: "image-rebuild", matches: (p) => p.startsWith("images/") || p === "src/agent-setup.ts" },
  { case: "irreversible", matches: (p, patch) => p === "src/control/registry.ts" && (patch === "" || /^@@.*\bmigrations\b|^\+.*\b(CREATE|ALTER|DROP) (TABLE|INDEX)\b/im.test(patch)) },
  { case: "irreversible", matches: (p, patch) => p === "package.json" && (patch === "" || /^[+-].*@earendil-works\/pi-durable/m.test(patch)) },
];

const personOnly = "Always needs the person: ";
const claudeApproved = "A Claude reviewer approved it. Its verdict is read from its transcript in its pylon, where code it runs could write, so only the person can land what it approved.";
const checkChanged = "The pull request changes .nexus/check, the check this policy relies on.";

/** The holds the review's record alone decides: they hold every landing of its approved head, whatever GitHub says. */
export const recordedHolds = (review: Review): string[] => [
  ...review.reviewerKind === "claude" ? [claudeApproved] : [],
  ...(review.rounds.at(-1)!.verdict?.reserved ?? []).map((r) => `${personOnly}${reservedNames[r.case]}, by the reviewer's reading (${r.why}).`),
];

/** What the holds currently on a review are: those its landing met, or else those its record alone decides. */
export const heldBy = (review: Review): string[] => review.phase.kind === "needs-person" ? review.phase.reasons : recordedHolds(review);

/**
 * Whether a hold meets every landing of the same approved head again, and whether the person may waive it, and why.
 * The first rule a reason matches decides. A reason none matches, such as a deploy's failure, is the loop's own and
 * nothing to waive.
 */
export interface HoldRule { holdsAgain: boolean; waivable: boolean; why: string }
const holdRules: readonly [(reason: string) => boolean, HoldRule][] = [
  [(r) => r.startsWith(personOnly), { holdsAgain: true, waivable: true, why: "The policy reserves this for you, and pressing Land here is you waiving it." }],
  [(r) => r === checkChanged, { holdsAgain: true, waivable: true, why: "Accepting a new .nexus/check is yours, and pressing Land here is you accepting it." }],
  [(r) => r === claudeApproved, { holdsAgain: true, waivable: false, why: "Nothing here stands in for a harness reviewer's approval: the Claude reviewer's verdict, its findings and reserved cases included, could have been written by code in its pylon." }],
  [(r) => /^Findings P0 to P2 are open|^The reviewer has not approved/.test(r), { holdsAgain: false, waivable: false, why: "Open P0 to P2 findings hold every landing until they are fixed and the reviewer approves." }],
  [(r) => r.startsWith("The builder neither fixed nor rejected"), { holdsAgain: false, waivable: false, why: "Every P0 to P2 finding needs the builder's fix or its reason to reject." }],
  [(r) => r.startsWith(".nexus/check "), { holdsAgain: false, waivable: false, why: "Only a .nexus/check that passed at the approved head lands." }],
  [(r) => /GitHub checks are/.test(r), { holdsAgain: false, waivable: false, why: "Failing or pending GitHub checks hold every landing until they pass." }],
  [(r) => /, not the approved /.test(r), { holdsAgain: false, waivable: false, why: "Only the commit the reviewer approved lands." }],
  [(r) => r === "The branch conflicts with its base.", { holdsAgain: false, waivable: false, why: "A branch that conflicts with its base cannot merge." }],
  [(r) => /^Pull request #\d+ is /.test(r), { holdsAgain: false, waivable: false, why: "Only an open pull request lands." }],
  [(r) => r.startsWith("The reviewer ran the builder's own model"), { holdsAgain: false, waivable: false, why: "The policy needs a reviewer on another model than the builder's." }],
  [(r) => /could not be checked live/.test(r), { holdsAgain: false, waivable: false, why: "The description must say what could not be checked live, which the builder can add." }],
];
const otherHold: HoldRule = { holdsAgain: false, waivable: false, why: "Only what the policy reserves for you can be waived." };
export const holdRule = (reason: string): HoldRule => holdRules.find(([matches]) => matches(reason))?.[1] ?? otherHold;
/** Whether a reason holds every landing of the same approved head again. Landing again gets past it only if the person waives it. */
export const holdsAgain = (reason: string) => holdRule(reason).holdsAgain;
export const waivable = (reason: string) => holdRule(reason).waivable;

/** The one hold the review loop answers itself, by having the builder rebase. */
export const conflictHold = "The branch conflicts with its base.";

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const conditions: readonly ((facts: LandingFacts) => string[])[] = [
  ({ review }) => review.models.reviewer === review.models.builder ? [`The reviewer ran the builder's own model, ${review.models.builder}.`] : [],
  ({ review }) => {
    const round = review.rounds.at(-1)!;
    if (round.verdict?.verdict !== "approve") return ["The reviewer has not approved the latest commits."];
    const open = findingsOf(round).filter(blocks);
    return open.length ? [`Findings P0 to P2 are open: ${open.map((f) => f.id).join(", ")}.`] : [];
  },
  ({ review }) => review.rounds.flatMap((round, i) => findingsOf(round).filter(blocks)
    .filter((f) => !round.answers?.some((a) => a.id === f.id && (a.action === "fixed" || a.reason.trim() !== "")))
    .map((f) => `The builder neither fixed nor rejected with a reason finding ${f.id} of round ${i + 1}.`)),
  ({ review }) => {
    const round = review.rounds.at(-1)!;
    if (round.check === null) return [`.nexus/check has not run at ${round.head}.`];
    return round.check.passed ? [] : [`.nexus/check failed at ${round.head}.`];
  },
  ({ review, pr }) => {
    const head = review.rounds.at(-1)!.head;
    // A PR merged outside the review is held on what can still be judged: which head merged.
    if (pr.pr.state === "merged") return pr.detail.head === head ? [] : [`Pull request #${pr.pr.number} merged at ${pr.detail.head}, not the approved ${head}.`];
    if (pr.pr.state !== "open") return [`Pull request #${pr.pr.number} is ${pr.pr.state}.`];
    return [
      ...pr.detail.head === head ? [] : [`The pull request's head is ${pr.detail.head}, not the approved ${head}.`],
      ...pr.pr.conflict === true ? [conflictHold] : [],
      ...pr.pr.checks === "failed" || pr.pr.checks === "pending" ? [`The pull request's GitHub checks are ${pr.pr.checks}.`] : [],
    ];
  },
  // No verify stack exists yet (docs/design.md, open questions), so every PR lands on its statement of what it could not check live.
  ({ review, pr }) => {
    const quoted = review.rounds.at(-1)!.verdict?.notCheckedLive ?? null;
    if (quoted === null || squash(quoted).length < 20) return ["No live check ran, and the pull request does not say what could not be checked live."];
    return squash(pr.detail.body).includes(squash(quoted)) ? [] : ["The reviewer's quote of what could not be checked live is not in the pull request's description."];
  },
  ({ review }) => recordedHolds(review),
  ({ files }) => files.some((f) => f.path === ".nexus/check" || f.previous === ".nexus/check") ? [checkChanged] : [],
  ({ files, nexus }) => {
    if (!nexus) return [];
    const hits = new Map<ReservedCase, string[]>();
    for (const file of files) {
      for (const path of [file.path, ...file.previous === null ? [] : [file.previous]]) {
        for (const rule of reservedPaths) if (rule.matches(path, file.patch)) hits.set(rule.case, [...new Set([...hits.get(rule.case) ?? [], path])]);
      }
    }
    return [...hits].map(([c, paths]) => `${personOnly}${reservedNames[c]}, as it changes ${paths.join(", ")}.`);
  },
];

/** Why the policy holds this landing for the person, or nothing when an agent may merge and deploy it. */
export function landingHolds(facts: LandingFacts): string[] {
  return conditions.flatMap((condition) => condition(facts));
}

/** The holds that still hold the review's landing once the person's waiver at the approved head lets it past those it names. */
export function unwaived(review: Review, holds: readonly string[]): string[] {
  const { waiver } = review;
  return holds.filter((reason) => !(waiver !== null && waiver.head === review.rounds.at(-1)!.head && waiver.holds.includes(reason) && waivable(reason)));
}
