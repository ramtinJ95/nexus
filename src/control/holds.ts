/**
 * The merge policy's hold vocabulary: the hold codes, and each code's row: its rule, the name a waiver of it goes by,
 * and what the loop does about it alone. src/contract/reserved.ts holds the reserved cases.
 */
import { reservedNames, type ReservedCase } from "../contract/reserved.ts";

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
  | "verify-changed" | "no-second-reviewer" | `reserved:${ReservedCase}` | `reserved-path:${ReservedCase}` | "stale-head" | "waiver-not-carried" | "loop";
export interface Hold { code: HoldCode; text: string }
const cases = Object.keys(reservedNames) as ReservedCase[];

/** Whether a hold meets every landing of the same approved head again, and whether the person may waive it, and why. */
export interface HoldRule { holdsAgain: boolean; waivable: boolean; why: string }
/**
 * What the loop does itself for a landing that is held by one hold alone: `rebase` the branch onto its base, or ask the
 * reviewer to `quote` the description again, which a Land press asks for too.
 */
type Remedy = "rebase" | "quote";
/** A hold's rule, and the few words a waiver of it is named by, which every hold the person may waive has. */
type HoldRow = ({ rule: HoldRule & { waivable: true }; name: string } | { rule: HoldRule & { waivable: false }; name?: never }) & { remedy?: Remedy };
const reserved = (name: string): HoldRow => ({ rule: { holdsAgain: true, waivable: true, why: "The policy reserves this for you, and pressing Land here is you waiving it." }, name });
const notWaivable = (why: string, remedy?: Remedy): HoldRow => ({ rule: { holdsAgain: false, waivable: false, why }, ...remedy === undefined ? {} : { remedy } });
const loopRow = notWaivable("Only what the policy reserves for you can be waived.");
const holdRows: Record<HoldCode, HoldRow> = {
  ...Object.fromEntries(cases.flatMap((c) => [[`reserved:${c}`, reserved(reservedNames[c])], [`reserved-path:${c}`, reserved(reservedNames[c])]])) as Record<`reserved:${ReservedCase}` | `reserved-path:${ReservedCase}`, HoldRow>,
  "check-changed": { rule: { holdsAgain: true, waivable: true, why: "Accepting a new .nexus/check is yours, and pressing Land here is you accepting it." }, name: "a change to .nexus/check" },
  "verify-changed": { rule: { holdsAgain: true, waivable: true, why: "Accepting a new .nexus/verify is yours, and pressing Land here is you accepting it." }, name: "a change to .nexus/verify" },
  "no-second-reviewer": { rule: { holdsAgain: true, waivable: true, why: "Landing on one reviewer's approval where the project asks for two is yours to accept, and pressing Land here is you accepting it." }, name: "a review without its second reviewer" },
  "claude-approved": { rule: { holdsAgain: true, waivable: false, why: "Nothing here stands in for a harness reviewer's approval: the Claude reviewer's verdict, its findings and reserved cases included, could have been written by code in its pylon." } },
  "not-approved": notWaivable("Open P0 to P2 findings hold every landing until they are fixed and the reviewer approves."),
  "open-findings": notWaivable("Open P0 to P2 findings hold every landing until they are fixed and the reviewer approves."),
  unanswered: notWaivable("Every P0 to P2 finding needs the builder's fix or its reason to reject."),
  "check-failed": notWaivable("Only a .nexus/check that passed at the approved head lands."),
  "live-failed": notWaivable("A repository with a .nexus/verify lands only once its live check passed at the approved head."),
  "github-checks": notWaivable("Failing or pending GitHub checks hold every landing until they pass."),
  "not-approved-head": notWaivable("Only the commit the reviewer approved lands."),
  conflict: notWaivable("A branch that conflicts with its base cannot merge.", "rebase"),
  "pr-not-open": notWaivable("Only an open pull request lands."),
  "same-model": { rule: { holdsAgain: true, waivable: false, why: "The policy needs a reviewer on another model than the builder's." } },
  "not-checked-live": notWaivable("A live check that passed at this commit clears it, or a description that says what could not be checked live: add that section to the pull request's description, then press Land, and Nexus asks the reviewer to quote it at this commit.", "quote"),
  "stale-head": loopRow,
  "waiver-not-carried": notWaivable("Your Land was for the change at an earlier commit, so the holds it waived are yours to look at again here."),
  loop: loopRow,
};
export const holdRule = (code: HoldCode): HoldRule => holdRows[code].rule;
export const waivable = (code: HoldCode) => holdRule(code).waivable;
export const remedyOf = (code: HoldCode): Remedy | null => holdRows[code].remedy ?? null;
/** The reserved case a hold is, or null for one the policy does not name as a case. */
export const caseOf = (code: HoldCode): ReservedCase | null => /^reserved(-path)?:/.test(code) ? code.slice(code.indexOf(":") + 1) as ReservedCase : null;
/** What a hold the person may waive is about, in a few words. */
export const waivedName = (code: HoldCode): string => holdRows[code].name ?? code;
