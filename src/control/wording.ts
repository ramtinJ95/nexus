/**
 * What the dashboard and `nexus show` say of a thread: a row per kind of need, and each fact sentence they both print,
 * so a state reads one way wherever it shows. A sentence that names a limit or a period reads it from the constant
 * that enforces it.
 */
import type { ThreadDetail } from "./wire.ts";
import type { Thread } from "./thread-store.ts";
import type { ThreadNeed } from "./work.ts";
import { usageLimitText } from "./claude-transcript.ts";
import { archivedDiskMs, keptPastDay } from "./reconcile.ts";
import { maxNudges } from "./nudge.ts";
import { commentCap, reviewedPr } from "./pr-watch-model.ts";
import { changesKeptMs, checkEveryMs, settleMs } from "./doctor-run.ts";
import { blocks, cannotLand, humanLabel, reviewerApproved, roundsSpent, type ModelFailure, type Review, type Verdict } from "./review-model.ts";

const spelled = (n: number) => ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);
const counted = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** A period as a sentence says it: "5 minutes", "24 hours", "30 days". */
export function duration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return counted(minutes, "minute");
  const hours = minutes / 60;
  return hours <= 48 || hours % 24 !== 0 ? counted(hours, "hour") : counted(hours / 24, "day");
}

export const firstLine = (text: string) => text.trim().split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

const limitText = (t: Pick<Thread, "usageLimit">, now: number) => usageLimitText(t.usageLimit ?? { resetsAt: null }, now);

export const stoppedShort = `Its turn ended without a pull request after ${spelled(maxNudges)} nudges`;
export const parkedText = (tasks: number) => `${counted(tasks, "task")} hit the restart limit and hold the run`;
export const dialogWaits = (t: Pick<Thread, "sessionWaitingMessage">) => `${t.sessionWaitingMessage ?? "A dialog waits for input"}, in the pylon's terminal`;
export const plannerGaveUp = (failed: string) => `The planner gave up on its pylon: ${firstLine(failed)}`;
/** Why a failed thread failed: the planner gave up on its pylon, or its Claude worker failed. */
export const failedText = (d: Pick<ThreadDetail, "pylon" | "claudeWorker">) => d.pylon.failed !== null ? plannerGaveUp(d.pylon.failed)
  : `The Claude worker failed${d.claudeWorker?.message === undefined ? "" : `: ${firstLine(d.claudeWorker.message)}`}`;

export const keptPast = `kept past its ${duration(archivedDiskMs)}`;
/** Where an archive's disk is, whose token usage was not read: gone with its pylon, or going once its time is up. */
export const diskGoes = (absent: boolean) => absent ? "its disk went" : `its disk goes ${duration(archivedDiskMs)} after the archive`;

/** A paused session waits for its pylon to run again: the archive's unarchive, or else any wake. */
export const sessionPaused = (t: Pick<Thread, "status">) => `paused, resumes on ${t.status === "archived" ? "unarchive" : "wake"}`;

export const freshVm = "Archive and unarchive the thread to give it a fresh VM. If the guest does not answer the pause either, the changes since its last saved disk are lost, so push or copy what you can first.";

export const prWatchText = (w: Pick<ThreadDetail["prWatch"], "enabled" | "stopped">) => !w.enabled ? "PR watch: off (no control-plane GitHub token configured)"
  : w.stopped ? `PR watch: stopped (${commentCap} comment-only wakes)` : "PR watch: on";

export const doctorSchedule = `every ${duration(checkEveryMs)} from ${duration(settleMs)} after a start`;
export const changesKept = duration(changesKeptMs);

/**
 * Why the latest round started, when it reviews a head pushed after the previous round's approval rather than the
 * builder's fixes, or carries that approval to the head.
 */
export function roundNote(r: Review): string | null {
  const [previous, round] = r.rounds.slice(-2);
  if (round?.carried !== undefined) return `${round.carried.held ? "hold" : "approval"} carried from ${round.carried.from.slice(0, 12)} to ${round.head.slice(0, 12)}: same change after a rebase`;
  if (round === undefined || previous!.answers !== null || !reviewerApproved(previous!)) return null;
  if (round.head === previous!.head && round.base !== previous!.base) return `a new round reviews ${round.head.slice(0, 12)} against ${round.base}, since the pull request's base changed from ${previous!.base} after its approval`;
  return `a new round reviews ${round.head.slice(0, 12)}, since the pull request's head moved from ${previous!.head.slice(0, 12)} after its approval`;
}
const labelStates = { adding: `, adding the label "${humanLabel}"`, added: `, labelled "${humanLabel}"`, failed: `, label "${humanLabel}" not added` } as const;
/** How a review's line in `nexus show` and the dashboard ends. A refused label's why is already one of the reasons. */
export const phaseNote = (r: Review) => r.phase.kind === "cancelled" ? r.phase.who === "person" ? `, cancelled by ${r.phase.by}` : `, the ${r.phase.who} thread ${r[r.phase.who]} was ${r.phase.status}`
  : r.phase.kind === "merging" && r.phase.waiting !== undefined ? `, waiting while ${r.phase.waiting}`
  : r.phase.kind === "needs-person" && r.phase.label ? labelStates[r.phase.label.state]
  : `${(r.phase.kind === "reviewing" || r.phase.kind === "fixing" || r.phase.kind === "quoting") && r.phase.failing ? failingNote(r.phase.kind === "fixing" ? "builder" : "reviewer", r.phase.failing) : ""}${r.phase.kind === "reviewing" && r.second?.kind === "claude" && r.second.failing ? failingNote("second reviewer", r.second.failing) : ""}`;
