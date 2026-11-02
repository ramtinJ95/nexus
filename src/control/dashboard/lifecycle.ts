/**
 * The life of a piece of work, as the home page's phases and a thread's timeline show it. Nothing here is stored: each
 * card's place is read from what the registry already says, the pipeline's phase of an item or a thread, its review
 * and what waits on the person.
 */
import type { ThreadId } from "../../ids.ts";
import { itemView, threadPhase, type ItemPhase, type PipelineItem } from "../pipeline.ts";
import { liveNote, type Review } from "../review-model.ts";
import { html, limitText, type Html, type Tone } from "./view.ts";
import { landingAt } from "./cards.ts";
import type { Context, ThreadNeed } from "./context.ts";

/** The steps every piece of work takes, in order. Held is not a step: work is held for the person at one of them. */
export const steps = ["planned", "queued", "building", "review", "landing", "deployed"] as const;
export type Step = typeof steps[number];
export type Stage = Step | "held";

/** Each phase of the work in flight, in the order work moves through them, with the tone of its marker. */
export const stages: readonly { stage: Stage; label: string; tone: Tone; means: string }[] = [
  { stage: "planned", label: "Planned", tone: "idle", means: "Items lined up, not queued yet" },
  { stage: "queued", label: "Queued", tone: "idle", means: "Threads that start once the work they wait on merges" },
  { stage: "building", label: "Building", tone: "work", means: "An agent works on it, with no pull request in review yet" },
  { stage: "review", label: "In review", tone: "review", means: "Its pull request is open, or the review loop runs its rounds" },
  { stage: "held", label: "Held for you", tone: "bad", means: "Only you move these on" },
  { stage: "landing", label: "Landing", tone: "busy", means: "Checked, merged and deployed one at a time" },
  { stage: "deployed", label: "Deployed", tone: "ok", means: "Merged, and deployed where the project deploys, until a day after its thread is archived" },
];
export const stageLabel = Object.fromEntries(stages.map((s) => [s.stage, s.label])) as Record<Stage, string>;

/**
 * Where a piece of work is: the phase it shows in, or null once it was archived or cancelled short of landing, the
 * step it reached, held or not, what moves it on, and what of it waits on the person.
 */
export interface Life { stage: Stage | null; at: Step; why: string; needs: readonly ThreadNeed[] }

const ofPhase: Record<ItemPhase["kind"], Stage | null> = {
  planned: "planned", queued: "queued", building: "building", reviewing: "review", held: "held", landing: "landing", landed: "deployed", archived: null, cancelled: null,
};

/** The step a review has taken its thread to, whatever holds it there. */
function reviewStep(r: Review): Step {
  switch (r.phase.kind) {
    case "merging": case "deploying": case "rolling-back": return "landing";
    case "landed": case "merged": return "deployed";
    case "needs-person": return r.merged === null ? "review" : "landing";
    default: return "review";
  }
}

/** What a review does next, in the words of the step it is on. */
function reviewNext(r: Review): string | null {
  const round = r.rounds.length;
  switch (r.phase.kind) {
    case "reviewing": return `The reviewer reads round ${round}`;
    case "fixing": return `The builder answers round ${round}'s findings`;
    case "checking": return "Runs .nexus/check at the approved head";
    case "verifying": return liveNote(r) ?? "Runs the live check";
    case "approved": return r.land === null ? "Approved, and lands once you press Land" : "Approved, landing next";
    case "merging": return r.phase.waiting === undefined ? "Merging" : `Waits to merge while ${r.phase.waiting}`;
    case "deploying": return `Deploying ${r.phase.commit.slice(0, 12)}`;
    case "rolling-back": return `Rolling back: ${r.phase.why}`;
    case "landed": return `Merged as ${r.phase.commit.slice(0, 12)}`;
    case "needs-person": return r.phase.reasons[0] ?? null;
    default: return null;
  }
}

/** What a card says waits on the person, from the first thing of the thread's that does. */
export function needLabel(n: ThreadNeed): string {
  switch (n.kind) {
    case "review": return n.d.review?.phase.kind === "needs-person" ? "Review needs you" : "Approved, yours to land";
    case "nudge": return "Stopped short of a pull request";
    case "question": return n.question.ask !== undefined ? "Claude asks" : n.question.proposal !== undefined ? "Proposed item" : (n.d.judgments ?? []).some((j) => j.question === n.question.id) ? "Judgment" : "Needs your decision";
    case "thread": return { waiting: "Dialog in its terminal", limited: "Usage limit", parked: "Stuck on the restart limit", failed: "Failed" }[n.attention];
  }
}

