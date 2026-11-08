import { test } from "node:test";
import assert from "node:assert/strict";
import { factsData, factsOf, growParts, noticeHash, noticeOf, unticked, type Facts } from "./contract.ts";
import { dataset, grows, growing, html, since } from "./view.ts";

/** An element's `data-*` attributes as the browser's `dataset` reads them. */
const datasetOf = (markup: string) => Object.fromEntries([...markup.matchAll(/ data-([\w-]+)="([^"]*)"/g)]
  .map(([, name, value]) => [name!.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()), value!]));

test("a thread page's facts read back as the server wrote them", () => {
  const open: Facts = { pylon: "running", turn: true, agentAt: 1_800_000_000_000, status: "idle", open: true };
  const archived: Facts = { pylon: "paused", turn: false, agentAt: 0, status: "archived", open: false };
  for (const facts of [open, archived]) assert.deepEqual(factsOf(datasetOf(html`<span${dataset(factsData(facts))}></span>`.text)), facts);
});

test("a region's growing parts come apart from its shape, which stays the same as they grow", () => {
  const region = (out: string) => html`<p>Bash</p><pre${growing}>${grows(out)}</pre><div${growing}>${grows("a <b>")}</div>`.text;
  const before = growParts(region("one"));
  const after = growParts(region("one\ntwo"));
  assert.deepEqual([before.parts, after.parts], [["one", "a &lt;b&gt;"], ["one\ntwo", "a &lt;b&gt;"]]);
  assert.equal(before.shape, after.shape);
});

test("a run clock's ticking is no change to its region, and a new start is", () => {
  const region = (at: number, now: number) => unticked(html`<p>working ${since(at, now)}</p>`.text);
  assert.equal(region(1000, 5000), region(1000, 65_000));
  assert.notEqual(region(1000, 5000), region(2000, 5000));
});

test("a notice's hash names the thread and the attention its card is for", () => {
  assert.deepEqual(noticeOf(noticeHash("th-0123456789ab", "decision")), { thread: "th-0123456789ab", attention: "decision" });
  assert.equal(noticeOf("#needs-you"), null);
});
