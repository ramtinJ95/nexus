import { test } from "node:test";
import assert from "node:assert/strict";

/** An element as page.js and review-notes.js write one: its text, its children and the handlers they set. */
const node = (props = {}) => ({
  textContent: "", children: [], dataset: {}, hidden: false,
  append(...children) { this.children.push(...children); },
  replaceChildren(...children) { this.children = children; this.textContent = children.map((c) => typeof c === "string" ? c : c.textContent).join(""); },
  setAttribute() {}, addEventListener() {}, focus() {},
  ...props,
});
const thread = "th-0123456789ab";
const note = { id: "note:1", kind: "comment", path: "a.ts", entry: 0, start: { side: "additions", line: 1 }, end: { side: "additions", line: 1 }, lines: { from: 1, to: 1, removed: false }, quote: ["x"], body: "rename this" };
const stored = new Map([[`nexus.review.${thread}`, JSON.stringify({ notes: [note], draft: null, composed: null })]]);
const listeners = new Map();
const state = node();
const ids = new Map([["refresh-state", state], ["pane-changes", node({ dataset: { thread } })]]);
const running = "/assets/client.js?v=000000000000";
const page = (client) => ({ querySelector: (s) => s === "script[src]" ? { getAttribute: () => client } : null, querySelectorAll: () => [], getElementById: () => null });
const fields = [{ type: "checkbox", value: "on", defaultValue: "" }];
let dialog = null;
let reloads = 0;
let served = running;
Object.assign(globalThis, {
  location: { href: "http://nexus.test/", pathname: "/", search: "", reload: () => { reloads++; } },
  localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
  addEventListener: (type, listener) => listeners.set(type, listener),
  EventSource: { OPEN: 1, CLOSED: 2 },
  fetch: async () => ({ ok: true, status: 200, text: async () => served }),
  DOMParser: class { parseFromString(client) { return page(client); } },
  document: {
    querySelector: (s) => s === "main" ? { dataset: { pollMs: "60000" } } : s === "dialog[open]" ? dialog : page(running).querySelector(s),
    querySelectorAll: (s) => s === "textarea, input" ? fields : [],
    getElementById: (id) => ids.get(id) ?? null,
    createElement: (tagName) => node({ tagName }),
    addEventListener: () => {},
  },
});
const { refreshNow } = await import("./page.js");
await import("./review-notes.js");

test("a refresh that finds another client holds the reload while unsent notes, a draft or a dialog would be lost, and reloads once nothing would", async () => {
  await refreshNow();
  assert.equal(reloads, 0, "the same client does not reload");
  assert.equal(state.textContent, "");

  served = "/assets/client.js?v=111111111111";
  await refreshNow();
  assert.equal(reloads, 0, "unsent notes hold the reload");
  assert.equal(state.textContent, "Dashboard updated — Reload");
  state.children[1].onclick();
  assert.equal(reloads, 1, "Reload reloads");
  // Another tab sent the notes, so this one's review is empty.
  listeners.get("storage")({ key: `nexus.review.${thread}`, newValue: JSON.stringify({ notes: [], draft: null, composed: null }) });
  await refreshNow();
  assert.equal(reloads, 2, "the refresh after the notes went reloads by itself, past the untouched checkbox");

  const draft = { type: "textarea", value: "half a message", defaultValue: "" };
  fields.push(draft);
  await refreshNow();
  assert.equal(reloads, 2, "a draft holds the reload");
  assert.equal(state.textContent, "Dashboard updated — Reload", "the notice stays while the reload is held");
  draft.value = "";
  await refreshNow();
  assert.equal(reloads, 3, "the refresh after the draft was cleared reloads");

  dialog = node({ tagName: "dialog" });
  await refreshNow();
  assert.equal(reloads, 3, "an open dialog holds the reload");
  dialog = null;
  await refreshNow();
  assert.equal(reloads, 4, "the refresh after the dialog closed reloads");
});
