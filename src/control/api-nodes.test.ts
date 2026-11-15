/** Node routes: the list, overcommit and a node's health. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadDetail } from "./wire.ts";
import type { Thread } from "./thread-store.ts";
import { stoppedPylon, testCapacity, testObservation } from "../test-support/kit.ts";
import type { ImageId, NodeName, PylonId, TailnetNodeId } from "../ids.ts";
import type { ProjectPlacement } from "../contract/reports.ts";
import type { NodeHealth } from "../protocol/client.ts";
import { node, laptop, phone, image, project, testApi, withThread, observeNode, withImage, deployment, admitStep } from "../test-support/api-kit.ts";

test("nodes are listed with their state and capacity, without the observation", async (t) => {
  const s = await testApi(t);
  const offline = { name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT", state: "offline", capacity: null, observedAt: null, overcommitted: false, pylons: null };
  assert.deepEqual(await s.call("GET", "/v1/nodes"), { status: 200, body: [offline] });
  const capacity = testCapacity();
  const none = { pylons: 0, cpus: 0, memoryGiB: 0 };
  s.registry.threads.apply({ record: "node", node, state: "online", capacity });
  s.registry.threads.ingested(testObservation(node, { observedAt: "2027-01-01T00:01:00Z" }), []);
  assert.deepEqual((await s.call("GET", "/v1/nodes")).body, [{ ...offline, state: "online", capacity, observedAt: "2027-01-01T00:01:00Z", pylons: { up: none, paused: none, archived: none, crashed: none, orphaned: [], stuck: [] } }]);
});

test("nodes report whether they are overcommitted, and their observed pylons as up, paused, archived, crashed and orphaned", async (t) => {
  const s = await withImage(t);
  const started = async (title: string) => (await s.call("POST", "/v1/threads", { project: "acme", title, node: "a" })).body as Thread;
  observeNode(s, "a", { total: 64, committed: 0 });
  const [up, paused, archived, failing, crashed, given] = [await started("Up"), await started("Paused"), await started("Archived"), await started("Failing"), await started("Crashed"), await started("Given up")];
  for (const thread of [archived, given]) assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).status, 200);
  s.registry.threads.savePylon({ ...s.registry.threads.pylon(up.pylonId)!, boot: { ...s.registry.threads.pylon(up.pylonId)!.boot, resources: { cpus: 4, memoryGiB: 8, diskGiB: 10 } } });
  const stopped = (t: Thread) => stoppedPylon(t.pylonId, { sessions: null });
  observeNode(s, "a", { total: 6, committed: 8 }, {
    pylons: [{ pylonId: up.pylonId, phase: "booting" }, stopped(paused), stopped(archived), { pylonId: "pylon-gone" as PylonId, phase: "booting" },
      { pylonId: failing.pylonId, phase: "broken", detail: "a service did not start", cause: "services", logTail: "" },
      { pylonId: crashed.pylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" },
      { pylonId: given.pylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" }],
  });
  const nodes = (await s.call("GET", "/v1/nodes")).body as { name: string; overcommitted: boolean; pylons: unknown }[];
  const of = (name: string) => nodes.find((n) => n.name === name)!;
  assert.equal(of("a").overcommitted, true);
  assert.deepEqual(of("a").pylons, {
    up: { pylons: 2, cpus: 6, memoryGiB: 12 }, paused: { pylons: 1, cpus: 2, memoryGiB: 4 }, archived: { pylons: 2, cpus: 4, memoryGiB: 8 },
    crashed: { pylons: 1, cpus: 2, memoryGiB: 4 }, orphaned: ["pylon-gone"], stuck: [],
  }, "a VM whose service failed still holds its CPUs and memory, one whose controller exited holds only its disk, and with its thread archived it waits for an unarchive, not a retry");
  assert.deepEqual([of(node).overcommitted, of(node).pylons], [false, null], "a node never observed has no pylons to report");
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
  assert.deepEqual(await s.call("GET", `/v1/nodes/${node}/health`), { status: 403, body: { error: `caller may not read a node's health: only deployers may, never infrastructure nodes or pylons${admitStep(phone, "deploy")}`, code: null, retryable: false } });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("GET", `/v1/nodes/${node}/health`)).status, 403, "the control node is never a deployer, though listed");
  s.callAs(laptop);
  assert.deepEqual(await s.call("GET", "/v1/nodes/nowhere/health"), { status: 404, body: { error: "no node nowhere", code: null, retryable: false } });
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await s.call(method, `/v1/nodes/${node}/health`, {})).status, 405, `${method} is no route`);
  s.nodeHealth(async () => { throw Object.assign(new Error(`${node}: connect ECONNREFUSED`), { code: "unreachable" }); });
  assert.deepEqual(await s.call("GET", `/v1/nodes/${node}/health`), { status: 503, body: { error: `${node}: connect ECONNREFUSED`, code: "probe-unreachable", retryable: false } });
  assert.equal(reads, 1, "a refused caller reaches no probe");
  const off = await testApi(t);
  assert.equal((await off.call("GET", `/v1/nodes/${node}/health`)).status, 403, "with no deployers configured, nobody reads it");
});

test("placement preview uses the start's project and dotfiles inputs, protects health, and reserves nothing", async (t) => {
  const s = await testApi(t, { deployment });
  assert.equal((await s.call("POST", "/v1/projects", { ...project, repoUrl: "https://example.com/acme.git", defaultNode: "auto" })).status, 201);
  assert.equal((await s.call("GET", "/v1/placement/acme")).status, 409, "no image yet is explicit, not a guessed decision");
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
  observeNode(s, "full", { total: 32, committed: 24 });
  observeNode(s, "no-ssh", { total: 32, committed: 0 }, { grants: { secrets: ["STRIPE_KEY", "NEXUS_CHATGPT_TOKEN"], gitSsh: false } });
  const at = Date.now();
  s.registry.nodeMetrics.recordHealthSample("full", { at, values: { memAvailable: 4.5 } });
  const reply = await s.call("GET", "/v1/placement/acme");
  assert.equal(reply.status, 200);
  const report = reply.body as ProjectPlacement;
  assert.deepEqual(report.resources, project.resources);
  assert.equal(report.defaultNode, "auto");
  assert.equal(report.best, null);
  assert.deepEqual(report.nearest, { node: "full", missingGiB: 0.5 });
  assert.match(report.nodes.find((n) => n.node === "no-ssh")!.reason!, /dotfiles.git/, "HTTPS project still needs the configured SSH dotfiles grant");
  assert.equal(report.nodes.find((n) => n.node === "full")!.memory!.sampledAt, at);
  assert.deepEqual(report.nodes.find((n) => n.node === node), { node, admitted: false, reason: "is offline", memory: null });
  assert.equal(s.registry.threads.threads().length, 0);
  assert.deepEqual(s.registry.placement.reserved("full" as NodeName), []);
  assert.equal((await s.call("GET", "/v1/placement/missing")).status, 404);
  assert.equal((await s.call("POST", "/v1/placement/acme", {})).status, 405);
  const start = await s.call("POST", "/v1/threads", { project: "acme", title: "No room", node: "auto" });
  assert.equal(start.status, 409);
  for (const n of report.nodes) assert.ok(start.body.error.includes(`${n.node} ${n.reason}`));
  assert.match(start.body.error, /nearest node: full needs 0.5 GiB more memory$/);
  s.callAs(phone);
  assert.equal((await s.call("GET", "/v1/placement/acme")).status, 403);
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("GET", "/v1/placement/acme")).status, 403);
  s.callAs(laptop);
  assert.equal((await s.call("DELETE", "/v1/projects/acme")).status, 200);
  assert.equal((await s.call("GET", "/v1/placement/acme")).status, 409);
});
