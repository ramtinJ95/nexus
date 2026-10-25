import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, type StoredPylon, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import type { JobId, LiveHash, NodeName, NodeObservation, PylonId, ServiceFact, TailnetNodeId } from "../protocol.ts";
import type { ProjectId, RemoteProject } from "../project.ts";
import type { ImageManifest, TemplateRecord } from "../images.ts";

const node = "rj-firebat" as NodeName;
const threadId = "th-1" as ThreadId;
const pylonId = "pylon-th-1" as PylonId;
const project: RemoteProject = {
  id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: ["registry.npmjs.org"],
  secrets: [{ name: "TOKEN", hosts: ["api.example.com"] }], logins: ["chatgpt"], preSetup: null,
};
const thread: Thread = {
  seenAt: null, lastReplyAt: null,
  id: threadId, title: "fix it", project: project.id, pylonId, status: "active", conversationId: null, startedBy: "nLAPTOP",
  createdAt: 1_000, agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: 1_000,
};
const { desired: _, ...pylon } = newPylonRecord({
  thread: threadId, pylonId, node, desired: "running",
  boot: {
    pylonId, image: "img-000000000000", resources: project.resources, network: { allowedHosts: ["a.example"], secrets: [] },
    repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "origin/main" } },
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
    gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
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
    attempts: { count: 1, last: { at: 5, code: "backend", message: "pylon-th-1: the controller exited" } },
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
    { record: "sessions", pylonId, sessions: [
      { id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", title: null, status: "working", message: null },
      { id: "p2", state: "running", herdrPane: "p2", harness: "shell", harnessSessionId: null, title: null, status: "idle", message: null },
    ] },
    { record: "sessions", pylonId, sessions: [{ id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", title: null, status: "working", message: null }] },
    { record: "output", pylonId, kind: "branch", ref: "nexus/fix-it" },
    { record: "orphan", node, pylonId: "pylon-stray" as PylonId },
    { record: "job", status: { jobId: "j" as JobId, subject: pylonId, kind: "spawn", state: "running", startedAt: "2027-01-01T00:00:00Z" } },
  ] as const;
  for (const write of [...writes, ...writes]) registry.apply(write);

  assert.equal(registry.node(node)?.state, "online");
  assert.deepEqual(registry.node(node)?.capacity, capacity);
  assert.deepEqual(registry.sessions(pylonId), [{ pylon: pylonId, id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", status: "working", title: null, message: null }]);
  assert.deepEqual(registry.outputs(threadId), [{ thread: threadId, kind: "branch", ref: "nexus/fix-it" }]);
  assert.deepEqual(registry.orphans(), [{ node, pylonId: "pylon-stray" }]);

  registry.markOffline(node);
  assert.equal(registry.node(node)?.state, "offline");
});

test("an observation is stored only together with the writes derived from it", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const capacity = { memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 400 };
  const first: NodeObservation = { node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [], previewRoutes: [] };
  registry.ingested(first, [{ record: "node", node, state: "online", capacity }]);
  assert.deepEqual(registry.node(node)?.observation, first);

  const second = { ...first, observedAt: "2027-01-01T00:01:00Z" };
  const sessions = [{ id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: null, title: null, status: "working", message: null }] as const;
  // The second write names a pylon the registry does not have, so it fails, and the first must not land either.
  assert.throws(() => registry.ingested(second, [
    { record: "sessions", pylonId, sessions },
    { record: "sessions", pylonId: "pylon-unknown" as PylonId, sessions },
  ]));
  assert.deepEqual(registry.node(node)?.observation, first);
  assert.deepEqual(registry.sessions(pylonId), []);
});

test("a paused pylon's sessions keep their rows and last status, and the first list after its wake replaces them", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const review = { id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", title: "review" } as const;
  const plan = { id: "failed-0123456789ab", herdrPane: null, harness: "pi", harnessSessionId: null, title: "plan" } as const;
  registry.apply({ record: "sessions", pylonId, sessions: [{ ...review, state: "running", status: "working", message: null }] });
  registry.apply({ record: "sessions", pylonId, sessions: [{ ...review, state: "paused", status: null, message: null }, { ...plan, state: "paused", status: null, message: null }] });
  assert.deepEqual(registry.sessions(pylonId), [
    { pylon: pylonId, ...plan, state: "paused", status: "unknown", message: null },
    { pylon: pylonId, ...review, state: "paused", status: "working", message: null },
  ], "a paused row keeps the status it last ran with, and one never seen running has none");
  assert.deepEqual(registry.session(pylonId, "w1:p1"), { pylon: pylonId, ...review, state: "paused", status: "working", message: null });
  assert.equal(registry.session(pylonId, "w9:p9"), undefined);

  registry.apply({ record: "sessions", pylonId, sessions: [
    { ...review, id: "w3:p1", herdrPane: "w3:p1", state: "running", status: "idle", message: null },
    { ...plan, state: "failed", status: null, message: "pi exited 1" },
  ] });
  assert.deepEqual(registry.sessions(pylonId), [
    { pylon: pylonId, ...plan, state: "failed", status: "unknown", message: "pi exited 1" },
    { pylon: pylonId, ...review, id: "w3:p1", herdrPane: "w3:p1", state: "running", status: "idle", message: null },
  ], "the pre-pause pane is gone and the failed session says why");

  registry.apply({ record: "sessions-paused", pylonId });
  assert.deepEqual(registry.sessions(pylonId).map((s) => [s.id, s.state, s.message]), [["failed-0123456789ab", "paused", null], ["w3:p1", "paused", null]]);
  registry.apply({ record: "sessions", pylonId, sessions: [] });
  assert.deepEqual(registry.sessions(pylonId), [], "a deleted pylon drops its rows");
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

/** The sessions table as the first schema made it. */
const untitledSessions = `DROP TABLE sessions; CREATE TABLE sessions (pylon TEXT NOT NULL REFERENCES pylons (id), herdr_pane TEXT NOT NULL,
  harness TEXT NOT NULL, harness_session_id TEXT, status TEXT NOT NULL, PRIMARY KEY (pylon, herdr_pane)) STRICT;`;

test("a registry from before failure messages keeps its pylons' attempts", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  /** A file at schema version 1, whose pylon's attempts are in the old shape. */
  const atVersion1 = (attempts: unknown): string => {
    const path = tempDb();
    seeded(path).close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE pylons SET attempts = ?").run(JSON.stringify(attempts));
    db.exec(`ALTER TABLE pylons DROP COLUMN retrying; ${untitledSessions} ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; DROP TABLE pr_watches; PRAGMA user_version = 1`);
    db.close();
    return path;
  };
  const reopened = (path: string) => {
    const registry = openRegistry(path);
    t.after(() => registry.close());
    return registry.pylon(pylonId)!.attempts;
  };
  assert.deepEqual(reopened(atVersion1({ count: 0, lastFailedAt: null, lastCode: null })), { count: 0, last: null });
  assert.deepEqual(reopened(atVersion1({ count: 2, lastFailedAt: 5, lastCode: "backend" })), {
    count: 2, last: { at: 5, code: "backend", message: "recorded before the registry kept failure messages" },
  });
});

test("a registry from before pylon retries opens with no retry under way, and a retry marks only a failed pylon", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDb();
  seeded(path).close();
  const db = new DatabaseSync(path);
  db.exec(`ALTER TABLE pylons DROP COLUMN retrying; ${untitledSessions} ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; DROP TABLE pr_watches; PRAGMA user_version = 3`);
  db.close();
  const registry = openRegistry(path);
  t.after(() => registry.close());
  assert.equal(registry.pylon(pylonId)!.retrying, false);

  assert.equal(registry.retryPylon(pylonId), false, "a pylon that has not failed is left as it is");
  const failed = { ...registry.pylon(pylonId)!, failed: "gave up", attempts: { count: 5, last: { at: 5, code: "backend" as const, message: "m" } } };
  registry.savePylon(failed);
  assert.equal(registry.retryPylon(pylonId), true);
  assert.deepEqual(registry.pylon(pylonId), { ...failed, failed: null, attempts: { count: 0, last: null }, retrying: true });
  assert.equal(registry.retryPylon(pylonId), false, "a second retry finds nothing to clear");
});

test("a registry from a newer control plane is refused", async (t) => {
  const path = tempDb();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => openRegistry(path), /schema version 99/);
});

/** Another thread's pylon on `on`, for tests that need neighbours. */
function addPylon(registry: ReturnType<typeof openRegistry>, id: string, on: NodeName = node): PylonId {
  const other = `pylon-${id}` as PylonId;
  registry.createThread({ ...thread, id: id as ThreadId, pylonId: other }, { ...pylon, thread: id, pylonId: other, node: on, boot: { ...pylon.boot, pylonId: other } });
  return other;
}
const ports = { first: 10200, last: 10209 };
const portsOf = (registry: ReturnType<typeof openRegistry>, of: PylonId) => registry.previews(of).map((p) => `${p.service} ${p.httpsPort}`);

test("preview ports are unique on a node, survive reopening the file, and asking again changes nothing", async (t) => {
  const path = tempDb();
  const first = seeded(path);
  const peer = "infra-testbench" as NodeName;
  first.upsertNode({ name: peer, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nTESTBENCH" as TailnetNodeId });
  const neighbour = addPylon(first, "th-2");
  const elsewhere = addPylon(first, "th-3", peer);
  first.allocatePreviews(pylonId, ["web", "api"], ports);
  first.allocatePreviews(neighbour, ["web"], ports);
  first.allocatePreviews(elsewhere, ["web"], ports);
  first.allocatePreviews(pylonId, ["api", "web", "docs"], ports);
  first.close();

  const second = openRegistry(path);
  t.after(() => second.close());
  assert.deepEqual(portsOf(second, pylonId), ["api 10201", "docs 10203", "web 10200"]);
  assert.deepEqual(portsOf(second, neighbour), ["web 10202"]);
  assert.deepEqual(portsOf(second, elsewhere), ["web 10200"], "another node has its own ports");
  assert.ok(second.previews(pylonId).every((p) => !p.ready), "a new port is not ready until the probe reports it");
});

test("a used-up port range fails naming the range, after allocating the services that fit", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const neighbour = addPylon(registry, "th-2");
  registry.allocatePreviews(neighbour, ["web"], { first: 10200, last: 10201 });
  assert.throws(() => registry.allocatePreviews(pylonId, ["web", "api"], { first: 10200, last: 10201 }),
    /no https port is free for the preview of api: pylons on rj-firebat hold or rj-firebat serves every port from 10200 to 10201/);
  assert.deepEqual(portsOf(registry, pylonId), ["web 10201"]);
});

test("releasing one service's preview frees only its port, which the next service that asks gets", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const neighbour = addPylon(registry, "th-2");
  registry.allocatePreviews(pylonId, ["web", "port-3000"], ports);
  registry.allocatePreviews(neighbour, ["port-3000"], ports);
  registry.releasePreview(pylonId, "port-3000");
  assert.deepEqual(portsOf(registry, pylonId), ["web 10200"]);
  assert.deepEqual(portsOf(registry, neighbour), ["port-3000 10202"], "another pylon's preview of the same name stays");
  registry.releasePreview(pylonId, "port-3000");
  assert.deepEqual(portsOf(registry, pylonId), ["web 10200"], "releasing again changes nothing");
  registry.allocatePreviews(pylonId, ["port-4000"], ports);
  assert.deepEqual(portsOf(registry, pylonId), ["port-4000 10201", "web 10200"]);
});

test("released ports go to the next pylon that asks, and readiness marks only the port a pylon holds", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  registry.allocatePreviews(pylonId, ["web"], ports);
  registry.apply({ record: "preview", pylonId, service: "web", httpsPort: 10299, ready: true });
  assert.equal(registry.previews(pylonId)[0]!.ready, false);
  registry.apply({ record: "preview", pylonId, service: "web", httpsPort: 10200, ready: true });
  assert.equal(registry.previews(pylonId)[0]!.ready, true);

  registry.releasePreviews(pylonId);
  assert.deepEqual(registry.previews(pylonId), []);
  registry.apply({ record: "preview", pylonId, service: "web", httpsPort: 10200, ready: true });
  assert.deepEqual(registry.previews(pylonId), [], "a late report for a released port records nothing");
  const next = addPylon(registry, "th-2");
  registry.allocatePreviews(next, ["web"], ports);
  assert.deepEqual(portsOf(registry, next), ["web 10200"]);
});

test("a published preview is ready only while its running pylon reports its service ready, or does not list it", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  registry.allocatePreviews(pylonId, ["api", "web"], ports);
  registry.apply({ record: "preview", pylonId, service: "api", httpsPort: 10200, ready: true });
  registry.apply({ record: "preview", pylonId, service: "web", httpsPort: 10201, ready: true });
  const observe = (observed: NodeObservation["pylons"][number]) => registry.ingested({
    node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 400 },
    artifacts: [], jobs: [], pylons: [observed], previewRoutes: [],
  }, []);
  const running = (webState: ServiceFact["state"] | null) => observe({
    pylonId, phase: "running", liveHash: null, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: image.id, checkpoint: null },
    services: [
      { name: "api", state: "ready", port: 8080, declared: true, wantsPreview: true },
      ...webState === null ? [] : [{ name: "web", state: webState, port: 8003, declared: true, wantsPreview: true }],
    ],
    listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  });
  const states = () => registry.previews(pylonId).map((p) => [p.service, p.ready, p.failed]);

  running("failed");
  assert.deepEqual(states(), [["api", true, null], ["web", false, "the service web failed. `nexus service logs web` in the pylon shows why"]]);
  running("ready");
  assert.deepEqual(states(), [["api", true, null], ["web", true, null]], "a restarted service's preview is ready again");
  running("starting");
  assert.deepEqual(states(), [["api", true, null], ["web", false, null]], "a starting service's URL answers 502 until it is ready");
  running("stopped");
  assert.deepEqual(states(), [["api", true, null], ["web", false, null]]);
  running(null);
  assert.deepEqual(states(), [["api", true, null], ["web", true, null]], "a service the read does not list is ready once published");
  running("failed");
  observe({ pylonId, phase: "stopped", checkpoint: null, sessions: null });
  assert.deepEqual(states(), [["api", true, null], ["web", true, null]], "a stopped pylon's services are not known to have failed");
});

