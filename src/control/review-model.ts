/**
 * A review's record and the pure rules over it. The review loop (review.ts) steps the record, the merge policy
 * (policy.ts) reads it, and the registry, the CLI and the dashboard store or show it.
 */
import { z } from "zod";
import { reviewPrefix } from "../agent-protocol.ts";
import type { PullRequest } from "./github.ts";
import { legacyHoldCode, reservedCases, type Hold, type HoldCode } from "./holds.ts";
import type { Thread, ThreadId } from "./registry.ts";

/** The most rounds a review runs, and how many it runs unless asked for fewer. */
export const maxRounds = 5;
export const humanLabel = "needs human review";

export const priorities = ["P0", "P1", "P2", "P3"] as const;
/** What a finding's severity, before priorities, reads as: a reviewer told the old shape, or a stored round, still answers with it. */
const legacyPriority: Record<string, typeof priorities[number]> = { serious: "P1", minor: "P3" };
const findingSchema = z.preprocess((v) => typeof v === "object" && v !== null && "severity" in v && !("priority" in v) ? { ...v, priority: legacyPriority[String(v.severity)] } : v, z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  priority: z.enum(priorities),
  where: z.string().max(300).nullish(),
  summary: z.string().min(1).max(2_000),
  detail: z.string().max(8_000).nullish(),
}));
/** P0 to P2 hold the loop and a merge until answered. A P3 is a note the builder may leave for a later pull request. */
export const blocks = (f: Finding) => f.priority !== "P3";
/** The reviewer approves exactly when no P0 to P2 finding is open, so its findings decide the verdict, whatever word it chose. */
export const verdictSchema = z.object({
  token: z.string(),
  verdict: z.enum(["approve", "changes"]),
  findings: z.array(findingSchema).max(50),
  reserved: z.array(z.object({ case: z.enum(reservedCases), why: z.string().max(2_000) })).max(20),
  notCheckedLive: z.string().max(4_000).nullable(),
}).transform((v) => ({ ...v, verdict: v.findings.some(blocks) ? "changes" as const : "approve" as const }));
export const answersSchema = z.object({
  token: z.string(),
  answers: z.array(z.object({ id: z.string().max(40), action: z.enum(["fixed", "rejected"]), reason: z.string().max(4_000) })).max(60),
});
export type Finding = z.output<typeof findingSchema>;
export type Verdict = z.output<typeof verdictSchema>;
export type Answer = z.infer<typeof answersSchema>["answers"][number];

/**
 * A round is one review of `head`. `check` is the repository's checks at `head`, run once the reviewer approves it.
 * `live` is the live check at `head`, recorded once the checks pass, and unset until a live check gave a verdict or
 * found no `.nexus/verify`. `conflict` is the base that `head` conflicted with when the landing tried to merge it, which
 * the builder rebases onto.
 */
/** Whether the builder answered finding `f`: fixed it, or rejected it with a reason. */
export const answered = (f: Pick<Finding, "id">, answers: readonly Answer[]) => answers.some((a) => a.id === f.id && (a.action === "fixed" || a.reason.trim() !== ""));
export interface Round { head: string; verdict: Verdict | null; check: { passed: boolean; output: string } | null; live?: LiveCheck; answers: Answer[] | null; conflict?: { base: string } }
/**
 * `absent` when `head` has no `.nexus/verify`, so the landing reads the PR's statement of what it could not check live
 * instead. `ran` when the script gave its verdict in verify pylon `thread`.
 */
export type LiveCheck = { kind: "absent" } | { kind: "ran"; thread: ThreadId; passed: boolean; output: string };

/**
 * The agent's last `count` turns in a row ended because its model failed, the latest with the error `last`. The loop
 * sends its request again at `retryAt`.
 */
export interface ModelFailure { count: number; last: string; retryAt: number }

