import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRegistry, type Registry } from "./registry.ts";
import type { StoredPylon } from "./thread-store.ts";
import { promptSenders, typeIntoClaude } from "./inbox.ts";
import { senders } from "./agent-protocol.ts";
import { seedRegistry, testPylon, testProject, testRegistry, testReview, testThread, claudeWorkerAt } from "../test-support/registry-kit.ts";
import { rewindTo, versionBefore } from "../test-support/schema-kit.ts";
import { migrations } from "./schema.ts";
import type { QueuedRecord } from "./queue-store.ts";
import type { PullRequest } from "./github.ts";
import type { PylonRecord } from "./tick.ts";
import { trackActivity } from "./harness/activity.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, DocumentObserver, LiveState, TaskId } from "@earendil-works/pi-durable";
import type { JobId, LiveHash, NodeName, ProjectId, PylonId, TailnetNodeId, ThreadId } from "../ids.ts";
import type { NodeObservation, ServiceFact } from "../protocol/observations.ts";
import type { TemplateRecord } from "./templates.ts";
import { parseRecord, transcriptStart, type ClaudeEntry } from "./claude-transcript.ts";
import { maxEntries } from "../contract/streams.ts";
import { runningPylon, stoppedPylon, tempDir, testCapacity, testImage, testObservation } from "../test-support/kit.ts";
import type { WaitingAsk } from "./questions.ts";

const node = "rj-firebat" as NodeName;
const threadId = "th-1" as ThreadId;
const pylonId = "pylon-th-1" as PylonId;
const project = testProject({ allowedHosts: ["registry.npmjs.org"], secrets: [{ name: "TOKEN", hosts: ["api.example.com"] }], logins: ["chatgpt"] });
const thread = testThread({ id: threadId, title: "fix it", createdAt: 1_000, lastHumanActivityAt: 1_000 });
const pylon = testPylon(thread, { node, boot: { network: { allowedHosts: ["a.example"], secrets: [] } } });
const image = testImage({ id: "img-000000000000", sha256: "0".repeat(64) });

// One directory for the file, so each test's registry is closed before it is removed.
const dir = await tempDir("nexus-registry-");
const tempDb = () => join(dir, `${randomUUID()}.db`);
const capacity = testCapacity({ committedMemoryGiB: 8, diskFreeGiB: 400 });

function seed(registry: Registry, claudePrompt?: string) {
  seedRegistry(registry, { project });
  registry.threads.createThread(thread, pylon, claudePrompt === undefined ? {} : { claude: { prompt: claudePrompt } });
  return registry;
}
const seeded = (t: TestContext, path: string, clock?: () => number, claudePrompt?: string) => seed(testRegistry(t, path, clock), claudePrompt);

