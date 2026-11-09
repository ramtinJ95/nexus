import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openRegistry, type Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import { addThread as addTestThread, observeNode, seedRegistry, testRegistry } from "../test-support/registry-kit.ts";
import { usageBackfill } from "./usage-backfill.ts";
import { archivedDiskMs, desiredPhase, diskKept, envelope } from "./reconcile.ts";
import type { ImageId, JobId, LiveHash, NodeName, PylonId, ThreadId } from "../ids.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import { runningPylon, stoppedPylon, tempDir, testCapacity } from "../test-support/kit.ts";
import { polled } from "../test-support/service-kit.ts";

const image: ImageId = "img-000000000000";
const n1 = "rj-firebat" as NodeName;
const n2 = "infra-testbench" as NodeName;
const dir = await tempDir("nexus-backfill-");

function opened(t: TestContext, path = join(dir, `${randomUUID()}.db`)): Registry {
  return seedRegistry(testRegistry(t, path), { nodes: [n1, n2] });
}

let created = 0;
/** An archived thread is settled unless `settled` is false, so only the run reads it. */
function addThread(registry: Registry, node: NodeName, title: string, status: Thread["status"] = "archived", settled = true): Thread {
  const { id } = addTestThread(registry, { node, boot: { image }, thread: { title, createdAt: 1_000 + created++, lastHumanActivityAt: 0 } });
  if (status !== "active") registry.threads.setThreadStatus(id, status);
  if (status === "archived" && settled) registry.usage.finishSettle(id, null, Date.now());
  return registry.threads.thread(id)!;
}

/** A pylon `running` from a wake for reading, which reports no liveHash, and one running `since archive` with its sessions. */
function observe(registry: Registry, node: NodeName, pylons: readonly [PylonId, "stopped" | "running" | "since archive"][], over: Partial<NodeObservation> = {}, memory = { total: 64, committed: 0 }) {
  const capacity = testCapacity({ memoryGiB: memory.total, committedMemoryGiB: memory.committed });
  const observed = pylons.map(([pylonId, phase]) => phase === "stopped" ? stoppedPylon(pylonId, { checkpoint: `ckpt-${pylonId}-1` })
    : runningPylon(pylonId, phase === "since archive" ? { bootedAt: "2020-01-01T00:00:00Z", liveHash: "live-1" as LiveHash } : {}));
  observeNode(registry, { node, probeBootId: "boot-1", capacity, artifacts: [image], pylons: observed, ...over });
}

/** Records `calls` calls no read had counted, `tokens` in all, as a backfill's read of the thread does. */
const recover = (registry: Registry, thread: ThreadId, calls: number, tokens: number) => registry.usage.recordUsage(thread, Array.from({ length: calls }, (_, i) => ({
  id: `claude:msg_${thread}_${i}`, agent: "claude" as const, model: "claude-opus-5-5", at: 1_000, input: i === 0 ? tokens - calls + 1 : 1, output: 0, cacheWrite: 0, cacheRead: 0,
})), [], true);

function fakeCounter(registry: Registry) {
  const counter = {
    reads: [] as ThreadId[],
    sealed: [] as ThreadId[],
    /** Waits before the seal, as a read of the pylon already under way holds it. */
    before: Promise.resolve(),
    answer: async (id: ThreadId) => recover(registry, id, 3, 300),
    async readWhole(id: ThreadId, _signal?: AbortSignal, seal?: () => void) {
      counter.reads.push(id);
      await counter.before;
      if (seal !== undefined) {
        seal();
        counter.sealed.push(id);
      }
      return counter.answer(id);
    },
  };
  return counter;
}

function backfill(t: TestContext, registry: Registry, counter = fakeCounter(registry), over: { bootMs?: number; pauseMs?: number; settleRetryMs?: number } = {}) {
  const woken: NodeName[] = [];
  const job = polled(usageBackfill({ registry, counter, wake: (node) => woken.push(node), intervalMs: 5, log: () => {}, ...over }));
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
  const run = registry.usage.usageBackfill();
  return run.state === "never" ? null : run.current;
};
const held = (registry: Registry, thread: Thread, phase: "reading" | "pausing") =>
  until(`${thread.title} is held ${phase}`, () => current(registry), (c) => c?.thread === thread.id && c.phase === phase);
