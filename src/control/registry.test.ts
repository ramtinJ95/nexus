import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, type StoredPylon, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { trackActivity } from "../harness/activity.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, DocumentObserver, LiveState, TaskId } from "@earendil-works/pi-durable";
import type { JobId, LiveHash, NodeName, NodeObservation, PylonId, ServiceFact, TailnetNodeId } from "../protocol.ts";
import type { ProjectId, RemoteProject } from "../project.ts";
import type { ImageManifest, TemplateRecord } from "../images.ts";
import { maxEntries, transcriptStart, type ClaudeEntry } from "../claude-transcript.ts";

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

function seeded(path: string, clock = Date.now) {
  const registry = openRegistry(path, clock);
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
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 400, committedDiskGiB: 0 };
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
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 400, committedDiskGiB: 0 };
  const first: NodeObservation = { node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [] };
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
    db.exec(`ALTER TABLE pylons DROP COLUMN retrying; ${untitledSessions} ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; ALTER TABLE threads DROP COLUMN placement; ALTER TABLE threads DROP COLUMN agent_turn_started_at; DROP TABLE reviews; DROP TABLE claude_transcripts; DROP TABLE claude_entries; DROP TABLE claude_messages; DROP TABLE session_order; DROP TABLE session_order_floor; DROP TABLE events; DROP TABLE session_activity; DROP TABLE event_receipts; DROP TABLE claude_workers; DROP TABLE thread_attention; DROP TABLE release_reports; DROP TABLE pr_watches; PRAGMA user_version = 1`);
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
  db.exec(`ALTER TABLE pylons DROP COLUMN retrying; ${untitledSessions} ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; ALTER TABLE threads DROP COLUMN placement; ALTER TABLE threads DROP COLUMN agent_turn_started_at; DROP TABLE reviews; DROP TABLE claude_transcripts; DROP TABLE claude_entries; DROP TABLE claude_messages; DROP TABLE session_order; DROP TABLE session_order_floor; DROP TABLE events; DROP TABLE session_activity; DROP TABLE event_receipts; DROP TABLE claude_workers; DROP TABLE thread_attention; DROP TABLE release_reports; DROP TABLE pr_watches; PRAGMA user_version = 3`);
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
    node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", capacity: { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 400, committedDiskGiB: 0 },
    artifacts: [], jobs: [], pylons: [observed], grants: { secrets: [], gitSsh: false }, previewRoutes: [],
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
  registry.ingested({ node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", capacity: { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 400, committedDiskGiB: 0 }, artifacts: [], jobs: [], pylons: [],
    grants: { secrets: [], gitSsh: false }, previewRoutes: [routed(10200, "pylon-lost"), routed(10201, pylonId)] }, []);
  registry.allocatePreviews(pylonId, ["web", "api"], ports);
  assert.deepEqual(portsOf(registry, pylonId), ["api 10203", "web 10202"], "a route left to this pylon from a lost row is refused too");
});

