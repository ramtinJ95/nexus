/**
 * Agent activity per thread, from each conversation's `pi.live` document. The tick reads it into the
 * planner's ActivityFacts, which keep a pylon running while its agent works.
 */
import type { Context } from "@earendil-works/chord";
import { LiveDoc, type ConversationId, type DocumentObserver, type DocumentWatch, type LiveState, type TaskId } from "@earendil-works/pi-durable";
import type { ActivityFacts } from "../reconcile.ts";

export interface HarnessActivity {
  facts(threadId: string): Pick<ActivityFacts, "agentTurnRunning" | "lastAgentActivityAt">;
}

interface ThreadActivity {
  running: boolean;
  /** 0 until the first change this process sees. */
  lastActivityAt: number;
  /** Tasks of the current run that hit the restart limit. They stay parked until retried or the run ends. */
  parked: Set<TaskId>;
}

export interface ActivityTracker extends HarnessActivity {
  track(observer: DocumentObserver, threadId: string, conversationId: ConversationId, context: Context): Promise<void>;
  /** A task Harness.inspect shows blocked by the restart limit. A `task_parked` report is not enough: a task parked before an earlier restart is not reported again. */
  park(conversationId: ConversationId, taskId: TaskId): void;
  parked(threadId: string): readonly TaskId[];
  /** After Harness.retryTask ran each of `parked(threadId)`. */
  retried(threadId: string): void;
  close(): Promise<void>;
}

export function trackActivity(now: () => number = Date.now): ActivityTracker {
  const threads = new Map<string, ThreadActivity>();
  const conversations = new Map<ConversationId, ThreadActivity>();
  const watches: DocumentWatch<LiveState>[] = [];
  const thread = (threadId: string) => {
    const a = threads.get(threadId);
    if (a === undefined) throw new Error(`the harness tracks no thread ${threadId}`);
    return a;
  };
  return {
    facts(threadId) {
      const a = thread(threadId);
      // A parked run cannot progress until someone retries it, so it must not keep its pylon awake.
      return { agentTurnRunning: a.running && a.parked.size === 0, lastAgentActivityAt: a.lastActivityAt };
    },
    async track(observer, threadId, conversationId, context) {
      const watch = await observer.watchDoc(LiveDoc, conversationId, context);
      if (watch === undefined) throw new Error(`conversation ${conversationId} of thread ${threadId} has no ${LiveDoc.definition.kind} document`);
      const a: ThreadActivity = { running: watch.value?.run !== undefined, lastActivityAt: 0, parked: new Set() };
      threads.set(threadId, a);
      conversations.set(conversationId, a);
      watches.push(watch);
      watch.start(async (live) => {
        a.running = live?.run !== undefined;
        a.lastActivityAt = now();
        if (!a.running) a.parked.clear();
      });
    },
    park(conversationId, taskId) {
      conversations.get(conversationId)?.parked.add(taskId);
    },
    parked: (threadId) => [...thread(threadId).parked],
    retried(threadId) {
      thread(threadId).parked.clear();
    },
    async close() {
      await Promise.all(watches.map((w) => w.stop()));
    },
  };
}
