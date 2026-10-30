import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName } from "../ids.ts";
import type { PylonObservation } from "../protocol/observations.ts";
import { runningPylon, stoppedPylon, testCapacity, testObservation } from "../test-kit.ts";
import { observedPylon, runningProbe } from "./observed.ts";
import { addThread, seedRegistry, testRegistry } from "./test-kit.ts";

const node = "rj-firebat" as NodeName;

test("a pylon is observed as its node last listed it, online or not, and its probe is handed out only while it runs on an online node", (t) => {
  const registry = seedRegistry(testRegistry(t), { nodes: [node] });
  const thread = addThread(registry, { node });
  const pylon = registry.pylon(thread.pylonId)!;
  const probe = { name: "the probe" };
  const probes = new Map([[node, probe]]);
  const capacity = testCapacity();
  const observe = (pylons: PylonObservation[]) => registry.ingested(testObservation(node, { observedAt: "2027-01-01T00:00:00Z", pylons }), []);
  const stopped = stoppedPylon(thread.pylonId, { sessions: null });
  const running = runningPylon(thread.pylonId, { bootedFrom: { image: pylon.boot.image, checkpoint: null }, services: null });

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
