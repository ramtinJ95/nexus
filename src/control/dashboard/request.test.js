import { test } from "node:test";
import assert from "node:assert/strict";
import { refusalAt, requestOver } from "./request.js";
import { threadRoutes } from "../../contract/threads.ts";
import { apiIdleMs, pylonWaitMs } from "../../contract/route.ts";

/** An API whose request stalls until its signal aborts, as fetch does, and a timeout the test fires itself. */
function stalled() {
  const timers = [];
  const api = (method, path, body, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const timeout = (ms) => {
    const controller = new AbortController();
    timers.push({ ms, fire: () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")) });
    return controller.signal;
  };
  return { request: requestOver(api, timeout), timers };
}

test("an action whose request stalls fails once its route has been silent as long as the CLI allows, so its button is free again", async () => {
  const { request, timers } = stalled();
  const archive = request(threadRoutes.archive, { thread: "th-x" });
  const message = request(threadRoutes.message, { thread: "th-x", body: { text: "hi", requestId: "msg:1", mode: "followUp" } });
  assert.deepEqual(timers.map((t) => t.ms), [apiIdleMs, pylonWaitMs], "a route that waits on the pylon has its own limit");
  for (const t of timers) t.fire();
  await assert.rejects(archive, { message: "the control plane did not answer in 30 s", timedOut: true, retryable: false });
  await assert.rejects(message, { message: "the control plane did not answer in 120 s", timedOut: true });
});

test("a request given its own signal keeps it, and a refusal is the API's error as it was", async () => {
  const seen = [];
  const refusal = Object.assign(new Error("thread th-x is archived"), { status: 409 });
  const request = requestOver(async (method, path, body, signal) => {
    seen.push(signal);
    throw refusal;
  }, () => assert.fail("no timeout of its own"));
  const own = new AbortController().signal;
  await assert.rejects(request(threadRoutes.archive, { thread: "th-x" }, own), refusal);
  assert.deepEqual(seen, [own]);
});

test("a refused stream's reason is the error its plain request answers, and a stream it would take now has none", async () => {
  const cancelled = [];
  const replies = {
    "/threads/th-full/stream": new Response(JSON.stringify({ error: "16 streams are open, the most this control plane serves at once", code: null, retryable: false }), { status: 503 }),
    "/threads/th-gone/stream": new Response("not json", { status: 502 }),
    "/threads/th-free/stream": { ok: true, status: 200, body: { cancel: async () => cancelled.push("stream") } },
    "/v1/threads/th-free/attach": { ok: false, status: 426, body: { cancel: async () => cancelled.push("attach") } },
  };
  const globals = { fetch: async (url) => replies[url], AbortSignal };
  assert.equal(await refusalAt("/threads/th-full/stream", globals), "16 streams are open, the most this control plane serves at once");
  assert.equal(await refusalAt("/threads/th-gone/stream", globals), "the control plane answered 502");
  assert.equal(await refusalAt("/threads/th-free/stream", globals), null);
  assert.equal(await refusalAt("/v1/threads/th-free/attach", globals), null);
  assert.deepEqual(cancelled, ["stream", "attach"], "a stream it would take is let go at once");
});
