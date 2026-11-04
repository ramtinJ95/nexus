/** Auto placement weighs a node by the memory its host has free, as well as by what its pylons have committed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName, PylonId, ThreadId } from "../ids.ts";
import type { HealthSample } from "./node-metrics.ts";
import type { NodeRecord } from "./node-store.ts";
import type { Room, StoredPylon, Thread } from "./thread-store.ts";
import { testCapacity, testObservation } from "../test-kit.ts";
import { HttpError } from "./http-error.ts";
import { freeHeldRoom, placeAuto, placeNear, weighNodes } from "./placement.ts";
import { observeNode, withImage } from "./api-test-kit.ts";

const image = "img-0123456789ab";
const need = (memoryGiB = 4) => ({
  image, resources: { cpus: 2, memoryGiB, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
  repo: { kind: "empty", branch: "main" }, dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" },
}) as unknown as Parameters<typeof placeAuto>[1];

interface FakeNode {
  name: string; total: number; committed: number; free?: number | "unread"; readAgoMs?: number; reserved?: number | undefined;
  /** A pylon-vm probe, which reports its pylons' filesystem and names their processes in a health read. */
  pylonVm?: true | undefined;
  /** VMs the probe reports and commits but the registry has not placed, as the health read names them. */
  orphans?: { id: string; residentGiB: number }[];
  /** `held` is a builder idle past the idle policy whose review holds it up for its findings. */
  pylons?: { id: string; memoryGiB: number; residentGiB: number; observed?: false; read?: false; held?: true }[];
}

function fakeRegistry(nodes: FakeNode[]) {
  const now = Date.now();
  const released = new Set<string>();
  const record = (n: FakeNode): NodeRecord => {
    const capacity = testCapacity({ memoryGiB: n.total, committedMemoryGiB: n.committed, diskFreeGiB: 200,
      ...n.pylonVm && { disks: [{ paths: ["/var/lib/nexus/pylons"], totalGiB: 500, freeGiB: 200, pylons: true }] } });
    return { name: n.name as NodeName, tailnetHost: `${n.name}.ts.net`, tailnetNodeId: `n${n.name}`, state: "online", capacity,
      observation: testObservation(n.name as NodeName, { capacity, artifacts: [image], pylons: [...(n.pylons ?? []).filter((p) => p.observed !== false), ...n.orphans ?? []].map((p) => ({ pylonId: `pylon-${p.id}` as PylonId, phase: "booting" })) }) } as NodeRecord;
  };
  const sample = (n: FakeNode): HealthSample | null => n.free === undefined ? null : {
    at: now - (n.readAgoMs ?? 0),
    values: { ...n.free === "unread" ? {} : { memAvailable: n.free }, ...Object.fromEntries((n.pylons ?? []).filter((p) => p.read !== false).map((p) => [`pylonResident:pylon-${p.id}:${p.id}`, p.residentGiB])),
      ...Object.fromEntries((n.orphans ?? []).map((p) => [`pylonResident:pylon-${p.id}:`, p.residentGiB])) },
  };
  const byName = new Map(nodes.map((n) => [n.name, n]));
  return {
    nodes: () => nodes.map(record),
    latestHealthSample: (name: string) => { const n = byName.get(name); return n === undefined ? null : sample(n); },
    pylonsWithStatusOn: (name: NodeName) => (byName.get(name)?.pylons ?? []).map((p) => ({
      pylon: { pylonId: `pylon-${p.id}` as PylonId, boot: { resources: { cpus: 2, memoryGiB: p.memoryGiB, diskGiB: 10 } } } as StoredPylon, status: "active" as const,
    })),
    // Each pylon's thread is active, so one its node has yet to report is about to boot there.
    pylonsWithThreadsOn: (name: NodeName) => (byName.get(name)?.pylons ?? []).map((p) => ({
      pylon: { pylonId: `pylon-${p.id}` as PylonId, failed: null, retrying: false, boot: { resources: { cpus: 2, memoryGiB: p.memoryGiB, diskGiB: 10 } } } as unknown as StoredPylon,
      thread: { id: p.id, status: "active", agentTurnRunning: false, working: false, ...p.held
        ? { lastAgentActivityAt: now - 3_600_000, lastHumanActivityAt: now - 3_600_000, ...!released.has(p.id) && { awaitedUntil: now + 600_000 } }
        : { lastAgentActivityAt: now, lastHumanActivityAt: now } } as unknown as Thread,
    })),
    releaseHold: (thread: ThreadId) => { released.add(thread); },
    reserved: (name: NodeName): Room[] => { const r = byName.get(name)?.reserved; return r === undefined ? [] : [{ cpus: 0, memoryGiB: r, diskGiB: 0 }]; },
  };
}