test("a registry from before session titles keeps its sessions, untitled until they are observed again", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = tempDb();
  seeded(path).close();
  const db = new DatabaseSync(path);
  db.exec(`${untitledSessions} ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; ALTER TABLE threads DROP COLUMN placement; ALTER TABLE threads DROP COLUMN agent_turn_started_at; DROP TABLE reviews; DROP TABLE claude_transcripts; DROP TABLE claude_entries; DROP TABLE claude_messages; DROP TABLE session_order; DROP TABLE session_order_floor; DROP TABLE events; DROP TABLE session_activity; DROP TABLE event_receipts; DROP TABLE claude_workers; DROP TABLE thread_attention; DROP TABLE release_reports; DROP TABLE pr_watches; PRAGMA user_version = 4`);
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
    THEN json_remove(submitted, '$.job.boot.repo.kind') ELSE submitted END; ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; ALTER TABLE threads DROP COLUMN placement; ALTER TABLE threads DROP COLUMN agent_turn_started_at; DROP TABLE reviews; DROP TABLE claude_transcripts; DROP TABLE claude_entries; DROP TABLE claude_messages; DROP TABLE session_order; DROP TABLE session_order_floor; DROP TABLE events; DROP TABLE session_activity; DROP TABLE event_receipts; DROP TABLE claude_workers; DROP TABLE thread_attention; DROP TABLE release_reports; DROP TABLE pr_watches; PRAGMA user_version = 5`);
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
  db.exec(`${untitledSessions} ALTER TABLE sessions ADD COLUMN title TEXT; ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; ALTER TABLE threads DROP COLUMN placement; ALTER TABLE threads DROP COLUMN agent_turn_started_at; DROP TABLE reviews; DROP TABLE claude_transcripts; DROP TABLE claude_entries; DROP TABLE claude_messages; DROP TABLE session_order; DROP TABLE session_order_floor; DROP TABLE events; DROP TABLE session_activity; DROP TABLE event_receipts; DROP TABLE claude_workers; DROP TABLE thread_attention; DROP TABLE release_reports; DROP TABLE pr_watches; PRAGMA user_version = 6`);
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
    ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; ALTER TABLE threads DROP COLUMN placement; ALTER TABLE threads DROP COLUMN agent_turn_started_at; DROP TABLE reviews; DROP TABLE claude_transcripts; DROP TABLE claude_entries; DROP TABLE claude_messages; DROP TABLE session_order; DROP TABLE session_order_floor; DROP TABLE events; DROP TABLE session_activity; DROP TABLE event_receipts; DROP TABLE claude_workers; DROP TABLE thread_attention; DROP TABLE release_reports; DROP TABLE pr_watches; PRAGMA user_version = 2;`);
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
  db.exec("ALTER TABLE threads DROP COLUMN seen_at; ALTER TABLE threads DROP COLUMN last_reply_at; ALTER TABLE threads DROP COLUMN placement; ALTER TABLE threads DROP COLUMN agent_turn_started_at; DROP TABLE reviews; DROP TABLE claude_transcripts; DROP TABLE claude_entries; DROP TABLE claude_messages; DROP TABLE session_order; DROP TABLE session_order_floor; DROP TABLE events; DROP TABLE session_activity; DROP TABLE event_receipts; DROP TABLE claude_workers; DROP TABLE thread_attention; DROP TABLE release_reports; DROP TABLE pr_watches; PRAGMA user_version = 7");
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
  db.exec("ALTER TABLE threads DROP COLUMN placement; ALTER TABLE threads DROP COLUMN agent_turn_started_at; DROP TABLE reviews; DROP TABLE claude_transcripts; DROP TABLE claude_entries; DROP TABLE claude_messages; DROP TABLE session_order; DROP TABLE session_order_floor; DROP TABLE events; DROP TABLE session_activity; DROP TABLE event_receipts; DROP TABLE claude_workers; DROP TABLE thread_attention; DROP TABLE release_reports; DROP TABLE pr_watches; PRAGMA user_version = 8");
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

test("desired release, reports and drain survive reopening the registry", () => {
  const path = join(dir, `${randomUUID()}.db`);
  const first = openRegistry(path);
  const desired = { commit: "a".repeat(40), requestedBy: "nMac", requestedAt: 100 };
  const report = { node, role: "control" as const, commit: "b".repeat(40), target: desired.commit, state: "rolled-back" as const, reason: "unhealthy", observedAt: 200 };
  first.setDesiredRelease(desired);
  first.reportRelease(report);
  first.setDrain({ commit: desired.commit, expiresAt: 300 });
  first.close();
  const reopened = openRegistry(path);
  try {
    assert.deepEqual(reopened.desiredRelease(), desired);
    assert.deepEqual(reopened.releaseReports(), [report]);
    assert.deepEqual(reopened.drain(), { commit: desired.commit, expiresAt: 300 });
  } finally { reopened.close(); }
});

test("Claude turn events keep a pylon awake until it ends, independently of harness activity and seen", async (t) => {
  const { desiredPhase } = await import("../reconcile.ts");
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const event = (sequence: number, kind: "session.turn-started" | "session.turn-ended" | "session.waiting", session = "c1") => registry.reportSession(node, { sequence, pylon: pylonId, time: Date.now(), event: { kind, session } });
  event(1, "session.turn-started");
  registry.recordActivity(threadId, { agentTurnRunning: false });
  registry.markSeen(threadId, false);
  assert.equal(desiredPhase(registry.thread(threadId)!, Date.now() + 25 * 60_000), "running");
  event(2, "session.turn-ended");
  const ended = registry.thread(threadId)!;
  assert.equal(ended.lastHumanActivityAt, thread.lastHumanActivityAt);
  assert.ok(ended.lastReplyAt);
  assert.equal(desiredPhase(ended, Date.now() + 60 * 60_000), "paused");
  event(2, "session.turn-ended");
  assert.equal(registry.thread(threadId)!.lastReplyAt, ended.lastReplyAt, "replayed observations do not invent another reply");
  event(3, "session.turn-started");
  event(4, "session.waiting");
  assert.equal(desiredPhase(registry.thread(threadId)!, Date.now() + 60 * 60_000), "paused");
  registry.reportSession("other-node" as NodeName, { sequence: 100, pylon: pylonId, time: 0, event: { kind: "session.turn-started" } });
  assert.equal(registry.thread(threadId)!.sessionTurnRunning, undefined);
  assert.equal(registry.events("0", { kinds: ["session.turn-ended"] }).length, 1);
});