test("records survive closing and reopening the file", async (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  const submitted: Omit<PylonRecord, "desired"> = {
    ...pylon, pauses: 2, failed: null,
    submitted: { jobId: "j1" as JobId, node, issuedAt: "2027-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:30.000Z", job: { kind: "delete", pylonId } },
    attempts: { count: 1, last: { at: 5, code: "backend", message: "pylon-th-1: the controller exited" } },
  };
  first.threads.savePylon(submitted);
  first.images.saveImage(image, "c".repeat(40));
  first.images.setCurrentImage(image.id);
  const key = { project: project.id, image: image.id, setupHash: "s" };
  const template: TemplateRecord = {
    id: "tpl-000000000000", key, state: "building", on: node, submitted: null,
    inputs: { key, repo: { url: project.repoUrl, branch: "main", commit: "c".repeat(40) }, preSetup: null, allowedHosts: [], resources: project.resources },
  };
  first.images.saveTemplate(template);
  first.close();

  const second = testRegistry(t, path);
  assert.deepEqual(second.projects.projects(), [project]);
  assert.deepEqual(second.threads.thread(threadId), thread);
  assert.deepEqual(second.threads.threads({ project: project.id }), [thread]);
  assert.deepEqual(second.threads.threads({ project: "other" as ProjectId }), []);
  assert.deepEqual(second.threads.pylon(pylonId), submitted);
  assert.deepEqual(second.threads.pylonsOn(node), [submitted]);
  assert.deepEqual(second.images.image(image.id), { ...image, release: "c".repeat(40) });
  assert.equal(second.images.currentImage(), image.id);
  assert.deepEqual(second.images.templates(project.id), [template]);
  assert.deepEqual(second.nodes.node(node), { name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT", state: "offline", capacity: null, observation: null });
});

test("a thread and its pylon must match", async (t) => {
  const registry = seeded(t, tempDb());
  const other = { ...thread, id: "th-2" as ThreadId, pylonId: "pylon-th-2" as PylonId };
  assert.throws(() => registry.threads.createThread(other, pylon), /does not belong/);
  assert.equal(registry.threads.thread(other.id), undefined);
});

test("only a recorded image can become current", async (t) => {
  const registry = seeded(t, tempDb());
  assert.equal(registry.images.currentImage(), null);
  assert.throws(() => registry.images.setCurrentImage("img-ffffffffffff"), /no image/);
});

test("the image a new current one replaces becomes previous, and making it current again swaps them", async (t) => {
  const registry = seeded(t, tempDb());
  const next = { ...image, id: "img-111111111111" as const };
  registry.images.saveImage(image, null);
  registry.images.saveImage(next, null);
  registry.images.setCurrentImage(image.id);
  assert.deepEqual([registry.images.currentImage(), registry.images.previousImage()], [image.id, null], "the first current image replaces none");
  registry.images.setCurrentImage(next.id);
  registry.images.setCurrentImage(next.id);
  assert.deepEqual([registry.images.currentImage(), registry.images.previousImage()], [next.id, image.id], "making the current image current again keeps previous");
  registry.images.setCurrentImage(image.id);
  assert.deepEqual([registry.images.currentImage(), registry.images.previousImage()], [image.id, next.id]);
});

test("a Claude message recorded before senders were reads as unknown, and only its thread tells Nexus's prompts by their prefix", async (t) => {
  const path = tempDb();
  seed(openRegistry(path)).close();
  rewindTo(path, versionBefore(/CREATE TABLE IF NOT EXISTS claude_senders\b/));
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO claude_messages (thread, request_id, state, result) VALUES (?, 'rv-1:1', 'sent', ?)").run(threadId, JSON.stringify({ session: "s1", outcome: "sent", resumed: false }));
  db.close();
  const registry = testRegistry(t, path);
  assert.deepEqual(registry.threads.claudeMessageSenders(threadId), [{ sender: "unknown", sha256: null }]);
  const review = `${senders.review.prefix}\nReview pull request #7.`;
  assert.equal(promptSenders(registry, threadId)(review), "review", "a thread with sends from before the record keeps the prefix");
  assert.equal(promptSenders(registry, threadId)("build the cache"), null);

  const fresh = seeded(t, tempDb());
  assert.equal(promptSenders(fresh, threadId)(review), null, "on a thread whose every send is recorded, an unrecorded prompt is the person's");
  await typeIntoClaude(fresh, threadId, "s1", null, "rv-1:1", review, async () => ({ kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed: false }), "review");
  assert.equal(promptSenders(fresh, threadId)(review), "review");
});

test("a long message Nexus typed, which Claude recorded as a paste, is still Nexus's", async (t) => {
  const registry = seeded(t, tempDb());
  const review = `${senders.review.prefix}\n${"Review pull request #7, every file of it.\n".repeat(100).trim()}`;
  await typeIntoClaude(registry, threadId, "s1", null, "rv-1:1", review, async () => ({ kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed: false }), "review");
  const record = JSON.stringify({ type: "user", timestamp: "2026-11-10T12:00:00.000Z", origin: { kind: "human" }, message: { role: "user", content: `\n\n<pasted_content id="cbe0">\n${review}\n</pasted_content id="cbe0">\n` } });
  const [entry] = parseRecord(record);
  assert.equal(entry?.kind === "prompt" && promptSenders(registry, threadId)(entry.text), "review");
});

test("an image recorded before images carried their release reads as of no known release", async (t) => {
  const path = tempDb();
  seed(openRegistry(path)).close();
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO images (id, manifest) VALUES (?, ?)").run(image.id, JSON.stringify(image));
  db.close();
  const registry = testRegistry(t, path);
  assert.deepEqual(registry.images.images(), [{ ...image, release: null }]);
});

test("activity timestamps only move forward", async (t) => {
  const registry = seeded(t, tempDb());
  registry.threads.recordActivity(threadId, { human: 5_000, agent: 4_000, agentTurnRunning: true });
  registry.threads.recordActivity(threadId, { human: 2_000, agent: 3_000 });
  registry.threads.apply({ record: "activity", pylonId, human: 1_000, agent: 6_000 });
  assert.deepEqual(
    (({ lastHumanActivityAt, lastAgentActivityAt, agentTurnRunning }) => ({ lastHumanActivityAt, lastAgentActivityAt, agentTurnRunning }))(registry.threads.thread(threadId)!),
    { lastHumanActivityAt: 5_000, lastAgentActivityAt: 6_000, agentTurnRunning: true },
  );
});

test("ingest writes fold into records, and applying one twice changes nothing", async (t) => {
  const registry = seeded(t, tempDb());
  const writes = [
    { record: "node", node, state: "online", capacity },
    { record: "sessions", pylonId, sessions: [
      { id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", title: null, status: "working", message: null },
      { id: "p2", state: "running", herdrPane: "p2", harness: "shell", harnessSessionId: null, title: null, status: "idle", message: null },
    ] },
    { record: "sessions", pylonId, sessions: [{ id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", title: null, status: "working", message: null }] },
    { record: "output", pylonId, kind: "branch", ref: "nexus/fix-it" },
    { record: "job", status: { jobId: "j" as JobId, subject: pylonId, kind: "spawn", state: "running", startedAt: "2027-01-01T00:00:00Z" } },
  ] as const;
  for (const write of [...writes, ...writes]) registry.threads.apply(write);

  assert.equal(registry.nodes.node(node)?.state, "online");
  assert.deepEqual(registry.nodes.node(node)?.capacity, capacity);
  assert.deepEqual(registry.threads.sessions(pylonId), [{ pylon: pylonId, id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", status: "working", title: null, message: null }]);
  assert.deepEqual(registry.threads.outputs(threadId), [{ thread: threadId, kind: "branch", ref: "nexus/fix-it" }]);

  registry.nodes.markOffline(node);
  assert.equal(registry.nodes.node(node)?.state, "offline");
});

test("an observation is stored only together with the writes derived from it", async (t) => {
  const registry = seeded(t, tempDb());
  const first = testObservation(node, { observedAt: "2027-01-01T00:00:00Z", capacity });
  registry.threads.ingested(first, [{ record: "node", node, state: "online", capacity }]);
  assert.deepEqual(registry.nodes.node(node)?.observation, first);

  const second = { ...first, observedAt: "2027-01-01T00:01:00Z" };
  const sessions = [{ id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: null, title: null, status: "working", message: null }] as const;
  // The second write names a pylon the registry does not have, so it fails, and the first must not land either.
  assert.throws(() => registry.threads.ingested(second, [
    { record: "sessions", pylonId, sessions },
    { record: "sessions", pylonId: "pylon-unknown" as PylonId, sessions },
  ]));
  assert.deepEqual(registry.nodes.node(node)?.observation, first);
  assert.deepEqual(registry.threads.sessions(pylonId), []);
});

test("a paused pylon's sessions keep their rows and last status, and the first list after its wake replaces them", async (t) => {
  const registry = seeded(t, tempDb());
  const review = { id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", title: "review" } as const;
  const plan = { id: "failed-0123456789ab", herdrPane: null, harness: "pi", harnessSessionId: null, title: "plan" } as const;
  registry.threads.apply({ record: "sessions", pylonId, sessions: [{ ...review, state: "running", status: "working", message: null }] });
  registry.threads.apply({ record: "sessions", pylonId, sessions: [{ ...review, state: "paused", status: null, message: null }, { ...plan, state: "paused", status: null, message: null }] });
  assert.deepEqual(registry.threads.sessions(pylonId), [
    { pylon: pylonId, ...plan, state: "paused", status: "unknown", message: null },
    { pylon: pylonId, ...review, state: "paused", status: "working", message: null },
  ], "a paused row keeps the status it last ran with, and one never seen running has none");
  assert.deepEqual(registry.threads.session(pylonId, "w1:p1"), { pylon: pylonId, ...review, state: "paused", status: "working", message: null });
  assert.equal(registry.threads.session(pylonId, "w9:p9"), undefined);

  registry.threads.apply({ record: "sessions", pylonId, sessions: [
    { ...review, id: "w3:p1", herdrPane: "w3:p1", state: "running", status: "idle", message: null },
    { ...plan, state: "failed", status: null, message: "pi exited 1" },
  ] });
  assert.deepEqual(registry.threads.sessions(pylonId), [
    { pylon: pylonId, ...plan, state: "failed", status: "unknown", message: "pi exited 1" },
    { pylon: pylonId, ...review, id: "w3:p1", herdrPane: "w3:p1", state: "running", status: "idle", message: null },
  ], "the pre-pause pane is gone and the failed session says why");

  registry.threads.apply({ record: "sessions-paused", pylonId });
  assert.deepEqual(registry.threads.sessions(pylonId).map((s) => [s.id, s.state, s.message]), [["failed-0123456789ab", "paused", null], ["w3:p1", "paused", null]]);
  registry.threads.apply({ record: "sessions-resumed", pylonId });
  assert.deepEqual(registry.threads.sessions(pylonId).map((s) => [s.id, s.state, s.status, s.message]), [
    ["failed-0123456789ab", "failed", "unknown", "its last wake did not bring it back, and whether this one did is not read yet"],
    ["w3:p1", "running", "unknown", null],
  ], "a pylon that runs again before a read has no paused session");
  registry.threads.apply({ record: "sessions-paused", pylonId });
  registry.threads.apply({ record: "sessions", pylonId, sessions: [] });
  assert.deepEqual(registry.threads.sessions(pylonId), [], "a deleted pylon drops its rows");
});

test("a job's result is not undone by an older report of it running", async (t) => {
  const registry = seeded(t, tempDb());
  const job = (jobId: string, state: "running" | "succeeded") => ({
    record: "job" as const,
    status: state === "running"
      ? { jobId: jobId as JobId, subject: pylonId, kind: "spawn" as const, state, startedAt: "2027-01-01T00:00:00Z" }
      : { jobId: jobId as JobId, subject: pylonId, kind: "spawn" as const, state, finishedAt: "2027-01-01T00:01:00Z" },
  });
  registry.threads.apply(job("j1", "running"));
  assert.equal(registry.threads.job(pylonId)?.state, "running");
  registry.threads.apply(job("j1", "succeeded"));
  registry.threads.apply(job("j1", "running"));
  assert.equal(registry.threads.job(pylonId)?.state, "succeeded");
  registry.threads.apply(job("j2", "running"));
  assert.deepEqual(registry.threads.job(pylonId), job("j2", "running").status);
});

test("a registry from before failure messages keeps its pylons' attempts", (t) => {
  /** A file at schema version 1, whose pylon's attempts are in the old shape. */
  const atVersion1 = (attempts: unknown): string => {
    const path = tempDb();
    seed(openRegistry(path)).close();
    rewindTo(path, 1);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE pylons SET attempts = ?").run(JSON.stringify(attempts));
    db.close();
    return path;
  };
  const reopened = (path: string) => {
    const registry = testRegistry(t, path);
    return registry.threads.pylon(pylonId)!.attempts;
  };
  assert.deepEqual(reopened(atVersion1({ count: 0, lastFailedAt: null, lastCode: null })), { count: 0, last: null });
  assert.deepEqual(reopened(atVersion1({ count: 2, lastFailedAt: 5, lastCode: "backend" })), {
    count: 2, last: { at: 5, code: "backend", message: "recorded before the registry kept failure messages" },
  });
});

test("a registry from before pylon retries opens with no retry under way, and a retry marks only a failed pylon", (t) => {
  const path = tempDb();
  seed(openRegistry(path)).close();
  rewindTo(path, 3);
  const registry = testRegistry(t, path);
  assert.equal(registry.threads.pylon(pylonId)!.retrying, false);

  assert.equal(registry.threads.retryPylon(pylonId), false, "a pylon that has not failed is left as it is");
  const failed = { ...registry.threads.pylon(pylonId)!, failed: "gave up", attempts: { count: 5, last: { at: 5, code: "backend" as const, message: "m" } } };
  registry.threads.savePylon(failed);
  assert.equal(registry.threads.retryPylon(pylonId), true);
  assert.deepEqual(registry.threads.pylon(pylonId), { ...failed, failed: null, attempts: { count: 0, last: null }, retrying: true });
  assert.equal(registry.threads.retryPylon(pylonId), false, "a second retry finds nothing to clear");
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
function addPylon(registry: ReturnType<typeof openRegistry>, id: string, on: NodeName = node, claudePrompt?: string): PylonId {
  const other = `pylon-${id}` as PylonId;
  registry.threads.createThread({ ...thread, id: id as ThreadId, pylonId: other }, { ...pylon, thread: id, pylonId: other, node: on, boot: { ...pylon.boot, pylonId: other } }, claudePrompt === undefined ? {} : { claude: { prompt: claudePrompt } });
  return other;
}
const ports = { first: 10200, last: 10209 };
const portsOf = (registry: ReturnType<typeof openRegistry>, of: PylonId) => registry.threads.previews(of).map((p) => `${p.service} ${p.httpsPort}`);

test("preview ports are unique on a node, survive reopening the file, and asking again changes nothing", async (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  const peer = "infra-testbench" as NodeName;
  first.nodes.upsertNode({ name: peer, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nTESTBENCH" as TailnetNodeId });
  const neighbour = addPylon(first, "th-2");
  const elsewhere = addPylon(first, "th-3", peer);
  first.threads.allocatePreviews(pylonId, ["web", "api"], ports);
  first.threads.allocatePreviews(neighbour, ["web"], ports);
  first.threads.allocatePreviews(elsewhere, ["web"], ports);
  first.threads.allocatePreviews(pylonId, ["api", "web", "docs"], ports);
  first.close();

  const second = testRegistry(t, path);
  assert.deepEqual(portsOf(second, pylonId), ["api 10201", "docs 10203", "web 10200"]);
  assert.deepEqual(portsOf(second, neighbour), ["web 10202"]);
  assert.deepEqual(portsOf(second, elsewhere), ["web 10200"], "another node has its own ports");
  assert.ok(second.threads.previews(pylonId).every((p) => !p.ready), "a new port is not ready until the probe reports it");
});

test("a used-up port range fails naming the range, after allocating the services that fit", async (t) => {
  const registry = seeded(t, tempDb());
  const neighbour = addPylon(registry, "th-2");
  registry.threads.allocatePreviews(neighbour, ["web"], { first: 10200, last: 10201 });
  assert.throws(() => registry.threads.allocatePreviews(pylonId, ["web", "api"], { first: 10200, last: 10201 }),
    /no https port is free for the preview of api: pylons on rj-firebat hold or rj-firebat serves every port from 10200 to 10201/);
  assert.deepEqual(portsOf(registry, pylonId), ["web 10201"]);
});

test("releasing one service's preview frees only its port, which the next service that asks gets", async (t) => {
  const registry = seeded(t, tempDb());
  const neighbour = addPylon(registry, "th-2");
  registry.threads.allocatePreviews(pylonId, ["web", "port-3000"], ports);
  registry.threads.allocatePreviews(neighbour, ["port-3000"], ports);
  registry.threads.releasePreview(pylonId, "port-3000");
  assert.deepEqual(portsOf(registry, pylonId), ["web 10200"]);
  assert.deepEqual(portsOf(registry, neighbour), ["port-3000 10202"], "another pylon's preview of the same name stays");
  registry.threads.releasePreview(pylonId, "port-3000");
  assert.deepEqual(portsOf(registry, pylonId), ["web 10200"], "releasing again changes nothing");
  registry.threads.allocatePreviews(pylonId, ["port-4000"], ports);
  assert.deepEqual(portsOf(registry, pylonId), ["port-4000 10201", "web 10200"]);
});

test("released ports go to the next pylon that asks, and readiness marks only the port a pylon holds", async (t) => {
  const registry = seeded(t, tempDb());
  registry.threads.allocatePreviews(pylonId, ["web"], ports);
  registry.threads.apply({ record: "preview", pylonId, service: "web", httpsPort: 10299, ready: true });
  assert.equal(registry.threads.previews(pylonId)[0]!.ready, false);
  registry.threads.apply({ record: "preview", pylonId, service: "web", httpsPort: 10200, ready: true });
  assert.equal(registry.threads.previews(pylonId)[0]!.ready, true);

  registry.threads.releasePreviews(pylonId);
  assert.deepEqual(registry.threads.previews(pylonId), []);
  registry.threads.apply({ record: "preview", pylonId, service: "web", httpsPort: 10200, ready: true });
  assert.deepEqual(registry.threads.previews(pylonId), [], "a late report for a released port records nothing");
  const next = addPylon(registry, "th-2");
  registry.threads.allocatePreviews(next, ["web"], ports);
  assert.deepEqual(portsOf(registry, next), ["web 10200"]);
});

test("a published preview is ready only while its running pylon reports its service ready, or does not list it", async (t) => {
  const registry = seeded(t, tempDb());
  registry.threads.allocatePreviews(pylonId, ["api", "web"], ports);
  registry.threads.apply({ record: "preview", pylonId, service: "api", httpsPort: 10200, ready: true });
  registry.threads.apply({ record: "preview", pylonId, service: "web", httpsPort: 10201, ready: true });
  const observe = (observed: NodeObservation["pylons"][number]) => registry.threads.ingested(testObservation(node, { observedAt: "2027-01-01T00:00:00Z", capacity, pylons: [observed] }), []);
  const running = (webState: ServiceFact["state"] | null) => observe(runningPylon(pylonId, {
    services: [
      { name: "api", state: "ready", port: 8080, declared: true, wantsPreview: true },
      ...webState === null ? [] : [{ name: "web", state: webState, port: 8003, declared: true, wantsPreview: true }],
    ],
  }));
  const states = () => registry.threads.previews(pylonId).map((p) => [p.service, p.ready, p.failed]);

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
  observe(stoppedPylon(pylonId, { sessions: null }));
  assert.deepEqual(states(), [["api", true, null], ["web", true, null]], "a stopped pylon's services are not known to have failed");
});

test("a port the node routes is never handed out, though no row holds it", async (t) => {
  const registry = seeded(t, tempDb());
  const routed = (httpsPort: number, owner: string) => ({ httpsPort, pylonId: owner as PylonId, service: "web" });
  registry.threads.ingested(testObservation(node, { observedAt: "2027-01-01T00:00:00Z", capacity, previewRoutes: [routed(10200, "pylon-lost"), routed(10201, pylonId)] }), []);
  registry.threads.allocatePreviews(pylonId, ["web", "api"], ports);
  assert.deepEqual(portsOf(registry, pylonId), ["api 10203", "web 10202"], "a route left to this pylon from a lost row is refused too");
});

test("previews and allocatePreviews answer the same with the node's observation passed, and use the routes of the one passed", async (t) => {
  const withIt = seeded(t, tempDb());
  const without = seeded(t, tempDb());
  const observation = testObservation(node, {
    observedAt: "2027-01-01T00:00:00Z", capacity, previewRoutes: [{ httpsPort: 10200, pylonId: "pylon-lost" as PylonId, service: "web" }],
    pylons: [runningPylon(pylonId, { services: [{ name: "web", state: "failed", port: 8000, declared: true, wantsPreview: true }] })],
  });
  for (const registry of [withIt, without]) registry.threads.ingested(observation, []);
  withIt.threads.allocatePreviews(pylonId, ["web", "api"], ports, withIt.nodes.node(node)!.observation);
  without.threads.allocatePreviews(pylonId, ["web", "api"], ports);
  assert.deepEqual(withIt.threads.previews(pylonId, withIt.nodes.node(node)!.observation), without.threads.previews(pylonId));
  assert.deepEqual(portsOf(without, pylonId), ["api 10202", "web 10201"]);
  assert.equal(without.threads.previews(pylonId).find((p) => p.service === "web")!.failed, "the service web failed. `nexus service logs web` in the pylon shows why");

  const neighbour = addPylon(without, "th-2");
  without.threads.allocatePreviews(neighbour, ["web"], ports, { ...observation, previewRoutes: [...observation.previewRoutes, { httpsPort: 10203, pylonId: "pylon-lost" as PylonId, service: "api" }] });
  assert.deepEqual(portsOf(without, neighbour), ["web 10204"], "a port the passed observation routes is not handed out");
});

test("an observation stored from a probe older than route reporting routes no port", async (t) => {
  const registry = seeded(t, tempDb());
  registry.threads.ingested({ node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", events: [], capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 400 }, artifacts: [], jobs: [], pylons: [] } as never, []);
  registry.threads.allocatePreviews(pylonId, ["web", "api"], ports);
  assert.deepEqual(portsOf(registry, pylonId), ["api 10201", "web 10200"]);
});

test("a registry from before session titles keeps its sessions, untitled until they are observed again", (t) => {
  const path = tempDb();
  seed(openRegistry(path)).close();
  rewindTo(path, 4);
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO sessions VALUES (?, 'w1:p1', 'claude-code', NULL, 'idle')").run(pylonId);
  db.close();
  const registry = testRegistry(t, path);
  assert.deepEqual(registry.threads.sessions(pylonId), [{ pylon: pylonId, id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: null, status: "idle", title: null, message: null }]);
  registry.threads.apply({ record: "sessions", pylonId, sessions: [{ id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s", status: "idle", title: "review", message: null }] });
  assert.equal(registry.threads.sessions(pylonId)[0]!.title, "review");
});

test("a registry from before repository kinds reads every stored repo, booted or submitted, as a clone", (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  const envelope = { jobId: "j1" as JobId, node, issuedAt: "2027-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:30.000Z" };
  const spawning: Omit<PylonRecord, "desired"> = { ...pylon, submitted: { ...envelope, job: { kind: "spawn", pylonId, boot: { ...pylon.boot, source: pylon.firstBoot }, live: pylon.live, liveHash: pylon.liveHash } } };
  first.threads.savePylon(spawning);
  const deleting = addPylon(first, "th-2");
  const deletion: StoredPylon = { ...first.threads.pylon(deleting)!, submitted: { ...envelope, jobId: "j2" as JobId, job: { kind: "delete", pylonId: deleting } } };
  first.threads.savePylon(deletion);
  first.close();
  rewindTo(path, 5);
  const db = new DatabaseSync(path);
  db.exec(`UPDATE pylons SET boot = json_remove(boot, '$.repo.kind'), submitted = CASE WHEN json_extract(submitted, '$.job.kind') = 'spawn'
    THEN json_remove(submitted, '$.job.boot.repo.kind') ELSE submitted END`);
  assert.equal((db.prepare("SELECT count(*) AS n FROM pylons WHERE boot LIKE '%\"kind\":\"clone\"%' OR submitted LIKE '%\"clone\"%'").get() as { n: number }).n, 0, "the old shape has no kind");
  db.close();

  const registry = testRegistry(t, path);
  assert.deepEqual(registry.threads.pylon(pylonId), spawning);
  assert.deepEqual(registry.threads.pylon(deleting), deletion);
});

test("a registry from before session states keeps its sessions as running in their panes, and holds each state to its fields", (t) => {
  const path = tempDb();
  seed(openRegistry(path)).close();
  rewindTo(path, 6);
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO sessions VALUES (?, 'w1:p1', 'pi', 's.jsonl', 'working', 'plan')").run(pylonId);
  db.close();
  const registry = testRegistry(t, path);
  assert.deepEqual(registry.threads.sessions(pylonId), [{ pylon: pylonId, id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "pi", harnessSessionId: "s.jsonl", status: "working", title: "plan", message: null }]);
  const row = { id: "x", herdrPane: null, harness: "pi", harnessSessionId: null, title: null, status: null } as const;
  assert.throws(() => registry.threads.apply({ record: "sessions", pylonId, sessions: [{ ...row, state: "failed", message: null } as never] }), /CHECK constraint/);
  assert.throws(() => registry.threads.apply({ record: "sessions", pylonId, sessions: [{ ...row, state: "running", status: "idle", message: null } as never] }), /CHECK constraint/);
});

test("a registry from before node-unique preview ports keeps its previews", (t) => {
  const path = tempDb();
  seed(openRegistry(path)).close();
  rewindTo(path, 2);
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO previews VALUES (?, 'web', 10200, 1)").run(pylonId);
  db.close();

  const registry = testRegistry(t, path);
  assert.deepEqual(registry.threads.previews(pylonId), [{ pylon: pylonId, service: "web", httpsPort: 10200, ready: true, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" }]);
  registry.threads.allocatePreviews(addPylon(registry, "th-2"), ["web"], ports);
  assert.deepEqual(portsOf(registry, "pylon-th-2" as PylonId), ["web 10201"]);
});

test("seen and reply timestamps migrate from null and persist without activity", (t) => {
  const path = tempDb();
  seed(openRegistry(path)).close();
  rewindTo(path, 7);
  const registry = openRegistry(path);
  assert.equal(registry.threads.thread(threadId)!.seenAt, null);
  assert.equal(registry.threads.thread(threadId)!.lastReplyAt, null);
  registry.threads.markSeen(threadId, true);
  assert.equal(registry.threads.thread(threadId)!.seenAt, null, "no reply to mark unread");
  registry.threads.recordReply(threadId, 2000);
  registry.threads.markSeen(threadId, false, 3000);
  registry.close();
  const reopened = testRegistry(t, path);
  assert.deepEqual(reopened.threads.thread(threadId), { ...thread, lastReplyAt: 2000, seenAt: 3000 });
  assert.deepEqual(reopened.threads.pylon(pylonId), pylon);
});

test("a reply recorded after seen in the same millisecond is unread and has a new identity", (t) => {
  const registry = seeded(t, tempDb());
  registry.threads.recordReply(threadId, 1000);
  registry.threads.markSeen(threadId, false, 2000);
  registry.threads.recordReply(threadId, 2000);
  const reply = registry.threads.thread(threadId)!;
  assert.equal(reply.seenAt, 2000);
  assert.equal(reply.lastReplyAt, 2001);
  assert.ok(reply.lastReplyAt > reply.seenAt);
  registry.threads.markSeen(threadId, false, 2000, reply.lastReplyAt);
  assert.equal(registry.threads.thread(threadId)!.seenAt, 2001);
  registry.threads.recordReply(threadId, 2000);
  assert.equal(registry.threads.thread(threadId)!.lastReplyAt, 2002);
});

test("seen with no time given is the registry clock's now", (t) => {
  const registry = seeded(t, tempDb(), () => 5000);
  registry.threads.recordReply(threadId, 2000);
  registry.threads.markSeen(threadId, false);
  assert.equal(registry.threads.thread(threadId)!.seenAt, 5000);
});

test("adding PR watches preserves the shared seen and reply markers from schema 8", (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  first.threads.recordReply(threadId, 2000);
  first.threads.markSeen(threadId, false, 3000);
  first.close();
  rewindTo(path, 8);
  const registry = testRegistry(t, path);
  assert.deepEqual(registry.threads.thread(threadId), { ...thread, lastReplyAt: 2000, seenAt: 3000 });
  assert.equal(registry.prWatches.prWatch(threadId), null);
  const watch = { links: [], commentWakes: 0, pending: null, error: null };
  registry.prWatches.savePrWatch(threadId, watch);
  assert.deepEqual(registry.prWatches.prWatch(threadId), watch);
  assert.deepEqual(registry.threads.thread(threadId), { ...thread, lastReplyAt: 2000, seenAt: 3000 });
});

test("a PR watch's save fires pull-request.linked once for each PR it has read, with the PR", (t) => {
  const registry = seeded(t, tempDb());
  const pr: PullRequest = { repo: "acme/repo", number: 1, title: "Fix", url: "https://github.com/acme/repo/pull/1", state: "open", checks: "none", review: "none", conflict: null };
  const save = (...prs: PullRequest[]) => registry.prWatches.savePrWatch(threadId, { links: prs.map((p) => ({ pr: p, seen: [], failed: false })), commentWakes: 0, pending: null, error: null });
  const linked = () => registry.threads.events("0", { kinds: ["pull-request.linked"] }).map((e) => [e.thread, e.payload]);
  save({ ...pr, title: "", url: "" });
  assert.deepEqual(linked(), [], "a placeholder the watch has not read is not linked yet");
  save(pr);
  save({ ...pr, checks: "passing" });
  save({ ...pr, state: "closed" });
  save({ ...pr, state: "open" });
  assert.deepEqual(linked(), [[threadId, { repo: "acme/repo", number: 1, url: pr.url, title: "Fix", state: "open" }]]);
  save(pr, { ...pr, number: 2, url: "https://github.com/acme/repo/pull/2", state: "merged" });
  assert.deepEqual(linked().map(([, p]) => (p as { number: number }).number), [1, 2]);
  assert.equal((linked()[1]![1] as { state: string }).state, "merged", "a PR first read merged is linked merged");
});

test("asking a question twice keeps one, its thread needs a decision until it is answered, and an answer is never replaced", (t) => {
  const path = tempDb();
  const registry = seed(openRegistry(path));
  const ask = { kind: "holds" as const, id: "qn-1", thread: threadId, text: "Rebuild the image?", options: ["Rebuild", "Not now"], reserved: "image-rebuild" as const, answerer: "deployer" as const, askedAt: 5, holds: { review: "rv-1", head: "h", base: null, holds: [] } };
  const asked = registry.questions.askQuestion(ask);
  assert.deepEqual(asked, { ...ask, answer: null });
  assert.deepEqual(registry.questions.askQuestion({ ...ask, text: "Something else?", askedAt: 6 }), asked, "asking again under one ID answers the first question");
  assert.deepEqual(registry.questions.questions(threadId), [asked]);
  assert.equal(registry.threads.attention(threadId), "decision");

  const answer = { option: "Not now", by: "nLAPTOP" as TailnetNodeId, at: 7 };
  assert.deepEqual(registry.questions.answerQuestion(registry.questions.question("qn-1")!, answer), { ...asked, answer });
  assert.equal(registry.threads.attention(threadId), null);
  assert.deepEqual(registry.questions.answerQuestion(registry.questions.question("qn-1")!, { option: "Rebuild", by: "nPHONE" as TailnetNodeId, at: 8 }).answer, answer, "the first answer stays");
  assert.deepEqual(registry.threads.events("0", { kinds: ["attention.changed"] }).map((e) => e.payload), [{ attention: "decision" }, { attention: null }]);
  registry.close();
  const reopened = testRegistry(t, path);
  assert.deepEqual(reopened.questions.question("qn-1"), { ...asked, answer });
  assert.equal(reopened.questions.question("qn-2"), null);
});

test("questions asked in one millisecond list in the order they were asked, before and after an answer", (t) => {
  const registry = seeded(t, tempDb());
  const ask = { kind: "judgment" as const, thread: threadId, failure: 0, options: ["Yes", "No"], reserved: null, answerer: "person" as const, askedAt: 5 };
  registry.questions.askQuestion({ ...ask, id: "qn-b", text: "First?" });
  registry.questions.askQuestion({ ...ask, id: "qn-a", text: "Second?" });
  assert.deepEqual(registry.questions.questions(threadId).map((q) => q.id), ["qn-b", "qn-a"]);
  for (const id of ["qn-b", "qn-a"]) {
    registry.questions.answerQuestion(registry.questions.question(id)!, { option: "Yes", by: "nLAPTOP" as TailnetNodeId, at: 6 });
    assert.deepEqual(registry.questions.questions(threadId).map((q) => q.id), ["qn-b", "qn-a"], `answering ${id} keeps the order`);
  }
});

test("desired release, reports and drain survive reopening the registry", () => {
  const path = join(dir, `${randomUUID()}.db`);
  const first = openRegistry(path);
  const desired = { commit: "a".repeat(40), requestedBy: "nMac", requestedAt: 100 };
  const report = { node, role: "control" as const, commit: "b".repeat(40), target: desired.commit, state: "rolled-back" as const, reason: "unhealthy", observedAt: 200 };
  first.releases.setDesiredRelease(desired);
  first.releases.reportRelease(report);
  first.releases.setDrain({ commit: desired.commit, expiresAt: 300 });
  first.close();
  const reopened = openRegistry(path);
  try {
    assert.deepEqual(reopened.releases.desiredRelease(), desired);
    assert.deepEqual(reopened.releases.releaseReports(), [report]);
    assert.deepEqual(reopened.releases.drain(), { commit: desired.commit, expiresAt: 300 });
  } finally { reopened.close(); }
});

test("Claude turn events keep a pylon awake until it ends, independently of harness activity and seen", async (t) => {
  const { desiredPhase } = await import("./reconcile.ts");
  const registry = seeded(t, tempDb());
  const event = (sequence: number, kind: "session.turn-started" | "session.turn-ended" | "session.waiting", session = "c1") => registry.threads.reportSession(node, { sequence, pylon: pylonId, time: Date.now(), event: { kind, session } });
  event(1, "session.turn-started");
  registry.threads.recordActivity(threadId, { agentTurnRunning: false });
  registry.threads.markSeen(threadId, false);
  assert.equal(desiredPhase(registry.threads.thread(threadId)!, Date.now() + 25 * 60_000), "running");
  event(2, "session.turn-ended");
  const ended = registry.threads.thread(threadId)!;
  assert.equal(ended.lastHumanActivityAt, thread.lastHumanActivityAt);
  assert.ok(ended.lastReplyAt);
  assert.equal(desiredPhase(ended, Date.now() + 60 * 60_000), "paused");
  event(2, "session.turn-ended");
  assert.equal(registry.threads.thread(threadId)!.lastReplyAt, ended.lastReplyAt, "replayed observations do not invent another reply");
  event(3, "session.turn-started");
  event(4, "session.waiting");
  assert.equal(desiredPhase(registry.threads.thread(threadId)!, Date.now() + 60 * 60_000), "paused");
  registry.threads.reportSession("other-node" as NodeName, { sequence: 100, pylon: pylonId, time: 0, event: { kind: "session.turn-started" } });
  assert.equal(registry.threads.thread(threadId)!.sessionTurnRunning, undefined);
  assert.equal(registry.threads.events("0", { kinds: ["session.turn-ended"] }).length, 1);
});

test("a lost turn end expires while heartbeats keep a long turn awake", async (t) => {
  const { desiredPhase } = await import("./reconcile.ts");
  const { sessionActivityTtlMs } = await import("./events.ts");
  let now = 10_000_000;
  const registry = seeded(t, tempDb(), () => now);
  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.heartbeat") => registry.threads.reportSession(node, {
    sequence: ++sequence, time: now + 1_000_000_000, pylon: pylonId, event: { kind, session: "long" },
  });
  report("session.turn-started");
  const started = registry.threads.thread(threadId)!;
  now += sessionActivityTtlMs;
  assert.equal(desiredPhase(started, now), "paused", "even a previously read thread has a bounded lease");
  assert.equal(registry.threads.thread(threadId)!.sessionTurnRunning, undefined);
  registry.threads.pruneSessions();
  assert.equal(registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, null);
  report("session.turn-started");
  for (let i = 0; i < 24; i++) {
    now += 5 * 60_000;
    report("session.heartbeat");
    registry.threads.pruneSessions();
    assert.equal(desiredPhase(registry.threads.thread(threadId)!, now), "running");
  }
  assert.equal(registry.threads.thread(threadId)!.lastHumanActivityAt, thread.lastHumanActivityAt);
  now += sessionActivityTtlMs;
  registry.threads.pruneSessions();
  assert.equal(desiredPhase(registry.threads.thread(threadId)!, now), "paused");
  assert.equal(registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, null);
});

test("session state is capped at sixteen, removed at end and pruned with event retention", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { sessionActivityTtlMs, maxActiveSessions } = await import("./events.ts");
  const path = tempDb();
  let now = 10_000_000;
  const registry = seed(openRegistry(path, () => now));
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); registry.close(); });
  const rows = () => db.prepare("SELECT session FROM session_activity WHERE thread = ? ORDER BY rowid").all(threadId).map((r) => r.session);
  for (let i = 1; i <= 10_006; i++) {
    now++;
    registry.threads.reportSession(node, { sequence: i, time: now, pylon: pylonId, event: { kind: "session.turn-started", session: `s${i}` } });
    assert.ok(rows().length <= maxActiveSessions);
  }
  assert.equal(rows().length, 16);
  assert.equal(db.prepare("SELECT count(*) AS n FROM session_order").get()!.n, 32);
  assert.equal(db.prepare("SELECT count(*) AS n FROM session_order_floor").get()!.n, 1);
  assert.equal(rows()[0], "s9991");
  registry.threads.reportSession(node, { sequence: 10_007, time: now, pylon: pylonId, event: { kind: "session.turn-started", session: "s1", at: 0 } });
  assert.equal(rows().includes("s1"), false, "the floor rejects a stale start after its cursor was evicted");
  registry.threads.reportSession(node, { sequence: 10_008, time: now, pylon: pylonId, event: { kind: "session.ended", session: "s10006" } });
  assert.equal(rows().length, 15);
  now += sessionActivityTtlMs;
  registry.threads.pruneSessions();
  registry.threads.retainEvents();
  assert.deepEqual(rows(), []);
  assert.equal(registry.threads.events().length, 10_000);
});

test("waiting survives a day without activity, and clears on end, archive or delete", async (t) => {
  const { desiredPhase } = await import("./reconcile.ts");
  let now = 10_000_000;
  const registry = seeded(t, tempDb(), () => now);
  let sequence = 0;
  const report = (kind: "session.waiting" | "session.ended") => registry.threads.reportSession(node, {
    sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session: "question", at: now },
  });
  for (const ending of ["session.ended", "archived", "deleted"] as const) {
    registry.threads.setThreadStatus(threadId, "active");
    now++;
    const before = registry.threads.thread(threadId)!;
    report("session.waiting");
    assert.equal(registry.threads.thread(threadId)!.lastAgentActivityAt, before.lastAgentActivityAt);
    now += 24 * 60 * 60_000;
    registry.threads.pruneSessions();
    registry.threads.appendEvent("release.changed", null, {});
    assert.equal(registry.threads.thread(threadId)!.sessionWaiting, true);
    assert.equal(desiredPhase(registry.threads.thread(threadId)!, now), "paused");
    assert.equal(registry.threads.thread(threadId)!.lastHumanActivityAt, before.lastHumanActivityAt);
    assert.equal(registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, "waiting");
    if (ending === "session.ended") report(ending);
    else {
      registry.threads.setThreadStatus(threadId, ending);
      now++;
      report("session.waiting");
    }
    assert.equal(registry.threads.thread(threadId)!.sessionWaiting, undefined);
    assert.equal(registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, null);
  }
});

test("ended sessions reject late heartbeats and starts, including after registry restart", () => {
  const path = tempDb();
  let now = 10_000_000;
  let registry = seed(openRegistry(path, () => now));
  let sequence = 0;
  const report = (kind: import("../protocol/observations.ts").PylonEvent["kind"], at: number) => {
    now++;
    registry.threads.reportSession(node, { sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session: "c1", at } });
  };
  try {
    for (const ending of ["session.turn-ended", "session.ended"] as const) {
      report("session.turn-started", now);
      const start = now;
      report(ending, now + 10);
      const ended = registry.threads.thread(threadId)!;
      const count = registry.threads.events().length;
      registry.close();
      registry = openRegistry(path, () => now);
      report("session.heartbeat", start + 1);
      report("session.heartbeat", now + 100);
      report("session.turn-started", start + 1);
      report("session.turn-started", start + 10);
      assert.equal(registry.threads.events().length, count, "stale and inactive reports have no side effects");
      assert.equal(registry.threads.thread(threadId)!.sessionTurnRunning, undefined);
      assert.equal(registry.threads.thread(threadId)!.lastAgentActivityAt, ended.lastAgentActivityAt);
      assert.equal(registry.threads.thread(threadId)!.lastReplyAt, ended.lastReplyAt);
      now += 1000;
    }
    report("session.turn-started", now);
    assert.equal(registry.threads.thread(threadId)!.sessionTurnRunning, true, "a genuinely newer turn can start");
  } finally { registry.close(); }
});


test("an outbox event sent again under its ID has no effect, even after another event at its stamp", () => {
  let now = 10_000_000;
  const registry = seed(openRegistry(tempDb(), () => now));
  let sequence = 0;
  const report = (kind: import("../protocol/observations.ts").PylonEvent["kind"], at: number, id: string) => {
    now += 1000;
    registry.threads.reportSession(node, { sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session: "c1", at, id } });
  };
  try {
    const start = now;
    for (const [kind, at, id] of [["session.turn-started", start, "a"], ["session.heartbeat", start + 1, "b"], ["session.waiting", start + 2, "c"], ["session.turn-ended", start + 3, "d"]] as const) {
      report(kind, at, id);
      const before = registry.threads.thread(threadId)!;
      const count = registry.threads.events().length;
      report(kind, at, id);
      assert.equal(registry.threads.events().length, count, `a resent ${kind} appends no event`);
      assert.deepEqual(registry.threads.thread(threadId), before, `a resent ${kind} changes no thread fact`);
    }
    report("session.ended", start + 3, "e");
    const ended = registry.threads.thread(threadId)!;
    const count = registry.threads.events().length;
    report("session.turn-ended", start + 3, "d");
    assert.equal(registry.threads.events().length, count);
    assert.equal(registry.threads.thread(threadId)!.lastReplyAt, ended.lastReplyAt, "the resent turn end records no second reply");
  } finally { registry.close(); }
});

test("distinct reports at the same stamp all apply, with or without IDs", () => {
  let now = 10_000_000;
  const registry = seed(openRegistry(tempDb(), () => now));
  let sequence = 0;
  const at = now;
  try {
    for (const ids of [["w1", "w2"], [undefined, undefined]]) {
      const count = registry.threads.events("0", { kinds: ["session.waiting"] }).length;
      ids.forEach((id, i) => {
        now += 1000;
        registry.threads.reportSession(node, { sequence: ++sequence, time: now, pylon: pylonId, event: { kind: "session.waiting", session: `c-${ids[0]}`, at, message: `Approve file ${i}`, ...(id === undefined ? {} : { id }) } });
      });
      assert.deepEqual(registry.threads.events("0", { kinds: ["session.waiting"] }).slice(count).map((e) => e.payload.message), ["Approve file 0", "Approve file 1"]);
    }
  } finally { registry.close(); }
});

test("a newer heartbeat resumes waiting with a fresh lease, while older or equal stamps do not", async (t) => {
  const { desiredPhase } = await import("./reconcile.ts");
  const { sessionActivityTtlMs } = await import("./events.ts");
  let now = 10_000_000;
  const registry = seeded(t, tempDb(), () => now);
  let sequence = 0;
  const report = (kind: import("../protocol/observations.ts").PylonEvent["kind"], at: number) => registry.threads.reportSession(node, {
    sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session: "c1", at },
  });
  const attention = () => registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention;
  report("session.turn-started", now);
  now++;
  const waitingAt = now;
  report("session.waiting", waitingAt);
  const waiting = registry.threads.thread(threadId)!;
  const count = registry.threads.events().length;
  now += 24 * 60 * 60_000;
  report("session.heartbeat", waitingAt - 1);
  report("session.heartbeat", waitingAt);
  assert.equal(registry.threads.events().length, count);
  assert.equal(registry.threads.thread(threadId)!.lastAgentActivityAt, waiting.lastAgentActivityAt);
  assert.equal(registry.threads.thread(threadId)!.sessionWaiting, true);
  assert.equal(attention(), "waiting");
  assert.equal(desiredPhase(registry.threads.thread(threadId)!, now), "paused");

  report("session.heartbeat", waitingAt + 1);
  const resumed = registry.threads.thread(threadId)!;
  assert.equal(resumed.sessionWaiting, undefined);
  assert.equal(resumed.sessionTurnRunning, true);
  assert.equal(resumed.sessionActiveUntil, now + sessionActivityTtlMs);
  assert.equal(resumed.lastHumanActivityAt, waiting.lastHumanActivityAt);
  assert.equal(attention(), "working");
  now += 25 * 60_000;
  assert.equal(desiredPhase(registry.threads.thread(threadId)!, now), "running", "the renewed lease outlasts ordinary idle grace");
});

test("a repeated parked report changes nothing, and a later process's report clears a stale one", (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  const changes = (registry: ReturnType<typeof openRegistry>) => registry.threads.events().filter((e) => e.thread === threadId)
    .map((e) => e.kind === "attention.changed" ? `attention ${String(e.payload.attention)}` : e.kind);
  first.threads.recordParked(threadId, true);
  first.threads.recordParked(threadId, true);
  assert.deepEqual(changes(first), ["thread.parked", "attention parked"]);
  first.close();

  const second = testRegistry(t, path);
  second.threads.recordParked(threadId, false);
  second.threads.recordParked(threadId, false);
  assert.deepEqual(changes(second), ["thread.parked", "attention parked", "attention null"]);
});

test("opening the registry stores the attention of a thread whose attention was never stored", (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  first.threads.recordReply(threadId, 1000);
  assert.equal(first.threads.attention(threadId), "reply");
  first.close();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM thread_attention");
  db.close();

  const second = testRegistry(t, path);
  assert.equal(second.threads.attention(threadId), "reply");
  assert.equal(second.threads.events("0", { kinds: ["attention.changed"], thread: threadId }).at(-1)!.payload.attention, "reply");
});

test("opening the registry asks the features whether a thread whose attention was never stored needs a decision", (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  first.questions.askQuestion({ kind: "holds", id: "qn-1", thread: threadId, text: "Rebuild the image?", options: ["Rebuild", "Not now"], reserved: "image-rebuild", answerer: "deployer", askedAt: 5, holds: { review: "rv-1", head: "h", base: null, holds: [] } });
  first.close();
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM thread_attention");
  db.close();

  assert.equal(testRegistry(t, path).threads.attention(threadId), "decision");
});

test("opening the registry clears the parked flag a thread deleted while parked kept", (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  first.threads.recordParked(threadId, true);
  first.close();
  const db = new DatabaseSync(path);
  db.exec(`UPDATE threads SET status = 'deleted'`);
  db.close();

  const second = testRegistry(t, path);
  assert.equal(second.threads.attention(threadId), null);
  assert.equal(second.threads.events("0", { kinds: ["attention.changed"], thread: threadId }).at(-1)!.payload.attention, null);
});

test("a parked harness run that is retried is working since the retry, as the tracker reports it", async (t) => {
  let now = 10_000_000;
  const registry = seeded(t, tempDb(), () => now);
  let listener: ((value: LiveState) => Promise<void>) | undefined;
  const observer = {
    watchDoc: async () => ({ value: {}, start: (l: typeof listener) => { listener = l; }, stop: async () => ({}) }),
  } as unknown as DocumentObserver;
  // Wired as the control plane wires them.
  const tracker = trackActivity({ now: () => now, onChange: (id, facts) => registry.threads.recordActivity(id as ThreadId, { agent: facts.lastAgentActivityAt, agentTurnRunning: facts.agentTurnRunning }) });
  await tracker.track(observer, threadId, 7 as ConversationId, false, BACKGROUND_CONTEXT);
  await listener!({ run: { taskId: 1 as TaskId, inputs: [] } });
  assert.equal(registry.threads.thread(threadId)!.workingSince, now, "the run began when its document changed");

  now += 60_000;
  tracker.park(7 as ConversationId, 2 as TaskId);
  assert.equal(registry.threads.thread(threadId)!.workingSince, undefined, "a parked run is not working");
  now += 3 * 3600_000;
  tracker.retried(threadId);
  assert.equal(registry.threads.thread(threadId)!.workingSince, now, "the retried run is working since the retry, not since its last progress");
});

test("a thread is working since the earliest start of its running harness turn and live session turns", async (t) => {
  let now = 10_000_000;
  const registry = seeded(t, tempDb(), () => now);
  let sequence = 0;
  const report = (kind: import("../protocol/observations.ts").PylonEvent["kind"], session: string) => registry.threads.reportSession(node, {
    sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session, at: now },
  });
  const since = () => registry.threads.thread(threadId)!.workingSince;
  assert.equal(since(), undefined, "nothing runs");

  registry.threads.recordActivity(threadId, { agent: now - 4_000, agentTurnRunning: true });
  assert.equal(since(), now - 4_000, "the harness turn began when its tracker saw it flip");
  now += 1_000;
  registry.threads.recordActivity(threadId, { agent: now, agentTurnRunning: true });
  assert.equal(since(), now - 5_000, "a turn still running keeps its start");

  report("session.turn-started", "c1");
  const sessionStart = now;
  assert.equal(since(), now - 5_000, "the earlier of the two starts");
  registry.threads.recordActivity(threadId, { agent: now, agentTurnRunning: false });
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

  registry.threads.recordActivity(threadId, { agentTurnRunning: true });
  assert.equal(since(), now, "a turn reported without its activity starts when control hears of it");
});

test("a thread works while its harness turn or a live session turn runs, such as a Claude worker's", async (t) => {
  const { sessionActivityTtlMs } = await import("./events.ts");
  let now = 10_000_000;
  const registry = seeded(t, tempDb(), () => now);
  let sequence = 0;
  const report = (kind: import("../protocol/observations.ts").PylonEvent["kind"]) => registry.threads.reportSession(node, {
    sequence: ++sequence, time: now, pylon: pylonId, event: { kind, session: "c1", at: now },
  });
  const working = () => registry.threads.thread(threadId)!.working;
  assert.equal(working(), false, "nothing runs");
  report("session.turn-started");
  assert.equal(working(), true, "the session's turn runs while no harness turn does");
  report("session.waiting");
  assert.equal(working(), false, "a waiting session is not working");
  now += 1_000;
  report("session.heartbeat");
  assert.equal(working(), true);
  report("session.turn-ended");
  assert.equal(working(), false);
  registry.threads.recordActivity(threadId, { agent: now, agentTurnRunning: true });
  assert.equal(working(), true, "the harness turn runs");
  registry.threads.recordActivity(threadId, { agent: now, agentTurnRunning: false });
  report("session.turn-started");
  now += sessionActivityTtlMs;
  assert.equal(working(), false, "a session's turn stops working when its lease runs out");
});

test("a turn running before turn starts were recorded has no known start", (t) => {
  const now = 10_000_000;
  const path = tempDb();
  const first = seed(openRegistry(path, () => now));
  first.threads.reportSession(node, { sequence: 1, time: now, pylon: pylonId, event: { kind: "session.turn-started", session: "c1", at: now } });
  first.close();
  rewindTo(path, versionBefore(/agent_turn_started_at/));
  const db = new DatabaseSync(path);
  db.exec("UPDATE threads SET agent_turn_running = 1");
  db.close();
  const registry = testRegistry(t, path, () => now);
  registry.threads.recordActivity(threadId, { agent: now, agentTurnRunning: true });
  registry.threads.reportSession(node, { sequence: 2, time: now, pylon: pylonId, event: { kind: "session.heartbeat", session: "c1", at: now + 1 } });
  const upgraded = registry.threads.thread(threadId)!;
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
  type Kind = import("../protocol/observations.ts").PylonEvent["kind"];
  let sequence = 0;
  const held: number[] = [];
  const send = (kind: Kind, at: number, message?: string) => registry.threads.reportSession(node, {
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
        registry.threads.pruneSessions();
        if (!gone && clock.now >= exit) { gone = true; exited(); }
      },
    });
  };
  return Object.assign(hook, { hold });
}
const backgroundSubagent = { id: "ac4719df54252d254", type: "subagent", status: "running", agent_type: "poteto-agent" };
const backgroundShell = { id: "b6fh14jr7", type: "shell", status: "running", command: "npm test" };

test("a main turn that ends while a background subagent runs stays working until the turn its finish starts ends", async (t) => {
  const { desiredPhase } = await import("./reconcile.ts");
  const clock = { now: 10_000_000 };
  const registry = seeded(t, tempDb(), () => clock.now);
  const hook = await claudeHooks(registry, clock);
  const attention = () => registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention;
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [backgroundSubagent] });
  for (let i = 0; i < 12; i++) {
    clock.now += 5 * 60_000;
    hook("session.heartbeat");
    registry.threads.pruneSessions();
  }
  const working = registry.threads.thread(threadId)!;
  assert.equal(working.sessionTurnRunning, true, "the subagent's tool heartbeats renew the lease for an hour");
  assert.equal(working.lastReplyAt, null);
  assert.equal(attention(), "working");
  assert.equal(desiredPhase(working, clock.now + 25 * 60_000), "running");
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [] });
  const ended = registry.threads.thread(threadId)!;
  assert.equal(ended.sessionTurnRunning, undefined);
  assert.ok(ended.lastReplyAt);
  assert.equal(attention(), "reply");
  assert.equal(registry.threads.events("0", { kinds: ["session.turn-ended"] }).length, 1);
});

test("a background subagent that never reports its finish expires with the session's lease, without a reply", async (t) => {
  const { desiredPhase } = await import("./reconcile.ts");
  const { sessionActivityTtlMs } = await import("./events.ts");
  const clock = { now: 10_000_000 };
  const registry = seeded(t, tempDb(), () => clock.now);
  const hook = await claudeHooks(registry, clock);
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [backgroundSubagent] });
  hook("session.heartbeat");
  clock.now += sessionActivityTtlMs;
  registry.threads.pruneSessions();
  const expired = registry.threads.thread(threadId)!;
  assert.equal(expired.sessionTurnRunning, undefined);
  assert.equal(expired.lastReplyAt, null);
  assert.equal(desiredPhase(expired, clock.now), "paused");
  assert.equal(registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention, null);
});

test("a late background subagent report after its session ended changes nothing", async (t) => {
  const clock = { now: 10_000_000 };
  const registry = seeded(t, tempDb(), () => clock.now);
  const hook = await claudeHooks(registry, clock);
  const start = clock.now;
  hook("session.turn-started", {}, start);
  hook("session.turn-ended", { background_tasks: [backgroundSubagent] }, start + 1000);
  hook("session.ended", {}, start + 3000);
  const ended = registry.threads.thread(threadId)!;
  const count = registry.threads.events().length;
  hook("session.heartbeat", {}, start + 2000);
  hook("session.heartbeat", {}, start + 4000);
  hook("session.turn-ended", { background_tasks: [backgroundSubagent] }, start + 5000);
  assert.equal(registry.threads.events().length, count, "stale and inactive reports have no side effects");
  assert.deepEqual(registry.threads.thread(threadId), ended);
});

test("a main turn that ends while a background command runs stays working until the turn its finish starts ends", async (t) => {
  const { desiredPhase } = await import("./reconcile.ts");
  const clock = { now: 10_000_000 };
  const registry = seeded(t, tempDb(), () => clock.now);
  const hook = await claudeHooks(registry, clock);
  const attention = () => registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention;
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [backgroundShell] });
  await hook.hold(45 * 60_000, () => {
    const running = registry.threads.thread(threadId)!;
    assert.equal(running.sessionTurnRunning, true, "heartbeats outlast the 30-minute lease while the command runs");
    assert.equal(desiredPhase(running, clock.now), "running");
    assert.equal(running.lastReplyAt, null);
    hook("session.turn-started");
  });
  assert.equal(registry.threads.thread(threadId)!.lastReplyAt, null, "the turn the command's finish started makes the held end stale");
  assert.equal(attention(), "working");
  hook("session.turn-ended", { background_tasks: [] });
  assert.ok(registry.threads.thread(threadId)!.lastReplyAt);
  assert.equal(attention(), "reply");
  assert.equal(registry.threads.events("0", { kinds: ["session.turn-ended"] }).length, 1);
});

test("a background command still running at the cap, such as a dev server, ends its turn and waits, saying why", async (t) => {
  const { backgroundShellCapMs, backgroundStillRunning } = await import("../../images/pylon/nexus-heartbeat.ts");
  const clock = { now: 10_000_000 };
  const registry = seeded(t, tempDb(), () => clock.now);
  const hook = await claudeHooks(registry, clock);
  const attention = () => registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)!.payload.attention;
  hook("session.turn-started");
  hook("session.turn-ended", { background_tasks: [backgroundShell] });
  const stop = clock.now;
  await hook.hold(Infinity);
  const ended = registry.threads.thread(threadId)!;
  assert.equal(ended.sessionTurnRunning, undefined);
  assert.ok(ended.lastReplyAt! >= stop + backgroundShellCapMs && ended.lastReplyAt! < stop + backgroundShellCapMs + 2 * 60_000);
  assert.equal(ended.sessionWaitingMessage, backgroundStillRunning);
  assert.deepEqual(registry.threads.events("0", { kinds: ["session.turn-ended"] }).map((e) => e.payload.message), [backgroundStillRunning]);
  assert.equal(attention(), "reply");
  registry.threads.markSeen(threadId, false, clock.now);
  assert.equal(attention(), "waiting", "once the reply is read, the thread still shows the command");
  hook("session.turn-started");
  assert.equal(registry.threads.thread(threadId)!.sessionWaitingMessage, undefined, "the turn the command's finish starts clears it");
});

test("only the stalled worker's launch session restores normal reply and seen attention", (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path), "hello");
  claudeWorkerAt(first, threadId, "stalled", { session: "launch-session", message: "Choose the text style" });
  first.close();
  const registry = testRegistry(t, path);
  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended" | "session.ended", session: string) => registry.threads.reportSession(node, {
    sequence: ++sequence, pylon: pylonId, time: 1000 + sequence, event: { kind, session },
  });
  const attention = () => registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)?.payload.attention;
  assert.equal(attention(), "failed");
  report("session.turn-started", "another-session");
  assert.equal(registry.threads.claudeWorker(threadId)!.state, "stalled");
  assert.equal(attention(), "failed");
  report("session.ended", "another-session");
  report("session.turn-started", "launch-session");
  assert.deepEqual(registry.threads.claudeWorker(threadId), { model: "claude-opus-5-5", prompt: "hello", state: "started", session: "launch-session" });
  assert.equal(attention(), "working");
  report("session.turn-ended", "launch-session");
  assert.equal(attention(), "reply");
  registry.threads.markSeen(threadId, false);
  assert.equal(attention(), null);
  assert.equal(registry.threads.events("0", { kinds: ["thread.failed"] })[0]!.payload.message, "Choose the text style");
});

