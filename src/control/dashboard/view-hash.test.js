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
  fire(type) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this }); }
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
const long = { ...file, path: "src/long.ts", additions: 5_000 };
const added = (name, n) => `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+row ${i}`).join("\n")}\n`;
const diffs = new Map([[path, added(path, 3)], [long.path, added(long.path, 5_000)]]);

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
  const press = (key) => { for (const listener of documentListeners.get("keydown") ?? []) listener({ key, target: ids.get("file-view"), preventDefault() {} }); };
  const fileView = ids.get("file-view");
  page = {
    tabs, ids, main, fileView, step, press,
    checkout: (await import("./checkout.js")).checkout,
    click: (key) => click(tabsBar.querySelector(`[data-tab="${key}"]`)),
    clickStep: () => click(timelineView.querySelector("[data-tab-go]")),
    view: () => main.dataset.view ?? "convo",
    /** Waits until the file view drew `name`'s diff, and says how many rows it drew. */
    drawn: async (name = path) => {
      const rows = () => fileView.dataset.path === name ? fileView.querySelector(".diff-view")?.shadowRoot.querySelectorAll("[data-line-index]").length : undefined;
      for (let i = 0; i < 2_000 && rows() === undefined; i++) await new Promise((resolve) => setImmediate(resolve));
      return rows() ?? 0;
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
  fetch: async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify({ base: { commit: null }, diff: diffs.get(new URL(url, "http://nexus.test/").searchParams.get("path")), truncated: false }) }),
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

  page.checkout.changes = { files: [file, { ...file, path: "src/c.ts" }], truncated: false, base: { commit: null } };
  travel(1);
  assert.equal(view(), "file", "Forward again shows the file");
  page.press("]");
  assert.deepEqual([page.tabs.activeTab, page.tabs.openTabs.map((f) => f.path)], ["src/c.ts", ["src/c.ts"]], "the step took the file's tab");
  travel(-1);
  assert.deepEqual([page.tabs.activeTab, page.tabs.openTabs.map((f) => f.path), location.hash], [path, [path], "#file=src/a%20b.ts"], "Back opens the file stepped from in that tab");
  travel(1);
  assert.equal(page.tabs.activeTab, "src/c.ts", "and Forward the file stepped to");
  assert.equal(entries.length, 4, "going through the history adds no entry");

  click("convo");
  clickStep();
  assert.equal(view(), "convo", "the link to a step waits for its hash");
  follow("#tl-review");
  assert.deepEqual([view(), step.scrolledTo, entries.length], ["timeline", 1, 6], "which shows the step in the timeline as one entry");
  travel(-1);
  assert.equal(view(), "convo");
});

test("after a reload, the open file's tab shows again where the reader left its diff", async () => {
  session.clear();
  const before = await load("");
  before.tabs.openFile(file);
  assert.ok(await before.drawn() > 0, "the diff drew");
  before.fileView.scrollTop = 640;
  const after = await load(location.hash);
  assert.equal(after.view(), "file");
  assert.equal(after.tabs.activeTab, path);
  assert.ok(await after.drawn() > 0, "the diff drew again");
  assert.equal(after.fileView.scrollTop, 640, "at the reader's place");

  after.tabs.openFile(long);
  const first = await after.drawn(long.path);
  after.fileView.querySelectorAll("button").find((b) => b.textContent === "Load more rows").fire("click");
  for (let i = 0; i < 2_000 && await after.drawn(long.path) === first; i++) await new Promise((resolve) => setImmediate(resolve));
  const loaded = await after.drawn(long.path);
  assert.ok(loaded > first, "Load more rows drew more of the long diff");
  after.fileView.scrollTop = 90_000;
  const again = await load(location.hash);
  assert.equal(await again.drawn(long.path), loaded, "a reload draws the rows the reader loaded");
  assert.equal(again.fileView.scrollTop, 90_000, "and goes back to the place among them");

  again.tabs.showTab(null);
  const fromConvo = await load("");
  fromConvo.tabs.showTab(path);
  assert.ok(await fromConvo.drawn() > 0);
  assert.equal(fromConvo.fileView.scrollTop, 0, "a reload from the conversation keeps no file's place");
});
