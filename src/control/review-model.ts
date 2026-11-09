/**
 * A review's record and the pure rules over it. The review loop (review.ts) steps the record, the merge policy
 * (policy.ts) reads it, and the registry, the CLI and the dashboard store or show it.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChangedFile, PullRequest } from "./github.ts";
import type { Hold, HoldCode } from "./holds.ts";
import { reservedCases } from "../contract/reserved.ts";
import type { ProjectId, ThreadId } from "../ids.ts";
import type { ThreadStatus } from "./reconcile.ts";

/** The most rounds a review runs, and how many it runs unless asked for fewer. */
export const maxRounds = 5;
export const humanLabel = "needs human review";

export const priorities = ["P0", "P1", "P2", "P3"] as const;
/** What a finding's severity, before priorities, reads as: a reviewer told the old shape, or a stored round, still answers with it. */
const legacyPriority: Record<string, typeof priorities[number]> = { serious: "P1", minor: "P3" };
export const findingSchema = z.preprocess((v) => typeof v === "object" && v !== null && "severity" in v && !("priority" in v) ? { ...v, priority: legacyPriority[String(v.severity)] } : v, z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  priority: z.enum(priorities),
  where: z.string().max(300).nullish(),
  summary: z.string().min(1).max(2_000),
  detail: z.string().max(8_000).nullish(),
}));
/** P0 to P2 hold the loop and a merge until answered. A P3 is a note the builder may leave for a later pull request. */
export const blocks = (f: Finding) => f.priority !== "P3";
/**
 * The reviewer approves exactly when no P0 to P2 finding is open, so its findings decide the verdict, whatever word it
 * chose. A stored round's word is decided the same way once, by the record upgrade, so `verdict` is the approval.
 */
export const verdictSchema = z.object({
  token: z.string(),
  verdict: z.enum(["approve", "changes"]),
  findings: z.array(findingSchema).max(50),
  reserved: z.array(z.object({ case: z.enum(reservedCases), why: z.string().max(2_000) })).max(20),
  notCheckedLive: z.string().max(4_000).nullable(),
}).transform((v) => ({ ...v, verdict: v.findings.some(blocks) ? "changes" as const : "approve" as const }));
export const answersSchema = z.object({
  token: z.string(),
  answers: z.array(z.object({ id: z.string().max(42), action: z.enum(["fixed", "rejected"]), reason: z.string().max(4_000) })).max(110),
});
/** The reviewer's quote, asked for by a Land press at an approved head, of what the description now says could not be checked live. */
export const quoteSchema = z.object({ token: z.string(), notCheckedLive: z.string().max(4_000).nullable() });
export type Finding = z.output<typeof findingSchema>;
export type Verdict = z.output<typeof verdictSchema>;
export type Answer = z.infer<typeof answersSchema>["answers"][number];

/** Whether the builder answered finding `f`: fixed it, or rejected it with a reason. */
export const answered = (f: Pick<Finding, "id">, answers: readonly Answer[]) => answers.some((a) => a.id === f.id && (a.action === "fixed" || a.reason.trim() !== ""));
/**
 * A round is one review of `head`. `verdict` is the reviewer's, and `secondVerdict` the second reviewer's on a round
 * with that seat (`seatsOf`), without either seeing the other's. `check` is the repository's checks at `head`, run
 * while the reviewer reads it. `live` is the live check at `head`, recorded once the checks pass, and unset until a live
 * check gave a verdict or found no `.nexus/verify`. `conflict` is the base that `head` conflicted with when the landing
 * tried to merge it, which the builder rebases onto.
 * `base` is the branch the round's head was reviewed against, absent from a round saved before Nexus recorded it, and
 * an approval carries only on the same base, since a new base adds its own commits to the change. `carried` marks a
 * round whose verdict is the reviewer's approval of head `from`, carried to `head` because the change at both is the
 * same, so no reviewer round ran for it and it counts against no limit. Its checks run as any round's do, since the
 * base under the change moved. With `held`, in a review whose rounds ran out, it carries whatever verdict it was held
 * with, and its hold, and runs nothing at the new head. `quotedFrom` is the digest of the description the reviewer
 * last quoted from when a landing asked it again, so a landing asks again only once the description changed since.
 * `heldAt` holds those `head` alone decides (policy.ts's `headHolds`) against the PR's `base`, whose files they read,
 * recorded once its checks pass, so the person's Land and the landing read the same ones. A landing reads them again
 * when the PR's base changed since. A round that passed its checks before Nexus recorded them gets them on the
 * loop's next pass while it waits at approval, and from its landing otherwise.
 */
