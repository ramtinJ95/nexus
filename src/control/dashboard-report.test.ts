/** The dashboard's badge for the latest daily report and the page that shows a report. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { DoctorReport } from "./doctor-model.ts";
import { laptop, testApi } from "./api-test-kit.ts";

const ok: DoctorReport = { at: "2026-11-01T00:30:00.000Z", status: "ok", checks: [{ node: null, name: "backup", status: "ok", text: "the newest backup is 3 h old and verified" }] };
const failing: DoctorReport = {
  at: "2026-11-02T00:30:00.000Z", status: "fail", checks: [
    { node: null, name: "backup", status: "fail", text: "the newest backup is 27 h old" },
    { node: "rj-firebat" as never, name: "disk", status: "warn", text: "12.4 of 98.0 GiB free at /var/lib/nexus-control, low" },
    { node: "rj-firebat" as never, name: "online", status: "ok", text: "online and observed in the last 5 min" },
  ],
};

test("the sidebar shows a badge to the latest report only while it found a warn or a fail, and the page shows that report's checks by group", async (t) => {
  const s = await testApi(t, { allowed: new Set([laptop]), probes: new Map() });
  const page = (path: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: s.port, path, agent: false, headers: { host: `127.0.0.1:${s.port}` } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, text }));
    });
    req.on("error", reject);
    req.end();
  });
  const badge = async () => /id="report-badge"[^>]*href="([^"]+)"/.exec((await page("/")).text)?.[1] ?? null;
  assert.equal(await badge(), null, "no report yet");
  assert.match((await page("/reports")).text, /No daily report yet/);
  s.registry.saveReport(ok, 0);
  assert.equal(await badge(), null, "a report that found nothing");
  const bad = s.registry.saveReport(failing, 0);
  assert.equal(await badge(), `/reports/${bad.id}`);
  const shown = (await page(`/reports/${bad.id}`)).text;
  assert.match(shown, /<h2>Control plane<\/h2>[\s\S]*data-check="backup" data-status="fail"[\s\S]*the newest backup is 27 h old[\s\S]*<h2>rj-firebat<\/h2>[\s\S]*data-check="disk" data-status="warn"/);
  assert.match(shown, /title="The daily report of 2026-11-02 00:30 UTC: 1 failed and 1 warned"/);
  assert.match((await page("/reports")).text, /aria-current="page">2026-11-02 00:30 UTC/, "/reports shows the latest");
  s.registry.saveReport({ ...ok, at: "2026-11-03T00:30:00.000Z" }, 0);
  assert.equal(await badge(), null, "a later report that found nothing takes the badge away");
  assert.equal((await page("/reports/99")).status, 404);
});
