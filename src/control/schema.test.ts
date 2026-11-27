import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { arcMigrations, migrations, type Migrations } from "./schema.ts";
import { migrate } from "./db.ts";
import { headHolds } from "./policy.ts";
import { addThread, seedRegistry, testReview } from "../test-support/registry-kit.ts";
import { openRegistry } from "./registry.ts";
import { operator } from "./people.ts";
import type { Person, ThreadId } from "../ids.ts";
import { tempDir } from "../test-support/kit.ts";
import { rewindTo, versionBefore } from "../test-support/schema-kit.ts";

const tables = (db: DatabaseSync) => db.prepare("SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table'").all() as { name: string; wr: number }[];
// The questions migration keeps rowids for the order of questions asked in one millisecond, so a row's rowid is part of it.
const snapshot = (db: DatabaseSync) => ({
  objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
  rows: Object.fromEntries(tables(db).sort((a, b) => a.name.localeCompare(b.name)).map(({ name, wr }) =>
    [name, db.prepare(`SELECT ${wr ? "" : "rowid AS _rowid, "}* FROM "${name}"`).all().map((row) => JSON.stringify(row)).sort()])),
});
const userVersion = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const arcVersion = (db: DatabaseSync) => (db.prepare("SELECT version FROM arc_schema").get() as { version: number }).version;

/** A registry made by the main list alone, as a control plane before the arc made it, with no arc_schema table. */
function mainRegistry(db = new DatabaseSync(":memory:"), list: Migrations = migrations) {
  db.exec("PRAGMA foreign_keys = ON");
  for (const [version, sql] of list.entries()) db.exec(`BEGIN IMMEDIATE; ${sql}; PRAGMA user_version = ${version + 1}; COMMIT`);
  return db;
}

/**
 * Applies each of `list` to `db` in turn and, from `first` on, applies again each that alters and drops no table an
 * earlier migration made, asserting it changes nothing. Returns how many it applied again.
 */
function reapplies(db: DatabaseSync, list: Migrations, first: number, name: string): number {
  let checked = 0;
  for (const [version, sql] of list.entries()) {
    const earlier = new Set(tables(db).map((t) => t.name));
    db.exec(sql);
    const changesEarlier = [...sql.replace(/--.*$/gm, "").matchAll(/\b(?:ALTER|DROP) TABLE (?!IF EXISTS\b)(\w+)/gi)].some((match) => earlier.has(match[1]!));
    if (version < first || changesEarlier) continue;
    const made = snapshot(db);
    assert.doesNotThrow(() => db.exec(sql), `${name} migration ${version} applies again`);
    assert.deepEqual(snapshot(db), made, `${name} migration ${version} applied again changes nothing`);
    checked++;
  }
  return checked;
}

// Test-only arc migrations: one makes a table, one only updates, as most of the arc's will.
const arcTable = `CREATE TABLE IF NOT EXISTS arc_people (login TEXT PRIMARY KEY, role TEXT NOT NULL) STRICT;
  INSERT OR IGNORE INTO arc_people (login, role) VALUES ('alice@example.com', 'engineer');`;
const arcUpdate = `UPDATE arc_people SET role = 'admin' WHERE login = 'alice@example.com';`;
const mainLater = `CREATE TABLE IF NOT EXISTS main_later (id TEXT PRIMARY KEY) STRICT;`;

test("from the passkeys' migration on, each that alters and drops no earlier table, applied again to the registry it made, changes nothing", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  assert.ok(reapplies(db, migrations, versionBefore(/CREATE TABLE IF NOT EXISTS passkeys\b/), "main") > 0, "the rule covers some migration");
  reapplies(db, arcMigrations, 0, "arc");
  db.close();
});

test("the rule that a migration applies again unchanged runs on an arc list after the main list", () => {
  const db = mainRegistry();
  assert.equal(reapplies(db, [arcTable, arcUpdate], 0, "test arc"), 2);
  db.close();
});