export type Phase =
  /** The reviewer has the round's request and owes its verdict. */
  | { kind: "reviewing"; failing?: ModelFailure }
  /** The builder has the round's findings and owes an answer to each, and a push for what it fixed. */
  | { kind: "fixing"; failing?: ModelFailure }
  /** The repository's checks run at the approved head, in `thread`, a check thread thrown away afterwards. */
  | { kind: "checking"; startedAt: number; thread: ThreadId | null }
  /**
   * The live check runs at the approved head in `thread`, a verify pylon archived afterwards. `refused` is why no node
   * could take the verify pylon yet, which the loop tries again.
   */
  | { kind: "verifying"; startedAt: number; thread: ThreadId | null; refused?: string }
  | { kind: "approved" }
  /**
   * `authorized` is the head this review is about to merge, saved before the merge call, so after a restart a PR that
   * merged at it is this review's own merge, and any other merge is someone else's. `waiting` is why a review that
   * deploys has not authorized its merge yet: another landing that deploys is under way, a deploy drains the control
   * plane, or the desired release is not healthy everywhere.
   */
  | { kind: "merging"; authorized: string | null; waiting?: string }
  /** `requested` once the desired release is set. `previous` is the release to roll back to, null if there was none. */
  | { kind: "deploying"; commit: string; previous: string | null; requested: boolean; deadline: number }
  /** The deploy of `commit` failed for `why`, and the fleet goes back to `previous`, the desired release once `requested`. */
  | { kind: "rolling-back"; commit: string; previous: string; why: string; requested: boolean; deadline: number }
  /** `commit` is the merge commit, deployed when the PR is Nexus's own. */
  | { kind: "landed"; commit: string }
  /**
   * Ended, for the person to decide. `cause` is which part of the loop held it. `reasons` say exactly which condition
   * failed or which reserved case applies, and `holds` are the same, one per reason in its order, with the code that
   * decides each one's rule. `unreviewed` is a head the PR moved to after the last round, which no round of this review
   * reviews.
   */
  | { kind: "needs-person"; cause: HoldCause; reasons: string[]; holds: Hold[]; label?: Label; unreviewed?: string }
  /** The PR merged or closed outside a review that does not land it, so nothing was left to review. */
  | { kind: "merged" }
  | { kind: "closed" }
  /** The person archived or deleted one of the review's threads, or, as `by`, cancelled the review itself. */
  | { kind: "cancelled"; who: "builder" | "reviewer"; status: "archived" | "deleted" }
  | { kind: "cancelled"; who: "person"; by: string };
/**
 * Why a review is held: its `rounds` ran out; a `gate` failed where it failed before, or the builder answered it
 * without a push; the check or live check gave `no-verdict`; an `agent` gave no answer the loop could read; the merge
 * `policy` holds it, or GitHub would not merge; the PR closed or merged `outside` the review; a `thread` of it is not
 * active; or its `deploy` or rollback failed. A record saved before causes is `unrecorded`, unless its label says its
 * rounds ran out.
 */
export type HoldCause = "rounds" | "gate" | "no-verdict" | "agent" | "policy" | "outside" | "thread" | "deploy" | "unrecorded";
/** The "needs human review" label on the PR, which only a review whose rounds ran out gets. */
export type Label = { state: "adding" } | { state: "added" } | { state: "failed"; why: string };
export type PhaseKind = Phase["kind"];

/**
 * The person's waiver of holds the policy reserves for them, for this review at `head`: `holds` as the person saw
 * them, and `codes`, which the landing matches. It lasts for the landing it started, and a later land replaces it.
 */
export interface Waiver { head: string; holds: string[]; codes: HoldCode[]; by: string; at: number }

