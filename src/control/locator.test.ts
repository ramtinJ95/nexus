import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryLocator } from "./locator.ts";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { probePort, type LiveHash, type NodeName, type NodeObservation, type PylonId, type PylonObservation, type TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";

const node = "infra-testbench" as NodeName;
const threadId = "th-1" as ThreadId;
const pylonId = "pylon-th-1" as PylonId;

const dir = await mkdtemp(join(tmpdir(), "nexus-locator-"));
after(() => rm(dir, { recursive: true }));

function seeded(t: import("node:test").TestContext) {
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  t.after(() => registry.close());
  registry.upsertNode({ name: node, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nTESTBENCH" as TailnetNodeId });
  registry.createProject({
    id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
    resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
  const thread: Thread = {
  seenAt: null, lastReplyAt: null,
    id: threadId, title: "t", project: "acme" as ProjectId, pylonId, status: "active", conversationId: "1", startedBy: "nLAPTOP",
    createdAt: 0, agentTurnRunning: true, lastAgentActivityAt: 0, lastHumanActivityAt: 0,
  };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: threadId, pylonId, node, desired: "running",
    boot: {
      pylonId, image: "img-000000000000", resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 }, network: { allowedHosts: [], secrets: [] },
      repo: { kind: "clone", url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
      dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    },
    firstBoot: { kind: "fresh", preSetup: null },
    live: { previews: [], overlay: [] },
    liveHash: "h" as LiveHash,
  });
  registry.createThread(thread, pylon);
  return registry;
}

function observe(registry: ReturnType<typeof openRegistry>, pylon: PylonObservation) {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 32, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  const observation: NodeObservation = { node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [pylon], grants: { secrets: [], gitSsh: false }, previewRoutes: [] };
  registry.ingested(observation, [{ record: "node", node, state: "online", capacity }]);
}

const running: PylonObservation = {
  pylonId, phase: "running", liveHash: null, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000", checkpoint: null },
  services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
};

test("a pylon is located at its node's probe once the node reports it running", async (t) => {
  const registry = seeded(t);
  observe(registry, { pylonId, phase: "booting" });
  const located = registryLocator(registry).awaitRunning(pylonId, Date.now() + 10_000);
  setTimeout(() => observe(registry, running), 100);
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
