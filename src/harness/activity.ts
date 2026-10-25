/**
 * Agent activity per thread, from each conversation's `pi.live` document. The control plane writes each change
 * of a thread's facts into its registry row, where the planner and the dashboard read them.
 */
import type { Context } from "@earendil-works/chord";
import { LiveDoc, type ConversationId, type DocumentObserver, type DocumentWatch, type LiveState, type TaskId } from "@earendil-works/pi-durable";
import type { ActivityFacts } from "../reconcile.ts";

export type AgentFacts = Pick<ActivityFacts, "agentTurnRunning" | "lastAgentActivityAt">;

export interface HarnessActivity {
  facts(threadId: string): AgentFacts;
  /** Tasks of the thread's current run that hit the restart limit. The run holds until each is retried. */
  parked(threadId: string): readonly TaskId[];
}

interface ThreadActivity {
  threadId: string;
  watch: DocumentWatch<LiveState>;
  running: boolean;
  /** 0 until the first change this process sees. */
  lastActivityAt: number;
  /** Tasks of the current run that hit the restart limit. They stay parked until retried or the run ends. */
  parked: Set<TaskId>;
  /** What the registry holds for agentTurnRunning, from the caller or the last onChange. */
  reported: boolean;
}

export interface ActivityTracker extends HarnessActivity {
  /** `recorded` is the agentTurnRunning the registry holds for the thread. A different value is reported at once. */
  track(observer: DocumentObserver, threadId: string, conversationId: ConversationId, recorded: boolean, context: Context): Promise<void>;
  untrack(threadId: string): Promise<void>;
  /** A task Harness.inspect shows blocked by the restart limit. A `task_parked` report is not enough: a task parked before an earlier restart is not reported again. */
  park(conversationId: ConversationId, taskId: TaskId): void;
  /** After Harness.retryTask ran each of `parked(threadId)`. */
  retried(threadId: string): void;
  close(): Promise<void>;
}

export interface ActivityOptions {
  /**
   * Called when a thread's agentTurnRunning changes. A running turn keeps its pylon awake whatever the time, so
   * the time of its end is the only lastAgentActivityAt the planner needs, and no other change is reported.
   */
  onChange(threadId: string, facts: AgentFacts): void;
  now?: () => number;
  onReply?(threadId: string, at: number): void;
  onParked?(threadId: string, parked: boolean): void;
}

export function trackActivity(options: ActivityOptions): ActivityTracker {
  const now = options.now ?? Date.now;
  const threads = new Map<string, ThreadActivity>();
  const conversations = new Map<ConversationId, ThreadActivity>();
  const thread = (threadId: string) => {
    const a = threads.get(threadId);
    if (a === undefined) throw new Error(`the harness tracks no thread ${threadId}`);
    return a;
  };
  // A parked run cannot progress until someone retries it, so it must not keep its pylon awake.
  const factsOf = (a: ThreadActivity): AgentFacts => ({ agentTurnRunning: a.running && a.parked.size === 0, lastAgentActivityAt: a.lastActivityAt });
  function report(a: ThreadActivity) {
    const facts = factsOf(a);
    options.onParked?.(a.threadId, a.parked.size > 0);
    if (facts.agentTurnRunning === a.reported) return;
    a.reported = facts.agentTurnRunning;
    options.onChange(a.threadId, facts);
  }
  return {
    facts: (threadId) => factsOf(thread(threadId)),
    parked: (threadId) => [...thread(threadId).parked],
    async track(observer, threadId, conversationId, recorded, context) {
      const watch = await observer.watchDoc(LiveDoc, conversationId, context);
      if (watch === undefined) throw new Error(`conversation ${conversationId} of thread ${threadId} has no ${LiveDoc.definition.kind} document`);
      const running = watch.value?.run !== undefined;
      // A turn that changed while no process watched changed at some time up to now. Now keeps its idle grace.
      const a: ThreadActivity = { threadId, watch, running, lastActivityAt: running === recorded ? 0 : now(), parked: new Set(), reported: recorded };
      threads.set(threadId, a);
      conversations.set(conversationId, a);
      if (recorded && !running) options.onReply?.(threadId, now());
      report(a);
      watch.start(async (live) => {
        if (a.running && live?.run === undefined) options.onReply?.(threadId, now());
        a.running = live?.run !== undefined;
        a.lastActivityAt = now();
        if (!a.running) a.parked.clear();
        report(a);
      });
    },
    async untrack(threadId) {
      const a = thread(threadId);
      threads.delete(threadId);
      for (const [id, tracked] of conversations) if (tracked === a) conversations.delete(id);
      await a.watch.stop();
    },
    park(conversationId, taskId) {
      const a = conversations.get(conversationId);
      if (a === undefined) return;
      a.parked.add(taskId);
      report(a);
    },
    retried(threadId) {
      const a = thread(threadId);
      a.parked.clear();
      report(a);
    },
    async close() {
      await Promise.all([...threads.values()].map((a) => a.watch.stop()));
    },
  };
}
