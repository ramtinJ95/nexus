/** Auto placement weighs a node by the memory its host has free, as well as by what its pylons have committed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName, PylonId, ThreadId } from "../ids.ts";
import type { HealthSample } from "./node-metrics.ts";
import type { NodeRecord } from "./node-store.ts";
import type { StoredPylon, Thread } from "./thread-store.ts";
import type { Room } from "./placement-model.ts";
import { testCapacity, testObservation } from "../test-support/kit.ts";
import { NoRoom, Refusal } from "./refusal.ts";
import { freeHeldRoom, placeAuto, placeNear, wakeShort, weighNodes } from "./placement.ts";
import { observeNode, withImage } from "../test-support/api-kit.ts";

const image = "img-0123456789ab";
const need = (memoryGiB = 4) => ({
  image, resources: { cpus: 2, memoryGiB, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
  repo: { kind: "empty", branch: "main" }, dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" },
}) as unknown as Parameters<typeof placeAuto>[1];

interface FakeNode {
  name: string; total: number; committed: number; free?: number | "unread"; readAgoMs?: number; reserved?: number | undefined;
  /** The disk the node has free, 200 GiB unless given. */
  diskFree?: number;
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
    const capacity = testCapacity({ memoryGiB: n.total, committedMemoryGiB: n.committed, diskFreeGiB: n.diskFree ?? 200,
      ...n.pylonVm && { disks: [{ paths: ["/var/lib/nexus/pylons"], totalGiB: 500, freeGiB: n.diskFree ?? 200, pylons: true }] } });
    return { name: n.name as NodeName, tailnetHost: `${n.name}.ts.net`, tailnetNodeId: `n${n.name}`, state: "online", capacity,
      observation: testObservation(n.name as NodeName, { capacity, artifacts: [image], pylons: [...(n.pylons ?? []).filter((p) => p.observed !== false), ...n.orphans ?? []].map((p) => ({ pylonId: `pylon-${p.id}` as PylonId, phase: "booting" })) }) } as NodeRecord;
  };
  const sample = (n: FakeNode): HealthSample | null => n.free === undefined ? null : {
    at: now - (n.readAgoMs ?? 0),
    values: { ...n.free === "unread" ? {} : { memAvailable: n.free }, ...Object.fromEntries((n.pylons ?? []).filter((p) => p.read !== false).map((p) => [`pylonResident:pylon-${p.id}:${p.id}`, p.residentGiB])),
      ...Object.fromEntries((n.orphans ?? []).map((p) => [`pylonResident:pylon-${p.id}:`, p.residentGiB])) },
  };
  const byName = new Map(nodes.map((n) => [n.name, n]));
  // Each pylon's thread is active, so one its node has yet to report is about to boot there.
  const pylonsWithThreadsOn = (name: NodeName) => (byName.get(name)?.pylons ?? []).map((p) => ({
    pylon: { pylonId: `pylon-${p.id}` as PylonId, failed: null, retrying: false, boot: { resources: { cpus: 2, memoryGiB: p.memoryGiB, diskGiB: 10 } } } as unknown as StoredPylon,
    thread: { id: p.id, status: "active", agentTurnRunning: false, working: false, ...p.held
      ? { lastAgentActivityAt: now - 3_600_000, lastHumanActivityAt: now - 3_600_000, ...!released.has(p.id) && { awaitedUntil: now + 600_000 } }
      : { lastAgentActivityAt: now, lastHumanActivityAt: now } } as unknown as Thread,
  }));
  return {
    now: () => now,
    nodes: { nodes: () => nodes.map(record) },
    nodeMetrics: { latestHealthSample: (name: string) => { const n = byName.get(name); return n === undefined ? null : sample(n); } },
    threads: {
      pylonsWithStatusOn: (name: NodeName) => (byName.get(name)?.pylons ?? []).map((p) => ({
        pylon: { pylonId: `pylon-${p.id}` as PylonId, boot: { resources: { cpus: 2, memoryGiB: p.memoryGiB, diskGiB: 10 } } } as StoredPylon, status: "active" as const,
      })),
      pylonsWithThreadsOn,
      pylonsWithHeldThreadsOn: (name: NodeName) => pylonsWithThreadsOn(name).filter(({ thread }) => thread.awaitedUntil !== undefined),
    },
    placement: {
      releaseHold: (thread: ThreadId) => { released.add(thread); },
      reserved: (name: NodeName): Room[] => { const r = byName.get(name)?.reserved; return r === undefined ? [] : [{ cpus: 0, memoryGiB: r, diskGiB: 0 }]; },
    },
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
  assert.throws(() => placeAuto(registry, need()), (err: unknown) => err instanceof Refusal && err.kind === "conflict"
    && err.message === "no node can run this pylon: a has 4.5 GiB of memory free, and the pylon needs 4 GiB with 1 GiB to spare; b has 3 GiB of memory free, and the pylon needs 4 GiB with 1 GiB to spare");
  assert.equal(placeAuto(registry, need(3.5)).node, "a", "1 GiB to spare is enough");
});

