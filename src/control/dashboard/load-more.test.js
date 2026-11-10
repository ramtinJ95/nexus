import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * An element with what file-view.js, review-notes.js and diff.js read and write of one: attributes, classes, a shadow
 * root, and the selectors they use, a class, an attribute, a tag, or a list of those.
 */
class Element {
  constructor(tagName) {
    Object.assign(this, { tagName, own: "", children: [], dataset: {}, hidden: false, listeners: new Map(), attributes: new Map(), className: "", style: {}, scrollTop: 0, parentElement: null });
  }
  get textContent() { return this.children.length > 0 ? this.children.map((c) => c.textContent ?? String(c)).join("") : this.own; }
  set textContent(text) { this.own = text; this.children = []; }
  get isConnected() { return true; }
  append(...children) { for (const c of children) { if (c instanceof Element) c.parentElement = this; this.children.push(c); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  replaceWith(next) { const at = this.parentElement.children.indexOf(this); this.parentElement.children[at] = next; next.parentElement = this.parentElement; }
  before() {}
  *all() { for (const child of this.children) if (child instanceof Element) { yield child; yield* child.all(); } }
  matches(selector) {
    return selector.split(",").some((one) => {
      const s = one.trim();
      if (s.startsWith(".")) return s.slice(1).split(".").every((c) => this.className.split(" ").includes(c));
      if (s.startsWith("[")) return this.attributes.has(s.slice(1, -1));
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
  focus() { focused = this; }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0 }; }
}
let focused = null;
const make = (tagName, props = {}) => Object.assign(new Element(tagName), props);
const thread = "th-0123456789ab";
const fileView = make("section", { hidden: true });
const ids = new Map([["pane-changes", make("section", { dataset: { thread } })], ["file-view", fileView], ["scroll", make("div")],
  ...["changes-head", "changes-turn", "changes-reload", "changes-base", "changes-body"].map((id) => [id, make("input")])]);
const facts = make("span", { dataset: { pylon: "running", turn: "false", agentAt: "0", threadStatus: "active", open: "true" } });
const rows = (name, n) => Array.from({ length: n }, (_, i) => `+${name} ${i}`).join("\n");
const diffs = new Map([
  ["long.txt", `diff --git a/long.txt b/long.txt\nnew file mode 100644\n--- /dev/null\n+++ b/long.txt\n@@ -0,0 +1,5000 @@\n${rows("row", 5_000)}\n`],
  ["short.txt", `diff --git a/short.txt b/short.txt\nnew file mode 100644\n--- /dev/null\n+++ b/short.txt\n@@ -0,0 +1,3 @@\n${rows("line", 3)}\n`],
]);
/** Each diff read waits here until the test lets it answer, so a test decides what is under way when. */
const pending = [];
Object.assign(globalThis, {
  Element,
  location: { href: "http://nexus.test/", pathname: "/", search: "" },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  ResizeObserver: class { observe() {} },
  MutationObserver: class { observe() {} },
  CSSStyleSheet: class { replaceSync() {} },
  getComputedStyle: () => ({ getPropertyValue: () => "pierre-light" }),
  EventSource: { OPEN: 1, CLOSED: 2 },
  fetch: (path) => {
    const url = new URL(path, "http://nexus.test/");
    const text = diffs.get(url.searchParams.get("path"));
    return new Promise((resolve) => pending.push(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ base: { commit: null }, diff: text, truncated: false }) })));
  },
  document: {
    get activeElement() { return focused; },
    documentElement: make("html"),
    querySelector: (s) => s === "main" ? make("main", { dataset: { pollMs: "60000" } }) : s === "#facts span" ? facts : null,
    querySelectorAll: () => [],
    getElementById: (id) => ids.get(id) ?? null,
    createElement: (tagName) => make(tagName),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener: () => {},
  },
});
const tabs = await import("./tab-bar.js");
await import("./file-view.js");

const file = (path) => ({ path, oldPath: null, status: "added", additions: 1, deletions: 0 });
/** Lets every diff read under way answer, and waits until the file view has drawn what they read. */
async function answer() {
  while (pending.length > 0) pending.shift()();
  for (let i = 0; i < 200 && (fileView.querySelector(".diff-view") === null || fileView.textContent.includes("Reading")); i++) await new Promise((resolve) => setImmediate(resolve));
}
const drawnRows = () => new Set(fileView.querySelector(".diff-view").shadowRoot.querySelectorAll("[data-line-index]").map((el) => el.getAttribute("data-line-index").split(",")[0])).size;
const loadMore = () => fileView.querySelectorAll("button").find((b) => b.textContent === "Load more rows");
/** Waits until the view drew `n` rows, or a step of the loop runs out. */
async function until(check) {
  for (let i = 0; i < 2_000 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  return check();
}

test("Load more rows draws the next stretch of the diff in the view, keeps the reader's place, and a load that ends after another file opened leaves that file alone", async () => {
  tabs.openFile(file("long.txt"));
  await answer();
  assert.equal(drawnRows(), 2_000);
  assert.match(fileView.textContent, /The first 2,000 of 5,000 rows show/);

  fileView.scrollTop = 1_234;
  loadMore().fire("click");
  assert.equal(await until(() => fileView.querySelector(".diff-view") !== null && drawnRows() === 4_000), true, "the second load draws 4,000 rows");
  assert.match(fileView.textContent, /The first 4,000 of 5,000 rows show/);
  assert.equal(await until(() => fileView.scrollTop === 1_234), true, "the reader stays where they were");

  loadMore().fire("click");
  assert.equal(await until(() => fileView.querySelector(".diff-view") !== null && drawnRows() === 5_000), true, "the third load draws the whole diff");
  assert.equal(loadMore(), undefined, "nothing is left to load");

  tabs.openFile(file("long.txt"));
  tabs.openFile(file("short.txt"));
  fileView.scrollTop = 0;
  await answer();
  assert.equal(fileView.dataset.path, "short.txt");
  assert.equal(drawnRows(), 3);

  tabs.showTab("long.txt");
  await answer();
  assert.equal(drawnRows(), 2_000, "another file's read starts the long one from its first rows again");
  loadMore().fire("click");
  tabs.showTab("short.txt");
  fileView.scrollTop = 7;
  focused = null;
  await answer();
  for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fileView.dataset.path, "short.txt");
  assert.equal(drawnRows(), 3, "the load under way when short.txt opened drew nothing over it");
  assert.equal(fileView.scrollTop, 7, "nor moved its scroll");
  assert.equal(focused, null, "nor took the keyboard");
});
