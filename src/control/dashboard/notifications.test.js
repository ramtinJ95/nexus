import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { coordinator, notificationChannel, needSelectors, noticeUrl, owedSeen, seenBody } from "./notifications.js";

const row = (attention, working = false, id = "t1") => ({ id, attention, working });
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
});
test("a session waiting on the person notifies at once, as its row stays bright", () => {
  const events = [];
  const update = coordinator((r) => events.push(r));
  update([row("working")], 0);
  update([row("waiting")], 1);
  assert.deepEqual(events.map((r) => r.attention), ["waiting"]);
});
test("a row whose attention becomes null or working never notifies", () => {
  const events = [];
  const update = coordinator((r) => events.push(r));
  update([row("failed")], 0);
  update([row(null)], 1);
  update([row("working")], 2);
  update([row(null)], 3);
  update([row("waiting")], 4);
  assert.deepEqual(events.map((r) => r.attention), ["waiting"]);
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
test("a Claude worker's follow-up cancels a pending reply, and its next reply gets its own grace period", () => {
  const events = [];
  const update = coordinator((r) => events.push(r));
  const claude = (lastReplyAt, working) => ({ id: "t1", attention: "reply", agentTurnRunning: false, sessionTurnRunning: working || undefined, working, lastReplyAt });
  update([row(null)], 0);
  update([claude(100, false)], 100);
  update([claude(100, true)], 1000);
  update([claude(100, true)], 5000);
  assert.deepEqual(events, [], "no reply notifies while the session's turn runs");
  update([claude(6000, false)], 6000);
  update([claude(6000, false)], 8000);
  assert.deepEqual(events, [claude(6000, false)]);
});
test("focused other thread gets only toast; background needs secure context and permission", () => {
  assert.equal(notificationChannel(true, "t2", "t1", true, "granted"), "toast");
  assert.equal(notificationChannel(true, "t1", "t1", true, "granted"), null);
  assert.equal(notificationChannel(false, "t1", "t1", true, "granted"), "system");
  assert.equal(notificationChannel(false, null, "t1", false, "granted"), null);
  assert.equal(notificationChannel(false, null, "t1", true, "default"), null);
  assert.equal(notificationChannel(true, null, "t1", false, "unavailable"), "toast");
});
test("a notice opens the inbox's card for what its thread waits on, and a reply, which has no card, opens the thread", () => {
  assert.equal(noticeUrl({ id: "th-0123456789ab", attention: "failed" }), "/#needs-you:th-0123456789ab:failed");
  assert.equal(noticeUrl({ id: "th-0123456789ab", attention: "decision" }), "/#needs-you:th-0123456789ab:decision");
  assert.equal(noticeUrl({ id: "th-0123456789ab", attention: "reply" }), "/threads/th-0123456789ab");
  assert.deepEqual(needSelectors("#needs-you:th-0123456789ab:waiting"), ['.need[data-thread="th-0123456789ab"][data-attention="waiting"]', '.need[data-thread="th-0123456789ab"]'],
    "the thread's card for that attention, or else any of its cards");
  for (const hash of ["", "#needs-you", "#terminal", '#needs-you:th-1"],a:failed']) assert.equal(needSelectors(hash), null, hash);
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

test("a page owes a seen mark once for each reply it shows, so one marked unseen elsewhere stays unseen", () => {
  const conversation = { dataset: { renderedReplyAt: "1000" } };
  assert.deepEqual(owedSeen(conversation, null), { lastReplyAt: 1000 });
  assert.equal(owedSeen(conversation, 1000), null, "the reply it marked already");
  conversation.dataset.renderedReplyAt = "2000";
  assert.deepEqual(owedSeen(conversation, 1000), { lastReplyAt: 2000 });
  assert.equal(owedSeen({ dataset: { renderedReplyAt: "" } }, null), null, "a page that shows no reply marks nothing");
  assert.equal(owedSeen(null, null), null);
});

const client = await readFile(new URL("./client.js", import.meta.url), "utf8");
const slice = (from, to) => client.slice(client.indexOf(from), client.indexOf(to));
const api = slice("async function api(", "\nfunction showError(");
const rows = slice("// The events that change a row's attention", "\nlet marking = false;");
const marking = slice("let marking = false;", "\nsetInterval(markSeen, 1000);");

/**
 * One dashboard tab's attention code from client.js, run in its own context. Tabs given the same `browser` share its
 * BroadcastChannel and its one Web Lock, which the first tab to ask holds.
 */
function tab(browser, { fetch, now = () => 0, notify = () => {}, conversation = null, focused = true, timeout = (ms) => AbortSignal.timeout(ms), locks = true, visible = true }) {
  const timers = [];
  const intervals = [];
  const favicon = { href: "/assets/favicon.svg?v=0123456789ab" };
  const doc = {
    title: "Threads · Nexus",
    getElementById: (id) => id === "convo" ? conversation : null,
    querySelector: (selector) => selector === 'link[rel="icon"]' ? favicon : null,
    visibilityState: visible ? "visible" : "hidden",
    listeners: [],
    addEventListener: (_, listener) => doc.listeners.push(listener),
  };
  class Channel {
    constructor() { browser.channels.push(this); this.listeners = []; }
    addEventListener(_, listener) { this.listeners.push(listener); }
    postMessage(data) { browser.posts += 1; for (const other of browser.channels) if (other !== this) for (const l of other.listeners) l({ data }); }
  }
  class Events {
    constructor(url) { browser.streams.push(this); this.url = url; this.closed = false; }
    close() { this.closed = true; }
  }
  const context = {
    window: { BroadcastChannel: Channel }, BroadcastChannel: Channel, EventSource: Events, URLSearchParams,
    navigator: locks ? { locks: { request: (_, hold) => { if (!browser.locked) { browser.locked = true; hold(); } return new Promise(() => {}); } } } : {},
    document: doc, fetch, Date: { now },
    AbortSignal: { timeout }, setTimeout: (f, ms) => timers.push({ f, at: now() + ms }), clearTimeout: () => timers.splice(0),
    setInterval: (f, ms) => intervals.push({ f, ms }), notifications: coordinator(notify), owedSeen,
    currentThread: () => "t1", focused: () => focused, activeTab: null,
  };
  const code = runInNewContext(`${api}\n${rows}\n${marking}\n({ readRows, markSeen })`, context);
  const show = (state) => { doc.visibilityState = state; for (const l of doc.listeners) l(); };
  return { ...code, doc, favicon, timers, intervals, show };
}
const browser = () => ({ channels: [], streams: [], locked: false, posts: 0 });
const json = (body) => ({ ok: true, text: async () => JSON.stringify(body) });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("stalled attention requests time out, release their lock and retry", async (t) => {
  for (const method of ["GET", "POST"]) for (const phase of ["headers", "body"]) {
    await t.test(`${method} stalled at ${phase}`, async () => {
      let stall = true;
      const requests = [];
      const timeouts = [];
      const conversation = { dataset: { renderedReplyAt: "1000" }, querySelector: () => null };
      const waitForAbort = (signal) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const page = tab(browser(), {
        conversation,
        timeout: (ms) => { timeouts.push(ms); return AbortSignal.timeout(20); },
        fetch: async (path, options) => {
          requests.push(options.method);
          assert.ok(options.signal, "each request has a deadline");
          const stuck = stall && options.method === method;
          if (stuck && phase === "headers") return waitForAbort(options.signal);
          return { ok: true, text: () => stuck ? waitForAbort(options.signal) : Promise.resolve(options.method === "GET" ? '[{"id":"t1","attention":"reply"}]' : "") };
        },
      });
      const call = method === "GET" ? page.readRows : page.markSeen;
      const sent = () => requests.filter((m) => m === method).length;
      if (method === "POST") void call();
      await call();
      assert.equal(sent(), 1, "a call while one is stalled sends nothing");
      await new Promise((resolve) => setTimeout(resolve, 50));
      stall = false;
      await call();
      assert.equal(sent(), 2, "the next call goes out once the stalled one gave up");
      assert.ok(timeouts.every((ms) => ms === 10_000));
    });
  }
});

test("threads that need the person leave the tab's title and icon as the page set them", async () => {
  let reads = 0;
  const listed = ["failed", "decision", "parked", "limited", "reply", "waiting"].flatMap((attention) => [row(attention, false, `${attention}-1`), row(attention, false, `${attention}-2`)]);
  const leader = tab(browser(), { fetch: async () => { reads += 1; return json(listed); } });
  await settle();
  assert.ok(reads > 0, "the tab read the threads");
  assert.equal(leader.doc.title, "Threads · Nexus");
  assert.equal(leader.favicon.href, "/assets/favicon.svg?v=0123456789ab");
});

test("a hidden tab notifies from the rows the tab that follows the events read, with no request of its own", async () => {
  let now = 0;
  let listed = [{ id: "t1", title: "Fix", attention: null, working: false, lastReplyAt: null }];
  const shared = browser();
  const reads = { leader: 0, hidden: 0 };
  const notified = { leader: [], hidden: [] };
  const page = (name) => tab(shared, {
    now: () => now, notify: (row) => notified[name].push(row.attention),
    fetch: async (path) => { assert.equal(path, "/v1/threads?deleted=false"); reads[name] += 1; return json(listed); },
  });
  const leader = page("leader");
  const hidden = page("hidden");
  await settle();
  assert.deepEqual(reads, { leader: 2, hidden: 0 }, "the tab that took the lock reads the list for itself and for the tab that asked");
  assert.equal(shared.streams.length, 1, "only the tab that took the lock follows the events");
  const query = new URL(shared.streams[0].url, "http://nexus").searchParams;
  assert.deepEqual([query.get("follow"), query.get("since"), query.getAll("kind")],
    ["true", "latest", ["attention.changed", "thread.turn-ended", "session.turn-started", "session.turn-ended", "session.waiting", "session.ended"]]);
  assert.deepEqual(leader.intervals.map((i) => i.ms), [10_000], "and reads the list every 10 s for what sends no event");
  assert.deepEqual(hidden.intervals, []);

  const stream = shared.streams[0];
  listed = [{ ...listed[0], attention: "waiting" }];
  stream.onmessage({});
  await settle();
  assert.deepEqual(notified, { leader: ["waiting"], hidden: ["waiting"] }, "a change that needs the person notifies every tab at once");
  assert.equal(hidden.doc.title, "Threads · Nexus", "and leaves every tab's title as the page set it");

  now = 1000;
  listed = [{ ...listed[0], attention: "reply", lastReplyAt: 1000 }];
  stream.onmessage({});
  await settle();
  assert.deepEqual(notified.hidden, ["waiting"], "a reply is held back");
  assert.deepEqual(leader.timers.map((timer) => timer.at), [3000], "the following tab reads again when the reply comes due");
  now = 3000;
  leader.timers[0].f();
  await settle();
  assert.deepEqual(notified, { leader: ["waiting", "reply"], hidden: ["waiting", "reply"] }, "every tab holds the reply back to the same moment");
  assert.equal(reads.hidden, 0, "the hidden tab read nothing");
});

test("the tab that follows the events reads every second while a turn runs over an unread reply, as its stop sends no event", async () => {
  let now = 0;
  let listed = [{ id: "t1", title: "Fix", attention: null, working: false, lastReplyAt: null }];
  const notified = [];
  const leader = tab(browser(), { now: () => now, notify: (row) => notified.push(row.attention), fetch: async () => json(listed) });
  await settle();
  listed = [{ ...listed[0], attention: "reply", working: true, lastReplyAt: 100 }];
  now = 100;
  await leader.readRows();
  assert.deepEqual(leader.timers.map((timer) => timer.at), [1100]);
  listed = [{ ...listed[0], working: false }];
  now = 1100;
  leader.timers.at(-1).f();
  await settle();
  assert.deepEqual(leader.timers.map((timer) => timer.at), [3100], "the stop holds the reply back 2 s");
  now = 3100;
  leader.timers.at(-1).f();
  await settle();
  assert.deepEqual(notified, ["reply"]);
  assert.deepEqual(leader.timers, [], "and nothing more to read for");
});

test("the tab that follows the events reads again a second after a read failed", async () => {
  let fail = true;
  let read = 0;
  const shared = browser();
  const leader = tab(shared, { fetch: async () => { if (fail) throw new Error("connection reset"); read += 1; return json([{ id: "t1", attention: "failed" }]); } });
  await settle();
  assert.deepEqual(leader.timers.map((timer) => timer.at), [1000]);
  fail = false;
  leader.timers[0].f();
  await settle();
  assert.equal(read, 1);
  assert.deepEqual(leader.timers, [], "and stops retrying once it reads");
});

test("over plain HTTP, with no Web Locks, a visible tab follows the events itself and a hidden one holds no stream", async () => {
  const shared = browser();
  const reads = { visible: 0, hidden: 0 };
  const page = (name) => tab(shared, { locks: false, visible: name === "visible", fetch: async () => { reads[name] += 1; return json([]); } });
  const visible = page("visible");
  const hidden = page("hidden");
  await settle();
  assert.equal(shared.streams.length, 1, "only the visible tab follows the events");
  const query = new URL(shared.streams[0].url, "http://nexus").searchParams;
  assert.deepEqual(query.getAll("kind"), ["attention.changed", "thread.turn-ended", "session.turn-started", "session.turn-ended", "session.waiting", "session.ended"]);
  for (const each of [visible, hidden]) assert.deepEqual(each.intervals.map((i) => i.ms), [10_000], "every tab reads the list every 10 s, not every second");
  assert.deepEqual(reads, { visible: 1, hidden: 1 }, "each tab reads the list once as it loads");

  shared.streams[0].onmessage({});
  await settle();
  assert.equal(reads.visible, 2, "an event reads the list");
  visible.show("hidden");
  assert.ok(shared.streams[0].closed, "a tab that is hidden closes its stream");
  visible.show("visible");
  assert.equal(shared.streams.length, 2, "and opens another on return");
  assert.equal(shared.streams[1].closed, false);
  hidden.show("visible");
  assert.equal(shared.streams.length, 3);
  assert.equal(shared.posts, 0, "no tab hands rows to another");
});

test("a page marks each reply it shows seen once, so one marked unseen elsewhere stays unseen", async () => {
  const posts = [];
  const conversation = { dataset: { renderedReplyAt: "1000" }, querySelector: () => null };
  const page = tab(browser(), {
    conversation,
    fetch: async (path, options) => {
      if (options.method === "POST") posts.push([path, JSON.parse(options.body)]);
      return json([]);
    },
  });
  for (let i = 0; i < 5; i += 1) await page.markSeen();
  assert.deepEqual(posts, [["/v1/threads/t1/seen", { lastReplyAt: 1000 }]], "once, however long the page stays focused");
  conversation.dataset.renderedReplyAt = "2000";
  await page.markSeen();
  await page.markSeen();
  assert.deepEqual(posts.at(-1), ["/v1/threads/t1/seen", { lastReplyAt: 2000 }], "a newer reply shown is marked");
  assert.equal(posts.length, 2);
});

test("a usage-limit stop notifies at once, where the reply that recorded it would wait", () => {
  const events = [];
  const update = coordinator((r) => events.push(r));
  update([row("working")], 0);
  update([row("limited")], 100);
  update([row("limited")], 5000);
  assert.deepEqual(events.map((r) => r.attention), ["limited"]);
});
