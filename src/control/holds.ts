/**
 * The merge policy's hold vocabulary: the reserved cases, the hold codes, and which holds the person may waive.
 */
export const reservedCases = ["secrets", "egress", "auth", "tailnet", "destructive-migration", "image-rebuild", "cli-breaking", "irreversible"] as const;
export type ReservedCase = typeof reservedCases[number];

export const reservedNames: Readonly<Record<ReservedCase, string>> = {
  secrets: "changes to secrets", egress: "changes to the egress allowlist", auth: "changes to login or auth", tailnet: "changes to the tailnets",
  "destructive-migration": "database migrations that delete or rewrite existing data", "image-rebuild": "pylon image rebuilds",
  "cli-breaking": "breaking changes to the CLI's contract", irreversible: "anything irreversible",
};

export const personOnly = "Always needs the person: ";

/**
 * What a hold is, which decides its rule, and its text, which only the person reads. A reserved case the reviewer
 * named and one the paths hit are separate codes, so a waiver of the one the person saw never covers the other.
 * `loop` is a reason of the review loop's own, such as a deploy's failure, `stale-head` the line a held review
 * gains when its head moves, and `waiver-not-carried` the line saying why the person's Land at an earlier head did not
 * carry to this one.
 */
export type HoldCode =
  | "same-model" | "not-approved" | "open-findings" | "unanswered" | "check-failed" | "live-failed" | "github-checks"
  | "not-approved-head" | "conflict" | "pr-not-open" | "not-checked-live" | "claude-approved" | "check-changed"
  | "verify-changed" | `reserved:${ReservedCase}` | `reserved-path:${ReservedCase}` | "stale-head" | "waiver-not-carried" | "loop";
export interface Hold { code: HoldCode; text: string }
const cases = Object.keys(reservedNames) as ReservedCase[];

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
  "waiver-not-carried": notWaivable("Your Land was for the change at an earlier commit, so the holds it waived are yours to look at again here."),
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
