import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.ts";

const owners: Record<string, string[]> = {
  "db.ts": ["settings"],
  "thread-store.ts": [
    "threads", "pylons", "sessions", "previews", "outputs", "jobs", "events", "event_receipts", "session_activity", "session_order",
    "session_order_floor", "claude_workers", "claude_transcripts", "claude_entries", "claude_messages", "claude_senders",
    "thread_attention", "start_requests", "aborted_conversations", "thread_archives", "disk_cleanups",
  ],
  "node-store.ts": ["nodes", "join_tokens", "joined_nodes"],
  "project-store.ts": ["projects"],
  "image-store.ts": ["images", "templates"],
  "release-store.ts": ["release_reports"],
  "review-store.ts": ["reviews", "reviewed_prs"],
  "question-store.ts": ["questions", "waiting_asks"],
  "nudge-store.ts": ["nudges"],
  "pr-watch-store.ts": ["pr_watches"],
  "planning-store.ts": ["planning_threads"],
  "judgment-store.ts": ["judgments", "judgment_since"],
  "pipeline-store.ts": ["pipeline_items"],
  "queue-store.ts": ["queued_threads"],
  "usage-store.ts": ["usage_records", "usage_days", "usage_cursors", "usage_since", "usage_backfill", "usage_backfill_threads"],
};

const foreignReads: Record<string, string[]> = {
  // previews joins each preview's node.
  "thread-store.ts": ["nodes"],
  // isReviewer reads the thread's record.
  "review-store.ts": ["threads"],
  // usageBackfillThreads joins the threads it backfills.
  "usage-store.ts": ["threads"],
  // reconcileAsks reads each worker and its entries.
  "question-store.ts": ["claude_workers", "claude_entries"],
};

const tableNames = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((match) => match[1]!);

test("every registry table has one owning file, and only its owner writes it or names it, but for the listed reads", () => {
  const { db } = openDb(":memory:");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name).sort();
  db.close();
  const known = new Set(tables);
  const dir = import.meta.dirname;
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !/\.(test|check)\.ts$/.test(path) && !["schema.ts", "schema-kit.ts"].includes(path));
  const named = new Map<string, Set<string>>();
  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    const names = new Set([
      ...tableNames(source, /\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/g),
      ...tableNames(source, /\b(?:recordOf|saveRecord)(?:<[^>]*>)?\(\s*"(\w+)"/g),
    ].filter((table) => known.has(table)));
    const writes = [
      ...tableNames(source, /\b(?:INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/g),
      ...tableNames(source, /\bsaveRecord\(\s*"(\w+)"/g),
    ].filter((table) => known.has(table));
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
