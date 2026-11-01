import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "../test-kit.ts";
import { openRegistry } from "./registry.ts";
import { rewindTo, versionBefore } from "./schema-kit.ts";
import { testRegistry } from "./test-kit.ts";
import type { DoctorReport } from "./doctor-model.ts";

const dir = await tempDir("nexus-report-store-");
const report = (at: string): DoctorReport => ({ at, status: "warn", checks: [{ node: null, name: "backup", status: "warn", text: "the run failed" }] });

test("a registry from before daily reports gains their table empty, and one rewound past it keeps the reports it holds", (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  openRegistry(path).close();
  const version = versionBefore(/CREATE TABLE IF NOT EXISTS doctor_reports\b/);
  rewindTo(path, version);
  const upgraded = openRegistry(path);
  assert.deepEqual(upgraded.reports(), []);
  const saved = upgraded.saveReport(report("2026-11-01T00:00:00.000Z"), 0);
  upgraded.close();
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
  const again = testRegistry(t, path);
  assert.deepEqual(again.reports(), [saved], "applied again, the migration keeps the report");
});

test("reports are listed newest first, read by ID or as the latest, and a save drops every report from before what it keeps", (t) => {
  const registry = testRegistry(t);
  assert.equal(registry.latestReport(), null);
  const first = registry.saveReport(report("2026-10-01T00:00:00.000Z"), 0);
  const second = registry.saveReport(report("2026-10-02T00:00:00.000Z"), 0);
  assert.deepEqual(registry.reports().map((r) => r.id), [second.id, first.id]);
  assert.deepEqual(registry.report(first.id), first);
  assert.deepEqual(registry.latestReport(), second);
  const third = registry.saveReport(report("2026-11-01T00:00:00.000Z"), Date.parse("2026-10-02T00:00:00.000Z"));
  assert.deepEqual(registry.reports().map((r) => r.id), [third.id, second.id], "the report at the cutoff stays, the one before it goes");
  assert.equal(registry.report(first.id), null);
});
