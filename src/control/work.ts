/** What waits on the person: the inbox, which lists each thread's needs beside what else stops a thread or holds work. */
import type { ThreadId } from "../ids.ts";
import type { Attention, Need } from "./attention.ts";
import { itemView, threadPhase, type PipelineItem } from "./pipeline.ts";
import type { NodeQuestion } from "./questions.ts";
import type { QueuedThread } from "./queue.ts";
import { archivedDiskMs, settleStuck } from "./reconcile.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import type { ThreadDetail, ThreadRow } from "./wire.ts";

/**
 * One card of the inbox for a thread: a need of its own, an archive whose disk is kept for usage that will not be read
 * without the person, or the thread itself, stopped where only they move it.
 */
export type ThreadNeed =
  | Need & { d: ThreadDetail }
  | { kind: "disk"; d: ThreadDetail; since: number }
  | { kind: "thread"; d: ThreadDetail; attention: Exclude<Attention, "reply" | "working" | "decision" | null>; since: number };
export type HeldWork = { kind: "item"; item: PipelineItem } | { kind: "queued"; q: QueuedThread } | { kind: "thread"; thread: Thread; d: ThreadDetail };
/** A thread's card, a node's cleanup question with its Cluster card, or work its pipeline phase holds for the person that no card acts on. */
export type InboxNeed = ThreadNeed | { kind: "cleanup"; question: NodeQuestion; since: number } | { kind: "held"; work: HeldWork; since: number };

interface Work {
  registry: Registry; now: number; row(thread: Thread): ThreadRow; threads(): readonly Thread[]; queuedIn(project: string): readonly QueuedThread[];
}

/**
 * What waits on the person in the open threads and on the nodes, oldest first, so each card keeps its place while the
 * person works down the list and the one that has waited longest is first. Each need of a thread gets its card, and
 * any other attention that needs the person one for the thread. A new reply does not wait on the person, so it has
 * none, but it outranks a dialog in the terminal, which the session's own state says waits. After the cards, oldest
 * first too, comes the work its pipeline phase holds for the person that no card acts on.
 */
export function needsOf(w: Work, detail: (thread: Thread) => ThreadDetail): InboxNeed[] {
  const cleanups = w.registry.openNodeQuestions().map((question): InboxNeed => ({ kind: "cleanup", question, since: question.askedAt }));
  const cards = [...cleanups, ...w.threads().filter((t) => t.status === "active" || t.status === "idle").flatMap((t): ThreadNeed[] => {
    const { attention } = w.row(t);
    const own = w.registry.needs(t.id);
    const stuck = attention === "failed" || attention === "parked" || attention === "limited" ? attention : attention !== "decision" && t.sessionWaiting === true ? "waiting" : null;
    if (own.length === 0 && stuck === null) return [];
    const d = detail(t);
    const needs: ThreadNeed[] = own.map((n) => ({ ...n, d }));
    if (stuck !== null) needs.push({ kind: "thread", d, attention: stuck, since: t.usageLimit?.stoppedAt ?? Math.max(t.createdAt, t.lastAgentActivityAt) });
    return needs;
  }), ...w.threads().filter((t) => t.status === "archived" && settleStuck(t, w.now)).map((t): ThreadNeed => ({ kind: "disk", d: detail(t), since: t.archivedAt! + archivedDiskMs }))]
    .sort((a, b) => a.since - b.since);
  const carded = new Set(cards.flatMap((n) => n.kind === "cleanup" || n.kind === "held" ? [] : [n.d.thread.id]));
  const holds = (id: ThreadId) => threadPhase(w.registry, id).kind === "held";
  const held = [
    ...w.registry.items().map((i) => itemView(w.registry, i)).filter((item) => item.thread === null && item.phase.kind === "held").map((item): InboxNeed => ({ kind: "held", work: { kind: "item", item }, since: item.addedAt })),
    ...w.registry.projects().flatMap((p) => w.queuedIn(p.id)).filter((q) => holds(q.id)).map((q): InboxNeed => ({ kind: "held", work: { kind: "queued", q }, since: q.createdAt })),
    ...w.threads().filter((t) => (t.status === "active" || t.status === "idle") && !carded.has(t.id) && holds(t.id)).map((thread): InboxNeed => ({ kind: "held", work: { kind: "thread", thread, d: detail(thread) }, since: Math.max(thread.createdAt, thread.lastAgentActivityAt) })),
  ].sort((a, b) => a.since - b.since);
  return [...cards, ...held];
}
