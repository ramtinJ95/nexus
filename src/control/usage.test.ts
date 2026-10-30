import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openRegistry, type Registry, type Thread, type ThreadId } from "./registry.ts";
import { addThread as addTestThread, observeNode, seedRegistry } from "./test-kit.ts";
import { usageCounter } from "./usage-counter.ts";
import { tokenCount, usageFilter, utc } from "./usage.ts";
import type { AgentCall, Tokens } from "../agent-usage.ts";
import { checkCaller, reviewerCaller, roleOf, verifyCaller } from "../agent-protocol.ts";
import { processStream } from "../process-stream.ts";
import type { ConversationId } from "../harness/host.ts";
import type { LiveHash, NodeName, PylonId } from "../ids.ts";
import type { ProbeClient } from "../protocol/client.ts";
import type { ProjectId } from "../project.ts";
import type { ImageId } from "../images.ts";
import { runningPylon } from "../test-kit.ts";

const node = "rj-firebat" as NodeName;
const image: ImageId = "img-000000000000";
const fixtures = new URL("../fixtures/", import.meta.url);
/** The calls in src/fixtures/claude-transcript.jsonl, summed by hand: 9 messages, several written as more than one record. */
const claudeFixture: Tokens & { calls: number } = { calls: 9, input: 20, output: 1523, cacheWrite: 37665, cacheRead: 293246 };
/** The two calls of src/fixtures/pi-session.jsonl, a real pi 1.4.0 session on gpt-6-astra. */
const piFixture: Tokens & { calls: number } = { calls: 2, input: 1723 + 204, output: 5 + 5, cacheWrite: 0, cacheRead: 1536 };

const dir = await mkdtemp(join(tmpdir(), "nexus-usage-"));
after(() => rm(dir, { recursive: true }));

function openOnline(path = join(dir, `${randomUUID()}.db`)): Registry {
  return seedRegistry(openRegistry(path), { nodes: [node] });
}

function addThread(registry: Registry, options: { startedBy?: string; conversationId?: string | null; phase?: "running" | "paused" } = {}): Thread {
  const conversationId = options.conversationId ?? null;
  // As a start does: a harness thread has no Claude worker.
  const { id, pylonId } = addTestThread(registry, { node, boot: { image }, thread: { conversationId, startedBy: options.startedBy ?? "nLAPTOP" }, claudePrompt: conversationId === null ? "hello" : undefined });
  observe(registry, pylonId, options.phase ?? "running");
  return registry.thread(id)!;
}

function observe(registry: Registry, pylonId: PylonId, phase: "running" | "paused") {
  const pylons = [...(registry.node(node)?.observation?.pylons ?? []).filter((p) => p.pylonId !== pylonId), ...phase === "paused" ? [] : [
    runningPylon(pylonId, { liveHash: "hash-1" as LiveHash, bootedAt: new Date().toISOString(), bootedFrom: { image, checkpoint: null } }),
  ]];
  observeNode(registry, { node, probeBootId: "boot-1", artifacts: [image], pylons });
}

/** A pylon's home: the Claude fixture as a worker's transcript, and the pi fixture as a reviewer's session. */
function pylonHome() {
  const home = join(dir, randomUUID());
  const logs = { claude: join(home, ".claude/projects"), pi: join(home, ".pi/agent/sessions") };
  const transcript = join(logs.claude, "-home-user-workspace-repo", "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30.jsonl");
  const session = join(logs.pi, "--home-user-workspace-repo--", "2026-10-27T22-42-05-996Z_01a17f87-262c-71b1-937e-ee435ee114b8.jsonl");
  mkdirSync(join(transcript, ".."), { recursive: true });
  mkdirSync(join(session, ".."), { recursive: true });
  copyFileSync(new URL("claude-transcript.jsonl", fixtures), transcript);
  copyFileSync(new URL("pi-session.jsonl", fixtures), session);
  return { logs, transcript, session };
}