test("auto passes over a node whose host has too little memory free, however little its pylons commit, and says so", () => {
  const registry = fakeRegistry([
    { name: "infra-testbench", total: 31.2, committed: 8, free: 2.2 },
    { name: "rj-firebat", total: 22.8, committed: 12, free: 9 },
  ]);
  const placement = placeAuto(registry, need());
  assert.equal(placement.node, "rj-firebat");
  assert.deepEqual(placement.how === "auto" && placement.weighed, [
    { node: "infra-testbench", refused: "has 2.2 GiB of memory free, and the pylon needs 4 GiB with 1 GiB to spare" },
    { node: "rj-firebat", left: { cpus: 14, memoryGiB: 5, diskGiB: 190 } },
  ], "rj-firebat's room is the 5 GiB its host has free after the pylon, under the 6.8 its commitments leave");
});

test("a start no node has free memory for fails with each node's reason", () => {
  const registry = fakeRegistry([{ name: "a", total: 32, committed: 0, free: 4.5 }, { name: "b", total: 32, committed: 0, free: 3 }]);
  assert.throws(() => placeAuto(registry, need()), (err: unknown) => err instanceof HttpError && err.status === 409
    && err.message === "no node can run this pylon: a has 4.5 GiB of memory free, and the pylon needs 4 GiB with 1 GiB to spare; b has 3 GiB of memory free, and the pylon needs 4 GiB with 1 GiB to spare");
  assert.equal(placeAuto(registry, need(3.5)).node, "a", "1 GiB to spare is enough");
});

test("auto ranks nodes by the smaller of the memory their commitments and their host leave", () => {
  const registry = fakeRegistry([
    { name: "roomy-on-paper", total: 64, committed: 0, free: 10 },
    { name: "tight-on-paper", total: 32, committed: 16, free: 20 },
  ]);
  const { best, weighed } = weighNodes(registry, need());
  assert.equal(best, "tight-on-paper");
  assert.deepEqual(weighed.map((w) => "left" in w && w.left.memoryGiB), [6, 12]);
});

test("free memory counts what the node's pylons have yet to touch and what pylons about to boot there will take", () => {
  const nodes = (reserved?: number): FakeNode[] => [
    { name: "a", total: 64, committed: 8, free: 14, reserved, pylons: [{ id: "th-aaaaaaaaaaaa", memoryGiB: 8, residentGiB: 2 }, { id: "th-bbbbbbbbbbbb", memoryGiB: 4, residentGiB: 4.3 }] },
  ];
  assert.deepEqual(weighNodes(fakeRegistry(nodes()), need()).weighed, [{ node: "a", left: { cpus: 14, memoryGiB: 4, diskGiB: 190 } }],
    "the 8 GiB guest will take 6 GiB more, and the 4 GiB one whose controller holds more than its size takes no more");
  assert.deepEqual(weighNodes(fakeRegistry(nodes(4)), need()).weighed, [{
    node: "a", refused: "has 14 GiB of memory free, less 6 GiB its pylons have yet to touch and 4 GiB for pylons about to boot there, and the pylon needs 4 GiB with 1 GiB to spare",
  }]);
});

test("a pylon the health read names before the observation does counts once, by all it asked for", () => {
  const registry = fakeRegistry([{ name: "a", total: 64, committed: 0, free: 14, pylons: [{ id: "th-aaaaaaaaaaaa", memoryGiB: 8, residentGiB: 2, observed: false }] }]);
  assert.deepEqual(weighNodes(registry, need()).weighed, [{ node: "a", left: { cpus: 12, memoryGiB: 2, diskGiB: 180 } }]);
});

test("a pylon the node reports that booted after its health read holds all its memory, on a node whose probe names its pylons", () => {
  const node = (over: Partial<FakeNode>, read?: false): FakeNode =>
    ({ name: "a", total: 32, committed: 8, free: 14, readAgoMs: 30_000, pylons: [{ id: "th-aaaaaaaaaaaa", memoryGiB: 8, residentGiB: 0.3, ...read === false && { read } }], ...over });
  assert.deepEqual(weighNodes(fakeRegistry([node({ pylonVm: true }, false)]), need(8)).weighed, [{
    node: "a", refused: "has 14 GiB of memory free, less 8 GiB its pylons have yet to touch, and the pylon needs 8 GiB with 1 GiB to spare",
  }]);
  assert.deepEqual(weighNodes(fakeRegistry([node({ pylonVm: true })]), need(8)).weighed, [{
    node: "a", refused: "has 14 GiB of memory free, less 7.7 GiB its pylons have yet to touch, and the pylon needs 8 GiB with 1 GiB to spare",
  }], "a read after its boot counts what it has yet to touch");
  assert.deepEqual(weighNodes(fakeRegistry([node({}, false)]), need(8)).weighed, [{ node: "a", left: { cpus: 14, memoryGiB: 6, diskGiB: 190 } }],
    "a probe that cannot name its pylons, as Docker's, leaves no read to tell, so the pylon counts as all touched");
});

