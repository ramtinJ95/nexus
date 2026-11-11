import { test } from "node:test";
import assert from "node:assert/strict";
import { narrow } from "./contract.ts";

/** An element as page.js, actions.js and keys.js read one, whose innerHTML parses and serializes the markup these tests write. */
class Element {
  constructor(localName, attributes = []) {
    Object.assign(this, { localName, attributes, children: [], parentElement: null, text: "" });
  }
  get id() { return this.getAttribute("id") ?? ""; }
  get hidden() { return this.hasAttribute("hidden"); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(on) {
    if (!on) return this.removeAttribute("disabled");
    this.setAttribute("disabled", "");
    // As a browser's focus fixup does, a focused button that is disabled leaves focus to the body.
    if (document.activeElement === this) document.activeElement = document.body;
  }
  get dataset() {
    const camel = (name) => name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    const attribute = (key) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    return new Proxy(Object.fromEntries(this.attributes.filter((a) => a.name.startsWith("data-")).map((a) => [camel(a.name), a.value])), {
      set: (_, key, value) => { this.setAttribute(attribute(key), value); return true; },
      deleteProperty: (_, key) => { this.removeAttribute(attribute(key)); return true; },
    });
  }
  get isConnected() { let el = this; while (el.parentElement !== null) el = el.parentElement; return el === root; }
  getAttribute(name) { return this.attributes.find((a) => a.name === name)?.value ?? null; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  setAttribute(name, value) { this.removeAttribute(name); this.attributes.push({ name, value: String(value) }); }
  removeAttribute(name) { this.attributes = this.attributes.filter((a) => a.name !== name); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(text) { this.text = text; this.children = []; }
  get innerHTML() { return this.text + this.children.map((c) => `<${c.localName}${c.attributes.map((a) => ` ${a.name}="${a.value}"`).join("")}>${c.innerHTML}</${c.localName}>`).join(""); }
  set innerHTML(markup) { this.text = ""; this.replaceChildren(...parse(markup)); }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = children.map((c) => typeof c === "string" ? Object.assign(new Element("span"), { text: c }) : c);
    for (const child of this.children) child.parentElement = this;
  }
  append(...children) { this.replaceChildren(...this.children, ...children); }
  *all() { for (const child of this.children) { yield child; yield* child.all(); } }
  matches(selector) { return selector.match(/(?:\[[^\]]*\]|[^,[])+/g).some((part) => chain(this, part.match(/(?:\[[^\]]*\]|[^\s[])+/g))); }
  querySelectorAll(selector) { return [...this.all()].filter((el) => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let el = this; el !== null; el = el.parentElement) if (el.matches(selector)) return el; return null; }
  contains(other) { return other === this || [...this.all()].includes(other); }
  addEventListener() {}
  focus() { if (!this.disabled && this.isConnected) document.activeElement = this; }
}
class HTMLElement extends Element {}
class HTMLButtonElement extends HTMLElement {}
class HTMLAnchorElement extends HTMLElement {}
class HTMLInputElement extends HTMLElement { select() {} }
class HTMLTextAreaElement extends HTMLElement {}
class HTMLDetailsElement extends HTMLElement {}
class HTMLDialogElement extends HTMLElement {
  get open() { return this.hasAttribute("open"); }
  showModal() { this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); }
}
const classes = { button: HTMLButtonElement, a: HTMLAnchorElement, input: HTMLInputElement, textarea: HTMLTextAreaElement, dialog: HTMLDialogElement };
const voids = new Set(["input", "br", "img", "meta", "link"]);
/** The elements of markup that holds only elements, attributes in double quotes, and text in leaf elements. */
function parse(markup) {
  const top = new Element("#fragment");
  let at = top;
  for (const [, close, tag, attrs, text] of markup.matchAll(/<(\/)?([a-z\d]+)([^>]*)>|([^<]+)/g)) {
    if (text !== undefined) at.text += text;
    else if (close !== undefined) at = at.parentElement;
    else {
      const el = new (classes[tag] ?? HTMLElement)(tag, [...attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value = ""]) => ({ name, value })));
      at.append(el);
      if (!voids.has(tag)) at = el;
    }
  }
  return top.children;
}
/** Whether `el` matches compound selectors joined by descendant and child combinators. */
function chain(el, steps) {
  if (!compound(el, steps.at(-1))) return false;
  if (steps.length === 1) return true;
  const child = steps.at(-2) === ">";
  const rest = steps.slice(0, child ? -2 : -1);
  for (let up = el.parentElement; up !== null; up = child ? null : up.parentElement) if (chain(up, rest)) return true;
  return false;
}
/** Whether `el` matches one compound selector: a tag, an ID, classes, attributes and `:not([attr])`. */
function compound(el, selector) {
  const m = /^([a-z\d]+)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="(?:[^"\\]|\\.)*")?\])*)$/.exec(selector);
  if (m === null) throw new SyntaxError(`'${selector}' is not a selector these tests read`);
  if (m[1] !== undefined && el.localName !== m[1]) return false;
  return [...m[2].matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]/g)].every(([, id, cls, name, value]) =>
    id !== undefined ? el.id === id
    : cls !== undefined ? (el.getAttribute("class") ?? "").split(" ").includes(cls)
    : value === undefined ? el.hasAttribute(name) : el.getAttribute(name) === value.replace(/\\(.)/g, "$1"));
}

