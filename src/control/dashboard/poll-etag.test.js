import { test } from "node:test";
import assert from "node:assert/strict";

const sent = [];
let answer = null;
/** Set to hold each read until the test answers it. */
let held = null;
Object.assign(globalThis, {
  location: { href: "http://nexus.test/", pathname: "/", search: "", reload: () => {} },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  EventSource: { OPEN: 1, CLOSED: 2 },
  fetch: async (url, init) => {
    sent.push({ url: String(url), ifNoneMatch: init.headers["if-none-match"] });
    if (held === null) return answer;
    const read = Promise.withResolvers();
    held.push(read.resolve);
    return read.promise;
  },
  DOMParser: class { parseFromString(text) { return { text }; } },
  document: {
    querySelector: (s) => s === "main" ? { dataset: { pollMs: "60000" } } : null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ dataset: {}, append() {}, replaceChildren() {}, setAttribute() {}, addEventListener() {} }),
    addEventListener: () => {},
  },
});
const { readPage } = await import("./page.js");
const page = (status, text, etag) => ({ ok: status < 400, status, headers: new Headers(etag ? { etag } : {}), text: async () => text });

test("a poll sends back the page's ETag, and a 304 gives the page it already read", async () => {
  answer = page(200, "<p>home</p>", 'W/"one"');
  assert.equal((await readPage(new URL("http://nexus.test/"))).text, "<p>home</p>");
  answer = page(304, "");
  assert.equal((await readPage(new URL("http://nexus.test/"))).text, "<p>home</p>", "a 304 is the page read before");
  answer = page(200, "<p>thread</p>", 'W/"two"');
  await readPage(new URL("http://nexus.test/threads/th-1"));
  assert.deepEqual(sent.map((s) => s.ifNoneMatch), [undefined, 'W/"one"', undefined], "only a read of the same address sends its ETag");
});

test("a 304 to a read that another read overtook is still the page its ETag named", async () => {
  answer = page(200, "<p>node a</p>", 'W/"a"');
  await readPage(new URL("http://nexus.test/nodes/a"));
  held = [];
  const b = readPage(new URL("http://nexus.test/nodes/b"));
  const a = readPage(new URL("http://nexus.test/nodes/a"));
  held[0](page(200, "<p>node b</p>", 'W/"b"'));
  assert.equal((await b).text, "<p>node b</p>");
  held[1](page(304, ""));
  assert.equal((await a).text, "<p>node a</p>");
  held = null;
});
