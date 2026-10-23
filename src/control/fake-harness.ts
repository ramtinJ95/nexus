/**
 * Test support: a ThreadHarness that records each call the API makes, for API tests that run without
 * pi-durable. Conversation IDs count from 1. Each thread's transcript is a list of pi-ai messages that a sent
 * message joins and a test appends to, served in pi-durable's view shape with one message per entry.
 */
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationView, JsonObject } from "@earendil-works/pi-durable";
import type { ConversationId } from "../harness/host.ts";
import type { ThreadHarness } from "./api.ts";

export interface FakeTranscript {
  messages: Message[];
  /** Such as `pi.live` and `pi.inbox`. */
  docs: Record<string, JsonObject>;
}

export function fakeHarness() {
  const calls: unknown[][] = [];
  let conversations = 0;
  const parked = new Map<string, number>();
  const transcripts = new Map<string, FakeTranscript & { id: ConversationId }>();
  const transcript = (threadId: string) => {
    const found = transcripts.get(threadId);
    assert.ok(found !== undefined, `the fake harness has no conversation for thread ${threadId}`);
    return found;
  };
  const view = (threadId: string): ConversationView => {
    const { id, messages, docs } = transcript(threadId);
    return {
      conversation: { id },
      entries: messages.map((message, i) => ({ id: i + 1, conversationId: id, kind: `pi.${message.role}`, model: [message] })),
      docs,
    } as never;
  };
  const harness: ThreadHarness = {
    async startThread(thread) {
      calls.push(["start", thread]);
      const id = ++conversations as ConversationId;
      transcripts.set(thread.threadId, { id, messages: [], docs: {} });
      return id;
    },
    async send(...args) {
      calls.push(["send", ...args]);
      transcript(args[0]).messages.push({ role: "user", content: args[1], timestamp: Date.now() });
      return { id: 7 } as never;
    },
    async abort(threadId) { calls.push(["abort", threadId]); },
    async retry(threadId) { calls.push(["retry", threadId]); },
    async watch(threadId) {
      calls.push(["watch", threadId]);
      return { value: view(threadId), stop: async () => { calls.push(["unwatch", threadId]); } } as never;
    },
    async deleteThread(thread) { calls.push(["delete", thread]); },
    activity: { facts: () => assert.fail("the API reads agent facts from the registry"), parked: (threadId) => Array.from({ length: parked.get(threadId) ?? 0 }, (_, i) => i + 1) as never },
  };
  return {
    harness, calls,
    transcript: transcript as (threadId: string) => FakeTranscript,
    /** Makes the thread's run hold this many tasks the restart limit parked. */
    park(threadId: string, tasks: number) { parked.set(threadId, tasks); },
  };
}
