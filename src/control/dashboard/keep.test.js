import { test } from "node:test";
import assert from "node:assert/strict";
import { swapKeeping } from "./keep.js";
import { composer } from "./conversation.ts";

class FakeNode {
  constructor(localName, text = "") {
    this.localName = localName;
    this.text = text;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
  }
  get id() { return this.attributes.get("id") ?? ""; }
  getAttributeNames() { return [...this.attributes.keys()]; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  remove() {
    if (this.parentNode === null) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  insertBefore(node, ref) {
    node.remove();
    const at = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
    if (at === -1) throw new Error("the reference node is not a child");
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  /** Only the `[name]` selector the swap uses. */
  querySelector(selector) {
    const name = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    if (name === undefined) throw new Error(`unsupported selector ${selector}`);
    for (const child of this.childNodes) {
      if (child.attributes.has(name)) return child;
      const found = child.querySelector(selector);
      if (found !== null) return found;
    }
    return null;
  }
  get textContent() { return this.text + this.childNodes.map((c) => c.textContent).join(""); }
}

/** The fragment a template makes of the server's markup, as far as the composer's markup needs. */
function parse(markup) {
  const fragment = new FakeNode(null);
  let open = fragment;
  for (const [, close, name, attrs, selfClosing, text] of markup.matchAll(/<\/([\w-]+)>|<([\w-]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (close !== undefined) open = open.parentNode;
    else if (text !== undefined) open.insertBefore(new FakeNode("#text", text), null);
    else {
      const el = open.insertBefore(new FakeNode(name), null);
      for (const [, attr, value] of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(attr, value ?? "");
      if (selfClosing === "") open = el;
    }
  }
  return fragment;
}

const descendants = (node) => node.childNodes.flatMap((c) => [c, ...descendants(c)]);
const byId = (node, id) => descendants(node).find((n) => n.id === id);
const detail = (status) => ({ thread: { id: "th-0123456789ab", status, project: "acme" }, pylon: { actualState: "running", failed: null, retryRefused: null } });
const markup = (status, run) => composer(detail(status), "harness", run, null, null, 0).text;
const idle = { kind: "idle", paused: false, repliedAt: null };
const working = { kind: "working", since: null, tools: 0, claude: false };

test("a swap from Send to Steer keeps the prompt box the same element and updates everything around it", () => {
  const region = new FakeNode("div");
  region.setAttribute("id", "composer");
  region.setAttribute("data-live", "");
  for (const node of [...parse(markup("idle", idle)).childNodes]) region.insertBefore(node, null);
  const box = byId(region, "prompt-text");
  box.value = "half typed";
  assert.equal(byId(region, "queue"), undefined);

  const fresh = parse(markup("idle", working));
  const freshBox = byId(fresh, "prompt-text");
  swapKeeping(region, fresh);

  assert.equal(byId(region, "prompt-text"), box, "the prompt box is the same element");
  assert.equal(box.value, "half typed");
  assert.equal(box.getAttribute("placeholder"), freshBox.getAttribute("placeholder"));
  assert.equal(box.getAttribute("placeholder"), "Steer the run…");
  assert.match(byId(region, "prompt").getAttribute("class"), /composer-steer/);
  assert.equal(byId(region, "send").textContent.includes("Steer"), true);
  assert.notEqual(byId(region, "queue"), undefined, "the Queue button shows");
  assert.equal(descendants(region).some((n) => n.getAttribute("class")?.includes("comp-hint")), true, "the hint shows");
  assert.deepEqual([region.getAttribute("id"), region.getAttribute("data-live")], ["composer", ""], "the region's own attributes are untouched");
});

test("a swap to markup without the prompt box, as on archiving, replaces the region's content", () => {
  const region = new FakeNode("div");
  for (const node of [...parse(markup("idle", idle)).childNodes]) region.insertBefore(node, null);
  swapKeeping(region, parse(markup("archived", idle)));
  assert.equal(byId(region, "prompt-text"), undefined);
  assert.match(region.textContent, /An archived thread takes no messages/);
});
