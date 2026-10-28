import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openRegistry, type Registry, type Thread, type ThreadId } from "./registry.ts";
import { usageBackfill } from "./usage-backfill.ts";
import { desiredPhase, envelope } from "../reconcile.ts";
import { newPylonRecord } from "../tick.ts";
import type { JobId, LiveHash, NodeName, NodeObservation, PylonId, PylonObservation, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";
import type { ImageId } from "../images.ts";

const image: ImageId = "img-000000000000";
const n1 = "rj-firebat" as NodeName;
const n2 = "infra-testbench" as NodeName;
const dir = await mkdtemp(join(tmpdir(), "nexus-backfill-"));
after(() => rm(dir, { recursive: true }));

function opened(path = join(dir, `${randomUUID()}.db`)): Registry {
  const registry = openRegistry(path);
  for (const name of [n1, n2]) registry.upsertNode({ name, tailnetHost: `${name}.tail.ts.net`, tailnetNodeId: `n${name}` as TailnetNodeId });
  if (registry.project("acme" as ProjectId) === undefined) {
    registry.createProject({
      id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: n1,
      resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
    });
  }
  return registry;
}

let created = 0;
function addThread(registry: Registry, node: NodeName, title: string, status: Thread["status"] = "archived"): Thread {
  const id = `th-${randomUUID().slice(0, 8)}` as ThreadId;
  const pylonId = `pylon-${id}` as PylonId;
  const thread: Thread = {
    seenAt: null, lastReplyAt: null, id, title, project: "acme" as ProjectId, pylonId, status: "active", conversationId: null,
    startedBy: "nLAPTOP", createdAt: 1_000 + created++, agentTurnRunning: false, working: false, lastAgentActivityAt: 0, lastHumanActivityAt: 0,
  };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: id, pylonId, node, desired: "paused",
    boot: {
      pylonId, image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
      repo: { kind: "clone", url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
      dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    },
    firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash-1" as LiveHash,
  });
  registry.createThread(thread, pylon);
  if (status !== "active") registry.setThreadStatus(id, status);
  return registry.thread(id)!;
}

function observe(registry: Registry, node: NodeName, pylons: readonly [PylonId, "stopped" | "running"][], over: Partial<NodeObservation> = {}, memory = { total: 64, committed: 0 }) {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: memory.total, committedMemoryGiB: memory.committed, diskFreeGiB: 100, committedDiskGiB: 0 };
  const observed = pylons.map(([pylonId, phase]): PylonObservation => phase === "stopped"
    ? { pylonId, phase, checkpoint: `ckpt-${pylonId}-1`, sessions: [] }
    : { pylonId, phase, liveHash: null, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0 });
  registry.ingested({
    node, observedAt: new Date().toISOString(), probeBootId: "boot-1", capacity, artifacts: [image], jobs: [], pylons: observed,
    grants: { secrets: [], gitSsh: false }, previewRoutes: [], spawnsWithoutRelaunch: true, ...over,
  }, [{ record: "node", node, state: "online", capacity }]);
}

function fakeCounter() {
  const counter = {
    reads: [] as ThreadId[],
    answer: async (_: ThreadId) => ({ calls: 3, tokens: 300 }),
    readWhole(id: ThreadId) {
      counter.reads.push(id);
      return counter.answer(id);
    },
  };
  return counter;
}

