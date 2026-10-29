import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatgptTokenHandoff } from "./chatgpt-token.ts";
import { startLoop, type Ingest, type Loop } from "./loop.ts";
import { openRegistry, type PortRange, type Registry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { envelope, ingest as realIngest } from "../reconcile.ts";
import type {
  BrokenCause, CommandResult, Job, JobEnvelope, JobErrorCode, JobId, JobStatus, ListeningFact, LiveHash, NodeName, NodeObservation, PreviewRouteFact, ProbeClient, ProbeEvent, PylonCommand, PylonId, PylonObservation, RunningFacts, ServiceFact, SessionFact, SubmitReply, TailnetNodeId,
} from "../protocol.ts";
import { upgradeObservation } from "../protocol.ts";
import { chatgptTokenGrant, liveHashOf, type LiveSpec, type ProjectId } from "../project.ts";
import type { CheckpointId, ImageId } from "../images.ts";
import type { ReportedEvent } from "../events.ts";
import { until, watch } from "../test-kit.ts";

const firebat = "rj-firebat" as NodeName;
const node = firebat;
const image: ImageId = "img-000000000000";
const previewPorts: PortRange = { first: 10200, last: 10209 };

/**
 * A node as its probe presents it. Jobs run until `finish` unless `autoFinish` is set. Like the real probe, a
 * finished job is announced by a job event first and by a fresh snapshot a moment later.
 */
function fakeNode(options: { autoFinish: boolean; node?: NodeName; reportsRoutes?: boolean; heldSecrets?: readonly string[]; artifacts?: readonly ImageId[] }) {
  const node = options.node ?? firebat;
  /** The held secrets the node's probe takes. A spawn asking for another fails for good, as on a probe older than it. */
  let heldSecrets = options.heldSecrets;
  /** The held secrets the control plane has handed the probe since it started. */
  const handed = new Set<string>();
  const pylons = new Map<PylonId, PylonObservation>();
  const jobs = new Map<JobId, { env: JobEnvelope; status: JobStatus }>();
  const submitted: Job[] = [];
  /** Each pylon's LiveSpec as its last spawn applied it. */
  const lives = new Map<PylonId, LiveSpec>();
  /** The gateway's route table: a spawn routes its previews, a pause keeps them and a delete drops them. */
  const routes = new Map<number, PreviewRouteFact>();
  const streams = new Set<(event: ProbeEvent | null) => void>();
  /** The observe streams whose loop has taken every event and asks for the next, and who waits for all of them to. */
  const waiting = new Set<(event: ProbeEvent | null) => void>();
  let delivered: (() => void)[] = [];
  const checkDelivered = () => {
    if ([...streams].every((push) => waiting.has(push))) for (const resolve of delivered.splice(0)) resolve();
  };
  let reachable = true;

  /** As the probe client hands it to the loop, upgraded from what the probe sent. */
  const observation = (): NodeObservation => upgradeObservation({
    node, observedAt: new Date().toISOString(), probeBootId: "boot-1",
    capacity: { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 },
    artifacts: options.artifacts ?? [image], jobs: [...jobs.values()].map((j) => j.status), pylons: [...pylons.values()], grants: { secrets: [...handed], gitSsh: false }, previewRoutes: options.reportsRoutes === false ? null : [...routes.values()],
    ...(heldSecrets === undefined ? {} : { heldSecrets }),
  });
  const unroute = (pylonId: PylonId) => { for (const [port, route] of routes) if (route.pylonId === pylonId) routes.delete(port); };
  const emit = (event: ProbeEvent) => { for (const push of streams) push(event); };

  /** Each pylon's last completed checkpoint. */
  const saved = new Map<PylonId, CheckpointId>();
  /** Checkpoints whose disk records a failed setup, which every boot of that disk reports again, as on pylon-vm. */
  const failedSetupDisks = new Set<CheckpointId>();
  type Failure = { code: JobErrorCode; message: string; logTail: string; broken?: { detail: string; cause: BrokenCause } };

  /** Applies a job that ran, or returns how it failed. */
  function apply(job: Job): Failure | undefined {
    switch (job.kind) {
      case "spawn": {
        const missing = job.boot.network.secrets.find((grant) => !heldSecrets?.includes(grant.name));
        if (missing !== undefined) return { code: "secret-missing", message: `secret ${missing.name} is not in this node's secret file`, logTail: "" };
        if (job.boot.source.kind === "resume" && failedSetupDisks.has(job.boot.source.checkpoint)) {
          const detail = "Setup exited 128. Read controller logs";
          return { code: "setup-failed", message: `${job.pylonId}: ${detail}`, logTail: "fatal: repository not found", broken: { detail, cause: "saved-setup" } };
        }
        // Like the probe, a spawn of a running pylon applies only its LiveSpec, and every spawn publishes the previews.
        const was = pylons.get(job.pylonId);
        const previews = job.live.previews.map((p) => ({ ...p, ready: true }));
        pylons.set(job.pylonId, was?.phase === "running" ? { ...was, liveHash: job.liveHash, previews } : {
          pylonId: job.pylonId, phase: "running", liveHash: job.liveHash, bootedAt: new Date().toISOString(),
          bootedFrom: { image, checkpoint: job.boot.source.kind === "resume" ? job.boot.source.checkpoint : null },
          // A woken pylon's sessions are read only once its relaunch has run.
          services: [], listening: [], previews, sessions: job.boot.source.kind === "resume" ? null : [], git: null, declaredOutputs: [], attachedClients: 0,
        });
        lives.set(job.pylonId, job.live);
        unroute(job.pylonId);
        for (const { service, httpsPort } of job.live.previews) routes.set(httpsPort, { httpsPort, pylonId: job.pylonId, service });
        return;
      }
      case "pause": {
        // As on pylon-vm, a failed setup is never saved: a VM with no checkpoint is removed, and one with a checkpoint,
        // which it reports as saved-setup, is refused.
        const was = pylons.get(job.pylonId);
        if (was?.phase === "broken" && was.cause === "saved-setup") return { code: "setup-failed", message: `${job.pylonId}: a pause would save the failed setup onto its disk`, logTail: "" };
        if (was?.phase === "broken" && was.cause === "setup") {
          assert.equal(saved.get(job.pylonId), undefined, "pylon-vm reports a failed setup on a disk with a checkpoint as saved-setup");
          pylons.delete(job.pylonId);
          return;
        }
        saved.set(job.pylonId, job.checkpoint);
        // As the backends do, the pause records the running sessions, and the stopped pylon reports them under the same IDs.
        const sessions = was?.phase === "running" && was.sessions !== null
          ? was.sessions.map(({ id, herdrPane, harness, harnessSessionId, title }) => ({ id, herdrPane, harness, harnessSessionId, title: title ?? "untitled" }))
          : null;
        pylons.set(job.pylonId, { pylonId: job.pylonId, phase: "stopped", checkpoint: job.checkpoint, sessions });
        return;
      }
      case "delete":
        unroute(job.pylonId);
        saved.delete(job.pylonId);
        pylons.delete(job.pylonId);
        return;
      default: throw new Error(`the fake node runs no ${job.kind} jobs`);
    }
  }

  /**
   * Ends a running job, as a success that applies it, unless the node's state fails it, or as a failure that changes
   * nothing. A failure with `broken` leaves its pylon broken, as pylon-vm leaves a VM whose boot failed running with
   * its startupError.
   */
  function finish(jobId: JobId, given?: Failure) {
    const entry = jobs.get(jobId)!;
    assert.equal(entry.status.state, "running");
    const ended = { jobId, subject: entry.status.subject, kind: entry.status.kind, finishedAt: new Date().toISOString() };
    const failure = given ?? apply(entry.env.job);
    if (failure === undefined) {
      entry.status = { ...ended, state: "succeeded" };
    } else {
      const { broken, ...failed } = failure;
      const pylonId = entry.status.subject as PylonId;
      if (broken !== undefined) pylons.set(pylonId, { pylonId, phase: "broken", logTail: "", ...broken });
      entry.status = { ...ended, state: "failed", ...failed };
    }
    emit({ type: "job", status: entry.status });
    setTimeout(() => emit({ type: "snapshot", observation: observation() }), 20);
  }

  const unreachable = () => Object.assign(new Error(`${node} is unreachable`), { code: "unreachable" });

  let held: Promise<void> | null = null;
  const probe: ProbeClient = {
    node,
    async submit(env): Promise<SubmitReply> {
      if (held !== null) await held;
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
      const push = (event: ProbeEvent | null) => { queue.push(event); waiting.delete(push); notify?.(); };
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
          const next = new Promise<void>((resolve) => { notify = resolve; });
          waiting.add(push);
          checkDelivered();
          await next;
          notify = null;
        }
      } finally {
        streams.delete(push);
        waiting.delete(push);
        checkDelivered();
        signal.removeEventListener("abort", onAbort);
      }
    },
    command: () => Promise.reject(new Error("unused")),
    stream: () => Promise.reject(new Error("unused")),
    manifest: () => Promise.reject(new Error("unused")),
    health: () => Promise.reject(new Error("unused")),
    putPeers: async () => {},
    async putSecret(name) {
      if (!reachable) throw Object.assign(new Error("probe unreachable"), { code: "unreachable" });
      if (!heldSecrets?.includes(name)) throw new Error(`${name} is not a secret the control plane hands over`);
      if (handed.has(name)) return;
      handed.add(name);
      emit({ type: "snapshot", observation: observation() });
    },
  };

  /** Changes a running pylon's guest facts, and announces it with a snapshot as the probe does after a job. */
  function setFacts(pylonId: PylonId, facts: Partial<Pick<RunningFacts, "sessions" | "services" | "listening">>) {
    const pylon = pylons.get(pylonId);
    assert.ok(pylon?.phase === "running");
    pylons.set(pylonId, { ...pylon, ...facts });
    emit({ type: "snapshot", observation: observation() });
  }
  const setSessions = (pylonId: PylonId, sessions: readonly SessionFact[] | null) => setFacts(pylonId, { sessions });
  /** The VM fails on its own, as when its controller dies, and the probe reports it with a snapshot. */
  function breakPylon(pylonId: PylonId, detail: string, cause: BrokenCause = "controller") {
    pylons.set(pylonId, { pylonId, phase: "broken", detail, cause, logTail: "" });
    emit({ type: "snapshot", observation: observation() });
  }
  /** Stops the pylon on a checkpoint that holds a failed setup, as a pause by a backend older than the cause did. */
  function stopOnFailedSetup(pylonId: PylonId, checkpoint: CheckpointId) {
    saved.set(pylonId, checkpoint);
    failedSetupDisks.add(checkpoint);
    pylons.set(pylonId, { pylonId, phase: "stopped", checkpoint, sessions: null });
  }

  return {
    probe, pylons, submitted, lives, routes, finish, setSessions, breakPylon, stopOnFailedSetup, setServices: (pylonId: PylonId, services: readonly ServiceFact[] | null) => setFacts(pylonId, { services }),
    setListening: (pylonId: PylonId, listening: readonly ListeningFact[] | null) => setFacts(pylonId, { listening }),
    /** Settles once the loop has taken every event sent so far, which it ingests before it asks for the next. */
    delivered: () => new Promise<void>((resolve) => { delivered.push(resolve); checkDelivered(); }),
    /** Sends a snapshot of the node as it is, after a test changed it by hand, with the probe's journal of session reports. */
    announce: (events?: readonly ReportedEvent[]) => emit({ type: "snapshot", observation: { ...observation(), ...(events === undefined ? {} : { events }) } }),
    send: emit,
    running: () => [...jobs.values()].filter((j) => j.status.state === "running").map((j) => j.env.jobId),
    /** Holds every submit until the returned release is called, so a test can act while a pass waits on the probe. */
    holdSubmits(): () => void {
      let release!: () => void;
      held = new Promise((resolve) => { release = resolve; });
      return () => { held = null; release(); };
    },
    /** Upgrades the probe to one that takes these held secrets, and announces it with a snapshot. */
    upgrade(names: readonly string[]) { heldSecrets = names; emit({ type: "snapshot", observation: observation() }); },
    /** Restarts the probe, which forgets the held secrets it was handed, and announces it with a snapshot. */
    restartProbe() { handed.clear(); emit({ type: "snapshot", observation: observation() }); },
    /** Drops every observe link and refuses calls until `reconnect`. */
    disconnect() { reachable = false; for (const push of streams) push(null); },
    reconnect() { reachable = true; },
  };
}

