import { test } from "node:test";
import assert from "node:assert/strict";

/** An element with what node-switch.js and page.js read of one, and the selectors they use. */
class Element {
  constructor(tag, attrs = {}, children = []) {
    const { class: className = "", id = "", dataset = {}, ...rest } = attrs;
    Object.assign(this, { tagName: tag, id, dataset, attributes: new Map(Object.entries(rest)), children, parentElement: null, textContent: "", innerHTML: "" });
    this.classList = new Set(className.split(" ").filter(Boolean));
    this.classList.contains = this.classList.has;
    this.classList.toggle = (name, on) => on ? this.classList.add(name) : this.classList.delete(name);
    for (const child of children) child.parentElement = this;
  }
  get href() { return new URL(this.getAttribute("href"), location.href).href; }
  *all() { for (const child of this.children) { yield child; yield* child.all(); } }
  matches(selector) { return selector.split(",").some((chain) => matchesChain(this, chain.trim().split(/\s+/))); }
  querySelectorAll(selector) { return [...this.all()].filter((el) => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let el = this; el !== null; el = el.parentElement) if (el.matches(selector)) return el; return null; }
  contains(other) { return other === this || [...this.all()].includes(other); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener() {}
}
function matchesOne(el, step) {
  const m = /^([a-z\d]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)\])?$/.exec(step);
  if (m === null) throw new SyntaxError(`'${step}' is not a selector this test reads`);
  const [, tag, classes, attr] = m;
  return (tag === undefined || el.tagName === tag) && classes.split(".").slice(1).every((c) => el.classList.has(c))
    && (attr === undefined || (attr.startsWith("data-") ? el.dataset[attr.slice(5)] !== undefined : el.attributes.has(attr)));
}
function matchesChain(el, chain) {
  if (!matchesOne(el, chain.at(-1))) return false;
  if (chain.length === 1) return true;
  for (let up = el.parentElement; up !== null; up = up.parentElement) if (matchesChain(up, chain.slice(0, -1))) return true;
  return false;
}

const nodes = ["rj-firebat", "infra-testbench", "spare"];
/** The Cluster page with `picked` picked, as the server renders it. */
function page(picked) {
  const cards = nodes.map((node) => new Element("article", { class: `node-card${node === picked ? " picked" : ""}`, dataset: { node } }, [
    new Element("header", { class: "node-card-h" }, [new Element("a", { class: "link", href: `/nodes/${node}`, ...node === picked ? { "aria-current": "page" } : {} })]),
  ]));
  const live = (id, html, children = []) => Object.assign(new Element("div", { id, dataset: { live: "" } }, children), { innerHTML: html });
  const crumb = Object.assign(new Element("h1"), { textContent: picked });
  const heading = Object.assign(new Element("h2", { class: "node-detail-h" }), { textContent: picked });
  return Object.assign(new Element("html", {}, [
    new Element("main", { dataset: { pollMs: "10000" } }, [
      new Element("header", { class: "bar" }, [new Element("div", { class: "crumb" }, [crumb])]),
      live("cluster-nodes", `cards picking ${picked}`, cards),
      new Element("div", { class: "node-detail" }, [heading, live("node-cleanup", `cleanup of ${picked}`), live("node-health", `health of ${picked}`), new Element("section", { id: "node-graphs", dataset: { node: picked } })]),
    ]),
  ]), { title: `Cluster: ${picked}` });
}
const doc = (root) => ({
  getElementById: (id) => [...root.all()].find((el) => el.id === id) ?? null,
  querySelector: (selector) => root.querySelector(selector),
  querySelectorAll: (selector) => root.querySelectorAll(selector),
  title: root.title,
});

/** Each read of a page waits until the test answers it with its status. */
const reads = [];
const pushed = [];
const replaced = [];
const clicks = [];
const popped = [];
const listeners = [];
Object.assign(globalThis, {
  Element, HTMLAnchorElement: Element, HTMLImageElement: Element, HTMLDetailsElement: Element, EventSource: { OPEN: 1 },
  location: { href: "http://nexus.test/nodes/rj-firebat", pathname: "/nodes/rj-firebat", search: "", replace: (href) => replaced.push(new URL(href).pathname) },
  history: { pushState: (_, __, url) => { pushed.push(url.pathname); go(url.pathname); } },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: (type, listener) => { if (type === "popstate") popped.push(listener); },
  fetch: (url) => new Promise((resolve, reject) => reads.push({ path: url.pathname, resolve, reject })),
  DOMParser: class { parseFromString(text) { return doc(page(text)); } },
  document: {
    ...doc(page("rj-firebat")),
    activeElement: null,
    addEventListener: (type, listener) => { if (type === "click") clicks.push(listener); },
  },
});
await import("./node-switch.js");
const { refreshNow } = await import("./page.js");
const settled = () => new Promise((resolve) => setImmediate(resolve));

function go(path) { Object.assign(location, { href: `http://nexus.test${path}`, pathname: path }); }
const link = (node) => document.querySelectorAll(".node-card-h a").find((a) => a.getAttribute("href") === `/nodes/${node}`);
function click(node, more = {}) {
  const event = { target: link(node), button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() { this.defaultPrevented = true; }, ...more };
  for (const listener of clicks) listener(event);
  return event;
}
async function answer(path, status = 200, node = path.slice("/nodes/".length)) {
  const at = reads.findIndex((r) => r.path === path);
  assert.notEqual(at, -1, `${path} was read`);
  const [read] = reads.splice(at, 1);
  read.resolve({ ok: status < 400, status, headers: new Headers(), text: async () => node });
  await settled();
}
const shows = () => ({
  picked: document.querySelectorAll(".node-card.picked").map((c) => c.dataset.node).join(),
  current: document.querySelectorAll(".node-card-h a").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.getAttribute("href")).join(),
  heading: document.querySelector(".node-detail-h").textContent,
  crumb: document.querySelector(".crumb h1").textContent,
  graphs: document.getElementById("node-graphs").dataset.node,
  busy: document.querySelector(".node-detail").getAttribute("aria-busy"),
});
const regions = () => ["cluster-nodes", "node-cleanup", "node-health"].map((id) => document.getElementById(id).innerHTML);