const reply = (n: number): ClaudeEntry => ({ kind: "reply", at: n, text: `reply ${n}` });
const cursorAt = (offset: number, skipping = false) => offset === 0 ? transcriptStart : { offset, skipping, before: `hash at ${offset}` };

test("a Claude worker's transcript survives reopening, keeps its newest entries, and starts over for a new session or a replaced file", (t) => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  const read = (from: number, entries: ClaudeEntry[], to: number, extra: { session?: string; reset?: boolean; readAt?: number; skipping?: boolean } = {}) => ({
    session: extra.session ?? "s1", from: cursorAt(from), entries, cursor: cursorAt(to, extra.skipping), reset: extra.reset ?? false, readAt: extra.readAt ?? to,
  });
  assert.equal(first.threads.appendClaudeRead(threadId, read(0, [reply(0), reply(1)], 100)), true);
  assert.equal(first.threads.appendClaudeRead(threadId, read(0, [reply(0), reply(1)], 100)), false, "a read applied twice changes nothing");
  first.close();

  const second = testRegistry(t, path);
  assert.deepEqual(second.threads.claudeTranscript(threadId), { session: "s1", cursor: cursorAt(100), dropped: 0, readAt: 100 });
  assert.deepEqual(second.threads.claudeEntries(threadId), [reply(0), reply(1)]);

  const many = Array.from({ length: maxEntries + 5 }, (_, i) => reply(i + 2));
  assert.equal(second.threads.appendClaudeRead(threadId, read(100, many, 200, { skipping: true })), true);
  const kept = second.threads.claudeEntries(threadId);
  assert.equal(kept.length, maxEntries);
  assert.deepEqual([kept[0], kept.at(-1)], [reply(7), reply(maxEntries + 6)], "the newest maxEntries are kept, in order");
  assert.deepEqual(second.threads.claudeTranscript(threadId), { session: "s1", cursor: cursorAt(200, true), dropped: 7, readAt: 200 });
  assert.equal(second.threads.appendClaudeRead(threadId, read(200, [reply(maxEntries + 7)], 300)), false, "a read must start where the reader stands, skipping included");
  assert.equal(second.threads.appendClaudeRead(threadId, { ...read(200, [reply(maxEntries + 7)], 300), from: cursorAt(200, true) }), true);
  assert.deepEqual([second.threads.claudeEntries(threadId)[0], second.threads.claudeEntries(threadId).length, second.threads.claudeTranscript(threadId)!.dropped], [reply(8), maxEntries, 8]);
  assert.deepEqual(second.threads.claudeEntries(threadId, 8 + maxEntries - 2), [reply(maxEntries + 6), reply(maxEntries + 7)], "the entries from one, numbered on from the dropped");

  second.threads.appendClaudeRead(threadId, read(300, [reply(-1)], 10, { reset: true }));
  assert.deepEqual(second.threads.claudeEntries(threadId), [reply(-1)], "a file that shrank starts the transcript over");
  assert.equal(second.threads.claudeTranscript(threadId)!.dropped, 0);
  assert.equal(second.threads.appendClaudeRead(threadId, read(0, [], 0, { session: "s2", readAt: 400 })), true);
  assert.deepEqual(second.threads.claudeEntries(threadId), [], "another session's transcript replaces the stored one");
  assert.deepEqual(second.threads.claudeTranscript(threadId), { session: "s2", cursor: cursorAt(0), dropped: 0, readAt: 400 });
});