/** The regions of a page that swap, with what the server renders in each. */
const page = (regions) => `<html><body><header class="bar" id="bar" data-live><button type="button" class="icon-btn menu" data-open="side" aria-label="Threads">☰</button>${regions.bar ?? ""}</header><div id="needs-you" data-live>${regions.needs}</div><div id="sessions" data-live>${regions.sessions}</div><div id="projects" data-live>${regions.projects}</div><div id="strip" data-live>${regions.strip}</div><div id="tabs" role="tablist" aria-label="Open views">${regions.tabs ?? ""}</div><main data-poll-ms="60000"><input id="filter"></main><dialog id="keys"><dl id="keys-list"></dl></dialog><dialog id="switcher"></dialog></body></html>`;
const question = (asked) => `<section data-question="q-1"><p>Asked ${asked}</p><button type="button" class="btn" data-action="answer" data-thread="th-1" data-question="q-1" data-option="Rebuild">Rebuild</button><button type="button" class="btn" data-action="answer" data-thread="th-1" data-question="q-1" data-option="Not now">Not now</button></section>`;
const sessions = (address) => `<ul><li>${address}<button type="button" class="btn btn-xs" data-action="show-session" data-thread="th-1" data-address="t1">Show in terminal</button><button type="button" class="btn btn-xs" data-action="close-session" data-thread="th-1" data-session="s-2">Close</button></li></ul><div class="s-new"><button type="button" class="btn btn-xs" data-action="open-session" data-thread="th-1" data-harness="shell">New shell</button></div>`;
const autoReview = (current) => `<span class="auto-review" role="group">${["off", "review", "land"].map((mode) => `<button type="button" class="btn btn-xs" data-action="auto-review" data-project="acme" data-mode="${mode}" aria-pressed="${mode === current}"${mode === current ? " disabled" : ""}>${mode}</button>`).join("")}</span>`;
const strip = (pylon) => `<button type="button" class="mini" data-open="inspect" data-pane="pylon">${pylon}</button><button type="button" class="mini" data-open="inspect" data-pane="pylon">2 outputs</button>`;
const fixedTabs = `<button type="button" class="tab" role="tab" data-tab="convo">acme</button><button type="button" class="tab" role="tab" data-tab="timeline">Timeline</button><button type="button" class="tab" role="tab" data-tab="term" hidden>Terminal</button><div class="tab tab-file"><button type="button" class="tab-pick" role="tab" data-key="pick:a.ts">a.ts</button><button type="button" class="tab-close" data-key="close:a.ts">×</button></div>`;

