/** What a render of the dashboard reads: its options, the context of one render, and what waits on the person. */
import type { NodeName, TailnetNodeId } from "../../ids.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import type { ThreadDetail, ThreadRow } from "../wire.ts";
import type { Attention } from "../attention.ts";
import type { Registry, Thread } from "../registry.ts";
import type { AgentView } from "../conversation-view.ts";
import type { Review } from "../review-model.ts";
import type { AnswerRefusal, Question } from "../questions.ts";
import type { QueuedThread } from "../queue.ts";

export interface DashboardOptions {
  registry: Registry;
  /** The API's thread detail, so the dashboard derives the actual state exactly as the API does. */
  detail(thread: Thread): ThreadDetail;
  /** The API's thread row, which is all a thread's line in the sidebar or the home table shows. */
  row(thread: Thread): ThreadRow;
  /** The API's conversation view, a Claude worker's transcript, or null for a thread with no agent. */
  conversation(thread: Thread): Promise<AgentView | null>;
  /** Why the land route would refuse the caller, or null when it would take the request. */
  landRefusal(caller: TailnetNodeId): LandRefusal | null;
  /** Why the answer route would refuse the caller's answer to the question, or null when it would take it. */
  answerRefusal(caller: TailnetNodeId, question: Question): AnswerRefusal | null;
  /** Whether the review's pull request deploys once it merges. */
  deploys(review: Review): boolean;
  /** The API's read of a node's health, which refuses a caller that is not a deployer. */
  nodeHealth(caller: TailnetNodeId, node: NodeName): Promise<NodeHealth>;
}

export type LandRefusal = "no review loop" | "not a deployer";

/** What every part of a page reads. `now` is read once, so every text of a render agrees on the time. */
export interface Context {
  registry: Registry; row: DashboardOptions["row"]; deploys: DashboardOptions["deploys"]; now: number; caller: TailnetNodeId; landRefusal: LandRefusal | null;
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
 * three are each a source of the `decision` attention, and the card is the thread page's own. `since` is when it began
 * to wait, so far as the records say.
 */
export type Need =
  | { kind: "review"; d: ThreadDetail; since: number }
  | { kind: "question"; d: ThreadDetail; question: Question; since: number }
  | { kind: "nudge"; d: ThreadDetail; since: number }
  | { kind: "thread"; d: ThreadDetail; attention: Exclude<Attention, "reply" | "working" | "decision" | null>; since: number };
