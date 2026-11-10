import { test } from "node:test";
import assert from "node:assert/strict";

/** A page as page.js reads one: its client script, its form fields, its dialogs and the refresh state line. */
const page = (client) => ({
  querySelector: (selector) => selector === "script[src]" ? { getAttribute: () => client } : null,
  querySelectorAll: () => [],
  getElementById: () => null,
});
const state = { textContent: "", children: [], replaceChildren(...children) { this.children = children; this.textContent = children.map((c) => typeof c === "string" ? c : c.textContent).join(""); } };
const fields = [];
let reloads = 0;
let served = "/assets/client.js?v=000000000000";
Object.assign(globalThis, {
  location: { href: "http://nexus.test/", pathname: "/", search: "", reload: () => { reloads++; } },
  localStorage: { getItem: () => null, setItem: () => {} },
  EventSource: { OPEN: 1, CLOSED: 2 },
  fetch: async () => ({ ok: true, status: 200, text: async () => served }),
  DOMParser: class { parseFromString(client) { return page(client); } },
  document: {
    querySelector: (selector) => selector === "main" ? { dataset: { pollMs: "60000" } } : page("/assets/client.js?v=000000000000").querySelector(selector),
    querySelectorAll: (selector) => selector === "textarea, input" ? fields : [],
    getElementById: (id) => id === "refresh-state" ? state : null,
    createElement: (tag) => ({ tagName: tag, append() {} }),
    addEventListener: () => {},
  },
});
const { refreshNow } = await import("./page.js");

test("a refresh that finds another client offers the reload, holds it over a draft, and reloads once nothing would be lost", async () => {
  await refreshNow();
  assert.equal(reloads, 0, "the same client does not reload");
  assert.equal(state.textContent, "");

  served = "/assets/client.js?v=111111111111";
  const draft = { value: "half a message", defaultValue: "" };
  fields.push(draft);
  await refreshNow();
  assert.equal(reloads, 0, "a draft holds the reload");
  assert.equal(state.textContent, "Dashboard updated — Reload");
  const [, button] = state.children;
  button.onclick();
  assert.equal(reloads, 1, "Reload reloads");

  draft.value = "";
  await refreshNow();
  assert.equal(reloads, 2, "the next refresh reloads by itself once the draft is gone");
});
