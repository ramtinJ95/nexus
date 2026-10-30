import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryObjects } from "node:v8";
import { claudeConversations } from "./claude-conversation.ts";
import { openRegistry, type Registry, type Thread } from "./registry.ts";
import { addThread, seedRegistry } from "./test-kit.ts";
import { claudeProjects, maxEntries, type ClaudeEntry } from "../claude-transcript.ts";
import { processStream } from "../process-stream.ts";
import { claudeHook } from "../../images/pylon/nexus-contract.ts";
import type { LiveHash, NodeName } from "../ids.ts";
import type { ByteStream } from "../protocol/streams.ts";
import type { ProbeClient } from "../protocol/client.ts";
import type { ImageId } from "../images.ts";
import { until } from "../test-kit.ts";

const node = "rj-firebat" as NodeName;
const image: ImageId = "img-000000000000";
const session = "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30";

const dir = await mkdtemp(join(tmpdir(), "nexus-claude-conversation-"));
after(() => rm(dir, { recursive: true }));

/** A registry whose node is online and runs the pylon of each Claude thread `claudeThread` adds. */
function openOnline(): Registry {
  return seedRegistry(openRegistry(join(dir, `${randomUUID()}.db`)), { nodes: [node] });
}

function claudeThread(registry: Registry): Thread {
  const { id, pylonId } = addThread(registry, { node, boot: { image }, claudePrompt: "hello" });
  registry.setClaudeWorker(id, "hello", "started", undefined, session);
  const pylons = [...registry.node(node)?.observation?.pylons ?? [], {
    pylonId, phase: "running" as const, liveHash: "hash-1" as LiveHash, bootedAt: new Date().toISOString(), bootedFrom: { image, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }];
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.ingested(
    { node, observedAt: new Date().toISOString(), probeBootId: "boot-1", events: [], capacity, artifacts: [image], jobs: [], pylons, grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] },
    [{ record: "node", node, state: "online", capacity }],
  );
  return registry.thread(id)!;
}

/** A probe whose transcript reads wait until the test fails them, as a pipe lost to the pylon does. */
function heldProbe() {
  const held: ((err: Error) => void)[] = [];
  let reads = 0;
  const probe: Pick<ProbeClient, "stream"> = {
    stream: () => new Promise<ByteStream>((_, reject) => { reads++; held.push(reject); }),
  };
  return { probe, held, reads: () => reads, lose: () => { for (const reject of held.splice(0)) reject(new Error("the pipe was lost")); } };
}

/** How many threads the service keeps a reader for, besides the active one whose ID marks its readers Map. */
function readersBesides(active: Thread): number {
  const maps = (queryObjects(Map, { format: "summary" }) as string[]).filter((m) => m.includes(`'${active.id}'`));
  assert.equal(maps.length, 1, "one Map holds the active thread's reader");
  return Number(/^Map\((\d+)\)/.exec(maps[0]!)![1]) - 1;
}

test("a transcript read that ends after the service and its registry closed settles without touching the registry", async () => {
  const registry = openOnline();
  const t = claudeThread(registry);
  const { probe, held, lose } = heldProbe();
  const conversations = claudeConversations({ registry, probes: new Map([[node, probe]]), followMs: 3_600_000 });
  const read = conversations.refresh(t);
  await until("the read reaches the pylon", () => held.length === 1);
  registry.setThreadStatus(t.id, "deleted");
  conversations.close();
  registry.close();
  lose();
  await assert.doesNotReject(read);
});

test("a deleted thread's reader stays while a read runs, so a refresh meanwhile waits for it rather than reading at once", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = claudeThread(registry);
  const { probe, held, reads, lose } = heldProbe();
  const conversations = claudeConversations({ registry, probes: new Map([[node, probe]]), followMs: 3_600_000 });
  t.after(() => conversations.close());
  const first = conversations.refresh(thread);
  await until("the read reaches the pylon", () => held.length === 1);
  registry.setThreadStatus(thread.id, "deleted");
  const second = conversations.refresh(thread);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reads(), 1, "the refresh waits for the read that runs");
  lose();
  await Promise.all([first, second]);
  assert.equal(reads(), 1, "the refresh after it read nothing, as the thread was deleted by then");
});