test("a start refused for room alone is a NoRoom, which room that frees can end, and one no node could ever take is not", () => {
  const full = fakeRegistry([{ name: "a", total: 32, committed: 30 }, { name: "b", total: 8, committed: 9 }]);
  assert.throws(() => placeAuto(full, need()), (err: unknown) => err instanceof NoRoom);
  assert.throws(() => placeNear(full, need(), "a" as NodeName, true), (err: unknown) => err instanceof NoRoom);
  assert.deepEqual(weighNodes(full, need()).weighed, [
    { node: "a", refused: "has 30 of 32 GiB of memory committed, and the pylon needs 4" }, { node: "b", refused: "is overcommitted, with 9 of 8 GiB of memory committed" },
  ], "what a node refused for stays as the thread's placement records it");
  const kvm = { ...need(), resources: { ...need().resources, nestedVirtualization: true as const } };
  assert.throws(() => placeAuto(fakeRegistry([{ name: "a", total: 32, committed: 0 }]), kvm), (err: unknown) => err instanceof Refusal && !(err instanceof NoRoom)
    && /a cannot give a pylon KVM of its own/.test(err.message));
  assert.throws(() => placeAuto(fakeRegistry([{ name: "a", total: 32, committed: 0 }]), { ...need(), image: "img-elsewhere" }), (err: unknown) => err instanceof Refusal && !(err instanceof NoRoom));
  assert.throws(() => placeAuto(fakeRegistry([{ name: "small", total: 8, committed: 0 }]), need(8)), (err: unknown) => err instanceof Refusal && !(err instanceof NoRoom)
    && err.message === "no node can run this pylon: small has 8 GiB of memory, and the pylon needs 8 GiB with 1 GiB to spare", "a pylon no node could hold even empty never waits for room");
  assert.throws(() => placeAuto(fakeRegistry([{ name: "a", total: 32, committed: 30, pylonVm: true, diskFree: 20 }]), need()), (err: unknown) => err instanceof Refusal && !(err instanceof NoRoom)
    && /a has 20.0 of 500.0 GiB free on the filesystem/.test(err.message), "pausing pylons frees no disk, so a node short of disk and memory is no wait for room");
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

test("a review's start beside its builder goes elsewhere once the builder's host has too little memory free, and waits for room when no node has it", () => {
  const registry = fakeRegistry([{ name: "builder", total: 32, committed: 4, free: 3 }, { name: "other", total: 32, committed: 4, free: 20 }]);
  assert.deepEqual(placeNear(registry, need(), "builder" as NodeName).node, "other");
  assert.throws(() => placeNear(fakeRegistry([{ name: "builder", total: 32, committed: 4, free: 3 }]), need(), "builder" as NodeName), (err: unknown) => err instanceof NoRoom && /^no node has room for this pylon: builder has 3 GiB of memory free/.test(err.message),
    "with no node to take it, it waits for room rather than overcommit the builder's host");
  assert.throws(() => placeNear(fakeRegistry([{ name: "builder", total: 32, committed: 30, free: 20 }]), need(), "builder" as NodeName), (err: unknown) => err instanceof NoRoom && /builder has 30 of 32 GiB of memory committed, and the pylon needs 4/.test(err.message),
    "nor past what the builder's host commits");
  assert.throws(() => placeNear(fakeRegistry([{ name: "builder", total: 32, committed: 4, free: 3 }]), need(), "builder" as NodeName, true), /no node has room for this pylon: builder has 3 GiB of memory free/,
    "a start that asks for room never overcommits the builder's host");
});

test("a wake counts a held builder's memory until its node reports it freed, so it waits while the released builder pauses", () => {
  const now = Date.now();
  const builder = (id: string) => ({ pylon: { pylonId: id, failed: null, boot: { resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } } },
    thread: { status: "active", agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: 0, awaitedUntil: now + 60_000 } });
  const registry = {
    now: () => now,
    placement: { reserved: () => [] },
    threads: { pylonsWithThreadsOn: () => [], pylonsWithHeldThreadsOn: () => [builder("pylon-held-1"), builder("pylon-held-2")] },
  } as unknown as Parameters<typeof wakeShort>[0];
  const waking = { pylonId: "pylon-wake", node: "small", submitted: null, retrying: false, boot: { resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } } } as unknown as Parameters<typeof wakeShort>[1];
  const observed = (committedMemoryGiB: number) => ({ pylons: [], capacity: { memoryGiB: 16, committedMemoryGiB } }) as unknown as Parameters<typeof wakeShort>[2];
  assert.equal(wakeShort(registry, waking, observed(16)), "small has 16 of 16 GiB of memory committed, and the pylon needs 4 GiB", "two held builders still hold their 16 GiB");
  assert.equal(wakeShort(registry, waking, observed(12)), null, "once the node reports one paused, the wake fits");
});

