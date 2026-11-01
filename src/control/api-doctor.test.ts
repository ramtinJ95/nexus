/** `nexus doctor`'s route and the health routes. */
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

test("the health routes serve the latest pass with each open problem, the changes newest first, and the seen mark, and the daily reports' routes are gone", async (t) => {
  let latest: DoctorReport | null = null;
  const s = await testApi(t, { health: () => latest });
  assert.deepEqual(await s.call("GET", "/v1/checks"), { status: 200, body: { at: null, checks: [], problems: [], unseen: 0 } });
  assert.deepEqual(await s.call("GET", "/v1/checks/changes"), { status: 200, body: [] });
  const [backup, disk] = s.registry.recordHealthChanges([
    { at: ok.at, node: null, name: "backup", from: "ok", status: "fail", text: "the newest backup is 27 h old" },
    { at: ok.at, node: "rj-firebat" as never, name: "disk", from: "ok", status: "warn", text: "12.4 of 98.0 GiB free at /var/lib/nexus-control, low" },
  ], 0);
  latest = failing;
  assert.deepEqual(await s.call("GET", "/v1/checks"), { status: 200, body: { at: failing.at, checks: failing.checks, problems: [backup, disk], unseen: 2 } });
  assert.deepEqual(await s.call("GET", "/v1/checks/changes"), { status: 200, body: [disk, backup] });
  assert.equal((await s.call("POST", "/v1/checks/seen", { through: backup!.id })).status, 204);
  const seen = (await s.call("GET", "/v1/checks")).body as { problems: { seenAt: string | null }[]; unseen: number };
  assert.deepEqual([seen.problems.map((p) => p.seenAt !== null), seen.unseen], [[true, false], 1]);
  assert.equal((await s.call("POST", "/v1/checks/seen", { through: -1 })).status, 400);
  assert.equal((await s.call("POST", "/v1/checks/seen", {})).status, 400);
  for (const path of ["/v1/reports", "/v1/reports/latest", "/v1/reports/1"]) assert.equal((await s.call("GET", path)).status, 404, path);
});