const row = (registry: Registry, thread: Thread) => registry.usage.usageBackfillThreads().find((r) => r.thread === thread.id);
const settling = (registry: Registry, thread: Thread, phase: "reading" | "pausing") =>
  until(`${thread.title}'s settle holds it ${phase}`, () => registry.usage.settleHold(), (h) => h?.thread === thread.id && h.phase === phase);
const released = (registry: Registry) => until("the settle lets go of its pylon", () => registry.usage.settleHold(), (h) => h === null);
const desired = (registry: Registry, thread: Thread) => desiredPhase(registry.threads.thread(thread.id)!, Date.now());
const nothing = { calls: 0, tokens: 0 };

test("a start lists each thread once and leaves a running run as it is, and a later start pends again only the skipped threads it lists", (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  let registry = seedRegistry(openRegistry(path), { nodes: [n1, n2] });
  const [a, b, c] = ["a", "b", "c"].map((title) => addThread(registry, n1, title));
  assert.deepEqual(registry.usage.usageBackfill(), { state: "never" });

  assert.deepEqual(registry.usage.startUsageBackfill([a!.id, b!.id], 100), {
    state: "running", startedAt: 100, finishedAt: null, current: null, waiting: null, read: 0, of: 2, recovered: nothing, skipped: [],
  });
  assert.deepEqual(registry.usage.startUsageBackfill([a!.id, b!.id, c!.id], 200), registry.usage.usageBackfill(), "a second start while one runs changes nothing");
  assert.deepEqual(registry.usage.usageBackfillThreads().map((r) => r.title), ["a", "b"]);
  recover(registry, a!.id, 5, 500);
  registry.usage.finishUsageBackfillThread(a!.id, "done", null, 300);
  registry.usage.finishUsageBackfillThread(b!.id, "skipped", "its node holds no disk for its pylon", 310);
  registry.usage.finishUsageBackfill(400);
  const skippedB = { thread: b!.id, title: "b", state: "skipped", reason: "its node holds no disk for its pylon", calls: 0, tokens: 0, at: 310 };
  assert.deepEqual(registry.usage.usageBackfill(), {
    state: "done", startedAt: 100, finishedAt: 400, current: null, waiting: null, read: 2, of: 2, recovered: { calls: 5, tokens: 500 }, skipped: [skippedB],
  });

  registry.close();
  registry = opened(t, path);
  assert.equal(registry.usage.usageBackfill().state, "done", "the run outlives a restart");
  assert.deepEqual(registry.usage.startUsageBackfill([b!.id, c!.id], 500), {
    state: "running", startedAt: 500, finishedAt: null, current: null, waiting: null, read: 1, of: 3, recovered: { calls: 5, tokens: 500 }, skipped: [],
  });
  assert.deepEqual(registry.usage.usageBackfillThreads().map((r) => [r.title, r.state]), [["a", "done"], ["b", "pending"], ["c", "pending"]]);

  registry.usage.holdUsageBackfill(c!.id, 600);
  assert.deepEqual([desired(registry, a!), desired(registry, c!)], ["paused", "reading"]);
  assert.equal(registry.threads.thread(c!.id)!.readingUsage, true);
  registry.usage.finishUsageBackfillThread(c!.id, "done", null, 700);
  assert.deepEqual(current(registry), { thread: c!.id, phase: "pausing", since: 700 });
  assert.equal(desired(registry, c!), "paused", "a read pylon's desired phase is paused again, while the run waits for its pause");
  assert.equal(registry.usage.stopUsageBackfill(800).state, "stopped");
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
  assert.deepEqual(job.start(), { state: "running", startedAt: (registry.usage.usageBackfill() as { startedAt: number }).startedAt, finishedAt: null, current: null, waiting: null, read: 0, of: 2, recovered: nothing, skipped: [] }, "only archived threads are read");

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
  const run = await until("the run is done", () => registry.usage.usageBackfill(), (r) => r.state === "done");
  assert.ok(run.state === "done");
  assert.deepEqual([run.read, run.of, run.recovered, run.skipped, run.current], [2, 2, { calls: 6, tokens: 600 }, [], null]);
  assert.deepEqual(counter.reads, [a.id, b.id]);
});

