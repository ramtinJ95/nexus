/** What waits on the person: the inbox, which lists each thread's needs beside what else stops a thread or holds work. */
import type { ThreadId } from "../ids.ts";
import { itemView, threadStage, type PipelineItem } from "./pipeline.ts";
import type { NodeQuestion } from "./questions.ts";
import type { QueuedThread } from "../contract/threads.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import type { ThreadDetail, ThreadNeed } from "./wire.ts";
import { personNeeds } from "./work-model.ts";

export type HeldWork = { kind: "item"; item: PipelineItem } | { kind: "queued"; q: QueuedThread } | { kind: "thread"; thread: Thread; d: ThreadDetail };
/** A thread's card, a node's cleanup question with its Cluster card, or work its pipeline phase holds for the person that no card acts on. */
export type InboxNeed = ThreadNeed | { kind: "cleanup"; question: NodeQuestion; since: number } | { kind: "held"; work: HeldWork; since: number };

interface Work {
  registry: Registry; now: number; threads(): readonly Thread[]; queuedIn(project: string): readonly QueuedThread[];
}

/**
 * What waits on the person in the threads and on the nodes, oldest first, so each card keeps its place while the
 * person works down the list and the one that has waited longest is first. Each need of a thread gets its card. After
 * the cards, oldest first too, comes the work its pipeline phase holds for the person that no card acts on.
 */
export function needsOf(w: Work, detail: (thread: Thread) => ThreadDetail): InboxNeed[] {
  const cleanups = w.registry.openNodeQuestions().map((question): InboxNeed => ({ kind: "cleanup", question, since: question.askedAt }));
  const cardsOf = (t: Thread): ThreadNeed[] => {
    const needs = personNeeds(w.registry, t, w.now);
    if (needs.length === 0) return [];
    const d = detail(t);
    return needs.map((n) => ({ ...n, d }));
  };
  // Open threads' cards before archives', so the sort keeps that order between cards of the same age.
  const threads = Map.groupBy(w.threads(), (t) => t.status === "archived");
  const cards = [...cleanups, ...(threads.get(false) ?? []).flatMap(cardsOf), ...(threads.get(true) ?? []).flatMap(cardsOf)].sort((a, b) => a.since - b.since);
  const carded = new Set(cards.flatMap((n) => n.kind === "cleanup" || n.kind === "held" ? [] : [n.d.thread.id]));
  const holds = (id: ThreadId) => threadStage(w.registry, id, w.now).phase.kind === "held";
  const held = [
    ...w.registry.items().map((i) => itemView(w.registry, i, w.now)).filter((item) => item.thread === null && item.phase.kind === "held").map((item): InboxNeed => ({ kind: "held", work: { kind: "item", item }, since: item.addedAt })),
    ...w.registry.projects().flatMap((p) => w.queuedIn(p.id)).filter((q) => holds(q.id)).map((q): InboxNeed => ({ kind: "held", work: { kind: "queued", q }, since: q.createdAt })),
    ...w.threads().filter((t) => (t.status === "active" || t.status === "idle") && !carded.has(t.id) && holds(t.id)).map((thread): InboxNeed => ({ kind: "held", work: { kind: "thread", thread, d: detail(thread) }, since: Math.max(thread.createdAt, thread.lastAgentActivityAt) })),
  ].sort((a, b) => a.since - b.since);
  return [...cards, ...held];
}
