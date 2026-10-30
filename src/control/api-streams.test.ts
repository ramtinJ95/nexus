/** A thread's event stream and the event log's followers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { request } from "node:http";
import { maxStreams } from "./api/sse.ts";
import { until } from "../test-kit.ts";
import type { TailnetNodeId } from "../ids.ts";
import { laptop, testApi, withThread, deployCommit, deployment, reporterHeaders } from "./api-test-kit.ts";

test("a follow from the latest event gets a reply's events and none from before it", async (t) => {
  const s = await withThread(t);
  s.registry.recordReply(s.thread.id, Date.now());
  const kinds = ["attention.changed", "thread.turn-ended", "session.turn-started", "session.turn-ended", "session.waiting", "session.ended"];
  const stream = s.events(`/v1/events?follow=true&since=latest&${kinds.map((k) => `kind=${k}`).join("&")}`);
  t.after(() => stream.close());
  await stream.response;
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/seen`, {})).status, 204);
  s.registry.recordReply(s.thread.id, Date.now());
  assert.deepEqual([(await stream.next()).payload, (await stream.next()).kind, (await stream.next()).payload], [{ attention: null }, "thread.turn-ended", { attention: "reply" }]);
  assert.deepEqual((await s.call("GET", "/v1/events?since=latest")).body, [], "nothing comes after the latest event");
});

test("a thread's event stream sends the whole view, then each part a commit changed, and stops its watch when the client leaves", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  const transcript = fake.transcript(thread.id);
  transcript.docs["pi.inbox"] = { items: [] };
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  const res = await stream.response;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.deepEqual(await stream.next(), { entries: [], docs: { "pi.inbox": { items: [] } } }, "the first event is the whole view");

  transcript.docs["pi.live"] = { run: { taskId: 1, inputs: [] }, generation: { message: { role: "assistant", content: [{ type: "text", text: "Hal" }] } } };
  fake.commit(thread.id);
  assert.deepEqual(await stream.next(), { docs: { "pi.live": transcript.docs["pi.live"] } }, "a commit to the live document sends only it, whole");
  transcript.docs["pi.live"] = { run: { taskId: 1, inputs: [] }, generation: { message: { role: "assistant", content: [{ type: "text", text: "Half" }] } } };
  fake.commit(thread.id);
  assert.equal((await stream.next()).docs["pi.live"].generation.message.content[0].text, "Half", "the partial is a snapshot, not a delta");

  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "and then?", requestId: "msg:1" })).status, 202);
  const appended = await stream.next();
  assert.deepEqual(Object.keys(appended), ["entries"]);
  assert.deepEqual(appended.entries.map((e: any) => e.model[0].content), ["and then?"]);
  delete transcript.docs["pi.live"];
  fake.commit(thread.id);
  assert.deepEqual(await stream.next(), { docs: { "pi.live": null } }, "a document that is gone is null");

  assert.equal(fake.watching(thread.id), 1);
  stream.close();
  await until("the stream's watch stopped when its client left", () => fake.watching(thread.id) === 0);
  assert.deepEqual(s.calls.filter(([call]) => call === "watch" || call === "unwatch"), [["watch", thread.id], ["unwatch", thread.id]]);
});

test("a client that reads slowly gets the latest view in fewer events, and never holds the harness up", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  const transcript = fake.transcript(thread.id);
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await stream.next();
  stream.pause();
  const commits = 40;
  // Each commit a megabyte, so the paused client's socket fills after a few.
  for (let i = 1; i <= commits; i++) {
    transcript.docs["pi.live"] = { seq: i, output: "x".repeat(1 << 20) };
    fake.commit(thread.id);
    await new Promise((resolve) => setImmediate(resolve));
  }
  stream.resume();
  const seen: number[] = [];
  while (seen.at(-1) !== commits) seen.push((await stream.next()).docs["pi.live"].seq);
  assert.ok(seen.length < commits, `the backed-up events were merged: ${seen.length} events for ${commits} commits`);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "events stay in commit order");
  stream.close();
});

test("a thread's streams end when it is deleted, and a deleted thread, a stranger or one stream too many is refused", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.events(`/v1/threads/${thread.id}/events`).response).statusCode, 403);
  s.callAs(laptop);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/events`)).status, 405);

  const open = Array.from({ length: maxStreams }, () => s.events(`/v1/threads/${thread.id}/events`));
  for (const stream of open) await stream.next();
  const extra = await s.events(`/v1/threads/${thread.id}/events`).response;
  assert.equal(extra.statusCode, 503, "past the most streams the control plane serves");
  open.pop()!.close();
  await until("a closed stream frees its place", () => fake.watching(thread.id) === maxStreams - 1);
  const page = s.events(`/threads/${thread.id}/stream`);
  assert.ok((await page.next()).convo !== undefined, "the dashboard's stream counts against the same limit");
  open.push(page);

  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  await Promise.all(open.map((stream) => stream.ended));
  await until("every stream of the deleted thread stopped its watch", () => fake.watching(thread.id) === 0);
  assert.equal((await s.events(`/v1/threads/${thread.id}/events`).response).statusCode, 409);
  assert.equal((await s.events("/v1/threads/th-missing/events").response).statusCode, 404);
});

/** Backs up a paused client's socket with ten commits of a megabyte each. */
async function backUp(s: Awaited<ReturnType<typeof withThread>>) {
  const transcript = s.fake.transcript(s.thread.id);
  // One frame must exceed loopback's autotuned socket buffers even when intermediate commits coalesce.
  for (let i = 0; i < 3; i++) {
    transcript.docs["pi.live"] = { seq: i, output: "x".repeat(16 << 20) };
    s.fake.commit(s.thread.id);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a client that stops reading is dropped after the stall limit, with its watch and its place", async (t) => {
  const s = await withThread(t, { streamStallMs: 1000 });
  const { thread, fake } = s;
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await stream.next();
  stream.pause();
  await backUp(s);
  assert.equal(fake.watching(thread.id), 1, "a slow client is not dropped at once");
  await until("the dropped stream stopped its watch", () => fake.watching(thread.id) === 0);
  stream.resume();
  assert.equal(await stream.ended, "dropped");
  const again = s.events(`/v1/threads/${thread.id}/events`);
  assert.ok((await again.next()).entries !== undefined, "a client that still listens connects again and gets the whole view");
  again.close();
});

