/** `GET /v1/nodes/<name>/metrics`: a node's recorded health over a range, which only a deployer reads. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PylonId, TailnetNodeId } from "../ids.ts";
import type { NodeHealth } from "../protocol/client.ts";
import type { NodeMetrics } from "./node-metrics.ts";
import { sampleOf } from "./node-metrics.ts";
import { node, phone, testApi, withThread, deployment } from "./api-test-kit.ts";

const hour = 3_600_000;
const day = 24 * hour;

test("a node's metrics are labelled for a person: a plain series by name, a sensor by its own, and a pylon by its thread's title or else its ID", async (t) => {
  const s = await withThread(t, { deployment });
  const health: NodeHealth = {
    node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: { one: 2.5, five: 1.75, fifteen: 1 },
    memory: { totalGiB: 62.8, availableGiB: 40.2, swapTotalGiB: 8, swapFreeGiB: 8 }, disk: { path: "/var/lib/nexus", totalGiB: 457, freeGiB: 180.3 },
    temperatures: [{ sensor: "Composite", celsius: 41 }, { sensor: "Composite", celsius: 44 }],
    pylons: [{ pylonId: s.thread.pylonId, processes: 2, cpuPercent: 12.5, residentGiB: 6.2 }, { pylonId: "pylon-gone" as PylonId, processes: 1, cpuPercent: 3, residentGiB: 0.5 }],
  };
  const at = Date.now() - 1_000;
  s.registry.recordHealthSample(node, sampleOf(health, at, (p) => s.registry.pylon(p)?.thread ?? null));
  const { status, body } = await s.call("GET", `/v1/nodes/${node}/metrics?from=${at - hour}&to=${at + 1}`);
  assert.equal(status, 200);
  const metrics = body as NodeMetrics;
  assert.deepEqual([metrics.node, metrics.from, metrics.to, metrics.tier, metrics.bucketMs], [node, at - hour, at + 1, "raw", 4_000]);
  assert.deepEqual(Object.fromEntries(metrics.series.map((m) => [m.key, m.label])), {
    cpus: "CPUs", diskFree: "Disk free", diskTotal: "Disk total", load1: "1-minute load", load15: "15-minute load", load5: "5-minute load",
    memAvailable: "Memory available", memTotal: "Memory total", swapTotal: "Swap total", swapUsed: "Swap used",
    [`pylonCpu:${s.thread.pylonId}:${s.thread.id}`]: "Fix checkout", [`pylonResident:${s.thread.pylonId}:${s.thread.id}`]: "Fix checkout",
    "pylonCpu:pylon-gone:": "pylon-gone", "pylonResident:pylon-gone:": "pylon-gone", "temp:Composite": "Composite", "temp:Composite (2)": "Composite (2)",
  });
  assert.deepEqual(metrics.series.find((m) => m.key === "load1"), { key: "load1", series: { kind: "load1" }, label: "1-minute load", t: [at], min: [2.5], avg: [2.5], max: [2.5], n: [1] });
});

test("a node's metrics never hold more than 1,000 points a series, whatever the range", async (t) => {
  const s = await testApi(t, { deployment });
  const now = Date.now();
  for (let at = now - 25 * hour; at < now - 2 * hour; at += 60_000) s.registry.recordHealthSample(node, { at, values: { load1: 1 } });
  for (let at = now - 2 * hour; at < now; at += 4_000) s.registry.recordHealthSample(node, { at, values: { load1: 1 } });
  for (const span of [hour, 2 * hour, 6 * hour, day, 31 * day]) {
    const { body } = await s.call("GET", `/v1/nodes/${node}/metrics?from=${now - span}&to=${now}`);
    const points = (body as NodeMetrics).series[0]!.t.length;
    assert.ok(points > 0 && points <= 1_000, `${span / hour} h: ${points} points`);
  }
});

test("only a deployer reads a node's metrics, of a node that exists, over a range of at most 31 days", async (t) => {
  const s = await testApi(t, { deployment });
  const to = Date.now();
  const path = (query: string, name: string = node) => `/v1/nodes/${name}/metrics?${query}`;
  const refused = (error: string) => ({ status: 400, body: { error } });
  assert.deepEqual(await s.call("GET", path(`from=${to - hour}&to=${to}`)), { status: 200, body: { node, from: to - hour, to, tier: "raw", bucketMs: 4_000, series: [] } });
  assert.deepEqual(await s.call("GET", path("")), refused("from must be a whole number of milliseconds since the epoch"));
  for (const bad of ["from=1.5", "from=-1", "from=soon", `from=1&to=${to}x`]) assert.equal((await s.call("GET", path(bad))).status, 400, bad);
  assert.deepEqual(await s.call("GET", path(`from=${to}&to=${to}`)), refused("from must be before to"));
  assert.deepEqual(await s.call("GET", path(`from=${to - 31 * day - 1}&to=${to}`)), refused("the range must span at most 31 days, as long as the registry keeps a node's metrics"));
  assert.equal((await s.call("GET", path(`from=${to - 31 * day}&to=${to}`))).status, 200, "31 days exactly");
  assert.equal((await s.call("GET", path(`from=${to - hour}`))).body.to >= to, true, "to defaults to now");
  assert.deepEqual(await s.call("GET", path(`from=${to - hour}`, "nowhere")), { status: 404, body: { error: "no node nowhere" } });
  s.callAs(phone);
  assert.deepEqual(await s.call("GET", path(`from=${to - hour}`)), { status: 403, body: { error: "caller may not read a node's metrics: only deployers may, never infrastructure nodes or pylons" } });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("GET", path(`from=${to - hour}`))).status, 403, "the control node is never a deployer, though listed");
  const off = await testApi(t);
  assert.equal((await off.call("GET", path(`from=${to - hour}`))).status, 403, "with no deployers configured, nobody reads it");
});
