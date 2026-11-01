/** What a render of the dashboard reads: the context of one render, and what waits on the person. */
import type { TailnetNodeId } from "../../ids.ts";
import type { ThreadDetail, ThreadRow } from "../wire.ts";
import type { Attention } from "../attention.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import type { Review } from "../review-model.ts";
import type { AnswerRefusal, NodeQuestion, Question } from "../questions.ts";
import type { QueuedThread } from "../queue.ts";

export type LandRefusal = "no review loop" | "not a deployer";

/** What every part of a page reads. `now` is read once, so every text of a render agrees on the time. */
export interface Context {
  registry: Registry; row(thread: Thread): ThreadRow; deploys(review: Review): boolean; now: number; caller: TailnetNodeId; landRefusal: LandRefusal | null;
  answerRefusal(question: Question): AnswerRefusal | null;
  /** Every thread, oldest first, and a project's, read once per render however many parts show them. */
  threads(): readonly Thread[];
  threadsIn(project: string): readonly Thread[];
  /** A project's threads that wait in the queue, in the order they were queued. */
  queuedIn(project: string): readonly QueuedThread[];
  /** What waits on the person, which the sidebar counts and the home page lists. */
  needs(): readonly Need[];
}

/**
 * One thing that waits on the person, for a card in the inbox: a review held for them or one they can land, a question
 * of the thread's, a builder its nudges did not move, or the thread itself, stopped where only they move it. The first
 * three are each a source of the `decision` attention, and the card is the thread page's own. A node's cleanup
 * question waits on them too, with its node page's card. `since` is when it began to wait, so far as the records say.
 */
export type ThreadNeed =
  | { kind: "review"; d: ThreadDetail; since: number }
  | { kind: "question"; d: ThreadDetail; question: Question; since: number }
  | { kind: "nudge"; d: ThreadDetail; since: number }
  | { kind: "thread"; d: ThreadDetail; attention: Exclude<Attention, "reply" | "working" | "decision" | null>; since: number };
export type Need = ThreadNeed | { kind: "cleanup"; question: NodeQuestion; since: number };