test("deleting a thread whose client stopped reading frees the stream at once, writes nothing after the end, and drops the client", async (t) => {
  const s = await withThread(t, { streamStallMs: 1000 });
  const { thread, fake } = s;
  const transcript = fake.transcript(thread.id);
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await stream.next();
  stream.pause();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await backUp(s);
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  transcript.docs["pi.live"] = { seq: 10 };
  fake.commit(thread.id);
  assert.equal(fake.watching(thread.id), 0, "the delete stopped the watch at once, though the client has not read the end yet");
  t.mock.timers.tick(1000);
  stream.resume();
  assert.equal(await stream.ended, "dropped", "a client that never read up to the end was dropped after the stall limit");
  assert.equal((await s.call("GET", "/v1/projects")).status, 200, "the control plane is still up");
});

test("a stream whose thread is deleted while its watch opens stops that watch", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  const release = fake.holdWatches();
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await until("the stream asked for its watch", () => s.calls.some(([call]) => call === "watch"));
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  release();
  await stream.ended;
  await until("the watch that opened after the delete was stopped", () => fake.watching(thread.id) === 0);
  assert.deepEqual(s.calls.filter(([call]) => call === "watch" || call === "unwatch"), [["watch", thread.id], ["unwatch", thread.id]]);
});

test("an event follower gets each event as an id and its data, then the watermark as a ping, every second, and a plain read gets them as JSON", async (t) => {
  const s = await testApi(t);
  const first = s.registry.appendEvent("release.changed", null, { state: "pending" });
  const unrelated = s.registry.appendEvent("thread.failed", null, {});
  const plain = await s.raw("/v1/events?kind=release.changed");
  assert.equal(plain.status, 200);
  assert.deepEqual([plain.headers["content-type"], plain.headers["cache-control"]], ["application/json", "no-store"]);
  assert.deepEqual(JSON.parse(plain.body.toString()), [first]);

  const chunks: string[] = [];
  const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    request({ host: "127.0.0.1", port: s.port, path: "/v1/events?follow=true&kind=release.changed", headers: { host: `127.0.0.1:${s.port}` } }, resolve).on("error", reject).end();
  });
  t.after(() => res.destroy());
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => chunks.push(chunk));
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.headers["content-type"], res.headers["cache-control"]], ["text/event-stream", "no-store"]);
  const frame = (event: { id: string }) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
  const ping = (id: string) => `id: ${id}\n: ping\n\n`;
  await until("the first batch arrived", () => chunks.join("").length >= (frame(first) + ping(unrelated.id)).length);
  assert.equal(chunks.join(""), frame(first) + ping(unrelated.id), "the watermark passes the unrelated event the filter left out");
  await until("a second passed", () => chunks.join("").length > (frame(first) + ping(unrelated.id)).length);
  const second = s.registry.appendEvent("release.changed", null, { state: "installing" });
  const expected = frame(first) + ping(unrelated.id) + ping(unrelated.id) + frame(second) + ping(second.id);
  await until("the next event arrived", () => chunks.join("").length >= expected.length);
  assert.equal(chunks.join("").slice(0, expected.length), expected);
});

