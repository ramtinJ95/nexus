import { test } from "node:test";
import assert from "node:assert/strict";
import { healthNotice, owedHealthSeen } from "./health.js";

const change = (from, status, node = "rj-firebat") => ({ id: 3, node, name: "disk", from, status, text: "12.4 of 98.0 GiB free", at: "2026-11-02T00:30:00.000Z", seenAt: null });

test("a check that went bad or worse alerts, and one that got better says so quietly, each opening the Health page", () => {
  assert.deepEqual(healthNotice(change("ok", "warn")), { key: '["rj-firebat","disk"]', title: "rj-firebat disk: warn", body: "12.4 of 98.0 GiB free", url: "/health", quiet: false });
  assert.equal(healthNotice(change("warn", "fail")).quiet, false);
  assert.deepEqual([healthNotice(change("fail", "warn")).title, healthNotice(change("fail", "warn")).quiet], ["rj-firebat disk: warn, better than fail", true]);
  assert.deepEqual([healthNotice(change("warn", "ok", null)).title, healthNotice(change("warn", "ok", null)).quiet], ["Control plane disk recovered", true]);
  assert.equal(healthNotice(change("ok", "warn")).key, healthNotice(change("warn", "ok")).key, "a recovery replaces its check's alert");
});

test("a Health page owes a seen mark for the newest problem it shows, once", () => {
  const page = (through) => ({ dataset: { healthThrough: String(through) } });
  assert.deepEqual(owedHealthSeen(page(7), null), { through: 7 });
  assert.equal(owedHealthSeen(page(7), 7), null);
  assert.deepEqual(owedHealthSeen(page(9), 7), { through: 9 });
  assert.equal(owedHealthSeen(page(0), null), null, "no problem shown");
  assert.equal(owedHealthSeen(null, null), null, "not the Health page");
});
