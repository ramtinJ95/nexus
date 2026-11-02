import { test } from "node:test";
import assert from "node:assert/strict";
import { pickedLink } from "./node-cards.js";

class Element {
  constructor(tag, className = "", children = []) {
    Object.assign(this, { tag, className, children, parent: null });
    for (const child of children) child.parent = this;
  }
  matches(selector) { return selector.startsWith(".") ? this.className.split(" ").includes(selector.slice(1)) : this.tag === selector; }
  closest(selectors) {
    for (let e = this; e !== null; e = e.parent) if (selectors.split(", ").some((s) => e.matches(s))) return e;
    return null;
  }
  querySelector(selector) {
    const [within, tag] = selector.split(" ");
    const all = (e) => [e, ...e.children.flatMap(all)];
    return all(this).find((e) => e.tag === tag && e.parent.closest(within) !== null) ?? null;
  }
}
globalThis.Element = Element;

const card = (name) => {
  const link = new Element("a");
  const meter = new Element("dd");
  const checks = new Element("a", "link node-checks");
  return { link, meter, checks, card: new Element("article", `node-card ${name}`, [new Element("header", "node-card-h", [new Element("span", "", [link])]), new Element("dl", "meters", [meter]), new Element("p", "node-facts", [checks])]) };
};
const click = (target, more = {}) => ({ target, button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...more });
const collapsed = { isCollapsed: true };

test("a click on a node card's body picks the card's node through its name link", () => {
  const firebat = card("rj-firebat");
  const testbench = card("infra-testbench");
  assert.equal(pickedLink(click(firebat.meter), collapsed), firebat.link);
  assert.equal(pickedLink(click(testbench.card), collapsed), testbench.link, "a click on the card's padding");
});

test("a link on the card keeps going where it goes, and the name link navigates by itself", () => {
  const { link, checks } = card("rj-firebat");
  assert.equal(pickedLink(click(checks), collapsed), null, "Every check ok opens the Health page");
  assert.equal(pickedLink(click(link), collapsed), null);
  assert.equal(pickedLink(click(new Element("button")), collapsed), null);
});

test("the click that ends selecting a card's text, a modified or prevented click, and a click off the cards pick nothing", () => {
  const { meter } = card("rj-firebat");
  assert.equal(pickedLink(click(meter), { isCollapsed: false }), null);
  assert.equal(pickedLink(click(meter, { metaKey: true }), collapsed), null);
  assert.equal(pickedLink(click(meter, { defaultPrevented: true }), collapsed), null);
  assert.equal(pickedLink(click(new Element("p")), collapsed), null);
});
