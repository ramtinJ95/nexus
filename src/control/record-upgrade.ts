/**
 * Review records saved by an older control plane, brought to the shape this code reads. The review store rewrites
 * each one once, when the registry opens.
 * The upgrade only fills in what the older record lacks, so a control plane rolled back to an older release still
 * reads what it wrote.
 */
import { reviewPrefix } from "../agent-protocol.ts";
import { personOnly, reservedCases, reservedNames, type HoldCode } from "./holds.ts";
import { findingSchema, maxRounds, secondReads, type Review } from "./review-model.ts";

/**
 * A stored record as this code reads it: a review saved with more rounds stops at the cap, old findings get
 * priorities, one saved before waivers has none, holds and a waiver saved before hold codes get them from their texts,
 * and a hold saved before causes gets one from its label. A waiver saved before changes keeps none, so it holds at its
 * own head alone.
 */
export function upgradeReview(record: Review): Review {
  const { phase, waiver } = record;
  return {
    ...record, maxRounds: Math.min(record.maxRounds, maxRounds), auto: record.auto ?? false,
    waiver: waiver == null ? null : { ...waiver, codes: waiver.codes ?? waiver.holds.map(codeOfText) },
    phase: phase.kind === "needs-person" ? {
      ...phase, cause: phase.cause ?? (phase.label === undefined ? "unrecorded" : "rounds"),
      holds: phase.holds ?? phase.reasons.map((text) => ({ code: codeOfText(text), text })),
    } : phase,
    asked: record.asked ?? `${reviewPrefix}\nYour last turn ended because your model failed. Carry out Nexus's last request again, and end your reply with the block it asks for, with the token "${record.expect}".`,
    rounds: record.rounds.map((round) => round.verdict === null ? round : { ...round, verdict: { ...round.verdict, findings: round.verdict.findings.map((f) => findingSchema.parse(f)) } })
      // A round of a review with a second reviewer that lacks its verdict has none, which never approves.
      .map((round, i) => secondReads(record) && i === record.rounds.length - 1 && round.secondVerdict === undefined ? { ...round, secondVerdict: null } : round),
  };
}

/**
 * The code a hold's text had under the text rules, for records saved before holds carried codes: a needs-person
 * phase with only reasons, and a waiver with only texts.
 */
function codeOfText(text: string): HoldCode {
  for (const c of reservedCases) {
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