const regions = { needs: question("just now"), sessions: sessions(""), projects: autoReview("off"), strip: strip("running"), tabs: fixedTabs };
let served = page(regions);
const root = new Element("#document");
root.innerHTML = served;
const body = root.querySelector("body");
const keydowns = [];
const clicks = [];
const posts = [];
const device = new Map();
let phone = false;
// Node has a navigator of its own, which says Mac on a Mac.
Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64" }, configurable: true });
Object.assign(globalThis, {
  Element, HTMLElement, HTMLButtonElement, HTMLDetailsElement, HTMLAnchorElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement: class extends HTMLElement {},
  CSS: { escape: (value) => value.replace(/["\\]/g, "\\$&") },
  EventSource: { OPEN: 1, CLOSED: 2 },
  location: { href: "http://nexus.test/", pathname: "/", search: "", hash: "" },
  localStorage: { getItem: (k) => device.get(k) ?? null, setItem: (k, v) => void device.set(k, String(v)), removeItem: (k) => void device.delete(k) },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  addEventListener() {},
  matchMedia: (query) => ({ get matches() { return query === narrow && phone; }, addEventListener() {} }),
  MutationObserver: class { observe() {} },
  DOMParser: class { parseFromString(markup) { const doc = new Element("#document"); doc.innerHTML = markup; return Object.assign(doc, { getElementById: (id) => doc.querySelector(`#${id}`) }); } },
  fetch: async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") return new Response(served, { status: 200 });
    const { pathname } = new URL(url, location.href);
    return new Promise((resolve) => posts.push({ path: pathname, resolve }));
  },
  document: {
    documentElement: root.querySelector("html"),
    body,
    activeElement: body,
    visibilityState: "visible",
    getElementById: (id) => root.querySelector(`#${id}`),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    createElement: (tag) => new (classes[tag] ?? HTMLElement)(tag),
    addEventListener: (type, listener) => { if (type === "keydown") keydowns.push(listener); if (type === "click") clicks.push(listener); },
  },
});
const { refreshNow } = await import("./page.js");
await import("./actions.js");
await import("./keys.js");
await import("./nav.js");
// The first ? loads the overlay. Loading it here first lets a press show it within a turn of the event loop.
await import("./shortcuts.js");

const button = (selector) => document.querySelector(selector);
const focused = () => document.activeElement === document.body ? "the body" : `${document.activeElement.textContent} (${document.activeElement.isConnected ? "in the page" : "gone"})`;
async function poll(changes) {
  served = page({ ...regions, ...changes });
  await refreshNow();
}
function press(key, target = document.activeElement, more = {}) {
  const event = { key, target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...more };
  for (const listener of keydowns) listener(event);
  return event;
}
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a button with no ID keeps focus when its region is swapped: an answer, a session's and an auto-review mode", async () => {
  button('[data-option="Not now"]').focus();
  await poll({ needs: question("a minute ago") });
  assert.equal(focused(), "Not now (in the page)", "the answer the person was on");

  button('[data-harness="shell"]').focus();
  await poll({ sessions: sessions("w-1:p-1") });
  assert.equal(focused(), "New shell (in the page)", "the session button");

  button('[data-mode="review"]').focus();
  await poll({ projects: `${autoReview("off")}<p>edited by laptop</p>` });
  assert.equal(focused(), "review (in the page)", "the auto-review mode");

  document.querySelectorAll('[data-pane="pylon"]')[1].focus();
  await poll({ strip: strip("paused") });
  assert.equal(focused(), "2 outputs (in the page)", "the same one of two buttons that carry the same attributes");
});

/** Answers the action's POST to `path` with `status`, and lets the action finish. */
async function answer(path, status) {
  await settled();
  const at = posts.findIndex((p) => p.path === path);
  assert.notEqual(at, -1, `${path} was posted`);
  const [post] = posts.splice(at, 1);
  post.resolve(status === 200 ? new Response("{}", { status, headers: { "content-type": "application/json" } })
    : new Response(JSON.stringify({ error: { code: "conflict", message: "The question was answered from another device." } }), { status, headers: { "content-type": "application/json" } }));
  for (let i = 0; i < 4; i++) await settled();
}
const click = (target) => { for (const listener of clicks) void listener({ target }); };

test("a pressed button that its action disables has focus again on the button that replaced it, or on itself when the action failed", async () => {
  await poll({});
  const rebuild = button('[data-option="Rebuild"]');
  rebuild.focus();
  click(rebuild);
  served = page({ ...regions, needs: question("a minute ago") });
  await answer("/v1/questions/q-1/answer", 200);
  assert.equal(focused(), "Rebuild (in the page)", "the swap after the answer puts focus on the new Rebuild");
  assert.notEqual(document.activeElement, rebuild, "the old button was replaced");

  const notNow = button('[data-option="Not now"]');
  notNow.focus();
  click(notNow);
  await answer("/v1/questions/q-1/answer", 409);
  assert.equal(focused(), "Not now (in the page)", "a refused answer leaves focus on the button, enabled to press again");
  assert.equal(notNow.disabled, false);
});

test("an action that ends after the person pressed another leaves focus to the newer one", async () => {
  await poll({});
  const notNow = button('[data-option="Not now"]');
  notNow.focus();
  click(notNow);
  const off = button('[data-mode="review"]');
  off.focus();
  click(off);
  await answer("/v1/questions/q-1/answer", 409);
  assert.equal(focused(), "the body", "the refused answer does not take focus from the auto-review press that runs");
  served = page({ ...regions, projects: `${autoReview("off")}<p>edited by laptop</p>` });
  await answer("/v1/projects/acme", 200);
  assert.equal(focused(), "review (in the page)", "the newer press has its focus back after its swap");
});

