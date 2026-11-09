/** Questions whose subject is a node, the migration that lets a question name no thread, and the one that names each question's kind. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRegistry } from "./registry.ts";
import { migrations } from "./schema.ts";
import { askRecord, type Question } from "./questions.ts";
import { rewindTo, versionBefore } from "../test-support/schema-kit.ts";
import { seedRegistry, testPylon, testRegistry, testThread } from "../test-support/registry-kit.ts";
import { tempDir } from "../test-support/kit.ts";
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
  before.threads.createThread(thread, testPylon(thread));
  const ask = { thread: thread.id, options: ["Yes", "No"], answerer: "person" as const, askedAt: 5 };
  before.questions.askQuestion({ kind: "judgment", ...ask, id: "qn-b", text: "First?", failure: 0, reserved: null });
  before.questions.askQuestion({ kind: "holds", ...ask, id: "qn-a", text: "Second?", reserved: "image-rebuild", answerer: "deployer", holds: { review: "rv-1", head: "h", base: null, holds: [] } });
  before.questions.askQuestion({ kind: "judgment", ...ask, id: "qn-c", text: "Third?", askedAt: 4, failure: 0, reserved: null });
  before.questions.answerQuestion(before.questions.question("qn-c")!, { option: "No", by: "nLAPTOP" as TailnetNodeId, at: 6 });
  const questions = before.questions.questions(thread.id);
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
  assert.deepEqual(after.questions.questions(thread.id), questions);
  assert.equal(after.threads.attention(thread.id), "decision", "the open questions still need the person");
  assert.deepEqual(after.questions.openNodeQuestions(), []);
});

test("a node question round-trips with its items and outcomes, holds no thread's attention, and a question names a thread or a node, never both", (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const registry = seedRegistry(openRegistry(path));
  registry.threads.createThread(thread, testPylon(thread));
  const asked = cleanupQuestion(node, [
    { kind: "template", id: "tpl-0000000000a1", project: null, bytes: 2048 },
    { kind: "release", name: "a".repeat(40), commit: "a".repeat(40), bytes: 1024 },
  ], 7);
  const stored = registry.questions.askQuestion(asked);
  assert.deepEqual(stored, { ...asked, answer: null });
  assert.deepEqual(registry.questions.nodeQuestions(node), [stored]);
  assert.deepEqual(registry.questions.openNodeQuestions(), [stored]);
  assert.equal(registry.threads.attention(thread.id), null, "a node question is no thread's decision");

  const answer = { option: "Delete", by: "nLAPTOP" as TailnetNodeId, at: 8 };
  registry.questions.answerQuestion(stored, answer);
  registry.questions.recordCleanup(stored.id, { "tpl-0000000000a1": { state: "deleted", bytes: 2048 } });
  registry.questions.recordCleanup(stored.id, { "tpl-0000000000a1": { state: "gone" }, [`release-${"a".repeat(40)}`]: { state: "skipped", reason: "process 7 runs from it" } });
  registry.close();
  const reopened = testRegistry(t, path);
  assert.deepEqual(reopened.questions.question(stored.id), {
    ...asked, answer,
    cleanup: { ...asked.cleanup, outcomes: { "tpl-0000000000a1": { state: "deleted", bytes: 2048 }, [`release-${"a".repeat(40)}`]: { state: "skipped", reason: "process 7 runs from it" } } },
  }, "the first report of each item stands");
  assert.deepEqual(reopened.questions.openNodeQuestions(), []);
  assert.deepEqual(reopened.questions.questions(thread.id), []);

  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  const insert = raw.prepare("INSERT INTO questions (id, thread, node, record) VALUES (?, ?, ?, '{}')");
  assert.throws(() => insert.run("both", thread.id, node), /CHECK constraint failed/);
  assert.throws(() => insert.run("neither", null, null), /CHECK constraint failed/);
});

test("the kind migration names each stored question's kind from the field it held, keeps every other field, and changes nothing applied again", (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const before = seedRegistry(openRegistry(path));
  before.threads.createThread(thread, testPylon(thread));
  const base = { thread: thread.id, text: "Go?", options: ["Yes", "No"], reserved: null, answerer: "person" as const, askedAt: 5 };
  before.questions.askQuestion({ ...base, kind: "proposal", id: "plan:th-1:b1:01", proposal: { block: "b1", index: 1, key: "a", title: "A", brief: "Build A.", after: [] } });
  before.questions.askQuestion(askRecord(thread.id, { session: "s1", toolUseId: "toolu_1", questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "One", description: "" }] }] }, 6));
  before.questions.askQuestion({ ...base, kind: "holds", id: "holds-rv-1-a", reserved: "auth", answerer: "deployer", holds: { review: "rv-1", head: "a".repeat(40), base: "main", holds: [{ code: "reserved-path:auth", text: "Always needs the person." }] } });
  before.questions.askQuestion({ ...base, kind: "judgment", id: "judgment:7", failure: 7 });
  before.questions.askQuestion({ ...base, kind: "judgment", id: "judgment:8", failure: 8 });
  before.questions.askQuestion(cleanupQuestion(node, [{ kind: "image", id: "img-000000000001" as never, bytes: 1 }], 7));
  before.questions.answerQuestion(before.questions.question("judgment:8")!, { option: "Yes", by: "nLAPTOP" as TailnetNodeId, at: 9 });
  before.close();

  const stripped = new DatabaseSync(path);
  stripped.prepare("UPDATE questions SET record = json_set(record, '$.withdrawn', json(?)) WHERE id = 'judgment:7'").run(JSON.stringify({ by: "archive", at: 10 }));
  const asked = (stripped.prepare("SELECT id, record FROM questions ORDER BY rowid").all() as { id: string; record: string }[]).map((r) => JSON.parse(r.record) as Question);
  stripped.exec("UPDATE questions SET record = json_remove(record, '$.kind')");
  stripped.close();
  const kindMigration = /json_set\(record, '\$\.kind'/;
  rewindTo(path, versionBefore(kindMigration));

  const after = testRegistry(t, path);
  assert.deepEqual(asked.map((q) => after.questions.question(q.id)), asked, "each question has the kind it was asked with, and every other field as it was");
  assert.deepEqual(asked.map((q) => q.kind), ["proposal", "ask", "holds", "judgment", "judgment", "cleanup"]);
  assert.deepEqual(after.questions.openNodeQuestions().map((q) => q.id), [asked[5]!.id]);
  assert.equal(after.threads.attention(thread.id), "decision", "the open proposal, ask and holds questions still need the person");

  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  const rows = () => raw.prepare("SELECT rowid, id, thread, node, record FROM questions ORDER BY rowid").all();
  const migrated = rows();
  raw.exec(migrations[versionBefore(kindMigration)]!);
  assert.deepEqual(rows(), migrated, "applied again, it changes nothing");
});