/** The node write the real ingest makes for a snapshot. Nothing else matters to the loop. */
const ingest: Ingest = (event, eventNode) => event.type === "snapshot"
  ? [{ record: "node", node: eventNode, state: "online", capacity: event.observation.capacity }]
  : [];

/** Waits until the loop has ingested every event the node sent and run a pass after them. */
async function settled(fake: ReturnType<typeof fakeNode>, loop: Loop) {
  await fake.delivered();
  await loop.wake(node);
}

// One directory for the file, so each test's registry is closed before it is removed.
const dir = await mkdtemp(join(tmpdir(), "nexus-loop-"));
after(() => rm(dir, { recursive: true }));
const tempDb = () => join(dir, `${randomUUID()}.db`);

function seed(registry: Registry, activity: Partial<Pick<Thread, "agentTurnRunning" | "lastAgentActivityAt" | "lastHumanActivityAt">> = {}): Thread {
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  if (registry.project("acme" as ProjectId) === undefined) registry.createProject({
    id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
  const id = `th-${randomUUID().slice(0, 8)}` as ThreadId;
  const pylonId = `pylon-${id}` as PylonId;
  const thread: Thread = {
  seenAt: null, lastReplyAt: null,
    id, title: "t", project: "acme" as ProjectId, pylonId, status: "active", conversationId: null, startedBy: "nLAPTOP",
    createdAt: Date.now(), agentTurnRunning: false, working: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now(), ...activity,
  };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: id, pylonId, node, desired: "running",
    boot: {
      pylonId, image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
      repo: { kind: "clone", url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
      dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    },
    firstBoot: { kind: "fresh", preSetup: null },
    live: { previews: [], overlay: [] },
    liveHash: "hash-1" as LiveHash,
  });
  registry.createThread(thread, pylon);
  return thread;
}

function run(t: import("node:test").TestContext, registry: Registry, probe: ProbeClient | readonly ProbeClient[], overrides: { gitIdentity?: { name: string; email: string }; offlineAfterMs?: number; silenceMs?: number; ingest?: Ingest; previewPorts?: PortRange; log?: (line: string) => void; claudeLaunchRetryMs?: number; intervalMs?: number } = {}): Loop {
  const loop = startLoop({
    ...(overrides.claudeLaunchRetryMs === undefined ? {} : { claudeLaunchRetryMs: overrides.claudeLaunchRetryMs }),
    gitIdentity: overrides.gitIdentity,
    registry, probes: Array.isArray(probe) ? probe : [probe], ingest: overrides.ingest ?? ingest, previewPorts: overrides.previewPorts ?? previewPorts, intervalMs: overrides.intervalMs ?? 10, reconnectMs: 10,
    offlineAfterMs: overrides.offlineAfterMs ?? 30_000, silenceMs: overrides.silenceMs ?? 30_000, log: overrides.log ?? assert.fail,
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

test("each pass sends the template builds recorded for its node, before its pylons", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const key = { project: "acme" as ProjectId, image, setupHash: "s" };
  const inputs = { key, repo: { url: "git@example.com:acme.git", branch: "main", commit: "c".repeat(40) }, preSetup: null, allowedHosts: [], resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } };
  registry.saveTemplate({ id: "tpl-aaaaaaaaaaaa", key, state: "building", on: node, inputs, submitted: null });
  const fake = fakeNode({ autoFinish: false });
  run(t, registry, fake.probe);
  await until("the pylon's spawn is sent", () => fake.submitted.some((job) => job.kind === "spawn"));
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["build-template", "spawn"]);
  assert.deepEqual(fake.submitted[0], { kind: "build-template", template: "tpl-aaaaaaaaaaaa", inputs });
  assert.equal(registry.pylon(thread.pylonId)!.submitted?.job.kind, "spawn");
});

test("a job that fails for good gives up with the probe's message and the end of its log", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const logged: string[] = [];
  run(t, registry, fake.probe, { log: (line) => logged.push(line) });
  await until("the spawn runs", () => fake.running().length === 1);

  const setupLines = Array.from({ length: 80 }, (_, i) => `setup line ${i}`);
  const fatal = "fatal: unable to access 'https://github.com/octocat/Spoon-Knife.git/': The requested URL returned error: 403";
  fake.finish(fake.running()[0]!, { code: "setup-failed", message: `  ${thread.pylonId}: Setup exited 128. Read controller logs\n`, logTail: `${[...setupLines, fatal].join("\n")}\n\n` });
  await until("the planner gives up", () => registry.pylon(thread.pylonId)?.failed !== null);

  const failed = registry.pylon(thread.pylonId)!.failed;
  assert.equal(failed, [
    `last job failed with setup-failed, which is not retryable: ${thread.pylonId}: Setup exited 128. Read controller logs`,
    ...setupLines.slice(-59), fatal,
  ].join("\n"));
  assert.deepEqual(logged, [`${thread.pylonId}: the planner gave up: ${failed}`]);
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["spawn"], "a setup failure is not retried");
});

const kinds = (jobs: readonly Job[]) => jobs.map((job) => job.kind === "spawn" ? `spawn ${job.boot.source.kind}` : job.kind);
/** As pylon-vm fails a fresh boot's setup: the instance, which holds no work, is removed. */
const setupFailed = (pylonId: PylonId, run: number) => ({ code: "setup-failed" as const, message: `${pylonId}: Setup exited 128 (run ${run})`, logTail: "fatal: repository not found" });
/** As pylon-vm fails a resume whose service did not start: the VM stays, broken. */
const serviceFailed = (pylonId: PylonId) => ({
  code: "setup-failed" as const, message: `${pylonId}: Service web was not ready within 30 s`, logTail: "", broken: { detail: "Service web was not ready within 30 s", cause: "services" as const },
});