function backfill(t: TestContext, registry: Registry, counter = fakeCounter(), over: { bootMs?: number; pauseMs?: number } = {}) {
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
  let registry = opened(path);
  t.after(() => registry.close());
  const [a, b, c] = ["a", "b", "c"].map((title) => addThread(registry, n1, title));
  assert.deepEqual(registry.usageBackfill(), { state: "never" });

  assert.deepEqual(registry.startUsageBackfill([a!.id, b!.id], 100), {
    state: "running", startedAt: 100, finishedAt: null, current: null, waiting: null, read: 0, of: 2, recovered: nothing, skipped: [],
  });
  assert.deepEqual(registry.startUsageBackfill([a!.id, b!.id, c!.id], 200), registry.usageBackfill(), "a second start while one runs changes nothing");
  assert.deepEqual(registry.usageBackfillThreads().map((r) => r.title), ["a", "b"]);
  registry.finishUsageBackfillThread(a!.id, "done", null, { calls: 5, tokens: 500 }, 300);
  registry.finishUsageBackfillThread(b!.id, "skipped", "its node holds no disk for its pylon", nothing, 310);
  registry.finishUsageBackfill(400);
  const skippedB = { thread: b!.id, title: "b", state: "skipped", reason: "its node holds no disk for its pylon", calls: 0, tokens: 0, at: 310 };
  assert.deepEqual(registry.usageBackfill(), {
    state: "done", startedAt: 100, finishedAt: 400, current: null, waiting: null, read: 2, of: 2, recovered: { calls: 5, tokens: 500 }, skipped: [skippedB],
  });

  registry.close();
  registry = opened(path);
  assert.equal(registry.usageBackfill().state, "done", "the run outlives a restart");
  assert.deepEqual(registry.startUsageBackfill([b!.id, c!.id], 500), {
    state: "running", startedAt: 500, finishedAt: null, current: null, waiting: null, read: 1, of: 3, recovered: { calls: 5, tokens: 500 }, skipped: [],
  });
  assert.deepEqual(registry.usageBackfillThreads().map((r) => [r.title, r.state]), [["a", "done"], ["b", "pending"], ["c", "pending"]]);

  registry.holdUsageBackfill(c!.id, 600);
  assert.deepEqual([desired(registry, a!), desired(registry, c!)], ["paused", "reading"]);
  assert.equal(registry.thread(c!.id)!.readingUsage, true);
  registry.finishUsageBackfillThread(c!.id, "done", null, { calls: 1, tokens: 10 }, 700);
  assert.deepEqual(current(registry), { thread: c!.id, phase: "pausing", since: 700 });
  assert.equal(desired(registry, c!), "paused", "a read pylon's desired phase is paused again, while the run waits for its pause");
  assert.equal(registry.stopUsageBackfill(800).state, "stopped");
  assert.equal(current(registry), null);
});

test("a run wakes one archived thread's pylon at a time, across nodes, reads it once it runs, and wakes the next once it paused", async (t) => {
  const registry = opened();
  t.after(() => registry.close());
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
  const registry = opened();
  t.after(() => registry.close());
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
  const registry = opened();
  t.after(() => registry.close());
  const a = addThread(registry, n1, "failed");
  const b = addThread(registry, n1, "slow");
  observe(registry, n1, [[a.pylonId, "stopped"], [b.pylonId, "stopped"]]);
  const before = { at: Date.now(), code: "backend" as const, message: "a failure from before the thread was archived" };
  registry.savePylon({ ...registry.pylon(a.pylonId)!, attempts: { count: 2, last: before } });
  const { job } = backfill(t, registry, fakeCounter(), { bootMs: 200 });
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

test("a thread whose pylon's image no online node holds is skipped, and woken once another node holds it", async (t) => {
  const registry = opened();
  t.after(() => registry.close());
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

test("a read that fails skips the thread with its error, and one a stop cut short leaves it for the next run", async (t) => {
  const registry = opened();
  t.after(() => registry.close());
  const a = addThread(registry, n1, "broken transcript");
  const b = addThread(registry, n1, "stopped mid-read");
  observe(registry, n1, [[a.pylonId, "running"], [b.pylonId, "running"]]);
  const counter = fakeCounter();
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
  const registry = opened();
  t.after(() => registry.close());
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
  const first = opened(path);
  const a = addThread(first, n1, "first");
  const b = addThread(first, n1, "second");
  observe(first, n1, [[a.pylonId, "stopped"], [b.pylonId, "stopped"]]);
  const before = usageBackfill({ registry: first, counter: fakeCounter(), wake: () => {}, intervalMs: 5, log: () => {} });
  before.start();
  await held(first, a, "reading");
  await before.close();
  first.close();

  const registry = opened(path);
  t.after(() => registry.close());
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
  const registry = opened();
  t.after(() => registry.close());
  const skipped = addThread(registry, n2, "skipped before");
  const done = addThread(registry, n1, "read before");
  const fresh = addThread(registry, n1, "never read");
  addThread(registry, n1, "active", "idle");
  addThread(registry, n1, "deleted", "deleted");
  registry.startUsageBackfill([skipped.id, done.id], 1);
  registry.finishUsageBackfillThread(skipped.id, "skipped", "infra-testbench holds no disk for its pylon", nothing, 2);
  registry.finishUsageBackfillThread(done.id, "done", null, { calls: 1, tokens: 1 }, 3);
  registry.stopUsageBackfill(4);
  const { job } = backfill(t, registry);
  assert.deepEqual(job.plan(), [
    { thread: skipped.id, project: "acme", node: n2, title: "skipped before", reason: "infra-testbench holds no disk for its pylon" },
    { thread: fresh.id, project: "acme", node: n1, title: "never read", reason: null },
  ]);
});
