import { test } from "node:test";
import assert from "node:assert/strict";
import { shown, themeStore, toggled } from "./theme.js";

test("System shows the device's light or dark, and any other choice shows itself", () => {
  assert.equal(shown("system", true), "dark");
  assert.equal(shown("system", false), "light");
  assert.equal(shown("kanagawa-wave", false), "kanagawa-wave");
  assert.equal(shown("light", true), "light");
});

test("the toggle goes from a named dark theme to light and back to it, and to plain dark before any was picked", () => {
  assert.equal(toggled("dark", "tokyo-night"), "light");
  assert.equal(toggled("light", "tokyo-night"), "tokyo-night");
  assert.equal(toggled("light", null), "dark");
});

/** A browser's storage as a page sees it, which may refuse its reads or its writes. */
function storage({ reads = true, writes = true } = {}) {
  const items = new Map();
  const refused = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
  return {
    items,
    getItem: (name) => reads ? items.get(name) ?? null : refused(),
    setItem: (name, value) => writes ? void items.set(name, String(value)) : refused(),
    removeItem: (name) => writes ? void items.delete(name) : refused(),
  };
}

test("a choice and the last dark theme are stored, and read back by the next page", () => {
  const kept = storage();
  const store = themeStore(kept);
  assert.equal(store.choice, "system");
  store.pick("tokyo-night");
  store.pickDark("tokyo-night");
  store.pick("light");
  const next = themeStore(kept);
  assert.deepEqual([next.choice, next.lastDark], ["light", "tokyo-night"]);
  next.pick("system");
  assert.equal(themeStore(kept).choice, "system");
});

test("storage that refuses reads or writes keeps the choice and the last dark theme for the page", () => {
  for (const [what, kept] of [["reads", storage({ reads: false })], ["writes", storage({ writes: false })], ["none at all", null]]) {
    const store = themeStore(kept);
    assert.equal(store.choice, "system", what);
    store.pick("kanagawa-wave");
    store.pickDark("kanagawa-wave");
    store.pick("light");
    assert.deepEqual([store.choice, store.lastDark], ["light", "kanagawa-wave"], what);
    assert.equal(toggled("light", store.lastDark), "kanagawa-wave", what);
  }
});

test("another tab's change is heard, and its clearing the storage goes back to System", () => {
  const store = themeStore(storage());
  assert.equal(store.heard({ key: "nexus.theme", newValue: "catppuccin-mocha" }), true);
  assert.equal(store.choice, "catppuccin-mocha");
  assert.equal(store.heard({ key: "nexus.folded", newValue: "[]" }), false);
  assert.equal(store.heard({ key: null, newValue: null }), true);
  assert.equal(store.choice, "system");
});
