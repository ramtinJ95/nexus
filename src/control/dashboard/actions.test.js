import { test } from "node:test";
import assert from "node:assert/strict";
import { actions } from "./contract.ts";

const none = () => null;
const node = () => ({ append() {}, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} }, dataset: {}, style: {} });
Object.assign(globalThis, {
  location: { href: "http://nexus.test/", pathname: "/", search: "" },
  localStorage: { getItem: none, setItem() {} },
  sessionStorage: { getItem: none, setItem() {} },
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  MutationObserver: class { observe() {} },
  document: { querySelector: none, getElementById: none, querySelectorAll: () => [], addEventListener() {}, createElement: node },
});
const { handlers } = await import("./actions.js");

test("every action a page's button names runs, and the client runs no other", () => {
  assert.deepEqual(Object.keys(handlers).sort(), [...actions].sort());
});
