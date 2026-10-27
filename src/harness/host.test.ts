import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarnessHost, type ConversationId } from "./host.ts";
import { scriptedModel, scriptedModels, scriptedUsage } from "./test-fixture.ts";
import type { PylonId } from "../protocol.ts";

test("the usage of a conversation's answers reads on from the last entry read, and stays readable after its thread is deleted", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "nexus-host-usage-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const storagePath = join(scratch, "harness.sqlite");
  const replies: string[] = [];
  const open = (deleted: readonly ConversationId[]) => openHarnessHost({
    storagePath, models: scriptedModels(), model: scriptedModel, tailscaled: join(scratch, "none.sock"),
    locator: { awaitRunning: () => Promise.reject(new Error("no pylon in this test")) },
    threads: [], deleted, onActivity: () => {}, onReply: (id) => replies.push(id), log: () => {},
  });
  const answered = async (n: number) => {
    for (let i = 0; i < 500 && replies.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(replies.length, n);
  };
  const host = await open([]);
  const pylonId = "pylon-th-usage" as PylonId;
  const conversation = await host.startThread({ threadId: "th-usage", pylonId });
  await host.send("th-usage", "hello", "m1", "followUp");
  await answered(1);
  const first = await host.usage(conversation, null);
  assert.deepEqual(first.calls.map(({ id: _, at: __, ...call }) => call), [{ agent: "pi", model: scriptedModel.modelId, ...scriptedUsage }]);
  assert.match(first.calls[0]!.id, new RegExp(`^harness:${conversation}/\\d+$`));
  assert.deepEqual((await host.usage(conversation, first.last)).calls, []);

  await host.send("th-usage", "again", "m2", "followUp");
  await answered(2);
  const second = await host.usage(conversation, first.last);
  assert.equal(second.calls.length, 1);
  assert.notEqual(second.calls[0]!.id, first.calls[0]!.id);
  await host.deleteThread({ threadId: "th-usage", pylonId });
  await host.close();

  const reopened = await open([conversation]);
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.usage(conversation, null)).calls.map((c) => c.id), [first.calls[0]!.id, second.calls[0]!.id]);
});
