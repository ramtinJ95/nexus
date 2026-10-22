import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentObserver, LiveState, TaskId } from "@earendil-works/pi-durable";
import { trackActivity } from "./activity.ts";

const conversationId = 7 as ConversationId;
const taskId = 42 as TaskId;
const busy: LiveState = { run: { taskId: 1 as TaskId, inputs: [] } };

/** One conversation's pi.live watch, whose changes the test delivers. */
function fakeLive(initial: LiveState) {
  let listener: ((value: LiveState) => Promise<void>) | undefined;
  const observer = {
    watchDoc: async () => ({
      value: initial,
      start: (l: typeof listener) => { listener = l; },
      stop: async () => ({}),
    }),
  } as unknown as DocumentObserver;
  return { observer, change: (value: LiveState) => listener!(value) };
}

test("a present run is a running turn, and each pi.live change is activity", async () => {
  let clock = 1000;
  const activity = trackActivity(() => clock);
  const live = fakeLive({});
  await activity.track(live.observer, "t1", conversationId, context);
  assert.deepEqual(activity.facts("t1"), { agentTurnRunning: false, lastAgentActivityAt: 0 });
  clock = 2000;
  await live.change(busy);
  assert.deepEqual(activity.facts("t1"), { agentTurnRunning: true, lastAgentActivityAt: 2000 });
  clock = 3000;
  await live.change({});
  assert.deepEqual(activity.facts("t1"), { agentTurnRunning: false, lastAgentActivityAt: 3000 });
});

test("a parked task stops its run counting as running until it is retried", async () => {
  const activity = trackActivity();
  const live = fakeLive(busy);
  await activity.track(live.observer, "t1", conversationId, context);
  assert.equal(activity.facts("t1").agentTurnRunning, true);
  activity.park(conversationId, taskId);
  await live.change(busy);
  assert.equal(activity.facts("t1").agentTurnRunning, false, "progress of a sibling task does not unpark the run");
  assert.deepEqual(activity.parked("t1"), [taskId]);
  activity.retried("t1");
  assert.equal(activity.facts("t1").agentTurnRunning, true);
});

test("a run that ends drops its parked tasks", async () => {
  const activity = trackActivity();
  const live = fakeLive(busy);
  await activity.track(live.observer, "t1", conversationId, context);
  activity.park(conversationId, taskId);
  await live.change({});
  await live.change(busy);
  assert.equal(activity.facts("t1").agentTurnRunning, true);
  assert.deepEqual(activity.parked("t1"), []);
});

test("an unknown thread is an error, not an idle thread", () => {
  assert.throws(() => trackActivity().facts("nope"), /tracks no thread nope/);
});
