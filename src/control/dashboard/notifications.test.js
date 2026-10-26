import { test } from "node:test";
import assert from "node:assert/strict";
import { coordinator, notificationChannel, badgeCount, badgeText, seenBody } from "./notifications.js";

const row = (attention, agentTurnRunning = false, id = "t1") => ({ id, attention, agentTurnRunning });
test("initial states are silent; failures and parked notify immediately", () => {
  const events = [];
  const update = coordinator((r) => events.push(r));
  update([row("reply"), row("failed", false, "t2"), row("parked", false, "t3")], 0);
  update([row("reply"), row("failed", false, "t2"), row("parked", false, "t3")], 9000);
  assert.deepEqual(events, []);
  update([row("parked")], 9001);
  update([row("failed")], 9002);
  update([row("decision")], 9003);
  assert.deepEqual(events.map((r) => r.attention), ["parked", "failed", "decision"]);
  assert.equal(badgeCount([row("decision"), row("working")]), 1);
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


test("seen payload stays at the rendered reply while attention polls find newer replies", () => {
  const conversation = { dataset: { renderedReplyAt: "1000" } };
  const update = coordinator(() => {});
  update([{ ...row("reply"), lastReplyAt: 1000 }], 1000);
  update([{ ...row("reply"), lastReplyAt: 2000 }], 2000);
  assert.deepEqual(seenBody(conversation), { lastReplyAt: 1000 });
  conversation.dataset.renderedReplyAt = "2000";
  assert.deepEqual(seenBody(conversation), { lastReplyAt: 2000 });
  assert.deepEqual(seenBody(null), { lastReplyAt: null });
  assert.deepEqual(seenBody({ dataset: { renderedReplyAt: "" } }), { lastReplyAt: null });
});

test("stalled attention requests time out, release the poll lock and retry", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const client = await readFile(new URL("./client.js", import.meta.url), "utf8");
  const api = client.slice(client.indexOf("async function api("), client.indexOf("\nfunction showError("));
  const polling = client.slice(client.indexOf("let attentionPolling ="), client.indexOf("\nvoid pollAttention();"));
  for (const method of ["GET", "POST"]) for (const phase of ["headers", "body"]) {
    await t.test(`${method} stalled at ${phase}`, async () => {
      let now = 10_000;
      let stall = true;
      const requests = [];
      const updates = [];
      const timeouts = [];
      const favicon = {};
      const conversation = { dataset: { renderedReplyAt: "1000" } };
      const waitForAbort = (signal) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const poll = runInNewContext(`${api}\n${polling}\npollAttention`, {
        AbortSignal: { timeout(ms) { timeouts.push(ms); return AbortSignal.timeout(20); } },
        Date: { now: () => now },
        fetch: async (path, options) => {
          requests.push(options.method);
          assert.ok(options.signal, "each request has a deadline");
          const stuck = stall && options.method === method;
          if (stuck && phase === "headers") return waitForAbort(options.signal);
          return {
            ok: true,
            text: () => stuck ? waitForAbort(options.signal) : Promise.resolve(options.method === "GET" ? '[{"id":"t1","attention":"reply"}]' : ""),
          };
        },
        document: {
          getElementById: () => conversation,
          querySelector: (selector) => selector === 'link[rel="icon"]' ? favicon : null,
        },
        notifications: (rows) => updates.push(rows),
        badgeCount, badgeText, seenBody,
        currentThread: () => "t1", focused: () => true, activeTab: null,
      });
      // AbortSignal's timer is unref'ed in Node; keep this simulated browser alive until it fires.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        const first = poll();
        await poll();
        await first;
        assert.deepEqual(requests, method === "GET" ? ["GET"] : ["GET", "POST"], "overlapping polls are suppressed");
        stall = false;
        now += 4000;
        await poll();
        assert.deepEqual(requests.slice(-2), ["GET", "POST"], "the recovered poll lists threads and marks seen");
        assert.equal(updates.length, method === "GET" ? 1 : 2);
        assert.ok(favicon.href.startsWith("data:image/svg+xml,"), "badges recover too");
        assert.ok(timeouts.every((ms) => ms === 10_000));
      } finally {
        clearInterval(keepAlive);
      }
    });
  }
});

test("a usage-limit stop notifies at once, where the reply that recorded it would wait", () => {
  const events = [];
  const update = coordinator((r) => events.push(r));
  update([row("working")], 0);
  update([row("limited")], 100);
  update([row("limited")], 5000);
  assert.deepEqual(events.map((r) => r.attention), ["limited"]);
  assert.equal(badgeCount([row("limited"), row("working")]), 1);
});
