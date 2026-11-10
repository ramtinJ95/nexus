import type { NodeName, ProjectId, TailnetNodeId, ThreadId } from "../../ids.ts";
import type { ServerDetail, ThreadRow } from "../wire.ts";
import type { Thread, ThreadAgent } from "../thread-store.ts";
import type { NodeRecord } from "../node-store.ts";
import type { Project } from "../project.ts";
import type { ItemPhase, PipelineItem, Step } from "../pipeline.ts";
import type { Role } from "../agent-protocol.ts";
import type { UsageReport, UsageTotals } from "../../contract/usage.ts";
import type { Item } from "./items.ts";
import type { Review } from "../review-model.ts";
import type { AnswerRefusal, CleanupQuestion, Question } from "../questions.ts";
import type { AgentView, QueuedThread } from "../../contract/threads.ts";
import type { InboxNeed } from "../work.ts";
import type { HealthChange } from "../doctor-model.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import type { ReleaseView } from "../../protocol/deploy.ts";
import type { NodePylons } from "../placement.ts";
import type { HealthSample } from "../node-metrics.ts";
import type { Period } from "../usage.ts";

export type LandRefusal = "no review loop" | "not a deployer";

/**
 * What every part of a page reads, read once per render however many parts show it. `now` is read once, so every
 * text of a render agrees on the time.
 */
export interface Context {
  now: number; caller: TailnetNodeId; landRefusal: LandRefusal | null;
  deploys(review: Review): boolean;
  answerRefusal(question: Question): AnswerRefusal | null;
  projects: readonly Project[];
  nodes: readonly NodeRecord[];
  /** The image a new pylon boots, or null before one is current. */
  image: string | null;
  /** Each health check's latest state, and every change kept, newest first. */
  health: { states: readonly HealthChange[]; changes: readonly HealthChange[] };
  /** Every thread, oldest first. */
  threads: readonly Thread[];
  threadsIn(project: string): readonly Thread[];
  /** A project's threads that wait in the queue, in the order they were queued. */
  queuedIn(project: string): readonly QueuedThread[];
  /** What waits on the person, which the sidebar and the phone's tab count and the home page lists. */
  needs: readonly InboxNeed[];
  /** Every review, read only by a render that shows what a reviewer, check or live check thread serves. */
  reviews(): readonly Review[];
  /** The list's row of a thread, read only for the threads a render shows, so the closed ones a fold hides cost nothing. */
  row(thread: Thread): ThreadRow;
  /** What a search matches of a thread, as contract.ts `findText` writes it, with its pull requests read once per render. */
  find(thread: Thread): string;
  thread(id: ThreadId): Thread | undefined;
  /** A thread's or a queued thread's title, or its ID once neither is known. */
  title(id: ThreadId): string;
  /** Where a started or queued thread is in the pipeline. */
  stage(id: ThreadId): { phase: ItemPhase; at: Step };
  /** The review of the builder thread `id`. */
  review(id: ThreadId): Review | null;
}

/** `items` are in the order they were added. */
export interface HomeView { offline: ReadonlySet<NodeName>; role(thread: Thread): Role; items: readonly PipelineItem[] }

/**
 * `cancelled` is, for the closed fold, the queued threads cancelled or deleted before they started, newest first. `project`
 * is the project the page names, or null for every project's.
 */
export interface FoldView { project: ProjectId | null; projects: readonly Project[]; offline: ReadonlySet<NodeName>; cancelled: readonly QueuedThread[] }

export interface Latest { reply: { text: string; at: number | null } | null; asked: { text: string; at: number } | null }

export type Peek =
  | { kind: "thread"; d: ServerDetail; row: ThreadRow; latest: Latest }
  | { kind: "queued"; q: QueuedThread }
  | { kind: "item"; item: PipelineItem };

/**
 * A thread's page, read after its conversation so its facts are no older than the conversation. `view` is null for a
 * deleted thread, `renderedReplyAt` is the reply the conversation is known to hold, `nudged` is whether Nexus stopped
 * nudging it for the person, `lands` whether its project lands its reviews on its own, `queuedAfter` the threads
 * it waited on in the queue, or null when it started at once, and `item` the pipeline item it started for.
 */
export interface ThreadView {
  d: ServerDetail; row: ThreadRow; node: NodeRecord; role: Role; agent: ThreadAgent; usage: UsageTotals;
  view: AgentView | Error | null; items: readonly Item[]; renderedReplyAt: number | null; nudged: boolean; lands: boolean;
  queuedAfter: readonly ThreadId[] | null; item: PipelineItem | undefined;
}

export type NodeReading =
  | { kind: "read"; cpus: number; load: number | null; memory: { totalGiB: number; availableGiB: number } | null; disk: { totalGiB: number; freeGiB: number } }
  | { kind: "failed"; error: string }
  | { kind: "refused" }
  | { kind: "stale" };

/**
 * The Cluster page with the node `name` picked. Each node has its card's reading, its pylons' tallies, or null before
 * its first observation, and its cleanup questions. The picked node has what its probe read of its host now or why it
 * could not, its newest recorded sample, and the thread of each of its pylons with whether that thread is a builder.
 */
export interface ClusterView {
  name: NodeName;
  release: ReleaseView;
  nodes: readonly { node: NodeRecord; reading: NodeReading; pylons: NodePylons | null; cleanups: readonly CleanupQuestion[] }[];
  health: NodeHealth | Error;
  sample: HealthSample | null;
  pylonThreads: ReadonlyMap<string, { thread: ThreadId; builder: boolean }>;
}

export interface UsageView { period: Period; project: ProjectId | null; report: UsageReport }
