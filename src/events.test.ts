import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "./control/registry.ts";
import { eventCursor, pylonEventSchema } from "./events.ts";

test("a follower reconnects across a registry restart without missing events", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-events-"));
  const path = join(dir, "registry.sqlite");
  let registry = openRegistry(path);
  try {
    const first = registry.appendEvent("release.changed", null, { state: "installing" });
    assert.deepEqual(registry.events().map((e) => e.id), [first.id]);
    registry.close();
    registry = openRegistry(path);
    const second = registry.appendEvent("release.changed", null, { state: "healthy" });
    const third = registry.appendEvent("release.changed", null, { state: "pending" });
    assert.deepEqual(registry.events(first.id).map((e) => e.id), [second.id, third.id]);
    assert.deepEqual(registry.events(third.id), []);
    assert.deepEqual(registry.events("0", { kinds: ["session.turn-ended"] }), []);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pylon event input rejects other threads, unknown kinds and oversized payloads", () => {
  for (const input of [
    { kind: "session.turn-ended", thread: "another-thread" },
    { kind: "release.changed" },
    { kind: "unknown" },
    { kind: "session.turn-started", at: -1 },
    { kind: "session.turn-started", at: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "session.waiting", message: "x".repeat(2049) },
    { kind: "session.ended", session: "x".repeat(201) },
  ]) assert.equal(pylonEventSchema.safeParse(input).success, false);
  assert.equal(pylonEventSchema.safeParse({ kind: "session.turn-started", session: "abc" }).success, true);
  for (const cursor of ["-1", "1.2", "01", "9007199254740992"]) assert.throws(() => eventCursor(cursor));
});

test("bounded retention reports an expired cursor instead of silently skipping", () => {
  const registry = openRegistry(":memory:");
  try {
    for (let i = 0; i < 10_002; i++) registry.appendEvent("release.changed", null, {});
    assert.equal(registry.events().length, 10_000);
    assert.throws(() => registry.events("1"), /expired/);
    assert.equal(registry.events("2").length, 10_000);
  } finally { registry.close(); }
});

test("the probe journal survives restart and preserves bounded ordered replay", async () => {
  const { eventJournal } = await import("./probe/event-journal.ts");
  const dir = mkdtempSync(join(tmpdir(), "nexus-journal-"));
  const path = join(dir, "events.sqlite");
  let journal = eventJournal(path);
  try {
    const first = journal.append("pylon-t1" as import("./protocol.ts").PylonId, { kind: "session.turn-started", session: "c1" });
    journal.close();
    journal = eventJournal(path);
    assert.deepEqual(journal.recent(), [first]);
    for (let i = 0; i < 101; i++) journal.append(first.pylon, { kind: "session.turn-ended", session: "c1" });
    assert.equal(journal.recent().length, 100);
    assert.equal(journal.recent()[0]!.sequence, 3);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("parallel tool hooks share a throttled heartbeat, and refresh after five minutes", async () => {
  const { heartbeatDue, heartbeatIntervalMs } = await import("../images/pylon/nexus-heartbeat.ts");
  const dir = mkdtempSync(join(tmpdir(), "nexus-heartbeat-"));
  const path = join(dir, "session");
  try {
    const now = Date.now();
    const replies = await Promise.all(Array.from({ length: 20 }, () => heartbeatDue(path, now)));
    assert.equal(replies.filter(Boolean).length, 1);
    assert.equal(await heartbeatDue(path, now + heartbeatIntervalMs - 1), false);
    assert.equal(await heartbeatDue(path, now + heartbeatIntervalMs), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a turn end with a background subagent still running reports a heartbeat, and background shells do not count", async () => {
  const { reportedKind } = await import("../images/pylon/nexus-heartbeat.ts");
  const subagent = { id: "ac4719df54252d254", type: "subagent", status: "running", agent_type: "general-purpose" };
  const shell = { id: "bq5q9o836", type: "shell", status: "running", command: "sleep 90" };
  assert.equal(reportedKind("session.turn-ended", { background_tasks: [shell, subagent] }), "session.heartbeat");
  assert.equal(reportedKind("session.turn-ended", { background_tasks: [shell] }), "session.turn-ended");
  assert.equal(reportedKind("session.turn-ended", { background_tasks: [{ ...subagent, status: "completed" }] }), "session.turn-ended");
  assert.equal(reportedKind("session.turn-ended", { background_tasks: [] }), "session.turn-ended");
  assert.equal(reportedKind("session.turn-ended", {}), "session.turn-ended", "a Claude without the field ends turns as before");
  assert.equal(reportedKind("session.ended", { background_tasks: [subagent] }), "session.ended");
});

test("filtered reads advance the scanned watermark through retention rollover", () => {
  const registry = openRegistry(":memory:");
  try {
    let since = "0";
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 5000; i++) registry.appendEvent("release.changed", null, { message: "x".repeat(2048) });
      const result = registry.eventBatch(since, { kinds: ["session.turn-ended"] });
      assert.deepEqual(result.events, []);
      assert.equal(result.watermark, String((batch + 1) * 5000));
      since = result.watermark;
    }
    const matching = registry.appendEvent("session.turn-ended", null, {});
    assert.deepEqual(registry.eventBatch(since, { kinds: ["session.turn-ended"] }).events, [matching]);
  } finally { registry.close(); }
});

test("SQL filters before decoding payloads, including intersecting thread and project filters", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "nexus-event-filter-"));
  const path = join(dir, "registry.sqlite");
  const registry = openRegistry(path);
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare("INSERT INTO events (time, thread, project, kind, payload) VALUES (0, ?, ?, ?, ?)");
    insert.run("t1", "p1", "session.turn-ended", '{"match":true}');
    insert.run("t2", "p1", "session.turn-ended", "not JSON");
    insert.run("t1", "p2", "session.turn-ended", "not JSON");
    insert.run("t1", "p1", "release.changed", "not JSON");
    const result = registry.eventBatch("0", { thread: "t1", project: "p1", kinds: ["session.turn-ended", "session.waiting"] });
    assert.equal(result.watermark, "4");
    assert.deepEqual(result.events.map((e) => e.payload), [{ match: true }]);
  } finally { db.close(); registry.close(); rmSync(dir, { recursive: true, force: true }); }
});
