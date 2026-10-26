/**
 * The merge policy, docs/merge-policy.md, as the checks a landing runs before it merges. Each condition answers the
 * reasons it fails, so a held landing tells the person exactly which ones, all at once.
 *
 * Most conditions read what the review loop recorded. The reserved cases come from two places that must both be
 * clear: the reviewer's classification, and, for Nexus's own pull requests, the changed paths. Text in the PR can
 * mislead the reviewer but cannot change its paths, so the path list is drawn wide: a path that might touch a
 * reserved case holds the landing for the person, who can merge it themselves. It is a list, so a reserved change in
 * a file it does not name still rests on the reviewer alone.
 */
import type { ChangedFile, PrSnapshot } from "./github.ts";
import { findingsOf, type ReservedCase, type Review } from "./review.ts";

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

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const conditions: readonly ((facts: LandingFacts) => string[])[] = [
  ({ review }) => review.models.reviewer === review.models.builder ? [`The reviewer ran the builder's own model, ${review.models.builder}.`] : [],
  ({ review }) => review.reviewerKind === "claude" ? ["A Claude reviewer approved it. Its verdict is read from its transcript in its pylon, where code it runs could write, so only the person can land what it approved."] : [],
  ({ review }) => {
    const round = review.rounds.at(-1)!;
    if (round.verdict?.verdict !== "approve") return ["The reviewer has not approved the latest commits."];
    const serious = findingsOf(round).filter((f) => f.severity === "serious");
    return serious.length ? [`Serious findings are open: ${serious.map((f) => f.id).join(", ")}.`] : [];
  },
  ({ review }) => review.rounds.flatMap((round, i) => findingsOf(round)
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
      ...pr.pr.conflict === true ? ["The branch conflicts with its base."] : [],
      ...pr.pr.checks === "failed" || pr.pr.checks === "pending" ? [`The pull request's GitHub checks are ${pr.pr.checks}.`] : [],
    ];
  },
  // No verify stack exists yet (docs/design.md, open questions), so every PR lands on its statement of what it could not check live.
  ({ review, pr }) => {
    const quoted = review.rounds.at(-1)!.verdict?.notCheckedLive ?? null;
    if (quoted === null || squash(quoted).length < 20) return ["No live check ran, and the pull request does not say what could not be checked live."];
    return squash(pr.detail.body).includes(squash(quoted)) ? [] : ["The reviewer's quote of what could not be checked live is not in the pull request's description."];
  },
  ({ review }) => (review.rounds.at(-1)!.verdict?.reserved ?? []).map((r) => `Always needs the person: ${reservedNames[r.case]}, by the reviewer's reading (${r.why}).`),
  ({ files }) => files.some((f) => f.path === ".nexus/check" || f.previous === ".nexus/check") ? ["The pull request changes .nexus/check, the check this policy relies on."] : [],
  ({ files, nexus }) => {
    if (!nexus) return [];
    const hits = new Map<ReservedCase, string[]>();
    for (const file of files) {
      for (const path of [file.path, ...file.previous === null ? [] : [file.previous]]) {
        for (const rule of reservedPaths) if (rule.matches(path, file.patch)) hits.set(rule.case, [...new Set([...hits.get(rule.case) ?? [], path])]);
      }
    }
    return [...hits].map(([c, paths]) => `Always needs the person: ${reservedNames[c]}, as it changes ${paths.join(", ")}.`);
  },
];

/** Why the policy holds this landing for the person, or nothing when an agent may merge and deploy it. */
export function landingHolds(facts: LandingFacts): string[] {
  return conditions.flatMap((condition) => condition(facts));
}
