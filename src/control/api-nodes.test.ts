/** Node routes: the list, overcommit and a node's health. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadDetail } from "./wire.ts";
import type { Thread } from "./registry.ts";
import { stoppedPylon, testCapacity, testObservation } from "../test-kit.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../ids.ts";
import type { NodeHealth } from "../protocol/client.ts";
import { node, laptop, phone, image, testApi, withThread, observeNode, withImage, deployment } from "./api-test-kit.ts";

test("nodes are listed with their state and capacity, without the observation", async (t) => {
  const s = await testApi(t);
  const offline = { name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT", state: "offline", capacity: null, observedAt: null, overcommitted: false, pylons: null };
  assert.deepEqual(await s.call("GET", "/v1/nodes"), { status: 200, body: [offline] });
  const capacity = testCapacity();
  const none = { pylons: 0, cpus: 0, memoryGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  s.registry.ingested(testObservation(node, { observedAt: "2027-01-01T00:01:00Z" }), []);
  assert.deepEqual((await s.call("GET", "/v1/nodes")).body, [{ ...offline, state: "online", capacity, observedAt: "2027-01-01T00:01:00Z", pylons: { up: none, paused: none, archived: none, crashed: none, orphaned: [] } }]);
});

test("nodes report whether they are overcommitted, and their observed pylons as up, paused, archived, crashed and orphaned", async (t) => {
  const s = await withImage(t);
  const started = async (title: string) => (await s.call("POST", "/v1/threads", { project: "acme", title, node: "a" })).body as Thread;
  observeNode(s, "a", { total: 64, committed: 0 });
  const [up, paused, archived, failing, crashed, given] = [await started("Up"), await started("Paused"), await started("Archived"), await started("Failing"), await started("Crashed"), await started("Given up")];
  for (const thread of [archived, given]) assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).status, 200);
  s.registry.savePylon({ ...s.registry.pylon(up.pylonId)!, boot: { ...s.registry.pylon(up.pylonId)!.boot, resources: { cpus: 4, memoryGiB: 8, diskGiB: 10 } } });
  const stopped = (t: Thread) => stoppedPylon(t.pylonId, { sessions: null });
  observeNode(s, "a", { total: 6, committed: 8 }, {
    pylons: [{ pylonId: up.pylonId, phase: "booting" }, stopped(paused), stopped(archived), { pylonId: "pylon-gone" as PylonId, phase: "booting" },
      { pylonId: failing.pylonId, phase: "broken", detail: "a service did not start", cause: "services", logTail: "" },
      { pylonId: crashed.pylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" },
      { pylonId: given.pylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" }],
  });
  observeNode(s, "old", { total: 6, committed: 8 });
  s.registry.apply({ record: "node", node: "old" as NodeName, state: "online", capacity: { memoryGiB: 6, committedMemoryGiB: 8, diskFreeGiB: 100 } as never });
  const nodes = (await s.call("GET", "/v1/nodes")).body as { name: string; overcommitted: boolean; pylons: unknown }[];
  const of = (name: string) => nodes.find((n) => n.name === name)!;
  assert.equal(of("a").overcommitted, true);
  assert.deepEqual(of("a").pylons, {
    up: { pylons: 2, cpus: 6, memoryGiB: 12 }, paused: { pylons: 1, cpus: 2, memoryGiB: 4 }, archived: { pylons: 2, cpus: 4, memoryGiB: 8 },
    crashed: { pylons: 1, cpus: 2, memoryGiB: 4 }, orphaned: ["pylon-gone"],
  }, "a VM whose service failed still holds its CPUs and memory, one whose controller exited holds only its disk, and with its thread archived it waits for an unarchive, not a retry");
  assert.equal(of("old").overcommitted, false, "a probe from before pylons were counted reports a committed memory that means nothing");
  assert.deepEqual([of(node).overcommitted, of(node).pylons], [false, null], "a node never observed has no pylons to report");
});

test("a node whose stored observation is from a probe before routes, grants, counting and listening ports gets no thread, is not overcommitted, and its pylon's ports are unknown", async (t) => {
  const s = await withThread(t);
  const capacity = { memoryGiB: 6, committedMemoryGiB: 8, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity: capacity as never });
  const running = {
    pylonId: s.thread.pylonId, phase: "running", liveHash: s.registry.pylon(s.thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id, checkpoint: null }, services: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  s.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", events: [], capacity, artifacts: [image.id], jobs: [], pylons: [running] } as never, []);
  assert.equal(((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports, null, "a probe that read no ports reports them unknown");
  const nodes = (await s.call("GET", "/v1/nodes")).body as { name: string; overcommitted: boolean }[];
  assert.equal(nodes.find((n) => n.name === node)!.overcommitted, false, "the committed memory of a probe from before pylons were counted means nothing");
  const refused = await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "no node can run this pylon: rj-firebat runs a probe too old to report what its pylons hold");
});

const health: NodeHealth = {
  node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: { one: 2.5, five: 1.75, fifteen: 1 },
  memory: { totalGiB: 62.8, availableGiB: 40.2, swapTotalGiB: 8, swapFreeGiB: 8 }, disk: { path: "/var/lib/nexus", totalGiB: 457, freeGiB: 180.3 },
  temperatures: null, pylons: [{ pylonId: "pylon-th-aaaaaaaaaaaa" as PylonId, processes: 2, cpuPercent: 12.5, residentGiB: 6.2 }],
};

test("only a deployer reads a node's health, which the node's probe answers, and no route under it changes the node", async (t) => {
  const s = await testApi(t, { deployment });
  let reads = 0;
  s.nodeHealth(async () => { reads++; return health; });
  assert.deepEqual(await s.call("GET", `/v1/nodes/${node}/health`), { status: 200, body: health });
  s.callAs(phone);
  assert.deepEqual(await s.call("GET", `/v1/nodes/${node}/health`), { status: 403, body: { error: "caller may not read a node's health: only deployers may, never infrastructure nodes or pylons" } });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("GET", `/v1/nodes/${node}/health`)).status, 403, "the control node is never a deployer, though listed");
  s.callAs(laptop);
  assert.deepEqual(await s.call("GET", "/v1/nodes/nowhere/health"), { status: 404, body: { error: "no node nowhere" } });
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await s.call(method, `/v1/nodes/${node}/health`, {})).status, 405, `${method} is no route`);
  s.nodeHealth(async () => { throw Object.assign(new Error(`${node}: connect ECONNREFUSED`), { code: "unreachable" }); });
  assert.deepEqual(await s.call("GET", `/v1/nodes/${node}/health`), { status: 503, body: { error: `${node}: connect ECONNREFUSED` } });
  assert.equal(reads, 1, "a refused caller reaches no probe");
  const off = await testApi(t);
  assert.equal((await off.call("GET", `/v1/nodes/${node}/health`)).status, 403, "with no deployers configured, nobody reads it");
});
