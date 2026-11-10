/**
 * The life of a piece of work, as the home page's phases and a thread's timeline show it. Nothing here is stored: each
 * card's place is read from what the registry already says, the pipeline's phase of an item or a thread, its review
 * and what waits on the person.
 */
import type { ThreadId } from "../../ids.ts";
import { phaseStep, steps, type ItemPhase, type PipelineItem, type Step } from "../pipeline.ts";
import { checkThread, landingAt, landingSteps, roundsSpent, type LandingAt, type LandingStep, type PhaseKind, type Review } from "../review-model.ts";
import { html, type Html, type Tone } from "./view.ts";
import { checkBeside, duration, heldNote, liveNote, needWording } from "../wording.ts";
import type { Context } from "./context.ts";
import type { ThreadNeed } from "../wire.ts";
import type { Role } from "../agent-protocol.ts";

export type Stage = Step | "held";

/** How long a landed thread stays under Deployed once it is archived, as the review loop archives each builder that lands. */
export const deployedForMs = 24 * 60 * 60 * 1000;

/** Each phase of the work in flight, in the order work moves through them, with the tone of its marker. */
export const stages: readonly { stage: Stage; label: string; tone: Tone; means: string }[] = [
  { stage: "planned", label: "Planned", tone: "idle", means: "Items lined up, not queued yet" },
  { stage: "queued", label: "Queued", tone: "idle", means: "Threads that start once the work they wait on merges" },
  { stage: "building", label: "Building", tone: "work", means: "An agent works on it, with no pull request in review yet" },
  { stage: "review", label: "In review", tone: "review", means: "Its pull request is open, or the review loop runs its rounds" },
  { stage: "held", label: "Held for you", tone: "bad", means: "Only you move these on" },
  { stage: "landing", label: "Landing", tone: "busy", means: "Checked, merged and deployed one at a time" },
  { stage: "deployed", label: "Deployed", tone: "ok", means: `Merged, and deployed where the project deploys, until ${duration(deployedForMs)} after its thread is archived` },
];
export const stageLabel = Object.fromEntries(stages.map((s) => [s.stage, s.label])) as Record<Stage, string>;

/**
 * Where a piece of work is: the phase it shows in, or null once it was archived or cancelled short of landing, the
 * step it reached, held or not, what moves it on, and what of it waits on the person.
 */
export interface Life { stage: Stage | null; at: Step; why: string; needs: readonly ThreadNeed[] }

/** Each pipeline phase's stage, or null once the work was archived or cancelled short of landing. */
export const stageOf = (kind: ItemPhase["kind"]): Stage | null => kind === "held" ? "held" : phaseStep[kind];
export const phaseTone: Record<ItemPhase["kind"], Tone> = {
  planned: "idle", queued: "idle", building: "work", reviewing: "work", held: "bad", landing: "busy", landed: "ok", archived: "muted", cancelled: "muted",
};

/** What a review does next, in the words of the step it is on. */
function reviewNext(r: Review): string | null {
  const round = r.rounds.length;
  switch (r.phase.kind) {
    case "reviewing": return `The reviewer reads round ${round}${checkBeside(r)}${heldNote(r)}`;
    case "fixing": return `The builder answers round ${round}'s findings`;
    case "quoting": return "The reviewer quotes what could not be checked live";
    case "checking": return `Runs .nexus/check at the approved head${heldNote(r)}`;
    case "verifying": return `${liveNote(r) ?? "Runs the live check"}${heldNote(r)}`;
    case "approved": return r.land === null ? "Approved, and lands once you press Land" : "Approved, landing next";
    case "merging": return r.phase.waiting === undefined ? "Merging" : `Waits to merge while ${r.phase.waiting}`;
    case "deploying": return `Deploying ${r.phase.commit.slice(0, 12)}`;
    case "rolling-back": return `Rolling back: ${r.phase.why}`;
    case "landed": return `Merged as ${r.phase.commit.slice(0, 12)}`;
    case "needs-person": return r.phase.holds[0]?.text ?? null;
    case "merged": case "closed": case "cancelled": return null;
    default: return r.phase satisfies never;
  }
}

const ranIn = (r: Review, id: ThreadId) => checkThread(r.phase) === id || (r.phase.kind === "verifying" && r.phase.thread === id)
  || r.rounds.some((round) => round.live?.kind === "ran" && round.live.thread === id);