test("a lost turn end expires while heartbeats keep a long turn awake", async (t) => {
  const { desiredPhase } = await import("../reconcile.ts");
  const { sessionActivityTtlMs } = await import("../events.ts");
  let now = 10_000_000;
  const registry = seeded(tempDb(), () => now);
  t.after(() => registry.close());
  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.heartbeat") => registry.reportSession(node, {
    sequence: ++sequence, time: now + 1_000_000_000, pylon: pylonId, event: { kind, session: "long" },
  });
  report("session.turn-started");
  const started = registry.thread(threadId)!;
  now += sessionActivityTtlMs;
  assert.equal(desiredPhase(started, now), "paused", "even a previously read thread has a bounded lease");
  assert.equal(registry.thread(threadId)!.sessionTurnRunning, undefined);
  registry.pruneSessions();
  assert.equal(registry.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, null);
  report("session.turn-started");
  for (let i = 0; i < 24; i++) {
    now += 5 * 60_000;
    report("session.heartbeat");
    registry.pruneSessions();
    assert.equal(desiredPhase(registry.thread(threadId)!, now), "running");
  }
  assert.equal(registry.thread(threadId)!.lastHumanActivityAt, thread.lastHumanActivityAt);
  now += sessionActivityTtlMs;
  registry.pruneSessions();
  assert.equal(desiredPhase(registry.thread(threadId)!, now), "paused");
  assert.equal(registry.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, null);
});

test("session state is capped at sixteen, removed at end and pruned with event retention", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { sessionActivityTtlMs, maxActiveSessions } = await import("../events.ts");
  const path = tempDb();
  let now = 10_000_000;
  const registry = seeded(path, () => now);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); registry.close(); });
  const rows = () => db.prepare("SELECT session FROM session_activity WHERE thread = ? ORDER BY rowid").all(threadId).map((r) => r.session);
  for (let i = 1; i <= 10_006; i++) {
    now++;
    registry.reportSession(node, { sequence: i, time: now, pylon: pylonId, event: { kind: "session.turn-started", session: `s${i}` } });
    assert.ok(rows().length <= maxActiveSessions);
  }
  assert.equal(rows().length, 16);
  assert.equal(db.prepare("SELECT count(*) AS n FROM session_order").get()!.n, 32);
  assert.equal(db.prepare("SELECT count(*) AS n FROM session_order_floor").get()!.n, 1);
  assert.equal(rows()[0], "s9991");
  registry.reportSession(node, { sequence: 10_007, time: now, pylon: pylonId, event: { kind: "session.turn-started", session: "s1", at: 0 } });
  assert.equal(rows().includes("s1"), false, "the floor rejects a stale start after its cursor was evicted");
  registry.reportSession(node, { sequence: 10_008, time: now, pylon: pylonId, event: { kind: "session.ended", session: "s10006" } });
  assert.equal(rows().length, 15);
  now += sessionActivityTtlMs;
  registry.appendEvent("release.changed", null, {});
  assert.deepEqual(rows(), []);
  assert.equal(registry.events().length, 10_000);
});

test("waiting survives a day without activity, and clears on end, archive or delete", async (t) => {
  const { desiredPhase } = await import("../reconcile.ts");
  let now = 10_000_000;
  const registry = seeded(tempDb(), () => now);
  t.after(() => registry.close());
  let sequence = 0;
  const report = (kind: "session.waiting" | "session.ended") => registry.reportSession(node, {
    sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session: "question", at: now },
  });
  for (const ending of ["session.ended", "archived", "deleted"] as const) {
    registry.setThreadStatus(threadId, "active");
    now++;
    const before = registry.thread(threadId)!;
    report("session.waiting");
    assert.equal(registry.thread(threadId)!.lastAgentActivityAt, before.lastAgentActivityAt);
    now += 24 * 60 * 60_000;
    registry.pruneSessions();
    registry.appendEvent("release.changed", null, {});
    assert.equal(registry.thread(threadId)!.sessionWaiting, true);
    assert.equal(desiredPhase(registry.thread(threadId)!, now), "paused");
    assert.equal(registry.thread(threadId)!.lastHumanActivityAt, before.lastHumanActivityAt);
    assert.equal(registry.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, "waiting");
    if (ending === "session.ended") report(ending);
    else {
      registry.setThreadStatus(threadId, ending);
      now++;
      report("session.waiting");
    }
    assert.equal(registry.thread(threadId)!.sessionWaiting, undefined);
    assert.equal(registry.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, null);
  }
});

