import { test } from "node:test";
import assert from "node:assert/strict";
import { ProbeHttpError, type NodeName, type TailnetNodeId } from "../protocol.ts";
import { peerHandoff } from "./peers.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { seedRegistry } from "./test-kit.ts";

const names = ["rj-firebat", "infra-testbench", "rj-spare"] as NodeName[];

test("each put reads the nodes' tailnet IDs once, without their records, and a snapshot puts the list again only to a restarted probe", async (t) => {
  const registry = seedRegistry(openRegistry(":memory:"), { nodes: names });
  t.after(() => registry.close());
  let idReads = 0;
  let recordReads = 0;
  const counted: Registry = {
    ...registry,
    nodeIds: () => { idReads++; return registry.nodeIds(); },
    node: (name) => { recordReads++; return registry.node(name); },
  };
  const puts: [NodeName, readonly TailnetNodeId[]][] = [];
  const probes = new Map(names.map((name) => [name, { putPeers: async (peers: readonly TailnetNodeId[]) => { puts.push([name, peers]); } }]));
  const handoff = peerHandoff({ registry: counted, probes, log: assert.fail });

  await handoff.all();
  assert.deepEqual(new Map(puts), new Map([["rj-firebat", ["nTESTBENCH", "nrj-spare"]], ["infra-testbench", ["nFIREBAT", "nrj-spare"]], ["rj-spare", ["nFIREBAT", "nTESTBENCH"]]]));
  assert.equal(idReads, 3);
  assert.equal(recordReads, 0);

  puts.length = 0;
  for (const boot of ["boot-1", "boot-1", "boot-2"]) {
    handoff.observed(names[0]!, boot);
    await handoff.close();
  }
  assert.deepEqual(puts, [["rj-firebat", ["nTESTBENCH", "nrj-spare"]], ["rj-firebat", ["nTESTBENCH", "nrj-spare"]]], "the first snapshot of each probe boot puts the list, and a second of the same boot does not");
  assert.equal(idReads, 6);
});

test("a probe that answers 404 is told once that it cannot learn its peers yet, and any other failure is logged each time", async (t) => {
  const registry = seedRegistry(openRegistry(":memory:"), { nodes: names });
  t.after(() => registry.close());
  let failure = new ProbeHttpError("rj-firebat: PUT /v1/peers: HTTP 404: ", 404);
  const probes = new Map(names.map((name) => [name, { putPeers: async () => { if (name === "rj-firebat") throw failure; } }]));
  const logged: string[] = [];
  const handoff = peerHandoff({ registry, probes, log: (message) => logged.push(message) });

  handoff.observed(names[0]!, "boot-1");
  await handoff.close();
  handoff.observed(names[0]!, "boot-1");
  await handoff.close();
  assert.deepEqual(logged, ["rj-firebat: its probe cannot learn its peers yet, so it keeps the peers in its probe.json until it is upgraded"]);

  logged.length = 0;
  failure = new ProbeHttpError("rj-firebat: PUT /v1/peers: HTTP 500: disk full", 500);
  handoff.observed(names[0]!, "boot-1");
  await handoff.close();
  assert.deepEqual(logged, ["telling rj-firebat its peers failed: rj-firebat: PUT /v1/peers: HTTP 500: disk full"]);
});

test("a put that failed is not remembered, so the next snapshot of the same probe boot puts the list again", async (t) => {
  const registry = seedRegistry(openRegistry(":memory:"), { nodes: names });
  t.after(() => registry.close());
  let attempts = 0;
  const probes = new Map(names.map((name) => [name, { putPeers: async () => { if (name === "rj-firebat" && attempts++ === 0) throw new ProbeHttpError("rj-firebat: PUT /v1/peers: HTTP 500: ", 500); } }]));
  const logged: string[] = [];
  const handoff = peerHandoff({ registry, probes, log: (message) => logged.push(message) });
  for (let i = 0; i < 3; i++) {
    handoff.observed(names[0]!, "boot-1");
    await handoff.close();
  }
  assert.equal(attempts, 2, "the failed put is retried once, and the put that succeeded is not repeated");
  assert.equal(logged.length, 1);
});
