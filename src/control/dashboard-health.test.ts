/** The dashboard's Health link, which counts the problems not seen, and the Health page. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { DoctorReport } from "./doctor-model.ts";
import { laptop, testApi } from "./api-test-kit.ts";

const latest: DoctorReport = {
  at: "2026-11-02T00:30:00.000Z", status: "fail", checks: [
    { node: null, name: "backup", status: "fail", text: "the newest backup is 27 h old" },
    { node: "rj-firebat" as never, name: "disk", status: "warn", text: "12.4 of 98.0 GiB free at /var/lib/nexus-control, low" },
    { node: "rj-firebat" as never, name: "online", status: "ok", text: "online and observed in the last 5 min" },
  ],
};

test("the sidebar counts the problems the person has not seen, which opening the Health page clears, and only a new or worse problem brings back", async (t) => {
  let pass: DoctorReport | null = null;
  const s = await testApi(t, { allowed: new Set([laptop]), probes: new Map(), health: () => pass });
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
  const count = async () => /id="health-link"[^>]*>.*?<span class="side-count">(\d*)<\/span>/.exec((await page("/")).text)?.[1];
  const through = async () => /data-health-through="(\d+)"/.exec((await page("/health")).text)?.[1];
  assert.equal(await count(), "", "the link is there, with no count, before any problem");
  const empty = (await page("/health")).text;
  assert.match(empty, /Every check is ok/);
  assert.match(empty, /No pass since the control plane started/);
  assert.match(empty, /No check has changed/);

  const [backup] = s.registry.recordHealthChanges([{ at: "2026-11-02T00:25:00.000Z", node: null, name: "backup", from: "ok", status: "fail", text: "the newest backup is 27 h old" }], 0);
  assert.equal(await count(), "1");
  pass = latest;
  const shown = (await page("/health")).text;
  assert.match(shown, /aria-current="page"/);
  assert.match(shown, /<h2>Control plane<\/h2>[\s\S]*data-check="backup" data-status="fail"[\s\S]*the newest backup is 27 h old[\s\S]*fail since <time datetime="2026-11-02T00:25:00.000Z">2026-11-02 00:25 UTC<\/time> <em>new<\/em>[\s\S]*<h2>rj-firebat<\/h2>[\s\S]*data-check="disk" data-status="warn"[\s\S]*this pass only, so it alerts if the next agrees/);
  assert.match(shown, /1 open problem<\/span> Checked at <time datetime="2026-11-02T00:30:00.000Z">/);
  assert.match(shown, new RegExp(`<li data-change="${backup!.id}" data-status="fail"><time[^>]*>2026-11-02 00:25 UTC</time> Control plane backup <span class="state">.*ok</span> to <span class="state">.*fail</span>: the newest backup is 27 h old</li>`));
  assert.equal(await through(), String(backup!.id));

  assert.equal((await s.call("POST", "/v1/checks/seen", { through: Number(await through()) })).status, 204, "as the page does once the person looks at it");
  assert.equal(await count(), "", "seen, so the count clears while the problem stays open");
  assert.doesNotMatch((await page("/health")).text, /<em>new<\/em>/);
  s.registry.recordHealthChanges([{ at: "2026-11-02T00:35:00.000Z", node: null, name: "backup", from: "fail", status: "warn", text: "the run failed" }], 0);
  assert.equal(await count(), "", "a problem that got better is not new");
  s.registry.recordHealthChanges([{ at: "2026-11-02T00:40:00.000Z", node: "rj-firebat" as never, name: "disk", from: "ok", status: "warn", text: "low" }], 0);
  assert.equal(await count(), "1", "a new problem brings the count back");
  s.registry.recordHealthChanges([{ at: "2026-11-02T00:45:00.000Z", node: "rj-firebat" as never, name: "disk", from: "warn", status: "ok", text: "fine" }], 0);
  assert.equal(await count(), "", "and its recovery takes it away");
  for (const path of ["/reports", "/reports/1"]) assert.equal((await page(path)).status, 404, path);
});