test("a port the node routes is never handed out, though no row holds it", async (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const routed = (httpsPort: number, owner: string) => ({ httpsPort, pylonId: owner as PylonId, service: "web" });
  registry.ingested({ node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 400 }, artifacts: [], jobs: [], pylons: [],
    previewRoutes: [routed(10200, "pylon-lost"), routed(10201, pylonId)] }, []);
  registry.allocatePreviews(pylonId, ["web", "api"], ports);
  assert.deepEqual(portsOf(registry, pylonId), ["api 10203", "web 10202"], "a route left to this pylon from a lost row is refused too");
});

test("a registry from before session titles keeps its sessions, untitled until they are observed again", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDb();
  seeded(path).close();
  const db = new DatabaseSync(path);
  db.exec(`${untitledSessions} ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; DROP TABLE pr_watches; PRAGMA user_version = 4`);
  db.prepare("INSERT INTO sessions VALUES (?, 'w1:p1', 'claude-code', NULL, 'idle')").run(pylonId);
  db.close();
  const registry = openRegistry(path);
  t.after(() => registry.close());
  assert.deepEqual(registry.sessions(pylonId), [{ pylon: pylonId, id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: null, status: "idle", title: null, message: null }]);
  registry.apply({ record: "sessions", pylonId, sessions: [{ id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s", status: "idle", title: "review", message: null }] });
  assert.equal(registry.sessions(pylonId)[0]!.title, "review");
});

test("a registry from before repository kinds reads every stored repo, booted or submitted, as a clone", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDb();
  const first = seeded(path);
  const envelope = { jobId: "j1" as JobId, node, issuedAt: "2027-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:30.000Z" };
  const spawning: StoredPylon = { ...pylon, submitted: { ...envelope, job: { kind: "spawn", pylonId, boot: { ...pylon.boot, source: pylon.firstBoot }, live: pylon.live, liveHash: pylon.liveHash } } };
  first.savePylon(spawning);
  const deleting = addPylon(first, "th-2");
  const deletion: StoredPylon = { ...first.pylon(deleting)!, submitted: { ...envelope, jobId: "j2" as JobId, job: { kind: "delete", pylonId: deleting } } };
  first.savePylon(deletion);
  first.close();
  const db = new DatabaseSync(path);
  db.exec(`UPDATE pylons SET boot = json_remove(boot, '$.repo.kind'), submitted = CASE WHEN json_extract(submitted, '$.job.kind') = 'spawn'
    THEN json_remove(submitted, '$.job.boot.repo.kind') ELSE submitted END; ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; DROP TABLE pr_watches; PRAGMA user_version = 5`);
  assert.equal((db.prepare("SELECT count(*) AS n FROM pylons WHERE boot LIKE '%\"kind\":\"clone\"%' OR submitted LIKE '%\"clone\"%'").get() as { n: number }).n, 0, "the old shape has no kind");
  db.close();

  const registry = openRegistry(path);
  t.after(() => registry.close());
  assert.deepEqual(registry.pylon(pylonId), spawning);
  assert.deepEqual(registry.pylon(deleting), deletion);
});

test("a registry from before session states keeps its sessions as running in their panes, and holds each state to its fields", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDb();
  seeded(path).close();
  const db = new DatabaseSync(path);
  db.exec(`${untitledSessions} ALTER TABLE sessions ADD COLUMN title TEXT; ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; DROP TABLE pr_watches; PRAGMA user_version = 6`);
  db.prepare("INSERT INTO sessions VALUES (?, 'w1:p1', 'pi', 's.jsonl', 'working', 'plan')").run(pylonId);
  db.close();
  const registry = openRegistry(path);
  t.after(() => registry.close());
  assert.deepEqual(registry.sessions(pylonId), [{ pylon: pylonId, id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "pi", harnessSessionId: "s.jsonl", status: "working", title: "plan", message: null }]);
  const row = { id: "x", herdrPane: null, harness: "pi", harnessSessionId: null, title: null, status: null } as const;
  assert.throws(() => registry.apply({ record: "sessions", pylonId, sessions: [{ ...row, state: "failed", message: null } as never] }), /CHECK constraint/);
  assert.throws(() => registry.apply({ record: "sessions", pylonId, sessions: [{ ...row, state: "running", status: "idle", message: null } as never] }), /CHECK constraint/);
});

test("a registry from before node-unique preview ports keeps its previews", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDb();
  seeded(path).close();
  const db = new DatabaseSync(path);
  db.exec(`DROP TABLE previews;
    CREATE TABLE previews (pylon TEXT NOT NULL REFERENCES pylons (id), service TEXT NOT NULL, https_port INTEGER NOT NULL, ready INTEGER NOT NULL, PRIMARY KEY (pylon, service)) STRICT;
    ALTER TABLE pylons DROP COLUMN retrying;
    ${untitledSessions}
    ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; DROP TABLE pr_watches; PRAGMA user_version = 2;`);
  db.prepare("INSERT INTO previews VALUES (?, 'web', 10200, 1)").run(pylonId);
  db.close();

  const registry = openRegistry(path);
  t.after(() => registry.close());
  assert.deepEqual(registry.previews(pylonId), [{ pylon: pylonId, service: "web", httpsPort: 10200, ready: true, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" }]);
  registry.allocatePreviews(addPylon(registry, "th-2"), ["web"], ports);
  assert.deepEqual(portsOf(registry, "pylon-th-2" as PylonId), ["web 10201"]);
});

test("seen and reply timestamps migrate from null and persist without activity", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDb();
  seeded(path).close();
  const db = new DatabaseSync(path);
  db.exec("ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; DROP TABLE pr_watches; PRAGMA user_version = 7");
  db.close();
  const registry = openRegistry(path);
  assert.equal(registry.thread(threadId)!.seenAt, null);
  assert.equal(registry.thread(threadId)!.lastReplyAt, null);
  registry.markSeen(threadId, true);
  assert.equal(registry.thread(threadId)!.seenAt, null, "no reply to mark unread");
  registry.recordReply(threadId, 2000);
  registry.markSeen(threadId, false, 3000);
  registry.close();
  const reopened = openRegistry(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.thread(threadId), { ...thread, lastReplyAt: 2000, seenAt: 3000 });
  assert.deepEqual(reopened.pylon(pylonId), pylon);
});

test("a reply recorded after seen in the same millisecond is unread and has a new identity", (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  registry.recordReply(threadId, 1000);
  registry.markSeen(threadId, false, 2000);
  registry.recordReply(threadId, 2000);
  const reply = registry.thread(threadId)!;
  assert.equal(reply.seenAt, 2000);
  assert.equal(reply.lastReplyAt, 2001);
  assert.ok(reply.lastReplyAt > reply.seenAt);
  registry.markSeen(threadId, false, 2000, reply.lastReplyAt);
  assert.equal(registry.thread(threadId)!.seenAt, 2001);
  registry.recordReply(threadId, 2000);
  assert.equal(registry.thread(threadId)!.lastReplyAt, 2002);
});

test("adding PR watches preserves the shared seen and reply markers from schema 8", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDb();
  const first = seeded(path);
  first.recordReply(threadId, 2000);
  first.markSeen(threadId, false, 3000);
  first.close();
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE pr_watches; PRAGMA user_version = 8");
  db.close();
  const registry = openRegistry(path);
  t.after(() => registry.close());
  assert.deepEqual(registry.thread(threadId), { ...thread, lastReplyAt: 2000, seenAt: 3000 });
  assert.equal(registry.prWatch(threadId), null);
  const watch = { links: [], commentWakes: 0, pending: null, error: null };
  registry.savePrWatch(threadId, watch);
  assert.deepEqual(registry.prWatch(threadId), watch);
  assert.deepEqual(registry.thread(threadId), { ...thread, lastReplyAt: 2000, seenAt: 3000 });
});
