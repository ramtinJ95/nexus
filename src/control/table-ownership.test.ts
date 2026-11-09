import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deletedWithThread, openDb, purged, type Holding } from "./db.ts";

const foreignReads: Record<string, string[]> = {
  // previews joins each preview's node, and harnessThreads leaves out the threads with a Claude worker.
  "thread-store.ts": ["nodes", "claude_workers"],
  // isReviewer reads the thread's record.
  "review-store.ts": ["threads"],
  // usageBackfillThreads joins the threads it backfills.
  "usage-store.ts": ["threads"],
  // reconcileAsks reads each worker and its entries.
  "question-store.ts": ["claude_workers", "claude_entries"],
};

const tableNames = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((match) => match[1]!);

const dir = import.meta.dirname;
const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".ts") && !/\.(test|check)\.ts$/.test(path) && path !== "schema.ts");
const holdings = new Map<string, Holding>();
for (const file of files) {
  if (readFileSync(join(dir, file), "utf8").includes("export const holding")) holdings.set(file, ((await import(join(dir, file))) as { holding: Holding }).holding);
}
const owners = Object.fromEntries([...holdings].map(([file, h]) => [file, Object.keys(h.tables)]));

test("a deleted thread's rows go from the tables a thread's delete cleared by hand", () => {
  assert.deepEqual(deletedWithThread([...holdings.values()]).sort(), ["session_order", "session_order_floor", "claude_transcripts", "claude_entries", "claude_messages", "claude_senders", "disk_cleanups"].sort());
});

test("every table whose rows name a thread or its pylon says what a thread's purge does with them, and each purge's condition reads its table", () => {
  const { db } = openDb(":memory:");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'threads'").all() as { name: string }[]).map((r) => r.name);
  const tied = tables.filter((table) => {
    const columns = (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((c) => c.name);
    const references = (db.prepare('SELECT "table" FROM pragma_foreign_key_list(?)').all(table) as { table: string }[]).map((f) => f.table);
    return columns.includes("thread") || columns.includes("pylon") || references.includes("threads") || references.includes("pylons");
  });
  const declared = new Map([...holdings.values()].flatMap((h) => Object.entries(h.tables)));
  const undecided = tied.filter((table) => {
    const t = declared.get(table);
    return t?.purge === undefined && t?.keptOnPurge === undefined && t?.deletedWithThread === undefined;
  });
  assert.deepEqual(undecided, [], "each declares purge, keptOnPurge or deletedWithThread in its holding");
  for (const [table, where] of purged([...holdings.values()])) assert.doesNotThrow(() => db.prepare(`DELETE FROM ${table} WHERE ${where}`), `${table}'s purge`);
  db.close();
});

test("no two stores hold one settings key", () => {
  const keys = [...holdings.values()].flatMap((h) => h.settings ?? []);
  assert.deepEqual(keys.sort(), ["backed-up-at", "current", "deploy-drain", "image-operation", "previous-image", "release", "releases:"]);
});

test("every registry table has one owning file, the one whose holding names it, and only its owner writes it or names it, but for the listed reads", () => {
  const { db } = openDb(":memory:");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name).sort();
  db.close();
  const known = new Set(tables);
  const named = new Map<string, Set<string>>();
  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    const names = new Set([
      ...tableNames(source, /\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/g),
      ...tableNames(source, /\brecords(?:<[^>]*>)?\(\s*"(\w+)"/g),
    ].filter((table) => known.has(table)));
    const writes = tableNames(source, /\b(?:INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/g).filter((table) => known.has(table));
    const owned = owners[file] ?? [];
    for (const table of writes) assert.ok(owned.includes(table), `${file} writes ${table}, which it does not own`);
    for (const table of names) assert.ok(owned.includes(table) || foreignReads[file]?.includes(table), `${file} names ${table}, which it neither owns nor is listed as reading`);
    named.set(file, names);
  }
  for (const [file, reads] of Object.entries(foreignReads)) {
    for (const table of reads) assert.ok(named.get(file)?.has(table), `${file} no longer reads ${table}, so foreignReads should drop it`);
  }
  assert.deepEqual(Object.values(owners).flat().sort(), tables, "owners lists every table exactly once");
});
