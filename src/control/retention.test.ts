import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addThread, claudeWorkerAt, seedRegistry, testPr, testPylon, testRegistry, testReview, testThread } from "../test-support/registry-kit.ts";
import { tempDir } from "../test-support/kit.ts";
import type { Registry } from "./registry.ts";
import type { JobId, NodeName, ThreadId } from "../ids.ts";
import type { Judgment } from "./judgment-store.ts";

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