test("a click on another node's name shows that node at once, and its detail once its page comes", async () => {
  const event = click("infra-testbench");
  assert.ok(event.defaultPrevented, "the browser loads no page");
  assert.deepEqual(pushed, ["/nodes/infra-testbench"], "the address names the node");
  assert.deepEqual(shows(), { picked: "infra-testbench", current: "/nodes/infra-testbench", heading: "infra-testbench", crumb: "infra-testbench", graphs: "infra-testbench", busy: "true" });
  assert.deepEqual(regions(), ["cards picking rj-firebat", "cleanup of rj-firebat", "health of rj-firebat"], "the detail waits for the node's page");
  await answer("/nodes/infra-testbench");
  assert.deepEqual(regions(), ["cards picking infra-testbench", "cleanup of infra-testbench", "health of infra-testbench"]);
  assert.equal(document.title, "Cluster: infra-testbench");
  assert.equal(shows().busy, null, "and is no longer loading");
  assert.deepEqual(replaced, []);
});

test("back and forward switch the node in place", async () => {
  pushed.length = 0;
  go("/nodes/rj-firebat");
  for (const listener of popped) listener();
  assert.equal(shows().picked, "rj-firebat");
  await answer("/nodes/rj-firebat");
  assert.deepEqual(regions(), ["cards picking rj-firebat", "cleanup of rj-firebat", "health of rj-firebat"]);
  go("/nodes/infra-testbench");
  for (const listener of popped) listener();
  await answer("/nodes/infra-testbench");
  assert.deepEqual(regions(), ["cards picking infra-testbench", "cleanup of infra-testbench", "health of infra-testbench"]);
  assert.deepEqual(pushed, [], "the history moved by itself");
});

test("a modified, middle or prevented click on a node's name is the browser's", () => {
  for (const more of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    const event = click("spare", more);
    assert.equal(event.defaultPrevented, more.defaultPrevented ?? false, JSON.stringify(more));
  }
  assert.deepEqual([pushed, reads.length, shows().picked], [[], 0, "infra-testbench"]);
});

test("a node whose page can't be read, as one that is gone, is loaded as a page", async () => {
  click("spare");
  await answer("/nodes/spare", 404);
  assert.deepEqual(replaced, ["/nodes/spare"], "the server's page and its error show in place of the pushed entry");
  replaced.length = 0;
  click("rj-firebat");
  reads.shift().reject(new TypeError("Failed to fetch"));
  await settled();
  assert.deepEqual(replaced, ["/nodes/rj-firebat"]);
  replaced.length = 0;
  go("/nodes/infra-testbench");
  for (const listener of popped) listener();
  await answer("/nodes/infra-testbench");
});

test("the poll reads the node switched to, and a poll from before the switch swaps nothing back", async () => {
  const before = refreshNow();
  click("spare");
  await answer("/nodes/spare");
  await answer("/nodes/infra-testbench");
  await before;
  assert.deepEqual(regions(), ["cards picking spare", "cleanup of spare", "health of spare"], "the old node's detail stays out");
  const poll = refreshNow();
  assert.deepEqual(reads.map((r) => r.path), ["/nodes/spare"]);
  await answer("/nodes/spare");
  await poll;
});

test("a second click before the first node's page comes is the one that shows", async () => {
  click("rj-firebat");
  click("infra-testbench");
  await answer("/nodes/infra-testbench");
  await answer("/nodes/rj-firebat");
  assert.deepEqual(regions(), ["cards picking infra-testbench", "cleanup of infra-testbench", "health of infra-testbench"]);
  assert.deepEqual(shows(), { picked: "infra-testbench", current: "/nodes/infra-testbench", heading: "infra-testbench", crumb: "infra-testbench", graphs: "infra-testbench", busy: null });
  assert.equal(location.pathname, "/nodes/infra-testbench");
  assert.deepEqual(replaced, []);
});

test("back to /cluster before the picked node's page comes picks the node /cluster shows, though its cards are unchanged", async () => {
  click("spare");
  go("/cluster");
  for (const listener of popped) listener();
  await answer("/cluster", 200, "infra-testbench");
  await answer("/nodes/spare");
  assert.deepEqual(shows(), { picked: "infra-testbench", current: "/nodes/infra-testbench", heading: "infra-testbench", crumb: "infra-testbench", graphs: "infra-testbench", busy: null });
});

test("a switch writes the node into the live heading once, so a screen reader says it once", async () => {
  const heading = document.querySelector(".node-detail-h");
  const said = [];
  let text = heading.textContent;
  Object.defineProperty(heading, "textContent", { get: () => text, set: (value) => { said.push(value); text = value; } });
  click("spare");
  await answer("/nodes/spare");
  assert.deepEqual(said, ["spare"]);
});

test("a poll in flight when only the address's hash changes swaps its page in, as the page is the same", async () => {
  const poll = refreshNow();
  location.href += "#node-cleanup";
  await answer("/nodes/spare", 200, "spare, read again");
  await poll;
  assert.equal(document.getElementById("node-health").innerHTML, "health of spare, read again");
});
