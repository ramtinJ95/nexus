/** Replies travel compressed in the coding the client accepts, a page answers a matching ETag with 304, and streams go as they are. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { assetUrl, entry } from "./dashboard/assets.ts";
import { negotiate } from "./api/encoding.ts";
import { testApi, withThread } from "../test-support/api-kit.ts";

const decoders: Record<string, (body: Buffer) => Buffer> = { br: brotliDecompressSync, gzip: gunzipSync };
const decoded = ({ headers, body }: { headers: import("node:http").IncomingHttpHeaders; body: Buffer }) =>
  headers["content-encoding"] === undefined ? body : decoders[headers["content-encoding"]]!(body);

test("a page, the API's JSON and an asset are sent in the coding the client prefers, and are the same once decoded", async (t) => {
  const s = await withThread(t);
  for (const title of ["Tune the cache", "Ship the phone layout"]) assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title })).status, 201);
  for (const path of ["/", `/threads/${s.thread.id}`, "/v1/threads", assetUrl(entry)]) {
    const plain = await s.raw(path);
    assert.equal(plain.status, 200, path);
    assert.equal(plain.headers["content-encoding"], undefined, `${path} without accept-encoding goes as it is`);
    assert.equal(plain.headers.vary, "accept-encoding", path);
    assert.ok(plain.body.length > 1024, `${path} is large enough to compress: ${plain.body.length} bytes`);
    for (const [accepts, coding] of [["gzip, deflate, br", "br"], ["br;q=0, gzip", "gzip"], ["gzip;q=0.5, br;q=0.9", "br"], ["identity", undefined]] as const) {
      const sent = await s.raw(path, { "accept-encoding": accepts });
      assert.equal(sent.headers["content-encoding"], coding, `${path} with accept-encoding ${accepts}`);
      assert.equal(sent.headers.vary, "accept-encoding", path);
      assert.equal(Number(sent.headers["content-length"]), sent.body.length, `${path} says its sent length`);
      if (coding !== undefined) assert.ok(sent.body.length < plain.body.length, `${path} in ${coding} is smaller`);
      assert.deepEqual(decoded(sent), plain.body, `${path} in ${coding ?? "identity"} decodes to the body`);
    }
  }
});

test("a body under 1 KiB goes as it is", async (t) => {
  const s = await testApi(t);
  const sent = await s.raw("/v1/threads", { "accept-encoding": "br, gzip" });
  assert.ok(sent.body.length < 1024, `${sent.body.length} bytes`);
  assert.equal(sent.headers["content-encoding"], undefined);
  assert.equal(sent.headers.vary, "accept-encoding", "a larger list would be compressed");
});

test("a page whose ETag the client sends back is a 304 with no body, and one whose page changed is the page", async (t) => {
  const s = await testApi(t);
  const first = await s.raw("/", { "accept-encoding": "br" });
  const etag = first.headers.etag!;
  assert.match(etag, /^W\/"[\w-]+"$/);
  assert.equal((await s.raw("/", { "accept-encoding": "gzip" })).headers.etag, etag, "the ETag names the page in any coding");
  const unchanged = await s.raw("/", { "if-none-match": etag, "accept-encoding": "br" });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
  assert.equal(unchanged.headers.etag, etag);
  assert.equal(unchanged.headers.vary, "accept-encoding");
  assert.equal((await s.raw("/", { "if-none-match": 'W/"another"' })).status, 200, "another page's ETag gets the page");
  const json = await s.raw("/v1/threads", { "if-none-match": "*" });
  assert.equal(json.status, 200, "the API's JSON carries no ETag");
  assert.equal(json.headers.etag, undefined);
});

test("an event stream is never compressed, whatever the client accepts", async (t) => {
  const s = await withThread(t);
  const stream = s.events(`/v1/threads/${s.thread.id}/events`, { "accept-encoding": "br, gzip" });
  t.after(() => stream.close());
  const res = await stream.response;
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.equal(res.headers["content-encoding"], undefined);
  assert.ok("entries" in (await stream.next()), "the first event reads as it was sent");
});

test("accept-encoding is read by its weights, and a coding it refuses or does not name is never chosen", () => {
  assert.equal(negotiate(undefined), null);
  assert.equal(negotiate(""), null);
  assert.equal(negotiate("deflate"), null);
  assert.equal(negotiate("*"), "br");
  assert.equal(negotiate("*;q=0.1, br;q=0"), "gzip");
  assert.equal(negotiate("GZIP"), "gzip");
  assert.equal(negotiate("br;q=0, gzip;q=0"), null);
  assert.equal(negotiate("gzip;q=1, br;q=0.4"), "gzip");
});
