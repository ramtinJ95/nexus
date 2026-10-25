import { test } from "node:test";
import assert from "node:assert/strict";
import { coordinator, notificationChannel, badgeCount, badgeText } from "./notifications.js";

const row = (attention, agentTurnRunning = false, id = "t1") => ({ id, attention, agentTurnRunning });
test("initial states are silent; failures and parked notify immediately", () => {
  const events = [];
  const update = coordinator((r) => events.push(r));
  update([row("reply"), row("failed", false, "t2"), row("parked", false, "t3")], 0);
  update([row("reply"), row("failed", false, "t2"), row("parked", false, "t3")], 9000);
  assert.deepEqual(events, []);
  update([row("parked")], 9001);
  update([row("failed")], 9002);
  assert.deepEqual(events.map((r) => r.attention), ["parked", "failed"]);
});
test("reply waits two seconds, and a follow-up cancels even when unread reply outranks working", () => {
  const events = [];
  const update = coordinator((r) => events.push(r));
  update([row(null)], 0);
  update([row("reply")], 100);
  update([row("reply")], 2099);
  assert.equal(events.length, 0);
  update([row("reply")], 2100);
  assert.equal(events.length, 1);
  update([row(null)], 3000);
  update([row("reply")], 4000);
  update([row("reply", true)], 4500);
  update([row("reply")], 7000);
  assert.equal(events.length, 1);
  update([row(null)], 8000);
  update([row("reply")], 9000);
  update([], 9500);
  update([], 12000);
  assert.equal(events.length, 1);
});
test("focused other thread gets only toast; background needs secure context and permission", () => {
  assert.equal(notificationChannel(true, "t2", "t1", true, "granted"), "toast");
  assert.equal(notificationChannel(true, "t1", "t1", true, "granted"), null);
  assert.equal(notificationChannel(false, "t1", "t1", true, "granted"), "system");
  assert.equal(notificationChannel(false, null, "t1", false, "granted"), null);
  assert.equal(notificationChannel(false, null, "t1", true, "default"), null);
  assert.equal(notificationChannel(true, null, "t1", false, "unavailable"), "toast");
});
test("badge counts only actionable threads and caps its label", () => {
  assert.equal(badgeCount([row("failed"), row("parked"), row("reply"), row("working"), row(null)]), 3);
  assert.equal(badgeText(0), "0");
  assert.equal(badgeText(9), "9");
  assert.equal(badgeText(10), "9+");
});


test("a follow-up's final reply gets its own grace period even while attention stays reply", () => {
  const events = [];
  const update = coordinator((r) => events.push(r));
  const reply = (lastReplyAt, working = false) => ({ ...row("reply", working), lastReplyAt });
  update([row(null)], 0);
  update([reply(100)], 100);
  update([reply(100, true)], 1000);
  update([reply(100, true)], 2200);
  assert.deepEqual(events, []);
  update([reply(3000)], 3000);
  update([reply(3000)], 4999);
  assert.deepEqual(events, []);
  update([reply(3000)], 5000);
  update([reply(3000)], 8000);
  assert.deepEqual(events, [reply(3000)]);
  // Even a follow-up entirely between polls is a distinct reply.
  update([reply(9000)], 9000);
  update([reply(9000)], 11000);
  assert.deepEqual(events, [reply(3000), reply(9000)]);
});

