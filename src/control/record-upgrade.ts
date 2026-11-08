/**
 * Review and pylon records saved by an older control plane, brought to the shape this code reads. The review and
 * thread stores rewrite each one once, when the registry opens.
 * The upgrade fills in what the older record lacks, caps its rounds and gives its findings priorities, as the read
 * before it did, so a control plane rolled back to an older release reads the upgraded record unchanged.
 */
import { reviewPrefix } from "./agent-protocol.ts";
import { noAttempts, type Attempts, type FailedAttempt } from "./reconcile.ts";
import type { JobEnvelope } from "../protocol/jobs.ts";
import { personOnly, type HoldCode } from "./holds.ts";
import { reservedCases, reservedNames } from "../contract/reserved.ts";
import { blocks, findingSchema, maxRounds, secondReads, type Change, type Review, type Verdict } from "./review-model.ts";

/** What a waiver saved before Nexus recorded the change it waives reads as, so it holds at its own head alone. */
const unrecordedChange: Change = { kind: "unknown", why: "the waiver was saved before Nexus recorded the change it waives" };

/**
 * A stored record as this code reads it: a review saved with more rounds stops at the cap, old findings get
 * priorities, one saved before waivers has none, holds and a waiver saved before hold codes get them from their texts,
 * a waiver saved before changes gets one that is unknown, a hold saved before causes gets one from its label, and a
 * verdict saved before its findings decided its word says "changes" unless it approved with no blocking finding.
 */
export function upgradeReview(record: Review): Review {
  const { phase, waiver } = record;
  return {
    ...record, maxRounds: Math.min(record.maxRounds, maxRounds), auto: record.auto ?? false,
    waiver: waiver == null ? null : { ...waiver, codes: waiver.codes ?? waiver.holds.map(codeOfText), change: waiver.change === undefined ? unrecordedChange : waiver.change },
    phase: phase.kind === "needs-person" ? {
      ...phase, cause: phase.cause ?? (phase.label === undefined ? "unrecorded" : "rounds"),
      holds: phase.holds ?? phase.reasons.map((text) => ({ code: codeOfText(text), text })),
    } : phase,
    asked: record.asked ?? `${reviewPrefix}\nYour last turn ended because your model failed. Carry out Nexus's last request again, and end your reply with the block it asks for, with the token "${record.expect}".`,
    rounds: record.rounds.map((round) => round.verdict === null ? round : { ...round, verdict: decided({ ...round.verdict, findings: round.verdict.findings.map((f) => findingSchema.parse(f)) }) })
      .map((round) => round.secondVerdict == null ? round : { ...round, secondVerdict: decided(round.secondVerdict) })
      // A round of a review with a second reviewer that lacks its verdict has none, which never approves.
      .map((round, i) => secondReads(record) && i === record.rounds.length - 1 && round.secondVerdict === undefined ? { ...round, secondVerdict: null } : round),
  };
}

const decided = (v: Verdict): Verdict => ({ ...v, verdict: v.verdict === "approve" && !v.findings.some(blocks) ? "approve" : "changes" });

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

/**
 * A pylon record saved before a failed wake for reading went to the usage hold kept one apart in `readFailure`, or
 * before that in `last`, marked `reading: true`. Either is dropped, so a hold that still reads the pylon wakes it again.
 */
export function upgradeAttempts(attempts: Attempts): Attempts {
  const { readFailure: _, ...kept } = attempts as Attempts & { readFailure?: FailedAttempt };
  return (kept.last as (FailedAttempt & { reading?: true }) | null)?.reading === true ? noAttempts : kept;
}

/** A job sent for reading before steps were marked `uncounted` was marked `reading: true`. */
export function upgradeSubmitted(submitted: (JobEnvelope & { uncounted?: true; reading?: true }) | null): (JobEnvelope & { uncounted?: true }) | null {
  if (submitted?.reading !== true) return submitted;
  const { reading: _, ...env } = submitted;
  return { ...env, uncounted: true };
}
