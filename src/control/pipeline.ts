/**
 * Pipeline items: a roadmap's worth of work lined up ahead, each item a brief that becomes a queued thread once every
 * item it waits on is one, in a project the pipeline runs for. The queue then starts it once those items' threads have
 * merged their pull requests, and the review loop reviews, lands and archives it as it does any builder.
 *
 * An item keeps only what the person gave it. Its thread is the one its request ID `pipeline:<item>` made, stored in
 * the same transaction as the queued record, so a pass after a crash finds the thread and never queues a second. Its
 * phase is derived on every read from the records that thread has: the queued record, the thread, its pull request
 * links, its review, its attention and what of it waits on the person.
 */
import { defaultClaudeModel } from "../protocol/models.ts";
import { singleFlight } from "../single-flight.ts";
import { newItemId, requestIds, type ItemId, type ProjectId, type ThreadId } from "../ids.ts";
import { Refusal } from "./refusal.ts";
import { queuedView, waitOf, type ThreadQueue } from "./queue.ts";
import { checkBeside, liveNote, phaseNote, trackStep, type Review } from "./review-model.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import { attentions } from "./attention.ts";
import { personNeeds, prLocationOf, type PersonNeed } from "./work-model.ts";
import { checkStart, startKey } from "./threads.ts";
import type { StartRequest } from "./start-request.ts";
import type { ItemRecord } from "./pipeline-store.ts";

type PipelineRegistry = Pick<Registry, "attention" | "createThread" | "currentImage" | "isReviewer" | "item" | "items" | "latestHealthSample" | "needs" | "node" | "nodes" | "planning" | "prWatch" | "project" | "pylonsWithStatusOn" | "pylonsWithThreadsOn" | "queuedThread" | "queuedThreads" | "reserve" | "reserved" | "review" | "saveItem" | "saveQueued" | "saveTemplate" | "startRequest" | "templates" | "thread">;

/** `held` waits on the person, for an approval, a blocked queue, a review that ended for them or a thread that needs them. */
export interface ItemPhase { kind: "planned" | "queued" | "building" | "reviewing" | "landing" | "landed" | "held" | "archived" | "cancelled"; why: string }

/** The steps every piece of work takes, in order. Held is not a step: work is held for the person at one of them. */
export const steps = ["planned", "queued", "building", "review", "landing", "deployed"] as const;
export type Step = typeof steps[number];
/** The step each phase is, or null for work held at a step or archived or cancelled short of landing. */
export const phaseStep: Record<ItemPhase["kind"], Step | null> = {
  planned: "planned", queued: "queued", building: "building", reviewing: "review", landing: "landing", landed: "deployed", held: null, archived: null, cancelled: null,
};

/** The API's view of an item, which `nexus items`, `nexus item show` and the dashboard's pipeline page show. */
export interface PipelineItem {
  id: ItemId;
  project: ProjectId;
  title: string;
  addedBy: string;
  addedAt: number;
  after: readonly ItemId[];
  worker: "harness" | "claude";
  model: string | null;
  brief: string | null;
  /** The thread it became, queued or started, or null before it is queued. */
  thread: ThreadId | null;
  phase: ItemPhase;
  approved: { by: string; at: number } | null;
}

export const itemThread = (registry: PipelineRegistry, id: ItemId): ThreadId | null => registry.startRequest(requestIds.pipeline(id))?.thread ?? null;

const phase = (kind: ItemPhase["kind"], why: string): ItemPhase => ({ kind, why });

/** What an item with no thread waits for, or null once the pass may queue it. */
function unqueued(registry: PipelineRegistry, item: ItemRecord): ItemPhase | null {
  if (item.cancelled !== null) return phase("cancelled", `cancelled by ${item.cancelled.by}`);
  const setting = registry.project(item.project)?.pipeline;
  if (setting == null) return phase("planned", `the pipeline does not run for project ${item.project}`);
  for (const id of item.after) {
    if (itemThread(registry, id) !== null) continue;
    const ahead = registry.item(id)!;
    return ahead.cancelled === null ? phase("planned", `waits for ${ahead.title} to be queued`) : phase("held", `${ahead.title} was cancelled, so this never starts. Cancel it, or add it again after other items`);
  }
  if (!setting.autoStart && item.approved === null) return phase("held", `project ${item.project} waits for the person to approve each item: nexus item approve ${item.id}`);
  return null;
}

