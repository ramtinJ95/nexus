import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openRegistry, type Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import { addThread as addTestThread, observeNode, seedRegistry, testRegistry } from "./test-kit.ts";
import { usageBackfill } from "./usage-backfill.ts";
import { archivedDiskMs, desiredPhase, envelope } from "../reconcile.ts";
import type { ImageId, JobId, NodeName, PylonId, ThreadId } from "../ids.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import { runningPylon, stoppedPylon, tempDir, testCapacity } from "../test-kit.ts";

const image: ImageId = "img-000000000000";
const n1 = "rj-firebat" as NodeName;
const n2 = "infra-testbench" as NodeName;
const dir = await tempDir("nexus-backfill-");

function opened(t: TestContext, path = join(dir, `${randomUUID()}.db`)): Registry {
  return seedRegistry(testRegistry(t, path), { nodes: [n1, n2] });
}

let created = 0;
function addThread(registry: Registry, node: NodeName, title: string, status: Thread["status"] = "archived"): Thread {
  const { id } = addTestThread(registry, { node, boot: { image }, thread: { title, createdAt: 1_000 + created++, lastHumanActivityAt: 0 } });
  if (status !== "active") registry.setThreadStatus(id, status);
  return registry.thread(id)!;
}

function observe(registry: Registry, node: NodeName, pylons: readonly [PylonId, "stopped" | "running"][], over: Partial<NodeObservation> = {}, memory = { total: 64, committed: 0 }) {
  const capacity = testCapacity({ memoryGiB: memory.total, committedMemoryGiB: memory.committed });
  const observed = pylons.map(([pylonId, phase]) => phase === "stopped" ? stoppedPylon(pylonId, { checkpoint: `ckpt-${pylonId}-1` }) : runningPylon(pylonId));
  observeNode(registry, { node, probeBootId: "boot-1", capacity, artifacts: [image], pylons: observed, spawnsWithoutRelaunch: true, ...over });
}

/** Records `calls` calls no read had counted, `tokens` in all, as a backfill's read of the thread does. */
const recover = (registry: Registry, thread: ThreadId, calls: number, tokens: number) => registry.recordUsage(thread, Array.from({ length: calls }, (_, i) => ({
  id: `claude:msg_${thread}_${i}`, agent: "claude" as const, model: "claude-opus-5-5", at: 1_000, input: i === 0 ? tokens - calls + 1 : 1, output: 0, cacheWrite: 0, cacheRead: 0,
})), [], true);

function fakeCounter(registry: Registry) {
  const counter = {
    reads: [] as ThreadId[],
    answer: async (id: ThreadId) => recover(registry, id, 3, 300),
    readWhole(id: ThreadId) {
      counter.reads.push(id);
      return counter.answer(id);
    },
  };
  return counter;
}

function backfill(t: TestContext, registry: Registry, counter = fakeCounter(registry), over: { bootMs?: number; pauseMs?: number } = {}) {
  const woken: NodeName[] = [];
  const job = usageBackfill({ registry, counter, wake: (node) => woken.push(node), intervalMs: 5, log: () => {}, ...over });
  t.after(() => job.close());
  return { job, woken, counter };
}

