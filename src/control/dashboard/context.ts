/** What a render of the dashboard reads: the context of one render, what waits on the person, and each page's own view the route reads for it. */
import type { NodeName, TailnetNodeId } from "../../ids.ts";
import type { ThreadDetail, ThreadRow } from "../wire.ts";
import type { Registry } from "../registry.ts";
import type { Thread, ThreadAgent } from "../thread-store.ts";
import type { NodeRecord } from "../node-store.ts";
import type { Project } from "../project.ts";
import type { PipelineItem } from "../pipeline.ts";
import type { Role } from "../work-model.ts";
import type { UsageTotals } from "../../contract/usage.ts";
import type { Item } from "./items.ts";
import type { Review } from "../review-model.ts";
import type { AnswerRefusal, Question } from "../questions.ts";
import type { AgentView, QueuedThread } from "../../contract/threads.ts";
import type { InboxNeed } from "../work.ts";

export type LandRefusal = "no review loop" | "not a deployer";

/** What every part of a page reads. `now` is read once, so every text of a render agrees on the time. */
export interface Context {
  registry: Registry; row(thread: Thread): ThreadRow; deploys(review: Review): boolean; now: number; caller: TailnetNodeId; landRefusal: LandRefusal | null;
  answerRefusal(question: Question): AnswerRefusal | null;
  /** Every thread, oldest first, and a project's, read once per render however many parts show them. */
  threads(): readonly Thread[];
  threadsIn(project: string): readonly Thread[];
  /** Every review, read once per render, as each thread's role reads them. */
  reviews(): readonly Review[];
  /** A project's threads that wait in the queue, in the order they were queued. */
  queuedIn(project: string): readonly QueuedThread[];
  /** What waits on the person, which the sidebar and the phone's tab count and the home page lists. */
  needs(): readonly InboxNeed[];
}

/** What the home page reads beside the context: every project, the nodes that are offline, and a thread's role. */
export interface HomeView { projects: readonly Project[]; offline: ReadonlySet<NodeName>; role(thread: Thread): Role }

/** A fold's page: the projects it lists, the nodes that are offline, and for the closed fold the queued threads cancelled or deleted before they started, newest first. */
export interface FoldView { projects: readonly Project[]; offline: ReadonlySet<NodeName>; cancelled: readonly QueuedThread[] }

/** The latest reply of a thread's agent, with when the thread last had one, and what the agent was last asked. */
export interface Latest { reply: { text: string; at: number | null } | null; asked: { text: string; at: number } | null }

/** What the home page's preview shows, as the route read it: a thread with its conversation's latest, a queued thread, or an item. */
export type Peek =
  | { kind: "thread"; d: ThreadDetail; row: ThreadRow; latest: Latest }
  | { kind: "queued"; q: QueuedThread }
  | { kind: "item"; item: PipelineItem };

/**
 * A thread's page, read after its conversation so its facts are no older than the conversation. `view` is null for a
 * deleted thread, `renderedReplyAt` is the reply the conversation is known to hold, `nudged` is whether Nexus stopped
 * nudging it for the person, and `lands` whether its project lands its reviews on its own.
 */
export interface ThreadView {
  d: ThreadDetail; row: ThreadRow; node: NodeRecord; role: Role; agent: ThreadAgent; usage: UsageTotals;
  view: AgentView | Error | null; items: readonly Item[]; renderedReplyAt: number | null; nudged: boolean; lands: boolean;
}
