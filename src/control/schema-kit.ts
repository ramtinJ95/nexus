/**
 * Test support: registry files at an older schema version, made from the migration list, so a migration test names
 * the migration it predates and never rewinds a registry by hand.
 */
import { renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./schema.ts";

type Column = { name: string; notnull: number; dflt_value: string | null };

/** The schema version just before the one migration whose SQL matches. Throws, naming the pattern, unless exactly one does. */
export function versionBefore(pattern: RegExp): number {
  const matching = migrations.flatMap((sql, version) => pattern.test(sql) ? [version] : []);
  if (matching.length !== 1) throw new Error(`${matching.length} migrations match ${pattern}, not one`);
  return matching[0]!;
}

/**
 * Rebuilds the closed registry file at `path` at schema `version`. The new file has the first `version` migrations,
 * applied in order as db.ts's migrate applies them, and every row `path` held of each table and column that exists
 * at `version`. Later tables and columns are dropped, as the hand-written chains dropped them.
 */
export function rewindTo(path: string, version: number): void {
  const rewound = `${path}.rewound`;
  rmSync(rewound, { force: true });
  const db = new DatabaseSync(rewound);
  db.exec("PRAGMA foreign_keys = ON");
  for (let applied = 0; applied < version; applied++) {
    db.exec(`BEGIN IMMEDIATE; ${migrations[applied]!}; PRAGMA user_version = ${applied + 1}; COMMIT`);
  }
  db.prepare("ATTACH ? AS current").run(path);
  const columns = (schema: string, table: string) => db.prepare('SELECT name, "notnull", dflt_value FROM pragma_table_info(?, ?)').all(table, schema) as Column[];
  const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { name: string }[];
  db.exec("BEGIN IMMEDIATE");
  for (const { name: table } of tables) {
    const source = new Set(columns("current", table).map((c) => c.name));
    if (source.size === 0) continue;
    const old = columns("main", table);
    const missing = old.find((c) => c.notnull && c.dflt_value === null && !source.has(c.name));
    if (missing !== undefined) throw new Error(`${table}.${missing.name} is NOT NULL at schema ${version}, and the current file has no such column`);
    const shared = old.filter((c) => source.has(c.name)).map((c) => `"${c.name}"`).join(", ");
    db.exec(`INSERT INTO main."${table}" (${shared}) SELECT ${shared} FROM current."${table}"`);
  }
  db.exec("COMMIT; DETACH current");
  db.close();
  for (const sidecar of ["-wal", "-shm"]) rmSync(`${path}${sidecar}`, { force: true });
  renameSync(rewound, path);
}
