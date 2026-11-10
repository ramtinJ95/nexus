import { test } from "node:test";
import assert from "node:assert/strict";

/** A node as the conversation's swap reads and writes one, with a template's parse and serialization. */
class FakeNode extends EventTarget {
  constructor(localName, text = "") {
    super();
    Object.assign(this, { localName, text, attributes: new Map(), childNodes: [], parentNode: null, dataset: {}, hidden: false });
  }
  get nodeType() { return this.localName === "#text" ? 3 : this.localName === null ? 11 : 1; }
  get id() { return this.attributes.get("id") ?? ""; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get isConnected() { return this.parentNode === null ? this === root : this.parentNode.isConnected; }
  get textContent() { return this.nodeType === 3 ? this.text : this.childNodes.map((c) => c.textContent).join(""); }
  get innerHTML() { return this.childNodes.map((c) => c.outerHTML).join(""); }
  set innerHTML(markup) {
    for (const child of [...this.childNodes]) child.remove();
    for (const child of [...parse(markup).childNodes]) this.append(child);
  }
  get outerHTML() {
    if (this.nodeType === 3) return this.text;
    const attrs = [...this.attributes].map(([name, value]) => ` ${name}="${value}"`).join("");
    return `<${this.localName}${attrs}>${this.innerHTML}</${this.localName}>`;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  remove() {
    if (this.parentNode === null) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      this.childNodes.push(node);
      node.parentNode = this;
    }
  }
  replaceWith(node) {
    const parent = this.parentNode;
    node.remove();
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1, node);
    node.parentNode = parent;
    this.parentNode = null;
  }
  contains(node) { for (let n = node; n instanceof FakeNode; n = n.parentNode) if (n === this) return true; return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { top: 0, bottom: 0 }; }
}

/** A template's content: a fragment of the markup's elements and text, as far as the test's markup needs. */
function parse(markup) {
  const fragment = new FakeNode(null);
  let open = fragment;
  for (const [, close, name, attrs, text] of markup.matchAll(/<\/([\w-]+)>|<([\w-]+)((?:\s+[\w-]+="[^"]*")*)\s*>|([^<]+)/g)) {
    if (close !== undefined) open = open.parentNode;
    else if (text !== undefined) open.append(new FakeNode("#text", text));
    else {
      const el = new FakeNode(name);
      for (const [, attr, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(attr, value);
      open.append(el);
      open = el;
    }
  }
  return fragment;
}

/** A template, whose markup parses into its content rather than its children. */
class Template extends FakeNode {
  content = new FakeNode(null);
  get innerHTML() { return this.content.innerHTML; }
  set innerHTML(markup) { this.content = parse(markup); }
}

/** A scroller as a browser keeps it: scrollTop stays between 0 and the end, and a scroll event follows each change. */
class Scroller extends FakeNode {
  #top = 0;
  scrollHeight = 3000;
  clientHeight = 800;
  get scrollTop() { return this.#top; }
  set scrollTop(value) {
    const top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    if (top === this.#top) return;
    this.#top = top;
    this.dispatchEvent(new Event("scroll"));
  }
}

const root = new FakeNode("body");
const scroller = new Scroller("div");
scroller.setAttribute("id", "scroll");
const convo = new FakeNode("div");
convo.setAttribute("id", "convo");
convo.innerHTML = `<div class="msg">first reply</div><div class="tools">running</div>`;
const jump = new FakeNode("button");
jump.setAttribute("id", "jump-end");
jump.hidden = true;
scroller.append(convo, jump);
root.append(scroller);

const ids = new Map([["scroll", scroller], ["convo", convo], ["jump-end", jump]]);
const sources = [];
Object.assign(globalThis, {
  Node: { ELEMENT_NODE: 1 },
  ResizeObserver: class { observe() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  EventSource: Object.assign(class extends EventTarget {
    readyState = 1;
    constructor(url) { super(); this.url = url; sources.push(this); }
  }, { OPEN: 1, CLOSED: 2 }),
  document: {
    visibilityState: "visible",
    activeElement: null,
    querySelector: () => null,
    querySelectorAll: (s) => s === "[data-live]" ? [convo] : [],
    getElementById: (id) => ids.get(id) ?? null,
    createElement: (tagName) => tagName === "template" ? new Template(tagName) : new FakeNode(tagName),
    addEventListener() {},
  },
});
const { end, follow } = await import("./page.js");
follow("/threads/th-0123456789ab/stream");
const send = (frame) => sources.at(-1).dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(frame) }));

test("a frame that adds a block keeps the blocks before it, so a selection in an earlier reply survives the run", () => {
  end.toEnd();
  const [reply, running] = convo.childNodes;
  const selection = { anchorNode: reply.childNodes[0], focusNode: reply.childNodes[0] };
  send({ convo: `<div class="msg">first reply</div><div class="tools">done</div><div class="msg">second reply</div>`, shows: "k1" });

  assert.equal(convo.childNodes[0], reply, "the unchanged reply is the same element");
  assert.equal(reply.isConnected, true);
  assert.equal(selection.anchorNode.isConnected && selection.focusNode.isConnected, true, "the selection's nodes are still in the document");
  assert.equal(running.isConnected, false, "the block whose markup changed is replaced");
  assert.equal(convo.childNodes[1].textContent, "done");
  assert.equal(convo.childNodes[2].textContent, "second reply", "the new block is appended");
  assert.equal(convo.childNodes.length, 3);

  send({ convo: `<div class="msg">first reply</div>`, shows: "k2" });
  assert.deepEqual(convo.childNodes, [reply], "blocks past the fresh ones are removed, and the first still stays");
});

test("Jump to latest shows while the reader is up the conversation, marks what arrived, and takes them back to the end", () => {
  end.toEnd();
  assert.equal(jump.hidden, true, "hidden while the reader follows the end");
  send({ convo: `<div class="msg">first reply</div><div class="msg">more</div>`, shows: "k3" });
  assert.equal(jump.dataset.fresh, undefined, "a reader at the end sees what arrived");

  scroller.scrollTop = 600;
  assert.equal(jump.hidden, false, "shown once the reader scrolls up");
  assert.equal(jump.dataset.fresh, undefined, "nothing new yet");
  send({ convo: `<div class="msg">first reply</div><div class="msg">more</div><div class="msg">and more</div>`, shows: "k4" });
  assert.equal(jump.dataset.fresh, "", "marked once more arrived below the reader");

  jump.dispatchEvent(new Event("click"));
  assert.equal(scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight, "back at the end");
  assert.equal(end.following, true);
  assert.equal(jump.hidden, true, "hidden again");
  assert.equal(jump.dataset.fresh, undefined, "the mark clears");
});
