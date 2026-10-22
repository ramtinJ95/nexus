import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, type StoredPylon, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import type { JobId, LiveHash, NodeName, NodeObservation, PylonId, TailnetNodeId } from "../protocol.ts";
import type { Project, ProjectId } from "../project.ts";
import type { ImageManifest, TemplateRecord } from "../images.ts";

const node = "rj-firebat" as NodeName;
const threadId = "th-1" as ThreadId;
const pylonId = "pylon-th-1" as PylonId;
const project: Project = {
  id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: ["registry.npmjs.org"],
  secrets: [{ name: "TOKEN", hosts: ["api.example.com"] }], logins: ["chatgpt"], preSetup: null,
};
const thread: Thread = {
  id: threadId, title: "fix it", project: project.id, pylonId, status: "active", conversationId: null, startedBy: "nLAPTOP",
  createdAt: 1_000, agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: 1_000,
};
const { desired: _, ...pylon } = newPylonRecord({
  thread: threadId, pylonId, node, desired: "running",
  boot: {
    pylonId, image: "img-000000000000", resources: project.resources, network: { allowedHosts: ["a.example"], secrets: [] },
    repo: { url: project.repoUrl, checkout: { branch: "main", commit: "origin/main" } },
    dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  },
  firstBoot: { kind: "fresh", preSetup: null },
  live: { previews: [], overlay: [] },
  liveHash: "hash-1" as LiveHash,
});
const image: ImageManifest = {
  id: "img-000000000000", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "0".repeat(64),
  pins: {
    debianDigest: "d", node: "24", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s",
    gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f",
  },
};

// One directory for the file, so each test's registry is closed before it is removed.
const dir = await mkdtemp(join(tmpdir(), "nexus-registry-"));
after(() => rm(dir, { recursive: true }));
const tempDb = () => join(dir, `${randomUUID()}.db`);

function seeded(path: string) {
  const registry = openRegistry(path);
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  registry.createProject(project);
  registry.createThread(thread, pylon);
  return registry;
}

test("records survive closing and reopening the file", async (t) => {
  const path = tempDb();
  const first = seeded(path);
  const submitted: StoredPylon = {
    ...pylon, pauses: 2, failed: null,
    submitted: { jobId: "j1" as JobId, node, issuedAt: "2027-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:30.000Z", job: { kind: "delete", pylonId } },
    attempts: { count: 1, lastFailedAt: 5, lastCode: "backend" },
  };
  first.savePylon(submitted);
  first.saveImage(image);
  first.setCurrentImage(image.id);
  const template: TemplateRecord = { id: "tpl-000000000000", key: { project: project.id, image: image.id, setupHash: "s" }, state: "building", on: node };
  first.saveTemplate(template);
  first.close();

  const second = openRegistry(path);
  t.after(() => second.close());
  assert.deepEqual(second.projects(), [project]);
  assert.deepEqual(second.thread(threadId), thread);
  assert.deepEqual(second.threads(project.id), [thread]);
  assert.deepEqual(second.threads("other" as ProjectId), []);
  assert.deepEqual(second.pylon(pylonId), submitted);
  assert.deepEqual(second.pylonsOn(node), [submitted]);
  assert.deepEqual(second.image(image.id), image);
  assert.equal(second.currentImage(), image.id);
  assert.deepEqual(second.templates(project.id), [template]);
  assert.deepEqual(second.node(node), { name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT", state: "offline", capacity: null, observation: null });
});

test("a thread and its pylon must match", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const other = { ...thread, id: "th-2" as ThreadId, pylonId: "pylon-th-2" as PylonId };
  assert.throws(() => registry.createThread(other, pylon), /does not belong/);
  assert.equal(registry.thread(other.id), undefined);
});

test("only a recorded image can become current", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  assert.equal(registry.currentImage(), null);
  assert.throws(() => registry.setCurrentImage("img-ffffffffffff"), /no image/);
});