/** A probe that runs each pipe as a local process, counting them. */
const usageHelper = readFileSync(new URL("../agent-usage.py", import.meta.url), "utf8");

/** Each stream runs on this machine. Its argv must fit the probe's request URL, as protocol/streams.ts's streamPath encodes it. */
function localProbe() {
  const probe = {
    reads: 0,
    stream: async (_pylon: PylonId, argv: readonly string[]) => {
      assert.ok(encodeURIComponent(JSON.stringify({ argv })).length < 2048, "the usage read's argv fits a small request URL");
      assert.ok(!argv.some((arg) => arg.includes(usageHelper.split("\n")[0]!)), "the helper's source is not in argv");
      probe.reads++;
      return processStream(argv[0]!, argv.slice(1), () => undefined);
    },
  };
  return probe as typeof probe & Pick<ProbeClient, "stream">;
}

const noHarness = { usage: async (_: ConversationId, after: number | null) => ({ calls: [], last: after }) };
const sum = (a: Tokens & { calls: number }, b: Tokens & { calls: number }) => ({
  calls: a.calls + b.calls, input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead,
});
const totals = (registry: Registry, thread?: ThreadId) => {
  const { calls, input, output, cacheWrite, cacheRead } = registry.usageReport({ since: null, thread: thread ?? null }).total;
  return { calls, input, output, cacheWrite, cacheRead };
};

test("a pylon's Claude transcripts and pi sessions count each call once, however often they are read", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = addThread(registry);
  const { logs, transcript, session } = pylonHome();
  const probe = localProbe();
  const counter = usageCounter({ registry, probes: new Map([[node, probe]]), harness: noHarness, logs, sweepMs: 3_600_000 });
  t.after(() => counter.close());
  await counter.sweep();
  const both = sum(claudeFixture, piFixture);
  assert.deepEqual(totals(registry), both);
  const report = registry.usageReport({ since: null, by: ["kind", "model", "role"] });
  assert.deepEqual(report.by.kind!.map((r) => [r.key, r.calls]), [["claude", 9], ["pi", 2]]);
  assert.deepEqual(report.by.model!.map((r) => r.key), ["claude-sonnet-5-5", "gpt-6-astra"]);
  assert.deepEqual(report.by.role!.map((r) => r.key), ["builder"]);

  await counter.sweep();
  assert.deepEqual(totals(registry), both, "a second read finds nothing new");
  // The same records written again, as a resumed or forked session copies them, are the same calls.
  appendFileSync(transcript, readFileSync(transcript));
  appendFileSync(session, readFileSync(session, "utf8").split("\n").slice(1).join("\n"));
  await counter.sweep();
  assert.deepEqual(totals(registry), both, "copied records count nothing twice");

  const next = { type: "assistant", timestamp: "2026-10-27T23:00:00.000Z", message: { id: "msg_new", model: "claude-opus-5-5", usage: { input_tokens: 3, output_tokens: 40, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000 } } };
  appendFileSync(transcript, `${JSON.stringify(next)}\n{"type":"assistant","message":{"id":"msg_half`);
  await counter.sweep();
  assert.deepEqual(totals(registry), sum(both, { calls: 1, input: 3, output: 40, cacheWrite: 500, cacheRead: 9000 }), "a call appended later counts once, and a half-written line waits");
});