test("ended sessions reject late heartbeats and starts, including after registry restart", () => {
  const path = tempDb();
  let now = 10_000_000;
  let registry = seeded(path, () => now);
  let sequence = 0;
  const report = (kind: import("../events.ts").PylonEvent["kind"], at: number) => {
    now++;
    registry.reportSession(node, { sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session: "c1", at } });
  };
  try {
    for (const ending of ["session.turn-ended", "session.ended"] as const) {
      report("session.turn-started", now);
      const start = now;
      report(ending, now + 10);
      const ended = registry.thread(threadId)!;
      const count = registry.events().length;
      registry.close();
      registry = openRegistry(path, () => now);
      report("session.heartbeat", start + 1);
      report("session.heartbeat", now + 100);
      report("session.turn-started", start + 1);
      report("session.turn-started", start + 10);
      assert.equal(registry.events().length, count, "stale and inactive reports have no side effects");
      assert.equal(registry.thread(threadId)!.sessionTurnRunning, undefined);
      assert.equal(registry.thread(threadId)!.lastAgentActivityAt, ended.lastAgentActivityAt);
      assert.equal(registry.thread(threadId)!.lastReplyAt, ended.lastReplyAt);
      now += 1000;
    }
    report("session.turn-started", now);
    assert.equal(registry.thread(threadId)!.sessionTurnRunning, true, "a genuinely newer turn can start");
  } finally { registry.close(); }
});


test("a report delivered again under a new sequence has no effect", () => {
  let now = 10_000_000;
  const registry = seeded(tempDb(), () => now);
  let sequence = 0;
  const report = (kind: import("../events.ts").PylonEvent["kind"], at: number) => {
    now += 1000;
    registry.reportSession(node, { sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session: "c1", at } });
  };
  try {
    const start = now;
    for (const [kind, at] of [["session.turn-started", start], ["session.heartbeat", start + 1], ["session.waiting", start + 2], ["session.turn-ended", start + 3]] as const) {
      report(kind, at);
      const before = registry.thread(threadId)!;
      const count = registry.events().length;
      report(kind, at);
      assert.equal(registry.events().length, count, `a resent ${kind} appends no event`);
      assert.deepEqual(registry.thread(threadId), before, `a resent ${kind} changes no thread fact`);
    }
  } finally { registry.close(); }
});

test("a newer heartbeat resumes waiting with a fresh lease, while older or equal stamps do not", async (t) => {
  const { desiredPhase } = await import("../reconcile.ts");
  const { sessionActivityTtlMs } = await import("../events.ts");
  let now = 10_000_000;
  const registry = seeded(tempDb(), () => now);
  t.after(() => registry.close());
  let sequence = 0;
  const report = (kind: import("../events.ts").PylonEvent["kind"], at: number) => registry.reportSession(node, {
    sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session: "c1", at },
  });
  const attention = () => registry.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention;
  report("session.turn-started", now);
  now++;
  const waitingAt = now;
  report("session.waiting", waitingAt);
  const waiting = registry.thread(threadId)!;
  const count = registry.events().length;
  now += 24 * 60 * 60_000;
  report("session.heartbeat", waitingAt - 1);
  report("session.heartbeat", waitingAt);
  assert.equal(registry.events().length, count);
  assert.equal(registry.thread(threadId)!.lastAgentActivityAt, waiting.lastAgentActivityAt);
  assert.equal(registry.thread(threadId)!.sessionWaiting, true);
  assert.equal(attention(), "waiting");
  assert.equal(desiredPhase(registry.thread(threadId)!, now), "paused");

  report("session.heartbeat", waitingAt + 1);
  const resumed = registry.thread(threadId)!;
  assert.equal(resumed.sessionWaiting, undefined);
  assert.equal(resumed.sessionTurnRunning, true);
  assert.equal(resumed.sessionActiveUntil, now + sessionActivityTtlMs);
  assert.equal(resumed.lastHumanActivityAt, waiting.lastHumanActivityAt);
  assert.equal(attention(), "working");
  now += 25 * 60_000;
  assert.equal(desiredPhase(registry.thread(threadId)!, now), "running", "the renewed lease outlasts ordinary idle grace");
});