test("orphaned VMs on a node whose probe names its pylons are yet to take what the probe commits for them", () => {
  const orphan = (residentGiB: number | null): FakeNode => ({ name: "a", total: 32, committed: 8, free: 10, pylonVm: true, orphans: residentGiB === null ? [] : [{ id: "th-orphanorphan", residentGiB }] });
  assert.deepEqual(weighNodes(fakeRegistry([orphan(1)]), need()).weighed, [{
    node: "a", refused: "has 10 GiB of memory free, less 7 GiB its pylons have yet to touch, and the pylon needs 4 GiB with 1 GiB to spare",
  }], "an 8 GiB orphan holding 1 GiB will take 7 more");
  assert.deepEqual(weighNodes(fakeRegistry([orphan(null)]), need()).weighed, [{
    node: "a", refused: "has 10 GiB of memory free, less 8 GiB its pylons have yet to touch, and the pylon needs 4 GiB with 1 GiB to spare",
  }], "one the read did not name booted since it");
  assert.deepEqual(weighNodes(fakeRegistry([{ ...orphan(1), pylonVm: undefined }]), need()).weighed, [{ node: "a", left: { cpus: 14, memoryGiB: 6, diskGiB: 190 } }],
    "a probe that cannot name its pylons leaves no read to tell");
});

test("a node with no fresh reading of its free memory is weighed by its commitments alone", () => {
  const unread: FakeNode[] = [
    { name: "never-read", total: 32, committed: 20 },
    { name: "no-meminfo", total: 32, committed: 20, free: "unread" },
    { name: "stale", total: 32, committed: 20, free: 0.5, readAgoMs: 10 * 60_000 },
  ];
  assert.deepEqual(weighNodes(fakeRegistry(unread), need()).weighed.map((w) => "left" in w && w.left.memoryGiB), [8, 8, 8]);
});

test("a review's start beside its builder goes elsewhere once the builder's host has too little memory free", () => {
  const registry = fakeRegistry([{ name: "builder", total: 32, committed: 4, free: 3 }, { name: "other", total: 32, committed: 4, free: 20 }]);
  assert.deepEqual(placeNear(registry, need(), "builder" as NodeName).node, "other");
  assert.deepEqual(placeNear(fakeRegistry([{ name: "builder", total: 32, committed: 4, free: 3 }]), need(), "builder" as NodeName), { how: "named", node: "builder" },
    "with no node to take it, it goes beside the builder all the same");
  assert.throws(() => placeNear(fakeRegistry([{ name: "builder", total: 32, committed: 4, free: 3 }]), need(), "builder" as NodeName, true), /no node has room for this pylon: builder has 3 GiB of memory free/,
    "a start that asks for room never overcommits the builder's host");
});

test("a move weighs the other nodes by their free memory too", () => {
  const registry = fakeRegistry([{ name: "from", total: 64, committed: 0, free: 60 }, { name: "full", total: 64, committed: 0, free: 2 }, { name: "to", total: 16, committed: 0, free: 10 }]);
  assert.equal(weighNodes(registry, need(), "from" as NodeName).best, "to");
});