function queuedPhase(registry: PipelineRegistry, id: ThreadId): ItemPhase {
  const queued = registry.queuedThread(id)!;
  if (queued.status !== "queued") return phase("cancelled", `its queued thread was ${queued.status === "archived" ? "cancelled" : "deleted"}`);
  const view = queuedView(registry, queued);
  const name = (thread: ThreadId) => registry.thread(thread)?.title ?? registry.queuedThread(thread)?.title ?? thread;
  const blocked = view.waits.find((w) => w.state === "blocked");
  if (blocked !== undefined) return phase("held", `blocked by ${name(blocked.thread)}: ${blocked.why}`);
  if (queued.refused !== undefined) return phase("held", `did not start: ${view.lastError}`);
  const waiting = view.waits.find((w) => w.state === "waiting");
  if (waiting !== undefined) return phase("queued", `waits for ${name(waiting.thread)}: ${waiting.why}`);
  return phase("queued", view.lastError === null ? "starts on the queue's next pass" : `did not start yet: ${view.lastError}`);
}

/** Quoting, and a review's checks once it was asked to land, are the first steps of its landing. */
const onTrack = (r: Review) => trackStep(r) === "landing" ? "landing" : "reviewing";

function startedPhase(registry: PipelineRegistry, t: Thread, review: Review | null): ItemPhase {
  const { id } = t;
  const pr = review === null ? "" : `PR #${review.pr.number}`;
  switch (review?.phase.kind) {
    case "landed": return phase("landed", `${pr} merged as ${review.phase.commit.slice(0, 12)}`);
    case "merged": return phase("landed", `${pr} merged outside its review`);
    case "needs-person": return phase("held", `its review ended for the person: ${review.phase.reasons[0] ?? "no reason given"}`);
    case "merging": case "deploying": case "rolling-back": return phase("landing", `${pr} is ${review.phase.kind.replace("-", " ")}${phaseNote(review)}`);
    case "approved": return review.land === null ? phase("held", `${pr} is approved, and lands once the person runs nexus land ${id}`) : phase("landing", `${pr} is approved`);
    case "reviewing": case "fixing": case "quoting": case "checking": return phase(onTrack(review), `${pr}, round ${review.rounds.length}: ${review.phase.kind}${checkBeside(review)}`);
    case "verifying": return phase(onTrack(review), `${pr}, round ${review.rounds.length}: ${liveNote(review)}`);
    // A review that ended without landing says nothing of a pull request reopened or merged since, which its links do.
    case "closed": case "cancelled": case undefined: break;
    default: return review!.phase satisfies never;
  }
  const wait = waitOf(registry, id);
  if (wait.state === "landed") return phase("landed", wait.why);
  if (t.status === "archived" || t.status === "deleted") return phase("archived", `its thread is ${t.status}`);
  const attention = registry.attention(id);
  if (attention === "failed" || attention === "decision") return phase("held", attention === "failed" ? "its thread failed" : "its thread needs the person's decision");
  if (wait.state === "blocked") return phase("held", wait.why);
  const where = prLocationOf(registry, id);
  if (where.kind === "open") return phase("reviewing", `PR #${where.number} is open, before its review`);
  return phase("building", t.working ? "its agent is working, with no pull request yet" : "no pull request yet");
}

const heldFor = (n: PersonNeed): ItemPhase => phase("held", n.kind === "disk" ? "its archive's disk is kept for its usage"
  : n.kind !== "thread" ? "its thread needs the person's decision" : n.attention === "failed" ? "its thread failed" : `its thread is ${attentions[n.attention].label}`);

/**
 * A thread's phase, and the step it reached of those every piece of work takes. A thread with anything that waits on
 * the person is held, at the step its work is at.
 */
export function threadStage(registry: PipelineRegistry, id: ThreadId, now: number): { phase: ItemPhase; at: Step } {
  const t = registry.thread(id);
  if (t === undefined) {
    const queued = queuedPhase(registry, id);
    return { phase: queued, at: phaseStep[queued.kind] ?? "queued" };
  }
  const review = registry.review(id);
  const own = startedPhase(registry, t, review);
  const needs = personNeeds(registry, t, now);
  const track = review === null ? null : trackStep(review);
  return {
    phase: own.kind === "held" || needs.length === 0 ? own : heldFor(needs[0]!),
    at: track ?? phaseStep[own.kind] ?? (review !== null || prLocationOf(registry, id).kind === "open" ? "review" : "building"),
  };
}

export function itemPhase(registry: PipelineRegistry, item: ItemRecord, now: number): ItemPhase {
  const thread = itemThread(registry, item.id);
  return thread === null ? unqueued(registry, item) ?? phase("planned", item.lastError === null ? "is queued on the pipeline's next pass" : `was not queued: ${item.lastError}`) : threadStage(registry, thread, now).phase;
}

