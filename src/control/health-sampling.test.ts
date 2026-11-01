/** The background read of each online node's health, once a minute, through the clients that record it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName, TailnetNodeId } from "../ids.ts";
import type { NodeHealth } from "../protocol/client.ts";
import { testCapacity } from "../test-kit.ts";
import { healthSampling } from "./health-sampling.ts";
import { recordingHealth, sampleOf } from "./node-metrics.ts";
import { testRegistry } from "./test-kit.ts";

const healthOf = (node: NodeName): NodeHealth => ({
  node, readAt: "2026-11-01T12:00:00.000Z", cpus: 8, load: { one: 1, five: 1, fifteen: 1 }, memory: null,
  disk: { path: "/var/lib/nexus", totalGiB: 100, freeGiB: 50 }, temperatures: null, pylons: null,
});

/** A registry with the nodes, online or not, and a recording client per node whose reads the test answers. */
function fleet(t: Parameters<typeof testRegistry>[0], nodes: Record<string, "online" | "offline">) {
  const registry = testRegistry(t);
  let now = Date.UTC(2026, 10, 1, 12);
  const reads = new Map<NodeName, number>();
  const answers = new Map<NodeName, () => Promise<NodeHealth>>();
  const logged: string[] = [];
  const probes = new Map(Object.entries(nodes).map(([name, state]) => {
    const node = name as NodeName;
    registry.upsertNode({ name: node, tailnetHost: `${name}.tail.ts.net`, tailnetNodeId: `n${name}` as TailnetNodeId });
    if (state === "online") registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
    const client = { health: () => { reads.set(node, (reads.get(node) ?? 0) + 1); return answers.get(node)?.() ?? Promise.resolve(healthOf(node)); } };
    return [node, recordingHealth(client, (h) => registry.recordHealthSample(node, sampleOf(h, now, () => null)), (m) => logged.push(m))] as const;
  }));
  const sampling = healthSampling({ registry, probes, log: (m) => logged.push(m) });
  t.after(() => sampling.close());
  return { registry, sampling, reads, answers, logged, tick: (ms: number) => { now += ms; } };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a pass reads and records each online node's health, and skips an offline one", async (t) => {
  const f = fleet(t, { a: "online", b: "online", c: "offline" });
  f.sampling.poll();
  await settled();
  assert.deepEqual(Object.fromEntries(f.reads), { a: 1, b: 1 }, "the offline node is not read");
  for (const node of ["a", "b"] as NodeName[]) assert.equal(f.registry.latestHealthSample(node)?.values.load1, 1, `${node}'s read is recorded`);
  assert.equal(f.registry.latestHealthSample("c" as NodeName), null);
  f.tick(60_000);
  f.sampling.poll();
  await settled();
  assert.deepEqual(Object.fromEntries(f.reads), { a: 2, b: 2 }, "the next pass reads them again");
});

test("a slow node's read is not overlapped by the next pass, nor does it hold up the others", async (t) => {
  const f = fleet(t, { slow: "online", fast: "online" });
  let answer!: (h: NodeHealth) => void;
  f.answers.set("slow" as NodeName, () => new Promise((resolve) => { answer = resolve; }));
  f.sampling.poll();
  await settled();
  assert.equal(f.registry.latestHealthSample("fast" as NodeName) !== null, true, "the fast node is recorded while the slow one still reads");
  for (const _ of [1, 2, 3]) {
    f.tick(60_000);
    f.sampling.poll();
    await settled();
  }
  assert.deepEqual(Object.fromEntries(f.reads), { slow: 1, fast: 4 }, "the slow node is skipped, not queued, while its read is in flight");
  f.answers.delete("slow" as NodeName);
  answer(healthOf("slow" as NodeName));
  await settled();
  assert.notEqual(f.registry.latestHealthSample("slow" as NodeName), null);
  f.tick(60_000);
  f.sampling.poll();
  await settled();
  assert.equal(f.reads.get("slow" as NodeName), 2, "once its read settles, the next pass reads it again");
});

test("an unreachable node's failed read records nothing, is logged once while it fails the same way, and is tried again", async (t) => {
  const f = fleet(t, { gone: "online" });
  f.answers.set("gone" as NodeName, () => Promise.reject(new Error("gone: unreachable")));
  for (const _ of [1, 2]) {
    f.sampling.poll();
    await settled();
  }
  assert.equal(f.reads.get("gone" as NodeName), 2);
  assert.equal(f.registry.latestHealthSample("gone" as NodeName), null);
  assert.deepEqual(f.logged, ["gone: reading its health for its history failed, and the next pass tries again: gone: unreachable"]);
});