const firstLine = (text: string) => text.trim().split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

/** Why a thing of the thread's waits on the person, in a line, which the card it opens to says in full. */
export function needWhy(n: ThreadNeed, now: number): string {
  const { d } = n;
  const t = d.thread;
  switch (n.kind) {
    case "review": return "";
    case "nudge": return "Its turn ended without a pull request after two nudges";
    case "question": return firstLine(n.question.ask?.questions[0]?.question ?? n.question.proposal?.title ?? n.question.text);
    case "thread": switch (n.attention) {
      case "waiting": return t.sessionWaitingMessage ?? "A dialog waits for input in the pylon's terminal";
      case "limited": return `It ${limitText(t, now)}`;
      case "parked": return `${d.agent?.parkedTasks ?? 0} ${d.agent?.parkedTasks === 1 ? "task" : "tasks"} hit the restart limit`;
      case "failed": return firstLine(d.pylon.failed ?? d.claudeWorker?.message ?? "It failed");
    }
  }
}

/** A started or queued thread's life, from its pipeline phase and what of it waits on the person. */
export function lifeOfThread(c: Pick<Context, "registry" | "needs" | "now">, id: ThreadId): Life {
  const phase = threadPhase(c.registry, id);
  const needs = c.needs().filter((n): n is ThreadNeed => n.kind !== "cleanup" && n.kind !== "held" && n.d.thread.id === id);
  const review = c.registry.review(id);
  const started = c.registry.thread(id) !== undefined;
  // A review's checks run as the first steps of its landing once it was asked to land, as the landing card shows them.
  const landing = review !== null && phase.kind === "reviewing" && landingAt(review) !== null;
  const mapped = landing ? "landing" : ofPhase[phase.kind];
  const at: Step = mapped !== null && mapped !== "held" ? mapped
    : review !== null ? reviewStep(review)
    : !started ? "queued"
    : c.registry.prWatch(id)?.links.some((l) => l.pr.state === "open") ? "review" : "building";
  const stage = needs.length > 0 ? "held" : mapped;
  const said = (needs.length === 0 ? null : needWhy(needs[0]!, c.now) || null) ?? (review === null ? null : reviewNext(review));
  return { stage, at, why: said ?? phase.why, needs };
}

/** An item's life: its thread's once it has one, and before then its own phase on the first step. */
export function lifeOfItem(c: Pick<Context, "registry" | "needs" | "now">, item: PipelineItem): Life {
  if (item.thread !== null) return lifeOfThread(c, item.thread);
  return { stage: ofPhase[item.phase.kind], at: "planned", why: item.phase.why, needs: [] };
}

export const itemsOf = (c: Pick<Context, "registry">) => c.registry.items().map((i) => itemView(c.registry, i));

/**
 * The track of steps a card or a page draws: each step done, the one it is at, held there or not, and those ahead.
 * Work that ended short of deploying leaves the steps it never took as skipped.
 */
export type StepState = "done" | "now" | "held" | "todo" | "skipped";
export function stepStates(life: Life): Record<Step, StepState> {
  const at = steps.indexOf(life.at);
  return Object.fromEntries(steps.map((step, i) => [step, i < at || life.stage === "deployed" ? "done"
    : i > at ? life.stage === null ? "skipped" : "todo"
    : life.stage === "held" ? "held" : life.stage === null ? "done" : "now"])) as Record<Step, StepState>;
}

/** A card's small track: one segment per step, said once in words for a screen reader. */
export function miniTrack(life: Life): Html {
  const states = stepStates(life);
  const said = life.stage === "held" ? `held for you at ${stageLabel[life.at].toLowerCase()}` : life.stage === null ? `ended at ${stageLabel[life.at].toLowerCase()}` : `at ${stageLabel[life.at].toLowerCase()}`;
  return html`<span class="trk" role="img" aria-label="${said}">${steps.map((step) => html`<i class="trk-${states[step]}"></i>`)}</span>`;
}
