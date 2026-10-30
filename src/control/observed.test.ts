import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName, NodeObservation, PylonObservation } from "../protocol.ts";
import { observedPylon, runningProbe } from "./observed.ts";
import { openRegistry } from "./registry.ts";
import { addThread, seedRegistry } from "./test-kit.ts";

const node = "rj-firebat" as NodeName;

test("a pylon is observed as its node last listed it, online or not, and its probe is handed out only while it runs on an online node", (t) => {
  const registry = seedRegistry(openRegistry(":memory:"), { nodes: [node] });
  t.after(() => registry.close());
  const thread = addThread(registry, { node });
  const pylon = registry.pylon(thread.pylonId)!;
  const probe = { name: "the probe" };
  const probes = new Map([[node, probe]]);
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  const observe = (pylons: PylonObservation[]) => registry.ingested({
    node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons,
    grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [],
  } satisfies NodeObservation, []);
  const stopped: PylonObservation = { pylonId: thread.pylonId, phase: "stopped", checkpoint: null, sessions: null };
  const running: PylonObservation = {
    pylonId: thread.pylonId, phase: "running", liveHash: null, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: pylon.boot.image, checkpoint: null },
    services: null, listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };

  registry.apply({ record: "node", node, state: "online", capacity });
  assert.equal(observedPylon(registry, pylon), null, "a node that sent no observation");
  assert.equal(runningProbe(registry, probes, thread), null);

  observe([]);
  assert.equal(observedPylon(registry, pylon), "absent", "an observation that leaves the pylon out");
  assert.equal(runningProbe(registry, probes, thread), null);

  observe([stopped]);
  assert.deepEqual(observedPylon(registry, pylon), stopped);
  assert.equal(runningProbe(registry, probes, thread), null, "a stopped pylon");

  observe([running]);
  assert.deepEqual(observedPylon(registry, pylon), running);
  assert.equal(runningProbe(registry, probes, thread), probe, "a running pylon on an online node");
  assert.equal(runningProbe(registry, new Map(), thread), null, "a node with no probe client");

  registry.markOffline(node);
  assert.deepEqual(observedPylon(registry, pylon), running, "an offline node's last observation still lists it");
  assert.equal(runningProbe(registry, probes, thread), null, "an offline node");
});
