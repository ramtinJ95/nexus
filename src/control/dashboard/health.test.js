import { test } from "node:test";
import assert from "node:assert/strict";
import { caughtUp, healthNotice, newChanges, owedHealthSeen } from "./health.js";

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

test("a tab takes only changes newer than its page showed, each once, though a catch-up and the stream both hand one on", () => {
  const fresh = newChanges(4);
  assert.deepEqual([3, 4, 5, 6, 5].map((id) => fresh({ id })), [false, false, true, true, false]);
});

test("a stream that opened again hands on every change kept, oldest first", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const asked = [];
  globalThis.fetch = async (path) => { asked.push(path); return { ok: true, text: async () => JSON.stringify([change("warn", "ok"), change("ok", "warn")].map((c, i) => ({ ...c, id: 9 - i }))) }; };
  const handed = [];
  await caughtUp((c) => handed.push([c.id, c.status]));
  assert.deepEqual([asked, handed], [["/v1/checks/changes"], [[8, "warn"], [9, "ok"]]]);
  globalThis.fetch = async () => { throw new Error("offline"); };
  await assert.doesNotReject(caughtUp(() => {}), "a failed read waits for the next reconnect");
});
