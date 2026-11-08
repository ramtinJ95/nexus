import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { services } from "./services.ts";
import { until } from "../test-support/kit.ts";

test("a periodic service polls when it starts and every everyMs after, until shutdown", async () => {
  const running = services();
  let polls = 0;
  running.start({ everyMs: 5, poll: () => polls++ });
  assert.equal(polls, 1);
  await until("it polls again", () => polls >= 3);
  await running.close();
  const after = polls;
  await delay(30);
  assert.equal(polls, after);
});

test("shutdown closes every service once, the last started first, past one whose close fails", async () => {
  const running = services();
  const closed: string[] = [];
  const failure = new Error("its close failed");
  running.start({ everyMs: 60_000, poll() {}, close: () => { closed.push("periodic"); } });
  assert.equal(running.start(null), null);
  running.start({ close: async () => { closed.push("failing"); throw failure; } });
  running.start({ everyMs: 60_000, poll() {} });
  running.start({ close: () => { closed.push("last"); } });
  await assert.rejects(running.close(), failure);
  assert.deepEqual(closed, ["last", "failing", "periodic"]);
  await running.close();
  assert.deepEqual(closed, ["last", "failing", "periodic"]);
});