test("an event follower open across a deploy drain gets every event in order, and the drain neither ends nor refuses it", async (t) => {
  const s = await testApi(t, { deployment });
  const stream = s.events("/v1/events?follow=true");
  t.after(() => stream.close());
  assert.equal((await s.call("PUT", "/v1/release", { commit: deployCommit })).status, 200);
  s.callAs("nFIREBAT" as TailnetNodeId);
  const report = (state: string) => s.call("POST", "/v1/deployer/report", { role: "control", commit: null, target: deployCommit, state, reason: null }, reporterHeaders);
  assert.equal((await report("waiting-for-idle")).status, 200);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
  assert.equal((await report("installing")).status, 200);
  s.callAs(laptop);
  assert.equal((await s.call("POST", "/v1/threads", {})).status, 409, "the drain holds");
  const during = s.events("/v1/events?follow=true&kind=release.changed");
  t.after(() => during.close());
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit, release: true }, reporterHeaders)).status, 200);
  assert.equal((await report("healthy")).status, 200);
  const states = async (reader: typeof stream, n: number) => {
    const seen: unknown[] = [];
    while (seen.length < n) seen.push((await reader.next()).payload.state ?? null);
    return seen;
  };
  assert.deepEqual(await states(stream, 4), [null, "waiting-for-idle", "installing", "healthy"], "the release asked for, then each report, in order");
  assert.deepEqual(await states(during, 4), [null, "waiting-for-idle", "installing", "healthy"], "a follower opened during the drain is served from the start");
  assert.equal(await Promise.race([stream.ended, new Promise((resolve) => setTimeout(resolve, 1_500, "open"))]), "open", "the follower stays open past the next ping");
});

test("a slow event follower gets every event once and in order, and one that stops reading is dropped after the stall limit with its place", async (t) => {
  const s = await testApi(t, { streamStallMs: 1000 });
  const slow = s.events("/v1/events?follow=true&kind=release.changed");
  t.after(() => slow.close());
  const firstId = s.registry.appendEvent("release.changed", null, { n: 0 }).id;
  assert.equal((await slow.next()).id, firstId);
  slow.pause();
  // A megabyte each, so the paused client's socket fills in a few events and the follower stops partway through a batch.
  const ids = [firstId];
  for (let n = 1; n <= 12; n++) ids.push(s.registry.appendEvent("release.changed", null, { n, pad: "x".repeat(1 << 20) }).id);
  await sleep(1_500);
  slow.resume();
  const seen = [firstId];
  while (seen.length < ids.length) seen.push((await slow.next()).id);
  assert.deepEqual(seen, ids, "each event once, in order");

  const stalled = s.events("/v1/events?follow=true");
  await stalled.response;
  stalled.pause();
  const others = Array.from({ length: maxStreams - 2 }, () => s.events("/v1/events?follow=true&kind=release.changed"));
  t.after(() => { for (const other of others) other.close(); });
  await Promise.all(others.map((other) => other.response));
  assert.equal((await s.events("/v1/events?follow=true&kind=release.changed").response).statusCode, 503, "every place is taken");
  for (let n = 0; n < 24; n++) s.registry.appendEvent("thread.failed", null, { n, pad: "x".repeat(1 << 20) });
  let freed = s.events("/v1/events?follow=true&kind=release.changed");
  while ((await freed.response).statusCode === 503) {
    await sleep(100);
    freed = s.events("/v1/events?follow=true&kind=release.changed");
  }
  t.after(() => freed.close());
  stalled.resume();
  assert.equal(await stalled.ended, "dropped", "the follower that stopped reading was dropped, which gave its place to the next");
});

