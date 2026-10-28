import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openRegistry, type Registry, type Thread, type ThreadId } from "./registry.ts";
import { usageCounter } from "./usage-counter.ts";
import { roleOf, tokenCount, usageFilter, type AgentCall, type Tokens } from "./usage.ts";
import { reviewerCaller } from "./review.ts";
import { checkCaller } from "./gate.ts";
import { newPylonRecord } from "../tick.ts";
import { processStream } from "../process-stream.ts";
import type { ConversationId } from "../harness/host.ts";
import type { LiveHash, NodeName, ProbeClient, PylonId, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";
import type { ImageId } from "../images.ts";

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
  const registry = openRegistry(path);
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  if (registry.project("acme" as ProjectId) === undefined) {
    registry.createProject({
      id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
      resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
    });
  }
  return registry;
}

function addThread(registry: Registry, options: { startedBy?: string; conversationId?: string | null; phase?: "running" | "paused" } = {}): Thread {
  const id = `th-${randomUUID().slice(0, 8)}` as ThreadId;
  const pylonId = `pylon-${id}` as PylonId;
  const thread: Thread = {
    seenAt: null, lastReplyAt: null, id, title: "t", project: "acme" as ProjectId, pylonId, status: "active", conversationId: options.conversationId ?? null,
    startedBy: options.startedBy ?? "nLAPTOP", createdAt: Date.now(), agentTurnRunning: false, working: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now(),
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
  registry.createThread(thread, pylon, "hello");
  observe(registry, pylonId, options.phase ?? "running");
  return registry.thread(id)!;
}

function observe(registry: Registry, pylonId: PylonId, phase: "running" | "paused") {
  const pylons = [...(registry.node(node)?.observation?.pylons ?? []).filter((p) => p.pylonId !== pylonId), ...phase === "paused" ? [] : [{
    pylonId, phase, liveHash: "hash-1" as LiveHash, bootedAt: new Date().toISOString(), bootedFrom: { image, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }]];
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.ingested(
    { node, observedAt: new Date().toISOString(), probeBootId: "boot-1", capacity, artifacts: [image], jobs: [], pylons, grants: { secrets: [], gitSsh: false }, previewRoutes: [] },
    [{ record: "node", node, state: "online", capacity }],
  );
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
function localProbe() {
  const probe = { reads: 0, stream: async (_pylon: PylonId, argv: readonly string[]) => { probe.reads++; return processStream(argv[0]!, argv.slice(1), () => undefined); } };
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
  assert.equal(roleOf("something-else"), "other");
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
