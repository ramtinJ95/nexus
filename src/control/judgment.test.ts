import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openHarnessHost, type ConversationId, type HarnessHost } from "../harness/host.ts";
import { scriptedModel, scriptedModels, type ScriptedRequest } from "../harness/test-fixture.ts";
import { desiredPhase } from "../reconcile.ts";
import { newPylonRecord } from "../tick.ts";
import type { LiveHash, NodeHealth, NodeName, PylonId, PylonObservation, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";
import { checkCaller, verifyCaller } from "./gate.ts";
import { briefOf, judgmentPass, type Judgment, type JudgmentPass } from "./judgment.ts";
import { openRegistry, type Registry, type Thread, type ThreadId } from "./registry.ts";
import { reviewerCaller } from "./review.ts";

const nodeA = "node-a" as NodeName;
const nodeB = "node-b" as NodeName;
const image = "img-000000000000" as const;
const resources = { cpus: 2, memoryGiB: 4, diskGiB: 10 };
const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
const laptop = "nLAPTOP" as TailnetNodeId;
const health = (node: NodeName): NodeHealth => ({
  node, readAt: "2027-01-01T00:00:00Z", cpus: 16, load: { one: 0.5, five: 0.4, fifteen: 0.3 }, memory: { totalGiB: 64, availableGiB: 40, swapTotalGiB: 8, swapFreeGiB: 8 },
  disk: { path: "/var/lib/nexus", totalGiB: 400, freeGiB: 300 }, temperatures: null, pylons: [],
});
/** The controller log a failure ends with, in which the scripted judgment finds its answer. */
const brokenWith = (judge: string) => `pylon is broken: the controller exited\nqemu: terminating on signal 15\njudge: ${judge}`;

function observe(registry: Registry, node: NodeName, pylons: PylonObservation[] = []) {
  const observation = { node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [image], jobs: [], pylons, grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] };
  registry.ingested(observation, [{ record: "node", node, state: "online", capacity }]);
}

function seed(registry: Registry) {
  for (const node of [nodeA, nodeB]) {
    registry.upsertNode({ name: node, tailnetHost: `${node}.ts.net`, tailnetNodeId: `n${node.replace("-", "")}` as TailnetNodeId });
    observe(registry, node);
  }
  const project = (id: string, pipeline: { autoStart: boolean } | null) => ({
    id: id as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: nodeA, resources, allowedHosts: [], secrets: [], logins: [],
    preSetup: "apt-get install -y jq", pipeline,
  });
  registry.createProject(project("nexus", { autoStart: true }));
  registry.createProject(project("plain", null));
}

interface World {
  registry: Registry;
  host: HarnessHost;
  judge: JudgmentPass;
  /** Every request the scripted model got. */
  seen: ScriptedRequest[];
  wakes: NodeName[];
  logs: string[];
  /** How many times anything looked for a pylon to run a tool in. */
  located(): number;
  /** Runs passes until `done` holds. */
  until(done: () => boolean): Promise<void>;
  close(): Promise<void>;
}

/** The control plane's registry and harness on files in `dir`, with the judgment pass over them, as main.ts wires them. */
async function open(t: TestContext, dir: string, options: { held?: () => Promise<void> | null; clock?: () => number } = {}): Promise<World> {
  const registry = openRegistry(join(dir, "registry.db"));
  if (registry.nodes().length === 0) seed(registry);
  const seen: ScriptedRequest[] = [];
  let located = 0;
  const host = await openHarnessHost({
    storagePath: join(dir, "harness.sqlite"), models: scriptedModels({ seen: (r) => seen.push(r), held: options.held ?? (() => null) }), model: scriptedModel,
    tailscaled: join(dir, "none.sock"), threads: [], deleted: [], onActivity: () => {}, log: () => {},
    locator: { awaitRunning: () => { located++; return Promise.reject(new Error("a judgment has no pylon")); } },
  });
  const wakes: NodeName[] = [];
  const logs: string[] = [];
  const probes = new Map([nodeA, nodeB].map((node) => [node, { health: async () => health(node) }]));
  const judge = judgmentPass({ registry, harness: host, probes, wake: (node) => wakes.push(node), log: (m) => logs.push(m), ...(options.clock ? { now: options.clock } : {}) });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await judge.close();
    await host.close();
    registry.close();
  };
  t.after(close);
  return {
    registry, host, judge, seen, wakes, logs, located: () => located, close,
    async until(done) {
      for (let i = 0; i < 300 && !done(); i++) {
        await judge.poll();
        if (!done()) await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(done(), "the passes got there");
    },
  };
}