const failingNote = (who: string, failing: ModelFailure) => `, the ${who}'s model is failing (${failing.count} in a row, last: ${failing.last}), retrying at ${new Date(failing.retryAt).toISOString().slice(11, 16)} UTC`;
const verdictWord = (v: Verdict | null | undefined) => v === undefined ? "did not review it" : v === null ? "has not answered" : v.verdict === "changes" ? `asks for changes (${v.findings.filter(blocks).map((f) => f.priority).join(", ")})` : "approves";
/**
 * Both reviewers of a review the project's rule gave a second one, and their verdicts at the latest round, as `nexus
 * show` and the dashboard say them, or null for a review with one reviewer.
 */
export function reviewersNote(r: Review): string | null {
  if (r.second === undefined) return null;
  const round = r.rounds.at(-1)!;
  const first = `round ${r.rounds.length}: the reviewer ${r.reviewer} on ${r.models.reviewer} ${verdictWord(round.verdict)}`;
  if (r.second.kind === "none") return `${first}. No second reviewer runs, though ${r.second.rule}: ${r.second.why}`;
  if (r.second.kind === "starting") return `${first}, and the second reviewer on ${r.second.model} is starting${r.second.why === null ? "" : `, after a start that failed: ${r.second.why}`}. It reviews since ${r.second.rule}`;
  return `${first}, and the second reviewer ${r.second.thread} on ${r.second.model} ${verdictWord(round.secondVerdict)}. It reviews since ${r.second.rule}`;
}
/** What a reviewing round's check does beside the reviewer, which a review's line adds to its phase note, so it says whether the round waits on one or both. */
export function checkBeside(r: Review): string {
  if (r.phase.kind !== "reviewing") return "";
  const { head, check } = r.rounds.at(-1)!;
  if (check !== null) return `, .nexus/check ${check.passed ? "passed" : "failed"} at ${head.slice(0, 12)}`;
  if (r.phase.check === undefined) return "";
  if (r.phase.check.unrunnable !== undefined) return `, .nexus/check could not run at ${head.slice(0, 12)}`;
  if (r.phase.check.refused !== undefined) return `, .nexus/check runs once the reviewer approves, since no node had room for it: ${r.phase.check.refused}`;
  return r.phase.check.thread === null ? `, .nexus/check starting at ${head.slice(0, 12)}` : `, .nexus/check running at ${head.slice(0, 12)} in check thread ${r.phase.check.thread}`;
}
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
  if (round.check?.passed !== true) return null;
  return (r.phase.kind === "reviewing" || r.phase.kind === "fixing") && !reviewerApproved(round) ? `no live check yet: it runs at ${head} once the reviewer approves it` : `no live check ran at ${head}`;
}
export const roundOf = (r: Pick<Review, "rounds" | "maxRounds">) => `round ${roundsSpent(r)} of ${r.maxRounds}`;

/**
 * A review's line, around its reviewer, which the dashboard links and `nexus show` names: its ID and pull request, its
 * phase and round, the reviewer's model, whether it lands once approved, and its phase's note.
 */
export function reviewLine(r: Review): { lead: string; tail: string } {
  const phase = r.phase.kind === "landed" ? `landed as ${r.phase.commit}` : r.phase.kind === "deploying" ? `deploying ${r.phase.commit}` : r.phase.kind;
  return {
    lead: `review ${r.id} of PR #${r.pr.number}${r.auto ? ", started on its own" : ""}: ${phase}, ${roundOf(r)}, reviewer `,
    tail: ` on ${r.models.reviewer}${r.land === null ? "" : ", landing when approved"}${phaseNote(r)}${checkBeside(r)}`,
  };
}

/** One kind of what waits on the person, as its card in the inbox and the timeline's hold name it. */
export type NeedKind = "held-review" | "approved-review" | "holds" | "ask" | "proposal" | "judgment" | "question" | "nudge" | "resume" | "disk" | "waiting" | "limited" | "parked" | "failed";
type NeedOf<K extends NeedKind> = K extends "held-review" | "approved-review" ? Extract<ThreadNeed, { kind: "review" }>
  : K extends "holds" | "ask" | "proposal" | "judgment" | "question" ? Extract<ThreadNeed, { kind: "question" }>
  : K extends "nudge" | "resume" | "disk" ? Extract<ThreadNeed, { kind: K }>
  : Extract<ThreadNeed, { kind: "thread" }>;

