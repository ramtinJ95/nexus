import { test } from "node:test";
import assert from "node:assert/strict";
import { request, type Api } from "./kit.ts";
import { apiIdleMs, apiPingMs, pylonWaitMs } from "../contract/route.ts";
import { pylonRoutes } from "../contract/pylon.ts";
import { threadRoutes } from "../contract/threads.ts";

test("a call takes its route's idle timeout, and a route with none takes the transport's default", async () => {
  const asked: { path: string; idleMs: number | undefined }[] = [];
  const api: Api = async (_method, path, _body, idleMs) => {
    asked.push({ path, idleMs });
    return null;
  };
  await request(api, pylonRoutes.files, { thread: "th-1", query: { path: "" } });
  await request(api, pylonRoutes.changes, { thread: "th-1", query: { base: "start" } });
  await request(api, pylonRoutes.diff, { thread: "th-1", query: { base: "head" } });
  await request(api, pylonRoutes.openSession, { thread: "th-1", body: {} });
  await request(api, threadRoutes.message, { thread: "th-1", body: { text: "hi", requestId: "msg:1" } });
  await request(api, threadRoutes.show, { thread: "th-1" });
  assert.deepEqual(asked.map((a) => a.idleMs), [pylonWaitMs, pylonWaitMs, pylonWaitMs, pylonWaitMs, pylonWaitMs, undefined], JSON.stringify(asked));
});

test("the server pings a quiet stream or terminal before a client's idle timeout gives up on it", () => {
  assert.ok(apiPingMs < apiIdleMs);
  assert.ok(apiIdleMs < pylonWaitMs);
});