export interface Review {
  /** Part of every token and request ID, so a later review of the same thread never matches an earlier one's. */
  id: string;
  /** The token the awaited answer must echo, and how many messages the review has sent, which numbers their request IDs. */
  expect: string;
  sent: number;
  builder: ThreadId;
  reviewer: ThreadId;
  pr: { repo: string; number: number; url: string; title: string; branch: string };
  models: { builder: string; reviewer: string };
  /**
   * A harness reviewer's verdict comes from the control plane's agent loop. A Claude reviewer's is read from its
   * transcript in its pylon, where code it runs could write, so its approval never lands without the person.
   */
  reviewerKind: "harness" | "claude";
  maxRounds: number;
  /**
   * Who asked for the PR to land once approved, or null to stop at approval. `fromProject` when the project's setting
   * asked, so each landing reads that setting again and lands for whoever it names.
   */
  land: { requestedBy: string; fromProject?: true } | null;
  /** Started on its own when the PR watch first linked the PR, as the project asks. */
  auto: boolean;
  rounds: Round[];
  /** The merge commit once the PR merged, so a later land never merges or deploys it again. */
  merged: string | null;
  waiver: Waiver | null;
  phase: Phase;
  /**
   * The next message, saved before it is sent. `attempted` is when its first send began, saved before it, so a send
   * that went through before a crash still dates the wait from then, and a reply that came meanwhile is read.
   */
  outbox: { to: "builder" | "reviewer"; id: string; text: string; attempted: number | null } | null;
  /** The text of the last message sent, which a turn that ended on a model failure gets again. */
  asked: string;
  /** When the agent the loop waits on was last sent something, and how many reminders in a row it has had. */
  since: number;
  nudges: number;
  startedAt: number;
}

export const endedKinds = ["approved", "landed", "needs-person", "merged", "closed", "cancelled"] as const;
/** The ended phases a step does nothing more for once the review has no message left to send, which a pass skips. */
export const settledKinds = ["landed", "merged", "closed", "cancelled"] as const satisfies readonly PhaseKind[];
/** Phases a pass never moves on from. A new review or a land request starts the thread over. */
export const ended: ReadonlySet<PhaseKind> = new Set(endedKinds);
export const needsPerson = (r: Review | null) => r?.phase.kind === "needs-person";
/** What a landing that authorized its merge, or is deploying or rolling back, does now, or null for any other review. */
export const landingVerb = (r: Review): "deploys" | "rolls back" | "merges" | null =>
  r.phase.kind === "deploying" ? "deploys" : r.phase.kind === "rolling-back" ? "rolls back" : r.phase.kind === "merging" && r.phase.authorized !== null ? "merges" : null;
/**
 * A landing under way is seen through, so the person cannot cancel it. A review that ended for the person can be, so
 * it stops waiting on them, as nothing else ends it once its pull request merged outside it.
 */
export const cancellable = (r: Review) => (!ended.has(r.phase.kind) || needsPerson(r)) && landingVerb(r) === null;

/** A needs-person phase for `cause` whose holds are `items`. A string is a reason of the loop's own. */
export const personPhase = (cause: HoldCause, ...items: readonly (Hold | string)[]) => {
  const holds = items.map((h): Hold => typeof h === "string" ? { code: "loop", text: h } : h);
  return { kind: "needs-person" as const, cause, reasons: holds.map((h) => h.text), holds };
};

/**
 * A stored record as this code reads it: a review saved with more rounds stops at the cap, old findings get
 * priorities, one saved before waivers has none, holds and a waiver saved before hold codes get them from their texts,
 * and a hold saved before causes gets one from its label.
 */
export function storedReview(record: Review): Review {
  const { phase, waiver } = record;
  return {
    ...record, maxRounds: Math.min(record.maxRounds, maxRounds), auto: record.auto ?? false,
    waiver: waiver == null ? null : { ...waiver, codes: waiver.codes ?? waiver.holds.map(legacyHoldCode) },
    phase: phase.kind === "needs-person" ? {
      ...phase, cause: phase.cause ?? (phase.label === undefined ? "unrecorded" : "rounds"),
      holds: phase.holds ?? phase.reasons.map((text) => ({ code: legacyHoldCode(text), text })),
    } : phase,
    asked: record.asked ?? `${reviewPrefix}\nYour last turn ended because your model failed. Carry out Nexus's last request again, and end your reply with the block it asks for, with the token "${record.expect}".`,
    rounds: record.rounds.map((round) => round.verdict === null ? round : { ...round, verdict: { ...round.verdict, findings: round.verdict.findings.map((f) => findingSchema.parse(f)) } }),
  };
}

/**
 * A gate that stopped an approval: the P0 `finding` the builder answers, what `failed`, the `verdict` its findings
 * message gives, the hold's `code` and its text once the builder `pushedNothing` for it, and the gate's `output`.
 */
