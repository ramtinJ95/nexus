import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { gateTurns, openHarnessHost, turnStarting, type ConversationId, type HarnessHost } from "./host.ts";
import { DeployDraining, turnGate } from "../drain.ts";
import { scriptedModel, scriptedModels, scriptedUsage, type ScriptedRequest } from "./test-fixture.ts";
import type { PylonId } from "../../ids.ts";
import { tempDir } from "../../test-support/kit.ts";

test("the usage of a conversation's answers reads on from the last entry read, and stays readable after its thread is deleted", async (t) => {
  const scratch = await tempDir("nexus-host-usage-", t);
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

test("a judgment's conversation is offered no tools, needs no pylon, and has replies once its run ends, across a reopen", async (t) => {
  const scratch = await tempDir("nexus-host-judgment-", t);
  const seen: ScriptedRequest[] = [];
  let hold: Promise<void> | null = new Promise<void>(() => {});
  let located = 0;
  const open = () => openHarnessHost({
    storagePath: join(scratch, "harness.sqlite"), models: scriptedModels({ seen: (r) => seen.push(r), held: () => hold }), model: scriptedModel,
    tailscaled: join(scratch, "none.sock"), threads: [], deleted: [], onActivity: () => {}, log: () => {},
    locator: { awaitRunning: () => { located++; return Promise.reject(new Error("no pylon in this test")); } },
  });
  const eventually = async <T>(read: () => T | null | Promise<T | null>): Promise<T> => {
    for (let i = 0; i < 500; i++) {
      const value = await read();
      if (value !== null) return value;
      await new Promise((r) => setTimeout(r, 10));
    }
    return assert.fail("timed out");
  };
  const brief = 'Is it the node?\njudge: retry\n```nexus-judgment\n{"token": "judgment:7:abc", "answer": "retry"}\n```';
  const host = await open();
  const id = await host.startJudgment();
  await host.sendJudgment(id, brief, "judgment:7");
  await host.sendJudgment(id, brief, "judgment:7");
  await eventually(() => seen[0] ?? null);
  assert.equal(await host.judgmentReplies(id), null, "no replies while its run is on");
  await host.close();

  hold = null;
  const reopened = await open();
  t.after(() => reopened.close());
  const replies = await eventually(() => reopened.judgmentReplies(id));
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /```nexus-judgment\n\{"token":"judgment:7:abc","answer":"retry","why":"scripted judgment: the brief says judge: retry"\}\n```/);
  assert.deepEqual([...seen], [{ tools: [], last: brief }, { tools: [], last: brief }], "the reopen ran the one brief again, and offered no tools either time");
  assert.equal(located, 0, "nothing looked for a pylon");

  await reopened.startThread({ threadId: "th-tools", pylonId: "pylon-th-tools" as PylonId });
  await reopened.send("th-tools", "hello", "m1", "followUp");
  assert.ok((await eventually(() => seen[2] ?? null)).tools.includes("bash"), "a thread's conversation in the same harness is offered the coding tools");
});

test("each deleted conversation aborted, by a delete or at open, is told to onAborted", async (t) => {
  const scratch = await tempDir("nexus-host-aborted-", t);
  const aborted: ConversationId[] = [];
  const open = (deleted: readonly ConversationId[]) => openHarnessHost({
    storagePath: join(scratch, "harness.sqlite"), models: scriptedModels(), model: scriptedModel, tailscaled: join(scratch, "none.sock"),
    locator: { awaitRunning: () => Promise.reject(new Error("no pylon in this test")) },
    threads: [], deleted, onAborted: (id) => aborted.push(id), onActivity: () => {}, log: () => {},
  });
  const host = await open([]);
  const [first, second] = [await host.startThread({ threadId: "th-a", pylonId: "pylon-th-a" as PylonId }), await host.startThread({ threadId: "th-b", pylonId: "pylon-th-b" as PylonId })];
  await host.deleteThread({ threadId: "th-a", pylonId: "pylon-th-a" as PylonId });
  assert.deepEqual(aborted, [first]);
  await host.close();
  const reopened = await open([first, second]);
  t.after(() => reopened.close());
  assert.deepEqual(aborted, [first, first, second]);
});

test("a draining gate refuses exactly the five methods that start a turn, and passes the rest through", async () => {
  assert.deepEqual(turnStarting, ["startThread", "send", "retry", "startJudgment", "sendJudgment"]);
  const called: string[] = [];
  const methods = ["startThread", "send", "latestTurn", "abort", "retry", "watch", "deleteThread", "usage", "startJudgment", "sendJudgment", "judgmentReplies", "abortJudgment", "close"] as const;
  const raw = Object.fromEntries(methods.map((m) => [m, async (...args: unknown[]) => { called.push(`${m}(${args.join(",")})`); return m; }])) as unknown as HarnessHost;
  let draining = false;
  const harness = gateTurns(raw, turnGate(() => draining));
  assert.equal(await harness.send("t1", "hi", "r1", "followUp"), "send");
  draining = true;
  const refused: (typeof methods)[number][] = [];
  for (const m of methods) {
    const call = (harness[m] as (...args: unknown[]) => Promise<unknown>)("x");
    if (await call.then(() => false, (err: unknown) => err instanceof DeployDraining)) refused.push(m);
  }
  assert.deepEqual(called, ["send(t1,hi,r1,followUp)", ...methods.filter((m) => !refused.includes(m)).map((m) => `${m}(x)`)]);
  assert.deepEqual(refused, [...turnStarting]);
});
