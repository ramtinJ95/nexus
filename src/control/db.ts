/**
 * The registry's database kernel, which the registry and its stores share: one connection, so every write is a
 * synchronous statement on it and no two writes interleave.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { migrations } from "./schema.ts";

export type Row = Record<string, unknown>;
export const json = <T>(value: unknown): T => JSON.parse(value as string) as T;
export const jsonOrNull = <T>(value: unknown): T | null => value === null ? null : json<T>(value);

export type Db = ReturnType<typeof openDb>;

/**
 * What one store holds in the registry: its tables, and the keys of the `settings` table only it reads and writes, where
 * a key ending in ":" holds every key it begins. `record` names the key column of a table that keeps each record as
 * JSON in a `record` column. `deletedWithThread` deletes a thread's rows, by its `thread` column, with the thread.
 *
 * A table whose rows name a thread or its pylon says what a thread's purge from the registry does with them.
 * `purge` is the SQL condition of the rows the purge deletes, over `$thread`, the thread's ID, `$pylon`, its pylon's,
 * and `$conversation`, its harness conversation's or null. A `deletedWithThread` table's purge deletes its rows by
 * its `thread` column too. `keptOnPurge` says why the table keeps them.
 */
export interface Holding {
  readonly tables: Readonly<Record<string, TableHolding>>;
  readonly settings?: readonly string[];
}
type TableHolding = { readonly record?: string; readonly deletedWithThread?: true } & ({ readonly purge?: string; readonly keptOnPurge?: never } | { readonly keptOnPurge?: string; readonly purge?: never });
/** What names a thread's rows in a purge's conditions. */
export interface PurgedThread { thread: string; pylon: string; conversation: string | null }
type RecordTable<H extends Holding> = { [T in keyof H["tables"]]: H["tables"][T] extends { record: string } ? T : never }[keyof H["tables"]] & string;
type SettingKey<H extends Holding> = H["settings"] extends readonly (infer K extends string)[] ? K | `${Extract<K, `${string}:`>}${string}` : never;

export const holding = { tables: { settings: {} } } as const satisfies Holding;

export const deletedWithThread = (holdings: readonly Holding[]): string[] =>
  holdings.flatMap((h) => Object.entries(h.tables).flatMap(([table, t]) => t.deletedWithThread ? [table] : []));

/** Each table a purge deletes rows of, with the condition of those rows. */
export const purged = (holdings: readonly Holding[]): [table: string, where: string][] =>
  holdings.flatMap((h) => Object.entries(h.tables).flatMap(([table, t]): [string, string][] => {
    const where = t.purge ?? (t.deletedWithThread ? "thread = $thread" : undefined);
    return where === undefined ? [] : [[table, where]];
  }));

const overlap = (a: string, b: string) => a === b || (a.endsWith(":") && b.startsWith(a)) || (b.endsWith(":") && a.startsWith(b));

/** Opens the file, creating it if needed, and applies any migrations it has not seen. */
export function openDb(path: string) {
  const db = new DatabaseSync(path);
  // Another process may write the registry, such as a second open of it, so a write waits out its short transaction.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);

  let transactionDepth = 0;
  let committed: (() => void)[] = [];
  const transaction = <T>(body: () => T): T => {
    if (transactionDepth > 0) return body();
    transactionDepth++;
    let result: T;
    try { result = inTransaction(db, body); } catch (err) { committed = []; throw err; } finally { transactionDepth--; }
    const after = committed;
    committed = [];
    for (const fn of after) fn();
    return result;
  };
  /** Runs `fn` once the transaction it is called in commits, and never if it rolls back. Outside a transaction it runs at once. */
  const afterCommit = (fn: () => void) => { if (transactionDepth > 0) committed.push(fn); else fn(); };
  const statements = new Map<string, StatementSync>();
  const sql = (text: string): StatementSync => {
    let statement = statements.get(text);
    if (statement === undefined) statements.set(text, statement = db.prepare(text));
    return statement;
  };

  const held: Holding[] = [];
  /** Claims the store's tables and settings keys, which no other store may hold, and gives its records and settings. */
  function hold<const H extends Holding>(holding: H) {
    for (const other of held) {
      for (const table of Object.keys(holding.tables)) if (table in other.tables) throw new Error(`two stores hold table ${table}`);
      for (const key of holding.settings ?? []) if (other.settings?.some((k) => overlap(k, key))) throw new Error(`two stores hold setting ${key}`);
    }
    held.push(holding);
    return {
      /** The table and its key column are SQL, so they come only from the holding, never from input. */
      records<R>(table: RecordTable<H>) {
        const key = holding.tables[table]!.record!;
        const stored = (k: string | number) => (sql(`SELECT record FROM ${table} WHERE ${key} = ?`).get(k)?.record ?? null) as string | null;
        return {
          get: (k: string | number): R | null => jsonOrNull<R>(stored(k)),
          save(k: string | number, record: R) {
            sql(`INSERT INTO ${table} (${key}, record) VALUES (?, ?) ON CONFLICT (${key}) DO UPDATE SET record = excluded.record`).run(k, JSON.stringify(record));
          },
          /** Whether the stored record is `previous`, or there is none when it is null, which a save checks in its transaction so it writes only over the record it read. */
          isCurrent: (k: string | number, previous: R | null) => stored(k) === (previous === null ? null : JSON.stringify(previous)),
        };
      },
      setting: (key: SettingKey<H>): string | null => (sql("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null) as string | null,
      setSetting(key: SettingKey<H>, value: string) { sql("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value); },
    };
  }
  hold(holding);

  function deleteThreadRows(thread: string) {
    for (const table of deletedWithThread(held)) sql(`DELETE FROM ${table} WHERE thread = ?`).run(thread);
  }

  /**
   * Deletes the thread's rows of every table whose holding purges them, in the transaction of the caller, which deletes
   * the thread's own row. The foreign keys are checked at its commit, so the tables go in any order, and a row left
   * behind that names the thread fails the commit, which keeps everything.
   */
  function purgeThreadRows(keys: PurgedThread) {
    transaction(() => {
      sql("PRAGMA defer_foreign_keys = ON").run();
      for (const [table, where] of purged(held)) {
        const statement = sql(`DELETE FROM ${table} WHERE ${where}`);
        // Each condition names only the keys it needs.
        statement.setAllowUnknownNamedParameters(true);
        statement.run({ ...keys });
      }
    });
  }

  return { db, transaction, afterCommit, sql, hold, deleteThreadRows, purgeThreadRows };
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
