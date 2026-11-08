import { test } from "node:test";
import assert from "node:assert/strict";
import { callOf } from "./route.ts";
import { matchedParams, pathPattern } from "../util/route-path.ts";
import { threadRoutes } from "./threads.ts";
import { noContent, ok, on } from "../control/api/kit.ts";
import { anyAllowed } from "../control/api/access.ts";
import type { ThreadDetail } from "../control/wire.ts";

/** Each route's method and RegExp as thread-routes.ts declared them before the contract. seen and unseen shared one. */
const before = [
  ["GET", /^\/v1\/threads$/, ["list"]],
  ["POST", /^\/v1\/threads$/, ["start"]],
  ["GET", /^\/v1\/queued$/, ["queued"]],
  ["GET", /^\/v1\/queued\/([^/]+)$/, ["queuedThread"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/start$/, ["startQueued"]],
  ["GET", /^\/v1\/threads\/([^/]+)$/, ["show"]],
  ["DELETE", /^\/v1\/threads\/([^/]+)$/, ["delete"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/(seen|unseen)$/, ["seen", "unseen"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/archive$/, ["archive"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/unarchive$/, ["unarchive"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/activity$/, ["activity"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/messages$/, ["message"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/abort$/, ["abort"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/retry$/, ["retry"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/pylon\/retry$/, ["retryPylon"]],
  ["GET", /^\/v1\/threads\/([^/]+)\/conversation$/, ["conversation"]],
] as const satisfies readonly (readonly [string, RegExp, readonly (keyof typeof threadRoutes)[]])[];

const corpus = [
  "/v1/threads", "/v1/threads/", "/v1/threadsx", "/v1/queued", "/v1/queued/", "/v1/queued/th-1", "/v1/queued/th-1/x",
  "/v1/threads/th-1", "/v1/threads/th%2F1", "/v1/threads/th-1/", "/v1/threads//start", "/v1/threads/a/b",
  ...["start", "seen", "unseen", "archive", "unarchive", "activity", "messages", "abort", "retry", "pylon/retry", "conversation", "events", "attach", "seenx", "pylon"]
    .flatMap((tail) => [`/v1/threads/th-1/${tail}`, `/v1/threads/th-1/${tail}/`, `/v1/threads/th.1/${tail}`]),
  "/v1/threads/th-1/pylon/retry/x", "/v2/threads/th-1", "v1/threads",
];

test("each route's path template matches the paths its old RegExp did, with the same thread captured", () => {
  assert.deepEqual(before.flatMap(([, , names]) => names).sort(), Object.keys(threadRoutes).sort());
  for (const [method, old, names] of before) {
    for (const path of corpus) {
      const was = old.exec(path);
      const now = names.flatMap((name) => {
        const route = threadRoutes[name];
        assert.equal(route.method, method, name);
        const m = pathPattern(route.path).exec(path);
        return m === null ? [] : [{ name, params: matchedParams(route.path, m) }];
      });
      assert.equal(now.length, was === null ? 0 : 1, `${method} ${path}`);
      if (was === null) continue;
      if (was[1] !== undefined) assert.deepEqual(now[0]!.params, { thread: was[1] }, `${method} ${path}`);
      if (was[2] !== undefined) assert.equal(now[0]!.name, was[2], `${method} ${path}`);
    }
  }
});

test("a call's path encodes its thread, and its query decodes on the server to what the client gave", () => {
  assert.equal(callOf(threadRoutes.show, { thread: "th 1/x" }).path, "/v1/threads/th%201%2Fx");
  assert.deepEqual(callOf(threadRoutes.message, { thread: "th-1", body: { text: "hi", requestId: "msg:1" } }), { path: "/v1/threads/th-1/messages", body: { text: "hi", requestId: "msg:1" } });
  for (const query of [{}, { project: "nexus" }, { deleted: false as const }, { project: "a b&c=d", deleted: false as const }]) {
    const { path } = callOf(threadRoutes.list, { query });
    assert.deepEqual(threadRoutes.list.query!.decode(new URL(path, "http://nexus").searchParams), query, path);
  }
  assert.equal(callOf(threadRoutes.list, { query: { project: undefined } }).path, "/v1/threads");
  assert.equal(callOf(threadRoutes.queued, { query: { project: "nexus" } }).path, "/v1/queued?project=nexus");
  assert.deepEqual(threadRoutes.list.query!.decode(new URLSearchParams("deleted=true")), {});
});

test("a call of either of two routes takes what both take, and a handler answers its route's reply", () => {
  const pick = (show: boolean) => show ? threadRoutes.show : threadRoutes.start;
  const either = pick(true);
  // @ts-expect-error show needs a thread
  assert.throws(() => callOf(either, { body: { project: "nexus", title: "t" } }), /needs thread/);
  // @ts-expect-error show answers a thread's detail, not 204
  on(threadRoutes.show, anyAllowed, () => noContent);
  // @ts-expect-error show answers a thread's detail, which a 200 must carry
  on(threadRoutes.show, anyAllowed, () => ({ status: 200 }));
  on(threadRoutes.show, anyAllowed, () => ok({} as ThreadDetail));
  // @ts-expect-error abort answers 204
  on(threadRoutes.abort, { role: "person", action: "abort" }, () => ok({}));
});