test("a watch of a deleted thread keeps its reader, so closing the service still ends the watch", async () => {
  const registry = openOnline();
  const thread = claudeThread(registry);
  const conversations = claudeConversations({ registry, probes: new Map(), followMs: 3_600_000 });
  const watch = await conversations.watch(thread);
  watch.start(() => undefined);
  registry.setThreadStatus(thread.id, "deleted");
  await conversations.refresh(thread);
  conversations.close();
  await watch.closed;
  registry.close();
});

test("a deleted thread's reader goes once its last read and its last watch end, and an active thread's stays", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const active = claudeThread(registry);
  const watched = claudeThread(registry);
  const read = claudeThread(registry);
  const { probe, held, lose } = heldProbe();
  const conversations = claudeConversations({ registry, probes: new Map([[node, probe]]), followMs: 3_600_000 });
  t.after(() => conversations.close());
  await Promise.all([conversations.refresh(active), until("the active read reaches the pylon", () => held.length === 1).then(lose)]);

  const watch = await conversations.watch(watched);
  const reading = conversations.refresh(read);
  await until("the read reaches the pylon", () => held.length === 1);
  registry.setThreadStatus(watched.id, "deleted");
  registry.setThreadStatus(read.id, "deleted");
  await conversations.refresh(watched);
  assert.equal(readersBesides(active), 2, "the watched and the reading thread keep their readers");

  lose();
  await reading;
  assert.equal(readersBesides(active), 1, "the read ended, so its thread's reader went");
  await watch.stop();
  assert.equal(readersBesides(active), 0, "the watch ended, so its thread's reader went");
});

test("a watched thread's view, which reads on from the last one, holds what the registry stores as reads append, drop, replace or change session", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = claudeThread(registry);
  const projects = await mkdtemp(join(dir, "projects-"));
  await mkdir(join(projects, "-home-user-workspace-repo"));
  const file = (id: string) => join(projects, "-home-user-workspace-repo", `${id}.jsonl`);
  const probe: Pick<ProbeClient, "stream"> = {
    stream: async (_, argv) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {}),
  };
  const conversations = claudeConversations({ registry, probes: new Map([[node, probe]]), followMs: 3_600_000 });
  t.after(() => conversations.close());
  const reply = JSON.parse((await readFile(new URL("../fixtures/claude-transcript.jsonl", import.meta.url), "utf8")).split("\n")[40]!);
  const lines = (...texts: string[]) => texts.map((text, i) => `${JSON.stringify({ ...reply, uuid: `${text}-${i}`, message: { ...reply.message, id: `msg-${text}-${i}`, content: [{ type: "text", text }] } })}\n`).join("");
  const stored = () => ({ entries: registry.claudeEntries(thread.id), dropped: registry.claudeTranscript(thread.id)!.dropped });
  const shown = async () => {
    await conversations.refresh(thread);
    const { entries, dropped } = conversations.view(thread);
    return { entries, dropped };
  };
  const texts = (view: { entries: readonly ClaudeEntry[] }) => view.entries.map((e) => e.kind === "reply" ? e.text : e.kind);

  await writeFile(file(session), lines("A", "Z"));
  const watch = await conversations.watch(thread);
  watch.start(() => undefined);
  assert.deepEqual(texts(await shown()), ["A", "Z"]);
  await appendFile(file(session), lines("C", "D"));
  assert.deepEqual(await shown(), stored(), "the entries a read appended");
  assert.deepEqual(texts(stored()), ["A", "Z", "C", "D"]);
  assert.deepEqual(await shown(), stored(), "a view with nothing new to read");
  await writeFile(file(session), lines("B", "Z"));
  assert.deepEqual(texts(await shown()), ["B", "Z"], "a replaced transcript that ends as the old one did");
  await appendFile(file(session), lines(...Array.from({ length: maxEntries }, (_, i) => `R${i}`)));
  const many = await shown();
  assert.deepEqual(many, stored());
  assert.deepEqual([many.dropped, texts(many)[0]], [2, "R0"], "a read past the most kept drops the oldest");
  await writeFile(file("another-session"), lines("E"));
  registry.setClaudeWorker(thread.id, "hello", "started", undefined, "another-session");
  assert.deepEqual(texts(await shown()), ["E"], "another session's transcript");
  await watch.stop();
  await appendFile(file("another-session"), lines("F"));
  assert.deepEqual(await shown(), stored(), "an unwatched thread's view");
});

