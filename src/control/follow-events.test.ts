import { test } from "node:test";
import assert from "node:assert/strict";
import type { NexusEvent } from "../events.ts";
import { followEvents } from "./follow-events.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { testRegistry } from "./test-kit.ts";
import { until } from "../test-kit.ts";

function following(t: { after(fn: () => void): void }) {
  const registry = openRegistry(":memory:");
  // Cursor 0 never expires, so the follower starts after an event.
  registry.appendEvent("release.changed", null, {});
  let batches = 0;
  const counted: Registry = { ...registry, eventBatch: (...args) => (batches++, registry.eventBatch(...args)) };
  const delivered: NexusEvent[] = [];
  const resets: Error[] = [];
  const stop = followEvents(counted, ["session.turn-ended"], 5, (events) => delivered.push(...events), (err) => resets.push(err));
  t.after(() => {
    stop();
    registry.close();
  });
  return { registry, delivered, resets, stop, batches: () => batches };
}

test("a follower delivers the events of its kinds appended after it starts, and none from before", async (t) => {
  const registry = testRegistry(t);
  registry.appendEvent("session.turn-ended", null, { before: true });
  const delivered: NexusEvent[] = [];
  const stop = followEvents(registry, ["session.turn-ended"], 5, (events) => delivered.push(...events), () => assert.fail("no reset"));
  t.after(stop);
  registry.appendEvent("release.changed", null, {});
  const after = registry.appendEvent("session.turn-ended", null, {});
  await until("the new event is delivered", () => delivered.length > 0);
  assert.deepEqual(delivered, [after]);
});

test("a follower whose cursor expired is reset and goes on from the newest event", async (t) => {
  const { registry, delivered, resets } = following(t);
  registry.appendEvent("session.turn-ended", null, { lost: true });
  for (let i = 0; i < 10_002; i++) registry.appendEvent("release.changed", null, {});
  await until("the follower is reset", () => resets.length > 0);
  assert.match(resets[0]!.message, /expired/);
  assert.deepEqual(delivered, [], "the events retention dropped are not delivered");
  const next = registry.appendEvent("session.turn-ended", null, {});
  await until("the event after the reset is delivered", () => delivered.length > 0);
  assert.deepEqual(delivered, [next]);
  assert.equal(resets.length, 1);
});

test("a stopped follower polls no more", async (t) => {
  const { registry, delivered, stop, batches } = following(t);
  await until("the follower polls", () => batches() > 0);
  stop();
  const polled = batches();
  registry.appendEvent("session.turn-ended", null, {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(batches(), polled);
  assert.deepEqual(delivered, []);
});
