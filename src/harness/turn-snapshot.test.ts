import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { LiveDoc, type GenerationHooks, type HookApi } from "@earendil-works/pi-durable";
import { turnSnapshots } from "./turn-snapshot.ts";

test("snapshot failure logs, lets the request proceed, and never retries after tools may have run", async () => {
  const logs: string[] = [];
  let attempts = 0;
  let memo: unknown;
  const extension = turnSnapshots(async (pylon, turn) => {
    assert.equal(pylon, "pylon-test");
    assert.equal(turn, "42");
    attempts++;
    throw new Error("pipe lost");
  }, (line) => logs.push(line));
  const api = {
    snapshot: async (token: unknown) => token === LiveDoc ? { run: { taskId: 42 } } : { pylonId: "pylon-test" },
    memo: async (_name: string, value: unknown) => {
      if (value === true) memo = true;
      return memo;
    },
  } as unknown as HookApi;
  const hooks = extension.hooks![0]!.handlers as GenerationHooks;
  await hooks.beforeRequest({ messages: [] }, api, context);
  await hooks.beforeRequest({ messages: [] }, api, context);
  assert.equal(attempts, 1);
  assert.deepEqual(logs, ["latest-turn snapshot failed: pipe lost"]);
});