test("a whole read counts every call from the start of each transcript, past where live counting's cursors stand, once", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = addThread(registry);
  const { logs, transcript, session } = pylonHome();
  const end = (path: string) => {
    const bytes = readFileSync(path);
    return { source: thread.pylonId, key: path, position: bytes.length, before: createHash("sha256").update(bytes.subarray(Math.max(0, bytes.length - 4096))).digest("hex") };
  };
  registry.recordUsage(thread.id, [], [end(transcript), end(session)]);
  const probe = localProbe();
  const counter = usageCounter({ registry, probes: new Map([[node, probe]]), harness: noHarness, logs, sweepMs: 3_600_000 });
  t.after(() => counter.close());
  await counter.sweep();
  assert.deepEqual(totals(registry).calls, 0, "live counting reads on from its cursors, past every call");

  const both = sum(claudeFixture, piFixture);
  const tokens = both.input + both.output + both.cacheWrite + both.cacheRead;
  assert.deepEqual(await counter.readWhole(thread.id), { calls: both.calls, tokens });
  assert.deepEqual(totals(registry), both);
  assert.deepEqual(await counter.readWhole(thread.id), { calls: 0, tokens: 0 }, "a second whole read recovers nothing");
  await counter.sweep();
  assert.deepEqual(totals(registry), both);

  observe(registry, thread.pylonId, "paused");
  const reads = probe.reads;
  await assert.rejects(counter.readWhole(thread.id), { message: "its pylon is not running" });
  assert.equal(probe.reads, reads, "a paused pylon is not read");
});

test("a whole read cut short keeps what its finished reads recovered on the thread's backfill row, and so does finishing the thread", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = addThread(registry, { phase: "paused" });
  const { logs, transcript } = pylonHome();
  // Over a megabyte of calls, which takes more than one read.
  const many = Array.from({ length: 8_000 }, (_, i) => JSON.stringify({ type: "assistant", timestamp: "2026-10-27T23:00:00.000Z", message: { id: `msg_many_${i}`, model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 2 } } }));
  appendFileSync(transcript, `${many.join("\n")}\n`);
  const probe = localProbe();
  let lost = true;
  const stream = probe.stream;
  probe.stream = (pylon, argv) => probe.reads === 1 && lost ? Promise.reject(new Error("the pipe to the pylon was lost")) : stream(pylon, argv);
  const counter = usageCounter({ registry, probes: new Map([[node, probe]]), harness: noHarness, logs, sweepMs: 3_600_000 });
  t.after(() => counter.close());
  registry.startUsageBackfill([thread.id], Date.now());
  observe(registry, thread.pylonId, "running");
  const row = () => {
    const { calls, tokens } = registry.usageBackfillThreads()[0]!;
    return { calls, tokens };
  };
  const recorded = () => {
    const { calls, total } = registry.usageReport({ since: null }).total;
    return { calls, tokens: total };
  };

  await assert.rejects(counter.readWhole(thread.id), { message: "the pipe to the pylon was lost" });
  assert.ok(recorded().calls > 0 && recorded().calls < 8_000, `the first read recorded part of the calls: ${recorded().calls}`);
  assert.deepEqual(row(), recorded(), "the row holds what the read recorded before it failed");
  registry.finishUsageBackfillThread(thread.id, "skipped", "reading it failed: the pipe to the pylon was lost", Date.now());
  assert.deepEqual(row(), recorded(), "skipping the thread keeps it");

  lost = false;
  registry.startUsageBackfill([thread.id], Date.now());
  await counter.readWhole(thread.id);
  registry.finishUsageBackfillThread(thread.id, "done", null, Date.now());
  const all = sum(claudeFixture, piFixture);
  assert.deepEqual(recorded(), { calls: all.calls + 8_000, tokens: all.input + all.output + all.cacheWrite + all.cacheRead + 8_000 * 3 });
  assert.deepEqual(row(), recorded(), "the read after it recovered the rest, and the row holds both");
  const run = registry.usageBackfill();
  assert.ok(run.state === "running" && run.recovered.calls === recorded().calls);
});