export interface Round { head: string; base?: string; verdict: Verdict | null; secondVerdict?: Verdict | null; check: { passed: boolean; output: string } | null; live?: LiveCheck; answers: Answer[] | null; conflict?: { base: string }; carried?: { from: string; held?: true }; quotedFrom?: string; heldAt?: HeldAt }
/** The holds a round's head alone decides, read from the PR's files against `base`. */
export interface HeldAt { base: string; holds: Hold[] }
/** The digest of a pull request's description, which a round's `quotedFrom` records. */
export const descriptionDigest = (body: string) => createHash("sha256").update(body).digest("hex");
/**
 * `absent` when `head` has no `.nexus/verify`, so the landing reads the PR's statement of what it could not check live
 * instead. `ran` when the script gave its verdict in verify pylon `thread`.
 */
type LiveCheck = { kind: "absent" } | { kind: "ran"; thread: ThreadId; passed: boolean; output: string };

/**
 * The agent's last `count` turns in a row ended because its model failed, the latest with the error `last`. The loop
 * sends its request again at `retryAt`.
 */
export interface ModelFailure { count: number; last: string; retryAt: number }

/** A run of a gate at a round's head, in `thread` once it started, the check thread or verify pylon. */
export interface GateRun { startedAt: number; thread: ThreadId | null }

export type Phase =
  /**
   * The reviewer has the round's request and owes its verdict. `check` is the repository's checks at the round's head,
   * run beside it unless the round has their result already, as `checking`'s are. `unrunnable` is the output of a check
   * the pylon could not run, which goes to the person once the reviewer approves while the PR is still at the round's
   * head. A PR at another head by then gets a round of its own. `refused` is why no node had room for the check, which
   * then runs in `checking` once the reviewer approves.
   */
  | { kind: "reviewing"; failing?: ModelFailure; check?: GateRun & { unrunnable?: string; refused?: string } }
  /** The builder has the round's findings and owes an answer to each, and a push for what it fixed. */
  | { kind: "fixing"; failing?: ModelFailure }
  /** The repository's checks run at the approved head, in a check thread thrown away afterwards. */
  | { kind: "checking" } & GateRun
  /**
   * The live check runs at the approved head, in a verify pylon archived afterwards. `refused` is why no node could take
   * the verify pylon yet, which the loop tries again.
   */
  | { kind: "verifying"; refused?: string } & GateRun
  /**
   * A landing at an approved head with no live check needs the reviewer's quote, from the description as it is now,
   * of what could not be checked live, as after the person's Land press. `asked` is the digest of the description the
   * request carries, once it is saved to send, and null before. The landing's checks follow.
   */
  | { kind: "quoting"; asked: string | null; failing?: ModelFailure }
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
  /**
   * `commit` is the merge commit, deployed when the PR is Nexus's own. `inTurn` is when it landed while its builder was
   * in a turn, as one answering the approval's notes, which leaves the builder open until that turn ends.
   */
  | { kind: "landed"; commit: string; inTurn?: number }
  /**
   * Ended, for the person to decide. `cause` is which part of the loop held it. `holds` say exactly which condition
   * failed or which reserved case applies, each with the code that decides its rule. `reasons` are their texts, which
   * nothing here reads: they stay on the record and in the API for older control planes and CLIs, which read them.
   * `unreviewed` is a head the PR moved to after the last round, which no round of this review reviews.
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
/** The "needs human review" label on the PR, which only a review whose rounds ran out gets. `why` is GitHub's answer. */
export type Label = { state: "adding" } | { state: "added" } | { state: "failed"; why: string };
export type PhaseKind = Phase["kind"];

