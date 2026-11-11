import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// xterm.js needs a browser, so the terminal tab loads one of these in place of term-view.js: a chunk a deploy took
// away, then a terminal that attaches, landing at the address it is given, and detaches.
const gone = `data:text/javascript,${encodeURIComponent('throw new TypeError("Failed to fetch dynamically imported module");')}`;
globalThis.attachedAt = [];
const attaching = `data:text/javascript,${encodeURIComponent(`export function openTerminal(host, thread, status, address) {
  globalThis.attachedAt.push(address);
  status({ over: false });
  let over = false;
  return { focus() {}, close() { if (!over) status({ over: over = true }); } };
}`)}`;
let termView = gone;
registerHooks({ resolve: (specifier, context, next) => specifier === "./term-view.js" ? { url: termView, shortCircuit: true } : next(specifier, context) });

class Element {}
/** Matches the selectors the click listeners ask a button for: a tag, a data attribute or both, as `button[data-action]`. */
function closest(selector) {
  return selector.split(",").some((part) => {
    const [, tag, attribute] = /^\s*(\w*)(?:\[data-([\w-]+)\])?\s*$/.exec(part) ?? [];
    if (tag === undefined) throw new SyntaxError(`'${part}' is not a selector this test reads`);
    return (tag === "" || tag === this.tagName) && (attribute === undefined || attribute.replace(/-(\w)/g, (_, c) => c.toUpperCase()) in this.dataset);
  }) ? this : null;
}
const node = (props = {}) => Object.assign(Object.create(Element.prototype), {
  textContent: "", children: [], dataset: {}, hidden: false, closest,
  append(...children) { this.children.push(...children); },
  replaceChildren(...children) { this.children = children; this.textContent = children.map((c) => typeof c === "string" ? c : c.textContent).join(""); },
  setAttribute() {}, addEventListener() {}, focus() {},
  ...props,
});
const state = node();
const ids = new Map([["refresh-state", state], ...["term-status", "term-again", "term-detach", "term-host", "term-view", "file-view", "scroll"].map((id) => [id, node()])]);
const running = "/assets/client.js?v=000000000000";
const page = (client) => ({ querySelector: (s) => s === "script[src]" ? { getAttribute: () => client } : null, querySelectorAll: () => [], getElementById: () => null });
let reloads = 0;
let served = running;
const clicks = [];
Object.assign(globalThis, {
  Element, HTMLDetailsElement: class {},
  ResizeObserver: class { observe() {} },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  location: { href: "http://nexus.test/", pathname: "/", search: "", reload: () => { reloads++; } },
  addEventListener: () => {},
  EventSource: { OPEN: 1, CLOSED: 2 },
  fetch: async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => served }),
  DOMParser: class { parseFromString(client) { return page(client); } },
  document: {
    documentElement: node(),
    body: node(),
    querySelector: (s) => s === "main" ? { dataset: { pollMs: "60000" } } : page(running).querySelector(s),
    querySelectorAll: () => [],
    getElementById: (id) => ids.get(id) ?? null,
    createElement: (tagName) => node({ tagName }),
    addEventListener: (type, listener) => { if (type === "click") clicks.push(listener); },
  },
});
const { chunk, refreshNow } = await import("./page.js");
const { showTerminal } = await import("./terminal-tab.js");
await import("./actions.js");

test("a chunk that does not load offers the reload, still fails for its caller, and does not reload by itself", async () => {
  await showTerminal();
  assert.match(ids.get("term-status").textContent, /^The terminal did not load: Failed to fetch dynamically imported module/);
  assert.equal(state.textContent, "Dashboard updated — Reload");
  const err = new TypeError("Failed to fetch dynamically imported module");
  await assert.rejects(chunk(Promise.reject(err)), (thrown) => thrown === err, "the caller gets the chunk's own error");
  await refreshNow();
  assert.equal(reloads, 0, "the same client does not reload");
  assert.equal(state.textContent, "Dashboard updated — Reload", "the notice stays");
});

test("an attached terminal holds the reload a new client asks for, until it detaches", async () => {
  termView = attaching;
  await showTerminal();
  assert.equal(ids.get("term-detach").hidden, false, "the terminal attached");
  served = "/assets/client.js?v=111111111111";
  await refreshNow();
  assert.equal(reloads, 0, "an attached terminal holds the reload");
  ids.get("term-detach").onclick();
  await refreshNow();
  assert.equal(reloads, 1, "the refresh after it detached reloads");
});

test("Show in terminal attaches once, in the session's terminal", async () => {
  const show = node({ tagName: "button", dataset: { action: "show-session", thread: "th-x", address: "t2" } });
  attachedAt.length = 0;
  for (const listener of clicks) void listener({ target: show });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attachedAt, ["t2"], "no attach to the worker's terminal comes first");
});