test("a finished disk delete restarts the transcript, keeping its entries for the new file, and clears that pylon's failure, once", (t) => {
  const registry = seeded(t, tempDb());
  const read = (from: number, entries: ClaudeEntry[], to: number, reset = false) => ({ session: "s1", from: cursorAt(from), entries, cursor: cursorAt(to), reset, readAt: to });
  assert.equal(registry.threads.appendClaudeRead(threadId, read(0, [reply(0), reply(1)], 100)), true);
  registry.threads.savePylon({ ...registry.threads.pylon(pylonId)!, failed: "gave up", attempts: { count: 5, last: { at: 1, code: "backend", message: "boom" } }, retrying: true });
  registry.threads.finishDiskDelete(pylonId);
  assert.deepEqual(registry.threads.claudeTranscript(threadId)?.cursor, cursorAt(100), "no disk delete was requested, so nothing changes");
  assert.equal(registry.threads.pylon(pylonId)?.failed, "gave up");

  registry.threads.requestDiskDelete(pylonId, threadId);
  registry.threads.requestDiskDelete(pylonId, threadId);
  assert.notEqual(registry.threads.diskDeleteRequestedAt(pylonId), undefined);
  registry.threads.finishDiskDelete(pylonId);
  assert.equal(registry.threads.diskDeleteRequestedAt(pylonId), undefined);
  assert.deepEqual(registry.threads.claudeTranscript(threadId), { session: "s1", cursor: transcriptStart, dropped: 0, readAt: 100 });
  assert.deepEqual([registry.threads.pylon(pylonId)?.failed, registry.threads.pylon(pylonId)?.attempts, registry.threads.pylon(pylonId)?.retrying], [null, { count: 0, last: null }, false]);
  assert.deepEqual(registry.threads.claudeEntries(threadId), [reply(0), reply(1)]);

  assert.equal(registry.threads.appendClaudeRead(threadId, read(0, [reply(2)], 50)), true);
  assert.deepEqual(registry.threads.claudeEntries(threadId), [reply(0), reply(1), reply(2)]);
  assert.deepEqual(registry.threads.claudeEntries(threadId, 2), [reply(2)], "the numbering goes on after the kept entries");
  assert.equal(registry.threads.appendClaudeRead(threadId, read(50, [reply(3)], 10, true)), true);
  assert.deepEqual(registry.threads.claudeEntries(threadId), [reply(3)], "a later replaced file still starts the transcript over");

  registry.threads.requestDiskDelete(pylonId, threadId);
  registry.threads.dropDiskDelete(pylonId);
  assert.equal(registry.threads.diskDeleteRequestedAt(pylonId), undefined);
  assert.deepEqual(registry.threads.claudeTranscript(threadId)?.cursor, cursorAt(10), "a dropped disk delete leaves the read where it stands");
});

