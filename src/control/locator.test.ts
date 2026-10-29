import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryLocator } from "./locator.ts";
import { openRegistry, type ThreadId } from "./registry.ts";
import { addThread, seedRegistry } from "./test-kit.ts";
import { probePort, type NodeName, type NodeObservation, type PylonId, type PylonObservation } from "../protocol.ts";

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

function observe(registry: ReturnType<typeof openRegistry>, pylon: PylonObservation) {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 32, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  const observation: NodeObservation = { node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons: [pylon], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] };
  registry.ingested(observation, [{ record: "node", node, state: "online", capacity }]);
}

const running: PylonObservation = {
  pylonId, phase: "running", liveHash: null, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000", checkpoint: null },
  services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
};

test("a pylon is located at its node's probe once the node reports it running", async (t) => {
  const registry = seeded(t);
  observe(registry, { pylonId, phase: "booting" });
  const located = registryLocator(registry).awaitRunning(pylonId, Date.now() + 60_000);
  observe(registry, running);
  assert.deepEqual(await located, { node, host: "infra-testbench.tail.ts.net", port: probePort, nodeId: "nTESTBENCH" });
});

test("a running pylon on an offline node is not reachable, and the wait ends at the deadline", async (t) => {
  const registry = seeded(t);
  observe(registry, running);
  registry.markOffline(node);
  await assert.rejects(registryLocator(registry).awaitRunning(pylonId, Date.now() + 300), /was not running by/);
});

test("the wait for a deleted thread's pylon ends at once", async (t) => {
  const registry = seeded(t);
  const located = registryLocator(registry).awaitRunning(pylonId, Date.now() + 60_000);
  registry.setThreadStatus(threadId, "deleted");
  await assert.rejects(located, /is deleted/);
});