test("a read asks the pylon's hook which dialogs wait while a turn runs or waits or an ask is open, and its report opens the worker's question though the transcript holds no call yet", async (t) => {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = claudeThread(registry);
  const projects = await mkdtemp(join(dir, "projects-"));
  await mkdir(join(projects, "-home-user-workspace-repo"));
  const reply = (await readFile(new URL("../fixtures/claude-transcript.jsonl", import.meta.url), "utf8")).split("\n")[40]!;
  await writeFile(join(projects, "-home-user-workspace-repo", `${session}.jsonl`), `${reply}\n`);
  let report: unknown[] = [];
  let exit = 0;
  let pulls = 0;
  const probe: Pick<ProbeClient, "stream"> = {
    async stream(_, argv) {
      if (argv[0] !== claudeHook) return processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {});
      pulls++;
      return processStream("sh", ["-c", 'printf "%s\n" "$0"; exit "$1"', JSON.stringify(report), String(exit)], () => {});
    },
  };
  const conversations = claudeConversations({ registry, probes: new Map([[node, probe]]), followMs: 3_600_000 });
  t.after(() => conversations.close());
  let sequence = 0;
  const event = (kind: "session.turn-started" | "session.waiting" | "session.turn-ended") => registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session, at: Date.now() + sequence } });
  const asks = () => registry.questions(thread.id).map((q) => q.id);
  const drink = { question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "Hot" }, { label: "Coffee", description: "Strong" }] };

  await conversations.refresh(thread);
  assert.equal(pulls, 0, "no turn runs or waits and no ask is open");
  event("session.turn-started");
  event("session.waiting");
  report = [{ session, toolUseId: "toolu_1", at: 5, input: { questions: [drink] } }];
  await conversations.refresh(thread);
  assert.deepEqual(registry.claudeEntries(thread.id).map((e) => e.kind), ["reply"], "Claude has not written the call yet");
  assert.deepEqual(asks(), ["ask-toolu_1"]);
  assert.equal(registry.attention(thread.id), "decision");

  report = [];
  exit = 1;
  await conversations.refresh(thread);
  assert.deepEqual(asks(), ["ask-toolu_1"], "a pull that failed keeps the last report");
  exit = 0;
  event("session.turn-ended");
  await conversations.refresh(thread);
  assert.deepEqual(asks(), [], "the open ask makes the read after the turn's end ask, and the hook reports none");
  const before = pulls;
  await conversations.refresh(thread);
  assert.equal(pulls, before, "an idle thread with no open ask is not asked");
});

/**
 * A Claude thread whose transcript holds a reply, a probe that reads it and answers the hook's `asks` with `report`,
 * and a reporter of the thread's session events.
 */
async function askingThread(t: { after(fn: () => void): void }) {
  const registry = openOnline();
  t.after(() => registry.close());
  const thread = claudeThread(registry);
  const projects = await mkdtemp(join(dir, "projects-"));
  await mkdir(join(projects, "-home-user-workspace-repo"));
  const reply = (await readFile(new URL("../fixtures/claude-transcript.jsonl", import.meta.url), "utf8")).split("\n")[40]!;
  await writeFile(join(projects, "-home-user-workspace-repo", `${session}.jsonl`), `${reply}\n`);
  const state = { report: [] as unknown[], pulls: 0, reads: 0 };
  const probe: Pick<ProbeClient, "stream"> = {
    async stream(_, argv) {
      if (argv[0] !== claudeHook) {
        state.reads++;
        return processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {});
      }
      state.pulls++;
      return processStream("sh", ["-c", 'printf "%s\n" "$0"', JSON.stringify(state.report)], () => {});
    },
  };
  let sequence = 0;
  const event = (kind: "session.turn-started" | "session.heartbeat" | "session.waiting") => registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session, at: Date.now() + sequence } });
  return { registry, thread, probe, state, event };
}

