import { test } from "node:test";
import assert from "node:assert/strict";
import { callOf } from "./route.ts";
import { matchedParams, pathPattern } from "../util/route-path.ts";
import { changesBases, changeStatuses, pylonRoutes, statusLetters, type ImageSource } from "./pylon.ts";
import { streamRoutes } from "./streams.ts";
import { imageSourceSchema } from "./pylon-parse.ts";

/** Each route's method and RegExp as pylon-routes.ts and stream-routes.ts declared them before the contract. */
const before = [
  ["POST", /^\/v1\/threads\/([^/]+)\/previews$/, pylonRoutes.preview, ["thread"]],
  ["DELETE", /^\/v1\/threads\/([^/]+)\/previews\/([^/]+)$/, pylonRoutes.unpreview, ["thread", "port"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/sessions$/, pylonRoutes.openSession, ["thread"]],
  ["DELETE", /^\/v1\/threads\/([^/]+)\/sessions\/([^/]+)$/, pylonRoutes.closeSession, ["thread", "session"]],
  ["POST", /^\/v1\/threads\/([^/]+)\/sessions\/([^/]+)\/focus$/, pylonRoutes.focusSession, ["thread", "session"]],
  ["GET", /^\/v1\/threads\/([^/]+)\/files$/, pylonRoutes.files, ["thread"]],
  ["GET", /^\/v1\/threads\/([^/]+)\/files\/content$/, pylonRoutes.file, ["thread"]],
  ["GET", /^\/v1\/threads\/([^/]+)\/image$/, pylonRoutes.image, ["thread"]],
  ["GET", /^\/v1\/threads\/([^/]+)\/changes$/, pylonRoutes.changes, ["thread"]],
  ["GET", /^\/v1\/threads\/([^/]+)\/diff$/, pylonRoutes.diff, ["thread"]],
  ["GET", /^\/v1\/events$/, streamRoutes.events, []],
  ["GET", /^\/v1\/threads\/([^/]+)\/events$/, streamRoutes.threadEvents, ["thread"]],
  ["GET", /^\/v1\/threads\/([^/]+)\/claude\/events$/, streamRoutes.claudeEvents, ["thread"]],
] as const;

const tails = ["previews", "previews/3000", "previews/", "previews/3000/x", "sessions", "sessions/w1:p1", "sessions/w1%3Ap1/focus", "sessions//focus",
  "sessions/w1:p1/focus/x", "files", "files/", "files/content", "files/content/x", "image", "images", "changes", "diff", "diff/x", "events", "claude/events", "claude", "claude/events/x"];
const corpus = ["/v1/events", "/v1/events/", "/v1/eventsx", "/v1/threads/events", "/v1/threads", "/v1/threads/th-1",
  ...tails.flatMap((tail) => [`/v1/threads/th-1/${tail}`, `/v1/threads/th%2F1/${tail}`, `/v1/threads//${tail}`, `/v2/threads/th-1/${tail}`])];

test("each pylon and stream route's path template matches the paths its old RegExp did, with the same parameters captured", () => {
  assert.equal(new Set(before.map(([, , route]) => route)).size, Object.keys(pylonRoutes).length + Object.keys(streamRoutes).length);
  for (const [method, old, route, names] of before) {
    assert.equal(route.method, method, route.path);
    for (const path of corpus) {
      const was = old.exec(path);
      const now = pathPattern(route.path).exec(path);
      assert.equal(now === null, was === null, `${route.path} ${path}`);
      if (was === null || now === null) continue;
      assert.deepEqual(matchedParams(route.path, now), Object.fromEntries(names.map((name, i) => [name, was[i + 1]])), `${route.path} ${path}`);
    }
  }
});

test("an image link keeps its source's field order, and the server parses it back to the same source", () => {
  const sha256 = "a".repeat(64);
  const sources: ImageSource[] = [
    { source: "transcript", offset: 10, bytes: 20, sha256, index: 0 },
    { source: "harness", entry: 3, message: 1, part: 2, sha256 },
    { source: "file", path: "shots/a b&c.png", base: "turn" },
    { source: "file", path: "shots/a.png" },
  ];
  assert.equal(callOf(pylonRoutes.image, { thread: "th-1", query: sources[0]! }).path, `/v1/threads/th-1/image?source=transcript&offset=10&bytes=20&sha256=${sha256}&index=0`);
  assert.equal(callOf(pylonRoutes.image, { thread: "th-1", query: sources[2]! }).path, "/v1/threads/th-1/image?source=file&path=shots%2Fa+b%26c.png&base=turn");
  for (const source of sources) {
    const { path } = callOf(pylonRoutes.image, { thread: "th-1", query: source });
    assert.deepEqual(imageSourceSchema.parse(pylonRoutes.image.query!.decode(new URL(path, "http://nexus").searchParams)), source, path);
  }
});

test("a checkout read's query decodes on the server to what the client gave", () => {
  const decoded = (path: string, route: { query?: { decode(p: URLSearchParams): unknown } }) => route.query!.decode(new URL(path, "http://nexus").searchParams);
  assert.equal(callOf(pylonRoutes.files, { thread: "th-1", query: { path: "" } }).path, "/v1/threads/th-1/files?path=");
  assert.deepEqual(decoded(callOf(pylonRoutes.files, { thread: "th-1", query: { path: "a b/c" } }).path, pylonRoutes.files), { path: "a b/c" });
  assert.equal(callOf(pylonRoutes.changes, { thread: "th-1", query: { base: "head" } }).path, "/v1/threads/th-1/changes?base=head");
  assert.deepEqual(decoded("/v1/threads/th-1/changes", pylonRoutes.changes), { base: undefined });
  const diff = callOf(pylonRoutes.diff, { thread: "th-1", query: { base: "start", paths: ["new.txt", "old name.txt"] } }).path;
  assert.equal(diff, "/v1/threads/th-1/diff?base=start&path=new.txt&path=old+name.txt");
  assert.deepEqual(decoded(diff, pylonRoutes.diff), { base: "start", paths: ["new.txt", "old name.txt"] });
  assert.equal(callOf(pylonRoutes.unpreview, { thread: "th-1", port: "3000" }).path, "/v1/threads/th-1/previews/3000");
  assert.equal(callOf(pylonRoutes.focusSession, { thread: "th-1", session: "w1:p1" }).path, "/v1/threads/th-1/sessions/w1%3Ap1/focus");
});

test("the events query decodes on the server to what the client gave", () => {
  const path = callOf(streamRoutes.events, { query: { since: "latest", thread: "th-1", project: "nexus", kinds: ["a.b", "c.d"], follow: true } }).path;
  assert.equal(path, "/v1/events?since=latest&thread=th-1&project=nexus&kind=a.b&kind=c.d&follow=true");
  assert.deepEqual(streamRoutes.events.query!.decode(new URL(path, "http://nexus").searchParams), { since: "latest", thread: "th-1", project: "nexus", kinds: ["a.b", "c.d"], follow: true });
  assert.equal(callOf(streamRoutes.events, { query: {} }).path, "/v1/events");
  assert.deepEqual(streamRoutes.events.query!.decode(new URLSearchParams("follow=1")), { since: undefined, thread: undefined, project: undefined, kinds: [], follow: false });
});

test("every change status has a letter, and the bases are the three the checkout reads", () => {
  assert.deepEqual(Object.keys(statusLetters), [...changeStatuses]);
  assert.deepEqual([...changesBases], ["start", "head", "turn"]);
});