test("the counts survive a restart, which reads on from where the last read stopped", async (t) => {
  const path = join(dir, `${randomUUID()}.db`);
  const registry = openOnline(path);
  const thread = addThread(registry);
  const { logs } = pylonHome();
  const first = usageCounter({ registry, probes: new Map([[node, localProbe()]]), harness: noHarness, logs, sweepMs: 3_600_000 });
  await first.sweep();
  await first.close();
  registry.close();

  const reopened = openOnline(path);
  t.after(() => reopened.close());
  assert.equal(reopened.usageCursors(thread.pylonId).size, 2);
  const second = usageCounter({ registry: reopened, probes: new Map([[node, localProbe()]]), harness: noHarness, logs, sweepMs: 3_600_000 });
  t.after(() => second.close());
  await second.sweep();
  assert.deepEqual(totals(reopened), sum(claudeFixture, piFixture));
});

test("a replaced transcript is read from its start, and its calls already counted stay counted once", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  addThread(registry);
  const { logs, transcript } = pylonHome();
  const counter = usageCounter({ registry, probes: new Map([[node, localProbe()]]), harness: noHarness, logs, sweepMs: 3_600_000 });
  t.after(() => counter.close());
  await counter.sweep();
  const lines = readFileSync(transcript, "utf8").split("\n");
  writeFileSync(transcript, lines.slice(0, 20).join("\n") + "\n");
  await counter.sweep();
  assert.deepEqual(totals(registry), sum(claudeFixture, piFixture));
});

test("deleting a thread keeps its counts, and a paused or deleted thread's pylon is not read", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = addThread(registry);
  const { logs } = pylonHome();
  const probe = localProbe();
  const counter = usageCounter({ registry, probes: new Map([[node, probe]]), harness: noHarness, logs, sweepMs: 3_600_000 });
  t.after(() => counter.close());
  await counter.sweep();
  const reads = probe.reads;
  observe(registry, thread.pylonId, "paused");
  await counter.sweep();
  assert.equal(probe.reads, reads, "a paused pylon is not woken to read it");
  registry.setThreadStatus(thread.id, "deleted");
  await counter.sweep();
  assert.equal(probe.reads, reads);
  assert.deepEqual(totals(registry, thread.id), sum(claudeFixture, piFixture));
});

test("the Nexus agent's calls are read from the harness after the last entry read, a deleted thread's too", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = addThread(registry, { conversationId: "7", phase: "paused" });
  const entries: AgentCall[] = [1, 2, 3].map((n) => ({ id: `harness:7/${n}`, agent: "pi", model: "gpt-6-astra", at: 1_000 * n, input: 100 * n, output: n, cacheWrite: 0, cacheRead: 10 * n }));
  const asked: (number | null)[] = [];
  const harness = {
    usage: async (conversation: ConversationId, after: number | null) => {
      assert.equal(conversation, 7);
      asked.push(after);
      const calls = entries.filter((_, i) => after === null || i + 1 > after);
      return { calls, last: entries.length };
    },
  };
  const counter = usageCounter({ registry, probes: new Map(), harness, sweepMs: 3_600_000, followMs: 10 });
  t.after(() => counter.close());
  await counter.sweep();
  assert.deepEqual(totals(registry), { calls: 3, input: 600, output: 6, cacheWrite: 0, cacheRead: 60 });
  entries.push({ id: "harness:7/4", agent: "pi", model: "gpt-6-astra", at: 4_000, input: 400, output: 4, cacheWrite: 0, cacheRead: 40 });
  registry.setThreadStatus(thread.id, "deleted");
  registry.recordReply(thread.id, Date.now());
  for (let i = 0; i < 100 && totals(registry).calls < 4; i++) await delay(10);
  assert.deepEqual(totals(registry), { calls: 4, input: 1000, output: 10, cacheWrite: 0, cacheRead: 100 });
  assert.equal(asked.at(-1), 3, "the turn's end reads on from the last entry read");
});

