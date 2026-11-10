import { test } from "node:test";
import assert from "node:assert/strict";
import { actions } from "./contract.ts";

const none = () => null;
const node = () => ({ append() {}, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} }, dataset: {}, style: {} });
Object.assign(globalThis, {
  location: { href: "http://nexus.test/", pathname: "/", search: "" },
  localStorage: { getItem: none, setItem() {} },
  sessionStorage: { getItem: none, setItem() {} },
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  MutationObserver: class { observe() {} },
  document: { documentElement: { dataset: {} }, querySelector: none, getElementById: none, querySelectorAll: () => [], addEventListener() {}, createElement: node },
});
const { handlers, publishOpening } = await import("./actions.js");
const { pylonRoutes } = await import("../../contract/pylon.ts");
const { threadRoutes } = await import("../../contract/threads.ts");

test("every action a page's button names runs, and the client runs no other", () => {
  assert.deepEqual(Object.keys(handlers).sort(), [...actions].sort());
});

/** A tab as window.open gives it, and the requests the handler makes, with the thread's ports answering `served` in turn. */
function publishing({ served = [], blocked = false, askTakesMs = 0 } = {}) {
  let clock = 0;
  const tab = { opener: "dashboard", location: { href: "about:blank" }, closed: false, close() { this.closed = true; } };
  const calls = [];
  let shown = 0;
  const request = async (route, args) => {
    calls.push(route === pylonRoutes.preview ? `publish ${args.body.port}` : route === threadRoutes.show ? "show" : "other");
    clock += askTakesMs;
    if (route === pylonRoutes.preview) return { url: "https://node.tail.ts.net:8444/", ready: false, failed: null };
    const preview = served[shown++] ?? { url: "https://node.tail.ts.net:8444/", ready: false, failed: "the service web failed" };
    return { ports: [{ port: 3000, service: "port-3000", preview }, { port: 5432, service: null, preview: null }] };
  };
  const waits = [];
  const publish = publishOpening({ request, refresh: async () => { calls.push("refresh"); }, open: () => { calls.push("open"); return blocked ? null : tab; }, wait: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock });
  return { publish: () => publish("th-1", { port: "3000" }), tab, calls, waits };
}

test("Publish publishes the port, opens a tab before it waits, and shows the preview there once the node serves it", async () => {
  const p = publishing({ served: [{ url: "https://node.tail.ts.net:8444/", ready: false, failed: null }, { url: "https://node.tail.ts.net:8444/", ready: true, failed: null }] });
  await p.publish();
  assert.equal(p.tab.opener, null, "the preview cannot reach the dashboard's window");
  assert.equal(p.tab.location.href, "https://node.tail.ts.net:8444/");
  assert.equal(p.tab.closed, false);
  assert.deepEqual(p.calls, ["open", "publish 3000", "refresh", "show", "show"], "the tab opens before the first request, while the click still lets it");
  assert.deepEqual(p.waits, [1000], "it asks again a second after a port that is not served yet");
});

test("a port never served closes its tab after the 120 s nexus preview --wait gives it, and says why", async () => {
  const p = publishing();
  await assert.rejects(p.publish(), { message: "Port 3000 was not served within 120 s, because the service web failed. Its preview opens from Previews once it is." });
  assert.equal(p.tab.closed, true);
  assert.equal(p.waits.reduce((sum, ms) => sum + ms, 0), 120_000);
});

test("a node slow to answer still ends the wait 120 s after it began, not after 120 asks", async () => {
  const p = publishing({ askTakesMs: 5_000 });
  await assert.rejects(p.publish(), /not served within 120 s/);
  assert.equal(p.tab.closed, true);
  assert.equal(p.calls.filter((c) => c === "show").length, 21, "an ask every 6 s, the 5 s it takes and the 1 s between, until 120 s have passed");
});

test("a browser that blocks the tab still gets the port published, and nothing waits", async () => {
  const p = publishing({ blocked: true });
  await p.publish();
  assert.deepEqual(p.calls, ["open", "publish 3000"]);
});
