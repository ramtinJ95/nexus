import { test } from "node:test";
import assert from "node:assert/strict";
import { composerDraft } from "./draft.js";
import { keeping } from "./contract.ts";

test("a draft stays in its thread's composer across a page load until it is sent, and text typed since the send stays", () => {
  const items = new Map();
  const kept = keeping(() => ({ getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) }));
  const load = (thread) => {
    const prompt = { value: "", form: { dataset: { thread } } };
    const document = { getElementById: (id) => id === "prompt-text" ? prompt : null };
    const draft = composerDraft({ kept }, { document });
    draft.restore();
    return { prompt, draft };
  };

  const first = load("th-0123456789ab");
  first.prompt.value = "half typed";
  first.draft.save(first.prompt);
  assert.equal(load("th-0123456789ab").prompt.value, "half typed", "the draft is back after a page load");
  assert.equal(load("th-ba9876543210").prompt.value, "", "another thread's composer does not take it");

  const page = load("th-0123456789ab");
  page.draft.sent("th-0123456789ab", "half typed");
  assert.equal(page.prompt.value, "", "a sent message leaves the composer");
  assert.deepEqual([...items.keys()], [], "and leaves storage");
  assert.equal(load("th-0123456789ab").prompt.value, "", "a page load after the send shows an empty composer");

  page.prompt.value = "the next one";
  page.draft.save(page.prompt);
  page.draft.sent("th-0123456789ab", "half typed");
  assert.equal(page.prompt.value, "the next one", "text typed since the send stays in the composer");
  assert.equal(load("th-0123456789ab").prompt.value, "the next one", "and stays the draft");
});

test("a thread archived while its message went out drops the draft it sent, and keeps one typed since", () => {
  const items = new Map([["nexus.draft.th-0123456789ab", "sent text"]]);
  const kept = keeping(() => ({ getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) }));
  const draft = composerDraft({ kept }, { document: { getElementById: () => null } });
  draft.sent("th-0123456789ab", "other text");
  assert.equal(items.get("nexus.draft.th-0123456789ab"), "sent text", "a draft other than the message sent stays");
  draft.sent("th-0123456789ab", "sent text");
  assert.equal(items.has("nexus.draft.th-0123456789ab"), false, "the draft that was sent goes");
});
