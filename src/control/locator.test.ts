import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { registryLocator, runningProbe } from "./locator.ts";
import { addThread, observeNode, seedRegistry, testRegistry } from "../test-support/registry-kit.ts";
import type { Registry } from "./registry.ts";
import type { NodeName, PylonId, ThreadId } from "../ids.ts";
import { probePort } from "../protocol/routes.ts";
import { runningPylon, tempDir, testCapacity } from "../test-support/kit.ts";

const node = "infra-testbench" as NodeName;
const threadId = "th-1" as ThreadId;
const pylonId = "pylon-th-1" as PylonId;

const dir = await tempDir("nexus-locator-");

function seeded(t: import("node:test").TestContext) {
  const registry = seedRegistry(testRegistry(t, join(dir, `${randomUUID()}.db`)), { nodes: [node] });
  addThread(registry, { node, thread: { id: threadId, conversationId: "1", createdAt: 0, agentTurnRunning: true, working: true, lastHumanActivityAt: 0 }, liveHash: "h" });
  return registry;
}

/** A locator over the registry, with `wake` standing in for the loop's wakes. */
function locator(registry: Registry, waitMs = 60_000) {
  const wakes = new Set<() => void>();
  const woken = () => new Promise<void>((resolve) => wakes.add(resolve));
  const wake = () => { for (const resolve of wakes) resolve(); wakes.clear(); };
  return { locator: registryLocator({ registry, probes: new Map([[node, "probe"]]), woken, waitMs }), wake };
}

const capacity = testCapacity({ memoryGiB: 32 });
const running = runningPylon(pylonId);

test("a pylon is located at its node's probe once the node reports it running", async (t) => {
  const registry = seeded(t);
  observeNode(registry, { node, capacity, pylons: [{ pylonId, phase: "booting" }] });
  const { locator: l, wake } = locator(registry);
  const located = l.awaitRunning(pylonId);
  observeNode(registry, { node, capacity, pylons: [running] });
  wake();
  assert.deepEqual(await located, { address: { node, host: "infra-testbench.tail.ts.net", port: probePort, nodeId: "nTESTBENCH" }, client: "probe" });
});

test("a running pylon on an offline node is not reachable, and the wait ends at the deadline", async (t) => {
  const registry = seeded(t);
  observeNode(registry, { node, capacity, pylons: [running] });
  registry.nodes.markOffline(node);
  await assert.rejects(locator(registry, 300).locator.awaitRunning(pylonId), /was not running by/);
});

test("the wait for a deleted thread's pylon ends at once", async (t) => {
  const registry = seeded(t);
  const { locator: l, wake } = locator(registry);
  const located = l.awaitRunning(pylonId);
  registry.threads.setThreadStatus(threadId, "deleted");
  wake();
  await assert.rejects(located, /is deleted/);
});

test("a boot a settle sealed is neither located nor handed out for work until its node reports another boot, though its usage is still read", async (t) => {
  const registry = seeded(t);
  const probes = new Map([[node, "probe"]]);
  observeNode(registry, { node, capacity, pylons: [running] });
  registry.threads.sealBoot(pylonId, running.bootedAt);
  registry.threads.setThreadStatus(threadId, "active");
  const { locator: l, wake } = locator(registry);
  const located = l.awaitRunning(pylonId);
  let found = false;
  void located.then(() => { found = true; });
  wake();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual([found, runningProbe(registry, probes, { pylonId }, "work"), runningProbe(registry, probes, { pylonId }, "usage")], [false, null, "probe"],
    "no tool, message or launch reaches the sealed boot, and the settle's read still does");
  observeNode(registry, { node, capacity, pylons: [runningPylon(pylonId, { bootedAt: "2027-01-01T00:05:00Z" })] });
  wake();
  assert.deepEqual(await located, { address: { node, host: "infra-testbench.tail.ts.net", port: probePort, nodeId: "nTESTBENCH" }, client: "probe" });
  assert.equal(runningProbe(registry, probes, { pylonId }, "work"), "probe");
});