async function world(t: TestContext, options: Parameters<typeof open>[2] = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-judgment-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, ...await open(t, dir, options) };
}

function builder(registry: Registry, id: string, options: { project?: string; startedBy?: string; firstBoot?: "template" } = {}): ThreadId {
  const thread: Thread = {
    id: id as ThreadId, title: `Build ${id}`, project: (options.project ?? "nexus") as ProjectId, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: "1",
    startedBy: options.startedBy ?? laptop, createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 0, lastAgentActivityAt: 0, agentTurnRunning: false, working: false,
    placement: { how: "default", node: nodeA }, setup: options.firstBoot === "template" ? { how: "template", template: "tpl-1" as never, builtAt: 1, commit: "c".repeat(40) } : { how: "fresh", reason: "no template yet" },
  };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: thread.id, pylonId: thread.pylonId, node: nodeA, desired: "running", liveHash: "hash" as LiveHash, live: { previews: [], overlay: [] },
    boot: { pylonId: thread.pylonId, image, resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: "https://github.com/acme/repo.git", checkout: { branch: "main", commit: "origin/main" } }, dotfiles: { repo: "https://github.com/acme/dotfiles.git", ref: "main" } },
    firstBoot: options.firstBoot === "template" ? { kind: "template", template: "tpl-1" as never } : { kind: "fresh", preSetup: null },
  });
  registry.createThread(thread, pylon);
  return thread.id;
}

/** The planner gives up on the thread's pylon, as the loop's tick saves it. */
function fail(registry: Registry, id: ThreadId, reason: string, pauses = 0) {
  const pylon = registry.pylon(`pylon-${id}` as PylonId)!;
  registry.savePylon({ ...pylon, pauses, failed: reason, attempts: { count: 5, last: { at: 1, code: "backend", message: "the controller exited" } } });
}

const only = (registry: Registry, id: ThreadId): Judgment => {
  const [j, ...rest] = registry.judgments(id);
  assert.equal(rest.length, 0, "one judgment of the failure");
  return j!;
};
const phaseOf = (w: World, id: ThreadId) => w.registry.judgments(id).at(-1)?.phase.kind;

test("a retry answer retries the pylon on its node, closes the judgment and counts what it used under the builder", async (t) => {
  const w = await world(t);
  const id = builder(w.registry, "th-retry");
  fail(w.registry, id, brokenWith("retry"));
  await w.until(() => phaseOf(w, id) === "done");

  const j = only(w.registry, id);
  assert.deepEqual(j.phase, { kind: "done", verdict: { answer: "retry", why: "scripted judgment: the brief says judge: retry", by: "judgment" }, outcome: { kind: "retried", node: nodeA, on: "verdict" } });
  const pylon = w.registry.pylon(`pylon-${id}` as PylonId)!;
  assert.deepEqual([pylon.failed, pylon.attempts, pylon.retrying], [null, { count: 0, last: null }, true]);
  assert.equal(desiredPhase(w.registry.thread(id)!, Date.now()), "running", "the retry wants the pylon running");
  assert.ok(w.wakes.includes(nodeA));
  assert.deepEqual(await w.host.judgmentReplies(j.conversation as ConversationId), [j.reply], "its run is over");
  assert.equal(w.registry.usageReport({ since: null, thread: id }).total.calls, 1, "the judgment's model call counts under the builder");

  assert.equal(w.seen.length, 1);
  assert.deepEqual(w.seen[0]!.tools, [], "the judgment is offered no tools");
  assert.equal(w.seen[0]!.last, j.request!.brief, "it is asked the saved brief");
  assert.match(j.request!.brief, /You have no tools/);
  assert.match(j.request!.brief, /judge: retry/, "the brief quotes the failure with its log");
  assert.match(j.request!.brief, /Node node-a is online\. Its health, read as this judgment started: load 0\.5/);
  assert.match(j.request!.brief, /- node-b would have 60 GiB memory, 14 CPUs and 90 GiB disk left/);
  assert.match(j.request!.brief, /retry-elsewhere: it moves the pylon to node-b/);
  assert.equal(w.located(), 0, "nothing looked for a pylon");
  assert.equal(w.logs.filter((l) => l.includes("retried the pylon on node-a")).length, 1);
});

