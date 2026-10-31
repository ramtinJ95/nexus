/** Where a start goes when a node's pylons' filesystem is about to run out. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName } from "../ids.ts";
import type { DiskFact } from "../protocol/observations.ts";
import { testCapacity } from "../test-kit.ts";
import { node, observeNode, withImage } from "./api-test-kit.ts";

const pylonsAt = (totalGiB: number, freeGiB: number): DiskFact => ({ paths: ["/var/lib/nexus/pylons", "/var/lib/nexus/artifacts"], totalGiB, freeGiB, pylons: true });

function observeDisks(s: Awaited<ReturnType<typeof withImage>>, name: string, disks: DiskFact[]) {
  const capacity = testCapacity({ diskFreeGiB: disks[0]!.freeGiB, disks });
  observeNode(s, name, { total: 64, committed: 0 }, { capacity });
  s.registry.apply({ record: "node", node: name as NodeName, state: "online", capacity });
}

test("--node auto passes over a node whose pylons' filesystem would keep less than max(10 GiB, 5%) free, though it has the most memory", async (t) => {
  const s = await withImage(t);
  observeDisks(s, "short", [pylonsAt(100, 19)]);
  observeNode(s, "roomy", { total: 32, committed: 0 });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.placement.node, "roomy");
  assert.deepEqual(started.body.placement.weighed.find((w: { node: string }) => w.node === "short"), {
    node: "short", refused: "has 19.0 of 100.0 GiB free on the filesystem of /var/lib/nexus/pylons, /var/lib/nexus/artifacts, and a 10 GiB pylon disk would leave less than the 10.0 GiB it keeps free",
  });

  observeDisks(s, "short", [pylonsAt(1000, 59)]);
  const again = await s.call("POST", "/v1/threads", { project: "acme", title: "Again", node: "auto" });
  assert.equal(again.body.placement.node, "roomy", "of 1000 GiB it keeps 50, which 59 less a 10 GiB disk is not");
  observeDisks(s, "short", [pylonsAt(1000, 65)]);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Fits", node: "auto" })).body.placement.node, "short");
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Counted", node: "auto" })).body.placement.node, "roomy",
    "the 10 GiB disk of the start placed there and not yet reported leaves 55 GiB, which another 10 GiB disk would cut under 50");
});

test("a start on a node it or its project names fails with the filesystem and its free space, and creates no thread", async (t) => {
  const s = await withImage(t);
  observeDisks(s, "short", [pylonsAt(100, 15)]);
  const named = await s.call("POST", "/v1/threads", { project: "acme", title: "Named", node: "short" });
  assert.equal(named.status, 409);
  assert.match(JSON.stringify(named.body), /short has 15\.0 of 100\.0 GiB free on the filesystem of \/var\/lib\/nexus\/pylons, \/var\/lib\/nexus\/artifacts, and a 10 GiB pylon disk would leave less than the 10\.0 GiB it keeps free/);
  observeDisks(s, node, [pylonsAt(100, 15)]);
  const byDefault = await s.call("POST", "/v1/threads", { project: "acme", title: "Default" });
  assert.equal(byDefault.status, 409, JSON.stringify(byDefault.body));
  assert.match(JSON.stringify(byDefault.body), new RegExp(`${node} has 15\\.0 of 100\\.0 GiB free`));
  assert.deepEqual((await s.call("GET", "/v1/threads")).body, []);

  observeDisks(s, "short", [pylonsAt(100, 20)]);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Fits", node: "short" })).status, 201, "10 GiB left is the 10 GiB kept");
  observeNode(s, "old", { total: 64, committed: 0 }, { capacity: testCapacity({ diskFreeGiB: 5 }) });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Old probe", node: "old" })).status, 201, "a probe that reports no filesystems is not checked, as before");
  observeNode(s, "docker", { total: 64, committed: 0 }, { capacity: testCapacity({ diskFreeGiB: 5, disks: [{ paths: ["/"], totalGiB: 100, freeGiB: 5 }] }) });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Docker", node: "docker" })).status, 201, "a Docker probe marks no pylons' filesystem, since it keeps no pylon disks");
});
