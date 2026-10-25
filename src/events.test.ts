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