interface GateFailure { kind: "check" | "live" | "conflict"; finding: Finding; failed: string; verdict: string; code: HoldCode; pushedNothing: string; output: string | null }
const gates = {
  check: (head: string, output: string): GateFailure => ({
    kind: "check", finding: { id: "CHECK", priority: "P0", where: ".nexus/check", summary: `.nexus/check failed at ${head}`, detail: output }, failed: ".nexus/check failed",
    verdict: "the repository's checks failed after the reviewer approved", code: "check-failed", pushedNothing: `.nexus/check failed at ${head}, and the builder pushed nothing for it`, output: checkOutput(output),
  }),
  live: (head: string, output: string): GateFailure => ({
    kind: "live", finding: { id: "LIVE", priority: "P0", where: ".nexus/verify", summary: `The live check failed at ${head}`, detail: output }, failed: "The live check failed",
    verdict: "the live check failed after the reviewer approved and the repository's checks passed", code: "live-failed", pushedNothing: `The live check failed at ${head}, and the builder pushed nothing for it`, output: liveOutput(output),
  }),
  conflict: (head: string, base: string): GateFailure => ({
    kind: "conflict", finding: {
      id: "CONFLICT", priority: "P0", where: `origin/${base}`, summary: `The branch conflicts with ${base}, so ${head} cannot merge`,
      detail: `Rebase the branch onto the current base: git fetch origin && git rebase origin/${base}. Resolve each conflict so that both sides' intent survives: keep what ${base} changed and what this pull request adds. Run the typecheck and the full test suite again, then push with git push --force-with-lease. The rebased head gets a new review round. If you cannot resolve a conflict, reject CONFLICT with the reason, and the person takes over.`,
    }, failed: `The branch conflicted with ${base}`,
    verdict: `the reviewer approved, but the branch conflicts with ${base}, so it cannot merge`, code: "loop", pushedNothing: `The branch conflicts with ${base}, and the builder did not rebase it`, output: null,
  }),
};
/**
 * The gate that failed at `round`, or null. A round fails at most one: the check runs only after an approval, the
 * live check only after the check passes, and a conflict is recorded only when a merge after both is refused.
 */
export const gateFailure = (round: Round): GateFailure | null => round.check?.passed === false ? gates.check(round.head, round.check.output)
  : round.live?.kind === "ran" && !round.live.passed ? gates.live(round.head, round.live.output)
  : round.conflict !== undefined ? gates.conflict(round.head, round.conflict.base) : null;
/** What the builder must answer for a round: the reviewer's findings, and the finding of a gate that failed. */
export const findingsOf = (round: Round): Finding[] => {
  const gate = gateFailure(round);
  return [...round.verdict?.findings ?? [], ...gate === null ? [] : [gate.finding]];
};
/** An approval with no blocking finding open, the check included. */
export const approves = (round: Round) => round.verdict?.verdict === "approve" && !findingsOf(round).some(blocks);
/**
 * Whether `nexus land` takes the review: approved, or held for the person after an approval whose check passed, at
 * the PR's head as far as the loop knows. A review that merged never lands again.
 */
export const landable = (r: Review) => r.merged === null && (r.phase.kind === "approved"
  || (r.phase.kind === "needs-person" && r.phase.unreviewed === undefined && r.rounds.at(-1)!.check?.passed === true && approves(r.rounds.at(-1)!)));
/**
 * Why `nexus land` refuses the review, or null when it takes it: its builder is not active, it merged, the PR watch
 * reads its PR as closed or merged outside it, or it is not landable. The dashboard offers Land by the same rule.
 */
export function cannotLand(r: Review, builder: Pick<Thread, "status">, pr?: Pick<PullRequest, "state">): string | null {
  if (builder.status !== "active") return `thread ${r.builder} is ${builder.status}`;
  if (r.merged !== null) return `review ${r.id} already merged pull request #${r.pr.number} as ${r.merged}, so it does not land again`;
  if (pr !== undefined && pr.state !== "open") return `pull request #${r.pr.number} is ${pr.state} on GitHub outside this review, so there is nothing to land`;
  if (!landable(r)) return `review ${r.id} of ${r.builder} is ${r.phase.kind}${r.phase.kind === "needs-person" ? `: ${r.phase.reasons.join(" ")}` : ""}, not approved with its checks passing`;
  return null;
}
/**
 * Whether the review is held for the person, for another cause than its rounds running out and with rounds left,
 * after an approval whose only blocking finding is a gate that failed, which a new head may answer. Changes the
 * reviewer requested stay the person's.
 */
