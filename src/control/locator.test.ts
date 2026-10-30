import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryLocator } from "./locator.ts";
import { openRegistry, type ThreadId } from "./registry.ts";
import { addThread, observeNode, seedRegistry } from "./test-kit.ts";
import type { NodeName, PylonId } from "../ids.ts";
import { probePort } from "../protocol/routes.ts";
import { runningPylon, testCapacity } from "../test-kit.ts";

const node = "infra-testbench" as NodeName;
const threadId = "th-1" as ThreadId;
const pylonId = "pylon-th-1" as PylonId;

const dir = await mkdtemp(join(tmpdir(), "nexus-locator-"));
after(() => rm(dir, { recursive: true }));

function seeded(t: import("node:test").TestContext) {
  const registry = seedRegistry(openRegistry(join(dir, `${randomUUID()}.db`)), { nodes: [node] });
  t.after(() => registry.close());
  addThread(registry, { node, thread: { id: threadId, conversationId: "1", createdAt: 0, agentTurnRunning: true, working: true, lastHumanActivityAt: 0 }, liveHash: "h" });
  return registry;
}

const capacity = testCapacity({ memoryGiB: 32 });
const running = runningPylon(pylonId);

test("a pylon is located at its node's probe once the node reports it running", async (t) => {
  const registry = seeded(t);
  observeNode(registry, { node, capacity, pylons: [{ pylonId, phase: "booting" }] });
  const located = registryLocator(registry).awaitRunning(pylonId, Date.now() + 60_000);
  observeNode(registry, { node, capacity, pylons: [running] });
  assert.deepEqual(await located, { node, host: "infra-testbench.tail.ts.net", port: probePort, nodeId: "nTESTBENCH" });
});

test("a running pylon on an offline node is not reachable, and the wait ends at the deadline", async (t) => {
  const registry = seeded(t);
  observeNode(registry, { node, capacity, pylons: [running] });
  registry.markOffline(node);
  await assert.rejects(registryLocator(registry).awaitRunning(pylonId, Date.now() + 300), /was not running by/);
});

test("the wait for a deleted thread's pylon ends at once", async (t) => {
  const registry = seeded(t);
  const located = registryLocator(registry).awaitRunning(pylonId, Date.now() + 60_000);
  registry.setThreadStatus(threadId, "deleted");
  await assert.rejects(located, /is deleted/);
});