/** Where a review is, in a word or two after the thread it serves. */
const reviewAt: Record<PhaseKind, (r: Review) => string> = {
  reviewing: (r) => `reviewing round ${roundsSpent(r)}`, fixing: (r) => `the builder answers round ${roundsSpent(r)}`,
  checking: () => "running the checks", quoting: () => "quoting what could not be checked live", verifying: () => "running the live check", approved: (r) => r.land === null ? "approved, yours to land" : "approved, landing next",
  merging: () => "merging", deploying: () => "deploying", "rolling-back": () => "rolling back", landed: () => "landed", "needs-person": () => "needs you",
  merged: () => "merged outside its review", closed: () => "its pull request closed", cancelled: () => "cancelled",
};

/** What a check or verify thread did, from its own run when the review records it. */
function runAt(r: Review, id: ThreadId): string {
  if (checkThread(r.phase) === id || (r.phase.kind === "verifying" && r.phase.thread === id)) return "running";
  const live = r.rounds.find((round) => round.live?.kind === "ran" && round.live.thread === id)?.live;
  return live?.kind === "ran" ? live.passed ? "passed" : "failed" : reviewAt[r.phase.kind](r);
}

/**
 * A thread that is not a builder says in one line what it is, in place of the track, with the review it serves, until
 * its builder's next review replaced it or its check is over.
 */
export function roleLine(c: Pick<Context, "reviews" | "thread">, id: ThreadId, role: Exclude<Role, "builder">): Html {
  if (role === "planning") return html`<p class="role-line">Planning thread. Each item it proposes waits for you to accept it.</p>`;
  const r = c.reviews().find((r) => role === "reviewer" ? r.reviewer === id || (r.second?.kind === "claude" && r.second.thread === id) : ranIn(r, id));
  const what = { reviewer: "Reviewer", check: "Check", verify: "Live check" }[role];
  if (r === undefined) return html`<p class="role-line">${what} for a review that has moved on.</p>`;
  const builder = html`<a class="link" href="/threads/${r.builder}">${c.thread(r.builder)?.title ?? r.builder}</a>`;
  const at = role === "reviewer" ? reviewAt[r.phase.kind](r) : runAt(r, id);
  return html`<p class="role-line">${what} of <a class="link" href="${r.pr.url}" target="_blank" rel="noreferrer">PR #${r.pr.number}</a> for ${builder}<span class="role-at">${at}</span></p>`;
}

/** A started or queued thread's life, from its pipeline phase and what of it waits on the person. */
export function lifeOfThread(c: Pick<Context, "stage" | "review" | "needs" | "now">, id: ThreadId): Life {
  const { phase, at } = c.stage(id);
  const needs = c.needs.filter((n): n is ThreadNeed => n.kind !== "cleanup" && n.kind !== "held" && n.d.thread.id === id);
  const review = c.review(id);
  const said = (needs.length === 0 ? null : needWording(needs[0]!, c.now).why || null) ?? (review === null ? null : reviewNext(review));
  return { stage: stageOf(phase.kind), at, why: said ?? phase.why, needs };
}

/** An item's life: its thread's once it has one, and before then its own phase on the first step. */
export function lifeOfItem(c: Pick<Context, "stage" | "review" | "needs" | "now">, item: PipelineItem): Life {
  if (item.thread !== null) return lifeOfThread(c, item.thread);
  return { stage: stageOf(item.phase.kind), at: "planned", why: item.phase.why, needs: [] };
}

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

const landingLabels: Record<LandingStep, string> = { checking: "Check", verifying: "Live check", merging: "Merge", deploying: "Deploy", landed: "Landed" };
export type LandingState = "done" | "now" | "failed" | "todo" | "skipped";
/**
 * The steps of `r`'s landing, each with its state, or null when no landing is on its way, as the landing card and the
 * timeline draw them. A project that does not deploy skips the deploy. A landing past the live check with none recorded
 * is one from before live checks, and `unverified` says why it skipped it.
 */
export function landingTrack(r: Review, deploys: boolean): { at: LandingAt; unverified: string | null; steps: { step: LandingStep; label: string; state: LandingState }[] } | null {
  const at = landingAt(r);
  if (at === null) return null;
  const index = landingSteps.indexOf(at.step);
  const { live } = r.rounds.at(-1)!;
  const unverified = live?.kind === "absent" ? " (no .nexus/verify)" : live === undefined && index > 1 ? " (not run)" : null;
  const stateOf = (step: LandingStep, i: number): LandingState => (step === "deploying" && !deploys) || (step === "verifying" && unverified !== null) ? "skipped"
    : i < index || at.step === "landed" ? "done" : i > index ? "todo" : at.failed ? "failed" : "now";
  return { at, unverified, steps: landingSteps.map((step, i) => ({ step, label: landingLabels[step], state: stateOf(step, i) })) };
}
