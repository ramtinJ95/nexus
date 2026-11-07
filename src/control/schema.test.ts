import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./schema.ts";
import { versionBefore } from "../test-support/schema-kit.ts";

const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
const snapshot = (db: DatabaseSync) => ({
  objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
  rows: Object.fromEntries(tables(db).sort().map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all().map((row) => JSON.stringify(row)).sort()])),
});

test("from the passkeys' migration on, each that alters and drops no earlier table, applied again to the registry it made, changes nothing", () => {
  const first = versionBefore(/CREATE TABLE IF NOT EXISTS passkeys\b/);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  let checked = 0;
  for (const [version, sql] of migrations.entries()) {
    const earlier = new Set(tables(db));
    db.exec(sql);
    const changesEarlier = [...sql.matchAll(/\b(?:ALTER|DROP) TABLE (?!IF EXISTS\b)(\w+)/gi)].some((match) => earlier.has(match[1]!));
    if (version < first || changesEarlier) continue;
    const made = snapshot(db);
    assert.doesNotThrow(() => db.exec(sql), `migration ${version} applies again`);
    assert.deepEqual(snapshot(db), made, `migration ${version} applied again changes nothing`);
    checked++;
  }
  db.close();
  assert.ok(checked > 0, "the rule covers some migration");
});
