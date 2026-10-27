/**
 * Test support: a ThreadHarness that records each call the API makes, for API tests that run without
 * pi-durable. Conversation IDs count from 1. Each thread's transcript is a list of pi-ai messages that a sent
 * message joins and a test appends to, served in pi-durable's view shape with one message per entry.
 *
 * A watch sees a change once it is committed: a sent message commits itself, and a test that changes a
 * transcript calls `commit`. As in pi-durable, a committed view shares each part the commit left alone.
 */
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, JsonObject, WatchEnd } from "@earendil-works/pi-durable";
import type { ConversationId } from "../harness/host.ts";
import type { ThreadHarness } from "./api.ts";

export interface FakeTranscript {
  messages: Message[];
  /** Such as `pi.live` and `pi.inbox`. */
  docs: Record<string, JsonObject>;
  /** Served instead of one entry per message, as an active context after a new head or a compaction is. */
  entries?: EntryRecord[];
}

/** `onParked` is told each park, as the control plane's harness host tells the registry. */
export function fakeHarness(options: { onParked?: (threadId: string, parked: boolean) => void } = {}) {
  const calls: unknown[][] = [];
  let conversations = 0;
  const parked = new Map<string, number>();
  const transcripts = new Map<string, FakeTranscript & { id: ConversationId }>();
  const committed = new Map<string, ConversationView>();
  const watchers = new Map<string, Set<(view: ConversationView) => void>>();
  let held: Promise<void> | null = null;
  const transcript = (threadId: string) => {
    const found = transcripts.get(threadId);
    assert.ok(found !== undefined, `the fake harness has no conversation for thread ${threadId}`);
    return found;
  };
  const view = (threadId: string): ConversationView => {
    const { id, messages, docs, entries } = transcript(threadId);
    const before = committed.get(threadId);
    const fresh = entries ?? messages.map((message, i) => ({ id: i + 1, conversationId: id, kind: `pi.${message.role}`, model: [message] }));
    const next = {
      conversation: { id },
      entries: before !== undefined && JSON.stringify(before.entries) === JSON.stringify(fresh) ? before.entries : fresh,
      docs: { ...docs },
    } as never as ConversationView;
    committed.set(threadId, next);
    return next;
  };
  const commit = (threadId: string) => {
    const next = view(threadId);
    for (const listener of watchers.get(threadId) ?? []) listener(next);
  };
  const harness: ThreadHarness = {
    latestTurn: async () => null,
    async startThread(thread) {
      calls.push(["start", thread]);
      const id = ++conversations as ConversationId;
      transcripts.set(thread.threadId, { id, messages: [], docs: {} });
      return id;
    },
    async send(...args) {
      calls.push(["send", ...args]);
      transcript(args[0]).messages.push({ role: "user", content: args[1], timestamp: Date.now() });
      commit(args[0]);
      return { id: 7 } as never;
    },
    async abort(threadId) { calls.push(["abort", threadId]); },
    async retry(threadId) { calls.push(["retry", threadId]); },
    async watch(threadId) {
      calls.push(["watch", threadId]);
      await held;
      const closed = Promise.withResolvers<WatchEnd>();
      const listeners = watchers.get(threadId) ?? new Set();
      watchers.set(threadId, listeners);
      let deliver = (_: ConversationView) => {};
      const listener = (next: ConversationView) => deliver(next);
      listeners.add(listener);
      return {
        value: view(threadId),
        start(onCommit) { deliver = (next) => void onCommit(next, [], {} as never); },
        closed: closed.promise,
        async stop() {
          if (listeners.delete(listener)) calls.push(["unwatch", threadId]);
          closed.resolve({ reason: "stopped" });
          return closed.promise;
        },
      };
    },
    async deleteThread(thread) { calls.push(["delete", thread]); },
    activity: { facts: () => assert.fail("the API reads agent facts from the registry"), parked: (threadId) => Array.from({ length: parked.get(threadId) ?? 0 }, (_, i) => i + 1) as never },
  };
  return {
    harness, calls,
    transcript: transcript as (threadId: string) => FakeTranscript,
    /** Publishes the transcript as it is now to the thread's watches. */
    commit,
    /** Makes each watch wait to open until the returned function is called. */
    holdWatches() {
      const gate = Promise.withResolvers<void>();
      held = gate.promise;
      return () => { held = null; gate.resolve(); };
    },
    /** How many watches of the thread are open. */
    watching: (threadId: string) => watchers.get(threadId)?.size ?? 0,
    /** Makes the thread's run hold this many tasks the restart limit parked. */
    park(threadId: string, tasks: number) {
      parked.set(threadId, tasks);
      options.onParked?.(threadId, tasks > 0);
    },
  };
}
