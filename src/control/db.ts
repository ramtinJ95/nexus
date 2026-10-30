/**
 * The registry's database kernel, which the registry and its stores share: one connection, so every write is a
 * synchronous statement on it and no two writes interleave.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { migrations } from "./schema.ts";

export type Row = Record<string, unknown>;
/** The tables that keep each record as JSON in a `record` column under one key. */
type RecordTable = "reviews" | "pr_watches" | "nudges" | "planning_threads" | "pipeline_items" | "queued_threads" | "questions" | "judgments";
type RecordKey = "builder" | "thread" | "id" | "failure";
export const json = <T>(value: unknown): T => JSON.parse(value as string) as T;
export const jsonOrNull = <T>(value: unknown): T | null => value === null ? null : json<T>(value);

export type Db = ReturnType<typeof openDb>;

/** Opens the file, creating it if needed, and applies any migrations it has not seen. */
export function openDb(path: string) {
  const db = new DatabaseSync(path);
  // Another process may write the registry, such as a second open of it, so a write waits out its short transaction.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);

  let transactionDepth = 0;
  const transaction = <T>(body: () => T): T => {
    if (transactionDepth > 0) return body();
    transactionDepth++;
    try { return inTransaction(db, body); } finally { transactionDepth--; }
  };
  const statements = new Map<string, StatementSync>();
  const sql = (text: string): StatementSync => {
    let statement = statements.get(text);
    if (statement === undefined) statements.set(text, statement = db.prepare(text));
    return statement;
  };

  const setting = (key: string): string | null => (sql("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null) as string | null;
  const setSetting = (key: string, value: string) => sql("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);

  /** The table and key column are SQL, so they come only from this code, never from input. */
  function recordOf<T>(table: RecordTable, keyColumn: RecordKey, key: string | number): T | null {
    return jsonOrNull<T>(sql(`SELECT record FROM ${table} WHERE ${keyColumn} = ?`).get(key)?.record ?? null);
  }

  function saveRecord(table: RecordTable, keyColumn: RecordKey, key: string | number, record: unknown) {
    sql(`INSERT INTO ${table} (${keyColumn}, record) VALUES (?, ?) ON CONFLICT (${keyColumn}) DO UPDATE SET record = excluded.record`).run(key, JSON.stringify(record));
  }

  return { db, transaction, sql, setting, setSetting, recordOf, saveRecord };
}

function migrate(db: DatabaseSync) {
  const applied = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (applied > migrations.length) throw new Error(`the registry is at schema version ${applied}, newer than this control plane's ${migrations.length}`);
  for (let version = applied; version < migrations.length; version++) {
    inTransaction(db, () => {
      db.exec(migrations[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

function inTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
