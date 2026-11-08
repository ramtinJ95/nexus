import { test } from "node:test";
import assert from "node:assert/strict";
import type { NexusEvent } from "./events.ts";
import { openDb } from "./db.ts";
import { testRegistry } from "../test-support/registry-kit.ts";
import { until } from "../test-support/kit.ts";

test("a follower is handed the events of its kinds appended after it starts, and none from before", async (t) => {
  const registry = testRegistry(t);
  registry.appendEvent("session.turn-ended", null, { before: true });
  const delivered: NexusEvent[] = [];
  t.after(registry.followEvents(["session.turn-ended"], (events) => delivered.push(...events)));
  registry.appendEvent("release.changed", null, {});
  const after = registry.appendEvent("session.turn-ended", null, {});
  await until("the new event is delivered", () => delivered.length > 0);
  assert.deepEqual(delivered, [after]);
});

test("a follower is handed every event of its kinds however many events come between and retention drops", async (t) => {
  const registry = testRegistry(t);
  const delivered: NexusEvent[] = [];
  t.after(registry.followEvents(["session.turn-ended"], (events) => delivered.push(...events)));
  const first = registry.appendEvent("session.turn-ended", null, { first: true });
  for (let i = 0; i < 10_002; i++) registry.appendEvent("release.changed", null, {});
  registry.retainEvents();
  const next = registry.appendEvent("session.turn-ended", null, {});
  await until("both events are delivered", () => delivered.length === 2);
  assert.deepEqual(delivered, [first, next]);
  assert.throws(() => registry.eventBatch(first.id), /expired/, "retention dropped the first event from the log");
});

test("a stopped follower is handed no more events", async (t) => {
  const registry = testRegistry(t);
  const delivered: NexusEvent[] = [];
  const stop = registry.followEvents(["session.turn-ended"], (events) => delivered.push(...events));
  registry.appendEvent("session.turn-ended", null, {});
  stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(delivered, [], "an event appended before the stop but not yet handed over is dropped");
});

test("the events appended in one turn of the event loop reach a follower in one batch, after the appends return", async (t) => {
  const registry = testRegistry(t);
  const batches: NexusEvent[][] = [];
  t.after(registry.followEvents(["release.changed"], (events) => batches.push([...events])));
  const a = registry.appendEvent("release.changed", null, { n: 1 });
  const b = registry.appendEvent("release.changed", null, { n: 2 });
  assert.deepEqual(batches, []);
  await until("the batch is delivered", () => batches.length > 0);
  assert.deepEqual(batches, [[a, b]]);
});

test("work deferred to a commit runs once the outermost transaction commits, and never when it rolls back", () => {
  const db = openDb(":memory:");
  const ran: string[] = [];
  db.transaction(() => {
    db.transaction(() => db.afterCommit(() => ran.push("inner")));
    assert.deepEqual(ran, [], "nothing runs before the outermost commit");
  });
  assert.deepEqual(ran, ["inner"]);
  assert.throws(() => db.transaction(() => {
    db.afterCommit(() => ran.push("rolled back"));
    throw new Error("abort");
  }), /abort/);
  db.transaction(() => db.afterCommit(() => ran.push("next")));
  db.afterCommit(() => ran.push("outside"));
  assert.deepEqual(ran, ["inner", "next", "outside"]);
  db.db.close();
});

test("an event a follower appends while handling a batch reaches it in the next batch", async (t) => {
  const registry = testRegistry(t);
  const batches: NexusEvent[][] = [];
  t.after(registry.followEvents(["release.changed"], (events) => {
    batches.push([...events]);
    if (batches.length === 1) registry.appendEvent("release.changed", null, { reply: true });
  }));
  const first = registry.appendEvent("release.changed", null, {});
  await until("the reply is delivered", () => batches.length === 2);
  assert.deepEqual(batches[0], [first]);
  assert.deepEqual(batches[1]!.map((e) => e.payload), [{ reply: true }]);
});
