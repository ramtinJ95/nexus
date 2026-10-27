/**
 * Counts what one reconcile pass does as deleted threads pile up, through the real loop, registry and planner against
 * a fake probe. Run with `node --no-warnings docs/verification/skip-deleted-pylons/count-pass-work.ts [deleted counts...]`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryObjects } from "node:v8";
import { startLoop, type Ingest } from "../../../src/control/loop.ts";
import { claudeConversations } from "../../../src/control/claude-conversation.ts";
import { openRegistry, type Registry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { ingest } from "../../../src/reconcile.ts";
import { newPylonRecord } from "../../../src/tick.ts";
import type { JobEnvelope, JobId, JobStatus, LiveHash, NodeName, NodeObservation, PreviewRouteFact, ProbeClient, ProbeEvent, PylonId, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";
import type { ProjectId } from "../../../src/project.ts";
import type { ImageId } from "../../../src/images.ts";

const node = "rj-firebat" as NodeName;
const image: ImageId = "img-000000000000";
const passes = 50;
const snapshots = 10;
const dir = await mkdtemp(join(tmpdir(), "nexus-136-"));

function seed(registry: Registry, n: number, claude = false): Thread {
  const id = `th-${String(n).padStart(6, "0")}` as ThreadId;
  const pylonId = `pylon-${id}` as PylonId;
  const thread: Thread = {
    seenAt: null, lastReplyAt: null, id, title: "t", project: "acme" as ProjectId, pylonId, status: "active", conversationId: null, startedBy: "nLAPTOP",
    createdAt: Date.now(), agentTurnRunning: false, working: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now(),
  };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: id, pylonId, node, desired: "running",
    boot: {
      pylonId, image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
      repo: { kind: "clone", url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
      dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    },
    firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash-1" as LiveHash,
  });
  registry.createThread(thread, pylon, claude ? "hello" : undefined);
  return thread;
}

function openSeeded(): Registry {
  const registry = openRegistry(join(dir, `${Math.random().toString(36).slice(2)}.db`));
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  registry.createProject({
    id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
  return registry;
}

/** A node whose jobs finish at once. Counts every call the loop makes to its probe. */
function fakeNode() {
  const pylons = new Map<PylonId, PylonObservation>();
  const routes = new Map<number, PreviewRouteFact>();
  const jobs = new Map<JobId, JobStatus>();
  const sent: { kind: string; pylonId: PylonId }[] = [];
  const calls = { submit: 0, job: 0 };
  const streams = new Set<(event: ProbeEvent) => void>();
  const observation = (): NodeObservation => ({
    node, observedAt: new Date().toISOString(), probeBootId: "boot-1",
    capacity: { cpus: 64, committedCpus: 0, memoryGiB: 256, committedMemoryGiB: 0, diskFreeGiB: 1000, committedDiskGiB: 0 },
    artifacts: [image], jobs: [...jobs.values()], pylons: [...pylons.values()], grants: { secrets: [], gitSsh: false }, previewRoutes: [...routes.values()],
  });
  const announce = () => { for (const push of streams) push({ type: "snapshot", observation: observation() }); };
  const running = (pylonId: PylonId, liveHash: LiveHash): PylonObservation => ({
    pylonId, phase: "running", liveHash, bootedAt: new Date().toISOString(), bootedFrom: { image, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  });
  const probe: ProbeClient = {
    node,
    async submit(env: JobEnvelope) {
      calls.submit++;
      const pylonId = (env.job as { pylonId: PylonId }).pylonId;
      sent.push({ kind: env.job.kind, pylonId });
      if (env.job.kind === "spawn") pylons.set(pylonId, running(pylonId, env.job.liveHash));
      if (env.job.kind === "delete") {
        pylons.delete(pylonId);
        for (const [port, route] of routes) if (route.pylonId === pylonId) routes.delete(port);
      }
      const now = new Date().toISOString();
      const status: JobStatus = { jobId: env.jobId, subject: pylonId, kind: env.job.kind, state: "succeeded", finishedAt: now };
      jobs.set(env.jobId, status);
      setTimeout(announce, 1);
      return { accepted: status };
    },
    async job(jobId) {
      calls.job++;
      return jobs.get(jobId) ?? "unknown";
    },
    async *observe(signal) {
      const queue: ProbeEvent[] = [{ type: "snapshot", observation: observation() }];
      let notify: (() => void) | null = null;
      const push = (event: ProbeEvent) => { queue.push(event); notify?.(); };
      streams.add(push);
      const onAbort = () => notify?.();
      signal.addEventListener("abort", onAbort);
      try {
        while (!signal.aborted) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>((resolve) => { notify = resolve; });
        }
      } finally {
        streams.delete(push);
        signal.removeEventListener("abort", onAbort);
      }
    },
    command: () => Promise.reject(new Error("unused")),
    stream: () => Promise.reject(new Error("unused")),
    manifest: () => Promise.reject(new Error("unused")),
    putSecret: () => Promise.reject(new Error("unused")),
  };
  return { probe, pylons, routes, sent, calls, announce, running };
}

/** The registry, with a count of each method the loop calls. */
function counted(registry: Registry) {
  const calls = new Map<string, number>();
  const proxy = new Proxy(registry, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || typeof key !== "string") return value;
      return (...args: unknown[]) => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return value.apply(target, args);
      };
    },
  });
  return { proxy, calls };
}