test("a sweep reads an archived thread's Nexus agent from the harness, and a deleted thread's not at all", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const deleted = addThread(registry, { conversationId: "7", phase: "paused" });
  const archived = addThread(registry, { conversationId: "8", phase: "paused" });
  const asked: ConversationId[] = [];
  const harness = { usage: async (conversation: ConversationId, after: number | null) => { asked.push(conversation); return { calls: [], last: after }; } };
  const counter = usageCounter({ registry, probes: new Map(), harness, sweepMs: 3_600_000 });
  t.after(() => counter.close());
  await counter.sweep();
  assert.deepEqual(new Set(asked), new Set([7, 8]));
  registry.setThreadStatus(deleted.id, "deleted");
  registry.setThreadStatus(archived.id, "archived");
  asked.length = 0;
  await counter.sweep();
  assert.deepEqual(asked, [8]);
});

test("a deleted thread's harness read in flight through a sweep still runs one at a time", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = addThread(registry, { conversationId: "7", phase: "paused" });
  let calls = 0;
  let running = 0;
  let most = 0;
  let open = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let hold = false;
  const harness = {
    usage: async (_: ConversationId, after: number | null) => {
      calls++;
      most = Math.max(most, ++running);
      if (hold) await gate;
      running--;
      return { calls: [], last: after };
    },
  };
  const counter = usageCounter({ registry, probes: new Map(), harness, sweepMs: 3_600_000, followMs: 10 });
  t.after(() => { open(); return counter.close(); });
  await counter.sweep();
  registry.setThreadStatus(thread.id, "deleted");
  hold = true;
  registry.recordReply(thread.id, Date.now());
  for (let i = 0; i < 100 && running === 0; i++) await delay(10);
  const before = calls;
  void counter.sweep();
  await delay(50);
  registry.recordReply(thread.id, Date.now());
  await delay(100);
  assert.equal(calls, before, "the next turn's end waits for the read in flight");
  hold = false;
  open();
  for (let i = 0; i < 100 && calls === before; i++) await delay(10);
  assert.equal(calls, before + 1, "and then reads once more");
  assert.equal(most, 1);
});

