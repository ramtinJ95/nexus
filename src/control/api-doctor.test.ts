/** `nexus doctor`'s route and the daily reports' routes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DoctorReport } from "./doctor-model.ts";
import { testApi } from "./api-test-kit.ts";

const ok: DoctorReport = { at: "2026-11-01T00:30:00.000Z", status: "ok", checks: [{ node: null, name: "backup", status: "ok", text: "the newest backup is 3 h old and verified" }] };
const failing: DoctorReport = {
  at: "2026-11-02T00:30:00.000Z", status: "fail", checks: [
    { node: null, name: "backup", status: "fail", text: "the newest backup is 27 h old" },
    { node: "rj-firebat" as never, name: "disk", status: "warn", text: "12.4 of 98.0 GiB free at /var/lib/nexus-control, low" },
    { node: "rj-firebat" as never, name: "online", status: "ok", text: "online and observed in the last 5 min" },
  ],
};

test("GET /v1/doctor runs the checks now, and answers 409 on a control plane that runs none", async (t) => {
  const s = await testApi(t, { doctor: async () => failing });
  assert.deepEqual(await s.call("GET", "/v1/doctor"), { status: 200, body: failing });
  const none = await testApi(t);
  assert.equal((await none.call("GET", "/v1/doctor")).status, 409);
});

test("the daily reports are listed newest first with their counts, and read as the latest or by ID", async (t) => {
  const s = await testApi(t);
  assert.deepEqual(await s.call("GET", "/v1/reports"), { status: 200, body: [] });
  assert.equal((await s.call("GET", "/v1/reports/latest")).status, 404);
  const first = s.registry.saveReport(ok, 0);
  const second = s.registry.saveReport(failing, 0);
  assert.deepEqual((await s.call("GET", "/v1/reports")).body, [
    { id: second.id, at: failing.at, status: "fail", counts: { ok: 1, warn: 1, fail: 1 } },
    { id: first.id, at: ok.at, status: "ok", counts: { ok: 1, warn: 0, fail: 0 } },
  ]);
  assert.deepEqual(await s.call("GET", "/v1/reports/latest"), { status: 200, body: second });
  assert.deepEqual(await s.call("GET", `/v1/reports/${first.id}`), { status: 200, body: first });
  assert.equal((await s.call("GET", "/v1/reports/99")).status, 404);
  assert.equal((await s.call("GET", "/v1/reports/x")).status, 404);
});
