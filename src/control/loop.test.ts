import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLoop, type Ingest, type Loop } from "./loop.ts";
import { openRegistry, type Registry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { envelope } from "../reconcile.ts";
import type {
  Job, JobEnvelope, JobId, JobStatus, LiveHash, NodeName, NodeObservation, ProbeClient, ProbeEvent, PylonId, PylonObservation, SubmitReply, TailnetNodeId,
} from "../protocol.ts";
import type { ProjectId } from "../project.ts";
import type { ImageId } from "../images.ts";

const node = "rj-firebat" as NodeName;
const image: ImageId = "img-000000000000";

/**
 * A node as its probe presents it. Jobs run until `finish` unless `autoFinish` is set. Like the real probe, a
 * finished job is announced by a job event first and by a fresh snapshot a moment later.
 */
function fakeNode(options: { autoFinish: boolean }) {
  const pylons = new Map<PylonId, PylonObservation>();
  const jobs = new Map<JobId, { env: JobEnvelope; status: JobStatus }>();
  const submitted: Job[] = [];
  const streams = new Set<(event: ProbeEvent | null) => void>();
  let reachable = true;

  const observation = (): NodeObservation => ({
    node, observedAt: new Date().toISOString(), probeBootId: "boot-1",
    capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 },
    artifacts: [image], jobs: [...jobs.values()].map((j) => j.status), pylons: [...pylons.values()],
  });
  const emit = (event: ProbeEvent) => { for (const push of streams) push(event); };

  function apply(job: Job) {
    switch (job.kind) {
      case "spawn":
        pylons.set(job.pylonId, {
          pylonId: job.pylonId, phase: "running", liveHash: job.liveHash, bootedAt: new Date().toISOString(),
          bootedFrom: { image, checkpoint: job.boot.source.kind === "resume" ? job.boot.source.checkpoint : null },
          services: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
        });
        return;
      case "pause": pylons.set(job.pylonId, { pylonId: job.pylonId, phase: "stopped", checkpoint: job.checkpoint }); return;
      case "delete": pylons.delete(job.pylonId); return;
      default: throw new Error(`the fake node runs no ${job.kind} jobs`);
    }
  }

  function finish(jobId: JobId) {
    const entry = jobs.get(jobId)!;
    assert.equal(entry.status.state, "running");
    apply(entry.env.job);
    entry.status = { jobId, subject: entry.status.subject, kind: entry.status.kind, state: "succeeded", finishedAt: new Date().toISOString() };
    emit({ type: "job", status: entry.status });
    setTimeout(() => emit({ type: "snapshot", observation: observation() }), 20);
  }

  const unreachable = () => Object.assign(new Error(`${node} is unreachable`), { code: "unreachable" });

  const probe: ProbeClient = {
    node,
    async submit(env): Promise<SubmitReply> {
      if (!reachable) throw unreachable();
      const known = jobs.get(env.jobId);
      if (known) return { accepted: known.status };
      const subject = "pylonId" in env.job ? env.job.pylonId : "";
      const busy = [...jobs.values()].find((j) => j.status.subject === subject && j.status.state === "running");
      if (busy) return { rejected: "busy", inFlight: busy.status.jobId };
      const status: JobStatus = { jobId: env.jobId, subject: subject as PylonId, kind: env.job.kind, state: "running", startedAt: new Date().toISOString() };
      jobs.set(env.jobId, { env, status });
      submitted.push(env.job);
      emit({ type: "job", status });
      if (options.autoFinish) setTimeout(() => finish(env.jobId), 5);
      return { accepted: status };
    },
    async job(jobId) {
      if (!reachable) throw unreachable();
      return jobs.get(jobId)?.status ?? "unknown";
    },
    async *observe(signal) {
      if (!reachable) throw unreachable();
      const queue: (ProbeEvent | null)[] = [{ type: "snapshot", observation: observation() }];
      let notify: (() => void) | null = null;
      const push = (event: ProbeEvent | null) => { queue.push(event); notify?.(); };
      streams.add(push);
      const onAbort = () => push(null);
      signal.addEventListener("abort", onAbort);
      try {
        for (;;) {
          while (queue.length > 0) {
            const event = queue.shift()!;
            if (event === null) return;
            yield event;
          }
          await new Promise<void>((resolve) => { notify = resolve; });
          notify = null;
        }
      } finally {
        streams.delete(push);
        signal.removeEventListener("abort", onAbort);
      }
    },
    command: () => Promise.reject(new Error("unused")),
    stream: () => Promise.reject(new Error("unused")),
  };

  return {
    probe, pylons, submitted, finish,
    running: () => [...jobs.values()].filter((j) => j.status.state === "running").map((j) => j.env.jobId),
    /** Drops every observe link and refuses calls until `reconnect`. */
    disconnect() { reachable = false; for (const push of streams) push(null); },
    reconnect() { reachable = true; },
  };
}