test("a run waits while the pylon's node is offline, is busy with a job, or would be left too little memory, and says why", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "archived");
  const other = addThread(registry, n1, "other", "idle");
  const { job } = backfill(t, registry);
  const waiting = (why: string) => until(`the run waits because ${why}`, () => registry.usage.usageBackfill(), (r) => r.state === "running" && r.waiting === why);
  job.start();

  await waiting("rj-firebat is offline");
  observe(registry, n1, [[a.pylonId, "stopped"]], { jobs: [{ jobId: "j1" as JobId, subject: other.pylonId, kind: "spawn", state: "running", startedAt: "2027-01-01T00:00:00Z" }] });
  await waiting("rj-firebat is busy with a job");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  registry.threads.savePylon({ ...registry.threads.pylon(other.pylonId)!, submitted: envelope({ kind: "pause", pylonId: other.pylonId, checkpoint: "ckpt-other-1" }, n1, Date.now()) });
  await waiting("rj-firebat is busy with a job");
  registry.threads.savePylon({ ...registry.threads.pylon(other.pylonId)!, submitted: null });
  observe(registry, n1, [[a.pylonId, "stopped"]], {}, { total: 10, committed: 4 });
  await waiting("rj-firebat would have 2 GiB of memory left with it up, less than the 4 GiB of the largest project's pylon");
  assert.equal(desired(registry, a), "paused");

  observe(registry, n1, [[a.pylonId, "stopped"]], {}, { total: 12, committed: 4 });
  await held(registry, a, "reading");
  assert.equal((registry.usage.usageBackfill() as { waiting: string | null }).waiting, null);
});

test("a wake that fails, or does not boot in time, is skipped with why, its attempt cleared so its pylon pauses rather than fails", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "failed");
  const b = addThread(registry, n1, "slow");
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "stopped"]]);
  const before = { at: Date.now(), code: "backend" as const, message: "a failure from before the thread was archived" };
  registry.threads.savePylon({ ...registry.threads.pylon(a.pylonId)!, attempts: { count: 2, last: before } });
  const { job } = backfill(t, registry, fakeCounter(registry), { bootMs: 200 });
  job.start();

  await held(registry, a, "reading");
  assert.deepEqual(registry.threads.pylon(a.pylonId)!.attempts, { count: 0, last: null }, "the hold forgets a failure that was not its wake's");
  registry.usage.failUsageRead(a.id, { at: Date.now(), code: "setup-failed", message: "the disk is full" });
  await held(registry, a, "pausing");
  assert.deepEqual([row(registry, a)!.state, row(registry, a)!.reason], ["skipped", "the pylon did not boot: setup-failed: the disk is full"]);
  assert.deepEqual(registry.threads.pylon(a.pylonId)!.attempts, { count: 0, last: null });
  assert.equal(registry.threads.pylon(a.pylonId)!.failed, null);
  assert.equal(desired(registry, a), "paused");

  await held(registry, b, "reading");
  await held(registry, b, "pausing");
  assert.equal(row(registry, b)!.state, "skipped");
  assert.match(row(registry, b)!.reason!, /^its pylon did not boot within [\d.]+ minutes$/);
  const run = await until("the run is done", () => registry.usage.usageBackfill(), (r) => r.state === "done");
  assert.ok(run.state === "done" && run.read === 2 && run.skipped.length === 2);
});

test("a failed wake for reading is skipped with why, as the loop hands it to the hold, and one of a thread unarchived meanwhile is skipped as unarchived", async (t) => {
  const registry = opened(t);
  const failed = addThread(registry, n1, "failed");
  const unarchived = addThread(registry, n1, "unarchived");
  observe(registry, n1, [[failed.pylonId, "stopped"], [unarchived.pylonId, "stopped"]]);
  const failure = { at: Date.now(), code: "setup-failed" as const, message: "the disk is full" };
  backfill(t, registry).job.start();

  await held(registry, failed, "reading");
  registry.usage.failUsageRead(failed.id, failure);
  await held(registry, failed, "pausing");
  assert.deepEqual([row(registry, failed)!.state, row(registry, failed)!.reason], ["skipped", "the pylon did not boot: setup-failed: the disk is full"]);
  assert.deepEqual(registry.threads.pylon(failed.pylonId)!.attempts, { count: 0, last: null });

  await held(registry, unarchived, "reading");
  registry.threads.setThreadStatus(unarchived.id, "active");
  registry.usage.failUsageRead(unarchived.id, failure);
  await held(registry, unarchived, "pausing");
  assert.deepEqual([row(registry, unarchived)!.state, row(registry, unarchived)!.reason], ["skipped", "it was unarchived while it was read, so live counting reads it"]);
});