test("a thread delete clears a requested disk delete with everything else it clears", (t) => {
  const registry = seeded(t, tempDb());
  assert.equal(registry.threads.appendClaudeRead(threadId, { session: "s1", from: transcriptStart, entries: [reply(0)], cursor: cursorAt(9), reset: false, readAt: 9 }), true);
  registry.threads.requestDiskDelete(pylonId, threadId);
  registry.threads.setThreadStatus(threadId, "deleted");
  assert.equal(registry.threads.diskDeleteRequestedAt(pylonId), undefined);
  assert.equal(registry.threads.claudeTranscript(threadId), undefined);
  assert.deepEqual(registry.threads.claudeEntries(threadId), []);
});

test("a thread records when it was archived, keeps the first time across archives, and forgets it on any other status", (t) => {
  let now = 5_000;
  const registry = seeded(t, tempDb(), () => now);
  assert.equal(registry.threads.thread(threadId)?.archivedAt, undefined);
  registry.threads.setThreadStatus(threadId, "archived");
  assert.equal(registry.threads.thread(threadId)?.archivedAt, 5_000);
  now = 6_000;
  registry.threads.setThreadStatus(threadId, "archived");
  assert.equal(registry.threads.thread(threadId)?.archivedAt, 5_000, "archiving again keeps the first time");
  assert.equal(registry.threads.threads().find((x) => x.id === threadId)?.archivedAt, 5_000, "a list reads it too");

  registry.threads.setThreadStatus(threadId, "active");
  assert.equal(registry.threads.thread(threadId)?.archivedAt, undefined);
  now = 7_000;
  registry.threads.setThreadStatus(threadId, "archived");
  assert.equal(registry.threads.thread(threadId)?.archivedAt, 7_000, "the next archive counts from its own time");

  registry.threads.setThreadStatus(threadId, "active");
  now = 8_000;
  assert.equal(registry.reviews.saveReview(testReview({ builder: threadId, reviewer: threadId }), [threadId]), true);
  assert.equal(registry.threads.thread(threadId)?.archivedAt, 8_000, "a review's landing archives through the same path");
  registry.threads.setThreadStatus(threadId, "deleted");
  assert.equal(registry.threads.thread(threadId)?.archivedAt, undefined);
});

