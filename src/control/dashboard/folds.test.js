import { test } from "node:test";
import assert from "node:assert/strict";
import { toggledBy } from "./folds.js";

class Element { constructor(details) { this.details = details; } closest(selector) { return selector === "summary" && this.details !== null ? { parentElement: this.details } : null; } }
class HTMLDetailsElement { constructor(id, open) { this.id = id; this.open = open; } }
globalThis.Element = Element;
globalThis.HTMLDetailsElement = HTMLDetailsElement;
const click = (details, prevented = false) => ({ target: new Element(details), defaultPrevented: prevented });

test("a click on a fold's summary records the state it toggles to, and a click a handler prevented records nothing", () => {
  const fold = new HTMLDetailsElement("fold-need-th-1-thread", false);
  assert.deepEqual(toggledBy(click(fold)), { details: fold, open: true });
  fold.open = true;
  assert.deepEqual(toggledBy(click(fold)), { details: fold, open: false });
  assert.equal(toggledBy(click(fold, true)), null, "a card title that opens the preview leaves the fold as it is, open");
  assert.equal(toggledBy(click(new HTMLDetailsElement("", false))), null, "a fold without an id is not remembered");
  assert.equal(toggledBy(click(null)), null, "a click outside any summary");
});