async function until(what: string, predicate: () => boolean) {
  const deadline = Date.now() + 60_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * `deleted` threads whose pylons the node no longer has, one active thread, and two deleted threads the node has not
 * let go of: one whose pylon still runs and one whose pylon is gone but still routes a preview port.
 */
async function measure(deleted: number) {
  const registry = openSeeded();
  for (let n = 0; n < deleted; n++) registry.setThreadStatus(seed(registry, n).id, "deleted");
  const active = seed(registry, 900_000);
  const stillRunning = seed(registry, 900_001);
  const stillRouted = seed(registry, 900_002);
  registry.setThreadStatus(stillRunning.id, "deleted");
  registry.setThreadStatus(stillRouted.id, "deleted");

  const fake = fakeNode();
  fake.pylons.set(stillRunning.pylonId, fake.running(stillRunning.pylonId, "hash-1" as LiveHash));
  fake.routes.set(10200, { httpsPort: 10200, pylonId: stillRouted.pylonId, service: "web" });
  const { proxy, calls } = counted(registry);
  let pylonWrites = 0;
  const counting: Ingest = (...args) => {
    const writes = ingest(...args);
    pylonWrites += writes.filter((w) => w.record !== "node" && w.record !== "job").length;
    return writes;
  };
  const loop = startLoop({
    registry: proxy, probes: [fake.probe], ingest: counting, previewPorts: { first: 10200, last: 10299 }, intervalMs: 3_600_000, reconnectMs: 10, log: (line) => console.error(line),
  });
  await until("the node is online", () => registry.node(node)?.state === "online");
  await until("the active pylon runs and the deleted ones are let go", () =>
    fake.pylons.get(active.pylonId)?.phase === "running" && !fake.pylons.has(stillRunning.pylonId) && fake.routes.size === 0
    && [active, stillRunning, stillRouted].every((t) => registry.pylon(t.pylonId)?.submitted === null));
  await loop.wake(node);
  const teardown = fake.sent.filter((s) => s.kind === "delete").map((s) => s.pylonId).sort();
  assert.deepEqual(teardown, [stillRunning.pylonId, stillRouted.pylonId], "the deleted pylons the node still had got a delete each, and no other did");

  calls.clear();
  fake.calls.submit = fake.calls.job = 0;
  const started = performance.now();
  for (let i = 0; i < passes; i++) await loop.wake(node);
  const ms = (performance.now() - started) / passes;
  const per = (name: string) => (calls.get(name) ?? 0) / passes;
  const pass = {
    deleted, teardown: teardown.length, ms,
    ids: per("pylonIdsOn") + per("pylonIdsToTick"), pylon: per("pylon"), thread: per("thread"), project: per("project"), previews: per("previews"), claudeWorker: per("claudeWorker"),
    savePylon: per("savePylon"), releasePreviews: per("releasePreviews"), probe: (fake.calls.submit + fake.calls.job) / passes,
  };
  const ingested = calls.get("ingested") ?? 0;
  const writes = pylonWrites;
  for (let i = 1; i <= snapshots; i++) {
    fake.announce();
    await until("the snapshot is ingested", () => (calls.get("ingested") ?? 0) === ingested + i);
  }
  const snapshotWrites = (pylonWrites - writes) / snapshots;
  await loop.close();
  registry.close();
  return { ...pass, snapshotWrites };
}

/**
 * The readers the Claude conversation service keeps for `count` Claude threads that were read, watched and deleted. An
 * active thread read first marks its `readers` Map, the only live Map keyed by thread IDs, whose size V8 prints.
 */
async function readersKept(count: number) {
  const registry = openSeeded();
  const active = seed(registry, 999_999, true);
  const threads = Array.from({ length: count }, (_, n) => seed(registry, n, true));
  for (const t of threads) registry.setThreadStatus(t.id, "deleted");
  const conversations = claudeConversations({ registry, probes: new Map(), followMs: 3_600_000 });
  await conversations.refresh(active);
  await Promise.all(threads.map((t) => conversations.refresh(t)));
  for (const t of threads) {
    const watch = await conversations.watch(t);
    await watch.stop();
  }
  const maps = (queryObjects(Map, { format: "summary" }) as string[]).filter((m) => m.includes(`'${active.id}'`));
  assert.equal(maps.length, 1, "one Map holds the active thread's reader");
  conversations.close();
  registry.close();
  return Number(/^Map\((\d+)\)/.exec(maps[0]!)![1]) - 1;
}

const readers = [];
for (const count of [1_000, 3_000]) readers.push({ count, kept: await readersKept(count) });
const counts = process.argv.slice(2).map(Number);
const rows = [];
for (const deleted of counts.length > 0 ? counts : [0, 100, 1000]) rows.push(await measure(deleted));
console.log(`Per pass, averaged over ${passes} passes after the loop settled. "ids" counts the queries that list the node's pylons. The last column is what ingest writes for pylons per snapshot, averaged over ${snapshots} snapshots of the settled node.\n`);
console.log("| deleted threads | deletes sent to still-held pylons | ids | pylon reads | thread reads | project reads | previews reads | Claude worker reads | pylon saves | releasePreviews | probe calls | ms per pass | pylon writes per snapshot |");
console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of rows) {
  console.log(`| ${r.deleted} | ${r.teardown} | ${r.ids} | ${r.pylon} | ${r.thread} | ${r.project} | ${r.previews} | ${r.claudeWorker} | ${r.savePylon} | ${r.releasePreviews} | ${r.probe} | ${r.ms.toFixed(2)} | ${r.snapshotWrites} |`);
}
console.log("\nReaders the Claude conversation service keeps after reading and watching deleted Claude threads, read from the size of its readers Map.\n");
console.log("| deleted Claude threads | readers kept |");
console.log("|---:|---:|");
for (const r of readers) console.log(`| ${r.count} | ${r.kept} |`);
await rm(dir, { recursive: true });
