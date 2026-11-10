import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addThread, claudeWorkerAt, observeNode, seedRegistry, testPr, testPylon, testRegistry, testReview, testThread, type PylonOptions } from "../test-support/registry-kit.ts";
import { stoppedPylon, tempDir } from "../test-support/kit.ts";
import { image, withThread } from "../test-support/api-kit.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { retentionPass } from "./retention-pass.ts";
import { rewindTo, versionBefore } from "../test-support/schema-kit.ts";
import { requestIds, type ItemId, type JobId, type NodeName, type ProjectId, type ThreadId } from "../ids.ts";
import { itemView } from "./pipeline.ts";
import type { Judgment } from "./judgment-store.ts";
import type { Thread } from "./thread-store.ts";
import type { ThreadDetail } from "./wire.ts";

const dir = await tempDir("nexus-retention-");
const tempDb = () => join(dir, `${randomUUID()}.db`);

/** How many rows of each table name `id` in any column, as itself, inside a pylon ID or inside a JSON record. */
function rowsNaming(path: string, id: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    return Object.fromEntries(tables.flatMap((table) => {
      const columns = (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((c) => `instr(CAST("${c.name}" AS TEXT), $id) > 0`);
      const n = (db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${columns.join(" OR ")}`).get({ id }) as { n: number }).n;
      return n === 0 ? [] : [[table, n]];
    }));
  } finally {
    db.close();
  }
}

/** A Claude worker thread with a row of its own in every table a thread's life writes, then deleted. */
function deletedWithEverything(registry: Registry): ThreadId {
  const t = testThread({ conversationId: "conv-purged" });
  const { id, pylonId } = t;
  registry.threads.createThread(t, testPylon(t), { claude: { prompt: "fix it" }, key: { requestId: "req-1", body: "{}" } });
  claudeWorkerAt(registry, id, "started", { session: "s1" });
  registry.threads.apply({ record: "sessions", pylonId, sessions: [{ id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", title: null, state: "running", status: "idle", message: null }] });
  registry.threads.apply({ record: "output", pylonId, kind: "branch", ref: "origin/fix" });
  registry.threads.apply({ record: "job", status: { subject: pylonId, jobId: "j1" as JobId, kind: "pause", state: "succeeded", finishedAt: "2027-01-01T00:00:00Z" } });
  registry.threads.allocatePreviews(pylonId, ["web"], { first: 10200, last: 10299 }, null);
  registry.threads.reportSession("rj-firebat" as NodeName, { pylon: pylonId, sequence: 1, time: Date.now(), event: { kind: "session.waiting", session: "s1", at: Date.now() } });
  registry.threads.recordParked(id, true);
  registry.questions.askQuestion({ kind: "judgment", id: "qn-1", thread: id, text: "Retry?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: Date.now(), failure: 0 });
  registry.questions.setWaitingAsks(id, []);
  registry.nudges.saveNudge(id, { state: "nudged", turn: 1, count: 1 });
  registry.prWatches.savePrWatch(id, { links: [{ pr: testPr({ state: "merged" }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  registry.reviews.saveReview(testReview({ builder: id, reviewer: "th-elsewhere" as ThreadId, phase: { kind: "merged" } }));
  registry.judgments.saveJudgment({ failure: 1, thread: id } as Judgment, null);
  registry.planning.savePlanning({ thread: id, token: "tk", read: 0, sent: [] });
  registry.usage.recordUsage(id, [{ id: "call-1", agent: "claude", model: "claude-opus-5-5", at: Date.now(), input: 10, output: 5, cacheWrite: 0, cacheRead: 0 }],
    [{ source: pylonId, key: "/home/user/.claude/projects/x.jsonl", position: 10, before: "" }, { source: "harness", key: "conv-purged", position: 3, before: "" }]);
  registry.usage.startUsageBackfill([id], Date.now());
  registry.usage.stopUsageBackfill(Date.now());
  registry.threads.setThreadStatus(id, "archived");
  registry.threads.setThreadStatus(id, "deleted");
  registry.threads.recordAborted("conv-purged");
  return id;
}

test("a purge removes the deleted thread and every row tied to it, and keeps the event log, its start's request ID and the day's usage sums", (t) => {
  const path = tempDb();
  const registry = seedRegistry(testRegistry(t, path));
  const id = deletedWithEverything(registry);
  const before = rowsNaming(path, id);
  assert.deepEqual(Object.keys(rowsNaming(path, "conv-purged")).sort(), ["aborted_conversations", "threads", "usage_cursors"]);
  for (const table of ["threads", "pylons", "sessions", "previews", "outputs", "jobs", "thread_attention", "questions", "nudges", "pr_watches", "reviews",
    "judgments", "planning_threads", "usage_records", "usage_cursors", "usage_backfill_threads", "claude_workers", "events"]) assert.ok(before[table], `the thread has a row in ${table}`);
  const usage = () => registry.usage.usageReport({ since: null });

  const totals = usage().total;
  registry.threads.purgeThread(id);

  assert.equal(registry.threads.thread(id), undefined);
  assert.deepEqual(Object.keys(rowsNaming(path, id)), ["events", "start_requests"], "only the event log and its start's request ID name it");
  assert.deepEqual(usage().total, totals, "the day's sums keep its calls");
  assert.deepEqual(rowsNaming(path, "conv-purged"), {}, "nor its conversation's abort or cursor");
});

test("a purge leaves a thread that is not deleted as it is", (t) => {
  const path = tempDb();
  const registry = seedRegistry(testRegistry(t, path));
  const { id } = addThread(registry);
  registry.threads.setThreadStatus(id, "archived");
  registry.threads.purgeThread(id);
  assert.equal(registry.threads.threadStatus(id), "archived");
});

const week = 7 * 24 * 60 * 60_000;
const minute = 60_000;

/** A registry on a clock the test moves, its node observed with no pylon, and a retention pass whose delete sets the status, as the API's does first. */
function world(t: import("node:test").TestContext, path = tempDb(), start = Date.now()) {
  let now = start;
  const registry = seedRegistry(testRegistry(t, path, () => now));
  observeNode(registry);
  const logged: string[] = [];
  const pass = retentionPass({ registry, deleteThread: async (thread) => registry.threads.setThreadStatus(thread.id, "deleted"), log: (m) => { logged.push(m); } });
  const closed = (status: "archived" | "deleted", options: PylonOptions & { thread?: Partial<Thread> } = {}) => {
    const { id } = addThread(registry, options);
    registry.threads.setThreadStatus(id, "archived");
    if (status === "deleted") registry.threads.setThreadStatus(id, "deleted");
    return id;
  };
  return {
    registry, logged, closed,
    pass,
    /** Two passes, so a reason logged once shows it is not logged again. */
    async passes() { await pass.poll(); await pass.poll(); },
    later(ms: number) { now += ms; },
    get now() { return now; },
    status: (id: ThreadId) => registry.threads.threadStatus(id) ?? "purged",
    keeps: (id: ThreadId) => logged.filter((l) => l.startsWith(`retention: keeps ${id},`)),
  };
}

test("an archived thread idle for a week is deleted as the API deletes it, and its pylon's disk goes though its usage was never read; one active in the week stays", async (t) => {
  let now = Date.now();
  const s = await withThread(t, { clock: () => now });
  const idle = s.thread;
  const active = (await s.call("POST", "/v1/threads", { project: "acme", title: "Active" })).body as Thread;
  for (const { id } of [idle, active]) assert.equal((await s.call("POST", `/v1/threads/${id}/archive`)).status, 200);
  const logged: string[] = [];
  const pass = retentionPass({ registry: s.registry, deleteThread: s.api.deleteThread, log: (m) => { logged.push(m); } });
  now += 5 * 24 * 60 * minute;
  s.registry.threads.recordActivity(active.id, { human: now });
  const detail = async (id: ThreadId) => (await s.call("GET", `/v1/threads/${id}`)).body as ThreadDetail;
  assert.equal((await detail(idle.id)).desired, "paused", "an archive's disk stays while its usage is unread");

  now += 2 * 24 * 60 * minute + minute;
  await pass.poll();
  assert.equal((await detail(idle.id)).thread.status, "deleted");
  assert.equal((await detail(idle.id)).desired, "deleted", "its pylon is deleted, usage read or not");
  assert.deepEqual(s.calls.filter((c) => c[0] === "delete"), [["delete", { threadId: idle.id, pylonId: idle.pylonId }]], "its conversation is deleted as nexus delete deletes it");
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, new RegExp(`^retention: deleted ${idle.id}, archived and idle for a week from `));
  assert.equal((await detail(active.id)).thread.status, "archived", "activity in the week keeps it");

  now += 5 * 24 * 60 * minute;
  await pass.poll();
  assert.equal((await detail(active.id)).thread.status, "deleted", "a week after that activity it goes too");
});

test("an archived thread a feature still reads stays past its week, and the pass logs why once", async (t) => {
  const w = world(t);
  const r = w.registry;
  const free = w.closed("archived");
  const waitedFor = w.closed("archived");
  const queuedId = "th-queued" as ThreadId;
  r.queue.saveQueued({
    id: queuedId, title: "Next", project: "acme" as ProjectId, startedBy: "nLAPTOP", createdAt: w.now, after: [waitedFor],
    request: { project: "acme", title: "Next", resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } }, message: null, status: "queued",
    startNow: null, lastError: null, startedAt: null, firstMessage: null,
  });
  const [ahead, behind] = ["it-000000000001", "it-000000000002"] as [ItemId, ItemId];
  const built = testThread();
  r.threads.createThread(built, testPylon(built), { key: { requestId: requestIds.pipeline(ahead), body: "{}" } });
  r.threads.setThreadStatus(built.id, "archived");
  const aheadThread = built.id;
  const item = (id: ItemId, after: ItemId[]) => r.pipeline.saveItem({ id, project: "acme" as ProjectId, title: id, request: { project: "acme", title: id }, message: "Build it.", after, addedBy: "nLAPTOP", addedAt: w.now, approved: null, cancelled: null, lastError: null });
  item(ahead, []);
  item(behind, [ahead]);
  const withPr = w.closed("archived");
  r.prWatches.savePrWatch(withPr, { links: [{ pr: testPr({ number: 4, state: "open" }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const asking = w.closed("archived");
  r.questions.askQuestion({ kind: "judgment", id: "qn-open", thread: asking, text: "Retry?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: w.now, failure: 0 });
  const builder = w.closed("archived");
  const reviewer = w.closed("archived");
  r.reviews.saveReview(testReview({ builder, reviewer, phase: { kind: "reviewing" } }));
  const read = w.closed("archived");
  r.usage.startUsageBackfill([read], w.now);
  r.usage.holdUsageBackfill(read, w.now);

  w.later(week + minute);
  await w.passes();
  assert.equal(w.status(free), "deleted", "a thread nothing reads goes");
  const reasons: [ThreadId, string][] = [
    [waitedFor, `queued thread ${queuedId} waits for it`], [aheadThread, `pipeline item ${behind}, not queued yet, comes after it`], [withPr, "its pull request #4 is open"],
    [asking, "its question qn-open is open"], [builder, "its review rv-1 has not ended"], [reviewer, `review rv-1 of ${builder}, whose reviewer it is, has not ended`],
    [read, "the usage backfill holds its pylon"],
  ];
  for (const [id, why] of reasons) {
    assert.equal(w.status(id), "archived", why);
    assert.deepEqual(w.keeps(id), [`retention: keeps ${id}, as ${why}`]);
  }
});

test("a pipeline item whose thread was purged lists as archived and still names it", (t) => {
  const registry = seedRegistry(testRegistry(t, tempDb()));
  const item = "it-000000000001" as ItemId;
  const built = testThread();
  registry.threads.createThread(built, testPylon(built), { key: { requestId: requestIds.pipeline(item), body: "{}" } });
  registry.pipeline.saveItem({ id: item, project: "acme" as ProjectId, title: "Item", request: { project: "acme", title: "Item" }, message: "Build it.", after: [], addedBy: "nLAPTOP", addedAt: Date.now(), approved: null, cancelled: null, lastError: null });
  registry.threads.setThreadStatus(built.id, "deleted");
  registry.threads.purgeThread(built.id);

  const view = itemView(registry, registry.pipeline.item(item)!, Date.now());
  assert.equal(view.thread, built.id, "the item still names the thread it became, so no pass queues it again");
  assert.deepEqual(view.phase, { kind: "archived", why: "its thread was deleted and purged from the registry" });
});

test("a deleted thread is purged a week after its delete once a backup began since, but not while its pylon is on its node, its conversation's abort is unrecorded, or a stored review names it", async (t) => {
  const w = world(t);
  const r = w.registry;
  const free = w.closed("deleted");
  const listed = addThread(r);
  r.threads.setThreadStatus(listed.id, "deleted");
  observeNode(r, { pylons: [stoppedPylon(listed.pylonId)] });
  const unaborted = w.closed("deleted", { thread: { conversationId: "conv-1" } });
  const builder = addThread(r).id;
  const reviewer = w.closed("deleted");
  r.reviews.saveReview(testReview({ builder, reviewer, phase: { kind: "merged" } }));
  r.usage.recordUsage(free, [{ id: "call-1", agent: "pi", model: "gpt-6-astra", at: w.now, input: 7, output: 3, cacheWrite: 0, cacheRead: 0 }]);
  const usage = r.usage.usageReport({ since: null }).total;

  w.later(week + minute);
  await w.passes();
  assert.equal(w.status(free), "deleted");
  assert.deepEqual(w.keeps(free), [`retention: keeps ${free}, as it waits for a verified backup that began after its delete`]);

  r.threads.recordBackedUp(w.now);
  await w.passes();
  assert.equal(w.status(free), "purged");
  assert.ok(w.logged.some((l) => l.startsWith(`retention: purged ${free} from the registry`)));
  assert.deepEqual(r.usage.usageReport({ since: null }).total, usage, "its calls stay in the day's sums");
  for (const [id, why] of [
    [listed.id, "its pylon is not gone from rj-firebat: the node lists or routes it, or a job, preview port, retry or Claude launch of it is left to settle"],
    [unaborted, "the abort of its harness conversation is not recorded yet"],
    [reviewer, `review rv-1 of ${builder} names it as its reviewer until ${builder} is purged`],
  ] as const) {
    assert.equal(w.status(id), "deleted", why);
    assert.deepEqual(w.keeps(id).at(-1), `retention: keeps ${id}, as ${why}`);
  }

  observeNode(r);
  r.threads.recordAborted("conv-1");
  r.threads.setThreadStatus(builder, "deleted");
  await w.passes();
  assert.deepEqual([w.status(listed.id), w.status(unaborted)], ["purged", "purged"], "once its node no longer lists it, and once its abort is recorded");
  assert.equal(w.status(reviewer), "deleted");
  w.later(week + minute);
  r.threads.recordBackedUp(w.now);
  await w.pass.poll();
  assert.deepEqual([w.status(builder), w.status(reviewer)], ["purged", "deleted"], "the builder's purge takes its review");
  await w.pass.poll();
  assert.equal(w.status(reviewer), "purged", "which frees its reviewer");
});

test("a purge that throws is logged once, and the pass still purges and deletes the rest", async (t) => {
  const w = world(t);
  const r = w.registry;
  const stuck = w.closed("deleted");
  w.later(minute);
  const free = w.closed("deleted");
  const idle = w.closed("archived");
  const purge = r.threads.purgeThread;
  r.threads.purgeThread = (id) => { if (id === stuck) throw new Error("FOREIGN KEY constraint failed"); purge(id); };
  w.later(week + minute);
  r.threads.recordBackedUp(w.now);
  await w.passes();
  assert.deepEqual([w.status(stuck), w.status(free), w.status(idle)], ["deleted", "purged", "deleted"]);
  assert.deepEqual(w.logged.filter((l) => l.startsWith(`retention: purging ${stuck}`)), [`retention: purging ${stuck} failed: FOREIGN KEY constraint failed`]);
});

test("the first passes after retention's migration remove nothing for a week, then at most a pass's share of the old threads, oldest first", async (t) => {
  const path = tempDb();
  const old = Date.now() - 60 * 24 * 60 * minute;
  const before = seedRegistry(openRegistry(path, () => old));
  for (let i = 0; i < 80; i++) {
    const { id } = addThread(before, { thread: { createdAt: old, lastHumanActivityAt: old } });
    before.threads.setThreadStatus(id, "archived");
    if (i >= 25) before.threads.setThreadStatus(id, "deleted");
  }
  before.close();
  const raw = new DatabaseSync(path);
  raw.exec("DELETE FROM settings WHERE key = 'retention-since'");
  raw.close();
  rewindTo(path, versionBefore(/ADD COLUMN deleted_at\b/));

  const migrated = Date.now();
  const w = world(t, path, migrated + week - minute);
  const counts = () => {
    const [archived, deleted] = (["archived", "deleted"] as const).map((status) => w.registry.threads.storedThreads({ status: [status] }).length);
    return { archived, deleted, purged: 80 - archived! - deleted! };
  };
  w.registry.threads.recordBackedUp(migrated + 24 * 60 * minute);
  await w.pass.poll();
  assert.deepEqual(counts(), { archived: 25, deleted: 55, purged: 0 }, "a week after the migration has not passed, so nothing goes, however old the threads");

  w.later(2 * minute);
  await w.pass.poll();
  assert.deepEqual(counts(), { archived: 5, deleted: 55 - 50 + 20, purged: 50 }, "one pass deletes 20 and purges 50");
  await w.pass.poll();
  assert.deepEqual(counts(), { archived: 0, deleted: 25, purged: 55 }, "the next takes the rest, and the threads it deleted wait their own week");
});