test("a failed wake for reading from an earlier run is cleared before the next run wakes the pylon", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "earlier");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  registry.threads.savePylon({ ...registry.threads.pylon(a.pylonId)!, attempts: { count: 1, last: { at: Date.now(), code: "backend", message: "an earlier run's wake" } } });
  backfill(t, registry).job.start();
  await held(registry, a, "reading");
  assert.deepEqual(registry.threads.pylon(a.pylonId)!.attempts, { count: 0, last: null }, "the hold forgets a failure that was not its wake's");
});

test("a thread whose pylon's image no online node holds is skipped, and woken once another node holds it", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "no image");
  observe(registry, n1, [[a.pylonId, "stopped"]], { artifacts: [] });
  const { job } = backfill(t, registry);
  job.start();
  await until("the run is done", () => registry.usage.usageBackfill().state, (s) => s === "done");
  assert.deepEqual([row(registry, a)!.state, row(registry, a)!.reason], ["skipped", `no online node holds its image ${image}`]);
  assert.equal(desired(registry, a), "paused");

  observe(registry, n2, []);
  job.start();
  await held(registry, a, "reading");
});

test("a thread archived for a day, its usage read and backed up since, is skipped, as its disk is deleted, though the node still holds it", async (t) => {
  let now = Date.now() - archivedDiskMs;
  const registry = seedRegistry(testRegistry(t, join(dir, `${randomUUID()}.db`), () => now), { nodes: [n1, n2] });
  const expired = addThread(registry, n1, "expired");
  now = Date.now();
  const kept = addThread(registry, n1, "kept");
  registry.threads.recordBackedUp(Date.now() + 1);
  observe(registry, n1, [[expired.pylonId, "stopped"], [kept.pylonId, "stopped"]]);
  const { job, counter } = backfill(t, registry);
  job.start();
  await held(registry, kept, "reading");
  observe(registry, n1, [[expired.pylonId, "stopped"], [kept.pylonId, "running"]]);
  await until("kept is read", () => counter.reads, (r) => r.includes(kept.id));
  observe(registry, n1, [[expired.pylonId, "stopped"], [kept.pylonId, "stopped"]]);
  await until("the run is done", () => registry.usage.usageBackfill().state, (s) => s === "done");
  assert.deepEqual([row(registry, expired)!.state, row(registry, expired)!.reason], ["skipped", "its disk was deleted 24 hours after it was archived, once its usage was read and backed up"]);
  assert.deepEqual(counter.reads, [kept.id]);
  assert.equal(desired(registry, expired), "deleted");
});

test("a read that fails skips the thread with its error, and one a stop cut short leaves it for the next run", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "broken transcript");
  const b = addThread(registry, n1, "stopped mid-read");
  observe(registry, n1, [[a.pylonId, "since archive"], [b.pylonId, "since archive"]]);
  const counter = fakeCounter(registry);
  const reading = Promise.withResolvers<{ calls: number; tokens: number }>();
  counter.answer = async (id) => id === a.id ? Promise.reject(new Error("the pipe to the pylon was lost")) : reading.promise;
  const { job, woken } = backfill(t, registry, counter);
  job.start();

  await held(registry, a, "pausing");
  assert.deepEqual([row(registry, a)!.state, row(registry, a)!.reason], ["skipped", "reading it failed: the pipe to the pylon was lost"]);
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "since archive"]]);
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
  registry.threads.setThreadStatus(a.id, "idle");
  await held(registry, b, "reading");
  assert.equal(row(registry, a)!.reason, "it was unarchived while it was read, so live counting reads it");
  registry.threads.setThreadStatus(b.id, "deleted");
  await held(registry, c, "reading");
  assert.equal(row(registry, b)!.reason, "it was deleted while it was read");
});