test("a Claude worker's messages answer their resends, and its transcript and messages outlive an archive but not a delete", (t) => {
  const registry = seeded(t, tempDb());
  const result = { session: "s1", outcome: "queued", resumed: false } as const;
  registry.threads.setClaudeMessage(threadId, "msg:1", { state: "sending" });
  assert.deepEqual(registry.threads.claudeMessage(threadId, "msg:1"), { state: "sending" });
  registry.threads.setClaudeMessage(threadId, "msg:1", { state: "sent", result });
  assert.deepEqual(registry.threads.claudeMessage(threadId, "msg:1"), { state: "sent", result });
  registry.threads.setClaudeMessage(threadId, "msg:2", { state: "sending" });
  registry.threads.setClaudeMessage(threadId, "msg:2", null);
  assert.equal(registry.threads.claudeMessage(threadId, "msg:2"), undefined, "a send that typed nothing is forgotten");
  registry.threads.setClaudeMessage(threadId, "msg:3", { state: "sending" });
  for (let i = 0; i < 1_000; i++) registry.threads.setClaudeMessage(threadId, `msg:more-${i}`, { state: "sent", result });
  assert.deepEqual(registry.threads.claudeMessage(threadId, "msg:1"), { state: "sent", result }, "however many messages follow, a resend is answered, not typed again");
  assert.deepEqual(registry.threads.claudeMessage(threadId, "msg:3"), { state: "sending" }, "nor is one whose send failed partway");

  registry.threads.appendClaudeRead(threadId, { session: "s1", from: cursorAt(0), entries: [reply(0)], cursor: cursorAt(10), reset: false, readAt: 1 });
  registry.threads.setThreadStatus(threadId, "archived");
  assert.deepEqual(registry.threads.claudeEntries(threadId), [reply(0)], "an archived thread's paused pylon still shows its transcript");
  registry.threads.setThreadStatus(threadId, "deleted");
  assert.equal(registry.threads.claudeTranscript(threadId), undefined);
  assert.deepEqual(registry.threads.claudeEntries(threadId), []);
  assert.equal(registry.threads.claudeMessage(threadId, "msg:more-0"), undefined);
});

test("a Claude worker whose transcript ends on a usage limit is limited until a turn starts or a prompt follows, whichever arrives first", (t) => {
  const registry = seeded(t, tempDb(), undefined, "hello");
  claudeWorkerAt(registry, threadId, "started", { session: "s1" });
  let sequence = 0;
  let offset = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended", at: number) => registry.threads.reportSession(node, { sequence: ++sequence, pylon: pylonId, time: 1000 + sequence, event: { kind, session: "s1", at } });
  const append = (...entries: ClaudeEntry[]) => assert.equal(registry.threads.appendClaudeRead(threadId, { session: "s1", from: cursorAt(offset), entries, cursor: cursorAt(offset += 10), reset: false, readAt: offset }), true);
  const attentions = () => registry.threads.events("0", { kinds: ["attention.changed"] }).map((e) => e.payload.attention);
  const attention = () => attentions().at(-1);
  const stop = (at: number): ClaudeEntry => ({ kind: "notice", at, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt: 9000 } });

  report("session.turn-started", 40);
  append({ kind: "prompt", at: 40, text: "go", from: "person" }, stop(50));
  report("session.turn-ended", 55);
  assert.deepEqual(registry.threads.thread(threadId)!.usageLimit, { stoppedAt: 50, resetsAt: 9000 });
  assert.equal(attention(), "limited");
  registry.threads.markSeen(threadId, false);
  assert.equal(attention(), "limited", "seeing the thread does not resume it");
  append({ kind: "turn", at: 51, durationMs: 10 });
  assert.equal(attention(), "limited");

  report("session.turn-started", 58);
  assert.equal(registry.threads.thread(threadId)!.usageLimit, undefined);
  assert.equal(attention(), "working");
  const before = attentions().length;
  report("session.turn-ended", 59);
  assert.equal(registry.threads.thread(threadId)!.usageLimit, undefined, "a turn that started after the stop ended it, though its prompt is not read yet");
  assert.ok(!attentions().slice(before).includes("limited"), "so the turn's end does not flash limited");
  append({ kind: "prompt", at: 58, text: "continue", from: "person" }, { kind: "reply", at: 59, text: "done" });
  assert.equal(attention(), "reply");

  report("session.turn-started", 65);
  report("session.turn-ended", 75);
  append({ kind: "prompt", at: 65, text: "more", from: "person" }, stop(70));
  assert.equal(attention(), "limited", "the read that finds the stop after the turn ended limits the thread");
  append({ kind: "notice", at: 71, tone: "error", text: "API Error: 529 Overloaded" });
  assert.equal(registry.threads.thread(threadId)!.usageLimit, undefined);
  assert.equal(attention(), "reply", "another API error is a plain reply");
});

test("a read that ends on a usage limit ends the turn that ran into it, though Claude Code reported no end, and not a later turn", (t) => {
  const registry = seeded(t, tempDb(), undefined, "hello");
  claudeWorkerAt(registry, threadId, "started", { session: "s1" });
  let sequence = 0;
  let offset = 0;
  const report = (at: number) => registry.threads.reportSession(node, { sequence: ++sequence, pylon: pylonId, time: 1000 + sequence, event: { kind: "session.turn-started", session: "s1", at } });
  const append = (...entries: ClaudeEntry[]) => assert.equal(registry.threads.appendClaudeRead(threadId, { session: "s1", from: cursorAt(offset), entries, cursor: cursorAt(offset += 10), reset: false, readAt: offset }), true);
  const attention = () => registry.threads.events("0", { kinds: ["attention.changed"] }).at(-1)?.payload.attention;

  report(40);
  const replied = registry.threads.thread(threadId)!.lastReplyAt;
  append({ kind: "prompt", at: 40, text: "go", from: "person" }, { kind: "notice", at: 50, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt: 9000 } });
  assert.equal(registry.threads.thread(threadId)!.sessionTurnRunning, undefined);
  assert.equal(attention(), "limited");
  assert.equal(registry.threads.thread(threadId)!.lastReplyAt, replied, "the stop records no reply");

  report(60);
  append({ kind: "turn", at: 61, durationMs: 10 });
  assert.equal(registry.threads.thread(threadId)!.sessionTurnRunning, true, "a turn that started after the stop keeps running");
  assert.equal(attention(), "working");
});

/** A Claude worker on session s1 whose transcript reads and pylon reports of waiting asks the test makes, as the reader would. */
function claudeAsking(registry: ReturnType<typeof seeded>) {
  claudeWorkerAt(registry, threadId, "started", { session: "s1" });
  let offset = 0;
  return {
    waiting: (...asks: WaitingAsk[]) => registry.questions.setWaitingAsks(threadId, asks),
    append: (...entries: ClaudeEntry[]) => assert.equal(registry.threads.appendClaudeRead(threadId, { session: "s1", from: cursorAt(offset), entries, cursor: cursorAt(offset += 10), reset: false, readAt: offset }), true),
    asks: () => registry.questions.questions(threadId).map((q) => [q.id, q.answer?.option ?? null]),
  };
}
const drink = { question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "Hot" }, { label: "Coffee", description: "Strong" }] };
const waitingAsk = (toolUseId: string, at: number, session = "s1"): WaitingAsk => ({ ask: { session, toolUseId, questions: [drink] }, at });
const askCall = (id: string, at: number): ClaudeEntry => ({ kind: "tool", at, id, name: "AskUserQuestion", input: { questions: [drink] } });
const answered = (id: string, at: number): ClaudeEntry => ({ kind: "result", at, toolUseId: id, output: 'User has answered your questions: "Which drink?"="Tea".', isError: false });

test("a Claude worker's AskUserQuestion is a question while its pylon reports the dialog waiting, though the transcript holds no call yet, and is withdrawn once a report leaves it out or the transcript holds its result", (t) => {
  const path = tempDb();
  const registry = seeded(t, path, undefined, "hello");
  const { waiting, append, asks } = claudeAsking(registry);
  append({ kind: "prompt", at: 40, text: "Make me a drink", from: "person" });
  assert.equal(waiting(waitingAsk("t1", 50)), true);
  assert.deepEqual(registry.questions.questions(threadId), [{
    kind: "ask", id: "ask-t1", thread: threadId, text: "Drink: Which drink?", options: [], reserved: null, answerer: "person", askedAt: 50,
    ask: { session: "s1", toolUseId: "t1", questions: [drink] }, answer: null,
  }]);
  assert.equal(registry.threads.attention(threadId), "decision");
  assert.equal(waiting(waitingAsk("t1", 50)), false, "the same report again asks nothing new");
  assert.equal(waiting(), true);
  assert.deepEqual(asks(), [], "a report without it, as after the terminal answered it");
  assert.notEqual(registry.threads.attention(threadId), "decision");

  waiting(waitingAsk("t2", 70));
  append(askCall("t2", 69), answered("t2", 75));
  assert.deepEqual(asks(), [], "the transcript holds its result");
  waiting(waitingAsk("t2", 70));
  assert.deepEqual(asks(), [], "a report taken before the hook stopped still names it");

  waiting(waitingAsk("t3", 80), waitingAsk("t4", 81, "person-session"));
  assert.deepEqual(asks(), [["ask-t3", null]], "another Claude's ask in the pylon, such as the person's own, asks nothing");
  // A worker's session changes under no launch Nexus sends now, so the test writes it, and moves the worker to have it reconciled.
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE claude_workers SET session = 's2' WHERE thread = ?").run(threadId);
  raw.close();
  registry.threads.moveClaudeWorker(threadId, { to: "started" });
  assert.deepEqual(asks(), [], "the worker started again on another session");
});

test("an answered ask stays answered whatever the pylon reports, and a withdrawn one is not asked again before the next report", (t) => {
  const registry = seeded(t, tempDb(), undefined, "hello");
  const { waiting, append, asks } = claudeAsking(registry);
  waiting(waitingAsk("t1", 50));
  registry.questions.answerQuestion(registry.questions.question("ask-t1")!, { option: "Drink: Tea", by: "nLAPTOP" as TailnetNodeId, at: 55, choices: [{ picked: ["Tea"] }] });
  waiting();
  registry.questions.withdrawAsk("ask-t1");
  assert.deepEqual(asks(), [["ask-t1", "Drink: Tea"]]);
  assert.deepEqual(registry.questions.question("ask-t1")!.answer!.choices, [{ picked: ["Tea"] }]);

  waiting(waitingAsk("t2", 90));
  assert.equal(registry.threads.attention(threadId), "decision");
  registry.questions.withdrawAsk("ask-t2");
  assert.deepEqual(asks(), [["ask-t1", "Drink: Tea"]]);
  assert.notEqual(registry.threads.attention(threadId), "decision");
  append();
  registry.threads.reportSession(node, { sequence: 1, pylon: pylonId, time: 1000, event: { kind: "session.waiting", session: "s1", at: 95 } });
  assert.deepEqual(asks(), [["ask-t1", "Drink: Tea"]], "a read and a session event before the pylon's next report");
});

test("archiving or deleting a Claude worker's thread withdraws its asks, and a report that lands after asks nothing", (t) => {
  const registry = seeded(t, tempDb(), undefined, "hello");
  const { waiting, asks } = claudeAsking(registry);
  for (const status of ["archived", "deleted"] as const) {
    waiting(waitingAsk("t1", 50));
    assert.deepEqual(asks(), [["ask-t1", null]]);
    registry.threads.setThreadStatus(threadId, status);
    assert.deepEqual(asks(), [], status);
    assert.equal(waiting(waitingAsk("t1", 50)), false);
    assert.deepEqual(asks(), [], `a pull that was under way when the thread was ${status}`);
    if (status === "archived") registry.threads.setThreadStatus(threadId, "active");
  }
});

test("a write waits while another process, such as a second open of the registry, holds its write lock", async (t) => {
  const path = tempDb();
  const registry = testRegistry(t, path);
  const writing = `${path}.writing`;
  // The holder keeps the lock until this process says it is writing, so the write always meets the lock.
  const holder = spawn(process.execPath, ["-e", `
    const { existsSync } = require("node:fs");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec("BEGIN IMMEDIATE");
    console.log("locked");
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    while (!existsSync(${JSON.stringify(writing)})) pause(10);
    pause(200);
    db.exec("COMMIT");
  `], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { holder.kill(); holder.stdout.destroy(); });
  await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
  writeFileSync(writing, "");
  registry.nodes.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  assert.deepEqual(registry.nodes.nodes().map((n) => n.name), [node], "the write waited for the lock rather than failing");
  await new Promise((resolve) => holder.once("exit", resolve));
});