const drink = { question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "Hot" }, { label: "Coffee", description: "Strong" }] };

test("a watched turn's reads ask the pylon's hook which dialogs wait once, and again only after a session event", async (t) => {
  const { registry, thread, probe, state, event } = await askingThread(t);
  event("session.turn-started");
  const conversations = claudeConversations({ registry, probes: new Map([[node, probe]]), workingReadMs: 10, followMs: 10 });
  t.after(() => conversations.close());
  const watch = await conversations.watch(thread);
  watch.start(() => undefined);
  await until("the turn is read several times", () => state.reads >= 5);
  assert.equal(state.pulls, 1, "the reader's first read asks, and the working reads after it do not");
  event("session.heartbeat");
  await until("the read after the event asks", () => state.pulls === 2);
  const reads = state.reads;
  await until("the turn is read several times more", () => state.reads >= reads + 5);
  assert.equal(state.pulls, 2);
  await watch.stop();
});

test("a report of no waiting asks after one of none is not stored again", async (t) => {
  const { registry, thread, probe, state, event } = await askingThread(t);
  let stores = 0;
  const counted: Registry = { ...registry, setWaitingAsks: (...args) => (stores++, registry.setWaitingAsks(...args)) };
  event("session.turn-started");
  const conversations = claudeConversations({ registry: counted, probes: new Map([[node, probe]]), followMs: 10 });
  t.after(() => conversations.close());
  await conversations.refresh(thread);
  event("session.heartbeat");
  await until("the read after the event asks", () => state.pulls === 2);
  await conversations.refresh(thread);
  assert.equal(stores, 1);
});

test("an ask withdrawn because no hook took its answer is asked again at the next read, with no session event, while the pylon still reports it", async (t) => {
  const { registry, thread, probe, state, event } = await askingThread(t);
  event("session.turn-started");
  event("session.waiting");
  state.report = [{ session, toolUseId: "toolu_1", at: 5, input: { questions: [drink] } }];
  const conversations = claudeConversations({ registry, probes: new Map([[node, probe]]), followMs: 3_600_000 });
  t.after(() => conversations.close());
  const asks = () => registry.questions(thread.id).map((q) => q.id);
  await conversations.refresh(thread);
  assert.deepEqual(asks(), ["ask-toolu_1"]);
  // As a delivery that gave up after 5 seconds does, while the hook may still wait, before the read it asked for.
  const read = conversations.refresh(thread);
  registry.withdrawAsk("ask-toolu_1");
  assert.deepEqual(asks(), []);
  await read;
  assert.deepEqual(asks(), ["ask-toolu_1"]);
  state.report = [];
  await conversations.refresh(thread);
  assert.deepEqual(asks(), [], "the hook no longer waits");
  const pulls = state.pulls;
  await conversations.refresh(thread);
  assert.equal(state.pulls, pulls, "a read after an empty report asks no more");
});

test("a reader whose session events were lost to an expired cursor asks the pylon's hook again at its next read", async (t) => {
  const { registry, thread, probe, state, event } = await askingThread(t);
  event("session.turn-started");
  const conversations = claudeConversations({ registry, probes: new Map([[node, probe]]), followMs: 10 });
  t.after(() => conversations.close());
  await conversations.refresh(thread);
  await conversations.refresh(thread);
  assert.equal(state.pulls, 1, "the reader's first read asks, and the next does not");
  const error = t.mock.method(console, "error", () => {});
  for (let i = 0; i < 10_002; i++) registry.appendEvent("release.changed", null, {});
  await until("the follower resets", () => error.mock.callCount() > 0);
  state.report = [{ session, toolUseId: "toolu_1", at: 5, input: { questions: [drink] } }];
  await conversations.refresh(thread);
  assert.deepEqual(registry.questions(thread.id).map((q) => q.id), ["ask-toolu_1"]);
});