/** Pauses a running pylon of an archived thread, as the planner does, and folds the pause in. */
async function archive(registry: Registry, fake: ReturnType<typeof fakeNode>, loop: Loop, thread: Thread) {
  registry.setThreadStatus(thread.id, "archived");
  void loop.wake(node);
  await until("the pause runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1);
}

test("a wake for reading that fails after the backfill let go of its pylon fails nothing, and the thread's next wake boots at once", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const logged: string[] = [];
  const loop = run(t, registry, fake.probe, { log: (line) => logged.push(line) });
  await until("the spawn runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await archive(registry, fake, loop, thread);

  registry.startUsageBackfill([thread.id], Date.now());
  registry.holdUsageBackfill(thread.id, Date.now());
  void loop.wake(node);
  await until("the wake for reading runs", () => fake.running().length === 1);
  const wake = fake.submitted.at(-1)!;
  assert.ok(wake.kind === "spawn" && wake.relaunch === false);
  registry.stopUsageBackfill(Date.now());
  fake.finish(fake.running()[0]!, setupFailed(thread.pylonId, 1));
  await until("the failure is folded in", () => registry.pylon(thread.pylonId)!.attempts.readFailure !== undefined);
  await settled(fake, loop);
  const read = registry.pylon(thread.pylonId)!;
  assert.equal(read.failed, null, "a failure the backfill no longer waits on fails nothing");
  assert.deepEqual([read.attempts.count, read.attempts.last, read.attempts.readFailure?.code], [0, null, "setup-failed"], "the failed wake for reading is kept apart from the wake's tries");
  assert.deepEqual(logged, []);

  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  void loop.wake(node);
  await until("the thread's wake runs", () => fake.running().length === 1);
  const next = fake.submitted.at(-1)!;
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh", "pause", "spawn resume", "spawn resume"]);
  assert.ok(next.kind === "spawn" && next.relaunch === undefined, "the wake brings the sessions back");
  fake.finish(fake.running()[0]!, setupFailed(thread.pylonId, 1));
  await until("the wake's failure is folded in", () => registry.pylon(thread.pylonId)!.attempts.last !== null);
  assert.equal(registry.pylon(thread.pylonId)!.attempts.count, 1, "the failed wake for reading is not one of the wake's tries");
});

test("a record from before failed wakes for reading were kept apart, whose last failure is one, plans the thread's next wake at once", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const loop = run(t, registry, fake.probe);
  await until("the spawn runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await archive(registry, fake, loop, thread);
  const failure = { at: Date.now(), code: "setup-failed" as const, message: "the disk is full" };
  registry.savePylon({ ...registry.pylon(thread.pylonId)!, attempts: { count: 1, last: { ...failure, reading: true } as typeof failure } });

  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  void loop.wake(node);
  await until("the thread's wake runs", () => fake.running().length === 1);
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh", "pause", "spawn resume"], "a setup-failed wake for reading neither fails the pylon nor holds its wake");
  assert.deepEqual(registry.pylon(thread.pylonId)!.attempts, { count: 0, last: null, readFailure: failure });
});

test("a wake for reading the planner gives up on, as for an image no online node holds, is an attempt the backfill skips, never a failed pylon", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const logged: string[] = [];
  const loop = run(t, registry, fake.probe, { log: (line) => logged.push(line) });
  await until("the spawn runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await archive(registry, fake, loop, thread);
  const pylon = registry.pylon(thread.pylonId)!;
  registry.savePylon({ ...pylon, boot: { ...pylon.boot, image: "img-111111111111" } });

  registry.startUsageBackfill([thread.id], Date.now());
  registry.holdUsageBackfill(thread.id, Date.now());
  await until("the planner gives up", () => registry.pylon(thread.pylonId)!.attempts.readFailure !== undefined || registry.pylon(thread.pylonId)!.failed !== null);
  await settled(fake, loop);
  const read = registry.pylon(thread.pylonId)!;
  assert.deepEqual([read.failed, read.attempts.count, read.attempts.last, read.attempts.readFailure?.code, read.attempts.readFailure?.message], [null, 0, null, "artifact-missing", "no online node holds img-111111111111"]);
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh", "pause"]);
  assert.deepEqual(logged, []);

  registry.stopUsageBackfill(Date.now());
  await settled(fake, loop);
  assert.equal(registry.pylon(thread.pylonId)!.failed, null, "the paused pylon needs no image");
});

test("a fetch of its image for a wake for reading that fails after the backfill let go of the pylon fails nothing, and the thread's next wake has every try", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const testbench = "infra-testbench" as NodeName;
  const other: ImageId = "img-111111111111";
  registry.upsertNode({ name: testbench, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nTESTBENCH" as TailnetNodeId });
  registry.saveImage({ id: other, gondolinBuildId: "b2", builtOn: testbench, builtAt: "2026-10-27T00:00:00Z", sha256: "b".repeat(64), pins: {} } as never, null);
  const fake = fakeNode({ autoFinish: false });
  const peer = fakeNode({ autoFinish: false, node: testbench, artifacts: [image, other] });
  const logged: string[] = [];
  const loop = run(t, registry, [fake.probe, peer.probe], { log: (line) => logged.push(line) });
  await until("the spawn runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await archive(registry, fake, loop, thread);
  const pylon = registry.pylon(thread.pylonId)!;
  registry.savePylon({ ...pylon, boot: { ...pylon.boot, image: other } });

  registry.startUsageBackfill([thread.id], Date.now());
  registry.holdUsageBackfill(thread.id, Date.now());
  void loop.wake(node);
  await until("the fetch for reading runs", () => fake.running().length === 1);
  assert.equal(fake.submitted.at(-1)!.kind, "fetch-artifact");
  registry.stopUsageBackfill(Date.now());
  fake.finish(fake.running()[0]!, { code: "invalid", message: `${testbench} refuses the copy`, logTail: "" });
  await until("the failure is folded in", () => registry.pylon(thread.pylonId)!.attempts.readFailure !== undefined);
  await settled(fake, loop);
  const read = registry.pylon(thread.pylonId)!;
  assert.deepEqual([read.failed, read.attempts.count, read.attempts.last, read.attempts.readFailure?.code], [null, 0, null, "invalid"], "a failure the backfill no longer waits on fails nothing");
  assert.deepEqual(logged, []);

  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  void loop.wake(node);
  await until("the thread's wake fetches its image", () => fake.running().length === 1);
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh", "pause", "fetch-artifact", "fetch-artifact"]);
  fake.finish(fake.running()[0]!, { code: "backend", message: "the copy was cut short", logTail: "" });
  await until("the wake's failure is folded in", () => registry.pylon(thread.pylonId)!.attempts.last !== null);
  assert.equal(registry.pylon(thread.pylonId)!.attempts.count, 1, "the failed fetch for reading is not one of the wake's tries");
});

test("a human retry of a pylon whose fresh setup failed spawns it fresh again, and the new setup's failure is the verdict", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const loop = run(t, registry, fake.probe, { log: () => {} });
  await until("the spawn runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!, setupFailed(thread.pylonId, 1));
  await until("the planner gives up", () => registry.pylon(thread.pylonId)?.failed !== null);
  assert.equal(fake.pylons.has(thread.pylonId), false, "the node removed the instance, as pylon-vm does");

  assert.equal(registry.retryPylon(thread.pylonId), true);
  assert.equal(registry.pylon(thread.pylonId)!.retrying, true);
  void loop.wake(node);
  await until("a fresh spawn runs", () => fake.running().length === 1 && fake.submitted.length === 2);
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh", "spawn fresh"], "the new instance runs setup again");
  fake.finish(fake.running()[0]!, setupFailed(thread.pylonId, 2));
  await until("the planner gives up again", () => registry.pylon(thread.pylonId)?.failed !== null);
  const again = registry.pylon(thread.pylonId)!;
  assert.match(again.failed!, /^last job failed with setup-failed, which is not retryable: .*\(run 2\)/);
  assert.equal(again.attempts.count, 1);
  assert.equal(again.retrying, false);
});

test("a retry and a wake boot the size the thread started with, though its project's size changed since", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const sized = { cpus: 4, memoryGiB: 12, diskGiB: 40 };
  const seeded = registry.pylon(thread.pylonId)!;
  // As threadStarter freezes a start's --memory 12 --cpus 4 --disk 40 into the pylon's boot.
  registry.savePylon({ ...seeded, boot: { ...seeded.boot, resources: sized } });
  const fake = fakeNode({ autoFinish: false });
  const loop = run(t, registry, fake.probe, { log: () => {} });
  await until("the spawn runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!, setupFailed(thread.pylonId, 1));
  await until("the planner gives up", () => registry.pylon(thread.pylonId)?.failed !== null);

  registry.updateProject({ ...registry.project(thread.project)!, resources: { cpus: 8, memoryGiB: 16, diskGiB: 80 } });
  assert.equal(registry.retryPylon(thread.pylonId), true);
  void loop.wake(node);
  await until("the retry's spawn runs", () => fake.running().length === 1 && fake.submitted.length === 2);
  fake.finish(fake.running()[0]!);
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  registry.setThreadStatus(thread.id, "archived");
  await until("the pause runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1);
  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  await until("the wake runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await until("the pylon runs again", () => fake.pylons.get(thread.pylonId)?.phase === "running");

  assert.deepEqual(kinds(fake.submitted), ["spawn fresh", "spawn fresh", "pause", "spawn resume"]);
  assert.deepEqual(fake.submitted.flatMap((job) => job.kind === "spawn" ? [job.boot.resources] : []), [sized, sized, sized]);
});

test("a human retry of a pylon broken after a resume pauses it onto its newest disk and resumes that", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const loop = run(t, registry, fake.probe, { log: () => {} });
  const next = async (what: string) => {
    await until(what, () => fake.running().length === 1);
    return fake.running()[0]!;
  };
  fake.finish(await next("the first spawn runs"));
  registry.setThreadStatus(thread.id, "archived");
  fake.finish(await next("the pause runs"));
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1);
  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  fake.finish(await next("the resume runs"), serviceFailed(thread.pylonId));
  await until("the planner gives up", () => registry.pylon(thread.pylonId)?.failed !== null);

  assert.equal(registry.retryPylon(thread.pylonId), true);
  void loop.wake(node);
  fake.finish(await next("the retry's pause runs"));
  fake.finish(await next("the resume after it runs"));
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh", "pause", "spawn resume", "pause", "spawn resume"], "the disk is never deleted");
  const resumed = fake.submitted.at(-1)!;
  assert.ok(resumed.kind === "spawn" && resumed.boot.source.kind === "resume");
  assert.equal(resumed.boot.source.checkpoint, `ckpt-${thread.id}-2`);
  assert.deepEqual(registry.pylon(thread.pylonId)!.failed, null);
});

test("a broken pylon nobody retried is never replaced, even after an earlier retry", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const loop = run(t, registry, fake.probe, { log: () => {} });
  await until("the spawn runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!, setupFailed(thread.pylonId, 1));
  await until("the planner gives up", () => registry.pylon(thread.pylonId)?.failed !== null);
  registry.retryPylon(thread.pylonId);
  void loop.wake(node);
  await until("the fresh spawn runs", () => fake.running().length === 1 && fake.submitted.length === 2);
  fake.finish(fake.running()[0]!);
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  await until("the spawn's success uses up the retry", () => registry.pylon(thread.pylonId)?.retrying === false);

  fake.breakPylon(thread.pylonId, "the controller exited without completing a stop");
  await until("the planner gives up", () => registry.pylon(thread.pylonId)?.failed !== null);
  assert.equal(registry.pylon(thread.pylonId)!.failed, "pylon is broken: the controller exited without completing a stop");
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh", "spawn fresh"]);
});

test("a retry never deletes a pylon whose checkpoint the registry did not count", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const loop = run(t, registry, fake.probe, { log: () => {} });
  const next = async (what: string) => {
    await until(what, () => fake.running().length === 1);
    return fake.running()[0]!;
  };
  fake.finish(await next("the first spawn runs"));
  registry.setThreadStatus(thread.id, "archived");
  fake.finish(await next("the pause runs"));
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1);
  // A probe restart that lost the pause's result: settle drops an unknown envelope without counting the pause.
  registry.savePylon({ ...registry.pylon(thread.pylonId)!, pauses: 0 });
  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  fake.finish(await next("the resume of the checkpoint runs"), serviceFailed(thread.pylonId));
  await until("the planner gives up", () => registry.pylon(thread.pylonId)?.failed !== null);

  registry.retryPylon(thread.pylonId);
  void loop.wake(node);
  fake.finish(await next("the retry's pause runs"));
  fake.finish(await next("the resume after it runs"));
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh", "pause", "spawn resume", "pause", "spawn resume"], "nothing deletes the disk with the user's work");
});

test("a retry of a pylon left broken by a fresh setup, as an older backend left it, removes it with a pause and spawns it fresh", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  // The older backend kept the VM whose first boot's setup failed, so the planner gave up on the broken pylon.
  fake.breakPylon(thread.pylonId, "Setup exited 128. Read controller logs", "setup");
  const loop = run(t, registry, fake.probe, { log: () => {} });
  await until("the planner gives up", () => registry.pylon(thread.pylonId)?.failed !== null);
  assert.equal(registry.pylon(thread.pylonId)!.failed, "pylon is broken: Setup exited 128. Read controller logs");

  assert.equal(registry.retryPylon(thread.pylonId), true);
  void loop.wake(node);
  await until("the retry's pause runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await until("a fresh spawn runs", () => fake.running().length === 1 && fake.submitted.length === 2);
  assert.equal(fake.pylons.has(thread.pylonId), false, "the pause removed the VM, whose disk had no checkpoint");
  fake.finish(fake.running()[0]!, setupFailed(thread.pylonId, 2));
  await until("the planner gives up again", () => registry.pylon(thread.pylonId)?.failed !== null);
  assert.deepEqual(kinds(fake.submitted), ["pause", "spawn fresh"], "the new instance runs setup again");
  assert.match(registry.pylon(thread.pylonId)!.failed!, /^last job failed with setup-failed, which is not retryable: .*\(run 2\)/);
});

test("an idle pylon whose fresh setup failed is removed by its pause, so its wake runs setup again", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setThreadStatus(thread.id, "archived");
  const fake = fakeNode({ autoFinish: false });
  // A probe that died between the setup failure and the instance's removal, so the planner sees only the broken pylon.
  fake.breakPylon(thread.pylonId, "Setup exited 128. Read controller logs", "setup");
  run(t, registry, fake.probe, { log: () => {} });
  await until("the idle broken pylon's pause runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1);
  assert.equal(fake.pylons.has(thread.pylonId), false, "no checkpoint holds the failed setup");
  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  await until("the wake spawns", () => fake.submitted.length === 2);
  assert.deepEqual(kinds(fake.submitted), ["pause", "spawn fresh"]);
});

test("a retry of a pylon whose checkpoint holds a failed setup boots nothing again, and says to start again", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  fake.stopOnFailedSetup(thread.pylonId, `ckpt-${thread.id}-1`);
  const loop = run(t, registry, fake.probe, { log: () => {} });
  await until("the resume runs", () => fake.running().length === 1);
  fake.finish(fake.running()[0]!);
  await until("the planner gives up", () => registry.pylon(thread.pylonId)?.failed !== null);
  assert.match(registry.pylon(thread.pylonId)!.failed!, /^last job failed with setup-failed/);
  assert.deepEqual(fake.pylons.get(thread.pylonId), { pylonId: thread.pylonId, phase: "broken", logTail: "", detail: "Setup exited 128. Read controller logs", cause: "saved-setup" }, "the checkpoint replays its failed setup");

  registry.retryPylon(thread.pylonId);
  void loop.wake(node);
  await until("the planner gives up again", () => registry.pylon(thread.pylonId)?.failed !== null);
  assert.equal(registry.pylon(thread.pylonId)!.failed, "pylon is broken: Setup exited 128. Read controller logs. Its disk holds the failed setup, and every boot of that disk fails the same way, so a retry cannot help. Start again from the project");
  assert.deepEqual(kinds(fake.submitted), ["spawn resume"], "no pause and resume of the poisoned disk");
});

