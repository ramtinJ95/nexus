/** Questions whose subject is a node, and the migration that lets a question name no thread. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRegistry } from "./registry.ts";
import { rewindTo, versionBefore } from "./schema-kit.ts";
import { seedRegistry, testPylon, testRegistry, testThread } from "./test-kit.ts";
import { tempDir } from "../test-kit.ts";
import { cleanupQuestion } from "./cleanup-model.ts";
import type { NodeName, TailnetNodeId, ThreadId } from "../ids.ts";

const dir = await tempDir("nexus-node-questions-");
const node = "rj-firebat" as NodeName;
const thread = testThread({ id: "th-1" as ThreadId });
const migration = /CREATE TABLE questions_by_subject\b/;

test("the migration keeps every thread question as it was, in its order, answered or not, and its thread's attention", (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const before = openRegistry(path);
  seedRegistry(before);
  before.createThread(thread, testPylon(thread));
  const ask = { thread: thread.id, options: ["Yes", "No"], reserved: null, answerer: "person" as const, askedAt: 5 };
  before.askQuestion({ ...ask, id: "qn-b", text: "First?" });
  before.askQuestion({ ...ask, id: "qn-a", text: "Second?", reserved: "image-rebuild", answerer: "deployer" });
  before.askQuestion({ ...ask, id: "qn-c", text: "Third?", askedAt: 4 });
  before.answerQuestion("qn-c", { option: "No", by: "nLAPTOP" as TailnetNodeId, at: 6 });
  const questions = before.questions(thread.id);
  before.close();
  rewindTo(path, versionBefore(migration));
  const old = new DatabaseSync(path);
  const rows = old.prepare("SELECT rowid, id, thread, record FROM questions ORDER BY rowid").all();
  assert.equal(old.prepare("SELECT \"notnull\" FROM pragma_table_info('questions') WHERE name = 'thread'").get()!.notnull, 1, "the old table needs a thread");
  old.close();

  const after = testRegistry(t, path);
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  assert.deepEqual(raw.prepare("SELECT rowid, id, thread, record FROM questions ORDER BY rowid").all(), rows, "each row, its rowid and its record are as they were");
  assert.deepEqual(after.questions(thread.id), questions);
  assert.equal(after.attention(thread.id), "decision", "the open questions still need the person");
  assert.deepEqual(after.openNodeQuestions(), []);
});

test("a node question round-trips with its items and outcomes, holds no thread's attention, and a question names a thread or a node, never both", (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const registry = seedRegistry(openRegistry(path));
  registry.createThread(thread, testPylon(thread));
  const asked = cleanupQuestion(node, [
    { kind: "template", id: "tpl-0000000000a1", project: null, bytes: 2048 },
    { kind: "release", name: "a".repeat(40), commit: "a".repeat(40), bytes: 1024 },
  ], 7);
  const stored = registry.askQuestion(asked);
  assert.deepEqual(stored, { ...asked, answer: null });
  assert.deepEqual(registry.nodeQuestions(node), [stored]);
  assert.deepEqual(registry.openNodeQuestions(), [stored]);
  assert.equal(registry.attention(thread.id), null, "a node question is no thread's decision");

  const answer = { option: "Delete", by: "nLAPTOP" as TailnetNodeId, at: 8 };
  registry.answerQuestion(stored.id, answer);
  registry.recordCleanup(stored.id, { "tpl-0000000000a1": { state: "deleted", bytes: 2048 } });
  registry.recordCleanup(stored.id, { "tpl-0000000000a1": { state: "gone" }, [`release-${"a".repeat(40)}`]: { state: "skipped", reason: "process 7 runs from it" } });
  registry.close();
  const reopened = testRegistry(t, path);
  assert.deepEqual(reopened.question(stored.id), {
    ...asked, answer,
    cleanup: { ...asked.cleanup, outcomes: { "tpl-0000000000a1": { state: "deleted", bytes: 2048 }, [`release-${"a".repeat(40)}`]: { state: "skipped", reason: "process 7 runs from it" } } },
  }, "the first report of each item stands");
  assert.deepEqual(reopened.openNodeQuestions(), []);
  assert.deepEqual(reopened.questions(thread.id), []);

  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  const insert = raw.prepare("INSERT INTO questions (id, thread, node, record) VALUES (?, ?, ?, '{}')");
  assert.throws(() => insert.run("both", thread.id, node), /CHECK constraint failed/);
  assert.throws(() => insert.run("neither", null, null), /CHECK constraint failed/);
});