export function itemView(registry: PipelineRegistry, item: ItemRecord, now: number): PipelineItem {
  const claude = item.request.claude !== undefined;
  return {
    id: item.id, project: item.project, title: item.title, addedBy: item.addedBy, addedAt: item.addedAt, after: item.after,
    worker: claude ? "claude" : "harness", model: claude ? item.request.model ?? defaultClaudeModel : null, brief: item.message ?? item.request.claude ?? null,
    thread: itemThread(registry, item.id), phase: itemPhase(registry, item, now), approved: item.approved,
  };
}

export type Pipeline = ReturnType<typeof pipeline>;

export function pipeline(options: { registry: PipelineRegistry; queue: Pick<ThreadQueue, "add" | "poll">; log?: (message: string) => void }) {
  const { registry, queue, log = () => {} } = options;

  function find(id: string): ItemRecord {
    const item = registry.item(id as ItemId);
    if (item === undefined) throw new Refusal("missing", `no item ${id}`);
    return item;
  }

  /** Before it is queued, so a refusal says why it can never be. */
  function unstarted(item: ItemRecord, verb: string): void {
    const thread = itemThread(registry, item.id);
    if (thread !== null) throw new Refusal("conflict", `item ${item.id} is thread ${thread} now, so it cannot be ${verb}. nexus archive ${thread} cancels it while it is queued`);
    if (item.cancelled !== null) throw new Refusal("conflict", `item ${item.id} was cancelled by ${item.cancelled.by}`);
  }

  /** Each item is queued under its request ID, which the queued record's transaction stores, so it is queued once. */
  async function pass() {
    let queuedAny = false;
    for (const item of registry.items()) {
      if (itemThread(registry, item.id) !== null || unqueued(registry, item) !== null) continue;
      const after = item.after.map((id) => itemThread(registry, id)!);
      try {
        queue.add(item.request, item.message, after, item.addedBy, startKey(requestIds.pipeline(item.id), { request: item.request, message: item.message, after }));
        queuedAny = true;
        if (item.lastError !== null) registry.saveItem({ ...item, lastError: null });
      } catch (err) {
        const message = (err as Error).message;
        if (item.lastError !== message) log(`pipeline item ${item.id} was not queued: ${message}`);
        registry.saveItem({ ...item, lastError: message });
      }
    }
    if (queuedAny) void queue.poll();
  }

  const passes = singleFlight(pass);
  return {
    /**
     * Validates and records. The route polls after, so an item with nothing ahead of it is queued at once. An accepted
     * proposal's item takes an ID made from its question, which the planning thread is told.
     */
    add(request: StartRequest, message: string | null, after: readonly string[], caller: string, id = newItemId()): ItemRecord {
      if (request.model !== undefined && request.claude === undefined) throw new Refusal("invalid", "model requires claude");
      if (message !== null && request.claude !== undefined) throw new Refusal("invalid", "message is for a Nexus agent thread. A Claude worker's brief is its claude");
      if (message === null && request.claude === undefined) throw new Refusal("invalid", "an item needs a brief: message for a Nexus agent thread, or claude for a Claude worker");
      const project = checkStart(registry, request, caller);
      if (project.pipeline == null) throw new Refusal("conflict", `the pipeline does not run for project ${project.id}. nexus project edit ${project.id} --pipeline start turns it on`);
      const ids = [...new Set(after)] as ItemId[];
      for (const id of ids) {
        const ahead = registry.item(id);
        if (ahead === undefined) throw new Refusal("missing", `no item ${id}`);
        if (ahead.project !== project.id) throw new Refusal("invalid", `item ${id} is in project ${ahead.project}, not ${project.id}`);
      }
      const record: ItemRecord = {
        id, project: project.id, title: request.title, request, message, after: ids, addedBy: caller, addedAt: Date.now(),
        approved: null, cancelled: null, lastError: null,
      };
      registry.saveItem(record);
      return record;
    },
    approve(id: string, caller: string): ItemRecord {
      const item = find(id);
      unstarted(item, "approved");
      if (registry.project(item.project)?.pipeline?.autoStart !== false) throw new Refusal("conflict", `project ${item.project} ${registry.project(item.project)?.pipeline == null ? "has the pipeline off" : "starts its items on their own"}, so item ${item.id} needs no approval`);
      if (item.approved !== null) return item;
      const next = { ...item, approved: { by: caller, at: Date.now() } };
      registry.saveItem(next);
      return next;
    },
    cancel(id: string, caller: string): ItemRecord {
      const item = find(id);
      unstarted(item, "cancelled");
      const next = { ...item, cancelled: { by: caller, at: Date.now() } };
      registry.saveItem(next);
      return next;
    },
    /** A pass, or one more after the pass in flight, so an item added during a pass is queued without waiting for the next. */
    poll: passes.rerun,
    close: passes.settled,
  };
}