/**
 * A pull request's change at a head against branch `base`, identified as `git patch-id --stable` would: one SHA-256 per
 * changed file, of its path, its path before a rename, its modes before and after, and its patch without the hunk
 * headers, so a rebase that only moves hunks keeps it, and any changed line, context lines included, or mode does not.
 * `unknown` when GitHub does not show the whole change, such as a binary file's, so nothing can say it is the same.
 */
export type Change = { kind: "known"; base: string; files: { path: string; id: string }[] } | { kind: "unknown"; why: string };
export function changeOf(base: string, files: readonly ChangedFile[] | null): Change {
  if (files === null) return { kind: "unknown", why: "GitHub did not show the whole change" };
  const unshown = files.find((f) => f.patch === "");
  if (unshown !== undefined) return { kind: "unknown", why: `GitHub shows no patch for ${unshown.path}` };
  const id = (f: ChangedFile) => createHash("sha256").update(JSON.stringify([f.previous, f.path, f.modes ?? null, f.patch.split("\n").filter((line) => !line.startsWith("@@"))])).digest("hex");
  return { kind: "known", base, files: files.map((f) => ({ path: f.path, id: id(f) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
/** The paths whose patches differ between two changes, an empty list for the same change. */
export function changedPaths(a: Extract<Change, { kind: "known" }>, b: Extract<Change, { kind: "known" }>): string[] {
  const ids = (c: typeof a) => new Map(c.files.map((f) => [f.path, f.id]));
  const [before, after] = [ids(a), ids(b)];
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
}

/**
 * The person's waiver of holds the policy reserves for them, for this review at `head`: `holds` as the person saw
 * them, and `codes`, which the landing matches. `change` is the change at the head they pressed Land at, null until
 * the landing reads it, and `from` that head once the waiver carried to a later head with the same change. It lasts
 * for the landing it started, and a later land replaces it. `yolo` is the project whose yolo setting gave it for `by`.
 */
export interface Waiver { head: string; holds: string[]; codes: HoldCode[]; by: string; at: number; change: Change | null; from?: string; yolo?: ProjectId }

/** A message saved before it is sent. `attempted` is when its first send began, saved before it. */
interface Outbox { id: string; text: string; attempted: number | null }
/**
 * The loop's side of a conversation with an agent it awaits answers from. `expect` is the token the awaited answer must
 * echo, and `asked` the text of the last message sent, which a turn that ended on a model failure gets again. `since`
 * is when the agent was last sent something, and `nudges` how many reminders in a row it has had. `outbox` is the next
 * message, and a send of it that went through before a crash still dates the wait from its `attempted`, and a reply
 * that came meanwhile is read.
 */
export interface Talk<O extends Outbox = Outbox> { expect: string; asked: string; since: number; nudges: number; outbox: O | null }

/**
 * The second reviewer the project's rule gave a review for `rule`'s reason: a Claude worker on another model than the
 * builder's and the first reviewer's, in `thread`, with its own conversation. `starting` until its thread starts,
 * tried since `since` and last at `tried`, which failed for `why`. `none` when no such model could run or its thread
 * did not start in time, for `why`, which holds the landing for the person.
 */
export type SecondReviewer =
  | ({ kind: "claude"; rule: string; thread: ThreadId; model: string; failing?: ModelFailure } & Talk)
  | { kind: "starting"; rule: string; model: string; since: number; tried: number | null; why: string | null }
  | { kind: "none"; rule: string; why: string };
/** Whether the review has a second reviewer whose verdict each round it reviews needs. */
export const secondReads = (r: Pick<Review, "second">) => r.second !== undefined && r.second.kind !== "none";
/**
 * A reviewer's seat at a round. A round records the seats it needs once, as one verdict field each, null until that
 * reviewer answers: the first always, and the second on a round its review had a second reviewer for.
 */
export type Seat = "first" | "second";
const seatFields = { first: "verdict", second: "secondVerdict" } as const;
export const seatsOf = (round: Round): Seat[] => round.secondVerdict === undefined ? ["first"] : ["first", "second"];
export const seatsFor = (r: Pick<Review, "second">): Seat[] => secondReads(r) ? ["first", "second"] : ["first"];
export const verdictAt = (round: Round, seat: Seat): Verdict | null => round[seatFields[seat]] ?? null;
/** A round's verdict fields for `seats`, holding `from`'s verdicts, or none yet for a round no reviewer read. */
export const verdictsFor = (seats: readonly Seat[], from?: Round): Pick<Round, "verdict" | "secondVerdict"> =>
  ({ verdict: from?.verdict ?? null, ...seats.includes("second") && { secondVerdict: from?.secondVerdict ?? null } });

/**
 * A request to land a review's PR once approved: the person's; the project's setting's, which each landing reads again
 * and lands for whoever it names; or the person's Land answer to a question about holds while the review ran, which is
 * for the change at `head` against `base` alone. Each is saved as its fields alone, as older control planes read it.
 */
export type LandRequest =
  | { requestedBy: string; fromProject?: never; head?: never }
  | { requestedBy: string; fromProject: true; head?: never }
  | { requestedBy: string; head: string; base: string | null; fromProject?: never };

/**
 * The review's own conversation is with the builder and the first reviewer, since only one of them owes an answer at
 * a time, and its outbox names which one its message is for.
 */
export interface Review extends Talk<Outbox & { to: "builder" | "reviewer" }> {
  /** `rv-` and 8 hex, part of every token and request ID, so a later review of the same thread never matches an earlier one's. */
  id: string;
  /** How many messages the review has sent, which numbers their request IDs. */
  sent: number;
  builder: ThreadId;
  reviewer: ThreadId;
  /** False until the loop starts the reviewer's thread, under the ID the review was recorded with. */
  reviewerStarted: boolean;
  pr: { repo: string; number: number; url: string; title: string; branch: string };
  models: { builder: string; reviewer: string };
  /**
   * A harness reviewer's verdict comes from the control plane's agent loop. A Claude reviewer's is read from its
   * transcript in its pylon, where code it runs could write, so its approval never lands without the person.
   */
  reviewerKind: "harness" | "claude";
  /** Absent when the project's rule gave the review no second reviewer. */
  second?: SecondReviewer;
  /** The builder's brief, its first message, cut as the description is, which each reviewer's first request carries. */
  brief?: string | null;
  /** 1 to 5, the rounds this review may spend. */
  maxRounds: number;
  /**
   * The rounds the PR's earlier reviews spent, whoever's record they were, which the person reads with this review's and
   * which a restart's 5 by default count against, so restarting a review does not give its PR more rounds.
   */
  earlierRounds: number;
  /** Who asked for the PR to land once approved, or null to stop at approval. */
  land: LandRequest | null;
  /** Started on its own when the PR watch first linked the PR, as the project asks. */
  auto: boolean;
  rounds: Round[];
  /** The merge commit once the PR merged, so a later land never merges or deploys it again. */
  merged: string | null;
  waiver: Waiver | null;
  phase: Phase;
  startedAt: number;
}

/**
 * What a phase is to the loop and the person. `ended`: the loop runs no step for it, though an approved review moves on
 * at the person's Land or a new head, and one held for the person at a new head, a land or a new review. `settled`:
 * ended with nothing more for a step to do once no message is left to send, so a pass skips it. `waitsOnPerson`: held
 * for them, or stopped at an approval that only their Land merges. `cancellable`: the person may cancel it, unless a
 * landing began its merge. `landing`: a landing's phase, which sees its deploy through whatever happens to the threads,
 * and what it does once it can no longer be stopped, or null before. `awaitsBuilder`: whether the phase keeps the
 * builder's pylon up, while its reviewer reads a round, which may end in findings for the builder, and until those
 * findings are delivered, but never while the reviewer's model fails. `track`: the step of its work's track the review
 * has taken its builder to, or null when a review that ended short of landing says nothing of where the work is.
 * `landingStep`: the step of a landing's own steps it is at, and whether it failed there, or null when no landing is on
 * its way. A landing held after its merge stopped at the deploy, which failed or rolled back. One held before its merge
 * is not on its way anywhere, and is landable again or not at all.
 */
interface PhaseRow<P extends Phase> {
  ended: boolean; settled: boolean; waitsOnPerson: boolean; cancellable: boolean;
  landing?: (phase: P) => "deploys" | "rolls back" | "merges" | null;
  awaitsBuilder?: (phase: P, r: Review) => boolean;
  track: TrackStep | null | ((phase: P, r: Review) => TrackStep);
  landingStep?: (phase: P, r: Review) => LandingAt | null;
}
export type TrackStep = "review" | "landing" | "deployed";
export const landingSteps = ["checking", "verifying", "merging", "deploying", "landed"] as const;
export type LandingStep = typeof landingSteps[number];
export interface LandingAt { step: LandingStep; failed: boolean }
const asked = (step: LandingStep) => (_: Phase, r: Review): LandingAt | null => r.land === null ? null : { step, failed: false };
const reached = (step: LandingStep, failed = false) => (): LandingAt => ({ step, failed });
const phases = {
  reviewing: { ended: false, settled: false, waitsOnPerson: false, cancellable: true, awaitsBuilder: (phase) => phase.failing === undefined, track: "review" },
  fixing: { ended: false, settled: false, waitsOnPerson: false, cancellable: true, awaitsBuilder: (_, r) => r.outbox?.to === "builder", track: "review" },
  // A review's checks run as the first steps of its landing once it was asked to land.
  checking: { ended: false, settled: false, waitsOnPerson: false, cancellable: true, track: (_, r) => r.land === null ? "review" : "landing", landingStep: asked("checking") },
  verifying: { ended: false, settled: false, waitsOnPerson: false, cancellable: true, track: (_, r) => r.land === null ? "review" : "landing", landingStep: asked("verifying") },
  quoting: { ended: false, settled: false, waitsOnPerson: false, cancellable: true, track: "landing", landingStep: reached("checking") },
  approved: { ended: true, settled: false, waitsOnPerson: true, cancellable: false, track: (_, r) => r.land === null ? "review" : "landing" },
  merging: { ended: false, settled: false, waitsOnPerson: false, cancellable: true, landing: (phase) => phase.authorized === null ? null : "merges", track: "landing", landingStep: reached("merging") },
  deploying: { ended: false, settled: false, waitsOnPerson: false, cancellable: false, landing: () => "deploys", track: "landing", landingStep: reached("deploying") },
  "rolling-back": { ended: false, settled: false, waitsOnPerson: false, cancellable: false, landing: () => "rolls back", track: "landing", landingStep: reached("deploying", true) },
  landed: { ended: true, settled: true, waitsOnPerson: false, cancellable: false, track: "deployed", landingStep: reached("landed") },
  "needs-person": {
    ended: true, settled: false, waitsOnPerson: true, cancellable: true, track: (_, r) => r.merged === null ? "review" : "landing",
    landingStep: (_, r) => r.merged !== null && r.land !== null ? { step: "deploying", failed: true } : null,
  },
  merged: { ended: true, settled: true, waitsOnPerson: false, cancellable: false, track: "deployed" },
  closed: { ended: true, settled: true, waitsOnPerson: false, cancellable: false, track: null },
  cancelled: { ended: true, settled: true, waitsOnPerson: false, cancellable: false, track: null },
} as const satisfies { [K in PhaseKind]: PhaseRow<Extract<Phase, { kind: K }>> };
export type EndedKind = { [K in PhaseKind]: typeof phases[K]["ended"] extends true ? K : never }[PhaseKind];
// Each row's functions take its own phase, which `phase.kind` picks, so the row of any phase reads it.
const rowAt = (kind: PhaseKind) => phases[kind] as unknown as PhaseRow<Phase>;
const rowOf = (phase: Phase) => rowAt(phase.kind);
type Flags = Record<"ended" | "settled" | "waitsOnPerson" | "cancellable" | "landing" | "awaitsBuilder", boolean>;
/** The phase kinds whose row's flags pass `has`, which the store's SQL filters read. */
export const kindsWhere = (has: (flags: Flags) => boolean) => (Object.keys(phases) as PhaseKind[]).filter((kind) => {
  const { ended, settled, waitsOnPerson, cancellable, landing, awaitsBuilder } = rowAt(kind);
  return has({ ended, settled, waitsOnPerson, cancellable, landing: landing !== undefined, awaitsBuilder: awaitsBuilder !== undefined });
});
export const ended = (r: Pick<Review, "phase">) => rowOf(r.phase).ended;
export const settled = (r: Pick<Review, "phase">) => rowOf(r.phase).settled;
export const waitsOnPerson = (r: Review | null) => r !== null && rowOf(r.phase).waitsOnPerson;
export const inLanding = (r: Pick<Review, "phase">) => rowOf(r.phase).landing !== undefined;
export const landingVerb = (r: Pick<Review, "phase">) => rowOf(r.phase).landing?.(r.phase) ?? null;
export const trackStep = (r: Review): TrackStep | null => {
  const { track } = rowOf(r.phase);
  return typeof track === "function" ? track(r.phase, r) : track;
};
export const landingAt = (r: Review) => rowOf(r.phase).landingStep?.(r.phase, r) ?? null;
/**
 * A landing under way is seen through, so the person cannot cancel it. A review that ended for the person can be, so
 * it stops waiting on them, as nothing else ends it once its pull request merged outside it.
 */
export const cancellable = (r: Pick<Review, "phase">) => rowOf(r.phase).cancellable && landingVerb(r) === null;
/**
 * How long after its request reached the reviewer a round keeps the builder's pylon up, so findings find it awake rather
 * than paused for 25 seconds of waking, and a reviewer that never answers holds no memory for the hours until the person.
 */
const builderAwaitedMs = 30 * 60_000;
/** Until when `r` keeps its builder's pylon up, counted from the builder's last activity, which a delivery is. */
export const builderAwaited = (r: Review): { from: number; until: number } | null =>
  rowOf(r.phase).awaitsBuilder?.(r.phase, r) === true ? { from: r.since, until: r.since + builderAwaitedMs } : null;

/** A needs-person phase for `cause` whose holds are `items`. A string is a reason of the loop's own. */
export const personPhase = (cause: HoldCause, ...items: readonly (Hold | string)[]) => {
  const holds = items.map((h): Hold => typeof h === "string" ? { code: "loop", text: h } : h);
  return { kind: "needs-person" as const, cause, reasons: holds.map((h) => h.text), holds };
};

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
      detail: `Rebase the branch onto the current base: git fetch origin && git rebase origin/${base}. Resolve each conflict so that both sides' intent survives: keep what ${base} changed and what this pull request adds. Run the typecheck and the full test suite again, then push with git push --force-with-lease. A rebase that leaves the change as it was keeps the approval, and any other gets a new review round. If you cannot resolve a conflict, reject CONFLICT with the reason, and the person takes over.`,
    }, failed: `The branch conflicted with ${base}`,
    verdict: `the reviewer approved, but the branch conflicts with ${base}, so it cannot merge`, code: "loop", pushedNothing: `The branch conflicts with ${base}, and the builder did not rebase it`, output: null,
  }),
};
/**
 * The gate that failed at `round`, or null. A round fails at most one: a failed check counts only once the reviewer
 * approves, the live check runs only after the check passes, and a conflict is recorded only when a merge after both
 * is refused.
 */
export const gateFailure = (round: Round): GateFailure | null => round.check?.passed === false && reviewerApproved(round) ? gates.check(round.head, round.check.output)
  : round.live?.kind === "ran" && !round.live.passed ? gates.live(round.head, round.live.output)
  : round.conflict !== undefined ? gates.conflict(round.head, round.conflict.base) : null;
/** A second reviewer's finding as the builder answers it. No finding's own ID has a dot, so it never meets one of the first reviewer's. */
export const secondId = (id: string) => `2.${id}`;
export const secondFindings = (round: Round): Finding[] => (round.secondVerdict?.findings ?? []).map((f) => ({ ...f, id: secondId(f.id) }));
export const reviewersFindings = (round: Round): Finding[] => [...round.verdict?.findings ?? [], ...secondFindings(round)];
/** What the builder must answer for a round: the reviewers' findings, and the finding of a gate that failed. */
export const findingsOf = (round: Round): Finding[] => {
  const gate = gateFailure(round);
  return [...reviewersFindings(round), ...gate === null ? [] : [gate.finding]];
};
/** The first of `seats` whose verdict at the round is no approval, or null when every one approved. */
export const unapprovedSeat = (round: Round, seats: readonly Seat[] = seatsOf(round)): Seat | null => seats.find((seat) => verdictAt(round, seat)?.verdict !== "approve") ?? null;
/** Every reviewer of the round approved it, whatever a gate after it found. */
export const reviewerApproved = (round: Round) => unapprovedSeat(round) === null;
/** An approval with no blocking finding open, the check included. */
export const approves = (round: Round) => reviewerApproved(round) && !findingsOf(round).some(blocks);
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
export function cannotLand(r: Review, builder: { status: ThreadStatus }, pr?: Pick<PullRequest, "state">): string | null {
  if (builder.status !== "active") return `thread ${r.builder} is ${builder.status}`;
  if (r.merged !== null) return `review ${r.id} already merged pull request #${r.pr.number} as ${r.merged}, so it does not land again`;
  if (pr !== undefined && pr.state !== "open") return `pull request #${r.pr.number} is ${pr.state} on GitHub outside this review, so there is nothing to land`;
  if (!landable(r)) return `review ${r.id} of ${r.builder} is ${r.phase.kind}${r.phase.kind === "needs-person" ? `: ${r.phase.holds.map((h) => h.text).join(" ")}` : ""}, not approved with its checks passing`;
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
    && reviewerApproved(round) && gateFailure(round) !== null;
};
/**
 * The rounds that count against the limit. One that approves again the head its previous round approved on the same
 * base reviewed nothing new, and an approval carried to the same change reviewed nothing at all.
 */
export const roundsSpent = (r: Pick<Review, "rounds">) => r.rounds.filter((round, i) => {
  const previous = r.rounds[i - 1];
  return round.carried === undefined && !(previous !== undefined && previous.head === round.head && previous.base === round.base && reviewerApproved(previous) && reviewerApproved(round));
}).length;
/** The rounds the PR's reviews spent and may spend, the earlier reviews' included, as the person reads them. */
export const prRounds = (r: Pick<Review, "rounds" | "maxRounds" | "earlierRounds">) => ({ spent: r.earlierRounds + roundsSpent(r), max: r.earlierRounds + r.maxRounds });
/**
 * The head `pr` was read at, when it is open there at another head than the latest round's and than the one its hold
 * named. A PR watch's read may be older than the round, so the loop confirms it with GitHub before it acts.
 */
export const pushedHead = (r: Review, pr: Pick<PullRequest, "state"> & { head?: string } | undefined): string | null =>
  pr?.state !== "open" || pr.head === undefined || r.rounds.at(-1)!.head === pr.head || (r.phase.kind === "needs-person" && r.phase.unreviewed === pr.head) ? null : pr.head;
/** The gate run `phase` steps: a reviewing round's check beside the reviewer, the check, or the live check. */
export const gateRun = (phase: Phase): GateRun | null => phase.kind === "checking" || phase.kind === "verifying" ? phase : phase.kind === "reviewing" ? phase.check ?? null : null;
/** The check thread `phase` holds: a checking round's, or a reviewing round's, which runs beside the reviewer. */
export const checkThread = (phase: Phase): ThreadId | null => phase.kind === "verifying" ? null : gateRun(phase)?.thread ?? null;
export const checkOutput = (output: string) => `The check's output:\n${output}`;
export const liveOutput = (output: string) => `The live check's output:\n${output}`;