test("a control plane restarted mid-run goes on with the pylon it held, and a second run reads none of the threads the first read", async (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const first = seedRegistry(openRegistry(path), { nodes: [n1, n2] });
  const a = addThread(first, n1, "first");
  const b = addThread(first, n1, "second");
  observe(first, n1, [[a.pylonId, "stopped"], [b.pylonId, "stopped"]]);
  const before = polled(usageBackfill({ registry: first, counter: fakeCounter(first), wake: () => {}, intervalMs: 5, log: () => {} }));
  before.start();
  await held(first, a, "reading");
  await before.close();
  first.close();

  const registry = opened(t, path);
  const { job, counter } = backfill(t, registry);
  assert.deepEqual(current(registry)?.thread, a.id);
  observe(registry, n1, [[a.pylonId, "running"], [b.pylonId, "stopped"]]);
  await held(registry, a, "pausing");
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "since archive"]]);
  await held(registry, b, "pausing");
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "stopped"]]);
  await until("the run is done", () => registry.usage.usageBackfill().state, (s) => s === "done");
  assert.deepEqual(counter.reads, [a.id, b.id]);

  assert.deepEqual(job.plan(), []);
  assert.equal(job.start().state, "running");
  const again = await until("the second run is done", () => registry.usage.usageBackfill(), (r) => r.state === "done");
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
  registry.usage.startUsageBackfill([skipped.id, done.id], 1);
  registry.usage.finishUsageBackfillThread(skipped.id, "skipped", "infra-testbench holds no disk for its pylon", 2);
  registry.usage.finishUsageBackfillThread(done.id, "done", null, 3);
  registry.usage.stopUsageBackfill(4);
  const { job } = backfill(t, registry);
  assert.deepEqual(job.plan(), [
    { thread: skipped.id, project: "acme", node: n2, title: "skipped before", reason: "infra-testbench holds no disk for its pylon" },
    { thread: fresh.id, project: "acme", node: n1, title: "never read", reason: null },
  ]);
});

test("an archive whose last read was missed is woken for reading once its pylon paused, read whole, settled, and let go once it pauses again, and its disk goes after the next backup", async (t) => {
  let now = Date.now() - archivedDiskMs;
  const registry = seedRegistry(testRegistry(t, join(dir, `${randomUUID()}.db`), () => now), { nodes: [n1, n2] });
  const a = addThread(registry, n1, "missed", "archived", false);
  now = Date.now();
  observe(registry, n1, [[a.pylonId, "since archive"]]);
  const { woken, counter } = backfill(t, registry);
  await delay(50);
  assert.deepEqual([registry.usage.settleHold(), woken, counter.reads], [null, [], []], "a pylon still running from before its archive's pause is not read, as a turn may still come");
  assert.equal(desired(registry, a), "paused");

  observe(registry, n1, [[a.pylonId, "stopped"]]);
  await settling(registry, a, "reading");
  assert.deepEqual([desired(registry, a), woken], ["reading", [n1]], "a disk kept past its 24 hours is woken for reading");
  observe(registry, n1, [[a.pylonId, "running"]]);
  await settling(registry, a, "pausing");
  assert.deepEqual([counter.reads, counter.sealed], [[a.id], [a.id]], "the read is sealed, so no hook or service of the wake adds a call after it");
  const settled = registry.threads.thread(a.id)!;
  assert.ok(settled.usageSettledAt !== undefined && settled.usageSettledAt >= now);
  assert.deepEqual([desired(registry, a), diskKept(settled)], ["paused", "it waits for a backup that begins after its token usage was read"]);
  assert.deepEqual(woken, [n1, n1], "the read wakes the node, so the pylon pauses");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  await released(registry);
  assert.equal(registry.usage.usageBackfill().state, "never", "a settle is no run of the backfill");

  registry.threads.recordBackedUp(settled.usageSettledAt);
  assert.equal(desired(registry, a), "paused", "a backup that began as the read ended may not hold it");
  registry.threads.recordBackedUp(settled.usageSettledAt + 1);
  assert.equal(desired(registry, a), "deleted");
  await delay(50);
  assert.deepEqual(counter.reads, [a.id], "a settled archive is not read again");
});

test("a settle that fails keeps the disk, counts the failures in a row with the last reason, and is tried again only after the retry wait", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "flaky", "archived", false);
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  const counter = fakeCounter(registry);
  let fails = 2;
  counter.answer = async (id) => fails-- > 0 ? Promise.reject(new Error("the pipe to the pylon was lost")) : recover(registry, id, 1, 10);
  backfill(t, registry, counter, { settleRetryMs: 200 });

  for (const count of [1, 2]) {
    await settling(registry, a, "reading");
    observe(registry, n1, [[a.pylonId, "running"]]);
    await settling(registry, a, "pausing");
    const failure = registry.threads.thread(a.id)!.settleFailure;
    assert.deepEqual(failure && { ...failure, at: 0 }, { reason: "reading it failed: the pipe to the pylon was lost", at: 0, count });
    assert.match(diskKept(registry.threads.thread(a.id)!)!, new RegExp(`reading it failed ${count === 1 ? "once" : "2 times in a row"}, the last because reading it failed: the pipe`));
    observe(registry, n1, [[a.pylonId, "stopped"]]);
    await released(registry);
    const again = await settling(registry, a, "reading");
    assert.ok(again!.since - failure!.at >= 200, "the next settle waits out the retry wait");
  }
  observe(registry, n1, [[a.pylonId, "running"]]);
  await settling(registry, a, "pausing");
  const settled = registry.threads.thread(a.id)!;
  assert.deepEqual([settled.usageSettledAt !== undefined, settled.settleFailure], [true, undefined], "a settle that reads it forgets the failures");
});

