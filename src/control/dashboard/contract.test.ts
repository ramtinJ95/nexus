import { test } from "node:test";
import assert from "node:assert/strict";
import { factsData, factsOf, growParts, keeping, noticeHash, noticeOf, storageKeys, unticked, type Facts, type Storage } from "./contract.ts";
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

test("storage that refuses reads or writes, or is missing, reads as nothing and keeps nothing, without throwing", () => {
  const refused = (): never => { throw new DOMException("The operation is insecure.", "SecurityError"); };
  const refusing: Storage = { getItem: refused, setItem: refused, removeItem: refused };
  for (const storage of [() => refusing, () => undefined, refused]) {
    const { read, write } = keeping(storage);
    write(storageKeys.pane, "changes");
    write(storageKeys.pane, null);
    assert.equal(read(storageKeys.pane), null);
  }
});

test("kept storage reads back what was written, and a null write removes it", () => {
  const items = new Map<string, string>();
  const { read, write } = keeping(() => ({ getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) }));
  write(storageKeys.review("th-0123456789ab"), "{}");
  assert.deepEqual([read(storageKeys.review("th-0123456789ab")), [...items.keys()]], ["{}", ["nexus.review.th-0123456789ab"]]);
  write(storageKeys.review("th-0123456789ab"), null);
  assert.equal(read(storageKeys.review("th-0123456789ab")), null);
});
