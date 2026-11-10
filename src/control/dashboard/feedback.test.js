import { test } from "node:test";
import assert from "node:assert/strict";

/** An element as the page's scripts use it: its children, text, attributes and events. */
class FakeElement {
  constructor(tag = "div", props = {}) {
    Object.assign(this, { tag, children: [], dataset: {}, hidden: false, disabled: false, isConnected: true, textContent: "" }, props);
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  closest(selector) { return this.selectors?.includes(selector) ? this : null; }
  matches(selector) { return this.selectors?.includes(selector) ?? false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  setAttribute() {}
  get classList() { return { add() {}, remove() {}, toggle() {} }; }
  get style() { return {}; }
  get text() { return [this.textContent, ...this.children.map((c) => typeof c === "string" ? c : c.text)].filter((t) => t !== "").join(" "); }
}

const listeners = {};
const regions = new Map();
const region = (id, props = {}) => {
  const el = new FakeElement("div", props);
  regions.set(id, el);
  return el;
};
let fetchImpl = async () => { throw new Error("offline"); };
const fetched = [];
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static opened = [];
  constructor(url) {
    Object.assign(this, { url, readyState: FakeEventSource.CONNECTING, heard: {} });
    FakeEventSource.opened.push(this);
  }
  addEventListener(type, listener) { (this.heard[type] ??= []).push(listener); }
  fire(type) { for (const listener of this.heard[type] ?? []) listener(new Event(type)); }
}
const none = () => null;
Object.assign(globalThis, {
  Element: FakeElement,
  HTMLDetailsElement: class {},
  HTMLAnchorElement: class {},
  EventSource: FakeEventSource,
  location: { href: "http://nexus.test/threads/th-x", pathname: "/threads/th-x", search: "" },
  localStorage: { getItem: none, setItem() {} },
  sessionStorage: { getItem: none, setItem() {} },
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  MutationObserver: class { observe() {} },
  confirm: () => true,
  fetch: (url, init) => {
    fetched.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return fetchImpl(String(url), init);
  },
  document: {
    body: { dataset: {} },
    visibilityState: "visible",
    querySelector: (selector) => selector === "main" ? { dataset: { pollMs: "5000" } } : null,
    getElementById: (id) => regions.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
    createElement: (tag) => new FakeElement(tag),
  },
});
const alert = region("action-error", { hidden: true });
const refreshState = region("refresh-state");
await import("./actions.js");
await import("./composer.js");
const { follow } = await import("./page.js");

const dispatch = async (type, event) => {
  for (const listener of listeners[type] ?? []) await listener({ defaultPrevented: false, preventDefault() {}, ...event });
};
const json = (status, body) => new Response(body === undefined ? "" : JSON.stringify(body), { status });
const buttonsOf = (el) => el.children.filter((c) => c.tag === "button");

test("a button whose action changes no region takes another press once the action settles", async () => {
  fetchImpl = async (url) => url.startsWith("/v1/") ? json(204) : Promise.reject(new Error("offline"));
  const button = new FakeElement("button", { selectors: ["button[data-action]"], dataset: { action: "close-session", thread: "th-x", session: "w2:p1" } });
  await dispatch("click", { target: button });
  assert.equal(fetched.at(-1)?.url, "/v1/threads/th-x/sessions/w2%3Ap1");
  assert.equal(button.disabled, false, "the action settled and the button is still in the page");
  const gone = new FakeElement("button", { selectors: ["button[data-action]"], isConnected: false, dataset: { action: "close-session", thread: "th-x", session: "w2:p1" } });
  await dispatch("click", { target: gone });
  assert.equal(gone.disabled, true, "a button a swap replaced is left as it was");
});

test("an action that fails says why in the page's alert, which Dismiss clears", async () => {
  fetchImpl = async () => json(409, { error: "thread th-x is archived", code: null, retryable: false });
  const button = new FakeElement("button", { selectors: ["button[data-action]"], dataset: { action: "unpublish", thread: "th-x", port: "3000" } });
  await dispatch("click", { target: button });
  assert.equal(alert.hidden, false);
  assert.equal(alert.text, "thread th-x is archived Dismiss");
  assert.equal(button.disabled, false);
  buttonsOf(alert).at(-1).onclick();
  assert.equal(alert.hidden, true);
  assert.deepEqual(alert.children, []);
});

test("an action whose request timed out says it may not have happened, and its button takes another press", async () => {
  fetchImpl = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
  const button = new FakeElement("button", { selectors: ["button[data-action]"], dataset: { action: "archive", thread: "th-x" } });
  await dispatch("click", { target: button });
  assert.equal(alert.text, "This may not have happened: the control plane did not answer in 30 s. Press it again to try again. Dismiss");
  assert.equal(button.disabled, false);
});

test("a message whose send timed out offers Try again, which sends it under the same request ID", async () => {
  const send = new FakeElement("button", { value: "followUp" });
  const form = new FakeElement("form", { selectors: ["#prompt"], dataset: { thread: "th-x" }, elements: { text: { value: "ship it" } } });
  form.querySelectorAll = () => [send];
  form.querySelector = (selector) => selector === 'button[type=submit][value="followUp"]' ? send : null;
  form.requestSubmit = (submitter) => dispatch("submit", { target: form, submitter });
  regions.set("prompt", form);
  fetchImpl = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
  await dispatch("submit", { target: form, submitter: send });
  assert.equal(alert.text, "The message may not have been sent: the control plane did not answer in 120 s. Try again Dismiss");
  const first = fetched.at(-1).body.requestId;
  fetchImpl = async (url) => url.startsWith("/v1/") ? json(200, { requestId: first }) : Promise.reject(new Error("offline"));
  await buttonsOf(alert)[0].onclick();
  assert.deepEqual(fetched.filter((f) => f.url === "/v1/threads/th-x/messages").map((f) => f.body.requestId), [first, first]);
  assert.equal(alert.hidden, true, "the sent message clears the alert");
  regions.delete("prompt");
});

test("a refused stream says why the page polls instead, until a stream opens", async () => {
  const said = Promise.withResolvers();
  let text = "";
  Object.defineProperty(refreshState, "textContent", { get: () => text, set: (value) => {
    text = value;
    if (value.startsWith("Live")) said.resolve();
  }, configurable: true });
  fetchImpl = async (url) => url === "/threads/th-x/stream"
    ? json(503, { error: "16 streams are open, the most this control plane serves at once", code: null, retryable: false })
    : Promise.reject(new Error("offline"));
  follow("/threads/th-x/stream");
  const refused = FakeEventSource.opened.at(-1);
  refused.readyState = FakeEventSource.CLOSED;
  refused.fire("error");
  await Promise.race([said.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("the page never said why")), 60_000).unref())]);
  assert.equal(text, "Live updates are off, so this page updates every 5 s: 16 streams are open, the most this control plane serves at once.");
  follow("/threads/th-x/stream");
  const next = FakeEventSource.opened.at(-1);
  assert.notEqual(next, refused, "the next poll opens another");
  next.readyState = FakeEventSource.OPEN;
  next.fire("open");
  assert.equal(text, "");
});