test("a settle wakes no pylon whose node has no disk for it, which is settled as it is, nor one that failed or whose image no online node holds, whose usage it records unread, so its disk goes at its 24 hours", async (t) => {
  let now = Date.now() - archivedDiskMs;
  const registry = seedRegistry(testRegistry(t, join(dir, `${randomUUID()}.db`), () => now), { nodes: [n1, n2] });
  const gone = addThread(registry, n1, "gone", "archived", false);
  const failed = addThread(registry, n1, "failed", "archived", false);
  const imageless = addThread(registry, n2, "imageless", "archived", false);
  now = Date.now();
  registry.threads.savePylon({ ...registry.threads.pylon(failed.pylonId)!, failed: "gave up after 5 failed attempts, the last with backend: boom\nthe log's last line" });
  observe(registry, n1, [[failed.pylonId, "stopped"]], { artifacts: [] });
  observe(registry, n2, [[imageless.pylonId, "stopped"]], { artifacts: [] });
  const { woken } = backfill(t, registry);
  await until("each is settled or unread", () => [gone, failed, imageless].map((x) => registry.threads.thread(x.id)!), (ts) => ts.every((x) => x.usageSettledAt !== undefined || x.usageUnread !== undefined));
  assert.ok(registry.threads.thread(gone.id)!.usageSettledAt !== undefined, "a pylon its online node does not have has no disk to lose");
  assert.deepEqual([failed, imageless].map((x) => registry.threads.thread(x.id)!.usageUnread), ["its pylon failed: gave up after 5 failed attempts, the last with backend: boom", `no online node holds its image ${image}`]);
  assert.deepEqual([failed, imageless].map((x) => [registry.threads.thread(x.id)!.settleFailure, desired(registry, x)]), [[undefined, "deleted"], [undefined, "deleted"]], "no settle failed, and no backup is waited for");
  await delay(50);
  assert.deepEqual([woken, registry.usage.settleHold()], [[], null]);

  observe(registry, n2, [[imageless.pylonId, "stopped"]]);
  await until("an archive whose image a node holds again can be read", () => registry.threads.thread(imageless.id)!.usageUnread, (u) => u === undefined);
  await settling(registry, imageless, "reading");
  assert.equal(desired(registry, imageless), "reading");
});

test("one pylon is up at a time across the run and the settles, a settle goes first, and the run's read of a pylon that has not paused settles nothing", async (t) => {
  const registry = opened(t);
  const read = addThread(registry, n1, "read by the run");
  const early = addThread(registry, n2, "not paused yet", "archived", false);
  const late = addThread(registry, n2, "archived later", "archived", false);
  observe(registry, n1, [[read.pylonId, "stopped"]]);
  observe(registry, n2, [[early.pylonId, "since archive"], [late.pylonId, "stopped"]]);
  const { job, counter } = backfill(t, registry);
  await settling(registry, late, "reading");
  job.start();
  await delay(50);
  assert.equal(current(registry), null, "the run waits while a settle holds a pylon");
  observe(registry, n2, [[early.pylonId, "since archive"], [late.pylonId, "running"]]);
  await settling(registry, late, "pausing");
  observe(registry, n2, [[early.pylonId, "since archive"], [late.pylonId, "stopped"]]);
  await held(registry, read, "reading");
  assert.equal(registry.usage.settleHold(), null);
  observe(registry, n1, [[read.pylonId, "running"]]);
  await held(registry, read, "pausing");
  await delay(50);
  assert.equal(registry.usage.settleHold(), null, "a settle waits while the run holds a pylon");
  observe(registry, n1, [[read.pylonId, "stopped"]]);
  await held(registry, early, "reading");
  await held(registry, early, "pausing");
  assert.equal(registry.threads.thread(early.id)!.usageSettledAt, undefined, "a read of a pylon that has not paused since its archive proves nothing");
  observe(registry, n2, [[early.pylonId, "stopped"], [late.pylonId, "stopped"]]);
  await settling(registry, early, "reading");
  assert.deepEqual(counter.reads, [late.id, read.id, early.id]);
  assert.deepEqual(counter.sealed, [late.id], "the run's read seals nothing");
});