test("event followers share the streams' places with thread streams, past which each is refused with its own error, and a thread's delete leaves them open", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const followers = Array.from({ length: maxStreams - 1 }, () => s.events("/v1/events?follow=true"));
  t.after(() => { for (const follower of followers) follower.close(); });
  await Promise.all(followers.map((follower) => follower.response));
  const page = s.events(`/v1/threads/${thread.id}/events`);
  await page.next();
  const follow = await s.call("GET", "/v1/events?follow=true");
  assert.deepEqual(follow, { status: 503, body: { error: "too many streams" } });
  const threadStream = await s.call("GET", `/v1/threads/${thread.id}/events`);
  assert.deepEqual(threadStream, { status: 503, body: { error: `${maxStreams} streams are open, the most this control plane serves at once` } });
  assert.deepEqual(await s.call("GET", "/v1/events?since=-1&follow=true"), { status: 400, body: { error: "invalid event cursor" } }, "a bad cursor is refused before the place is counted");
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  assert.equal(await page.ended, "end");
  const after = s.registry.appendEvent("release.changed", null, {});
  for (const follower of followers) assert.equal((await follower.next()).id, after.id, "every follower is still open after the delete");
  assert.equal((await s.events("/v1/events?follow=true").response).statusCode, 200, "the deleted thread's stream gave its place back, and the followers kept theirs");
});

test("an event cursor older than what the log retains is refused with 409", async (t) => {
  const s = await testApi(t);
  for (let i = 0; i < 10_002; i++) s.registry.appendEvent("release.changed", null, {});
  for (const path of ["/v1/events?since=1", "/v1/events?since=1&follow=true"]) {
    assert.deepEqual(await s.call("GET", path), { status: 409, body: { error: "event cursor expired; retained events cannot fill the gap" } });
  }
});

test("an event read that fails for any other reason answers 500, not the expired cursor's 409", async (t) => {
  const s = await testApi(t);
  s.registry.eventBatch = () => { throw new Error("database disk image is malformed"); };
  assert.deepEqual(await s.call("GET", "/v1/events?since=0"), { status: 500, body: { error: "database disk image is malformed" } });
});

test("event followers replay a disconnect gap with since and filter without losing order", async (t) => {
  const s = await testApi(t);
  const first = s.registry.appendEvent("release.changed", null, { state: "pending" });
  const stream = s.events("/v1/events?follow=true&kind=release.changed");
  assert.equal((await stream.next()).id, first.id);
  stream.close();
  const second = s.registry.appendEvent("release.changed", null, { state: "installing" });
  s.registry.appendEvent("thread.failed", null, {});
  const third = s.registry.appendEvent("release.changed", null, { state: "healthy" });
  const resumed = s.events(`/v1/events?follow=true&kind=release.changed&since=${first.id}`);
  t.after(() => resumed.close());
  assert.deepEqual([await resumed.next(), await resumed.next()].map((e) => e.id), [second.id, third.id]);
  const fourth = s.registry.appendEvent("release.changed", null, { state: "pending" });
  assert.equal((await resumed.next()).id, fourth.id);
  assert.equal((await s.call("GET", "/v1/events?since=-1")).status, 400);
  assert.equal((await s.call("GET", "/v1/events?kind=unknown")).status, 400);
});

test("a quiet filtered stream scans past unrelated events and survives retention rollover", async (t) => {
  const { follow } = await import("../cli/transport.ts");
  const s = await testApi(t);
  const stop = new AbortController();
  t.after(() => stop.abort());
  let cursor = "0";
  const endpoint = { url: new URL(`http://127.0.0.1:${s.port}`), socks: null };
  const reading = follow(endpoint, "/v1/events?follow=true&kind=session.turn-ended", () => assert.fail("no matching events yet"), stop.signal, (id) => { cursor = id; });
  for (let batch = 0; batch < 3; batch++) {
    let last = "0";
    for (let i = 0; i < 5000; i++) {
      last = s.registry.appendEvent("release.changed", null, {}).id;
      if (i % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    await until("the stream sent its scanned watermark", () => cursor === last);
  }
  stop.abort();
  await reading;
  const matching = s.registry.appendEvent("session.turn-ended", null, {});
  const resumed = s.events(`/v1/events?follow=true&kind=session.turn-ended&since=${cursor}`);
  t.after(() => resumed.close());
  assert.equal((await resumed.next()).id, matching.id);
});
