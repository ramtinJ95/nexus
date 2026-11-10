import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReview, noteOn } from "./review.js";

/** An element as page.js, review-notes.js and composer.js write one, whose text is its children's once it has any. */
const node = (props = {}) => ({
  own: "", children: [], dataset: {}, hidden: false,
  get textContent() { return this.children.length > 0 ? this.children.map((c) => typeof c === "string" ? c : c.textContent).join("") : this.own; },
  set textContent(text) { this.own = text; this.children = []; },
  append(...children) { this.children.push(...children); },
  replaceChildren(...children) { this.children = children; },
  setAttribute() {}, addEventListener() {}, focus() {}, querySelector: () => null, querySelectorAll: () => [],
  ...props,
});
const thread = "th-0123456789ab";
const rows = [{ index: 0, type: "addition", old: null, new: 1, text: "a" }, { index: 1, type: "addition", old: null, new: 2, text: "b" }];
const notes = [
  noteOn({ id: "note:1", kind: "comment", path: "a.ts", entry: 0, rows, first: 0, last: 0, body: "rename this" }),
  noteOn({ id: "note:2", kind: "question", path: "b.ts", entry: 0, rows, first: 1, last: 1, body: "why here?" }),
];
const composed = formatReview(notes);
// The reader put both notes in the composer, then cut the second one's entry from it before the page reloaded.
const draft = composed.split("\n\n2. ")[0];
assert.ok(draft.includes("a.ts") && !draft.includes("b.ts"));
const stored = new Map([
  [`nexus.review.${thread}`, JSON.stringify({ notes, draft: null, composed: { text: composed, ids: notes.map((n) => n.id) } })],
  [`nexus.draft.${thread}`, draft],
]);
const prompt = node({ value: "", form: { dataset: { thread } } });
// An archived thread's page has no composer, and an unarchive swaps one in.
const ids = new Map([["pane-changes", node({ dataset: { thread } })]]);
const composer = Object.defineProperty(node({ id: "composer", contains: () => false }), "innerHTML", { set() { ids.set("prompt-text", prompt); } });
Object.assign(globalThis, {
  location: { href: "http://nexus.test/", pathname: "/", search: "" },
  localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
  addEventListener: () => {},
  EventSource: { OPEN: 1, CLOSED: 2 },
  document: {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id) => ids.get(id) ?? null,
    createElement: (tagName) => node({ tagName }),
    addEventListener: () => {},
  },
});
const { reviewBox } = await import("./review-notes.js");
await import("./composer.js");
const { swap } = await import("./page.js");

test("a page with no composer keeps the review as composed, and the composer an unarchive brings counts what its draft holds", () => {
  assert.equal(JSON.parse(stored.get(`nexus.review.${thread}`)).composed.ids.length, 2, "the kept review is as it was");
  swap([[composer, "<form id=prompt>…</form>"]]);
  assert.equal(prompt.value, draft, "the composer took its draft");
  assert.match(reviewBox.textContent, /^Review: 2 notes, 1 in the message box/);
  assert.deepEqual(JSON.parse(stored.get(`nexus.review.${thread}`)).composed.ids, ["note:1"], "the kept review says so too");
});