test("a control plane restarted while a settle holds a pylon lets it pause, and settles it once it has", async (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const first = seedRegistry(openRegistry(path), { nodes: [n1, n2] });
  const a = addThread(first, n1, "held", "archived", false);
  observe(first, n1, [[a.pylonId, "stopped"]]);
  const before = polled(usageBackfill({ registry: first, counter: fakeCounter(first), wake: () => {}, intervalMs: 5, log: () => {} }));
  await settling(first, a, "reading");
  await before.close();
  first.close();

  const registry = opened(t, path);
  observe(registry, n1, [[a.pylonId, "running"]]);
  assert.deepEqual([registry.usage.settleHold(), desired(registry, a)], [null, "paused"], "the pylon the lost hold woke pauses");
  const { counter } = backfill(t, registry);
  await delay(50);
  assert.deepEqual(counter.reads, [], "a pylon running from a wake no settle holds is not read");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  await settling(registry, a, "reading");
  observe(registry, n1, [[a.pylonId, "running"]]);
  await settling(registry, a, "pausing");
  assert.ok(registry.threads.thread(a.id)!.usageSettledAt !== undefined);
});

test("a settle's read that an unarchive and a new archive overtook settles neither archive, and the new one is read again", async (t) => {
  let now = 1_000;
  const registry = seedRegistry(testRegistry(t, join(dir, `${randomUUID()}.db`), () => now), { nodes: [n1, n2] });
  const a = addThread(registry, n1, "rearchived", "archived", false);
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  const counter = fakeCounter(registry);
  const reading = Promise.withResolvers<void>();
  counter.answer = async (id) => {
    await reading.promise;
    return recover(registry, id, 1, 10);
  };
  backfill(t, registry, counter);
  await settling(registry, a, "reading");
  observe(registry, n1, [[a.pylonId, "running"]]);
  await until("the settle reads it", () => counter.reads.length, (n) => n === 1);
  registry.threads.setThreadStatus(a.id, "idle");
  now = 2_000;
  registry.threads.setThreadStatus(a.id, "archived");
  reading.resolve();
  await settling(registry, a, "pausing");
  assert.equal(registry.threads.thread(a.id)!.usageSettledAt, undefined, "a turn may have run between the archives");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  await released(registry);
  await settling(registry, a, "reading");
  observe(registry, n1, [[a.pylonId, "running"]]);
  await settling(registry, a, "pausing");
  assert.notEqual(registry.threads.thread(a.id)!.usageSettledAt, undefined, "a read after the new archive settles it");
});

test("after a restart lost a settle's hold, no other pylon is woken until the one it woke has paused", async (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const first = seedRegistry(openRegistry(path), { nodes: [n1, n2] });
  const a = addThread(first, n1, "held", "archived", false);
  observe(first, n1, [[a.pylonId, "stopped"]]);
  const before = polled(usageBackfill({ registry: first, counter: fakeCounter(first), wake: () => {}, intervalMs: 5, log: () => {} }));
  await settling(first, a, "reading");
  await before.close();
  first.close();

  const registry = opened(t, path);
  const b = addThread(registry, n2, "next", "archived", false);
  observe(registry, n1, [[a.pylonId, "running"]]);
  observe(registry, n2, [[b.pylonId, "stopped"]]);
  const { woken } = backfill(t, registry);
  await delay(50);
  assert.deepEqual([registry.usage.settleHold(), woken], [null, []], "the pylon the lost hold woke is still up");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  await settling(registry, a, "reading");
});