test("a parked harness run that is retried is working since the retry, as the tracker reports it", async (t) => {
  let now = 10_000_000;
  const registry = seeded(tempDb(), () => now);
  t.after(() => registry.close());
  let listener: ((value: LiveState) => Promise<void>) | undefined;
  const observer = {
    watchDoc: async () => ({ value: {}, start: (l: typeof listener) => { listener = l; }, stop: async () => ({}) }),
  } as unknown as DocumentObserver;
  // Wired as the control plane wires them.
  const tracker = trackActivity({ now: () => now, onChange: (id, facts) => registry.recordActivity(id as ThreadId, { agent: facts.lastAgentActivityAt, agentTurnRunning: facts.agentTurnRunning }) });
  await tracker.track(observer, threadId, 7 as ConversationId, false, BACKGROUND_CONTEXT);
  await listener!({ run: { taskId: 1 as TaskId, inputs: [] } });
  assert.equal(registry.thread(threadId)!.workingSince, now, "the run began when its document changed");

  now += 60_000;
  tracker.park(7 as ConversationId, 2 as TaskId);
  assert.equal(registry.thread(threadId)!.workingSince, undefined, "a parked run is not working");
  now += 3 * 3600_000;
  tracker.retried(threadId);
  assert.equal(registry.thread(threadId)!.workingSince, now, "the retried run is working since the retry, not since its last progress");
});

test("a thread is working since the earliest start of its running harness turn and live session turns", async (t) => {
  let now = 10_000_000;
  const registry = seeded(tempDb(), () => now);
  t.after(() => registry.close());
  let sequence = 0;
  const report = (kind: import("../events.ts").PylonEvent["kind"], session: string) => registry.reportSession(node, {
    sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session, at: now },
  });
  const since = () => registry.thread(threadId)!.workingSince;
  assert.equal(since(), undefined, "nothing runs");

  registry.recordActivity(threadId, { agent: now - 4_000, agentTurnRunning: true });
  assert.equal(since(), now - 4_000, "the harness turn began when its tracker saw it flip");
  now += 1_000;
  registry.recordActivity(threadId, { agent: now, agentTurnRunning: true });
  assert.equal(since(), now - 5_000, "a turn still running keeps its start");

  report("session.turn-started", "c1");
  const sessionStart = now;
  assert.equal(since(), now - 5_000, "the earlier of the two starts");
  registry.recordActivity(threadId, { agent: now, agentTurnRunning: false });
  assert.equal(since(), sessionStart, "the session's turn once the harness turn ends");

  now += 5 * 60_000;
  report("session.heartbeat", "c1");
  assert.equal(since(), sessionStart, "a heartbeat keeps the running turn's start");
  report("session.waiting", "c1");
  assert.equal(since(), undefined, "a waiting session is not working");
  now += 60_000;
  report("session.heartbeat", "c1");
  assert.equal(since(), now, "a heartbeat that resumes a waiting session starts a new turn");
  report("session.turn-ended", "c1");
  assert.equal(since(), undefined);

  registry.recordActivity(threadId, { agentTurnRunning: true });
  assert.equal(since(), now, "a turn reported without its activity starts when control hears of it");
});

test("a turn running before turn starts were recorded has no known start", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const now = 10_000_000;
  const path = tempDb();
  seeded(path, () => now).reportSession(node, { sequence: 1, time: now, pylon: pylonId, event: { kind: "session.turn-started", session: "c1", at: now } });
  const db = new DatabaseSync(path);
  const version = db.prepare("PRAGMA user_version").get()!.user_version as number;
  db.exec(`UPDATE threads SET agent_turn_running = 1; ALTER TABLE threads DROP COLUMN placement; ALTER TABLE threads DROP COLUMN agent_turn_started_at; ALTER TABLE session_activity DROP COLUMN started_at; DROP TABLE reviews;
    ALTER TABLE claude_workers DROP COLUMN turn_session; ALTER TABLE claude_workers DROP COLUMN turn_at; ALTER TABLE session_activity DROP COLUMN message; PRAGMA user_version = ${version - 5}`);
  db.close();
  const registry = openRegistry(path, () => now);
  t.after(() => registry.close());
  registry.recordActivity(threadId, { agent: now, agentTurnRunning: true });
  registry.reportSession(node, { sequence: 2, time: now, pylon: pylonId, event: { kind: "session.heartbeat", session: "c1", at: now + 1 } });
  const upgraded = registry.thread(threadId)!;
  assert.equal(upgraded.agentTurnRunning && upgraded.sessionTurnRunning, true);
  assert.equal(upgraded.workingSince, undefined);
});

/**
 * Claude's hooks for one session, as the image's hook reports them: a Stop hook's input decides whether its turn
 * ended. Each report is stamped a second after the last. `hold` runs the hook's detached hold for the last Stop that
 * listed background shells, on the test's clock, and calls `exited` once the command exits.
 */