test("a retry made while a pass waits on the probe for another pylon is not undone by that pass", async (t) => {
  const registry = openRegistry(tempDb());
  const [first, second] = [seed(registry), seed(registry)].sort((a, b) => a.pylonId.localeCompare(b.pylonId));
  // The pass ticks the first pylon, whose spawn waits on the probe, before it reaches the failed second one.
  registry.savePylon({ ...registry.pylon(second!.pylonId)!, failed: "gave up after 5 failed attempts", attempts: { count: 5, last: { at: 1, code: "backend", message: "boot failed" } } });
  const fake = fakeNode({ autoFinish: false });
  const release = fake.holdSubmits();
  run(t, registry, fake.probe, { log: () => {} });
  await until("the first pylon's tick waits on its submit", () => registry.pylon(first!.pylonId)?.submitted !== null);

  assert.equal(registry.retryPylon(second!.pylonId), true);
  // A preview changes the second pylon's LiveSpec, so its tick saves the record before planning.
  registry.allocatePreviews(second!.pylonId, ["web"], previewPorts);
  release();
  await until("the second pylon spawns", () => fake.submitted.some((job) => job.kind === "spawn" && job.pylonId === second!.pylonId));
  const retried = registry.pylon(second!.pylonId)!;
  assert.equal(retried.failed, null);
  assert.equal(retried.live.previews.length, 1);
});