test("a start with --node auto fails with the free memory as the reason, and one that names the node starts there all the same", async (t) => {
  const s = await withImage(t);
  observeNode(s, "infra-testbench", { total: 31.2, committed: 8 });
  s.registry.recordHealthSample("infra-testbench", { at: Date.now(), values: { memAvailable: 2.2 } });
  const refused = await s.call("POST", "/v1/threads", { project: "acme", title: "Nowhere", node: "auto" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "no node can run this pylon: infra-testbench has 2.2 GiB of memory free, and the pylon needs 4 GiB with 1 GiB to spare; rj-firebat is offline");
  const named = await s.call("POST", "/v1/threads", { project: "acme", title: "Pinned", node: "infra-testbench" });
  assert.equal(named.status, 201, JSON.stringify(named.body));
  assert.deepEqual(named.body.placement, { how: "named", node: "infra-testbench" });
});

test("a pylon that boots after the node's health read holds all its memory until a read names it", async (t) => {
  const s = await withImage(t);
  const capacity = (committed: number) => testCapacity({ committedCpus: 4, memoryGiB: 32, committedMemoryGiB: committed, diskFreeGiB: 200, committedDiskGiB: 60,
    disks: [{ paths: ["/var/lib/nexus/pylons"], totalGiB: 500, freeGiB: 200, pylons: true }] });
  observeNode(s, "infra-testbench", { total: 32, committed: 0 }, { capacity: capacity(0) });
  s.registry.recordHealthSample("infra-testbench", { at: Date.now(), values: { memAvailable: 6 } });
  const first = await s.call("POST", "/v1/threads", { project: "acme", title: "First", node: "auto" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const refusal = "no node can run this pylon: infra-testbench has 6 GiB of memory free, less 4 GiB %s, and the pylon needs 4 GiB with 1 GiB to spare; rj-firebat is offline";
  const second = () => s.call("POST", "/v1/threads", { project: "acme", title: "Second", node: "auto" });
  assert.equal((await second()).body.error, refusal.replace("%s", "for pylons about to boot there"), "before the node reports it, the first pylon is about to boot");
  observeNode(s, "infra-testbench", { total: 32, committed: 4 }, { capacity: capacity(4), pylons: [{ pylonId: (first.body as Thread).pylonId, phase: "booting" }] });
  assert.equal((await second()).body.error, refusal.replace("%s", "its pylons have yet to touch"), "once it reports it, the read from before its boot still lacks it");
  s.registry.recordHealthSample("infra-testbench", { at: Date.now() + 5_000, values: { memAvailable: 9.5, [`pylonResident:${(first.body as Thread).pylonId}:${(first.body as Thread).id}`]: 0.5 } });
  const named = await second();
  assert.equal(named.status, 201, `a read that names it counts only the 3.5 GiB it has yet to touch: ${JSON.stringify(named.body)}`);
});

test("a start takes the room of a builder its review only holds up, and the node's next pass releases that hold", () => {
  const registry = fakeRegistry([{ name: "rj-firebat", total: 22.8, committed: 20, pylons: [
    { id: "busy", memoryGiB: 16, residentGiB: 16 }, { id: "held", memoryGiB: 4, residentGiB: 4, held: true },
  ] }]);
  assert.equal(placeAuto(registry, need()).node, "rj-firebat", "the held builder's 4 GiB count as room, so a new pylon fits beside it");
  assert.deepEqual(freeHeldRoom(registry, "rj-firebat" as NodeName), [], "nothing is released while nothing took the room");
  const started = fakeRegistry([{ name: "rj-firebat", total: 22.8, committed: 20, reserved: 4, pylons: [
    { id: "busy", memoryGiB: 16, residentGiB: 16 }, { id: "held", memoryGiB: 4, residentGiB: 4, held: true },
  ] }]);
  assert.deepEqual(freeHeldRoom(started, "rj-firebat" as NodeName), ["held"], "the start took its room, so its hold goes and it pauses");
  assert.deepEqual(freeHeldRoom(started, "rj-firebat" as NodeName), [], "a released hold is released once");
  const two = fakeRegistry([{ name: "rj-firebat", total: 22.8, committed: 20, reserved: 4, pylons: [
    { id: "busy", memoryGiB: 12, residentGiB: 12 }, { id: "held-1", memoryGiB: 4, residentGiB: 4, held: true }, { id: "held-2", memoryGiB: 4, residentGiB: 4, held: true },
  ] }]);
  assert.equal(freeHeldRoom(two, "rj-firebat" as NodeName).length, 1);
  assert.deepEqual(freeHeldRoom(two, "rj-firebat" as NodeName), [], "a pass while the released builder still pauses releases no other");
});

test("a node whose free memory falls under the headroom releases its held builders, soonest first, until it has the room", () => {
  const registry = fakeRegistry([{ name: "a", total: 31.2, committed: 12, free: 0.5, pylons: [
    { id: "busy", memoryGiB: 4, residentGiB: 4 }, { id: "held-1", memoryGiB: 4, residentGiB: 4, held: true }, { id: "held-2", memoryGiB: 4, residentGiB: 4, held: true },
  ] }]);
  assert.equal(freeHeldRoom(registry, "a" as NodeName).length, 1, "one held builder's 4 GiB bring back the 1 GiB of headroom");
  assert.deepEqual(freeHeldRoom(fakeRegistry([{ name: "b", total: 31.2, committed: 8, free: 20, pylons: [{ id: "held", memoryGiB: 4, residentGiB: 4, held: true }] }]), "b" as NodeName), [],
    "a node with room keeps its held builders up");
});
