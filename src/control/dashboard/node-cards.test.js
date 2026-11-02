import { test } from "node:test";
import assert from "node:assert/strict";

class Element {
  constructor(tag, className = "", children = []) {
    Object.assign(this, { tag, className, children, parent: null, clicks: 0 });
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
  click() { this.clicks++; }
}
let onClick = null;
let selection = { isCollapsed: true };
Object.assign(globalThis, { Element, getSelection: () => selection, document: { addEventListener: (type, listener) => { if (type === "click") onClick = listener; } } });
await import("./node-cards.js");

const card = (name, picked = false) => {
  const link = new Element("a");
  const meter = new Element("dd");
  const checks = new Element("a", "link node-checks");
  const article = new Element("article", `node-card${picked ? " picked" : ""}`, [new Element("header", "node-card-h", [new Element("span", "", [link])]), new Element("dl", "meters", [meter]), new Element("p", "node-facts", [checks])]);
  return { name, link, meter, checks, card: article };
};
const click = (target, more = {}) => onClick({ target, button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...more });
const opened = (...cards) => cards.flatMap((c) => [c.link, c.checks].map((a) => a.clicks)).join(",");

test("a click on another node's card body opens that card's name link", () => {
  const firebat = card("rj-firebat");
  const testbench = card("infra-testbench");
  click(firebat.meter);
  assert.equal(opened(firebat, testbench), "1,0,0,0");
  click(testbench.card);
  assert.equal(opened(firebat, testbench), "1,0,1,0", "a click on the card's padding");
});

test("a link or button on a card keeps doing its own thing, and is not opened twice", () => {
  const { link, checks, ...rest } = card("rj-firebat");
  click(checks);
  click(link);
  click(new Element("button"));
  assert.equal(opened({ link, checks, ...rest }), "0,0", "the browser follows the clicked link itself");
});

test("the click that ends selecting a card's text, a modified or prevented click, and a click off the cards open nothing", () => {
  const firebat = card("rj-firebat");
  selection = { isCollapsed: false };
  click(firebat.meter);
  selection = { isCollapsed: true };
  click(firebat.meter, { metaKey: true });
  click(firebat.meter, { button: 1 });
  click(firebat.meter, { defaultPrevented: true });
  click(new Element("p"));
  assert.equal(opened(firebat), "0,0");
});
