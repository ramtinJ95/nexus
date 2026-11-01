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

test("a tab takes only changes newer than its page showed and than its check's latest, so a catch-up never undoes a recovery the stream passed first", () => {
  const fresh = newChanges(4);
  const of = (id, name, status) => ({ id, node: null, name, from: "ok", status });
  assert.deepEqual([of(3, "disk", "warn"), of(4, "disk", "warn"), of(6, "disk", "ok"), of(5, "disk", "warn"), of(6, "disk", "ok"), of(5, "backup", "warn")].map(fresh), [false, false, true, false, false, true]);
});

test("a stream that opened again hands on every change kept, oldest first, and a failed read tries again until one succeeds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const asked = [];
  let down = 2;
  globalThis.fetch = async (path) => {
    asked.push(path);
    if (down-- > 0) throw new Error("offline");
    return { ok: true, text: async () => JSON.stringify([change("warn", "ok"), change("ok", "warn")].map((c, i) => ({ ...c, id: 9 - i }))) };
  };
  const handed = [];
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  await caughtUp((c) => handed.push([c.id, c.status]));
  assert.deepEqual([asked.length, handed], [1, []]);
  t.mock.timers.tick(999);
  await settled();
  assert.equal(asked.length, 1);
  t.mock.timers.tick(1);
  await settled();
  assert.equal(asked.length, 2, "again after 1 s");
  t.mock.timers.tick(2000);
  await settled();
  assert.deepEqual([asked, handed], [["/v1/checks/changes", "/v1/checks/changes", "/v1/checks/changes"], [[8, "warn"], [9, "ok"]]], "and after 2 s more, which succeeds");
  t.mock.timers.tick(60_000);
  await settled();
  assert.equal(asked.length, 3, "and stops");
});
