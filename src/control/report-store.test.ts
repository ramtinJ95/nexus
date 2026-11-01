import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NodeName } from "../ids.ts";
import { tempDir } from "../test-kit.ts";
import { openRegistry } from "./registry.ts";
import { rewindTo, versionBefore } from "./schema-kit.ts";
import { testRegistry } from "./test-kit.ts";
import type { NewHealthChange } from "./report-store.ts";
import type { Status } from "./doctor-model.ts";

const dir = await tempDir("nexus-report-store-");
const node = "rj-firebat" as NodeName;
const change = (at: string, from: Status, status: Status, name: "disk" | "online" = "disk"): NewHealthChange => ({ at, node, name, from, status, text: `${name} ${status}` });

test("a registry from the daily reports drops them, and one rewound past that keeps every change and its seen mark", (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  openRegistry(path).close();
  const version = versionBefore(/DELETE FROM doctor_reports WHERE json_extract/);
  rewindTo(path, version);
  const daily = new DatabaseSync(path);
  daily.prepare("INSERT INTO doctor_reports (at, record) VALUES (?, ?)").run(Date.parse("2026-11-01T00:30:00Z"), JSON.stringify({ at: "2026-11-01T00:30:00.000Z", status: "warn", checks: [{ node: null, name: "backup", status: "warn", text: "no backup run is recorded yet" }] }));
  daily.close();
  const upgraded = openRegistry(path);
  assert.deepEqual(upgraded.healthChanges(), [], "the daily report holds no change");
  const rows = new DatabaseSync(path, { readOnly: true });
  assert.equal(rows.prepare("SELECT count(*) AS n FROM doctor_reports").get()!.n, 0, "and is dropped");
  rows.close();
  const [saved] = upgraded.recordHealthChanges([change("2026-11-01T12:00:00.000Z", "ok", "warn")], 0);
  upgraded.markHealthSeen(saved!.id, Date.parse("2026-11-01T12:01:00Z"));
  upgraded.close();
  rewindTo(path, version);
  const again = testRegistry(t, path);
  assert.deepEqual(again.healthChanges().map((c) => [c.id, c.seenAt]), [[saved!.id, "2026-11-01T12:01:00.000Z"]], "applied again, the migration keeps the change");
});

test("changes are read newest first and each check's latest as its state, and a row that does not parse is passed over", (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const registry = testRegistry(t, path);
  const [warn] = registry.recordHealthChanges([change("2026-11-01T00:00:00.000Z", "ok", "warn")], 0);
  const [down, fail] = registry.recordHealthChanges([change("2026-11-01T00:05:00.000Z", "ok", "fail", "online"), change("2026-11-01T00:05:00.000Z", "warn", "fail")], 0);
  const raw = new DatabaseSync(path);
  raw.prepare("INSERT INTO doctor_reports (at, record) VALUES (?, ?)").run(Date.parse("2026-11-01T00:06:00Z"), "{ not json");
  raw.close();
  assert.deepEqual(registry.healthChanges().map((c) => c.id), [fail!.id, down!.id, warn!.id]);
  assert.deepEqual(registry.healthStates().map((c) => [c.name, c.status]), [["online", "fail"], ["disk", "fail"]]);
  assert.deepEqual(registry.events("0", { kinds: ["health.changed"] }).map((e) => [e.thread, e.payload.id, e.payload.status]), [[null, warn!.id, "warn"], [null, down!.id, "fail"], [null, fail!.id, "fail"]], "each change is an event the dashboard alerts on");
});

test("seen marks each open problem up to the change named, a problem that gets better stays seen, and one that gets worse or comes back is unseen", (t) => {
  const registry = testRegistry(t);
  const unseen = () => registry.healthStates().filter((c) => c.status !== "ok" && c.seenAt === null).map((c) => c.name);
  const [disk] = registry.recordHealthChanges([change("2026-11-01T00:00:00.000Z", "ok", "fail")], 0);
  const [online] = registry.recordHealthChanges([change("2026-11-01T00:05:00.000Z", "ok", "warn", "online")], 0);
  assert.equal(registry.markHealthSeen(disk!.id, Date.parse("2026-11-01T00:06:00Z")), 1);
  assert.deepEqual(unseen(), ["online"], "the online problem came after the page the person saw");
  registry.markHealthSeen(online!.id, Date.parse("2026-11-01T00:07:00Z"));
  assert.deepEqual(unseen(), []);
  registry.recordHealthChanges([change("2026-11-01T00:10:00.000Z", "fail", "warn")], 0);
  assert.deepEqual(unseen(), [], "fail to warn is no new problem");
  registry.recordHealthChanges([change("2026-11-01T00:15:00.000Z", "warn", "fail")], 0);
  assert.deepEqual(unseen(), ["disk"], "warn to fail is worse");
  registry.recordHealthChanges([change("2026-11-01T00:20:00.000Z", "fail", "ok"), change("2026-11-01T00:20:00.000Z", "warn", "ok", "online")], 0);
  assert.deepEqual(unseen(), []);
  registry.recordHealthChanges([change("2026-11-01T00:30:00.000Z", "ok", "warn", "online")], 0);
  assert.deepEqual(unseen(), ["online"], "a problem that comes back is new");
});

test("a change is dropped once older than what is kept, unless it set a problem still open", (t) => {
  const registry = testRegistry(t);
  registry.recordHealthChanges([change("2026-10-01T00:00:00.000Z", "ok", "warn"), change("2026-10-01T00:00:00.000Z", "ok", "warn", "online")], 0);
  registry.recordHealthChanges([change("2026-10-01T01:00:00.000Z", "warn", "ok", "online")], 0);
  const keepSince = Date.parse("2026-10-02T00:00:00Z");
  registry.recordHealthChanges([change("2026-11-01T00:00:00.000Z", "warn", "fail")], keepSince);
  assert.deepEqual(registry.healthChanges().map((c) => [c.name, c.from, c.status]), [["disk", "warn", "fail"]], "the online problem and its recovery are past what is kept, and so is the disk's first change, which no longer sets its state");
  registry.recordHealthChanges([], Date.parse("2026-12-01T00:00:00Z"));
  assert.deepEqual(registry.healthStates().map((c) => c.status), ["fail"], "the open problem's change stays however old");
});
