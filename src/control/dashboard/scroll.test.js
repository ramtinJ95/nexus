import { test } from "node:test";
import assert from "node:assert/strict";
import { endFollower } from "./scroll.js";

/** A scroller as a browser keeps it: scrollTop stays between 0 and the end, and a scroll event follows each change. */
class Scroller extends EventTarget {
  #top = 0;
  #resized = () => {};
  constructor(scrollHeight, clientHeight) {
    super();
    Object.assign(this, { scrollHeight, clientHeight });
  }
  get scrollTop() { return this.#top; }
  set scrollTop(value) {
    const top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    if (top === this.#top) return;
    this.#top = top;
    this.dispatchEvent(new Event("scroll"));
  }
  observe = (callback) => { this.#resized = callback; };
  resize(clientHeight) {
    this.clientHeight = clientHeight;
    this.#resized();
  }
  /** A fold inside opens, which grows the content under the reader and scrolls nothing. */
  unfold(by) {
    this.scrollHeight += by;
    this.dispatchEvent(new Event("toggle"));
  }
}
const scroller = (scrollHeight, clientHeight) => new Scroller(scrollHeight, clientHeight);
const fromEnd = (el) => el.scrollHeight - el.clientHeight - el.scrollTop;

test("a reader at the end stays there when the scroller shrinks, as when a phone's keyboard opens", () => {
  const el = scroller(3000, 800);
  const end = endFollower(el, el.observe);
  end.toEnd();
  el.resize(500);
  assert.equal(fromEnd(el), 0);
  el.scrollHeight = 3200;
  end.settle();
  assert.equal(fromEnd(el), 0, "the next reply is followed too");
});

test("a reader who scrolled up keeps their place while the scroller shrinks and the conversation grows", () => {
  const el = scroller(3000, 800);
  const end = endFollower(el, el.observe);
  end.toEnd();
  el.scrollTop = 600;
  el.resize(500);
  el.scrollHeight = 3200;
  end.settle();
  assert.equal(el.scrollTop, 600);
  assert.equal(end.following, false);
});

test("a reader who scrolls back to the end follows it again", () => {
  const el = scroller(3000, 800);
  const end = endFollower(el, el.observe);
  el.scrollTop = 600;
  el.scrollTop = 2190;
  assert.equal(end.following, true, "within a line of the end counts as the end");
  el.resize(500);
  assert.equal(fromEnd(el), 0);
});

test("a reader who left the end for a diff tab is back at it when the conversation shows again", () => {
  const el = scroller(3000, 800);
  const end = endFollower(el, el.observe);
  end.toEnd();
  el.scrollHeight = 3600;
  end.settle();
  assert.equal(fromEnd(el), 0);
});

test("a reader at the end who opens a fold reads it, rather than being taken past it by the next reply", () => {
  const el = scroller(3000, 800);
  const end = endFollower(el, el.observe);
  end.toEnd();
  el.unfold(1000);
  el.scrollHeight += 200;
  end.settle();
  assert.equal(el.scrollTop, 2200);
});