test("with an empty arc list, opening a registry the main list made writes nothing to it", async (t) => {
  const path = join(await tempDir("nexus-schema-", t), "registry.db");
  const made = new DatabaseSync(path);
  made.exec("PRAGMA journal_mode = WAL");
  mainRegistry(made).close();
  const before = readFileSync(path);
  const db = new DatabaseSync(path);
  const seen = { snapshot: snapshot(db), version: userVersion(db) };
  migrate(db, { main: migrations, arc: [] });
  assert.deepEqual({ snapshot: snapshot(db), version: userVersion(db) }, seen);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'arc_schema'").get()!.n, 0, "no arc_schema table");
  db.close();
  assert.deepEqual(readFileSync(path), before, "the file is byte for byte the same");
});

test("a registry that applied an arc migration takes a later main migration, and only that one runs", () => {
  const db = mainRegistry();
  migrate(db, { main: migrations, arc: [arcTable, arcUpdate] });
  assert.equal(arcVersion(db), 2);
  db.exec("UPDATE arc_people SET role = 'engineer'");
  migrate(db, { main: [...migrations, mainLater], arc: [arcTable, arcUpdate] });
  assert.equal(userVersion(db), migrations.length + 1);
  assert.equal(arcVersion(db), 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'main_later'").get()!.n, 1, "the new main migration ran");
  assert.equal(db.prepare("SELECT role FROM arc_people").get()!.role, "engineer", "the arc's update did not run again");
  db.close();
});

test("a registry at the main list's end takes a later arc migration, and only that one runs", () => {
  const db = mainRegistry();
  migrate(db, { main: migrations, arc: [arcTable] });
  assert.equal(arcVersion(db), 1);
  db.exec("DELETE FROM arc_people");
  migrate(db, { main: migrations, arc: [arcTable, arcUpdate] });
  assert.equal(userVersion(db), migrations.length);
  assert.equal(arcVersion(db), 2);
  assert.deepEqual(db.prepare("SELECT * FROM arc_people").all(), [], "the arc's first migration did not run again");
  db.close();
});

test("a registry ahead of either list is refused, and nothing is written first", () => {
  const ahead = mainRegistry();
  ahead.exec(`PRAGMA user_version = ${migrations.length + 1}`);
  assert.throws(() => migrate(ahead, { main: migrations, arc: [arcTable] }), { message: `the registry is at schema version ${migrations.length + 1}, newer than this control plane's ${migrations.length}` });
  assert.equal(ahead.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'arc_schema'").get()!.n, 0);
  ahead.close();
  const arcAhead = mainRegistry(new DatabaseSync(":memory:"), migrations.slice(0, -1));
  migrate(arcAhead, { main: migrations.slice(0, -1), arc: [arcTable, arcUpdate] });
  assert.throws(() => migrate(arcAhead, { main: migrations, arc: [arcTable] }), { message: "the registry is at arc schema version 2, newer than this control plane's 1" });
  assert.equal(userVersion(arcAhead), migrations.length - 1, "the main list's newer migration did not run");
  arcAhead.close();
});

test("the arc's first migration gives every thread that came before it the operator as its owner", async (t) => {
  const dir = await tempDir("nexus-owner-", t);
  const path = join(dir, "registry.db");
  const before = openRegistry(path);
  const old = addThread(seedRegistry(before), { thread: { owner: "someone@example.com" as Person } });
  before.close();
  rewindTo(path, migrations.length);
  const rewound = new DatabaseSync(path);
  assert.equal(rewound.prepare("SELECT count(*) AS n FROM pragma_table_info('threads') WHERE name = 'owner'").get()!.n, 0, "a registry from before the arc has no owner");
  rewound.close();
  const after = openRegistry(path);
  t.after(() => after.close());
  assert.equal(after.threads.thread(old.id)?.owner, operator);
});

test("the arc's owner migration sums each day's usage by the owner of each call's thread, and a call no longer recorded under the operator", async (t) => {
  const path = join(await tempDir("nexus-usage-owner-", t), "registry.db");
  const before = seedRegistry(openRegistry(path));
  const alice = "alice@example.com" as Person;
  const bob = "bob@example.com" as Person;
  const call = (id: string, input: number) => ({ id, agent: "pi" as const, model: "gpt-6-astra", at: Date.UTC(2026, 10, 1), input, output: 1, cacheWrite: 0, cacheRead: 0 });
  const [a, b, purged] = [alice, bob, bob].map((owner) => addThread(before, { thread: { owner } }).id) as [ThreadId, ThreadId, ThreadId];
  before.usage.recordUsage(a, [call("a1", 10), call("a2", 20)]);
  before.usage.recordUsage(b, [call("b1", 100)]);
  before.usage.recordUsage(purged, [call("p1", 1000)]);
  const total = before.usage.usageReport({ since: null }).total;
  before.close();
  const db = new DatabaseSync(path);
  const owned = arcMigrations.findIndex((sql) => sql.includes("usage_days_owned"));
  db.exec(`BEGIN; DELETE FROM usage_records WHERE thread = '${purged}';
    CREATE TABLE usage_days_was (day TEXT NOT NULL, project TEXT NOT NULL, role TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_read INTEGER NOT NULL, calls INTEGER NOT NULL,
      PRIMARY KEY (day, project, role, agent, model)) STRICT;
    INSERT INTO usage_days_was SELECT day, project, role, agent, model, sum(input), sum(output), sum(cache_write), sum(cache_read), sum(calls) FROM usage_days GROUP BY 1, 2, 3, 4, 5;
    DROP TABLE usage_days; ALTER TABLE usage_days_was RENAME TO usage_days; UPDATE arc_schema SET version = ${owned}; COMMIT`);
  db.close();
  const after = openRegistry(path);
  t.after(() => after.close());
  const report = after.usage.usageReport({ since: null, by: ["owner"] });
  assert.deepEqual(report.total, total, "the migration keeps every call's tokens");
  assert.deepEqual(report.by.owner!.map((r) => [r.key, r.input, r.calls]), [[operator, 1000, 1], [bob, 100, 1], [alice, 30, 2]]);
});

test("the merge policy holds a change inside the arc list as irreversible, even one that names no table", async (t) => {
  const dir = await tempDir("nexus-schema-diff-", t);
  const declaration = "export const arcMigrations: Migrations = [\n";
  const shipped = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
  assert.ok(shipped.includes(declaration));
  // The arc's own migrations name tables, which the diff's context would show, so the list starts empty here.
  const source = shipped.slice(0, shipped.indexOf(declaration) + declaration.length) + shipped.slice(shipped.indexOf("\n];", shipped.indexOf(declaration)) + 1);
  const withArc = (...entries: string[]) => source.replace(declaration, declaration + entries.join(""));
  const first = "  `UPDATE threads SET title = title;`,\n";
  const long = "  // A long one.\n  `UPDATE threads\n     SET title = title\n     WHERE 1;`,\n";
  // git's own hunk header, which GitHub's patch carries too, is the nearest line before the hunk that starts a declaration.
  const patch = (before: string, after: string) => {
    writeFileSync(join(dir, "a.ts"), before);
    writeFileSync(join(dir, "b.ts"), after);
    try {
      execFileSync("git", ["diff", "--no-index", "--no-color", "a.ts", "b.ts"], { cwd: dir, encoding: "utf8" });
    } catch (err) {
      const out = (err as { stdout: string }).stdout;
      return out.slice(out.indexOf("@@"));
    }
    throw new Error("the files do not differ");
  };
  const review = testReview();
  for (const [what, before, after] of [["the arc's first migration", source, withArc(first)], ["a migration after a long one", withArc(long), withArc(long, first)]] as const) {
    const diff = patch(before, after);
    assert.doesNotMatch(diff, /CREATE|ALTER|DROP/, what);
    const codes = headHolds({ review, deploys: true, files: [{ path: "src/control/schema.ts", previous: null, patch: diff }] }).map((h) => h.code);
    assert.ok(codes.includes("reserved-path:irreversible"), `${what} is held: ${diff.split("\n")[0]}`);
  }
});
