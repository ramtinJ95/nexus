import { test } from "node:test";
import assert from "node:assert/strict";
import { findText, narrow as narrowQuery } from "./contract.ts";

/** An element with what find.js and switcher.js read of one, and the selectors they use. */
class El {
  constructor(tag, { id = "", class: className = "", dataset = {}, open = false } = {}, children = []) {
    Object.assign(this, { tagName: tag, id, dataset, open, hidden: false, value: "", attributes: new Map(), listeners: {}, parentElement: null });
    this.classes = new Set(className.split(" ").filter(Boolean));
    this.children = [];
    this.append(...children);
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  *all() { for (const child of this.children) { yield child; yield* child.all(); } }
  matches(step) {
    const m = /^([a-z]+)?(#[\w-]+)?((?:\.[\w-]+)*)(\[open\])?$/.exec(step);
    if (m === null) throw new SyntaxError(`'${step}' is not a selector this test reads`);
    return (m[1] === undefined || this.tagName === m[1]) && (m[2] === undefined || this.id === m[2].slice(1))
      && m[3].split(".").slice(1).every((c) => this.classes.has(c)) && (m[4] === undefined || this.open);
  }
  querySelectorAll(selector) {
    const [last, ...ups] = selector.split(/\s+/).reverse();
    const within = (el) => ups.every((up) => { for (let p = el.parentElement; p !== null; p = p.parentElement) if (p.matches(up)) return true; return false; });
    return [...this.all()].filter((el) => el.matches(last) && within(el));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  fire(type, event = {}) {
    const e = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
    for (const listener of this.listeners[type] ?? []) listener(e);
    return e;
  }
  focus() { document.activeElement = this; }
  select() { this.selected = true; }
  scrollIntoView() {}
}
class Input extends El {}
class Form extends El {}
class TextArea extends El {}
class Dialog extends El {
  showModal() { this.open = true; this.opened?.(); }
  close() { this.open = false; this.closed?.(); }
}

/** The switcher's dialog, which every page has the same of, as shell.ts renders it. */
const switcher = new Dialog("dialog", { id: "switcher" }, [new Input("input", { id: "switcher-q" }), new El("ul", { id: "switcher-list" })]);
const [switcherInput, switcherList] = switcher.children;

const threads = [
  { id: "th-cart0000001", title: "Review of #88: feat(checkout) cache the cart", project: "acme", prs: [], at: 3 },
  { id: "th-charge00001", title: "Review of #88: feat(checkout) retry the charge", project: "acme", prs: [], at: 2 },
  { id: "th-builder0001", title: "feat(checkout) cache the cart", project: "acme", prs: [88], at: 1 },
  { id: "th-docs0000001", title: "Write the docs", project: "beta", prs: [412], at: 4 },
];
/** A row as shell.ts renders it, with its `data-find`. */
const row = (t) => {
  const link = new El("a", { class: "row", dataset: { find: findText(t, t.prs) } });
  link.setAttribute("href", `/threads/${t.id}`);
  return new El("li", {}, [link]);
};
/** A page as the server renders it, with beta folded as its reader left it. */
function page() {
  const group = (project, open) => new El("details", { id: `group-${project}`, class: "group", open }, [new El("ul", {}, threads.filter((t) => t.project === project).map(row))]);
  const filter = new Input("input", { id: "filter" });
  filter.setAttribute("name", "q");
  const form = new Form("form", { id: "filter-form" }, [filter]);
  form.setAttribute("action", "/threads/closed");
  form.setAttribute("role", "search");
  const textarea = new TextArea("textarea", { id: "prompt-text" });
  const root = new El("html", {}, [form, new El("nav", { id: "side-threads" }, [group("acme", true), group("beta", false)]), textarea, switcher]);
  const doc = Object.assign(root, {
    getElementById: (id) => [...root.all()].find((el) => el.id === id) ?? null,
    createElement: (tag) => new El(tag),
    activeElement: null,
    body: new El("body"),
  });
  return { doc, filter, form, textarea, shown: () => doc.querySelectorAll("li").filter((li) => !li.hidden && li.parentElement.parentElement.open).map((li) => threads.find((t) => li.querySelector("a.row").dataset.find === findText(t, t.prs)).id) };
}

const stored = new Map();
let phone = false;
let assigned = [];
Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64" }, configurable: true, writable: true });
Object.assign(globalThis, {
  HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLSelectElement: class extends El {},
  FormData: class { constructor(form) { return form.querySelectorAll("input").map((input) => [input.getAttribute("name"), input.value]); } },
  matchMedia: (query) => ({ matches: query === narrowQuery && phone }),
  sessionStorage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: (k) => stored.delete(k) },
  location: { assign: (href) => assigned.push(href) },
});
let loads = 0;
/** Loads `p` as a click loads a page: find.js runs again over it, and client.js then filters it. */
async function load(p) {
  globalThis.document = p.doc;
  const find = await import(`./find.js?${loads++}`);
  find.applyFilter();
  return find;
}
const type = (input, value) => { input.value = value; input.fire("input"); };
const ids = (...names) => threads.filter((t) => names.includes(t.id.slice(3, 7))).map((t) => t.id);

test("the filter a reader typed still filters the page the next click loads, and clearing it is kept too", async () => {
  stored.clear();
  const first = page();
  await load(first);
  type(first.filter, "charge");
  assert.deepEqual(first.shown(), ids("char"));

  const next = page();
  await load(next);
  assert.equal(next.filter.value, "charge", "the next page's filter holds what the reader typed");
  assert.deepEqual(next.shown(), ids("char"), "and filters its rows");
  type(next.filter, "");
  const after = page();
  await load(after);
  assert.equal(after.filter.value, "");
  assert.deepEqual(after.shown(), ids("cart", "char", "buil"), "an empty filter shows every row of the open projects");
});

test("the filter matches a thread's title, project, ID and pull request, each word of it, and opens a folded project it matches", async () => {
  stored.clear();
  const p = page();
  await load(p);
  const cases = [
    ["cache cart", ["cart", "buil"], "every word of the title"],
    ["beta", ["docs"], "the project, which opens beta's fold"],
    ["th-charge", ["char"], "the ID"],
    ["#412", ["docs"], "the pull request's number"],
    ["412", ["docs"], "the number without its #"],
    ["#88", ["cart", "char", "buil"], "a number in the title, and the one a builder linked"],
    ["acme retry", ["char"], "the project and the title together"],
  ];
  for (const [query, expected, what] of cases) {
    type(p.filter, query);
    assert.deepEqual(p.shown(), ids(...expected), `${query}: ${what}`);
  }
  type(p.filter, "no such thread");
  assert.deepEqual(p.doc.querySelectorAll(".group").map((g) => g.hidden), [true, true], "a project with no match is hidden");
  type(p.filter, "");
  assert.equal(p.doc.getElementById("group-beta").open, false, "clearing the filter folds again what it opened");
});

test("/ focuses the filter, but not while the reader types or a dialog is open", async () => {
  stored.clear();
  const p = page();
  await load(p);
  const typed = p.doc.fire("keydown", { key: "/", target: p.textarea });
  assert.equal(typed.defaultPrevented, false, "a / typed into the composer is the composer's");
  assert.notEqual(p.doc.activeElement, p.filter);
  switcher.open = true;
  assert.equal(p.doc.fire("keydown", { key: "/", target: p.doc }).defaultPrevented, false, "a / over an open dialog is the dialog's");
  switcher.open = false;
  const pressed = p.doc.fire("keydown", { key: "/", target: p.doc });
  assert.equal(pressed.defaultPrevented, true);
  assert.equal(p.doc.activeElement, p.filter, "the filter has focus");
  assert.equal(p.filter.selected, true, "with what it holds selected, to type over");
  assert.equal(p.doc.body.dataset.open, undefined, "a wide page's sidebar is always shown");
  phone = true;
  p.doc.fire("keydown", { key: "/", target: p.doc });
  phone = false;
  assert.equal(p.doc.body.dataset.open, "side", "a phone's drawer opens to show the filter");
});

test("Enter in the filter searches the archived and deleted threads for it, though the page's policy refuses a form's own submit", async () => {
  stored.clear();
  assigned = [];
  const p = page();
  await load(p);
  type(p.filter, "checkout retry");
  assert.equal(p.doc.fire("submit", { target: p.form }).defaultPrevented, true, "the browser's submit, which form-action 'none' refuses, is not run");
  assert.deepEqual(assigned, ["/threads/closed?q=checkout+retry"]);
  type(p.filter, " ");
  assert.equal(p.doc.fire("submit", { target: p.form }).defaultPrevented, true);
  assert.deepEqual(assigned, ["/threads/closed?q=checkout+retry"], "an empty filter searches nothing");
});

test("Ctrl/⌘K opens the switcher over the listed rows, and the keyboard picks a thread and opens it", async () => {
  stored.clear();
  assigned = [];
  switcher.open = false;
  const p = page();
  const find = await load(p);
  // A quiet thread past the sidebar's cap is in the list's rows alone.
  const older = { id: "th-quiet000001", title: "Tidy the logs", project: "acme", prs: [977], at: 0 };
  find.listRows([...threads, older].map((t) => ({ id: t.id, title: t.title, project: t.project, createdAt: t.at, lastAgentActivityAt: 0, lastHumanActivityAt: 0, pullRequestNumbers: t.prs })));
  const opened = new Promise((resolve) => { switcher.opened = resolve; });
  assert.equal(p.doc.fire("keydown", { key: "k", ctrlKey: true, target: p.doc }).defaultPrevented, true, "the browser's own Ctrl+K is not run");
  await opened;
  const listed = () => switcherList.children.map((li) => [li.children[0].textContent, li.children[0].href, li.getAttribute("aria-selected")]);
  assert.deepEqual(listed().map(([title]) => title), ["Write the docs", threads[0].title, threads[1].title, threads[2].title, older.title], "every listed thread, the last active first");
  assert.equal(p.doc.activeElement, switcherInput);

  type(switcherInput, "88 charge");
  assert.deepEqual(listed(), [
    [threads[1].title, `/threads/${threads[1].id}`, "true"],
    ["Search archived and deleted threads for “88 charge”", "/threads/closed?q=88+charge", "false"],
  ], "a query narrows the list, and ends it with a search of the closed threads");
  switcherInput.fire("keydown", { key: "ArrowDown" });
  assert.deepEqual(listed().map(([, , selected]) => selected), ["false", "true"]);
  switcherInput.fire("keydown", { key: "ArrowDown" });
  assert.deepEqual(listed().map(([, , selected]) => selected), ["true", "false"], "the pick wraps around");
  assert.equal(switcherInput.getAttribute("aria-activedescendant"), switcherList.children[0].id);
  switcherInput.fire("keydown", { key: "Enter", isComposing: true });
  assert.deepEqual(assigned, [], "an input method's Enter confirms what it composes, and opens nothing");
  switcherInput.fire("keydown", { key: "Enter" });
  assert.deepEqual(assigned, [`/threads/${threads[1].id}`], "Enter opens the picked thread");
  type(switcherInput, "412");
  assert.equal(listed()[0][1], `/threads/${threads[3].id}`, "a pull request's number finds its thread");
  type(switcherInput, "#977");
  assert.equal(listed()[0][1], `/threads/${older.id}`, "and finds a thread the sidebar does not list");

  let closed = new Promise((resolve) => { switcher.closed = resolve; });
  assert.equal(p.doc.fire("keydown", { key: "K", ctrlKey: true, target: switcherInput }).defaultPrevented, true);
  await closed;
  assert.equal(switcher.open, false, "Ctrl+K again closes it");
  const reopened = new Promise((resolve) => { switcher.opened = resolve; });
  p.doc.fire("keydown", { key: "k", ctrlKey: true, target: p.doc });
  await reopened;
  switcherInput.fire("click", { target: switcherInput });
  switcher.fire("click", { target: switcherInput });
  assert.equal(switcher.open, true, "a click inside the dialog keeps it open");
  closed = new Promise((resolve) => { switcher.closed = resolve; });
  switcher.fire("click", { target: switcher });
  await closed;
  assert.equal(switcher.open, false, "a click on its backdrop closes it");
});

test("on a Mac, ⌘K opens the switcher and Ctrl+K is left to the text field, where it deletes to the end of the line", async () => {
  switcher.open = false;
  navigator.platform = "MacIntel";
  const p = page();
  try {
    const find = await load(p);
    find.listRows([]);
    const ctrl = p.doc.fire("keydown", { key: "k", ctrlKey: true, target: p.textarea });
    assert.equal(ctrl.defaultPrevented, false, "Ctrl+K is the text field's");
    const opened = new Promise((resolve) => { switcher.opened = resolve; });
    assert.equal(p.doc.fire("keydown", { key: "k", metaKey: true, target: p.textarea }).defaultPrevented, true);
    await opened;
    assert.equal(switcher.open, true, "⌘K opens it");
    switcher.close();
  } finally { navigator.platform = "Linux x86_64"; }
});
