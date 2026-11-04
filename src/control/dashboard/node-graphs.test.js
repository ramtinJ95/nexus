import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { seriesOf } from "../node-metrics.ts";
import { charts } from "./graph-data.ts";

/** Each chart uPlot draws, which the test reads its lines' looks from. */
const plots = [];
globalThis.FakeUPlot = class {
  static paths = { stepped: () => null };
  constructor(opts, data, target) { Object.assign(this, { opts, target, cursor: {} }); plots.push(this); }
  setData(data) { this.data = data; }
  setSeries() {}
  setSize() {}
  destroy() {}
  posToVal() { return 0; }
  valToPos() { return 0; }
};
registerHooks({
  resolve: (specifier, context, next) => specifier === "uplot" ? { url: "data:text/javascript,export default globalThis.FakeUPlot", shortCircuit: true }
    : specifier === "uplot/dist/uPlot.min.css" ? { url: "data:text/javascript,export default ''", shortCircuit: true }
    : next(specifier, context),
});

class Element {
  constructor(tag, attrs = {}, children = []) {
    const { class: className = "", id = "", dataset = {} } = attrs;
    Object.assign(this, { tagName: tag, id, dataset, attributes: new Map(), children: [], parentElement: null, hidden: false, textContent: "", style: {}, clientWidth: 600 });
    this.classList = new Set(className.split(" ").filter(Boolean));
    this.classList.contains = this.classList.has;
    this.classList.remove = this.classList.delete;
    this.append(...children);
  }
  append(...children) { for (const child of children) if (child instanceof Element) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  *all() { for (const child of this.children) { yield child; yield* child.all(); } }
  /** The simple selectors node-graphs.js uses. page.js's others, such as `.shot img`, find nothing on this page. */
  matches(selector) {
    const m = /^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/.exec(selector);
    if (m === null) return false;
    const [, tag, cls, attr] = m;
    return (tag === undefined || this.tagName === tag) && (cls === undefined || this.classList.has(cls)) && (attr === undefined || this.dataset[attr.slice(5)] !== undefined);
  }
  querySelectorAll(selector) { return [...this.all()].filter((el) => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener() {}
}

/** The node page's graphs' frame, as cluster-page.ts renders it, for `node`. */
function frame(node) {
  const figures = charts.map((chart) => new Element("figure", { dataset: { chart: chart.id } }, [
    new Element("figcaption"), new Element("div", { class: "graph-plot" }, [new Element("p", { class: "graph-empty" })]), new Element("div", { class: "graph-legend" }),
  ]));
  return new Element("section", { id: "node-graphs", dataset: { node } }, [new Element("p", { id: "graphs-error" }), new Element("div", { class: "graph-grid" }, figures)]);
}
let root = new Element("html");
const observers = [];
const now = Date.now();
/** Each node's pylons, which its metrics serve a CPU series for. A node not here answers 502. */
const pylons = { "rj-firebat": Array.from({ length: 10 }, (_, i) => `pylon-a${i}`), "infra-testbench": ["pylon-b0", "pylon-b1", "pylon-b2"] };
function metrics(node) {
  const series = pylons[node].map((pylon) => {
    const key = `pylonCpu:${pylon}:th-${pylon}`;
    return { key, series: seriesOf(key), label: pylon, t: [now - 60_000, now], min: [5, 6], avg: [5, 6], max: [5, 6], n: [1, 1] };
  });
  return { node, from: now - 3_600_000, to: now, tier: "raw", bucketMs: 4_000, sampledAt: now, series, otherPylons: [] };
}
Object.assign(globalThis, {
  Element, HTMLAnchorElement: Element, HTMLImageElement: Element, HTMLDetailsElement: Element, EventSource: { OPEN: 1 },
  CSSStyleSheet: class { replaceSync() {} },
  MutationObserver: class { constructor(changed) { this.changed = changed; } observe(target) { observers.push({ target, changed: this.changed }); } },
  ResizeObserver: class { observe() {} },
  getComputedStyle: () => ({ getPropertyValue: (name) => name === "--chart-series" ? "c0 c1 c2 c3 c4 c5 c6 c7" : "ink" }),
  localStorage: { getItem: () => null, setItem: () => {} },
  location: { href: "http://nexus.test/nodes/rj-firebat", pathname: "/nodes/rj-firebat", search: "" },
  fetch: async (path) => {
    const node = decodeURIComponent(/^\/v1\/nodes\/([^/]+)\/metrics/.exec(path)[1]);
    const body = node in pylons ? metrics(node) : { error: `${node}'s probe did not answer` };
    return { ok: node in pylons, status: node in pylons ? 200 : 502, text: async () => JSON.stringify(body) };
  },
  document: {
    adoptedStyleSheets: [],
    documentElement: new Element("html"),
    createElement: (tag) => new Element(tag),
    getElementById: (id) => [...root.all()].find((el) => el.id === id) ?? null,
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    addEventListener() {},
  },
});
const settled = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
let loads = 0;
/** The graphs of a page opened on `node`. */
async function open(node) {
  root = new Element("html", {}, [new Element("main"), frame(node)]);
  await import(`./node-graphs.js?${loads++}`);
  await settled();
  return document.getElementById("node-graphs");
}
async function switchTo(section, node) {
  section.dataset.node = node;
  for (const o of observers) if (o.target === section) o.changed();
  await settled();
}
/** The lines the pylon CPU chart draws now, with their colours and dashes. */
function pylonLines(section) {
  const plot = section.querySelectorAll("figure").find((f) => f.dataset.chart === "pylon-cpu").querySelector(".graph-plot");
  return plots.findLast((p) => p.target === plot).opts.series.slice(1).map((s) => [s.label, s.stroke(), s.dash ?? null]);
}

test("a switch to another node draws its pylons in the colours a load of its page gives them", async () => {
  const section = await open("rj-firebat");
  assert.equal(pylonLines(section).length, 10);
  await switchTo(section, "infra-testbench");
  const switched = pylonLines(section);
  const loaded = pylonLines(await open("infra-testbench"));
  assert.deepEqual(switched, loaded);
  assert.deepEqual(switched, [["pylon-b0", "c0", null], ["pylon-b1", "c1", null], ["pylon-b2", "c2", null]], "and none is dashed as a ninth line is");
});

test("a switch to a node whose metrics fail leaves none of the last node's lines under its name", async () => {
  const section = await open("rj-firebat");
  await switchTo(section, "gone");
  assert.deepEqual(pylonLines(section), []);
  const error = document.getElementById("graphs-error");
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /gone's probe did not answer/);
});