test("a pylon moved to another node while a pass waits on the probe for another pylon gets no job from its old node", async (t) => {
  const registry = openRegistry(tempDb());
  const [first, second] = [seed(registry), seed(registry)].sort((a, b) => a.pylonId.localeCompare(b.pylonId));
  registry.savePylon({ ...registry.pylon(second!.pylonId)!, failed: "gave up after 5 failed attempts", attempts: { count: 5, last: { at: 1, code: "backend", message: "boot failed" } } });
  const other = "infra-testbench" as NodeName;
  registry.upsertNode({ name: other, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nTESTBENCH" as TailnetNodeId });
  const fake = fakeNode({ autoFinish: false });
  const release = fake.holdSubmits();
  const loop = run(t, registry, fake.probe, { log: () => {} });
  await until("the first pylon's tick waits on its submit", () => registry.pylon(first!.pylonId)?.submitted !== null);

  const stored = registry.pylon(second!.pylonId)!;
  assert.equal(registry.movePylon(second!.pylonId, node, { node: other, firstBoot: stored.firstBoot, live: stored.live, liveHash: stored.liveHash, placement: { how: "named", node: other }, setup: { how: "fresh", reason: "moved" } }), true);
  release();
  await loop.wake(node);
  assert.deepEqual(fake.submitted.filter((job) => "pylonId" in job && job.pylonId === second!.pylonId), [], "the old node's pass left the moved pylon alone");
  assert.equal(registry.pylon(second!.pylonId)!.node, other);
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

  registry.apply({ record: "node", node, state: "online", capacity: { cpus: 16, committedCpus: 0, memoryGiB: 1, committedMemoryGiB: 0, diskFreeGiB: 1, committedDiskGiB: 0 } });
  await until("the node is recorded offline", () => registry.node(node)?.state === "offline");
  assert.equal(fake.submitted.length, 0);

  fake.reconnect();
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.equal(registry.node(node)?.state, "online");
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["spawn"]);
});

test("with the real ingest, a pylon's sessions reach the registry and a working one keeps the pylon up", async (t) => {
  const registry = openRegistry(tempDb());
  const longAgo = Date.now() - 60 * 60_000;
  const thread = seed(registry, { agentTurnRunning: true, lastAgentActivityAt: longAgo, lastHumanActivityAt: longAgo });
  const fake = fakeNode({ autoFinish: true });
  const loop = run(t, registry, fake.probe, { ingest: realIngest });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");

  const working: SessionFact = { id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", status: "working", title: "plan" };
  fake.setSessions(thread.pylonId, [working]);
  await until("the session is recorded", () => registry.sessions(thread.pylonId).length === 1);
  assert.deepEqual(registry.sessions(thread.pylonId), [{ pylon: thread.pylonId, ...working, message: null }]);
  assert.ok(registry.thread(thread.id)!.lastAgentActivityAt > longAgo);

  // The turn ends, but the working session counts as agent activity, so the pylon stays up.
  registry.recordActivity(thread.id, { agentTurnRunning: false });
  await settled(fake, loop);
  assert.equal(fake.pylons.get(thread.pylonId)?.phase, "running");

  // Sessions the probe could not read leave the registry as it was, and the next read is diffed against the last one.
  fake.setSessions(thread.pylonId, null);
  await settled(fake, loop);
  assert.deepEqual(registry.sessions(thread.pylonId), [{ pylon: thread.pylonId, ...working, message: null }]);

  fake.setSessions(thread.pylonId, []);
  await until("the closed session is removed", () => registry.sessions(thread.pylonId).length === 0);
  assert.deepEqual(registry.orphans(), []);
});

test("with the real ingest, a paused pylon lists its sessions as paused, and once it runs again they run, with the status each read gives", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  run(t, registry, fake.probe, { ingest: realIngest });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  const review: SessionFact = { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", status: "working", title: "review" };
  fake.setSessions(thread.pylonId, [review]);
  await until("the session is recorded", () => registry.sessions(thread.pylonId).length === 1);

  registry.setThreadStatus(thread.id, "archived");
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1 && registry.sessions(thread.pylonId)[0]?.state === "paused");
  assert.deepEqual(registry.sessions(thread.pylonId), [{ pylon: thread.pylonId, ...review, state: "paused", message: null }], "it keeps its pane and its last status");

  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  await until("the pylon runs again", () => registry.node(node)!.observation?.pylons.find((p) => p.pylonId === thread.pylonId)?.phase === "running");
  // Its sessions are not read yet, so the stored observation knows none, and the session runs in its pane, its status unknown.
  const stored = registry.node(node)!.observation!.pylons.find((p) => p.pylonId === thread.pylonId);
  assert.ok(stored?.phase === "running" && stored.sessions === null);
  assert.deepEqual(registry.sessions(thread.pylonId), [{ pylon: thread.pylonId, ...review, status: "unknown", message: null }]);

  const moved: SessionFact = { ...review, id: "w3:p1", herdrPane: "w3:p1", status: "working" };
  fake.setSessions(thread.pylonId, [moved]);
  await until("the relaunched session replaces the resumed one", () => registry.sessions(thread.pylonId)[0]?.id === "w3:p1");
  assert.deepEqual(registry.sessions(thread.pylonId), [{ pylon: thread.pylonId, ...moved, message: null }]);
  fake.setSessions(thread.pylonId, [{ ...moved, status: "idle" }]);
  await until("its turn ends", () => registry.sessions(thread.pylonId)[0]?.status === "idle");
  assert.equal(registry.sessions(thread.pylonId)[0]?.state, "running");
});

test("a restarted control plane writes each pylon's session list on its first observation, though the stored one has the same list", async (t) => {
  const path = tempDb();
  const fake = fakeNode({ autoFinish: true });
  const before = openRegistry(path);
  const thread = seed(before);
  const first = startLoop({ registry: before, probes: [fake.probe], ingest: realIngest, previewPorts, intervalMs: 10, reconnectMs: 10, log: assert.fail });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  const review: SessionFact = { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", status: "idle", title: "review" };
  fake.setSessions(thread.pylonId, [review]);
  await until("the session is recorded", () => before.sessions(thread.pylonId).length === 1);
  before.setThreadStatus(thread.id, "archived");
  await until("the pause is folded in", () => before.pylon(thread.pylonId)?.pauses === 1 && before.sessions(thread.pylonId)[0]?.state === "paused");
  await first.close();
  // As a control plane from before paused sessions left it: the observation with the paused list, and no rows.
  before.ingested(before.node(node)!.observation!, [{ record: "sessions", pylonId: thread.pylonId, sessions: [] }]);
  before.close();

  const after = openRegistry(path);
  run(t, after, fake.probe, { ingest: realIngest });
  await until("the paused list is written again", () => after.sessions(thread.pylonId).length === 1);
  assert.deepEqual(after.sessions(thread.pylonId).map((s) => [s.id, s.state]), [["w1:p1", "paused"]]);
});

test("with the real ingest, sessions the probe could not read record no agent activity", async (t) => {
  const registry = openRegistry(tempDb());
  const longAgo = Date.now() - 60 * 60_000;
  const thread = seed(registry, { agentTurnRunning: true, lastAgentActivityAt: longAgo, lastHumanActivityAt: longAgo });
  const fake = fakeNode({ autoFinish: true });
  const loop = run(t, registry, fake.probe, { ingest: realIngest });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");

  const working: SessionFact = { id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", status: "working" };
  fake.setSessions(thread.pylonId, [working]);
  await until("the working session counts as agent activity", () => registry.thread(thread.id)!.lastAgentActivityAt > longAgo);
  const seen = registry.thread(thread.id)!.lastAgentActivityAt;

  // The stored observation still lists the working session, but only a fresh read of it is activity.
  for (let i = 0; i < 2; i++) {
    fake.setSessions(thread.pylonId, null);
    await settled(fake, loop);
    assert.equal(registry.thread(thread.id)!.lastAgentActivityAt, seen);
  }
  fake.setSessions(thread.pylonId, [working]);
  await until("a fresh read is activity again", () => registry.thread(thread.id)!.lastAgentActivityAt > seen);
});

test("services the probe could not read change nothing: the next diff sees the last list read", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  const servicesOf = (o: PylonObservation | "absent" | undefined) => o !== undefined && o !== "absent" && o.phase === "running" ? o.services : undefined;
  /** Per snapshot, the services read, and those of the last observation it is diffed against. */
  const seen: { read: readonly ServiceFact[] | null | undefined; before: readonly ServiceFact[] | null | undefined }[] = [];
  run(t, registry, fake.probe, {
    ingest: (event, eventNode, known, now, unlisted) => {
      if (event.type === "snapshot") {
        seen.push({ read: servicesOf(event.observation.pylons.find((p) => p.pylonId === thread.pylonId)), before: servicesOf(known.get(thread.pylonId)) });
      }
      return ingest(event, eventNode, known, now, unlisted);
    },
  });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  const web: ServiceFact = { name: "web", state: "ready", port: 8000, declared: true, wantsPreview: true };
  for (const services of [[web], null, null, [web]]) fake.setServices(thread.pylonId, services);
  // The spawn that publishes web's preview sends its own snapshot, which can land after these four.
  const sent = JSON.stringify([[web], null, null, [web]]);
  const at = () => seen.findIndex((_, i) => JSON.stringify(seen.slice(i, i + 4).map((s) => s.read)) === sent);
  await until("the four reads are ingested", () => at() !== -1);
  assert.deepEqual(seen.slice(at() + 1, at() + 4).map((s) => s.before), [[web], [web], [web]], "a null read is diffed as the list read before it, never as none");
});

test("listening ports the probe could not read are stored as unknown, not as the ports read before", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  run(t, registry, fake.probe);
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  const stored = () => {
    const pylon = registry.node(node)!.observation?.pylons.find((p) => p.pylonId === thread.pylonId);
    return pylon?.phase === "running" ? pylon.listening : undefined;
  };
  fake.setListening(thread.pylonId, [{ port: 3000 }]);
  await until("port 3000 is stored", () => JSON.stringify(stored()) === JSON.stringify([{ port: 3000 }]));
  fake.setListening(thread.pylonId, null);
  await until("the unread ports are stored as unknown", () => stored() === null);
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
    ingest: (event, eventNode, known, now, unlisted) => {
      if (event.type === "snapshot") {
        assert.deepEqual([...known.keys()], [thread.pylonId]);
        previous.push([...known.values()].map((o) => o === "absent" ? "absent" : o.phase));
      }
      return ingest(event, eventNode, known, now, unlisted);
    },
  });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  registry.setThreadStatus(thread.id, "archived");
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1);
  await until("the snapshot after the pause is ingested", () => previous.length === 3);
  // On connect nothing was observed yet, after the spawn the last observation had no pylon, and after the pause it ran.
  assert.deepEqual(previous, [["absent"], ["absent"], ["running"]]);
});

test("a snapshot's journal applies each report past the node's receipt in order, and the reports before it change nothing", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const loop = run(t, registry, fake.probe, { ingest: realIngest });
  const at = Date.now();
  const report = (sequence: number, kind: ReportedEvent["event"]["kind"], session: string, offset: number): ReportedEvent =>
    ({ sequence, pylon: thread.pylonId, time: at + offset, event: { kind, session, at: at + offset } });
  const started = report(1, "session.turn-started", "s1", 0);
  fake.send({ type: "session-event", report: started });
  await settled(fake, loop);
  assert.equal(registry.thread(thread.id)!.working, true);

  const ended = report(2, "session.turn-ended", "s1", 1);
  const waiting = report(3, "session.waiting", "s2", 2);
  fake.announce([started, ended, waiting]);
  await settled(fake, loop);
  const after = registry.thread(thread.id)!;
  assert.equal(after.working, false);
  assert.equal(after.sessionWaiting, true);

  // The next snapshot replays all three, and a live report that came after them still applies.
  fake.announce([started, ended, waiting]);
  fake.send({ type: "session-event", report: report(4, "session.turn-ended", "s2", 3) });
  await settled(fake, loop);
  const last = registry.thread(thread.id)!;
  assert.equal(last.working, false);
  assert.equal(last.sessionWaiting, undefined);
});

test("session, job and preview-hit events apply their writes and leave the stored observation as the last snapshot stored it", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const loop = run(t, registry, fake.probe, { ingest: realIngest });
  await until("the spawn's job event is ingested", () => registry.job(thread.pylonId)?.state === "running");
  await settled(fake, loop);
  const stored = registry.node(node)!.observation;
  assert.deepEqual(stored?.jobs, [], "the job event came after the snapshot");

  const hit = Date.now() + 1000;
  fake.send({ type: "preview-hit", pylonId: thread.pylonId, service: "web", at: new Date(hit).toISOString(), login: null });
  fake.send({ type: "session-event", report: { sequence: 1, pylon: thread.pylonId, time: hit, event: { kind: "session.turn-started", session: "s1", at: hit } } });
  await settled(fake, loop);
  assert.equal(registry.thread(thread.id)!.lastHumanActivityAt, hit);
  assert.equal(registry.thread(thread.id)!.working, true);
  assert.deepEqual(registry.node(node)!.observation, stored);
});

