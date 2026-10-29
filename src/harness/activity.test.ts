import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentObserver, LiveState, TaskId } from "@earendil-works/pi-durable";
import { trackActivity, type AgentFacts } from "./activity.ts";

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

const ignore = { onChange: () => {} };

test("a present run is a running turn, and each pi.live change is activity", async () => {
  let clock = 1000;
  const activity = trackActivity({ ...ignore, now: () => clock });
  const live = fakeLive({});
  await activity.track(live.observer, "t1", conversationId, false, context);
  assert.deepEqual(activity.facts("t1"), { agentTurnRunning: false, lastAgentActivityAt: 0 });
  clock = 2000;
  await live.change(busy);
  assert.deepEqual(activity.facts("t1"), { agentTurnRunning: true, lastAgentActivityAt: 2000 });
  clock = 3000;
  await live.change({});
  assert.deepEqual(activity.facts("t1"), { agentTurnRunning: false, lastAgentActivityAt: 3000 });
});

test("a parked task stops its run counting as running until it is retried", async () => {
  const activity = trackActivity(ignore);
  const live = fakeLive(busy);
  await activity.track(live.observer, "t1", conversationId, false, context);
  assert.equal(activity.facts("t1").agentTurnRunning, true);
  activity.park(conversationId, taskId);
  await live.change(busy);
  assert.equal(activity.facts("t1").agentTurnRunning, false, "progress of a sibling task does not unpark the run");
  assert.deepEqual(activity.parked("t1"), [taskId]);
  activity.retried("t1");
  assert.equal(activity.facts("t1").agentTurnRunning, true);
});

test("a run that ends drops its parked tasks", async () => {
  const activity = trackActivity(ignore);
  const live = fakeLive(busy);
  await activity.track(live.observer, "t1", conversationId, false, context);
  activity.park(conversationId, taskId);
  await live.change({});
  await live.change(busy);
  assert.equal(activity.facts("t1").agentTurnRunning, true);
  assert.deepEqual(activity.parked("t1"), []);
});

test("an unknown thread is an error, not an idle thread", () => {
  assert.throws(() => trackActivity(ignore).facts("nope"), /tracks no thread nope/);
});

test("each flip of a running turn is reported once, and the end of a run carries its time", async () => {
  let clock = 1000;
  const reports: [string, AgentFacts][] = [];
  const activity = trackActivity({ onChange: (threadId, facts) => reports.push([threadId, facts]), now: () => clock });
  const live = fakeLive(busy);
  await activity.track(live.observer, "t1", conversationId, false, context);
  clock = 2000;
  await live.change(busy);
  activity.park(conversationId, taskId);
  activity.retried("t1");
  clock = 3000;
  await live.change({});
  await live.change({});
  assert.deepEqual(reports, [
    ["t1", { agentTurnRunning: true, lastAgentActivityAt: 1000 }],
    ["t1", { agentTurnRunning: false, lastAgentActivityAt: 2000 }],
    ["t1", { agentTurnRunning: true, lastAgentActivityAt: 2000 }],
    ["t1", { agentTurnRunning: false, lastAgentActivityAt: 3000 }],
  ]);
});

test("a thread is reported at once only when the registry holds a different turn, as a change made now", async () => {
  const reports: [string, AgentFacts][] = [];
  const activity = trackActivity({ onChange: (threadId, facts) => reports.push([threadId, facts]), now: () => 5000 });
  await activity.track(fakeLive(busy).observer, "t1", conversationId, true, context);
  await activity.track(fakeLive({}).observer, "t2", 8 as ConversationId, true, context);
  assert.deepEqual(reports, [["t2", { agentTurnRunning: false, lastAgentActivityAt: 5000 }]]);
});

test("an untracked thread is unknown again", async () => {
  const activity = trackActivity(ignore);
  await activity.track(fakeLive({}).observer, "t1", conversationId, false, context);
  await activity.untrack("t1");
  assert.throws(() => activity.facts("t1"), /tracks no thread t1/);
});

test("only a turn ending records a reply, not streaming, parking or retrying", async () => {
  const replies: unknown[] = [];
  const tracker = trackActivity({ ...ignore, now: () => 2000, onReply: (id, at) => replies.push([id, at]) });
  const live = fakeLive({});
  await tracker.track(live.observer, "t1", conversationId, false, context);
  await live.change(busy);
  await live.change(busy);
  tracker.park(conversationId, taskId);
  tracker.retried("t1");
  assert.deepEqual(replies, []);
  await live.change({});
  await live.change({});
  assert.deepEqual(replies, [["t1", 2000]]);
  await tracker.close();
});

test("the parked state is reported at track and then only when it flips, not on every pi.live change", async () => {
  const parked: unknown[] = [];
  const tracker = trackActivity({ ...ignore, onParked: (id, is) => parked.push([id, is]) });
  const live = fakeLive(busy);
  await tracker.track(live.observer, "t1", conversationId, false, context);
  assert.deepEqual(parked, [["t1", false]], "the first report always goes out");
  await live.change(busy);
  await live.change(busy);
  assert.deepEqual(parked, [["t1", false]]);
  tracker.park(conversationId, taskId);
  tracker.park(conversationId, 43 as TaskId);
  await live.change(busy);
  assert.deepEqual(parked, [["t1", false], ["t1", true]]);
  tracker.retried("t1");
  await live.change(busy);
  assert.deepEqual(parked, [["t1", false], ["t1", true], ["t1", false]]);
  await tracker.close();
});