export const heldForGate = (r: Review) => {
  const round = r.rounds.at(-1)!;
  return r.phase.kind === "needs-person" && r.phase.cause !== "rounds" && r.merged === null && roundsSpent(r) < r.maxRounds
    && round.verdict?.verdict === "approve" && !round.verdict.findings.some(blocks) && gateFailure(round) !== null;
};
/** The rounds that count against the limit. One that approves again the head its previous round approved reviewed nothing new. */
export const roundsSpent = (r: Pick<Review, "rounds">) => r.rounds.filter((round, i) => {
  const previous = r.rounds[i - 1];
  return !(previous?.head === round.head && previous.verdict?.verdict === "approve" && round.verdict?.verdict === "approve" && !round.verdict.findings.some(blocks));
}).length;
/**
 * The head `pr` was read at, when it is open there at another head than the latest round's and than the one its hold
 * named. A PR watch's read may be older than the round, so the loop confirms it with GitHub before it acts.
 */
export const pushedHead = (r: Review, pr: Pick<PullRequest, "state" | "head"> | undefined): string | null =>
  pr?.state !== "open" || pr.head === undefined || r.rounds.at(-1)!.head === pr.head || (r.phase.kind === "needs-person" && r.phase.unreviewed === pr.head) ? null : pr.head;
/** Why the latest round started, when it reviews a head pushed after the previous round's approval rather than the builder's fixes. */
export function roundNote(r: Review): string | null {
  const [previous, round] = r.rounds.slice(-2);
  if (round === undefined || previous!.answers !== null || previous!.verdict?.verdict !== "approve") return null;
  return `a new round reviews ${round.head.slice(0, 12)}, since the pull request's head moved from ${previous!.head.slice(0, 12)} after its approval`;
}
const labelStates = { adding: `, adding the label "${humanLabel}"`, added: `, labelled "${humanLabel}"`, failed: `, label "${humanLabel}" not added` } as const;
/** How a review's line in `nexus show` and the dashboard ends. A refused label's why is already one of the reasons. */
export const phaseNote = (r: Review) => r.phase.kind === "cancelled" ? r.phase.who === "person" ? `, cancelled by ${r.phase.by}` : `, the ${r.phase.who} thread ${r[r.phase.who]} was ${r.phase.status}`
  : r.phase.kind === "merging" && r.phase.waiting !== undefined ? `, waiting while ${r.phase.waiting}`
  : r.phase.kind === "needs-person" && r.phase.label ? labelStates[r.phase.label.state]
  : (r.phase.kind === "reviewing" || r.phase.kind === "fixing") && r.phase.failing ? `, the ${r.phase.kind === "reviewing" ? "reviewer" : "builder"}'s model is failing (${r.phase.failing.count} in a row, last: ${r.phase.failing.last}), retrying at ${new Date(r.phase.failing.retryAt).toISOString().slice(11, 16)} UTC` : "";
/** The latest round's live check, as `nexus show` and the dashboard say it, or null before its checks passed. */
export function liveNote(r: Review): string | null {
  const round = r.rounds.at(-1)!;
  const head = round.head.slice(0, 12);
  if (r.phase.kind === "verifying") {
    if (r.phase.thread !== null) return `live check running .nexus/verify at ${head} in verify pylon ${r.phase.thread}`;
    return r.phase.refused === undefined ? `live check starting at ${head}` : `live check waiting for a node to take its verify pylon: ${r.phase.refused}`;
  }
  if (round.live?.kind === "absent") return `no live check: ${head} has no .nexus/verify, so the landing reads the pull request's statement of what could not be checked live`;
  if (round.live?.kind === "ran") return `live check ${round.live.passed ? "passed" : "failed"} at ${head}`;
  return round.check?.passed === true ? `no live check ran at ${head}` : null;
}
export const checkOutput = (output: string) => `The check's output:\n${output}`;
export const liveOutput = (output: string) => `The live check's output:\n${output}`;
