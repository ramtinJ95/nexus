import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedFlight, serialQueue } from "./single-flight.ts";

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

test("a scoped flight runs wakes and polls one at a time, sharing one run among the wakes that wait for it", async () => {
  const runs: (string[] | null)[] = [];
  let running = 0;
  let overlapped = false;
  const gate = Promise.withResolvers<void>();
  const flight = scopedFlight<string>(async (only) => {
    running++;
    if (running > 1) overlapped = true;
    runs.push(only === null ? null : [...only].sort());
    if (runs.length === 1) await gate.promise;
    running--;
  });
  const first = flight.wake("a");
  const polled = flight.poll();
  const b = flight.wake("b");
  const c = flight.wake("c");
  gate.resolve();
  await Promise.all([first, polled, b, c]);
  assert.deepEqual(runs, [["a"], null], "the wakes during the first run ride the poll's run over everything");
  assert.equal(overlapped, false);

  runs.length = 0;
  const again = Promise.withResolvers<void>();
  const flight2 = scopedFlight<string>(async (only) => {
    runs.push(only === null ? null : [...only].sort());
    if (runs.length === 1) await again.promise;
  });
  const whole = flight2.poll();
  const joined = flight2.poll();
  const d = flight2.wake("d");
  const e = flight2.wake("e");
  again.resolve();
  await Promise.all([whole, joined, d, e]);
  assert.deepEqual(runs, [null, ["d", "e"]], "a poll joins a run over everything, and a burst of wakes runs once after it");
});