test("a thread unarchived while its settle waits to seal its pylon is not sealed, and a sealed boot is recorded before its seal", async (t) => {
  const registry = opened(t);
  const a = addThread(registry, n1, "unarchived", "archived", false);
  const b = addThread(registry, n2, "sealed", "archived", false);
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  const counter = fakeCounter(registry);
  const earlier = Promise.withResolvers<void>();
  counter.before = earlier.promise;
  backfill(t, registry, counter);
  await settling(registry, a, "reading");
  observe(registry, n1, [[a.pylonId, "running"]]);
  await until("the settle waits on the read before it", () => counter.reads, (r) => r.length === 1);
  registry.threads.setThreadStatus(a.id, "idle");
  earlier.resolve();
  await until("the settle gives up", () => registry.usage.settleHold(), (h) => h?.phase !== "reading");
  assert.deepEqual([counter.sealed, registry.threads.sealedBoot(a.pylonId)], [[], undefined], "an unarchived thread's pylon is never sealed");
  observe(registry, n1, [[a.pylonId, "since archive"]]);
  await released(registry);

  counter.before = Promise.resolve();
  observe(registry, n2, [[b.pylonId, "stopped"]]);
  await settling(registry, b, "reading");
  observe(registry, n2, [[b.pylonId, "running"]]);
  await settling(registry, b, "pausing");
  assert.deepEqual([counter.sealed, registry.threads.sealedBoot(b.pylonId)], [[b.id], "2027-01-01T00:00:00Z"], "the boot it sealed is recorded");
});

test("a run wakes nothing while a pylon a restart's lost settle woke is still up, and goes on once it paused", async (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const first = seedRegistry(openRegistry(path), { nodes: [n1, n2] });
  const a = addThread(first, n1, "held", "archived", false);
  observe(first, n1, [[a.pylonId, "stopped"]]);
  const before = polled(usageBackfill({ registry: first, counter: fakeCounter(first), wake: () => {}, intervalMs: 5, log: () => {} }));
  await settling(first, a, "reading");
  await before.close();
  first.close();

  const registry = opened(t, path);
  const c = addThread(registry, n2, "the run's");
  observe(registry, n1, [[a.pylonId, "running"]]);
  observe(registry, n2, [[c.pylonId, "stopped"]]);
  const { job, woken } = backfill(t, registry);
  job.start();
  await delay(50);
  assert.deepEqual([current(registry), woken], [null, []], "the run waits for the pylon up for reading");
  assert.equal(registry.threads.thread(a.id)!.settleWaiting, undefined, "the archive whose pylon is up is the one it waits for");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  await settling(registry, a, "reading");
  observe(registry, n1, [[a.pylonId, "running"]]);
  await settling(registry, a, "pausing");
  observe(registry, n1, [[a.pylonId, "stopped"]]);
  await until("the run takes its next pylon once nothing is up", () => current(registry), (h) => h !== null);
});

test("a pylon stuck up for reading holds the settles back only for the pause's time limit, and is logged", async (t) => {
  const registry = opened(t);
  const stuck = addThread(registry, n1, "stuck");
  const next = addThread(registry, n2, "next", "archived", false);
  observe(registry, n1, [[stuck.pylonId, "running"]]);
  observe(registry, n2, [[next.pylonId, "stopped"]]);
  const logs: string[] = [];
  const job = polled(usageBackfill({ registry, counter: fakeCounter(registry), wake: () => {}, intervalMs: 5, pauseMs: 200, log: (m) => logs.push(m) }));
  t.after(() => job.close());
  await delay(50);
  assert.equal(registry.usage.settleHold(), null);
  assert.match(registry.threads.thread(next.id)!.settleWaiting!, new RegExp(`${stuck.pylonId} on rj-firebat is up for reading`));
  assert.match(diskKept(registry.threads.thread(next.id)!)!, /Its next read waits, as .* is up for reading, and one pylon is woken at a time/);
  await settling(registry, next, "reading");
  assert.ok(logs.some((m) => m.includes(`${stuck.pylonId} has been up for reading`)), "the pylon it stopped waiting for is logged");
});

test("an archive whose settle waits says why: its node is offline, or has no room for its pylon", async (t) => {
  const registry = opened(t);
  const offline = addThread(registry, n1, "offline", "archived", false);
  const full = addThread(registry, n2, "full", "archived", false);
  observe(registry, n2, [[full.pylonId, "stopped"]], {}, { total: 64, committed: 60 });
  registry.nodes.markOffline(n1);
  backfill(t, registry);
  await until("both record why they wait", () => [offline, full].map((x) => registry.threads.thread(x.id)!.settleWaiting), (w) => w.every((r) => r !== undefined));
  assert.equal(registry.threads.thread(offline.id)!.settleWaiting, "rj-firebat is offline");
  assert.match(registry.threads.thread(full.id)!.settleWaiting!, /^infra-testbench would have .* GiB of memory left with it up/);
  assert.equal(registry.usage.settleHold(), null);
});
