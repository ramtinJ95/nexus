import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadId } from "./registry.ts";
import { testPylon, testRegistry, testThread } from "./test-kit.ts";
import { agentInbox } from "./inbox.ts";
import { usageLimitResumer } from "./usage-limit.ts";
import { usageLimitPrefix } from "../agent-protocol.ts";
import { transcriptStart, type ClaudeEntry } from "../claude-transcript.ts";
import type { LiveHash, NodeName, PylonId, TailnetNodeId } from "../ids.ts";
import type { CommandResult, PylonCommand } from "../protocol/commands.ts";
import type { ProjectId } from "../project.ts";
import { runningPylon, testCapacity, testObservation, watch } from "../test-kit.ts";

const node = "node" as NodeName;
const session = "c0ffee00-0000-4000-8000-000000000000";
const resetsAt = 10_000_000;
const graceMs = 180_000;

/** A Claude worker thread whose transcript ends on a usage limit, behind the real inbox and a probe that types or blocks. */
function fixture(t: import("node:test").TestContext, limit: { resetsAt: number | null } = { resetsAt }, ids: readonly string[] = ["th-1"]) {
  const registry = testRegistry(t);
  const project = { id: "project" as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };
  registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
  registry.createProject(project);
  const threads = ids.map((id) => testThread({ id: id as ThreadId, title: "test", project: project.id, startedBy: "test", createdAt: 1, lastHumanActivityAt: 1 }));
  for (const thread of threads) {
    const pylon = testPylon(thread, { node, liveHash: "hash", boot: { repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "main" } }, dotfiles: { repo: project.repoUrl, ref: "main" } } });
    registry.createThread(thread, pylon, "/poteto-mode fix it");
    registry.setClaudeWorker(thread.id, "/poteto-mode fix it", "started", undefined, session);
    const stop: ClaudeEntry = { kind: "notice", at: 5000, tone: "error", text: "You've hit your session limit", usageLimit: limit };
    registry.appendClaudeRead(thread.id, { session, from: transcriptStart, entries: [stop], cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: 1 });
  }
  const thread = threads[0]!;
  registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  registry.ingested(testObservation(node, { pylons: threads.map((th) => runningPylon(th.pylonId, { liveHash: "hash" as LiveHash })) }), []);
  const typed: Extract<PylonCommand, { kind: "send-claude" }>[] = [];
  let outcome: "sent" | "blocked" = "sent";
  const probe = { async command(_: PylonId, command: PylonCommand): Promise<CommandResult> { typed.push(command as Extract<PylonCommand, { kind: "send-claude" }>); return { kind: "send-claude", outcome, herdrPane: "w1:p1", resumed: false }; } };
  const inbox = agentInbox({ registry, harness: { async send() { throw new Error("a Claude worker's message never reaches the harness"); } }, probes: new Map([[node, probe]]), wake() {} });
  let now = resetsAt + graceMs;
  let gate: Promise<void> | null = null;
  const gated: typeof inbox = async (th, message) => { await gate; return inbox(th, message); };
  const resumer = usageLimitResumer({ registry, inbox: gated, clock: () => now, graceMs });
  const continued = () => registry.events("0", { kinds: ["usage-limit.continued"] });
  return { registry, id: thread.id, typed, resumer, continued, setNow(at: number) { now = at; }, setOutcome(o: typeof outcome) { outcome = o; }, hold(until: Promise<void> | null) { gate = until; } };
}

test("a worker stopped on its usage limit is told to continue once, after the reset and its grace, under the stop's request ID", async (t) => {
  const f = fixture(t);
  f.setNow(resetsAt + graceMs - 1);
  await f.resumer.poll();
  assert.equal(f.typed.length, 0, "nothing is typed before the reset and its grace pass");
  f.setNow(resetsAt + graceMs);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.typed[0]!.session, session);
  assert.equal(f.typed[0]!.text, `${usageLimitPrefix} The usage limit reset. Continue where you stopped.`);
  const requestId = `usage-limit:${session}:5000`;
  assert.deepEqual(f.continued().map((e) => e.payload), [{ session, stoppedAt: 5000, resetsAt, requestId }]);
  assert.notEqual(f.registry.claudeMessage(f.id, requestId), undefined);
  assert.ok(f.registry.thread(f.id)!.usageLimit, "the thread still shows the stop until Claude's next turn starts");
  await f.resumer.poll();
  assert.equal(f.typed.length, 1, "a stop gets one message");
  assert.equal(f.continued().length, 1);
});

