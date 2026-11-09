import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName } from "../ids.ts";
import type { PylonObservation } from "../protocol/observations.ts";
import { runningPylon, stoppedPylon, testCapacity, testObservation } from "../test-support/kit.ts";
import { observedPylon } from "./observed.ts";
import { runningProbe } from "./locator.ts";
import { addThread, seedRegistry, testRegistry } from "../test-support/registry-kit.ts";

const node = "rj-firebat" as NodeName;

test("a pylon is observed as its node last listed it, online or not, and its probe is handed out only while it runs on an online node", (t) => {
  const registry = seedRegistry(testRegistry(t), { nodes: [node] });
  const thread = addThread(registry, { node });
  const pylon = registry.threads.pylon(thread.pylonId)!;
  const probe = { name: "the probe" };
  const probes = new Map([[node, probe]]);
  const capacity = testCapacity();
  const observe = (pylons: PylonObservation[]) => registry.threads.ingested(testObservation(node, { observedAt: "2027-01-01T00:00:00Z", pylons }), []);
  const stopped = stoppedPylon(thread.pylonId, { sessions: null });
  const running = runningPylon(thread.pylonId, { bootedFrom: { image: pylon.boot.image, checkpoint: null }, services: null });

  registry.threads.apply({ record: "node", node, state: "online", capacity });
  assert.equal(observedPylon(registry, pylon), null, "a node that sent no observation");
  assert.equal(runningProbe(registry, probes, thread, "work"), null);

  observe([]);
  assert.equal(observedPylon(registry, pylon), "absent", "an observation that leaves the pylon out");
  assert.equal(runningProbe(registry, probes, thread, "work"), null);

  observe([stopped]);
  assert.deepEqual(observedPylon(registry, pylon), stopped);
  assert.equal(runningProbe(registry, probes, thread, "work"), null, "a stopped pylon");

  observe([running]);
  assert.deepEqual(observedPylon(registry, pylon), running);
  assert.equal(runningProbe(registry, probes, thread, "work"), probe, "a running pylon on an online node");
  assert.equal(runningProbe(registry, new Map(), thread, "work"), null, "a node with no probe client");

  registry.nodes.markOffline(node);
  assert.deepEqual(observedPylon(registry, pylon), running, "an offline node's last observation still lists it");
  assert.equal(runningProbe(registry, probes, thread, "work"), null, "an offline node");
});