test("a registry made when landing asked for a passkey keeps neither passkey table", (t) => {
  const path = tempDb();
  openRegistry(path).close();
  const db = new DatabaseSync(path);
  const version = db.prepare("PRAGMA user_version").get()!.user_version as number;
  db.close();
  rewindTo(path, versionBefore(/DROP TABLE IF EXISTS passkeys\b/));
  openRegistry(path).close();
  const reopened = new DatabaseSync(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'passkey%'").all(), []);
  assert.equal(reopened.prepare("PRAGMA user_version").get()!.user_version, version);
});

test("a queued thread's row and its queue record's start commit together, and a record no longer queued starts nothing", (t) => {
  const registry = testRegistry(t, ":memory:");
  registry.nodes.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  registry.projects.createProject(project);
  const record: QueuedRecord = {
    id: threadId, title: thread.title, project: project.id, startedBy: "nLAPTOP", createdAt: 500, after: ["th-0" as ThreadId],
    request: { project: project.id, title: thread.title, node, resources: project.resources }, message: "Fix it.",
    status: "queued", startNow: null, lastError: "no node can run this pylon", startedAt: null, firstMessage: null,
  };
  registry.queue.saveQueued({ ...record, status: "archived" });
  assert.throws(() => registry.threads.createThread(thread, pylon, { queued: true }), /thread th-1 is no longer queued/);
  assert.equal(registry.threads.thread(threadId), undefined, "a cancelled thread gets no row");
  assert.equal(registry.threads.pylon(pylonId), undefined);

  registry.queue.saveQueued(record);
  registry.threads.createThread(thread, pylon, { queued: true });
  assert.equal(registry.threads.thread(threadId)?.id, threadId);
  assert.deepEqual(registry.queue.queuedThread(threadId), { ...record, status: "started", startedAt: thread.createdAt, lastError: null, firstMessage: "pending" });
  assert.throws(() => registry.threads.createThread(thread, pylon, { queued: true }), /no longer queued/, "a started record never starts again");
  assert.deepEqual(registry.queue.queuedThreads().map((r) => r.status), ["started"]);
  assert.throws(() => registry.threads.createThread({ ...thread, id: "th-2" as ThreadId, pylonId: "pylon-th-2" as PylonId }, { ...pylon, pylonId: "pylon-th-2" as PylonId, thread: "th-2" }, { queued: true }), /th-2 is no longer queued/, "a thread with no record is not queued");
});

test("the migration that adds pipeline items turns the pipeline on for project nexus once, and never back on once it is off", (t) => {
  const path = tempDb();
  const registry = openRegistry(path);
  for (const id of ["nexus", "other"]) registry.projects.createProject({ ...project, id: id as ProjectId });
  registry.close();
  const rewind = () => rewindTo(path, versionBefore(/CREATE TABLE IF NOT EXISTS pipeline_items\b/));
  rewind();
  const upgraded = openRegistry(path);
  assert.deepEqual(upgraded.projects.project("nexus" as ProjectId)?.pipeline, { autoStart: true });
  assert.equal(upgraded.projects.project("other" as ProjectId)?.pipeline, undefined);
  assert.deepEqual(upgraded.pipeline.items(), []);
  upgraded.projects.editProject("nexus" as ProjectId, (p) => ({ ...p, pipeline: null }));
  upgraded.close();
  rewind();
  const again = testRegistry(t, path);
  assert.equal(again.projects.project("nexus" as ProjectId)?.pipeline, null, "the person turned it off, and a rewound registry keeps it off");
});

test("the migration that records archive times stamps each thread archived before it with its own time, and no other", (t) => {
  const path = tempDb();
  const registry = seed(openRegistry(path, () => 1_000));
  registry.threads.createThread({ ...thread, id: "th-2" as ThreadId, pylonId: "pylon-th-2" as PylonId }, { ...pylon, pylonId: "pylon-th-2" as PylonId, thread: "th-2" as ThreadId });
  registry.threads.setThreadStatus(threadId, "archived");
  registry.close();
  rewindTo(path, versionBefore(/CREATE TABLE IF NOT EXISTS thread_archives\b/));
  const before = Date.now();
  const upgraded = testRegistry(t, path);
  const after = Date.now();
  const stamp = upgraded.threads.thread(threadId)?.archivedAt;
  assert.ok(stamp !== undefined && stamp >= Math.floor(before / 1000) * 1000 && stamp <= after, `the stamp ${stamp} is the migration's time`);
  assert.equal(upgraded.threads.thread("th-2" as ThreadId)?.archivedAt, undefined, "an active thread gets none");
});

test("an archive's settle records when its usage was read and forgets the failed ones, which count in a row, and only an unarchive unsettles it", (t) => {
  const registry = seeded(t, tempDb(), () => 1_000);
  const archived = () => registry.threads.thread(threadId)!;
  const kept = () => registry.threads.keptArchives().map((k) => k.id);
  assert.deepEqual(kept(), [], "an active thread keeps no disk for its usage");
  registry.threads.setThreadStatus(threadId, "archived");
  assert.deepEqual([archived().usageSettledAt, archived().settleFailure, archived().backedUpAt, kept()], [undefined, undefined, undefined, [threadId]]);

  registry.usage.finishSettle(threadId, "its pylon did not boot within 10 minutes", 2_000);
  registry.usage.finishSettle(threadId, "reading it failed: the pipe to the pylon was lost", 3_000);
  assert.deepEqual(archived().settleFailure, { reason: "reading it failed: the pipe to the pylon was lost", at: 3_000, count: 2 });
  registry.usage.finishSettle(threadId, null, 4_000);
  assert.deepEqual([archived().usageSettledAt, archived().settleFailure], [4_000, undefined]);
  registry.usage.finishSettle(threadId, "a late failure", 5_000);
  registry.usage.finishSettle(threadId, null, 6_000);
  assert.deepEqual([archived().usageSettledAt, archived().settleFailure], [4_000, undefined], "a settled archive stays as it was settled");
  registry.threads.setThreadStatus(threadId, "archived");
  assert.equal(archived().usageSettledAt, 4_000, "archiving it again keeps its settle, as it keeps its archive time");

  assert.deepEqual(kept(), [threadId], "no backup began after the settle yet");
  registry.threads.recordBackedUp(4_000);
  assert.deepEqual([archived().backedUpAt, kept()], [4_000, [threadId]], "a backup that began as the read ended may have missed it");
  registry.threads.recordBackedUp(4_001);
  registry.threads.recordBackedUp(3_000);
  assert.deepEqual([archived().backedUpAt, kept()], [4_001, []], "an older backup never moves the newest back");

  registry.threads.setThreadStatus(threadId, "idle");
  const { usageSettledAt, settleFailure, backedUpAt } = archived();
  assert.deepEqual([usageSettledAt, settleFailure, backedUpAt], [undefined, undefined, undefined], "only an archived thread has them");
  registry.threads.setThreadStatus(threadId, "archived");
  assert.deepEqual([archived().usageSettledAt, kept()], [undefined, [threadId]], "the next archive has its own usage to read");
});

test("a settle's hold wakes its pylon for reading until the read is done, and is held in memory only", (t) => {
  const path = tempDb();
  const registry = seed(openRegistry(path));
  registry.threads.setThreadStatus(threadId, "archived");
  assert.equal(registry.usage.settleHold(), null);
  registry.usage.holdSettle(threadId, 10);
  assert.deepEqual([registry.usage.settleHold(), registry.threads.thread(threadId)!.readingUsage], [{ thread: threadId, phase: "reading", since: 10 }, true]);
  registry.usage.finishSettle(threadId, null, 20);
  assert.deepEqual([registry.usage.settleHold(), registry.threads.thread(threadId)!.readingUsage], [{ thread: threadId, phase: "pausing", since: 20 }, undefined]);
  registry.usage.holdSettle(threadId, 30);
  registry.close();
  const reopened = testRegistry(t, path);
  assert.deepEqual([reopened.usage.settleHold(), reopened.threads.thread(threadId)!.readingUsage], [null, undefined], "a restart lets the pylon pause");
  assert.equal(reopened.threads.thread(threadId)!.usageSettledAt, 20);
});

test("the migration that records settles leaves every archive before it unsettled, and its failures none", (t) => {
  const path = tempDb();
  const registry = seed(openRegistry(path, () => 1_000));
  registry.threads.setThreadStatus(threadId, "archived");
  registry.usage.finishSettle(threadId, null, 2_000);
  registry.threads.recordBackedUp(3_000);
  registry.close();
  rewindTo(path, versionBefore(/ADD COLUMN usage_settled_at\b/));
  const upgraded = testRegistry(t, path);
  const { archivedAt, usageSettledAt, settleFailure, backedUpAt } = upgraded.threads.thread(threadId)!;
  assert.deepEqual([archivedAt, usageSettledAt, settleFailure, backedUpAt], [1_000, undefined, undefined, 3_000], "the backup's time is a setting, which the migration keeps");
  assert.deepEqual(upgraded.threads.keptArchives().map((k) => k.id), [threadId], "its disk stays until a settle reads it");
  upgraded.usage.finishSettle(threadId, "its pylon failed: boom", 4_000);
  assert.deepEqual(upgraded.threads.thread(threadId)!.settleFailure, { reason: "its pylon failed: boom", at: 4_000, count: 1 });
});

test("judgments begin at the newest event, so failures from before are never judged, and a rewound registry keeps that watermark", (t) => {
  const path = tempDb();
  const registry = seed(openRegistry(path));
  registry.threads.savePylon({ ...pylon, failed: "gave up after 5 failed attempts" });
  const failed = Number(registry.threads.events("0", { kinds: ["thread.failed"] })[0]!.id);
  const before = Number(registry.threads.newestEvent());
  registry.close();
  const rewind = () => rewindTo(path, versionBefore(/CREATE TABLE IF NOT EXISTS judgments\b/));
  rewind();
  const upgraded = openRegistry(path);
  assert.equal(upgraded.judgments.judgmentSince(), before, "the failure before the upgrade is at the watermark");
  assert.ok(upgraded.threads.failure(threadId)!.event === failed && failed <= before);
  upgraded.threads.retryPylon(pylonId);
  upgraded.threads.savePylon({ ...upgraded.threads.pylon(pylonId)!, failed: "gave up again" });
  upgraded.close();
  const db = new DatabaseSync(path);
  db.exec(migrations[versionBefore(/CREATE TABLE IF NOT EXISTS judgments\b/)]!);
  db.close();
  const again = testRegistry(t, path);
  assert.equal(again.judgments.judgmentSince(), before, "applied again, the migration keeps the first watermark");
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  assert.equal(raw.prepare("SELECT count(*) AS n FROM judgment_since").get()!.n, 1, "and adds no second one");
  assert.ok(again.threads.failure(threadId)!.event > before, "and the failure since is above it");
});

test("a pylon's failure is the thread.failed event its pylon appended, until a retry clears it", (t) => {
  let now = 1_000;
  const registry = seeded(t, tempDb(), () => now);
  assert.equal(registry.threads.failure(threadId), null, "a pylon that has not failed has none");
  registry.threads.savePylon({ ...pylon, failed: "pylon is broken: the controller exited" });
  const first = registry.threads.failure(threadId)!;
  assert.deepEqual(first, { event: Number(registry.threads.events("0", { kinds: ["thread.failed"] })[0]!.id), at: 1_000 });
  now = 2_000;
  registry.threads.appendEvent("thread.failed", threadId, { message: "Claude launch was interrupted; attach to check before starting another session" });
  registry.threads.savePylon({ ...registry.threads.pylon(pylonId)!, attempts: { count: 0, last: null } });
  assert.deepEqual(registry.threads.failure(threadId), first, "a failed Claude launch and a save that keeps the reason are not new failures");
  registry.threads.retryPylon(pylonId);
  assert.equal(registry.threads.failure(threadId), null, "a retry clears it");
  registry.threads.savePylon({ ...registry.threads.pylon(pylonId)!, failed: "pylon is broken: the controller exited" });
  assert.ok(registry.threads.failure(threadId)!.event > first.event, "the same reason after a retry is a new failure");
});

test("a pylon's failure is found by its event's cause, not its message, so a Claude worker failure with the same text is not it", (t) => {
  const registry = seeded(t, tempDb(), undefined, "hello");
  const reason = "pylon is broken: the controller exited";
  registry.threads.savePylon({ ...pylon, failed: reason });
  const failure = registry.threads.failure(threadId)!;
  claudeWorkerAt(registry, threadId, "failed", { message: reason });
  assert.deepEqual(registry.threads.events("0", { kinds: ["thread.failed"] }).map((e) => e.payload), [{ message: reason, cause: "pylon" }, { message: reason, cause: "claude-worker" }]);
  assert.deepEqual(registry.threads.failure(threadId), failure);
});

test("an older control plane's thread.failed, which names no cause, is the pylon's failure once the registry opens again", () => {
  const path = tempDb();
  const first = seed(openRegistry(path));
  first.threads.savePylon({ ...pylon, failed: "pylon is broken: the controller exited" });
  first.threads.appendEvent("thread.failed", threadId, { message: "something else failed" });
  first.close();
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE events SET payload = json_remove(payload, '$.cause') WHERE kind = 'thread.failed'").run();
  raw.close();
  const registry = openRegistry(path);
  try {
    const events = registry.threads.events("0", { kinds: ["thread.failed"] });
    assert.deepEqual(events.map((e) => e.payload), [{ message: "pylon is broken: the controller exited", cause: "pylon" }, { message: "something else failed" }]);
    assert.equal(registry.threads.failure(threadId)?.event, Number(events[0]!.id));
  } finally {
    registry.close();
  }
});

test("a judgment is saved only over the record as it was read, with what it does in the same transaction", (t) => {
  const registry = seeded(t, tempDb());
  const judgment = {
    failure: 7, thread: threadId, node, failed: "broken", startedAt: 1, request: { brief: "Judge it.", token: "judgment:7:aa" }, conversation: null, reply: null,
    phase: { kind: "judging", deadline: null },
  } as const;
  let acted = 0;
  assert.equal(registry.judgments.saveJudgment(judgment, null, () => acted++), true);
  assert.equal(registry.judgments.saveJudgment({ ...judgment, conversation: 9 }, null, () => acted++), false, "a second record of the failure is refused");
  assert.equal(registry.judgments.saveJudgment({ ...judgment, conversation: 9 }, judgment, () => acted++), true);
  assert.equal(registry.judgments.saveJudgment({ ...judgment, conversation: 10 }, judgment, () => acted++), false, "a pass that read the record before that save changes nothing");
  assert.equal(acted, 2, "only the saves that wrote acted");
  assert.deepEqual(registry.judgments.judgment(7), { ...judgment, conversation: 9 });
  assert.deepEqual(registry.judgments.judgments(threadId).map((j) => j.conversation), [9]);
});

test("a move takes a failed pylon to another node with a fresh boot, and its thread's placement and setup with it", (t) => {
  const registry = seeded(t, tempDb());
  const other = "rj-other" as NodeName;
  registry.nodes.upsertNode({ name: other, tailnetHost: "rj-other.tail.ts.net", tailnetNodeId: "nOTHER" as TailnetNodeId });
  const to = {
    node: other, firstBoot: { kind: "fresh", preSetup: "apt-get install -y jq" }, live: { previews: [], overlay: [] }, liveHash: "hash-2" as LiveHash,
    placement: { how: "auto", node: other, weighed: [{ node: other, left: { cpus: 6, memoryGiB: 20, diskGiB: 90 } }] }, setup: { how: "fresh", reason: "the pylon moved" },
  } as const;
  assert.equal(registry.threads.movePylon(pylonId, node, to), false, "a pylon that has not failed stays");
  registry.threads.savePylon({ ...pylon, failed: "broken", attempts: { count: 5, last: { at: 5, code: "backend", message: "no" } } });
  assert.equal(registry.threads.movePylon(pylonId, other, to), false, "a pylon on another node than the one named stays");
  assert.equal(registry.threads.movePylon(pylonId, node, to), true);
  assert.deepEqual(registry.threads.pylon(pylonId), { ...pylon, node: other, firstBoot: to.firstBoot, live: to.live, liveHash: to.liveHash, failed: null, attempts: { count: 0, last: null }, retrying: false });
  assert.deepEqual([registry.threads.thread(threadId)!.placement, registry.threads.thread(threadId)!.setup], [to.placement, to.setup]);
  assert.equal(registry.threads.attention(threadId) === "failed", false);
});

test("a registry from before join tokens keeps its nodes as they were, with none joined", (t) => {
  const path = tempDb();
  const before = openRegistry(path);
  before.nodes.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  before.close();
  rewindTo(path, versionBefore(/CREATE TABLE IF NOT EXISTS join_tokens\b/));
  const registry = testRegistry(t, path);
  assert.deepEqual(registry.nodes.nodes().map((n) => [n.name, n.tailnetHost, n.tailnetNodeId]), [[node, "rj-firebat.tail.ts.net", "nFIREBAT"]]);
  assert.deepEqual(registry.nodes.joinedNodes(), []);
});

test("a join token records one node, once, before it expires", (t) => {
  const registry = testRegistry(t, ":memory:");
  registry.nodes.addJoinToken("hash", 2_000);
  const joining = { name: "infra-2" as NodeName, tailnetHost: "infra-2.tail.ts.net", tailnetNodeId: "nINFRA2" as TailnetNodeId, deployKey: "a".repeat(64) };
  assert.equal(registry.nodes.joinNode("unknown", joining, 1_000), false);
  assert.equal(registry.nodes.joinNode("hash", joining, 2_000), false, "expired at 2000");
  assert.deepEqual(registry.nodes.joinedNodes(), []);
  assert.deepEqual(registry.nodes.nodes(), []);
  assert.equal(registry.nodes.joinNode("hash", joining, 1_999), true);
  assert.equal(registry.nodes.joinNode("hash", { ...joining, deployKey: "b".repeat(64) }, 1_999), false, "used");
  assert.deepEqual(registry.nodes.joinedNodes(), [{ ...joining, joinedAt: 1_999 }]);
  assert.deepEqual(registry.nodes.joinToken("hash"), { expiresAt: 2_000, usedAt: 1_999 });
  assert.equal(registry.nodes.node(joining.name)?.state, "offline");
});

test("a node by its tailnet ID carries the key it joined with, and a configured node none", (t) => {
  const registry = testRegistry(t, ":memory:");
  registry.nodes.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  registry.nodes.addJoinToken("hash", 2_000);
  registry.nodes.joinNode("hash", { name: "infra-2" as NodeName, tailnetHost: "infra-2.tail.ts.net", tailnetNodeId: "nINFRA2" as TailnetNodeId, deployKey: "a".repeat(64) }, 1_000);
  assert.deepEqual(registry.nodes.nodeByTailnetId("nFIREBAT" as TailnetNodeId), { name: node, deployKey: null });
  assert.deepEqual(registry.nodes.nodeByTailnetId("nINFRA2" as TailnetNodeId), { name: "infra-2", deployKey: "a".repeat(64) });
  assert.equal(registry.nodes.nodeByTailnetId("nLAPTOP" as TailnetNodeId), undefined);
});

/**
 * Threads that each take a different path through the session facts: a harness and a session turn running, a waiting
 * session with and without a message, a Claude worker stopped on its usage limit and one a later turn ended, one the
 * usage backfill reads, and a deleted one.
 */
function sessionFactThreads(registry: ReturnType<typeof seeded>) {
  let sequence = 0;
  const report = (id: string, kind: "session.turn-started" | "session.turn-ended" | "session.waiting", at: number, message?: string) => registry.threads.reportSession(node, {
    sequence: ++sequence, pylon: `pylon-${id}` as PylonId, time: 1000 + sequence, event: { kind, session: "s1", at, ...(message === undefined ? {} : { message }) },
  });
  const limited = (id: string) => {
    claudeWorkerAt(registry, id as ThreadId, "started", { session: "s1" });
    report(id, "session.turn-started", 40);
    registry.threads.appendClaudeRead(id as ThreadId, { session: "s1", from: transcriptStart, cursor: cursorAt(10), reset: false, readAt: 10, entries: [
      { kind: "prompt", at: 40, text: "go", from: "person" }, { kind: "notice", at: 50, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt: 9000 } },
    ] });
    report(id, "session.turn-ended", 55);
  };
  addPylon(registry, "th-live");
  registry.threads.recordActivity("th-live" as ThreadId, { agent: 5, agentTurnRunning: true });
  report("th-live", "session.turn-started", 10);
  addPylon(registry, "th-waiting");
  report("th-waiting", "session.waiting", 10, "a dev server still runs");
  addPylon(registry, "th-waiting-bare");
  report("th-waiting-bare", "session.waiting", 10);
  addPylon(registry, "th-limited", node, "hello");
  limited("th-limited");
  addPylon(registry, "th-resumed", node, "hello");
  limited("th-resumed");
  report("th-resumed", "session.turn-started", 58);
  report("th-resumed", "session.turn-ended", 59);
  addPylon(registry, "th-reading");
  registry.threads.setThreadStatus("th-reading" as ThreadId, "archived");
  registry.usage.startUsageBackfill(["th-reading" as ThreadId], 1_000);
  registry.usage.holdUsageBackfill("th-reading" as ThreadId, 1_000);
  addPylon(registry, "th-deleted");
  registry.threads.setThreadStatus("th-deleted" as ThreadId, "deleted");
  return ["th-1", "th-live", "th-waiting", "th-waiting-bare", "th-limited", "th-resumed", "th-reading", "th-deleted"] as ThreadId[];
}