test("the arrow keys, Home and End move between a tab list's tabs, past a hidden one, and wrap", () => {
  const tabs = () => document.querySelectorAll('[role="tab"]');
  tabs()[0].focus();
  assert.equal(press("ArrowRight").defaultPrevented, true);
  assert.equal(focused(), "Timeline (in the page)");
  press("ArrowRight");
  assert.equal(focused(), "a.ts (in the page)", "the hidden Terminal tab is skipped");
  press("ArrowRight");
  assert.equal(focused(), "acme (in the page)", "the last tab wraps to the first");
  press("ArrowLeft");
  assert.equal(focused(), "a.ts (in the page)", "the first wraps to the last");
  press("Home");
  assert.equal(focused(), "acme (in the page)");
  press("End");
  assert.equal(focused(), "a.ts (in the page)");
  assert.equal(press("ArrowRight", document.activeElement, { altKey: true }).defaultPrevented, false, "a modified arrow is the browser's");
  button(".tab-close").focus();
  assert.equal(press("ArrowRight").defaultPrevented, false, "a file tab's close button is not a tab");
  const loose = new HTMLButtonElement("button", [{ name: "role", value: "tab" }]);
  document.body.append(loose);
  loose.focus();
  assert.equal(press("ArrowRight").defaultPrevented, false, "a tab outside a tab list is left alone");
  document.body.replaceChildren(...document.body.children.filter((el) => el !== loose));
});

test("? lists the shortcuts the page has, and not while the person types or a dialog is open", async () => {
  const overlay = document.getElementById("keys");
  assert.equal(press("?", button("#filter")).defaultPrevented, false, "? typed in the filter is text");
  assert.equal(overlay.open, false);

  assert.equal(press("?", document.body).defaultPrevented, true);
  await settled();
  assert.equal(overlay.open, true);
  const rows = document.getElementById("keys-list").children;
  const listed = [];
  for (let i = 0; i < rows.length; i += 2) listed.push(`${rows[i].children.map((k) => k.textContent).join("+")} ${rows[i + 1].textContent}`);
  assert.deepEqual(listed, [
    "? Show these shortcuts",
    "/ Filter threads",
    "Ctrl+K Go to a thread",
    "←+→+Home+End Move between tabs, or to the first or the last",
    "Esc Close a dialog, a panel or a preview",
  ], "only the shortcuts this page has: it has no start dialog, composer or diff");

  assert.equal(press("?", document.body).defaultPrevented, false, "a second ? with the overlay open does nothing");
  overlay.close();

  const fileView = (new HTMLElement("section", [{ name: "id", value: "file-view" }, { name: "hidden", value: "" }]));
  document.body.append(fileView);
  press("?", document.body);
  await settled();
  const diffRows = [];
  const shown = document.getElementById("keys-list").children;
  for (let i = 0; i < shown.length; i += 2) diffRows.push(`${shown[i].children.map((k) => k.textContent).join("+")} ${shown[i + 1].textContent}`);
  assert.deepEqual(diffRows.filter((row) => row.includes("diff")), [
    "[+] In a diff, open the previous or the next changed file",
    "J+K In a diff, move through its lines, with Shift to select them",
    "C+Q+S+R In a diff, note the selected lines: comment, question, suggestion, requested change",
  ], "a thread page, which has a diff view, lists the diff's keys");
  overlay.close();
  document.body.replaceChildren(...document.body.children.filter((el) => el !== fileView));
});

test("above a phone's width the menu button folds the sidebar away, the device keeps the fold, and / unfolds it for the filter", async () => {
  const html = document.documentElement;
  const click = (target) => { for (const listener of clicks) listener({ target }); };
  const expanded = () => button(".bar .menu").getAttribute("aria-expanded");
  assert.equal(expanded(), "true", "the threads show on a page loaded without a fold");

  click(button(".bar .menu"));
  assert.equal(html.dataset.side, "folded");
  assert.equal(device.get("nexus.side"), "folded", "the device keeps the fold for the next page's head script");
  assert.equal(document.body.dataset.open, undefined, "a wide window opens no drawer");
  assert.equal(expanded(), "false");

  const before = button(".bar .menu");
  await poll({ bar: "<h1>Renamed</h1>" });
  assert.notEqual(button(".bar .menu"), before, "the poll swapped the bar in");
  assert.equal(expanded(), "false", "and the bar it swapped in says the threads are folded too");

  document.activeElement = document.body;
  assert.equal(press("/").defaultPrevented, true);
  assert.equal(html.dataset.side, undefined, "/ unfolds the sidebar, whose filter it focuses");
  assert.equal(device.has("nexus.side"), false);
  assert.equal(document.activeElement, button("#filter"));
  assert.equal(expanded(), "true");

  phone = true;
  click(button(".bar .menu"));
  assert.equal(document.body.dataset.open, "side", "a phone's menu button opens the drawer");
  assert.equal(html.dataset.side, undefined, "and folds nothing");
  assert.equal(expanded(), "true");
  phone = false;
  click(button("#filter"));
  assert.equal(html.dataset.side, undefined, "a click in a window widened past a phone's, with its drawer still named open, folds nothing");
  phone = true;
  click(button(".bar .menu"));
  assert.equal(document.body.dataset.open, undefined);
  assert.equal(expanded(), "false");
  phone = false;
});