/** The node write the real ingest makes for a snapshot. Nothing else matters to the loop. */
const ingest: Ingest = (event, eventNode) => event.type === "snapshot"
  ? [{ record: "node", node: eventNode, state: "online", capacity: event.observation.capacity }]
  : [];

async function until(what: string, predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// One directory for the file, so each test's registry is closed before it is removed.
const dir = await mkdtemp(join(tmpdir(), "nexus-loop-"));
after(() => rm(dir, { recursive: true }));
const tempDb = () => join(dir, `${randomUUID()}.db`);

function seed(registry: Registry, activity: Partial<Pick<Thread, "agentTurnRunning" | "lastAgentActivityAt" | "lastHumanActivityAt">> = {}): Thread {
  registry.upsertNode({ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  registry.createProject({
    id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
  const id = `th-${randomUUID().slice(0, 8)}` as ThreadId;
  const pylonId = `pylon-${id}` as PylonId;
  const thread: Thread = {
    id, title: "t", project: "acme" as ProjectId, pylonId, status: "active", conversationId: null, startedBy: "nLAPTOP",
    createdAt: Date.now(), agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now(), ...activity,
  };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: id, pylonId, node, desired: "running",
    boot: {
      pylonId, image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
      repo: { url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
    },
    firstBoot: { kind: "fresh", preSetup: null },
    live: { previews: [], overlay: [] },
    liveHash: "hash-1" as LiveHash,
  });
  registry.createThread(thread, pylon);
  return thread;
}

function run(t: import("node:test").TestContext, registry: Registry, probe: ProbeClient, overrides: { offlineAfterMs?: number; silenceMs?: number; ingest?: Ingest } = {}): Loop {
  const loop = startLoop({
    registry, probes: [probe], ingest: overrides.ingest ?? ingest, intervalMs: 10, reconnectMs: 10,
    offlineAfterMs: overrides.offlineAfterMs ?? 30_000, silenceMs: overrides.silenceMs ?? 30_000, log: assert.fail,
  });
  t.after(async () => {
    await loop.close();
    registry.close();
  });
  return loop;
}

test("a thread's pylon follows its thread: spawn, pause on archive, resume on activity, delete", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  run(t, registry, fake.probe);

  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.equal(registry.node(node)?.state, "online");

  registry.setThreadStatus(thread.id, "archived");
  await until("the pylon is paused", () => fake.pylons.get(thread.pylonId)?.phase === "stopped");
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1);

  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  await until("the pylon runs again", () => fake.pylons.get(thread.pylonId)?.phase === "running");

  registry.setThreadStatus(thread.id, "deleted");
  await until("the pylon is gone", () => !fake.pylons.has(thread.pylonId) && registry.pylon(thread.pylonId)?.submitted === null);

  assert.deepEqual(fake.submitted.map((job) => job.kind === "spawn" ? `spawn ${job.boot.source.kind}` : job.kind), ["spawn fresh", "pause", "spawn resume", "delete"]);
  const resume = fake.submitted[2]!;
  assert.ok(resume.kind === "spawn" && resume.boot.source.kind === "resume");
  assert.equal(resume.boot.source.checkpoint, `ckpt-${thread.id}-1`);
});

test("a pylon pauses once its agent turn ends and nobody has used it for a while", async (t) => {
  const registry = openRegistry(tempDb());
  const longAgo = Date.now() - 60 * 60_000;
  const thread = seed(registry, { agentTurnRunning: true, lastAgentActivityAt: longAgo, lastHumanActivityAt: longAgo });
  const fake = fakeNode({ autoFinish: true });
  run(t, registry, fake.probe);
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");

  registry.recordActivity(thread.id, { agentTurnRunning: false });
  await until("the pylon is paused", () => fake.pylons.get(thread.pylonId)?.phase === "stopped");
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["spawn", "pause"]);
});

test("an unreachable node gets no jobs, is recorded offline after the grace period, and catches up when it returns", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  fake.disconnect();
  run(t, registry, fake.probe, { offlineAfterMs: 30 });

  registry.apply({ record: "node", node, state: "online", capacity: { memoryGiB: 1, committedMemoryGiB: 0, diskFreeGiB: 1 } });
  await until("the node is recorded offline", () => registry.node(node)?.state === "offline");
  assert.equal(fake.submitted.length, 0);

  fake.reconnect();
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.equal(registry.node(node)?.state, "online");
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["spawn"]);
});