async function claudeHooks(registry: ReturnType<typeof seeded>, clock: { now: number }) {
  const { holdTurnEnd, reportedKind } = await import("../../images/pylon/nexus-heartbeat.ts");
  type Kind = import("../events.ts").PylonEvent["kind"];
  let sequence = 0;
  const held: number[] = [];
  const send = (kind: Kind, at: number, message?: string) => registry.reportSession(node, {
    sequence: ++sequence, time: clock.now, pylon: pylonId, event: { kind, session: "c1", at, ...(message === undefined ? {} : { message }) },
  });
  const hook = (kind: Kind, input: { background_tasks?: unknown } = {}, at = (clock.now += 1000)) => {
    const reported = reportedKind(kind, input);
    if (reported.shells !== undefined) held.push(at);
    send(reported.kind as Kind, at);
  };
  const hold = (exitsAfterMs: number, exited = () => {}) => {
    const stop = held.pop()!;
    const exit = clock.now + exitsAfterMs;
    let gone = false;
    return holdTurnEnd({ running: async () => clock.now < exit, superseded: async () => false, report: async (kind, message) => { send(kind, stop, message); } }, {
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
        registry.pruneSessions();
        if (!gone && clock.now >= exit) { gone = true; exited(); }
      },
    });
  };
  return Object.assign(hook, { hold });
}
const backgroundSubagent = { id: "ac4719df54252d254", type: "subagent", status: "running", agent_type: "poteto-agent" };
const backgroundShell = { id: "b6fh14jr7", type: "shell", status: "running", command: "npm test" };

test("a main turn that ends while a background subagent runs stays working until the turn its finish starts ends", async (t) => {
  const { desiredPhase } = await import("../reconcile.ts");
  const clock = { now: 10_000_000 };
  const registry = seeded(tempDb(), () => clock.now);
  t.after(() => registry.close());
  const hook = await claudeHooks(registry, clock);
  const attention = () => registry.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention;
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [backgroundSubagent] });
  for (let i = 0; i < 12; i++) {
    clock.now += 5 * 60_000;
    hook("session.heartbeat");
    registry.pruneSessions();
  }
  const working = registry.thread(threadId)!;
  assert.equal(working.sessionTurnRunning, true, "the subagent's tool heartbeats renew the lease for an hour");
  assert.equal(working.lastReplyAt, null);
  assert.equal(attention(), "working");
  assert.equal(desiredPhase(working, clock.now + 25 * 60_000), "running");
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [] });
  const ended = registry.thread(threadId)!;
  assert.equal(ended.sessionTurnRunning, undefined);
  assert.ok(ended.lastReplyAt);
  assert.equal(attention(), "reply");
  assert.equal(registry.events("0", { kinds: ["session.turn-ended"] }).length, 1);
});

test("a background subagent that never reports its finish expires with the session's lease, without a reply", async (t) => {
  const { desiredPhase } = await import("../reconcile.ts");
  const { sessionActivityTtlMs } = await import("../events.ts");
  const clock = { now: 10_000_000 };
  const registry = seeded(tempDb(), () => clock.now);
  t.after(() => registry.close());
  const hook = await claudeHooks(registry, clock);
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [backgroundSubagent] });
  hook("session.heartbeat");
  clock.now += sessionActivityTtlMs;
  registry.pruneSessions();
  const expired = registry.thread(threadId)!;
  assert.equal(expired.sessionTurnRunning, undefined);
  assert.equal(expired.lastReplyAt, null);
  assert.equal(desiredPhase(expired, clock.now), "paused");
  assert.equal(registry.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, null);
});

test("a late background subagent report after its session ended changes nothing", async (t) => {
  const clock = { now: 10_000_000 };
  const registry = seeded(tempDb(), () => clock.now);
  t.after(() => registry.close());
  const hook = await claudeHooks(registry, clock);
  const start = clock.now;
  hook("session.turn-started", {}, start);
  hook("session.turn-ended", { background_tasks: [backgroundSubagent] }, start + 1000);
  hook("session.ended", {}, start + 3000);
  const ended = registry.thread(threadId)!;
  const count = registry.events().length;
  hook("session.heartbeat", {}, start + 2000);
  hook("session.heartbeat", {}, start + 4000);
  hook("session.turn-ended", { background_tasks: [backgroundSubagent] }, start + 5000);
  assert.equal(registry.events().length, count, "stale and inactive reports have no side effects");
  assert.deepEqual(registry.thread(threadId), ended);
});