test("a job in flight survives a control-plane restart: the new process asks the probe and sends nothing twice", async (t) => {
  const path = tempDb();
  const fake = fakeNode({ autoFinish: false });

  const before = openRegistry(path);
  const thread = seed(before);
  const first = startLoop({ registry: before, probes: [fake.probe], ingest, previewPorts, intervalMs: 10, reconnectMs: 10, log: assert.fail });
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

/**
 * A loop over rj-firebat and infra-testbench whose only timer never fires within a test. rj-firebat holds a pylon whose
 * envelope may still be on its way to the probe, so each of its passes asks the probe about that job once. Once `hold`
 * is called, each lookup waits for the test to release it.
 */
async function heldLoop(t: import("node:test").TestContext) {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.savePylon({ ...registry.pylon(thread.pylonId)!, submitted: envelope({ kind: "delete", pylonId: thread.pylonId }, node, Date.now()) });
  const testbench = "infra-testbench" as NodeName;
  registry.upsertNode({ name: testbench, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nTESTBENCH" as TailnetNodeId });
  const fake = fakeNode({ autoFinish: false });
  const other = fakeNode({ autoFinish: false, node: testbench });
  const lookups: { began: PromiseWithResolvers<void>; released: PromiseWithResolvers<void> }[] = [];
  const nth = (i: number) => lookups[i] ??= { began: Promise.withResolvers(), released: Promise.withResolvers() };
  let count = 0;
  let holding = false;
  const probe: ProbeClient = {
    ...fake.probe,
    async job(jobId) {
      const lookup = nth(count++);
      lookup.began.resolve();
      if (holding) await lookup.released.promise;
      return fake.probe.job(jobId);
    },
  };
  const loop = run(t, registry, [probe, other.probe], { intervalMs: 600_000 });
  await other.delivered();
  await settled(fake, loop);
  assert.equal(registry.node(node)?.state, "online");
  count = 0;
  lookups.length = 0;
  return {
    loop, testbench,
    get passes() { return count; },
    hold() { holding = true; },
    began: (i: number) => nth(i).began.promise,
    release: (i: number) => nth(i).released.resolve(),
    free() { holding = false; for (const lookup of lookups) lookup.released.resolve(); },
  };
}

test("wakes of a node during its pass give exactly one more pass after it, and resolve once that pass has finished", async (t) => {
  const h = await heldLoop(t);
  h.hold();
  const first = h.loop.wake(node);
  await h.began(0);
  const second = watch(h.loop.wake(node));
  void h.loop.wake(node);
  void h.loop.wake(node);
  h.release(0);
  await Promise.race([h.began(1), first]);
  assert.equal(h.passes, 2, "another pass began after the one the wakes came during");
  assert.equal(await second(), false, "a wake waits for the pass that began after it");
  h.free();
  await first;
  assert.equal(await second(), true);
  assert.equal(h.passes, 2, "three wakes during one pass gave one more pass");
});

test("a wake of one node does not wait for another node's pass, and a wake of an unknown node resolves at once", async (t) => {
  const h = await heldLoop(t);
  h.hold();
  const first = h.loop.wake(node);
  await h.began(0);
  assert.equal(await watch(h.loop.wake(h.testbench))(), true, "infra-testbench's pass ran while rj-firebat's waits");
  assert.equal(await watch(h.loop.wake("rj-nuc" as NodeName))(), true);
  assert.equal(h.passes, 1, "neither wake ran a pass of rj-firebat");
  h.free();
  await first;
});

test("a wake after close resolves at once and runs no pass", async (t) => {
  const h = await heldLoop(t);
  await h.loop.close();
  await h.loop.wake(node);
  assert.equal(h.passes, 0);
});

test("close waits for the pass in flight, and a wake asked for during that pass runs no other", async (t) => {
  const h = await heldLoop(t);
  h.hold();
  const first = h.loop.wake(node);
  await h.began(0);
  void h.loop.wake(node);
  const closed = watch(h.loop.close());
  assert.equal(await closed(), false);
  h.free();
  await first;
  assert.equal(await closed(), true);
  assert.equal(h.passes, 1);
});

const web: ServiceFact = { name: "web", state: "ready", port: 8000, declared: true, wantsPreview: true };
const overlayFile = (live: LiveSpec | undefined, path: string) => live?.overlay.find((f) => f.path === path)?.content ?? "";
const previewsIn = (live: LiveSpec | undefined) => JSON.parse(overlayFile(live, "/home/user/.nexus/pylon.json")).previews;

test("a service that wants a preview gets a port, and the next spawn publishes it with an overlay that names its URL", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  run(t, registry, fake.probe, { ingest: realIngest });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.deepEqual(previewsIn(fake.lives.get(thread.pylonId)), [], "the first spawn already carries the overlay");

  const worker: ServiceFact = { name: "worker", state: "ready", port: 9000, declared: true, wantsPreview: false };
  fake.setServices(thread.pylonId, [web, worker]);
  await until("the preview is ready", () => registry.previews(thread.pylonId).some((p) => p.ready));

  assert.deepEqual(registry.previews(thread.pylonId), [{ pylon: thread.pylonId, service: "web", httpsPort: 10200, ready: true, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" }]);
  const live = fake.lives.get(thread.pylonId);
  assert.deepEqual(live?.previews, [{ service: "web", httpsPort: 10200 }]);
  assert.deepEqual(previewsIn(live), [{ service: "web", url: "https://rj-firebat.tail.ts.net:10200/" }]);
  assert.match(overlayFile(live, "/home/user/.nexus/PYLON.md"), /- web: https:\/\/rj-firebat\.tail\.ts\.net:10200\//);
  assert.equal(registry.pylon(thread.pylonId)?.liveHash, liveHashOf(live!));
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["spawn", "spawn"], "the running pylon gets the new LiveSpec in a second spawn");
  assert.deepEqual(registry.outputs(thread.id).filter((o) => o.kind === "preview"), [{ thread: thread.id, kind: "preview", ref: "web" }]);
});

test("a linked port's preview goes once a read of the pylon's services leaves it out, and a read that failed changes nothing", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  const loop = run(t, registry, fake.probe, { ingest: realIngest });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  const linked: ServiceFact = { name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true };
  const services = () => registry.previews(thread.pylonId).map((p) => `${p.service} ${p.httpsPort}`);
  const published = () => fake.lives.get(thread.pylonId)?.previews.map((p) => `${p.service} ${p.httpsPort}`);
  fake.setServices(thread.pylonId, [web, linked]);
  await until("both previews are ready", () => registry.previews(thread.pylonId).filter((p) => p.ready).length === 2);

  fake.setServices(thread.pylonId, [web]);
  await until("the next spawn publishes the previews without the port", () => JSON.stringify(published()) === JSON.stringify(["web 10200"]));
  assert.deepEqual(services(), ["web 10200"], "a declared service keeps its preview");

  fake.setServices(thread.pylonId, [web, linked]);
  await until("the port is published again", () => registry.previews(thread.pylonId).filter((p) => p.ready).length === 2);
  // As the API does once the pylon unlinks the port. A read that fails then carries the list read before the unlink.
  registry.releasePreview(thread.pylonId, "port-3000");
  fake.setServices(thread.pylonId, null);
  await settled(fake, loop);
  assert.deepEqual(services(), ["web 10200"], "a list carried from an earlier read gives no port back");
});

test("preview ports are unique on a node and keep their port across pause, a control-plane restart and wake", async (t) => {
  const path = tempDb();
  const fake = fakeNode({ autoFinish: true });
  const before = openRegistry(path);
  const a = seed(before);
  const b = seed(before);
  const first = startLoop({ registry: before, probes: [fake.probe], ingest: realIngest, previewPorts, intervalMs: 10, reconnectMs: 10, log: assert.fail });
  await until("both pylons run", () => [a, b].every((th) => fake.pylons.get(th.pylonId)?.phase === "running"));
  fake.setServices(a.pylonId, [web]);
  await until("a's preview is ready", () => before.previews(a.pylonId)[0]?.ready === true);
  fake.setServices(b.pylonId, [web]);
  await until("b's preview is ready", () => before.previews(b.pylonId)[0]?.ready === true);
  assert.deepEqual([a, b].map((th) => fake.lives.get(th.pylonId)?.previews), [[{ service: "web", httpsPort: 10200 }], [{ service: "web", httpsPort: 10201 }]]);

  before.setThreadStatus(a.id, "archived");
  await until("a is paused", () => fake.pylons.get(a.pylonId)?.phase === "stopped");
  await until("a's preview is not ready", () => before.previews(a.pylonId)[0]?.ready === false);
  await first.close();
  before.close();

  const after = openRegistry(path);
  run(t, after, fake.probe, { ingest: realIngest });
  assert.deepEqual(after.previews(a.pylonId), [{ pylon: a.pylonId, service: "web", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" }]);
  after.setThreadStatus(a.id, "active");
  after.recordActivity(a.id, { human: Date.now() });
  await until("a's preview is ready again", () => after.previews(a.pylonId)[0]?.ready === true);
  const wake = fake.submitted.at(-1)!;
  assert.ok(wake.kind === "spawn" && wake.boot.source.kind === "resume", "the wake resumes a from its checkpoint");
  assert.deepEqual(wake.live.previews, [{ service: "web", httpsPort: 10200 }], "the wake publishes the same port, though a reports no services yet");
});

test("a deleted thread's ports go back only once its node no longer has the pylon", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const finishNext = async (kind: Job["kind"]) => {
    await until(`a ${kind} job runs`, () => fake.running().length === 1 && fake.submitted.at(-1)?.kind === kind);
    fake.finish(fake.running()[0]!);
  };
  run(t, registry, fake.probe, { ingest: realIngest });
  await finishNext("spawn");
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  fake.setServices(thread.pylonId, [web]);
  await finishNext("spawn");
  await until("the preview is ready", () => registry.previews(thread.pylonId)[0]?.ready === true);

  registry.setThreadStatus(thread.id, "deleted");
  await until("the delete runs", () => fake.running().length === 1 && fake.submitted.at(-1)?.kind === "delete");
  assert.deepEqual(registry.previews(thread.pylonId).map((p) => p.httpsPort), [10200], "the port is held while the node may still serve it");
  fake.finish(fake.running()[0]!);
  await until("the port is released", () => registry.previews(thread.pylonId).length === 0);
});

test("a port the node still serves for a pylon the registry lost goes to no new preview, and its route is left alone", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  const lost = "pylon-th-lost" as PylonId;
  fake.pylons.set(lost, { pylonId: lost, phase: "stopped", checkpoint: null, sessions: null });
  fake.routes.set(10200, { httpsPort: 10200, pylonId: lost, service: "web" });
  run(t, registry, fake.probe, { ingest: realIngest });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  fake.setServices(thread.pylonId, [web]);
  await until("web is published", () => registry.previews(thread.pylonId)[0]?.ready === true);
  assert.deepEqual(fake.lives.get(thread.pylonId)?.previews, [{ service: "web", httpsPort: 10201 }]);
  assert.deepEqual(fake.routes.get(10200), { httpsPort: 10200, pylonId: lost, service: "web" });
  assert.ok(!fake.submitted.some((job) => "pylonId" in job && job.pylonId === lost), "the planner sends nothing for a pylon it does not know");
});

test("a deleted thread whose pylon was removed by hand gets a delete that unpublishes its previews, and only then its ports back", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: false });
  const finishNext = async (kind: Job["kind"]) => {
    await until(`a ${kind} job runs`, () => fake.running().length === 1 && fake.submitted.at(-1)?.kind === kind);
    fake.finish(fake.running()[0]!);
  };
  const loop = run(t, registry, fake.probe, { ingest: realIngest });
  await finishNext("spawn");
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  fake.setServices(thread.pylonId, [web]);
  await finishNext("spawn");
  await until("the preview is ready", () => registry.previews(thread.pylonId)[0]?.ready === true);
  registry.setThreadStatus(thread.id, "archived");
  await finishNext("pause");
  await until("the pylon is paused", () => fake.pylons.get(thread.pylonId)?.phase === "stopped");

  fake.pylons.delete(thread.pylonId);
  fake.announce();
  registry.setThreadStatus(thread.id, "deleted");
  await until("a delete runs for the absent pylon", () => fake.running().length === 1 && fake.submitted.at(-1)?.kind === "delete");
  assert.deepEqual(registry.previews(thread.pylonId).map((p) => p.httpsPort), [10200], "the port is held while the node still routes it");
  fake.finish(fake.running()[0]!);
  await until("the port is released", () => registry.previews(thread.pylonId).length === 0);
  assert.deepEqual([...fake.routes.keys()], []);
  const deletes = () => fake.submitted.filter((job) => job.kind === "delete").length;
  const sent = deletes();
  await settled(fake, loop);
  assert.equal(deletes(), sent, "once the node has neither the pylon nor its routes, no delete follows");
});

test("a deleted thread's pylon that is gone is torn down again whenever its node lists or routes it again", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  const loop = run(t, registry, fake.probe, { ingest: realIngest });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  registry.setThreadStatus(thread.id, "deleted");
  await until("the pylon is gone", () => !fake.pylons.has(thread.pylonId) && registry.pylon(thread.pylonId)?.submitted === null);
  const deletes = () => fake.submitted.filter((job) => job.kind === "delete").length;
  await settled(fake, loop);
  assert.equal(deletes(), 1);

  const stopped: PylonObservation = { pylonId: thread.pylonId, phase: "stopped", checkpoint: null, sessions: null };
  fake.pylons.set(thread.pylonId, stopped);
  fake.announce();
  await until("the listed pylon is deleted again", () => deletes() === 2 && !fake.pylons.has(thread.pylonId));

  fake.routes.set(10200, { httpsPort: 10200, pylonId: thread.pylonId, service: "web" });
  fake.announce();
  await until("the routed pylon is deleted again", () => deletes() === 3 && fake.routes.size === 0);
  await settled(fake, loop);
  assert.equal(deletes(), 3, "once the node lets go of it again, no delete follows");
});

test("follow leaves out a deleted thread's pylon its node no longer lists, and diffs it afresh when the node lists it again", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  const snapshots: { lists: boolean; known: PylonId[]; unlisted: PylonId[] }[] = [];
  const loop = run(t, registry, fake.probe, {
    ingest: (event, eventNode, known, now, unlisted) => {
      if (event.type === "snapshot") snapshots.push({ lists: event.observation.pylons.some((p) => p.pylonId === thread.pylonId), known: [...known.keys()], unlisted: [...unlisted] });
      return realIngest(event, eventNode, known, now, unlisted);
    },
  });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  registry.setThreadStatus(thread.id, "deleted");
  await until("the pylon is gone", () => !fake.pylons.has(thread.pylonId) && registry.pylon(thread.pylonId)?.submitted === null);
  await settled(fake, loop);
  fake.announce();
  await settled(fake, loop);
  assert.deepEqual(snapshots.at(-1), { lists: false, known: [], unlisted: [] }, "a snapshot that no longer lists the pylon leaves it out");

  const from = snapshots.length;
  fake.pylons.set(thread.pylonId, { pylonId: thread.pylonId, phase: "stopped", checkpoint: null, sessions: null });
  fake.announce();
  await until("the listed pylon is ingested", () => snapshots.slice(from).some((s) => s.lists));
  assert.deepEqual(snapshots.slice(from).find((s) => s.lists), { lists: true, known: [thread.pylonId], unlisted: [thread.pylonId] }, "its sessions are written again, as for a pylon never listed");
});

test("a deleted thread's pylon removed by hand while the control plane was down has its sessions cleared", async (t) => {
  const path = tempDb();
  const fake = fakeNode({ autoFinish: true });
  const before = openRegistry(path);
  const thread = seed(before);
  const first = startLoop({ registry: before, probes: [fake.probe], ingest: realIngest, previewPorts, intervalMs: 10, reconnectMs: 10, log: assert.fail });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  fake.setSessions(thread.pylonId, [{ id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", status: "idle", title: "review" }]);
  before.setThreadStatus(thread.id, "archived");
  await until("the pause is folded in", () => before.pylon(thread.pylonId)?.pauses === 1 && before.sessions(thread.pylonId)[0]?.state === "paused");
  await first.close();
  before.setThreadStatus(thread.id, "deleted");
  fake.pylons.delete(thread.pylonId);
  before.close();

  const after = openRegistry(path);
  run(t, after, fake.probe, { ingest: realIngest });
  await until("the paused session is cleared", () => after.sessions(thread.pylonId).length === 0);
});

test("a deleted thread's ports go back after a restart between its delete and their release", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.allocatePreviews(thread.pylonId, ["web"], previewPorts);
  registry.setThreadStatus(thread.id, "deleted");
  const fake = fakeNode({ autoFinish: true });
  run(t, registry, fake.probe);
  await until("the port is released", () => registry.previews(thread.pylonId).length === 0);
  assert.deepEqual(fake.submitted, []);
});

test("a deleted thread whose pylon was retried just before the delete settles the retry, though its pylon is gone", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.savePylon({ ...registry.pylon(thread.pylonId)!, failed: "gave up" });
  assert.ok(registry.retryPylon(thread.pylonId));
  registry.setThreadStatus(thread.id, "deleted");
  const fake = fakeNode({ autoFinish: true });
  const loop = run(t, registry, fake.probe);
  await until("the retry is settled", () => registry.pylon(thread.pylonId)?.retrying === false);
  await settled(fake, loop);
  assert.deepEqual(registry.pylonIdsToTick(node, []), [], "once settled, the pass leaves the pylon out");
  assert.deepEqual(fake.submitted, []);
});

test("a deleted thread whose Claude launch was cut off has the launch failed, though its pylon is gone", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setThreadStatus(thread.id, "deleted");
  registry.setClaudeWorker(thread.id, "hello", "starting", undefined, "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30");
  const fake = fakeNode({ autoFinish: true });
  run(t, registry, fake.probe);
  await until("worker failed", () => registry.claudeWorker(thread.id)?.state === "failed");
  assert.deepEqual(fake.submitted, []);
});

test("a probe that reports no routes still gets planned for, with ports allocated by the registry alone", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true, reportsRoutes: false });
  run(t, registry, fake.probe, { ingest: realIngest });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  fake.setServices(thread.pylonId, [web]);
  await until("web is published", () => registry.previews(thread.pylonId)[0]?.ready === true);
  assert.deepEqual(fake.lives.get(thread.pylonId)?.previews, [{ service: "web", httpsPort: 10200 }]);

  fake.pylons.delete(thread.pylonId);
  fake.announce();
  registry.setThreadStatus(thread.id, "deleted");
  await until("the port is released", () => registry.previews(thread.pylonId).length === 0);
  assert.ok(!fake.submitted.some((job) => job.kind === "delete"), "with its routes unknown, an absent pylon of a deleted thread is gone, as before");
});

