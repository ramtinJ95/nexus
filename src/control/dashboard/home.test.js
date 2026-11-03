import { test } from "node:test";
import assert from "node:assert/strict";

/** An element with what home.js and page.js read of one, and the selectors they use, which it parses as a browser does. */
class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag;
    this.id = attrs.id ?? "";
    this.classList = new Set((attrs.class ?? "").split(" ").filter(Boolean));
    this.classList.contains = this.classList.has;
    this.classList.remove = this.classList.delete;
    this.classList.toggle = (name, on) => on ? this.classList.add(name) : this.classList.delete(name);
    this.dataset = attrs.dataset ?? {};
    this.open = attrs.open ?? false;
    this.children = children;
    this.parentElement = null;
    for (const child of children) child.parentElement = this;
    this.scrolled = 0;
  }
  *all() { for (const child of this.children) { yield child; yield* child.all(); } }
  matches(selector) { return parse(selector).some((chain) => matchesChain(this, chain)); }
  querySelectorAll(selector) { const chains = parse(selector); return [...this.all()].filter((el) => chains.some((chain) => matchesChain(el, chain))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let el = this; el !== null; el = el.parentElement) if (el.matches(selector)) return el; return null; }
  getAttribute(name) { return this[name] ?? null; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(type, listener) { (this.listeners ??= {})[type] = listener; }
  scrollIntoView() { this.scrolled++; }
  focus() {}
}
const compound = /^([a-z]+)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/;
function parse(selector) {
  return selector.split(",").map((part) => part.trim().split(/\s+/).map((step) => {
    const m = compound.exec(step);
    if (m === null) throw new SyntaxError(`'${selector}' is not a valid selector.`);
    return { tag: m[1], tests: [...m[2].matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)] };
  }));
}
const attr = (el, name) => name === "id" ? el.id || undefined : name.startsWith("data-") ? el.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] : el[name];
const matchesOne = (el, { tag, tests }) => (tag === undefined || el.tagName === tag)
  && tests.every(([, cls, name, value]) => cls !== undefined ? el.classList.has(cls) : value === undefined ? attr(el, name) !== undefined : attr(el, name) === value);
function matchesChain(el, chain) {
  if (!matchesOne(el, chain.at(-1))) return false;
  if (chain.length === 1) return true;
  for (let up = el.parentElement; up !== null; up = up.parentElement) if (matchesChain(up, chain.slice(0, -1))) return true;
  return false;
}

/** A thread's card in Needs you, marked picked when the server picked it. */
function card(thread, picked, kind = "review", attention = "decision") {
  const head = new Element("summary", { class: "need-sum" });
  return new Element("article", { class: `need need-${kind}${picked ? " picked" : ""}`, id: `need-${thread}-${kind}`, dataset: { thread, attention } }, [
    new Element("details", { class: "need-fold", id: `fold-need-${thread}-${kind}`, open: picked }, [head]),
  ]);
}
const replaced = [];
const fetched = [];
const listeners = {};
function setPage(href, cards) {
  const url = new URL(href, "http://nexus.test");
  const needs = new Element("section", { id: "needs-you" }, cards);
  const root = new Element("html", {}, [
    new Element("main", { dataset: { pollMs: "1000" } }),
    new Element("input", { id: "side-needs" }),
    new Element("input", { id: "side-flight" }),
    new Element("div", { id: "split" }, [needs, new Element("div", { id: "peek" })]),
  ]);
  Object.assign(globalThis.location, { href: url.href, hash: url.hash, pathname: url.pathname });
  globalThis.document.root = root;
  replaced.length = fetched.length = 0;
  return root;
}
const store = new Map();
let reply = () => Promise.reject(new Error("offline"));
Object.assign(globalThis, {
  Element, HTMLAnchorElement: Element, HTMLImageElement: Element, EventSource: { OPEN: 1 },
  location: {},
  history: { state: null, replaceState: (_, __, url) => { replaced.push(`${url.pathname}${url.search}`); Object.assign(location, { href: url.href }); } },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  matchMedia: () => ({ matches: true }),
  addEventListener: (type, listener) => { listeners[type] = listener; },
  fetch: (url) => { fetched.push(`${url.pathname}${url.search}`); return reply(); },
  document: {
    root: new Element("html"),
    getElementById(id) { return [...this.root.all()].find((el) => el.id === id) ?? null; },
    querySelector(selector) { return this.root.querySelector(selector); },
    querySelectorAll(selector) { return this.root.querySelectorAll(selector); },
    addEventListener() {},
  },
});
let loads = 0;
const load = () => import(`./home.js?${loads++}`);
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a malformed peek in the address leaves the home page's handlers working", async () => {
  const root = setPage('/?peek=a"b', [card("th-1", false)]);
  await load();
  const split = document.getElementById("split");
  assert.ok(split.listeners?.click, "the page's clicks are handled");
  split.listeners.click({ target: root.querySelector(".need-sum"), button: 0 });
  assert.deepEqual(replaced, ["/?peek=th-1&card=need-th-1-review"], "opening a card picks it");
});