test("threads() reads each thread's session facts as thread() does, whichever facts it has", (t) => {
  const registry = seeded(t, tempDb());
  const ids = sessionFactThreads(registry);
  const listed = registry.threads.threads();
  assert.deepEqual(listed.map((l) => l.id), [...ids].sort(), "threads made in one millisecond, by ID");
  for (const id of ids) assert.deepEqual(listed.find((l) => l.id === id), registry.threads.thread(id), id);
  assert.deepEqual(registry.threads.threads({ project: project.id }), listed);
  const of = (id: string) => registry.threads.thread(id as ThreadId)!;
  assert.equal(of("th-live").sessionTurnRunning, true);
  assert.ok(of("th-live").workingSince !== undefined);
  assert.equal(of("th-waiting").sessionWaitingMessage, "a dev server still runs");
  assert.equal(of("th-waiting-bare").sessionWaiting, true);
  assert.equal(of("th-waiting-bare").sessionWaitingMessage, undefined);
  assert.deepEqual(of("th-limited").usageLimit, { stoppedAt: 50, resetsAt: 9000 });
  assert.equal(of("th-resumed").usageLimit, undefined, "a turn that started after the stop ended it");
  assert.equal(of("th-reading").readingUsage, true);
  assert.equal(of("th-1").working, false);
});

test("storedThreads reads only the threads' own rows, by status and by who started them", (t) => {
  const registry = seeded(t, tempDb());
  const ids = sessionFactThreads(registry);
  registry.threads.createThread({ ...thread, id: "th-review" as ThreadId, pylonId: "pylon-th-review" as PylonId, startedBy: "nexus-review" },
    { ...pylon, thread: "th-review", pylonId: "pylon-th-review" as PylonId, boot: { ...pylon.boot, pylonId: "pylon-th-review" as PylonId } });
  const idsOf = (filter?: Parameters<typeof registry.threads.storedThreads>[0]) => registry.threads.storedThreads(filter).map((s) => s.id);
  assert.deepEqual(idsOf(), [...ids, "th-review"].sort());
  assert.deepEqual(idsOf({ status: ["active", "idle"] }), [...ids, "th-review"].filter((id) => id !== "th-reading" && id !== "th-deleted").sort());
  assert.deepEqual(idsOf({ startedBy: "nexus-review" }), ["th-review"]);
  assert.deepEqual(idsOf({ status: ["archived"], startedBy: "nLAPTOP" }), ["th-reading"]);
  assert.deepEqual(idsOf({ status: [] }), []);
  for (const stored of registry.threads.storedThreads()) {
    const { working: _w, workingSince: _ws, sessionTurnRunning: _st, sessionActiveUntil: _sa, sessionWaiting: _sw, sessionWaitingMessage: _sm, usageLimit: _u, readingUsage: _r, archivedAt: _a, ...own } = registry.threads.thread(stored.id)!;
    assert.deepEqual(stored, own, `${stored.id} has no session facts`);
  }
  assert.equal(registry.threads.threadStatus("th-reading" as ThreadId), "archived");
  assert.equal(registry.threads.threadStatus("th-missing" as ThreadId), undefined);
});

test("a deploy drain set to null reads back as null, as does one never set", (t) => {
  const registry = testRegistry(t, ":memory:");
  assert.equal(registry.releases.drain(), null);
  assert.equal(registry.releases.desiredRelease(), null);
  registry.releases.setDrain({ commit: "c".repeat(40), expiresAt: 300 });
  assert.deepEqual(registry.releases.drain(), { commit: "c".repeat(40), expiresAt: 300 });
  registry.releases.setDrain(null);
  assert.equal(registry.releases.drain(), null);
});

test("the harness threads at start are those whose agent is a conversation, less deleted ones whose abort is recorded", (t) => {
  const registry = seeded(t, tempDb());
  const start = (id: string, conversationId: string, claude?: string) => registry.threads.createThread({ ...thread, id: id as ThreadId, pylonId: `pylon-${id}` as PylonId, conversationId },
    { ...pylon, thread: id, pylonId: `pylon-${id}` as PylonId, boot: { ...pylon.boot, pylonId: `pylon-${id}` as PylonId } }, claude === undefined ? {} : { claude: { prompt: claude } });
  start("th-live", "1");
  start("th-deleted", "2");
  start("th-aborted", "3");
  start("th-claude", "4", "hello");
  registry.threads.setThreadStatus("th-deleted" as ThreadId, "deleted");
  registry.threads.setThreadStatus("th-aborted" as ThreadId, "deleted");
  registry.threads.recordAborted("3");
  const harnessIds = () => registry.threads.harnessThreads().map((h) => [h.id, h.status, h.conversationId]);
  for (const h of registry.threads.harnessThreads()) assert.equal(registry.threads.agent(h).kind, "harness");
  assert.deepEqual(harnessIds(), [["th-deleted", "deleted", "2"], ["th-live", "active", "1"]]);
  registry.threads.recordAborted("2");
  registry.threads.recordAborted("2");
  registry.threads.recordAborted("1");
  assert.deepEqual(harnessIds(), [["th-live", "active", "1"]], "a live thread stays whatever is recorded of its conversation");
});

test("a node's tallies and room count each of its pylons by what it holds, and a pylon placed elsewhere as an orphan", async (t) => {
  const { nodePylons, roomLeft } = await import("./placement.ts");
  const registry = seeded(t, tempDb());
  const other = "rj-other" as NodeName;
  registry.nodes.upsertNode({ name: other, tailnetHost: "rj-other.tail.ts.net", tailnetNodeId: "nOTHER" as TailnetNodeId });
  const placed = (id: string, active: boolean, on = node) => {
    const p = addPylon(registry, id, on);
    if (active) registry.threads.recordActivity(id as ThreadId, { human: Date.now() });
    return p;
  };
  const [up, paused, waking] = [placed("th-up", true), placed("th-paused", false), placed("th-waking", true)];
  placed("th-unseen", true);
  const [archived, reading, crashed] = [placed("th-archived", false), placed("th-reading", false), placed("th-crashed", true)];
  const failed = placed("th-failed", true);
  registry.threads.savePylon({ ...registry.threads.pylon(failed)!, failed: "gave up" });
  const elsewhere = placed("th-elsewhere", true, other);
  for (const id of ["th-archived", "th-reading"]) registry.threads.setThreadStatus(id as ThreadId, "archived");
  registry.usage.startUsageBackfill(["th-reading" as ThreadId], Date.now());
  registry.usage.holdUsageBackfill("th-reading" as ThreadId, Date.now());
  const release = registry.placement.reserve("pylon-th-starting" as PylonId, node, { cpus: 1, memoryGiB: 1, diskGiB: 1 });
  t.after(release);
  const stopped = (pylonId: PylonId) => stoppedPylon(pylonId, { sessions: null });
  registry.threads.ingested(testObservation(node, {
    observedAt: "2027-01-01T00:00:00Z", capacity,
    pylons: [{ pylonId: up, phase: "booting" }, stopped(paused), stopped(waking), stopped(archived), stopped(reading),
      { pylonId: crashed, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" },
      { pylonId: "pylon-gone" as PylonId, phase: "booting" }, { pylonId: elsewhere, phase: "booting" }],
  }), []);
  const record = registry.nodes.node(node)!;
  assert.deepEqual(nodePylons(registry, record), {
    up: { pylons: 1, cpus: 2, memoryGiB: 4 }, paused: { pylons: 2, cpus: 4, memoryGiB: 8 }, archived: { pylons: 2, cpus: 4, memoryGiB: 8 },
    crashed: { pylons: 1, cpus: 2, memoryGiB: 4 }, orphaned: ["pylon-gone", elsewhere],
  });
  assert.deepEqual(roomLeft(registry, node, record.observation!, capacity, { cpus: 1, memoryGiB: 1, diskGiB: 1 }), {
    pending: { cpus: 7, memoryGiB: 13, diskGiB: 11 },
    left: { cpus: 8, memoryGiB: 42, diskGiB: 388 },
  }, "a stopped pylon about to wake or be read holds its CPUs and memory again, an unreported one all it asked for, and a start placed here what it reserved");
});

test("a usage limit reads each Claude thread's newest 16 entries, in threads() as in thread()", (t) => {
  const registry = seeded(t, tempDb());
  const stopped = (id: string, after: number) => {
    addPylon(registry, id, node, "hello");
    claudeWorkerAt(registry, id as ThreadId, "started", { session: "s1" });
    const bookkeeping = Array.from({ length: after }, (_, i): ClaudeEntry => ({ kind: "turn", at: 60 + i, durationMs: 1 }));
    registry.threads.appendClaudeRead(id as ThreadId, { session: "s1", from: transcriptStart, cursor: cursorAt(10), reset: false, readAt: 10, entries: [
      ...Array.from({ length: 30 }, (_, i) => reply(i)), { kind: "notice", at: 50, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt: 9000 } }, ...bookkeeping,
    ] });
  };
  stopped("th-15-after", 15);
  stopped("th-16-after", 16);
  assert.deepEqual(registry.threads.thread("th-15-after" as ThreadId)!.usageLimit, { stoppedAt: 50, resetsAt: 9000 });
  assert.equal(registry.threads.thread("th-16-after" as ThreadId)!.usageLimit, undefined, "a stop older than the newest 16 entries is not read");
  const listed = registry.threads.threads();
  for (const id of ["th-15-after", "th-16-after"]) assert.deepEqual(listed.find((l) => l.id === id), registry.threads.thread(id as ThreadId), id);
});