test("a used-up port range is logged, and the services that got a port are still published", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  const logged: string[] = [];
  run(t, registry, fake.probe, { ingest: realIngest, previewPorts: { first: 10200, last: 10200 }, log: (line) => logged.push(line) });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  fake.setServices(thread.pylonId, [web, { ...web, name: "api", port: 8001 }]);
  await until("web is published", () => registry.previews(thread.pylonId)[0]?.ready === true);
  assert.deepEqual(fake.lives.get(thread.pylonId)?.previews, [{ service: "web", httpsPort: 10200 }]);
  assert.ok(logged.includes(`${thread.pylonId}: no https port is free for the preview of api: pylons on ${node} hold or ${node} serves every port from 10200 to 10200`), logged.join("\n"));
});

test("a node the loop starts following while it runs comes online and runs its threads' pylons", async (t) => {
  const registry = openRegistry(tempDb());
  const loop = run(t, registry, []);
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  assert.throws(() => loop.follow(fakeNode({ autoFinish: true, node: "unknown" as NodeName }).probe), /which the registry does not know/);
  loop.follow(fake.probe);
  loop.follow(fake.probe);
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.equal(registry.node(node)?.state, "online");
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["spawn"], "following it twice follows it once");
});

test("a node reporting a pylon the registry places on another node gets no ports for it", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const peer = "infra-testbench" as NodeName;
  registry.upsertNode({ name: peer, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nTESTBENCH" as TailnetNodeId });
  const home = fakeNode({ autoFinish: true });
  const elsewhere = fakeNode({ autoFinish: true, node: peer });
  const loop = startLoop({ registry, probes: [home.probe, elsewhere.probe], ingest: realIngest, previewPorts, intervalMs: 10, reconnectMs: 10, log: assert.fail });
  t.after(async () => {
    await loop.close();
    registry.close();
  });
  await until("the pylon runs on its node", () => home.pylons.get(thread.pylonId)?.phase === "running");

  elsewhere.pylons.set(thread.pylonId, { ...home.pylons.get(thread.pylonId)!, services: [] } as PylonObservation);
  elsewhere.setServices(thread.pylonId, [web]);
  await until("the copy is recorded as an orphan", () => registry.orphans().some((o) => o.node === peer));
  await loop.wake(firebat);
  assert.deepEqual(registry.previews(thread.pylonId), []);
  assert.deepEqual(home.submitted.map((job) => job.kind), ["spawn"]);
});

test("a boot asking for a held secret waits for a probe older than it, and boots once the upgraded probe has it", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const stored = registry.pylon(thread.pylonId)!;
  registry.savePylon({ ...stored, boot: { ...stored.boot, network: { allowedHosts: [], secrets: [chatgptTokenGrant] } } });
  const fake = fakeNode({ autoFinish: true });
  const loop = run(t, registry, fake.probe);
  await until("the node is online", () => registry.node(node)?.state === "online");
  await settled(fake, loop);
  assert.deepEqual(fake.submitted, [], "no spawn reaches a probe that does not take the held secret");
  assert.equal(registry.pylon(thread.pylonId)!.failed, null);

  fake.upgrade([chatgptTokenGrant.name]);
  await settled(fake, loop);
  assert.deepEqual(fake.submitted, [], "no spawn reaches a probe that takes the held secret but has not got it");

  await fake.probe.putSecret(chatgptTokenGrant.name, "token");
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh"]);
  assert.equal(registry.pylon(thread.pylonId)!.attempts.count, 0);
});