test("a node that goes quiet, as a sleeping one does, is treated as unreachable", async (t) => {
  const registry = openRegistry(tempDb());
  seed(registry);
  const fake = fakeNode({ autoFinish: true });
  // The stream stays open and silent after its first snapshot, and the node takes no calls.
  const asleep: ProbeClient = { ...fake.probe, observe: async function* (signal) {
    for await (const event of fake.probe.observe(signal)) {
      yield event;
      fake.disconnect();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return;
    }
  } };
  run(t, registry, asleep, { silenceMs: 30, offlineAfterMs: 30 });
  await until("the node is online", () => registry.node(node)?.state === "online");
  await until("the node is recorded offline", () => registry.node(node)?.state === "offline");
});

test("each snapshot is ingested against the last observation ingested for each known pylon", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  const previous: string[][] = [];
  run(t, registry, fake.probe, {
    ingest: (event, eventNode, known, now) => {
      assert.deepEqual([...known.keys()], [thread.pylonId]);
      if (event.type === "snapshot") previous.push([...known.values()].map((o) => o === "absent" ? "absent" : o.phase));
      return ingest(event, eventNode, known, now);
    },
  });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  registry.setThreadStatus(thread.id, "archived");
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1);
  await until("the snapshot after the pause is ingested", () => previous.length === 3);
  // On connect nothing was observed yet, after the spawn the last observation had no pylon, and after the pause it ran.
  assert.deepEqual(previous, [["absent"], ["absent"], ["running"]]);
});

test("a job in flight survives a control-plane restart: the new process asks the probe and sends nothing twice", async (t) => {
  const path = tempDb();
  const fake = fakeNode({ autoFinish: false });

  const before = openRegistry(path);
  const thread = seed(before);
  const first = startLoop({ registry: before, probes: [fake.probe], ingest, intervalMs: 10, reconnectMs: 10, log: assert.fail });
  await until("the spawn is accepted", () => fake.running().length === 1);
  await first.close();
  before.close();

  const after = openRegistry(path);
  assert.equal(after.pylon(thread.pylonId)?.submitted?.jobId, fake.running()[0]);
  const loop = run(t, after, fake.probe);
  await loop.wake(node);
  await loop.wake(node);
  assert.equal(fake.submitted.length, 1, "no job is sent while the first one runs");

  fake.finish(fake.running()[0]!);
  await until("the finished job is folded in", () => after.pylon(thread.pylonId)?.submitted === null);
  await loop.wake(node);
  assert.equal(fake.pylons.get(thread.pylonId)?.phase, "running");
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["spawn"]);
});

test("an envelope saved by a control plane that died mid-submit holds the pylon until it expires", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const pylon = registry.pylon(thread.pylonId)!;
  // The request may still be on its way to the probe, so a new job could land before it.
  const inTransit = envelope({ kind: "delete", pylonId: thread.pylonId }, node, Date.now());
  registry.savePylon({ ...pylon, submitted: inTransit });
  const fake = fakeNode({ autoFinish: true });
  const loop = run(t, registry, fake.probe);
  await until("the node is online", () => registry.node(node)?.state === "online");
  await loop.wake(node);
  await loop.wake(node);
  assert.equal(fake.submitted.length, 0);
  assert.equal(registry.pylon(thread.pylonId)?.submitted?.jobId, inTransit.jobId);

  // Past notAfter the probe refuses it, so it can never run. It is dropped without counting an attempt.
  const expired = envelope({ kind: "delete", pylonId: thread.pylonId }, node, Date.now() - 31_000);
  registry.savePylon({ ...pylon, submitted: expired });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["spawn"]);
  assert.equal(registry.pylon(thread.pylonId)?.attempts.count, 0);
});