/** What gets a stopped thread past the stop: a button its card presses, or its terminal, where a dialog waits. */
export type NeedAction = { kind: "button"; action: string; label: string; confirm?: string; danger?: true } | { kind: "terminal" };
/** A card that says in full what stopped its thread, with the one action that gets past it. */
export interface NeedFix { body: string; action: NeedAction }

interface NeedRow<K extends NeedKind> {
  label: string;
  /** In a line, which the card the need opens to says in full. Empty where that card says it. */
  why(n: NeedOf<K>, now: number): string;
  fix?(n: NeedOf<K>, now: number): NeedFix;
}

const asked = (n: NeedOf<"question">) => firstLine(n.question.ask?.questions[0]?.question ?? n.question.proposal?.title ?? n.question.text);
const button = (action: string, label: string, confirm?: string): NeedAction => ({ kind: "button", action, label, ...confirm === undefined ? {} : { confirm } });

const needRows: { [K in NeedKind]: NeedRow<K> } = {
  "held-review": { label: "Review needs you", why: () => "" },
  "approved-review": { label: "Approved, yours to land", why: () => "" },
  holds: { label: "Holds to waive", why: asked },
  ask: { label: "Claude asks", why: asked },
  proposal: { label: "Proposed item", why: asked },
  judgment: { label: "Judgment", why: asked },
  question: { label: "Needs your decision", why: asked },
  nudge: { label: "Stopped short of a pull request", why: () => stoppedShort },
  resume: { label: "Stopped resuming its turns", why: (n) => n.why },
  disk: {
    label: "Disk kept for its usage",
    why: (n, now) => firstLine(keptPastDay(n.d.thread, now) ?? "Its disk is kept for its token usage"),
    fix: (n, now) => ({
      body: `Its disk is ${keptPast}, as ${keptPastDay(n.d.thread, now)}. Nexus tries the read again on its own, or delete the thread, which deletes the disk with the token usage on it unread.`,
      action: { ...button("delete", "Delete", `Delete "${n.d.thread.title}"? Its disk goes with the token usage on it unread.`), danger: true },
    }),
  },
  waiting: { label: "Dialog in its terminal", why: (n) => dialogWaits(n.d.thread), fix: (n) => ({ body: `${dialogWaits(n.d.thread)}.`, action: { kind: "terminal" } }) },
  limited: {
    label: "Usage limit",
    why: (n, now) => `It ${limitText(n.d.thread, now)}`,
    fix: (n, now) => ({ body: `It ${limitText(n.d.thread, now)}. Nexus has it continue once the limit resets, or archive it to stop it.`, action: button("archive", "Archive") }),
  },
  parked: { label: "Stuck on the restart limit", why: (n) => parkedText(n.d.agent?.parkedTasks ?? 0), fix: (n) => ({ body: `${parkedText(n.d.agent?.parkedTasks ?? 0)}.`, action: button("retry", "Retry") }) },
  failed: {
    label: "Failed",
    why: (n) => failedText(n.d),
    fix: ({ d }) => d.pylon.failed !== null && d.pylon.retryRefused === null ? { body: failedText(d), action: button("retry-pylon", "Retry") }
      : { body: d.pylon.retryRefused === null ? failedText(d) : `${failedText(d)} ${d.pylon.retryRefused}.`, action: button("archive", "Archive") },
  },
};

/** The pull request a review is of, as the PR watch last read it. */
export const reviewPr = (d: Pick<ThreadDetail, "pullRequests" | "review" | "prWatch">) => d.review === null ? undefined : reviewedPr(d.review, d.pullRequests, d.prWatch.stopped);

/** A review waits on the person to land it once approved, and for anything else once it is held or cannot land. */
export function needKind(n: ThreadNeed): NeedKind {
  switch (n.kind) {
    case "review": {
      const r = n.d.review!;
      return r.phase.kind === "needs-person" || cannotLand(r, n.d.thread, reviewPr(n.d)) !== null ? "held-review" : "approved-review";
    }
    case "question": {
      const q = n.question;
      return q.holds !== undefined ? "holds" : q.ask !== undefined ? "ask" : q.proposal !== undefined ? "proposal" : n.d.judgments.some((j) => j.question === q.id) ? "judgment" : "question";
    }
    case "thread": return n.attention;
    default: return n.kind;
  }
}

export const needLabels = Object.fromEntries(Object.entries(needRows).map(([kind, row]) => [kind, row.label])) as Record<NeedKind, string>;

/** A need's kind and its row's words for it. `fix` is the card of a stop no other card acts on. */
export function needWording(n: ThreadNeed, now: number): { kind: NeedKind; label: string; why: string; fix: NeedFix | null } {
  const kind = needKind(n);
  const row = needRows[kind] as NeedRow<NeedKind>;
  return { kind, label: row.label, why: row.why(n as never, now), fix: row.fix?.(n as never, now) ?? null };
}
