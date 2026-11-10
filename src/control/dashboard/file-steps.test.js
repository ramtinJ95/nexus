import { test } from "node:test";
import assert from "node:assert/strict";

/** An element as page.js, tab-bar.js, changes-tree.js and file-view.js write one, with the handlers they set. */
class Element {
  constructor(tagName) {
    Object.assign(this, { tagName, own: "", children: [], dataset: {}, hidden: false, listeners: new Map(), className: "" });
  }
  get textContent() { return this.children.length > 0 ? this.children.map((c) => typeof c === "string" ? c : c.textContent).join("") : this.own; }
  set textContent(text) { this.own = text; this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  *all() { for (const child of this.children) if (child instanceof Element) { yield child; yield* child.all(); } }
  setAttribute() {}
  addEventListener(type, listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  fire(type) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this }); }
  focus() {}
  scrollIntoView() {}
  closest(selector) { return selector.includes(this.tagName) ? this : null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
const make = (tagName, props = {}) => Object.assign(new Element(tagName), props);
const thread = "th-0123456789ab";
const ids = new Map([
  ["pane-changes", make("section", { dataset: { thread } })],
  ["file-view", make("section", { hidden: true })],
  ["scroll", make("div")],
  ["changes-body", make("div")],
  ["changes-base", make("span")],
  ["changes-head", make("input")],
  ["changes-turn", make("input")],
  ["changes-reload", make("button")],
  ["icons", { content: { querySelector: () => ({ cloneNode: () => make("svg") }) } }],
]);
const facts = make("span", { dataset: { pylon: "paused", turn: "false", agentAt: "0", threadStatus: "active", open: "true" } });
const stored = new Map();
const documentListeners = new Map();
Object.assign(globalThis, {
  Element,
  location: { href: "http://nexus.test/", pathname: "/", search: "" },
  localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  ResizeObserver: class { observe() {} },
  MutationObserver: class { observe() {} },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  EventSource: { OPEN: 1, CLOSED: 2 },
  document: {
    querySelector: (s) => s === "main" ? make("main", { dataset: { pollMs: "60000" } }) : s === "#facts span" ? facts : null,
    querySelectorAll: () => [],
    getElementById: (id) => ids.get(id) ?? null,
    createElement: (tagName) => make(tagName),
    addEventListener: (type, listener) => documentListeners.set(type, [...documentListeners.get(type) ?? [], listener]),
  },
});
const { checkout } = await import("./checkout.js");
const tabs = await import("./tab-bar.js");
await import("./file-view.js");

const file = (path, additions) => ({ path, oldPath: null, status: "modified", additions, deletions: 1 });
// The pylon lists them in its own order, and the tree draws folders before files.
checkout.changes = { files: [file("README.md", 1), file("src/b.ts", 2), file("src/a.ts", 3)], truncated: false, base: { commit: "0123456789abcdef" } };
const fileView = ids.get("file-view");
const head = () => fileView.children[0];
const press = (key, target = fileView) => {
  let prevented = false;
  for (const listener of documentListeners.get("keydown") ?? []) listener({ key, target, preventDefault: () => { prevented = true; } });
  return prevented;
};
const viewedBox = () => [...head().all()].find((el) => el.tagName === "input");
const treeFiles = () => [...ids.get("changes-body").all()].filter((el) => el.className.startsWith("tree-file"));

test("[ and ] step through the changed files in the tree's order, in one tab, and say where the reader is", () => {
  assert.equal(tabs.activeTab, null);
  tabs.openFile(checkout.changes.files[2]);
  assert.equal(tabs.activeTab, "src/a.ts");
  assert.match(head().textContent, /1 of 3/);

  assert.equal(press("]"), true);
  assert.equal(tabs.activeTab, "src/b.ts");
  assert.match(head().textContent, /2 of 3/);
  press("]");
  assert.equal(tabs.activeTab, "README.md");
  assert.match(head().textContent, /3 of 3/);
  press("]");
  assert.equal(tabs.activeTab, "README.md", "the last file has no next");
  press("[");
  assert.equal(tabs.activeTab, "src/b.ts");
  assert.deepEqual(tabs.openTabs.map((f) => f.path), ["src/b.ts"], "each step took the tab of the file it left");

  const note = make("textarea");
  assert.equal(press("]", note), false, "a key typed into a note is the note's");
  assert.equal(tabs.activeTab, "src/b.ts");
});

test("a file marked viewed shows so in the tree and its header until it changes again", () => {
  assert.equal(viewedBox().checked, false);
  viewedBox().checked = true;
  viewedBox().fire("change");
  assert.deepEqual(treeFiles().map((el) => [el.dataset.path, el.className.includes("viewed")]), [["src/a.ts", false], ["src/b.ts", true], ["README.md", false]]);
  press("[");
  press("]");
  assert.equal(viewedBox().checked, true, "the header shows the mark again on return");

  checkout.changes = { ...checkout.changes, files: checkout.changes.files.map((f) => f.path === "src/b.ts" ? { ...f, additions: 9 } : f) };
  press("[");
  press("]");
  assert.equal(viewedBox().checked, false, "the agent changed the file since");
});
