import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Each load of the page imports the dashboard's modules afresh, as a reload does, over the same session storage,
// address and history.
const dashboard = new URL("./", import.meta.url).href;
let generation = 0;
registerHooks({
  resolve: (specifier, context, next) => {
    const resolved = next(specifier, context);
    return resolved.url.startsWith(dashboard) && !resolved.url.includes("?") ? { ...resolved, url: `${resolved.url}?page=${generation}` } : resolved;
  },
});

/** An element with what tab-bar.js, file-view.js and diff.js read and write of one. */
class Element {
  constructor(tagName) {
    Object.assign(this, { tagName, own: "", children: [], dataset: {}, hidden: false, listeners: new Map(), attributes: new Map(), className: "", style: {}, scrollTop: 0, parentElement: null, scrolledTo: 0 });
  }
  get localName() { return this.tagName; }
  get textContent() { return this.children.length > 0 ? this.children.map((c) => c.textContent ?? String(c)).join("") : this.own; }
  set textContent(text) { this.own = text; this.children = []; }
  get isConnected() { return true; }
  get classList() { return { toggle: (name, on) => { const names = new Set(this.className.split(" ").filter(Boolean)); if (on) names.add(name); else names.delete(name); this.className = [...names].join(" "); }, contains: (name) => this.className.split(" ").includes(name) }; }
  append(...children) { for (const c of children) { if (c instanceof Element) c.parentElement = this; this.children.push(c); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  replaceWith(next) { const at = this.parentElement.children.indexOf(this); this.parentElement.children[at] = next; next.parentElement = this.parentElement; }
  before() {}
  *all() { for (const child of this.children) if (child instanceof Element) { yield child; yield* child.all(); } }
  matches(selector) {
    return selector.split(",").some((one) => {
      const s = one.trim().replace(/^#tabs > /, "");
      if (s.startsWith(".")) return s.slice(1).split(".").every((c) => this.className.split(" ").includes(c));
      const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
      if (attr !== null) return this.attributes.has(attr[1]) && (attr[2] === undefined || this.attributes.get(attr[1]) === attr[2]);
      return this.tagName === s;
    });
  }
  querySelectorAll(selector) { return [...this.all()].filter((el) => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let el = this; el instanceof Element; el = el.parentElement) if (el.matches(selector)) return el; return null; }
  contains(other) { return other === this || [...this.all()].includes(other); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(value); }
  removeAttribute(name) { this.attributes.delete(name); }
  attachShadow() { const root = new Element("#shadow"); root.adoptedStyleSheets = []; this.shadowRoot = root; return root; }
  addEventListener(type, listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  focus() {}
  scrollIntoView() { this.scrolledTo++; }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0 }; }
}
const make = (tagName, attributes = {}, props = {}) => {
  const el = Object.assign(new Element(tagName), props);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  return el;
};
const thread = "th-0123456789ab";
const path = "src/a b.ts";
const file = { path, oldPath: null, status: "added", additions: 3, deletions: 0 };
const diff = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n`;

const session = new Map();
const windowListeners = new Map();
const fire = (type) => { for (const listener of windowListeners.get(type) ?? []) listener({}); };
const location = { href: "", pathname: `/threads/${thread}`, search: "", hash: "" };
/** The tab's history: each entry's hash, as pushState and replaceState write them and Back and Forward go between them. */
const entries = [""];
let at = 0;
const go = (url) => { location.hash = new URL(url, "http://nexus.test/").hash; };
const history = {
  pushState(state, title, url) { go(url); entries.splice(at + 1, Infinity, location.hash); at++; },
  replaceState(state, title, url) { go(url); entries[at] = location.hash; },
};
/** Goes `step` entries through the history. The views differ only in the hash, so the browser fires hashchange. */
function travel(step) {
  at += step;
  location.hash = entries[at];
  fire("hashchange");
}
/** What following a link to a hash on the page does: a new entry, then hashchange. */
function follow(hash) {
  entries.splice(at + 1, Infinity, hash);
  at++;
  location.hash = hash;
  fire("hashchange");
}

let page = null;
/** Loads the thread's page afresh at `hash`, as client.js does: the tabs drawn, then the view the hash names. */
async function load(hash) {
  if (page !== null) fire("pagehide");
  windowListeners.clear();
  generation++;
  location.hash = hash;
  entries.splice(0, Infinity, hash);
  at = 0;
  const tabsBar = make("div", { id: "tabs" });
  tabsBar.append(make("button", { "data-tab": "convo" }), make("button", { "data-tab": "timeline" }), make("button", { "data-tab": "term" }));
  const step = make("li", { id: "tl-review" });
  const timelineView = make("section", {}, { hidden: true });
  timelineView.append(step, make("a", { href: "#tl-review", "data-tab-go": "timeline" }));
  const ids = new Map([
    ["tabs", tabsBar], ["timeline-view", timelineView], ["tl-review", step], ["term-view", make("section", {}, { hidden: true })],
    ["file-view", make("section", {}, { hidden: true })], ["scroll", make("div")], ["pane-changes", make("section", { "data-thread": thread })],
    ...["changes-head", "changes-turn", "changes-reload", "changes-base", "changes-body"].map((id) => [id, make("input")]),
  ]);
  const main = make("main", { "data-poll-ms": "60000" });
  const facts = make("span", { "data-pylon": "running", "data-turn": "false", "data-agent-at": "0", "data-thread-status": "active", "data-open": "true" });
  const documentListeners = new Map();
  Object.assign(globalThis.document, {
    querySelector: (s) => s === "main" ? main : s === "#facts span" ? facts : null,
    getElementById: (id) => ids.get(id) ?? null,
    addEventListener: (type, listener) => documentListeners.set(type, [...documentListeners.get(type) ?? [], listener]),
  });
  const tabs = await import("./tab-bar.js");
  await import("./file-view.js");
  tabs.tabShows.terminal = async () => {};
  tabs.renderTabs();
  tabs.followHash();
  const click = (target) => { for (const listener of documentListeners.get("click") ?? []) listener({ target }); };
  const fileView = ids.get("file-view");
  page = {
    tabs, ids, main, fileView, step,
    click: (key) => click(tabsBar.querySelector(`[data-tab="${key}"]`)),
    clickStep: () => click(timelineView.querySelector("[data-tab-go]")),
    view: () => main.dataset.view ?? "convo",
    drawn: async () => {
      for (let i = 0; i < 2_000 && fileView.querySelector(".diff-view") === null; i++) await new Promise((resolve) => setImmediate(resolve));
      return fileView.querySelector(".diff-view") !== null;
    },
  };
  return page;
}

Object.assign(globalThis, {
  Element,
  HTMLDetailsElement: class {},
  location,
  history,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, value), removeItem: (key) => session.delete(key) },
  addEventListener: (type, listener) => windowListeners.set(type, [...windowListeners.get(type) ?? [], listener]),
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  ResizeObserver: class { observe() {} },
  MutationObserver: class { observe() {} },
  CSSStyleSheet: class { replaceSync() {} },
  getComputedStyle: () => ({ getPropertyValue: () => "pierre-light" }),
  EventSource: { OPEN: 1, CLOSED: 2 },
  fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ base: { commit: null }, diff, truncated: false }) }),
  document: {
    activeElement: null,
    documentElement: make("html"),
    querySelectorAll: () => [],
    createElement: (tagName) => make(tagName),
    createTextNode: (text) => ({ textContent: text }),
  },
});

test("each view's hash on load shows that view", async () => {
  session.set(`nexus.tabs.${thread}`, JSON.stringify([file]));
  for (const [hash, view] of [["", "convo"], ["#write", "convo"], ["#timeline", "timeline"], ["#terminal", "term"], ["#file=src/a%20b.ts", "file"]]) {
    const { ids, view: shown, tabs } = await load(hash);
    assert.equal(shown(), view, `${hash || "no hash"} shows the ${view}`);
    assert.equal(ids.get("timeline-view").hidden, view !== "timeline");
    assert.equal(ids.get("term-view").hidden, view !== "term");
    assert.equal(ids.get("file-view").hidden, view !== "file");
    assert.equal(ids.get("scroll").hidden, view !== "convo");
    assert.equal(tabs.activeTab === path, view === "file");
    assert.equal(location.hash, hash, "following the hash leaves it as it was");
  }
  const { view, step } = await load("#tl-review");
  assert.equal(view(), "timeline", "a step's hash shows the timeline");
  assert.equal(step.scrolledTo, 1, "and brings the step into view");

  const closed = await load("#file=src/gone.ts");
  assert.equal(closed.view(), "convo", "a file whose tab is closed shows the conversation");
  assert.equal(location.hash, "", "and the hash says so");
  assert.equal((await load("#main")).view(), "convo", "a hash that names no view, as the skip link's, changes nothing");
});

test("a tab change adds an entry to the history, and Back and Forward go between the views", async () => {
  session.set(`nexus.tabs.${thread}`, JSON.stringify([file]));
  const { click, clickStep, view, step } = await load("");
  click("timeline");
  assert.deepEqual([view(), location.hash, entries.length], ["timeline", "#timeline", 2]);
  click("timeline");
  assert.equal(entries.length, 2, "showing the view already shown adds no entry");
  page.tabs.showTab(path);
  assert.deepEqual([view(), location.hash, entries.length], ["file", "#file=src/a%20b.ts", 3]);

  travel(-1);
  assert.equal(view(), "timeline", "Back shows the timeline again");
  travel(-1);
  assert.equal(view(), "convo", "Back again shows the conversation");
  travel(1);
  assert.equal(view(), "timeline", "Forward shows the timeline");
  assert.equal(entries.length, 3, "going through the history adds no entry");

  click("convo");
  clickStep();
  assert.equal(view(), "convo", "the link to a step waits for its hash");
  follow("#tl-review");
  assert.deepEqual([view(), step.scrolledTo, entries.length], ["timeline", 1, 4], "which shows the step in the timeline as one entry");
  travel(-1);
  assert.equal(view(), "convo");
});

test("after a reload, the open file's tab shows again where the reader left its diff", async () => {
  session.clear();
  const before = await load("");
  before.tabs.openFile(file);
  assert.equal(await before.drawn(), true, "the diff drew");
  before.fileView.scrollTop = 640;
  const after = await load(location.hash);
  assert.equal(after.view(), "file");
  assert.equal(after.tabs.activeTab, path);
  assert.equal(await after.drawn(), true, "the diff drew again");
  assert.equal(after.fileView.scrollTop, 640, "at the reader's place");

  after.fileView.scrollTop = 0;
  after.tabs.showTab(null);
  const fromConvo = await load("");
  fromConvo.tabs.showTab(path);
  assert.equal(await fromConvo.drawn(), true);
  assert.equal(fromConvo.fileView.scrollTop, 0, "a reload from the conversation keeps no file's place");
});