test("a boot asking for the ChatGPT token right after a probe restart boots once the handoff the restart set off arrives", async (t) => {
  const registry = openRegistry(tempDb());
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  const fake = fakeNode({ autoFinish: true, heldSecrets: [chatgptTokenGrant.name] });
  let token: string | undefined;
  const handoff = chatgptTokenHandoff({ probes: [fake.probe], token: async () => token, log: assert.fail });
  run(t, registry, fake.probe, { ingest: (event, ...rest) => {
    if (event.type === "snapshot") handoff.observed(event.observation);
    return ingest(event, ...rest);
  } });
  await until("the node is online", () => registry.node(node)?.state === "online");
  token = "token";

  fake.restartProbe();
  const thread = seed(registry);
  const stored = registry.pylon(thread.pylonId)!;
  registry.savePylon({ ...stored, boot: { ...stored.boot, network: { allowedHosts: [], secrets: [chatgptTokenGrant] } } });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.deepEqual(kinds(fake.submitted), ["spawn fresh"]);
  assert.deepEqual(registry.node(node)?.observation?.grants?.secrets, [chatgptTokenGrant.name]);
  await handoff.close();
});

test("every new boot takes the configured git identity, but a checkpoint keeps its original grants", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  const fake = fakeNode({ autoFinish: true });
  const gitIdentity = { name: "Example Person", email: "person@example.com" };
  run(t, registry, fake.probe, { gitIdentity });
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  const fresh = fake.submitted.find((job) => job.kind === "spawn")!;
  assert.ok(fresh.kind === "spawn");
  assert.deepEqual(fresh.boot.gitIdentity, gitIdentity);
  const override = { name: "Work Person", email: "work@example.com" };
  registry.updateProject({ ...registry.project(thread.project)!, gitIdentity: override, secrets: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }], logins: ["claude"] });
  assert.deepEqual(registry.pylon(thread.pylonId)!.boot.gitIdentity, gitIdentity, "a running pylon keeps its boot identity");
  registry.setThreadStatus(thread.id, "archived");
  await until("the pause is folded in", () => registry.pylon(thread.pylonId)?.pauses === 1);
  registry.setThreadStatus(thread.id, "active");
  registry.recordActivity(thread.id, { human: Date.now() });
  await until("the pylon runs again", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  const resume = fake.submitted.findLast((job) => job.kind === "spawn")!;
  assert.ok(resume.kind === "spawn" && resume.boot.source.kind === "resume");
  assert.deepEqual(resume.boot.gitIdentity, override);
  assert.deepEqual(resume.boot.network, fresh.boot.network);
});

test("a queued Claude worker launches once after its pylon runs", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setClaudeWorker(thread.id, "/poteto-mode implement it", "pending");
  const fake = fakeNode({ autoFinish: true });
  const commands: unknown[] = [];
  const probe: ProbeClient = { ...fake.probe, command: async (pylonId, command) => {
    assert.equal(pylonId, thread.pylonId);
    assert.equal(fake.pylons.get(pylonId)?.phase, "running");
    commands.push(command);
    return { kind: "open-session", herdrPane: "w1:p1" };
  } };
  const loop = run(t, registry, probe);
  await until("worker started", () => registry.claudeWorker(thread.id)?.state === "started");
  await loop.wake(node);
  assert.deepEqual(commands, [{ kind: "open-session", harness: "claude-code", title: "t", resume: (commands[0] as { resume: string }).resume, prompt: "/poteto-mode implement it", model: "claude-opus-5-5" }]);
});

test("a stalled Claude launch reports its screen and failed attention without resubmitting", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setClaudeWorker(thread.id, "/poteto-mode hello", "pending");
  const fake = fakeNode({ autoFinish: true });
  let launches = 0;
  const probe: ProbeClient = { ...fake.probe, command: async () => {
    launches++;
    throw new Error("Claude launch stalled: no UserPromptSubmit within 30 seconds. The pane showed:\nChoose the text style");
  } };
  const loop = run(t, registry, probe, { log: () => {} });
  await until("worker stalled", () => registry.claudeWorker(thread.id)?.state === "stalled");
  await loop.wake(node);
  assert.equal(launches, 1);
  assert.match(registry.claudeWorker(thread.id)!.message!, /Choose the text style/);
  assert.ok(registry.events().some((e) => e.kind === "thread.failed" && String(e.payload.message).includes("Choose the text style")));
  assert.ok(registry.events().some((e) => e.kind === "attention.changed" && e.payload.attention === "failed"));
});

test("a submission receipt wins over a late launch error without a contradictory failed event", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setClaudeWorker(thread.id, "hello", "pending");
  const fake = fakeNode({ autoFinish: true });
  let launches = 0;
  const probe: ProbeClient = { ...fake.probe, command: async (_pylon, command) => {
    assert.equal(command.kind, "open-session");
    if (command.kind !== "open-session") throw new Error("wrong command");
    launches++;
    registry.reportSession(node, { sequence: 1, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.turn-started", session: command.resume! } });
    throw new Error("Herdr timed out waiting for readiness");
  } };
  const loop = run(t, registry, probe);
  await until("worker submitted", () => registry.claudeWorker(thread.id)?.state === "started");
  await loop.wake(node);
  assert.equal(launches, 1);
  assert.equal(registry.claudeWorker(thread.id)!.message, undefined);
  assert.equal(registry.events().some((e) => e.kind === "thread.failed"), false);
  assert.equal(registry.events().filter((e) => e.kind === "attention.changed").at(-1)?.payload.attention, "working");
});

test("a failed launch persists the same diagnostic it publishes and never resubmits", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setClaudeWorker(thread.id, "hello", "pending");
  const fake = fakeNode({ autoFinish: true });
  let launches = 0;
  const probe: ProbeClient = { ...fake.probe, command: async () => {
    launches++;
    throw new Error("seeding Claude state failed: invalid JSON");
  } };
  const loop = run(t, registry, probe, { log: () => {} });
  await until("worker failed", () => registry.claudeWorker(thread.id)?.state === "failed");
  await loop.wake(node);
  assert.equal(launches, 1);
  const worker = registry.claudeWorker(thread.id)!;
  assert.match(worker.message!, /seeding Claude state failed: invalid JSON/);
  assert.equal(registry.events().filter((e) => e.kind === "thread.failed").at(-1)?.payload.message, worker.message);
  assert.equal(registry.events().filter((e) => e.kind === "attention.changed").at(-1)?.payload.attention, "failed");
});

/**
 * A probe whose command answers with `answers`, in order. A "restart" drops the connection, as a deploy's probe restart
 * does, with the observe link, and the probe is back 30 ms later.
 */
function restartingProbe(fake: ReturnType<typeof fakeNode>, answers: ("restart" | CommandResult)[], commands: PylonCommand[]): ProbeClient {
  return { ...fake.probe, command: async (_pylonId, command) => {
    commands.push(command);
    const answer = answers.shift() ?? assert.fail("the launch was sent once too often");
    if (answer !== "restart") return answer;
    fake.disconnect();
    setTimeout(() => fake.reconnect(), 30);
    throw Object.assign(new Error(`${node}: socket hang up`), { code: "unreachable" });
  } };
}

test("a Claude launch whose probe restarts mid-way is sent again under its session once the probe is back, and starts once", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setClaudeWorker(thread.id, "/poteto-mode hello", "pending");
  const fake = fakeNode({ autoFinish: true });
  const commands: PylonCommand[] = [];
  const logged: string[] = [];
  run(t, registry, restartingProbe(fake, ["restart", "restart", { kind: "open-session", herdrPane: "w1:p1" }], commands), { log: (line) => logged.push(line) });
  await until("worker started", () => registry.claudeWorker(thread.id)?.state === "started");
  assert.equal(commands.length, 3);
  assert.deepEqual(new Set(commands.map((c) => c.kind === "open-session" && c.resume)), new Set([registry.claudeWorker(thread.id)!.session]), "every send names the session recorded before the first");
  assert.equal(registry.events().some((e) => e.kind === "thread.failed"), false);
  assert.ok(logged.some((line) => line.includes("the Claude launch lost its probe (rj-firebat: socket hang up). Sending it again")));
});

test("a Claude launch whose probe stays away fails once the wait is over", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setClaudeWorker(thread.id, "hello", "pending");
  const fake = fakeNode({ autoFinish: true });
  const commands: PylonCommand[] = [];
  const probe: ProbeClient = { ...fake.probe, command: async (_pylonId, command) => {
    commands.push(command);
    fake.disconnect();
    throw Object.assign(new Error(`${node}: socket hang up`), { code: "unreachable" });
  } };
  run(t, registry, probe, { log: () => {}, claudeLaunchRetryMs: 200 });
  await until("worker failed", () => registry.claudeWorker(thread.id)?.state === "failed");
  assert.equal(commands.length, 1);
  assert.match(registry.claudeWorker(thread.id)!.message!, /socket hang up, and the probe did not come back within 0\.2 seconds$/);
  assert.ok(registry.events().some((e) => e.kind === "thread.failed"));
});

test("a Claude launch a control plane restart cut off goes again under its session", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setClaudeWorker(thread.id, "hello", "starting", undefined, "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30");
  const fake = fakeNode({ autoFinish: true });
  const commands: PylonCommand[] = [];
  run(t, registry, restartingProbe(fake, [{ kind: "open-session", herdrPane: "w1:p1" }], commands));
  await until("worker started", () => registry.claudeWorker(thread.id)?.state === "started");
  assert.deepEqual(commands.map((c) => c.kind === "open-session" && c.resume), ["6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30"]);
});

test("a control plane that opens on an observation stored from a probe older than routes, grants, held secrets and counting boots its pylon from the probe's first snapshot", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.ingested({
    node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "boot-0", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [image], jobs: [],
    pylons: [{ pylonId: thread.pylonId, phase: "stopped", checkpoint: null }],
  } as never, []);
  const fake = fakeNode({ autoFinish: true });
  run(t, registry, fake.probe);
  await until("the pylon runs", () => fake.pylons.get(thread.pylonId)?.phase === "running");
  assert.deepEqual(fake.submitted.map((job) => job.kind), ["spawn"]);
});

test("a Claude launch a control plane restart cut off before it recorded a session fails, sent never", async (t) => {
  const registry = openRegistry(tempDb());
  const thread = seed(registry);
  registry.setClaudeWorker(thread.id, "hello", "starting");
  const fake = fakeNode({ autoFinish: true });
  const sent: PylonCommand[] = [];
  run(t, registry, restartingProbe(fake, [], sent));
  await until("worker failed", () => registry.claudeWorker(thread.id)?.state === "failed");
  assert.equal(registry.claudeWorker(thread.id)!.message, "Claude launch was interrupted; attach to check before starting another session");
  assert.deepEqual(sent, []);
});