test("a forked pi session, a replaced transcript of the same size, and another thread's copy of a session count each call once", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  addThread(registry);
  const { logs, transcript, session } = pylonHome();
  const counter = usageCounter({ registry, probes: new Map([[node, localProbe()]]), harness: noHarness, logs, sweepMs: 3_600_000 });
  t.after(() => counter.close());
  const usageEntry = { type: "usage", id: "f6g7h8i9", parentId: "f8688165", timestamp: "2026-10-27T22:43:00.000Z", kind: "cache_warm", provider: "openai", model: "gpt-6-astra", usage: { input: 0, output: 0, cacheRead: 500, cacheWrite: 0, totalTokens: 500 } };
  appendFileSync(session, `${JSON.stringify(usageEntry)}\n`);
  await counter.sweep();
  const both = sum(sum(claudeFixture, piFixture), { calls: 1, input: 0, output: 0, cacheWrite: 0, cacheRead: 500 });
  assert.deepEqual(totals(registry), both);
  // A fork copies the entries under a new session header, and its usage entry has no response ID.
  const [, ...entries] = readFileSync(session, "utf8").split("\n");
  writeFileSync(join(session, "..", "2026-10-27T23-00-00-000Z_0f0f0f0f-0000-4000-8000-000000000000.jsonl"), [JSON.stringify({ type: "session", version: 3, id: "0f0f0f0f-0000-4000-8000-000000000000" }), ...entries].join("\n"));
  await counter.sweep();
  assert.deepEqual(totals(registry), both, "a fork's copies are the same calls");

  // Another transcript of the same size, whose last line is a new call.
  const lines = readFileSync(transcript, "utf8").split("\n");
  const last = lines.at(-2)!;
  const call = { type: "assistant", timestamp: "2026-10-27T23:00:00.000Z", message: { id: "msg_replaced", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
  const line = JSON.stringify({ ...call, pad: "" });
  writeFileSync(transcript, [...lines.slice(0, -2), JSON.stringify({ ...call, pad: "x".repeat(Buffer.byteLength(last) - Buffer.byteLength(line)) }), ""].join("\n"));
  assert.equal(readFileSync(transcript).length, Buffer.byteLength(lines.join("\n")));
  await counter.sweep();
  assert.equal(totals(registry).calls, both.calls + 1, "a replacement of the same size is read from its start, and its one new call counts");

  const other = addThread(registry, { startedBy: reviewerCaller });
  const before = registry.usageReport({ since: null, by: ["role"] }).by.role;
  registry.recordUsage(other.id, [{ id: "claude:msg_replaced", agent: "claude", model: "claude-sonnet-5-5", at: 0, input: 999, output: 999, cacheWrite: 999, cacheRead: 999 }]);
  assert.deepEqual(registry.usageReport({ since: null, by: ["role"] }).by.role, before, "another thread's read of a call changes nothing");
});

test("a pylon's read is refused whole when a call claims another agent's ID or a count past 10⁹", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = addThread(registry);
  registry.recordUsage(thread.id, [{ id: "harness:7/1", agent: "pi", model: "gpt-6-astra", at: 0, input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }]);
  const call = (id: string, input: number) => JSON.stringify({ id, agent: "pi", model: "gpt-6-astra", at: 1, input, output: 0, cacheWrite: 0, cacheRead: 0 });
  // The counter's sweep at start takes the first reply, and the sweep after it the second.
  const lines = [[call("pi:ok", 5), call("harness:7/1", 1_000_000)], [call("pi:ok", 5), call("pi:huge", 2e9)], [call("pi:ok", 5)]];
  const probe = {
    stream: async () => {
      const out = [...lines.shift()!, JSON.stringify({ offsets: {}, more: false })].join("\n") + "\n";
      return processStream("sh", ["-c", `cat > /dev/null; printf '%s' '${out}'`], () => undefined);
    },
  };
  const logged: string[] = [];
  const counter = usageCounter({ registry, probes: new Map([[node, probe]]), harness: noHarness, sweepMs: 3_600_000, log: (m) => logged.push(m) });
  t.after(() => counter.close());
  await counter.sweep();
  assert.equal(totals(registry).calls, 1, "neither read recorded anything");
  assert.equal(logged.length, 2);
  await counter.sweep();
  assert.deepEqual(totals(registry), { calls: 2, input: 6, output: 1, cacheWrite: 0, cacheRead: 0 });
});

test("an event cursor that retention passed reads every thread and follows on from the newest", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  addThread(registry);
  const { logs } = pylonHome();
  let expired = false;
  const logged: string[] = [];
  const watched = { ...registry, eventBatch: (...args: Parameters<Registry["eventBatch"]>) => {
    if (expired) {
      expired = false;
      throw new Error("invalid event cursor");
    }
    return registry.eventBatch(...args);
  } };
  const probe = localProbe();
  const counter = usageCounter({ registry: watched, probes: new Map([[node, probe]]), harness: noHarness, logs, sweepMs: 3_600_000, followMs: 5, log: (m) => logged.push(m) });
  t.after(() => counter.close());
  await counter.sweep();
  const reads = probe.reads;
  expired = true;
  for (let i = 0; i < 200 && probe.reads === reads; i++) await delay(10);
  assert.match(logged[0]!, /invalid event cursor\. Reading every thread/);
  assert.equal(probe.reads, reads + 1, "the sweep after it read the pylon again");
  assert.deepEqual(totals(registry), sum(claudeFixture, piFixture));
});

test("each thread's role comes from who started it", () => {
  assert.equal(roleOf("nLAPTOP"), "builder");
  assert.equal(roleOf(reviewerCaller), "reviewer");
  assert.equal(roleOf(checkCaller), "check");
  assert.equal(roleOf(verifyCaller), "verify");
  assert.equal(roleOf("something-else"), "other");
});