async function until<T>(what: string, read: () => T, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}, but it is ${JSON.stringify(value)}`);
    await delay(5);
  }
}

const current = (registry: Registry) => {
  const run = registry.usageBackfill();
  return run.state === "never" ? null : run.current;
};
const held = (registry: Registry, thread: Thread, phase: "reading" | "pausing") =>
  until(`${thread.title} is held ${phase}`, () => current(registry), (c) => c?.thread === thread.id && c.phase === phase);
const row = (registry: Registry, thread: Thread) => registry.usageBackfillThreads().find((r) => r.thread === thread.id);
const desired = (registry: Registry, thread: Thread) => desiredPhase(registry.thread(thread.id)!, Date.now());
const nothing = { calls: 0, tokens: 0 };

test("a start lists each thread once and leaves a running run as it is, and a later start pends again only the skipped threads it lists", (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  let registry = seedRegistry(openRegistry(path), { nodes: [n1, n2] });
  const [a, b, c] = ["a", "b", "c"].map((title) => addThread(registry, n1, title));
  assert.deepEqual(registry.usageBackfill(), { state: "never" });

  assert.deepEqual(registry.startUsageBackfill([a!.id, b!.id], 100), {
    state: "running", startedAt: 100, finishedAt: null, current: null, waiting: null, read: 0, of: 2, recovered: nothing, skipped: [],
  });
  assert.deepEqual(registry.startUsageBackfill([a!.id, b!.id, c!.id], 200), registry.usageBackfill(), "a second start while one runs changes nothing");
  assert.deepEqual(registry.usageBackfillThreads().map((r) => r.title), ["a", "b"]);
  recover(registry, a!.id, 5, 500);
  registry.finishUsageBackfillThread(a!.id, "done", null, 300);
  registry.finishUsageBackfillThread(b!.id, "skipped", "its node holds no disk for its pylon", 310);
  registry.finishUsageBackfill(400);
  const skippedB = { thread: b!.id, title: "b", state: "skipped", reason: "its node holds no disk for its pylon", calls: 0, tokens: 0, at: 310 };
  assert.deepEqual(registry.usageBackfill(), {
    state: "done", startedAt: 100, finishedAt: 400, current: null, waiting: null, read: 2, of: 2, recovered: { calls: 5, tokens: 500 }, skipped: [skippedB],
  });

  registry.close();
  registry = opened(t, path);
  assert.equal(registry.usageBackfill().state, "done", "the run outlives a restart");
  assert.deepEqual(registry.startUsageBackfill([b!.id, c!.id], 500), {
    state: "running", startedAt: 500, finishedAt: null, current: null, waiting: null, read: 1, of: 3, recovered: { calls: 5, tokens: 500 }, skipped: [],
  });
  assert.deepEqual(registry.usageBackfillThreads().map((r) => [r.title, r.state]), [["a", "done"], ["b", "pending"], ["c", "pending"]]);

  registry.holdUsageBackfill(c!.id, 600);
  assert.deepEqual([desired(registry, a!), desired(registry, c!)], ["paused", "reading"]);
  assert.equal(registry.thread(c!.id)!.readingUsage, true);
  registry.finishUsageBackfillThread(c!.id, "done", null, 700);
  assert.deepEqual(current(registry), { thread: c!.id, phase: "pausing", since: 700 });
  assert.equal(desired(registry, c!), "paused", "a read pylon's desired phase is paused again, while the run waits for its pause");
  assert.equal(registry.stopUsageBackfill(800).state, "stopped");
  assert.equal(current(registry), null);
});

test("a run wakes one archived thread's pylon at a time, across nodes, reads it once it runs, and wakes the next once it paused", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "first");
  const b = addThread(registry, n2, "second");
  addThread(registry, n1, "active", "idle");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  observe(registry, n2, [[b.pylonId, "stopped"]]);
  const { job, woken, counter } = backfill(t, registry);
  assert.deepEqual(job.start(), { state: "running", startedAt: (registry.usageBackfill() as { startedAt: number }).startedAt, finishedAt: null, current: null, waiting: null, read: 0, of: 2, recovered: nothing, skipped: [] }, "only archived threads are read");

  await held(registry, a, "reading");
  assert.deepEqual([desired(registry, a), desired(registry, b)], ["reading", "paused"]);
  assert.deepEqual(woken, [n1]);
  observe(registry, n1, [[a.pylonId, "running"]]);
  await held(registry, a, "pausing");
  assert.deepEqual(row(registry, a)!.state, "done");
  assert.deepEqual([desired(registry, a), desired(registry, b)], ["paused", "paused"]);
  await delay(50);
  assert.deepEqual(current(registry)?.thread, a.id, "the next pylon waits for this one's pause, though it is on another node");

  observe(registry, n1, [[a.pylonId, "stopped"]]);
  await held(registry, b, "reading");
  observe(registry, n2, [[b.pylonId, "running"]]);
  await held(registry, b, "pausing");
  observe(registry, n2, [[b.pylonId, "stopped"]]);
  const run = await until("the run is done", () => registry.usageBackfill(), (r) => r.state === "done");
  assert.ok(run.state === "done");
  assert.deepEqual([run.read, run.of, run.recovered, run.skipped, run.current], [2, 2, { calls: 6, tokens: 600 }, [], null]);
  assert.deepEqual(counter.reads, [a.id, b.id]);
});

test("a run waits while the pylon's node is offline, runs an older probe, is busy with a job, or would be left too little memory, and says why", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "archived");
  const other = addThread(registry, n1, "other", "idle");
  const { job } = backfill(t, registry);
  const waiting = (why: string) => until(`the run waits because ${why}`, () => registry.usageBackfill(), (r) => r.state === "running" && r.waiting === why);
  job.start();

  await waiting("rj-firebat is offline");
  observe(registry, n1, [[a.pylonId, "stopped"]], { spawnsWithoutRelaunch: undefined as never });
  await waiting("rj-firebat runs a probe too old to wake a pylon without its sessions");
  observe(registry, n1, [[a.pylonId, "stopped"]], { jobs: [{ jobId: "j1" as JobId, subject: other.pylonId, kind: "spawn", state: "running", startedAt: "2027-01-01T00:00:00Z" }] });
  await waiting("rj-firebat is busy with a job");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  registry.savePylon({ ...registry.pylon(other.pylonId)!, submitted: envelope({ kind: "pause", pylonId: other.pylonId, checkpoint: "ckpt-other-1" }, n1, Date.now()) });
  await waiting("rj-firebat is busy with a job");
  registry.savePylon({ ...registry.pylon(other.pylonId)!, submitted: null });
  observe(registry, n1, [[a.pylonId, "stopped"]], {}, { total: 10, committed: 4 });
  await waiting("rj-firebat would have 2 GiB of memory left with it up, less than the 4 GiB of the largest project's pylon");
  assert.equal(desired(registry, a), "paused");

  observe(registry, n1, [[a.pylonId, "stopped"]], {}, { total: 12, committed: 4 });
  await held(registry, a, "reading");
  assert.equal((registry.usageBackfill() as { waiting: string | null }).waiting, null);
});

test("a wake that fails, or does not boot in time, is skipped with why, its attempt cleared so its pylon pauses rather than fails", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "failed");
  const b = addThread(registry, n1, "slow");
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "stopped"]]);
  const before = { at: Date.now(), code: "backend" as const, message: "a failure from before the thread was archived" };
  registry.savePylon({ ...registry.pylon(a.pylonId)!, attempts: { count: 2, last: before } });
  const { job } = backfill(t, registry, fakeCounter(registry), { bootMs: 200 });
  job.start();

  await held(registry, a, "reading");
  assert.deepEqual(registry.pylon(a.pylonId)!.attempts, { count: 0, last: null }, "the hold forgets a failure that was not its wake's");
  registry.savePylon({ ...registry.pylon(a.pylonId)!, attempts: { count: 1, last: { at: Date.now(), code: "setup-failed", message: "the disk is full" } } });
  await held(registry, a, "pausing");
  assert.deepEqual([row(registry, a)!.state, row(registry, a)!.reason], ["skipped", "the pylon did not boot: setup-failed: the disk is full"]);
  assert.deepEqual(registry.pylon(a.pylonId)!.attempts, { count: 0, last: null });
  assert.equal(registry.pylon(a.pylonId)!.failed, null);
  assert.equal(desired(registry, a), "paused");

  await held(registry, b, "reading");
  await held(registry, b, "pausing");
  assert.equal(row(registry, b)!.state, "skipped");
  assert.match(row(registry, b)!.reason!, /^its pylon did not boot within [\d.]+ minutes$/);
  const run = await until("the run is done", () => registry.usageBackfill(), (r) => r.state === "done");
  assert.ok(run.state === "done" && run.read === 2 && run.skipped.length === 2);
});

test("a failed wake for reading is skipped with why, as the tick keeps it apart and as a record from before kept it in last", async (t) => {
  const registry = opened(t);
  const apart = addThread(registry, n1, "apart");
  const before = addThread(registry, n1, "before");
  observe(registry, n1, [[apart.pylonId, "stopped"], [before.pylonId, "stopped"]]);
  const failure = { at: Date.now(), code: "setup-failed" as const, message: "the disk is full" };
  backfill(t, registry).job.start();

  await held(registry, apart, "reading");
  registry.savePylon({ ...registry.pylon(apart.pylonId)!, attempts: { count: 0, last: null, readFailure: failure } });
  await held(registry, apart, "pausing");
  assert.deepEqual([row(registry, apart)!.state, row(registry, apart)!.reason], ["skipped", "the pylon did not boot: setup-failed: the disk is full"]);
  assert.deepEqual(registry.pylon(apart.pylonId)!.attempts, { count: 0, last: null });

  await held(registry, before, "reading");
  registry.savePylon({ ...registry.pylon(before.pylonId)!, attempts: { count: 1, last: { ...failure, reading: true } as typeof failure } });
  await held(registry, before, "pausing");
  assert.deepEqual([row(registry, before)!.state, row(registry, before)!.reason], ["skipped", "the pylon did not boot: setup-failed: the disk is full"]);
  assert.deepEqual(registry.pylon(before.pylonId)!.attempts, { count: 0, last: null });
});

test("a failed wake for reading from an earlier run is cleared before the next run wakes the pylon", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "earlier");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  registry.savePylon({ ...registry.pylon(a.pylonId)!, attempts: { count: 0, last: null, readFailure: { at: Date.now(), code: "backend", message: "an earlier run's wake" } } });
  backfill(t, registry).job.start();
  await held(registry, a, "reading");
  assert.deepEqual(registry.pylon(a.pylonId)!.attempts, { count: 0, last: null }, "the hold forgets a failure that was not its wake's");
});

test("a thread whose pylon's image no online node holds is skipped, and woken once another node holds it", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "no image");
  observe(registry, n1, [[a.pylonId, "stopped"]], { artifacts: [] });
  const { job } = backfill(t, registry);
  job.start();
  await until("the run is done", () => registry.usageBackfill().state, (s) => s === "done");
  assert.deepEqual([row(registry, a)!.state, row(registry, a)!.reason], ["skipped", `no online node holds its image ${image}`]);
  assert.equal(desired(registry, a), "paused");

  observe(registry, n2, []);
  job.start();
  await held(registry, a, "reading");
});

test("a thread archived for a day is skipped, as its disk is deleted, though the node still holds it", async (t) => {
  let now = Date.now() - archivedDiskMs;
  const registry = seedRegistry(testRegistry(t, join(dir, `${randomUUID()}.db`), () => now), { nodes: [n1, n2] });
  const expired = addThread(registry, n1, "expired");
  now = Date.now();
  const kept = addThread(registry, n1, "kept");
  observe(registry, n1, [[expired.pylonId, "stopped"], [kept.pylonId, "stopped"]]);
  const { job, counter } = backfill(t, registry);
  job.start();
  await held(registry, kept, "reading");
  observe(registry, n1, [[expired.pylonId, "stopped"], [kept.pylonId, "running"]]);
  await until("kept is read", () => counter.reads, (r) => r.includes(kept.id));
  observe(registry, n1, [[expired.pylonId, "stopped"], [kept.pylonId, "stopped"]]);
  await until("the run is done", () => registry.usageBackfill().state, (s) => s === "done");
  assert.deepEqual([row(registry, expired)!.state, row(registry, expired)!.reason], ["skipped", "its disk was deleted 24 hours after it was archived"]);
  assert.deepEqual(counter.reads, [kept.id]);
  assert.equal(desired(registry, expired), "deleted");
});

test("a read that fails skips the thread with its error, and one a stop cut short leaves it for the next run", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "broken transcript");
  const b = addThread(registry, n1, "stopped mid-read");
  observe(registry, n1, [[a.pylonId, "running"], [b.pylonId, "running"]]);
  const counter = fakeCounter(registry);
  const reading = Promise.withResolvers<{ calls: number; tokens: number }>();
  counter.answer = async (id) => id === a.id ? Promise.reject(new Error("the pipe to the pylon was lost")) : reading.promise;
  const { job, woken } = backfill(t, registry, counter);
  job.start();

  await held(registry, a, "pausing");
  assert.deepEqual([row(registry, a)!.state, row(registry, a)!.reason], ["skipped", "reading it failed: the pipe to the pylon was lost"]);
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "running"]]);
  await until("b is read", () => counter.reads, (reads) => reads.includes(b.id));
  woken.length = 0;
  assert.equal(job.stop().state, "stopped");
  assert.deepEqual(woken, [n1], "the stop wakes the node, so the pylon it let go of pauses");
  assert.equal(desired(registry, b), "paused");
  reading.reject(new Error("the pylon paused"));
  await delay(50);
  assert.equal(row(registry, b)!.state, "pending");
  assert.deepEqual(job.plan().map((p) => [p.title, p.reason]), [["broken transcript", "reading it failed: the pipe to the pylon was lost"], ["stopped mid-read", null]]);
});

test("a thread unarchived or deleted while its pylon is read is skipped and let go at once, and the run goes on", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "unarchived");
  const b = addThread(registry, n1, "deleted");
  const c = addThread(registry, n1, "last");
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "stopped"], [c.pylonId, "stopped"]]);
  const { job } = backfill(t, registry);
  job.start();

  await held(registry, a, "reading");
  registry.setThreadStatus(a.id, "idle");
  await held(registry, b, "reading");
  assert.equal(row(registry, a)!.reason, "it was unarchived while it was read, so live counting reads it");
  registry.setThreadStatus(b.id, "deleted");
  await held(registry, c, "reading");
  assert.equal(row(registry, b)!.reason, "it was deleted while it was read");
});

test("a control plane restarted mid-run goes on with the pylon it held, and a second run reads none of the threads the first read", async (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const first = seedRegistry(openRegistry(path), { nodes: [n1, n2] });
  const a = addThread(first, n1, "first");
  const b = addThread(first, n1, "second");
  observe(first, n1, [[a.pylonId, "stopped"], [b.pylonId, "stopped"]]);
  const before = usageBackfill({ registry: first, counter: fakeCounter(first), wake: () => {}, intervalMs: 5, log: () => {} });
  before.start();
  await held(first, a, "reading");
  await before.close();
  first.close();

  const registry = opened(t, path);
  const { job, counter } = backfill(t, registry);
  assert.deepEqual(current(registry)?.thread, a.id);
  observe(registry, n1, [[a.pylonId, "running"], [b.pylonId, "stopped"]]);
  await held(registry, a, "pausing");
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "running"]]);
  await held(registry, b, "pausing");
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "stopped"]]);
  await until("the run is done", () => registry.usageBackfill().state, (s) => s === "done");
  assert.deepEqual(counter.reads, [a.id, b.id]);

  assert.deepEqual(job.plan(), []);
  assert.equal(job.start().state, "running");
  const again = await until("the second run is done", () => registry.usageBackfill(), (r) => r.state === "done");
  assert.ok(again.state === "done" && again.read === 2 && again.of === 2);
  assert.deepEqual(counter.reads, [a.id, b.id], "the second run read nothing");
});

test("the dry run lists each archived thread a start would read, with its node and why a run skipped it, and no done, active or deleted one", async (t) => {
  const registry = opened(t);
  const skipped = addThread(registry, n2, "skipped before");
  const done = addThread(registry, n1, "read before");
  const fresh = addThread(registry, n1, "never read");
  addThread(registry, n1, "active", "idle");
  addThread(registry, n1, "deleted", "deleted");
  registry.startUsageBackfill([skipped.id, done.id], 1);
  registry.finishUsageBackfillThread(skipped.id, "skipped", "infra-testbench holds no disk for its pylon", 2);
  registry.finishUsageBackfillThread(done.id, "done", null, 3);
  registry.stopUsageBackfill(4);
  const { job } = backfill(t, registry);
  assert.deepEqual(job.plan(), [
    { thread: skipped.id, project: "acme", node: n2, title: "skipped before", reason: "infra-testbench holds no disk for its pylon" },
    { thread: fresh.id, project: "acme", node: n1, title: "never read", reason: null },
  ]);
});
