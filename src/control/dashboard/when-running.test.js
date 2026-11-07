import { test } from "node:test";
import assert from "node:assert/strict";

/** The replies the fake fetch gives each path, in order, and the paths it was asked. */
const replies = new Map();
const asked = [];
const none = () => null;
Object.assign(globalThis, {
  location: { href: "http://nexus.test/threads/th-0123456789ab", pathname: "/threads/th-0123456789ab", search: "" },
  localStorage: { getItem: none, setItem: () => {} },
  addEventListener: () => {},
  fetch: async (path, { method }) => {
    asked.push(`${method} ${path}`);
    const [status, body] = replies.get(path).shift();
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  },
  document: { querySelector: none, getElementById: none, querySelectorAll: () => [], addEventListener: () => {} },
});
const { whenRunning } = await import("./page.js");
const { api } = await import("./request.js");

const thread = "th-0123456789ab";
const active = [200, { thread: { status: "active" }, pylon: { actualState: "paused" } }];
const send = () => api("POST", `/v1/threads/${thread}/messages`, {});

test("whenRunning sends again after a retryable refusal, and throws at once on one that is not", async () => {
  replies.set(`/v1/threads/${thread}`, [active, active]);
  replies.set(`/v1/threads/${thread}/messages`, [
    [409, { error: "pylon-x is stopped, not running", code: "not-running", retryable: true }],
    [200, { sent: true }],
    [409, { error: "Claude waits at a prompt", code: "blocked", retryable: false }],
  ]);
  const waited = [];
  assert.deepEqual(await whenRunning(thread, send, (err) => waited.push(err.code)), { sent: true });
  assert.deepEqual(waited, ["not-running"]);
  asked.length = 0;
  await assert.rejects(whenRunning(thread, send), { status: 409, code: "blocked", retryable: false });
  assert.deepEqual(asked, [`POST /v1/threads/${thread}/messages`], "a refusal that is not retryable is sent once");
});
