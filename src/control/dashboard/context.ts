/** What a render of the dashboard reads: the context of one render, and what waits on the person. */
import type { TailnetNodeId } from "../../ids.ts";
import type { ThreadRow } from "../wire.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import type { Review } from "../review-model.ts";
import type { AnswerRefusal, Question } from "../questions.ts";
import type { QueuedThread } from "../../contract/threads.ts";
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