test("a main turn that ends while a background command runs stays working until the turn its finish starts ends", async (t) => {
  const { desiredPhase } = await import("../reconcile.ts");
  const clock = { now: 10_000_000 };
  const registry = seeded(tempDb(), () => clock.now);
  t.after(() => registry.close());
  const hook = await claudeHooks(registry, clock);
  const attention = () => registry.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention;
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [backgroundShell] });
  await hook.hold(45 * 60_000, () => {
    const running = registry.thread(threadId)!;
    assert.equal(running.sessionTurnRunning, true, "heartbeats outlast the 30-minute lease while the command runs");
    assert.equal(desiredPhase(running, clock.now), "running");
    assert.equal(running.lastReplyAt, null);
    hook("session.turn-started");
  });
  assert.equal(registry.thread(threadId)!.lastReplyAt, null, "the turn the command's finish started makes the held end stale");
  assert.equal(attention(), "working");
  hook("session.turn-ended", { background_tasks: [] });
  assert.ok(registry.thread(threadId)!.lastReplyAt);
  assert.equal(attention(), "reply");
  assert.equal(registry.events("0", { kinds: ["session.turn-ended"] }).length, 1);
});

test("a background command still running at the cap, such as a dev server, ends its turn and waits, saying why", async (t) => {
  const { backgroundShellCapMs, backgroundStillRunning } = await import("../../images/pylon/nexus-heartbeat.ts");
  const clock = { now: 10_000_000 };
  const registry = seeded(tempDb(), () => clock.now);
  t.after(() => registry.close());
  const hook = await claudeHooks(registry, clock);
  const attention = () => registry.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention;
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [backgroundShell] });
  const stop = clock.now;
  await hook.hold(Infinity);
  const ended = registry.thread(threadId)!;
  assert.equal(ended.sessionTurnRunning, undefined);
  assert.ok(ended.lastReplyAt! >= stop + backgroundShellCapMs && ended.lastReplyAt! < stop + backgroundShellCapMs + 2 * 60_000);
  assert.equal(ended.sessionWaitingMessage, backgroundStillRunning);
  assert.deepEqual(registry.events("0", { kinds: ["session.turn-ended"] }).map((e) => e.payload.message), [backgroundStillRunning]);
  assert.equal(attention(), "reply");
  registry.markSeen(threadId, false, clock.now);
  assert.equal(attention(), "waiting", "once the reply is read, the thread still shows the command");
  hook("session.turn-started");
  assert.equal(registry.thread(threadId)!.sessionWaitingMessage, undefined, "the turn the command's finish starts clears it");
});

test("only the stalled worker's launch session restores normal reply and seen attention", (t) => {
  const path = tempDb();
  const first = seeded(path);
  first.setClaudeWorker(threadId, "hello", "starting", undefined, "launch-session");
  first.setClaudeWorker(threadId, "hello", "stalled", "Choose the text style");
  first.appendEvent("thread.failed", threadId, { message: "Choose the text style" });
  first.close();
  const registry = openRegistry(path);
  t.after(() => registry.close());
  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended" | "session.ended", session: string) => registry.reportSession(node, {
    sequence: ++sequence, pylon: pylonId, time: 1000 + sequence, event: { kind, session },
  });
  const attention = () => registry.events("0", { kinds: ["attention.changed"] }).at(-1)?.payload.attention;
  assert.equal(attention(), "failed");
  report("session.turn-started", "another-session");
  assert.equal(registry.claudeWorker(threadId)!.state, "stalled");
  assert.equal(attention(), "failed");
  report("session.ended", "another-session");
  report("session.turn-started", "launch-session");
  assert.deepEqual(registry.claudeWorker(threadId), { model: "claude-opus-5-5", prompt: "hello", state: "started", session: "launch-session" });
  assert.equal(attention(), "working");
  report("session.turn-ended", "launch-session");
  assert.equal(attention(), "reply");
  registry.markSeen(threadId, false);
  assert.equal(attention(), null);
  assert.equal(registry.events("0", { kinds: ["thread.failed"] })[0]!.payload.message, "Choose the text style");
});

const reply = (n: number): ClaudeEntry => ({ kind: "reply", at: n, text: `reply ${n}` });
const cursorAt = (offset: number, skipping = false) => offset === 0 ? transcriptStart : { offset, skipping, before: `hash at ${offset}` };