test("a link to an item that became a carded thread brings the thread's card into view and reads its latest reply", async () => {
  const root = setPage("/?peek=it-000000000001", [card("th-2", true)]);
  await load();
  await settled();
  const need = root.querySelector(".need");
  assert.equal(need.scrolled, 1, "the card the server picked comes into view");
  assert.ok(document.getElementById("side-needs").checked, "on the Needs you side");
  assert.deepEqual(replaced, ["/?peek=th-2"], "the address names the thread");
  assert.deepEqual(fetched, ["/?peek=th-2"], "and the page reads itself again with the thread's latest reply");
});

test("a notice's link opens its card and reads its latest reply", async () => {
  const root = setPage("/#needs-you:th-3:decision", [card("th-4", false), card("th-3", false)]);
  await load();
  await settled();
  const [other, noticed] = root.querySelectorAll(".need");
  assert.ok(noticed.classList.has("picked") && noticed.querySelector(".need-fold").open, "the notice's card is picked and open");
  assert.equal(noticed.scrolled, 1);
  assert.ok(!other.classList.has("picked") && !other.querySelector(".need-fold").open);
  assert.deepEqual(replaced, ["/?peek=th-3&card=need-th-3-review"], "and picking it reads its latest reply");
});

test("a notice for a thread's second card names that card, so the poll the pick starts keeps it marked", async () => {
  const root = setPage("/#needs-you:th-7:failed", [card("th-7", false), card("th-7", false, "thread", "failed")]);
  await load();
  await settled();
  const [first, noticed] = root.querySelectorAll(".need");
  assert.ok(noticed.classList.has("picked") && !first.classList.has("picked"), "the notice's card is the one picked");
  assert.deepEqual(replaced, ["/?peek=th-7&card=need-th-7-thread"], "and the address names it for the server to mark");
  assert.deepEqual(fetched, ["/?peek=th-7&card=need-th-7-thread"]);
});

test("a reader's pick while a notice waits for its card is the one that stands", async (t) => {
  const pending = [];
  reply = () => new Promise((_, reject) => pending.push(reject));
  t.after(() => { reply = () => Promise.reject(new Error("offline")); });
  const root = setPage("/#needs-you:th-5:decision", [card("th-6", false)]);
  await load();
  await settled();
  document.getElementById("split").listeners.click({ target: root.querySelector(".need-sum"), button: 0 });
  for (let i = 0; i < 3; i++) {
    for (const reject of pending.splice(0)) reject(new Error("offline"));
    await settled();
  }
  assert.deepEqual(replaced, ["/?peek=th-6&card=need-th-6-review"], "the address keeps the reader's pick");
  assert.equal(document.getElementById("needs-you").scrolled, 0, "and the inbox does not jump to the notice's card");
});
