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

test("a dark theme another tab picked is where this tab's toggle goes back to", () => {
  const kept = storage();
  const here = themeStore(kept);
  const there = themeStore(kept);
  there.pick("tokyo-night");
  there.pickDark("tokyo-night");
  assert.equal(here.heard({ key: "nexus.theme", newValue: "tokyo-night" }), true);
  assert.equal(here.heard({ key: "nexus.theme.dark", newValue: "tokyo-night" }), false);
  const light = toggled("dark", here.lastDark);
  here.pick(light);
  assert.deepEqual([light, toggled("light", here.lastDark)], ["light", "tokyo-night"]);
});

test("another tab clearing the storage forgets the remembered dark theme too", () => {
  const store = themeStore(storage());
  store.pickDark("kanagawa-wave");
  store.pick("light");
  assert.equal(store.heard({ key: null, newValue: null }), true);
  assert.deepEqual([store.choice, store.lastDark], ["system", null]);
  assert.equal(toggled("light", store.lastDark), "dark");
});

test("the first-paint script names the platform beside the theme, as find.js tells a Mac, so each shortcut shows its own keys", async () => {
  const { runInNewContext } = await import("node:vm");
  const { themeScript } = await import("./view.ts");
  const painted = (platform) => {
    const root = { dataset: {} };
    runInNewContext(themeScript, { document: { documentElement: root }, navigator: { platform }, localStorage: storage(), matchMedia: () => ({ matches: false }) });
    return root.dataset;
  };
  assert.deepEqual(painted("MacIntel"), { theme: "light", platform: "mac" });
  assert.deepEqual(painted("iPhone"), { theme: "light", platform: "mac" });
  assert.deepEqual(painted("Win32"), { theme: "light", platform: "other" });
  assert.deepEqual(painted("Linux x86_64"), { theme: "light", platform: "other" });
});

test("the page's head script folds the sidebar before the first paint where the device keeps it folded, and only then", async () => {
  const { runInNewContext } = await import("node:vm");
  const { themeScript } = await import("./view.ts");
  const painted = (store) => {
    const root = { dataset: {} };
    runInNewContext(themeScript, { document: { documentElement: root }, navigator: { platform: "Linux x86_64" }, localStorage: store, matchMedia: () => ({ matches: false }) });
    return root.dataset.side;
  };
  const folded = storage();
  folded.setItem("nexus.side", "folded");
  assert.equal(painted(folded), "folded");
  assert.equal(painted(storage()), undefined);
  assert.equal(painted(storage({ reads: false })), undefined, "a refused read leaves the sidebar shown");
});