test("a retry-elsewhere answer moves a pylon its node holds nothing of to the other node, to boot fresh there", async (t) => {
  const w = await world(t);
  const id = builder(w.registry, "th-move", { firstBoot: "template" });
  fail(w.registry, id, brokenWith("retry-elsewhere"));
  await w.until(() => phaseOf(w, id) === "done");

  assert.deepEqual(only(w.registry, id).phase, {
    kind: "done", verdict: { answer: "retry-elsewhere", why: "scripted judgment: the brief says judge: retry-elsewhere", by: "judgment" }, outcome: { kind: "moved", from: nodeA, to: nodeB, on: "verdict" },
  });
  const pylon = w.registry.pylon(`pylon-${id}` as PylonId)!;
  assert.deepEqual([pylon.node, pylon.firstBoot, pylon.failed], [nodeB, { kind: "fresh", preSetup: "apt-get install -y jq" }, null]);
  const t2 = w.registry.thread(id)!;
  assert.equal(t2.placement?.node, nodeB);
  assert.equal(t2.setup?.how, "fresh");
  assert.ok(w.wakes.includes(nodeA) && w.wakes.includes(nodeB));
});

test("a move goes to the person when the failed node still lists the pylon or holds its disk", async (t) => {
  const w = await world(t);
  const listed = builder(w.registry, "th-listed");
  const paused = builder(w.registry, "th-paused");
  observe(w.registry, nodeA, [{ pylonId: `pylon-${listed}` as PylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" }]);
  fail(w.registry, listed, brokenWith("retry-elsewhere"));
  fail(w.registry, paused, brokenWith("retry-elsewhere"), 2);
  await w.until(() => phaseOf(w, listed) === "asked" && phaseOf(w, paused) === "asked");

  for (const [id, why] of [[listed, "node-a still lists it broken, and Nexus has no move job"], [paused, "its disk is on node-a, and Nexus has no move job"]] as const) {
    const j = only(w.registry, id);
    assert.deepEqual(j.phase, { kind: "asked", verdict: { answer: "person", why: `the judgment answered retry-elsewhere, which cannot run: ${why}`, by: "control plane" } });
    const question = w.registry.question(`judgment:${j.failure}`)!;
    assert.deepEqual([question.thread, question.answerer, question.answer, question.options], [id, "person", null, ["Retry", "Leave it failed"]]);
    assert.equal(w.registry.pylon(`pylon-${id}` as PylonId)!.node, nodeA);
    assert.equal(w.registry.attention(id), "failed");
  }
});

test("a person answer asks with the actions that can run, and each answer does what it says", async (t) => {
  const w = await world(t);
  const ids = ["th-p1", "th-p2", "th-p3"].map((id) => builder(w.registry, id));
  for (const id of ids) fail(w.registry, id, brokenWith("person"));
  await w.until(() => ids.every((id) => phaseOf(w, id) === "asked"));
  const questions = ids.map((id) => w.registry.question(`judgment:${only(w.registry, id).failure}`)!);
  for (const q of questions) {
    assert.deepEqual(q.options, ["Retry", "Retry on another node", "Leave it failed"]);
    assert.match(q.text, /^The pylon failed on node-a: pylon is broken: the controller exited\n\nIts judgment leaves it to you: scripted judgment: the brief says judge: person\n/);
  }

  const answered = Date.now();
  for (const [q, option] of questions.map((q, i) => [q, q.options[i]!] as const)) w.registry.answerQuestion(q.id, { option, by: laptop, at: answered });
  await w.until(() => ids.every((id) => phaseOf(w, id) === "done"));

  const outcomes = ids.map((id) => { const p = only(w.registry, id).phase; return p.kind === "done" ? p.outcome : null; });
  assert.deepEqual(outcomes, [{ kind: "retried", node: nodeA, on: "answer" }, { kind: "moved", from: nodeA, to: nodeB, on: "answer" }, { kind: "left", why: "the person left it failed" }]);
  assert.deepEqual(ids.map((id) => w.registry.pylon(`pylon-${id}` as PylonId)!.failed === null), [true, true, false]);
  assert.ok(w.registry.thread(ids[0]!)!.lastHumanActivityAt >= answered, "the person's retry is their activity");
});

test("a reply with a malformed block or none goes to the person, by the control plane's rule", async (t) => {
  const w = await world(t);
  const malformed = builder(w.registry, "th-malformed");
  const silent = builder(w.registry, "th-silent");
  fail(w.registry, malformed, brokenWith("malformed"));
  fail(w.registry, silent, brokenWith("silent"));
  await w.until(() => phaseOf(w, malformed) === "asked" && phaseOf(w, silent) === "asked");
  for (const id of [malformed, silent]) {
    const j = only(w.registry, id);
    assert.deepEqual(j.phase, { kind: "asked", verdict: { answer: "person", why: "the judgment's reply had no valid nexus-judgment block with its token", by: "control plane" } });
    assert.ok(j.reply!.startsWith("scripted judgment"));
    assert.equal(w.registry.question(`judgment:${j.failure}`)!.answer, null);
    assert.equal(w.registry.attention(id), "failed");
  }
});

test("a judgment that does not answer in time is closed and goes to the person, and one whose thread is deleted ends", async (t) => {
  let late = 0;
  const w = await world(t, { held: () => new Promise(() => {}), clock: () => Date.now() + late });
  const slow = builder(w.registry, "th-slow");
  const deleted = builder(w.registry, "th-deleted");
  fail(w.registry, slow, brokenWith("retry"));
  fail(w.registry, deleted, brokenWith("retry"));
  await w.until(() => w.seen.length === 2);
  await w.judge.poll();
  assert.deepEqual([phaseOf(w, slow), phaseOf(w, deleted)], ["judging", "judging"], "a judgment waits for its answer");

  w.registry.setThreadStatus(deleted, "deleted");
  await w.until(() => phaseOf(w, deleted) === "done");
  const ended = only(w.registry, deleted);
  assert.deepEqual(ended.phase, { kind: "done", verdict: { answer: "person", why: "the thread was deleted before the judgment answered", by: "control plane" }, outcome: { kind: "left", why: "the thread is deleted" } });
  assert.notEqual(await w.host.judgmentReplies(ended.conversation as ConversationId), null, "its conversation is closed");

  late = 15 * 60_000;
  await w.until(() => phaseOf(w, slow) === "asked");
  const j = only(w.registry, slow);
  assert.deepEqual(j.phase, { kind: "asked", verdict: { answer: "person", why: "the judgment did not answer within 15 minutes", by: "control plane" } });
  assert.notEqual(await w.host.judgmentReplies(j.conversation as ConversationId), null, "its conversation is closed");
  assert.notEqual(w.registry.pylon(`pylon-${slow}` as PylonId)!.failed, null);
});

test("a judgment the control plane stopped before its answer goes on after a restart, briefed once and acted on once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-judgment-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await open(t, dir, { held: () => new Promise(() => {}) });
  const id = builder(first.registry, "th-crash");
  fail(first.registry, id, brokenWith("retry"));
  await first.until(() => first.seen.length === 1);
  const before = only(first.registry, id);
  assert.ok(before.phase.kind === "judging" && before.phase.deadline !== null && before.conversation !== null);
  await first.close();

  const second = await open(t, dir);
  await second.until(() => phaseOf(second, id) === "done");
  const after = only(second.registry, id);
  assert.equal(after.conversation, before.conversation, "the same conversation");
  assert.deepEqual(second.seen, [{ tools: [], last: before.request!.brief }], "the restart asked the model once more, for the one brief");
  assert.equal(after.phase.kind === "done" && after.phase.outcome.kind, "retried");
  assert.equal(second.logs.filter((l) => l.includes("retried the pylon")).length, 1, "and Nexus acted once");
});

test("concurrent passes and a restart judge a failure once, a later failure gets its own judgment, and a third retry is the person's", async (t) => {
  const w = await world(t);
  const other = judgmentPass({ registry: w.registry, harness: w.host, probes: new Map([nodeA, nodeB].map((node) => [node, { health: async () => health(node) }])), wake: () => {}, log: () => {} });
  t.after(() => other.close());
  const id = builder(w.registry, "th-twice");
  const both = async (done: () => boolean) => {
    for (let i = 0; i < 300 && !done(); i++) {
      await Promise.all([w.judge.poll(), other.poll(), other.poll()]);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(done());
  };
  fail(w.registry, id, brokenWith("retry"));
  await both(() => phaseOf(w, id) === "done");
  assert.equal(w.registry.judgments(id).length, 1);
  assert.equal(w.seen.length, 1, "one brief reached a model");

  fail(w.registry, id, brokenWith("retry"));
  await both(() => w.registry.judgments(id).length === 2 && phaseOf(w, id) === "done");
  assert.equal(w.seen.length, 2);
  assert.notEqual(w.registry.judgments(id)[1]!.failure, w.registry.judgments(id)[0]!.failure);

  fail(w.registry, id, brokenWith("retry"));
  await both(() => w.registry.judgments(id).length === 3 && phaseOf(w, id) === "asked");
  const third = w.registry.judgments(id)[2]!;
  assert.deepEqual([third.request, third.conversation], [null, null], "no judgment ran");
  assert.deepEqual(third.phase, { kind: "asked", verdict: { answer: "person", why: "Nexus already retried this thread's pylon 2 times on its own, so this failure is the person's", by: "control plane" } });
  assert.equal(w.seen.length, 2, "no model was asked");

  await other.close();
  await w.close();
  const reopened = await open(t, w.dir);
  for (let i = 0; i < 3; i++) await reopened.judge.poll();
  assert.equal(reopened.registry.judgments(id).length, 3);
  assert.equal(reopened.seen.length, 0);
});

test("failures from before judgments, projects without the pipeline and threads no person started as builders are never judged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-judgment-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await open(t, dir);
  const old = builder(first.registry, "th-old");
  fail(first.registry, old, brokenWith("retry"));
  await first.close();
  const db = new DatabaseSync(join(dir, "registry.db"));
  const version = db.prepare("PRAGMA user_version").get()!.user_version as number;
  db.exec(`DROP TABLE judgments; DROP TABLE judgment_since; PRAGMA user_version = ${version - 4}`);
  db.close();

  const w = await open(t, dir);
  const ids = [
    builder(w.registry, "th-plain", { project: "plain" }),
    builder(w.registry, "th-reviewer", { startedBy: reviewerCaller }),
    builder(w.registry, "th-check", { startedBy: checkCaller }),
    builder(w.registry, "th-verify", { startedBy: verifyCaller }),
  ];
  for (const id of ids) fail(w.registry, id, brokenWith("retry"));
  for (let i = 0; i < 3; i++) await w.judge.poll();
  for (const id of [old, ...ids]) assert.deepEqual(w.registry.judgments(id), [], id);
  assert.equal(w.seen.length, 0);
  assert.notEqual(w.registry.pylon(`pylon-${old}` as PylonId)!.failed, null, "the person's failed pylon stays failed");

  const now = builder(w.registry, "th-now");
  fail(w.registry, now, brokenWith("retry"));
  await w.until(() => phaseOf(w, now) === "done");
});

test("the brief states each fact it is given, and why one could not be read", () => {
  const pylonId = "pylon-th-1" as PylonId;
  const brief = briefOf({
    token: "judgment:9:ab", thread: { id: "th-1" as ThreadId, title: "Build it", project: "nexus" as ProjectId }, agent: "a Claude worker",
    pylon: { pylonId, node: nodeA, failed: "pylon is broken: setup failed\nnpm ERR! 404", pauses: 3, attempts: { count: 1, last: { at: Date.UTC(2026, 9, 28, 9), code: "backend", message: "setup exited 1" } } },
    listed: { pylonId, phase: "broken", detail: "setup failed", cause: "saved-setup", logTail: "" }, online: false, health: { unread: "its probe did not answer within 5 s" },
    others: [{ node: nodeB, refused: "is offline" }],
    earlier: [{ startedAt: Date.UTC(2026, 9, 27, 9), phase: { kind: "done", verdict: { answer: "retry", why: "A flaky boot.", by: "judgment" }, outcome: { kind: "retried", node: nodeA, on: "verdict" } } }],
    retriesLeft: 1, retry: "Its disk holds the failed setup", move: { refused: "its disk is on node-a, and Nexus has no move job" },
  });
  for (const fact of [
    "The thread: th-1, \"Build it\", in project nexus. Its agent: a Claude worker.",
    "<failure>\npylon is broken: setup failed\nnpm ERR! 404\n</failure>",
    "Failed jobs in a row: 1, the last at 2026-10-28T09:00:00.000Z with backend: setup exited 1.",
    "node-a's latest observation lists the pylon broken, cause saved-setup: setup failed",
    "Its disk holds the checkpoint of its pause 3, on node-a.",
    "Node node-a is offline. Its health could not be read: its probe did not answer within 5 s.",
    "- node-b cannot take it: it is offline",
    "- judged at 2026-10-27T09:00:00.000Z: retry, by the judgment: A flaky boot.; then Nexus retried the pylon on node-a",
    "at most 2 times, and can retry this one 1 more time.",
    "This cannot run now: Its disk holds the failed setup. Nexus would ask the person instead.",
    "retry-elsewhere: it would move the pylon to another node, but this cannot run now: its disk is on node-a, and Nexus has no move job.",
    "If a fact you need is missing, answer person and name the fact.",
  ]) assert.ok(brief.includes(fact), fact);
  assert.ok(brief.endsWith('```nexus-judgment\n{"token": "judgment:9:ab", "answer": "retry" or "retry-elsewhere" or "person", "why": "one or two sentences"}\n```'));
});

test("a judgment whose project turns its pipeline off before Nexus acts asks the person instead of retrying", async (t) => {
  let release = () => {};
  const answer = new Promise<void>((r) => { release = r; });
  const w = await world(t, { held: () => answer });
  const id = builder(w.registry, "th-off");
  fail(w.registry, id, brokenWith("retry"));
  await w.until(() => w.seen.length === 1);
  w.registry.editProject("nexus" as ProjectId, (p) => ({ ...p, pipeline: null }));
  release();
  await w.until(() => phaseOf(w, id) === "asked");

  const j = only(w.registry, id);
  assert.deepEqual(j.phase, { kind: "asked", verdict: { answer: "person", why: "the judgment answered retry, which cannot run: the project's pipeline was turned off", by: "control plane" } });
  assert.notEqual(w.registry.pylon(`pylon-${id}` as PylonId)!.failed, null, "nothing retried the pylon");
});

test("an answer to a judgment whose failure Nexus can no longer tell from a later one with the same reason does nothing", async (t) => {
  const w = await world(t);
  const id = builder(w.registry, "th-pruned");
  fail(w.registry, id, brokenWith("person"));
  await w.until(() => phaseOf(w, id) === "asked");
  const { failure } = only(w.registry, id);

  assert.equal(w.registry.retryPylon(`pylon-${id}` as PylonId), true);
  fail(w.registry, id, brokenWith("person"));
  for (let i = 0; i < 10_000; i++) w.registry.appendEvent("attention.changed", null, {});
  assert.equal(w.registry.failure(id), null, "both failures' events are pruned");
  w.registry.answerQuestion(`judgment:${failure}`, { option: "Retry", by: laptop, at: Date.now() });
  await w.until(() => phaseOf(w, id) === "done");

  const j = only(w.registry, id);
  assert.deepEqual(j.phase.kind === "done" && j.phase.outcome, { kind: "left", why: "the event of this failure is gone from the registry's event log, so Nexus cannot tell it from a later failure" });
  assert.notEqual(w.registry.pylon(`pylon-${id}` as PylonId)!.failed, null, "the later failure stays for the person");
});