test("activity timestamps only move forward", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  registry.recordActivity(threadId, { human: 5_000, agent: 4_000, agentTurnRunning: true });
  registry.recordActivity(threadId, { human: 2_000, agent: 3_000 });
  registry.apply({ record: "activity", pylonId, human: 1_000, agent: 6_000 });
  assert.deepEqual(
    (({ lastHumanActivityAt, lastAgentActivityAt, agentTurnRunning }) => ({ lastHumanActivityAt, lastAgentActivityAt, agentTurnRunning }))(registry.thread(threadId)!),
    { lastHumanActivityAt: 5_000, lastAgentActivityAt: 6_000, agentTurnRunning: true },
  );
});

test("ingest writes fold into records, and applying one twice changes nothing", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const capacity = { memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 400 };
  const writes = [
    { record: "node", node, state: "online", capacity },
    { record: "session", pylonId, herdrPane: "p1", fact: { herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", status: "working" } },
    { record: "session", pylonId, herdrPane: "p2", fact: { herdrPane: "p2", harness: "shell", harnessSessionId: null, status: "idle" } },
    { record: "session", pylonId, herdrPane: "p2", fact: null },
    { record: "output", pylonId, kind: "branch", ref: "nexus/fix-it" },
    { record: "orphan", node, pylonId: "pylon-stray" as PylonId },
    { record: "job", status: { jobId: "j" as JobId, subject: pylonId, kind: "spawn", state: "running", startedAt: "2027-01-01T00:00:00Z" } },
  ] as const;
  for (const write of [...writes, ...writes]) registry.apply(write);

  assert.equal(registry.node(node)?.state, "online");
  assert.deepEqual(registry.node(node)?.capacity, capacity);
  assert.deepEqual(registry.sessions(pylonId), [{ pylon: pylonId, herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", status: "working" }]);
  assert.deepEqual(registry.outputs(threadId), [{ thread: threadId, kind: "branch", ref: "nexus/fix-it" }]);
  assert.deepEqual(registry.orphans(), [{ node, pylonId: "pylon-stray" }]);

  registry.markOffline(node);
  assert.equal(registry.node(node)?.state, "offline");
});

test("an observation is stored only together with the writes derived from it", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const capacity = { memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 400 };
  const first: NodeObservation = { node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [] };
  registry.ingested(first, [{ record: "node", node, state: "online", capacity }]);
  assert.deepEqual(registry.node(node)?.observation, first);

  const second = { ...first, observedAt: "2027-01-01T00:01:00Z" };
  const fact = { herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "working" } as const;
  // The second write names a pylon the registry does not have, so it fails, and the first must not land either.
  assert.throws(() => registry.ingested(second, [
    { record: "session", pylonId, herdrPane: "p1", fact },
    { record: "session", pylonId: "pylon-unknown" as PylonId, herdrPane: "p1", fact },
  ]));
  assert.deepEqual(registry.node(node)?.observation, first);
  assert.deepEqual(registry.sessions(pylonId), []);
});

test("a job's result is not undone by an older report of it running", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const job = (jobId: string, state: "running" | "succeeded") => ({
    record: "job" as const,
    status: state === "running"
      ? { jobId: jobId as JobId, subject: pylonId, kind: "spawn" as const, state, startedAt: "2027-01-01T00:00:00Z" }
      : { jobId: jobId as JobId, subject: pylonId, kind: "spawn" as const, state, finishedAt: "2027-01-01T00:01:00Z" },
  });
  registry.apply(job("j1", "running"));
  assert.equal(registry.job(pylonId)?.state, "running");
  registry.apply(job("j1", "succeeded"));
  registry.apply(job("j1", "running"));
  assert.equal(registry.job(pylonId)?.state, "succeeded");
  registry.apply(job("j2", "running"));
  assert.deepEqual(registry.job(pylonId), job("j2", "running").status);
});

test("a registry from a newer control plane is refused", async (t) => {
  const path = tempDb();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => openRegistry(path), /schema version 99/);
});
