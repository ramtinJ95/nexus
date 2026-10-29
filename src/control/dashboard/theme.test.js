import { test } from "node:test";
import assert from "node:assert/strict";
import { shown, toggled } from "./theme.js";

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
