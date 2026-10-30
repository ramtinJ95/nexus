import { test } from "node:test";
import assert from "node:assert/strict";
import { serialQueue } from "./single-flight.ts";

test("a serial queue starts each run after the one before it settles, and a failure does not stop the next", async () => {
  const queue = serialQueue();
  const order: string[] = [];
  const first = Promise.withResolvers<string>();
  const a = queue.run(async () => { order.push("a starts"); const value = await first.promise; order.push("a ends"); return value; });
  const b = queue.run(async () => { order.push("b runs"); throw new Error("b failed"); });
  const c = queue.run(async () => { order.push("c runs"); return 3; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["a starts"], "b waits for a");
  first.resolve("a");
  assert.equal(await a, "a");
  await assert.rejects(b, { message: "b failed" });
  assert.equal(await c, 3);
  assert.deepEqual(order, ["a starts", "a ends", "b runs", "c runs"]);
});

test("a run that throws before it returns a promise rejects its own caller only", async () => {
  const queue = serialQueue();
  const failed = queue.run(() => { throw new Error("at once"); });
  await assert.rejects(failed, { message: "at once" });
  assert.equal(await queue.run(async () => "next"), "next");
});
