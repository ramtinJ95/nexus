/**
 * Test support: a ThreadHarness that records each call the API makes, for API tests that run without
 * pi-durable. Conversation IDs count from 1.
 */
import assert from "node:assert/strict";
import type { ConversationId } from "../harness/host.ts";
import type { ThreadHarness } from "./api.ts";

export function fakeHarness() {
  const calls: unknown[][] = [];
  let conversations = 0;
  const harness: ThreadHarness = {
    async startThread(thread) { calls.push(["start", thread]); return ++conversations as ConversationId; },
    async send(...args) { calls.push(["send", ...args]); return { id: 7 } as never; },
    async abort(threadId) { calls.push(["abort", threadId]); },
    async retry(threadId) { calls.push(["retry", threadId]); },
    async watch(threadId) {
      calls.push(["watch", threadId]);
      return { value: { entries: ["the transcript"] }, stop: async () => { calls.push(["unwatch", threadId]); } } as never;
    },
    async deleteThread(thread) { calls.push(["delete", thread]); },
    activity: { facts: () => assert.fail("the API reads agent facts from the registry"), parked: () => [] },
  };
  return { harness, calls };
}