test("a Claude worker's transcript survives reopening, keeps its newest entries, and starts over for a new session or a replaced file", (t) => {
  const path = tempDb();
  const first = seeded(path);
  const read = (from: number, entries: ClaudeEntry[], to: number, extra: { session?: string; reset?: boolean; readAt?: number; skipping?: boolean } = {}) => ({
    session: extra.session ?? "s1", from: cursorAt(from), entries, cursor: cursorAt(to, extra.skipping), reset: extra.reset ?? false, readAt: extra.readAt ?? to,
  });
  assert.equal(first.appendClaudeRead(threadId, read(0, [reply(0), reply(1)], 100)), true);
  assert.equal(first.appendClaudeRead(threadId, read(0, [reply(0), reply(1)], 100)), false, "a read applied twice changes nothing");
  first.close();

  const second = openRegistry(path);
  t.after(() => second.close());
  assert.deepEqual(second.claudeTranscript(threadId), { session: "s1", cursor: cursorAt(100), dropped: 0, readAt: 100 });
  assert.deepEqual(second.claudeEntries(threadId), [reply(0), reply(1)]);

  const many = Array.from({ length: maxEntries + 5 }, (_, i) => reply(i + 2));
  assert.equal(second.appendClaudeRead(threadId, read(100, many, 200, { skipping: true })), true);
  const kept = second.claudeEntries(threadId);
  assert.equal(kept.length, maxEntries);
  assert.deepEqual([kept[0], kept.at(-1)], [reply(7), reply(maxEntries + 6)], "the newest maxEntries are kept, in order");
  assert.deepEqual(second.claudeTranscript(threadId), { session: "s1", cursor: cursorAt(200, true), dropped: 7, readAt: 200 });
  assert.equal(second.appendClaudeRead(threadId, read(200, [reply(maxEntries + 7)], 300)), false, "a read must start where the reader stands, skipping included");
  assert.equal(second.appendClaudeRead(threadId, { ...read(200, [reply(maxEntries + 7)], 300), from: cursorAt(200, true) }), true);
  assert.deepEqual([second.claudeEntries(threadId)[0], second.claudeEntries(threadId).length, second.claudeTranscript(threadId)!.dropped], [reply(8), maxEntries, 8]);

  second.appendClaudeRead(threadId, read(300, [reply(-1)], 10, { reset: true }));
  assert.deepEqual(second.claudeEntries(threadId), [reply(-1)], "a file that shrank starts the transcript over");
  assert.equal(second.claudeTranscript(threadId)!.dropped, 0);
  assert.equal(second.appendClaudeRead(threadId, read(0, [], 0, { session: "s2", readAt: 400 })), true);
  assert.deepEqual(second.claudeEntries(threadId), [], "another session's transcript replaces the stored one");
  assert.deepEqual(second.claudeTranscript(threadId), { session: "s2", cursor: cursorAt(0), dropped: 0, readAt: 400 });
});

test("a Claude worker's messages answer their resends, and its transcript and messages outlive an archive but not a delete", (t) => {
  const registry = seeded(tempDb());
  t.after(() => registry.close());
  const result = { session: "s1", outcome: "queued", resumed: false } as const;
  registry.setClaudeMessage(threadId, "msg:1", { state: "sending" });
  assert.deepEqual(registry.claudeMessage(threadId, "msg:1"), { state: "sending" });
  registry.setClaudeMessage(threadId, "msg:1", { state: "sent", result });
  assert.deepEqual(registry.claudeMessage(threadId, "msg:1"), { state: "sent", result });
  registry.setClaudeMessage(threadId, "msg:2", { state: "sending" });
  registry.setClaudeMessage(threadId, "msg:2", null);
  assert.equal(registry.claudeMessage(threadId, "msg:2"), undefined, "a send that typed nothing is forgotten");
  registry.setClaudeMessage(threadId, "msg:3", { state: "sending" });
  for (let i = 0; i < 1_000; i++) registry.setClaudeMessage(threadId, `msg:more-${i}`, { state: "sent", result });
  assert.deepEqual(registry.claudeMessage(threadId, "msg:1"), { state: "sent", result }, "however many messages follow, a resend is answered, not typed again");
  assert.deepEqual(registry.claudeMessage(threadId, "msg:3"), { state: "sending" }, "nor is one whose send failed partway");

  registry.appendClaudeRead(threadId, { session: "s1", from: cursorAt(0), entries: [reply(0)], cursor: cursorAt(10), reset: false, readAt: 1 });
  registry.setThreadStatus(threadId, "archived");
  assert.deepEqual(registry.claudeEntries(threadId), [reply(0)], "an archived thread's paused pylon still shows its transcript");
  registry.setThreadStatus(threadId, "deleted");
  assert.equal(registry.claudeTranscript(threadId), undefined);
  assert.deepEqual(registry.claudeEntries(threadId), []);
  assert.equal(registry.claudeMessage(threadId, "msg:more-0"), undefined);
});