test("a verify pylon's calls count under the verify role", (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const verify = addThread(registry, { startedBy: verifyCaller });
  registry.recordUsage(verify.id, [{ id: "v", agent: "claude", model: "claude-opus-5-5", at: Date.now(), input: 10, output: 1, cacheWrite: 0, cacheRead: 0 }]);
  assert.deepEqual(registry.usageReport({ since: null, by: ["role"] }).by.role!.map((r) => [r.key, r.calls]), [["verify", 1]]);
});

test("the report groups calls by model, project, kind, role and UTC day, within the period and project asked for", (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const builder = addThread(registry);
  const reviewer = addThread(registry, { startedBy: reviewerCaller });
  const call = (id: string, at: number, model: string, input: number): AgentCall => ({ id, agent: "pi", model, at, input, output: 1, cacheWrite: 2, cacheRead: 3 });
  const day = Date.UTC(2026, 9, 26);
  registry.recordUsage(builder.id, [call("a", day + 1_000, "gpt-6-astra", 10), call("b", day + 86_400_000, "gpt-6-astra", 20)]);
  registry.recordUsage(reviewer.id, [call("c", day + 86_400_000 + 5, "claude-opus-5-5", 1000)]);
  // A later read of the same call with a larger count keeps the larger, and its time stays.
  registry.recordUsage(builder.id, [{ ...call("a", day + 9_000_000, "gpt-6-astra", 15), output: 0 }]);
  const report = registry.usageReport({ since: null, by: ["model", "role", "day"] });
  assert.deepEqual(report.total, { input: 1035, output: 3, cacheWrite: 6, cacheRead: 9, total: 1053, calls: 3 });
  assert.deepEqual(report.by.model!.map((r) => [r.key, r.total]), [["claude-opus-5-5", 1006], ["gpt-6-astra", 47]]);
  assert.deepEqual(report.by.role!.map((r) => [r.key, r.calls]), [["reviewer", 1], ["builder", 2]]);
  assert.deepEqual(report.by.day!.map((r) => [r.key, r.calls]), [["2026-10-27", 2], ["2026-10-26", 1]]);
  assert.equal(registry.usageReport({ since: day + 86_400_000, by: [] }).total.calls, 2);
  assert.equal(registry.usageReport({ since: null, project: "other" as ProjectId, by: [] }).total.calls, 0);
  assert.ok(Math.abs(report.countingSince - Date.now()) < 60_000);
});

test("the usage query takes a period or a UTC day, and refuses anything else", () => {
  const now = Date.UTC(2026, 9, 27, 15, 30);
  const q = (s: string) => usageFilter(new URLSearchParams(s), now);
  assert.equal(q("").since, null);
  assert.equal(q("since=today").since, Date.UTC(2026, 9, 27));
  assert.equal(q("since=7d").since, Date.UTC(2026, 9, 21));
  assert.equal(q("since=30d").since, Date.UTC(2026, 8, 28));
  assert.equal(q("since=2026-10-01").since, Date.UTC(2026, 9, 1));
  assert.deepEqual(q("by=model&by=day,model").by, ["model", "day"]);
  assert.equal(q("").by.length, 5);
  assert.throws(() => q("since=yesterday"), /since must be/);
  assert.throws(() => q("since=1790000000000"), /since must be/);
  assert.throws(() => q("by=thread"), /by must be one of/);
});

test("token counts read as 950, 12.3k, 1.2M", () => {
  assert.deepEqual([0, 950, 1000, 12_345, 999_499, 999_600, 1_234_567, 3_400_000_000].map(tokenCount), ["0", "950", "1k", "12.3k", "999k", "1M", "1.2M", "3.4B"]);
});

test("a time reads to the minute in UTC", () => {
  assert.equal(utc(Date.parse("2026-10-27T09:05:59.999Z")), "2026-10-27 09:05 UTC");
  assert.equal(utc(0), "1970-01-01 00:00 UTC");
});