test("a move weighs the other nodes by their free memory too", () => {
  const registry = fakeRegistry([{ name: "from", total: 64, committed: 0, free: 60 }, { name: "full", total: 64, committed: 0, free: 2 }, { name: "to", total: 16, committed: 0, free: 10 }]);
  assert.equal(weighNodes(registry, need(), "from" as NodeName).best, "to");
});

test("a start with --node auto, one that names the node and one on its project's pinned default all fail with the node's memory as the reason", async (t) => {
  const s = await withImage(t);
  observeNode(s, "infra-testbench", { total: 31.2, committed: 8 });
  s.registry.nodeMetrics.recordHealthSample("infra-testbench", { at: Date.now(), values: { memAvailable: 2.2 } });
  const refused = await s.call("POST", "/v1/threads", { project: "acme", title: "Nowhere", node: "auto" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "no node can run this pylon: infra-testbench has 2.2 GiB of memory free, and the pylon needs 4 GiB with 1 GiB to spare; rj-firebat is offline");
  const named = await s.call("POST", "/v1/threads", { project: "acme", title: "Pinned", node: "infra-testbench" });
  assert.deepEqual([named.status, named.body.error], [409, "infra-testbench has 2.2 GiB of memory free, and the pylon needs 4 GiB with 1 GiB to spare"]);
  observeNode(s, "infra-testbench", { total: 31.2, committed: 29 });
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { defaultNode: "infra-testbench" })).status, 200);
  const pinned = await s.call("POST", "/v1/threads", { project: "acme", title: "Default" });
  assert.deepEqual([pinned.status, pinned.body.error], [409, "infra-testbench has 29 of 31.2 GiB of memory committed, and the pylon needs 4"]);
  const huge = await s.call("POST", "/v1/threads", { project: "acme", title: "Huge", node: "infra-testbench", resources: { memoryGiB: 32 } });
  assert.deepEqual([huge.status, huge.body.error], [409, "infra-testbench has 31.2 GiB of memory, and the pylon needs 32 GiB with 1 GiB to spare"], "a pylon the node could never hold is refused, not left to wait");
  assert.equal(s.registry.threads.threads().length, 0, "no refused start made a thread");
});

test("a pylon that boots after the node's health read holds all its memory until a read names it", async (t) => {
  const s = await withImage(t);
  const capacity = (committed: number) => testCapacity({ committedCpus: 4, memoryGiB: 32, committedMemoryGiB: committed, diskFreeGiB: 200, committedDiskGiB: 60,
    disks: [{ paths: ["/var/lib/nexus/pylons"], totalGiB: 500, freeGiB: 200, pylons: true }] });
  observeNode(s, "infra-testbench", { total: 32, committed: 0 }, { capacity: capacity(0) });
  s.registry.nodeMetrics.recordHealthSample("infra-testbench", { at: Date.now(), values: { memAvailable: 6 } });
  const first = await s.call("POST", "/v1/threads", { project: "acme", title: "First", node: "auto" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const refusal = "no node can run this pylon: infra-testbench has 6 GiB of memory free, less 4 GiB %s, and the pylon needs 4 GiB with 1 GiB to spare; rj-firebat is offline";
  const second = () => s.call("POST", "/v1/threads", { project: "acme", title: "Second", node: "auto" });
  assert.equal((await second()).body.error, refusal.replace("%s", "for pylons about to boot there"), "before the node reports it, the first pylon is about to boot");
  observeNode(s, "infra-testbench", { total: 32, committed: 4 }, { capacity: capacity(4), pylons: [{ pylonId: (first.body as Thread).pylonId, phase: "booting" }] });
  assert.equal((await second()).body.error, refusal.replace("%s", "its pylons have yet to touch"), "once it reports it, the read from before its boot still lacks it");
  s.registry.nodeMetrics.recordHealthSample("infra-testbench", { at: Date.now() + 5_000, values: { memAvailable: 9.5, [`pylonResident:${(first.body as Thread).pylonId}:${(first.body as Thread).id}`]: 0.5 } });
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