test("a worker whose usage limit names no reset, a reset no later than the stop, or whose thread is archived, is not told to continue", async (t) => {
  const unknown = fixture(t, { resetsAt: null });
  unknown.setNow(Number.MAX_SAFE_INTEGER);
  await unknown.resumer.poll();
  assert.equal(unknown.typed.length, 0);
  const past = fixture(t, { resetsAt: 5000 });
  past.setNow(Number.MAX_SAFE_INTEGER);
  await past.resumer.poll();
  assert.equal(past.typed.length, 0, "a reset that had passed when the limit stopped the worker would stop it again");
  const archived = fixture(t);
  archived.registry.setThreadStatus(archived.id, "archived");
  await archived.resumer.poll();
  assert.equal(archived.typed.length, 0);
  assert.equal(archived.continued().length, 0);
});

test("a message the session could not take yet is sent again on the next poll", async (t) => {
  const f = fixture(t);
  f.setOutcome("blocked");
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.continued().length, 0, "a message that typed nothing did not continue the worker");
  f.setOutcome("sent");
  await f.resumer.poll();
  assert.equal(f.typed.length, 2);
  assert.equal(f.continued().length, 1);
});

test("a thread archived or continued while an earlier thread's message is being sent is not told to continue", async (t) => {
  const f = fixture(t, { resetsAt }, ["th-1", "th-2", "th-3"]);
  const released = Promise.withResolvers<void>();
  f.hold(released.promise);
  const poll = f.resumer.poll();
  await new Promise((resolve) => setImmediate(resolve));
  f.hold(null);
  f.registry.setThreadStatus("th-2" as ThreadId, "archived");
  f.registry.appendClaudeRead("th-3" as ThreadId, { session, from: { ...transcriptStart, offset: 1 }, entries: [{ kind: "prompt", at: 6000, text: "continue", from: "person" }], cursor: { ...transcriptStart, offset: 2 }, reset: false, readAt: 2 });
  released.resolve();
  await poll;
  assert.deepEqual(f.continued().map((e) => e.thread), ["th-1"], "only the thread that was still stopped when its turn came was told to continue");
  assert.equal(f.typed.length, 1);
});

test("a poll while a pass runs joins it and settles after it, and a poll after it settles runs a new pass", async (t) => {
  const f = fixture(t);
  f.setOutcome("blocked");
  const released = Promise.withResolvers<void>();
  f.hold(released.promise);
  const first = f.resumer.poll();
  const second = watch(f.resumer.poll());
  assert.equal(await second(), false, "the joined poll waits for the pass it joined");
  released.resolve();
  await first;
  assert.equal(await second(), true);
  assert.equal(f.typed.length, 1, "one pass ran for both polls");
  await f.resumer.poll();
  assert.equal(f.typed.length, 2);
});

test("close waits for the pass in flight", async (t) => {
  const f = fixture(t);
  const released = Promise.withResolvers<void>();
  f.hold(released.promise);
  void f.resumer.poll();
  const closed = watch(f.resumer.close());
  assert.equal(await closed(), false);
  assert.equal(f.typed.length, 0);
  released.resolve();
  assert.equal(await closed(), true);
  assert.equal(f.typed.length, 1, "the pass finished before close resolved");
});

test("a pass that throws rejects every poll that joined it, and the next poll runs a new pass", async (t) => {
  const f = fixture(t);
  const threads = f.registry.storedThreads;
  f.registry.storedThreads = () => { throw new Error("database is locked"); };
  await Promise.all([
    assert.rejects(f.resumer.poll(), /database is locked/),
    assert.rejects(f.resumer.poll(), /database is locked/),
  ]);
  f.registry.storedThreads = threads;
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  await f.resumer.close();
});

test("a pass reads no archived or deleted thread", async (t) => {
  const f = fixture(t, { resetsAt }, ["th-1", "th-archived", "th-deleted"]);
  f.registry.setThreadStatus("th-archived" as ThreadId, "archived");
  f.registry.setThreadStatus("th-deleted" as ThreadId, "deleted");
  const read: ThreadId[] = [];
  const registry = { ...f.registry, thread: (id: ThreadId) => { read.push(id); return f.registry.thread(id); } };
  const resumer = usageLimitResumer({ registry, inbox: async () => "delivered", clock: () => resetsAt + graceMs, graceMs });
  await resumer.poll();
  assert.deepEqual(read, ["th-1"]);
  assert.equal(registry.events("0", { kinds: ["usage-limit.continued"] }).length, 1);
});
