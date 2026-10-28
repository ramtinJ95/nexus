import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { agentInbox, type Inbox } from "./inbox.ts";
import { fakeHarness } from "./fake-harness.ts";
import { builderNudger, nudgePrefix } from "./nudge.ts";
import { reviewerCaller } from "./review.ts";
import { checkCaller } from "./gate.ts";
import { turnGate } from "./drain.ts";
import { transcriptStart, type ClaudeEntry } from "../claude-transcript.ts";
import type { CommandResult, LiveHash, NodeName, PylonCommand, PylonId, PylonObservation, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";

const node = "node" as NodeName;
const session = "c0ffee00-0000-4000-8000-000000000000";
const repo = "acme/repo";
const graceMs = 60_000;

const assistant = (text: string) => ({
  role: "assistant", content: [{ type: "text", text }], stopReason: "stop", api: "x", provider: "x", model: "gpt-test", timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}) as AssistantMessage;

/** Builders in an auto-review project behind the real inbox: harness threads on the fake harness, Claude workers on a fake probe. */
function fixture(t: import("node:test").TestContext) {
  const registry = openRegistry(":memory:");
  t.after(() => registry.close());
  const resources = { cpus: 2, memoryGiB: 4, diskGiB: 10 };
  const project = (id: string, autoReview: { land: boolean; enabledBy: string } | null) =>
    ({ id: id as ProjectId, repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node, resources, allowedHosts: [], secrets: [], logins: [], preSetup: null, autoReview });
  registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
  registry.createProject(project("reviewed", { land: false, enabledBy: "nLAPTOP" }));
  registry.createProject(project("plain", null));
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const fake = fakeHarness();
  const typed: Extract<PylonCommand, { kind: "send-claude" }>[] = [];
  let outcome: "sent" | "blocked" = "sent";
  const probe = { async command(_: PylonId, command: PylonCommand): Promise<CommandResult> { typed.push(command as Extract<PylonCommand, { kind: "send-claude" }>); return { kind: "send-claude", outcome, herdrPane: "w1:p1", resumed: false }; } };
  const inbox: Inbox = agentInbox({ registry, harness: fake.harness, probes: new Map([[node, probe]]), wake() {} });
  const prs = new Map<string, number[]>();
  const finds: string[] = [];
  let findFails = false;
  let searching = () => {};
  const logs: string[] = [];
  let now = 1_000_000;
  const nudger = builderNudger({
    registry, inbox, harness: fake.harness, now: () => now, log: (message) => logs.push(message),
    github: { async find(r, branch, state) { finds.push(`${r} ${branch} ${state}`); searching(); if (findFails) throw new Error("401 Authorization: Bearer secret"); return prs.get(branch) ?? []; } },
  });
  const claudes = new Set<ThreadId>();
  const claudeSeq = new Map<ThreadId, number>();
  const running: PylonObservation[] = [];

  async function add(id: string, options: { claude?: boolean; startedBy?: string; project?: string } = {}): Promise<ThreadId> {
    const thread: Thread = { id: id as ThreadId, title: id, project: (options.project ?? "reviewed") as ProjectId, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: options.claude ? null : "1", startedBy: options.startedBy ?? "nLAPTOP", createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false, working: false };
    const { desired: _, ...pylon } = newPylonRecord({ thread: thread.id, pylonId: thread.pylonId, node, desired: "running", boot: { pylonId: thread.pylonId, image: "img-000000000000", resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: `https://github.com/${repo}.git`, checkout: { branch: "main", commit: "main" } }, dotfiles: { repo: `https://github.com/${repo}.git`, ref: "main" } }, firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash" as LiveHash });
    if (options.claude) {
      registry.createThread(thread, pylon, "build the cache", "claude-opus-5-5");
      registry.setClaudeWorker(thread.id, "build the cache", "started", undefined, session);
      claudes.add(thread.id);
      claudeSeq.set(thread.id, 0);
      transcript(thread.id, [{ kind: "prompt", at: 1, text: "build the cache", from: "person" }]);
      running.push({ pylonId: thread.pylonId, phase: "running" as const, liveHash: "hash" as LiveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000" as const, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0 });
      registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons: running, grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
    } else {
      registry.createThread(thread, pylon);
      await fake.harness.startThread({ threadId: thread.id, pylonId: thread.pylonId });
      await fake.harness.send(thread.id, "build the cache", `brief:${id}`, "followUp");
    }
    return thread.id;
  }
  /** A read of the worker's transcript. `reset` replaces every entry kept so far, as a read of a new session does. */
  function transcript(id: ThreadId, entries: ClaudeEntry[], reset = false) {
    const from = claudeSeq.get(id)!;
    registry.appendClaudeRead(id, { session, from: { ...transcriptStart, offset: from }, entries, cursor: { ...transcriptStart, offset: from + 1 }, reset, readAt: now });
    claudeSeq.set(id, from + 1);
  }
  /** The agent answers and its turn ends now. */
  function turn(id: ThreadId, text = "Done for now.") {
    if (claudes.has(id)) transcript(id, [{ kind: "reply", at: now, text }]);
    else { fake.transcript(id).messages.push(assistant(text)); fake.commit(id); }
    registry.recordReply(id, now);
  }
  /** The person writes to the thread, which starts a turn. */
  async function personWrites(id: ThreadId, text: string) {
    if (claudes.has(id)) transcript(id, [{ kind: "prompt", at: now, text, from: "person" }]);
    else await fake.harness.send(id, text, `person:${now}`, "followUp");
    registry.recordActivity(id, { human: now, agentTurnRunning: true });
  }
  /** Every nudge either path delivered, in order: harness sends with their sender, and messages typed into a Claude worker. */
  const nudges = () => [
    ...fake.calls.filter((c) => c[0] === "send" && c[5] === "nudge").map((c) => ({ thread: c[1] as string, text: c[2] as string, requestId: c[3] as string, sender: c[5] as string })),
    ...typed.map((c) => ({ thread: "claude", text: c.text, requestId: c.requestId, sender: "typed" })),
  ];
  return {
    registry, fake, nudger, add, turn, personWrites, transcript, nudges, typed, prs, finds, logs,
    tick(ms: number) { now += ms; },
    get now() { return now; },
    set outcome(o: "sent" | "blocked") { outcome = o; },
    set findFails(v: boolean) { findFails = v; },
    set searching(v: () => void) { searching = v; },
    branch(id: ThreadId, ref: string) { registry.apply({ record: "output", pylonId: registry.thread(id)!.pylonId, kind: "branch", ref }); },
    link(id: ThreadId, number: number) {
      registry.savePrWatch(id, { links: [{ pr: { repo, number, title: "Add the cache", url: `https://github.com/${repo}/pull/${number}`, state: "open", checks: "none", review: "none", conflict: false }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
    },
  };
}

test("a builder whose turn ended without a pull request gets one nudge after the grace, under the turn's request ID", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.turn(id);
  const turnEnd = f.registry.thread(id)!.lastReplyAt!;
  f.tick(graceMs - 1);
  await f.nudger.poll();
  assert.deepEqual(f.nudges(), [], "nothing is sent while a pull request opened just before the turn ended may still be reaching GitHub");
  f.tick(1);
  await f.nudger.poll();
  const sent = f.nudges();
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.text.startsWith(`${nudgePrefix}\n`));
  assert.ok(!sent[0]!.text.includes("\t"), "the text is typeable");
  assert.equal(sent[0]!.sender, "nudge");
  assert.equal(sent[0]!.requestId, `nudge:${id}:${turnEnd}`);
  assert.deepEqual(f.registry.nudge(id), { state: "nudged", turn: turnEnd, count: 1 });
  f.tick(graceMs);
  await f.nudger.poll();
  assert.equal(f.nudges().length, 1, "a turn is nudged once");
  assert.notEqual(f.registry.attention(id), "decision");
});

test("a pull request opened just before the turn ended, which the PR watch has not linked yet, gets no nudge", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.branch(id, "origin/nexus/cache");
  f.branch(id, "nexus/local-only");
  f.prs.set("nexus/cache", [12]);
  f.turn(id);
  for (let i = 0; i < 3; i++) {
    f.tick(graceMs);
    await f.nudger.poll();
  }
  assert.deepEqual(f.nudges(), []);
  assert.deepEqual(f.registry.nudge(id), { state: "opened", turn: f.registry.thread(id)!.lastReplyAt });
  assert.deepEqual(f.finds, [`${repo} nexus/cache all`], "only the branch pushed to origin is searched, in every state, once per turn");
});

test("a GitHub search that fails sends nothing and logs no error text", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.branch(id, "origin/nexus/cache");
  f.findFails = true;
  f.turn(id);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.deepEqual(f.nudges(), []);
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(f.logs[0]!, /secret|Authorization/);
  f.findFails = false;
  await f.nudger.poll();
  assert.equal(f.nudges().length, 1, "the next pass searches again");
});

test("after two nudges a third stalled turn goes to the person, until the PR watch links a pull request", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  for (let i = 0; i < 2; i++) {
    f.turn(id);
    f.tick(graceMs);
    await f.nudger.poll();
  }
  assert.equal(f.nudges().length, 2);
  assert.notEqual(f.registry.attention(id), "decision");
  f.turn(id, "I could not finish.");
  f.tick(graceMs);
  await f.nudger.poll();
  assert.equal(f.nudges().length, 2, "no third nudge");
  assert.equal(f.registry.attention(id), "decision");
  assert.equal(f.registry.nudge(id)?.state, "person");
  f.tick(graceMs);
  await f.nudger.poll();
  assert.equal(f.registry.attention(id), "decision", "the hold stays");
  f.link(id, 12);
  await f.nudger.poll();
  assert.equal(f.registry.nudge(id), null);
  assert.notEqual(f.registry.attention(id), "decision");
});

test("a reviewer, a check thread, a builder in a project without auto-review, and a running turn are never nudged", async (t) => {
  const f = fixture(t);
  const ids = [
    await f.add("th-reviewer", { startedBy: reviewerCaller }),
    await f.add("th-check", { startedBy: checkCaller }),
    await f.add("th-plain", { project: "plain" }),
    await f.add("th-working"),
  ];
  for (const id of ids) f.turn(id);
  f.registry.recordActivity("th-working" as ThreadId, { agentTurnRunning: true });
  f.tick(graceMs);
  await f.nudger.poll();
  assert.deepEqual(f.nudges(), []);
  for (const id of ids) assert.equal(f.registry.nudge(id), null);
});

test("the person writing after the first reply leaves a builder alone, and takes back one held for them", async (t) => {
  const f = fixture(t);
  const theirs = await f.add("th-theirs");
  f.turn(theirs);
  await f.personWrites(theirs, "Hold off on the pull request, I want to look first.");
  f.tick(1_000);
  f.turn(theirs);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.deepEqual(f.nudges(), []);

  const held = await f.add("th-held");
  for (let i = 0; i < 3; i++) {
    f.turn(held);
    f.tick(graceMs);
    await f.nudger.poll();
  }
  assert.equal(f.registry.attention(held), "decision");
  await f.personWrites(held, "I'll take it from here.");
  await f.nudger.poll();
  assert.deepEqual(f.registry.nudge(held), { state: "left-alone" });
  assert.notEqual(f.registry.attention(held), "decision", "the person's message ends the hold while the turn it started runs");
  f.registry.recordActivity(held, { agentTurnRunning: false });
  f.turn(held);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.equal(f.nudges().filter((n) => n.thread === held).length, 2, "a thread the person wrote to is not nudged again");
});

test("a Claude worker builder is nudged by typing into its session, and a person's prompt after its first reply leaves it alone", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-claude", { claude: true });
  f.turn(id);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.typed[0]!.session, session);
  assert.ok(f.typed[0]!.text.startsWith(`${nudgePrefix}\n`));
  assert.equal(f.typed[0]!.requestId, `nudge:${id}:${f.registry.thread(id)!.lastReplyAt}`);
  // The nudge shows in the transcript as a prompt, which is not the person's.
  f.transcript(id, [{ kind: "prompt", at: f.now, text: f.typed[0]!.text, from: "person" }]);
  f.turn(id);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.equal(f.typed.length, 2, "a nudge is not the person writing");

  const theirs = await f.add("th-claude-theirs", { claude: true });
  f.turn(theirs);
  await f.personWrites(theirs, "Wait for me before opening it.");
  f.registry.recordActivity(theirs, { agentTurnRunning: false });
  f.tick(1_000);
  f.turn(theirs);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.equal(f.typed.length, 2);
  assert.deepEqual(f.registry.nudge(theirs), { state: "left-alone" });
  f.transcript(theirs, [{ kind: "prompt", at: f.now, text: "build the cache", from: "person" }], true);
  assert.ok(!f.registry.claudeEntries(theirs).some((e) => e.kind === "prompt" && e.text.startsWith("Wait for me")));
  f.tick(1_000);
  f.turn(theirs);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.equal(f.typed.length, 2, "it stays the person's after the transcript that showed their message is gone");
});

test("a person's message seen while the turn it started runs keeps the thread theirs after the transcript drops it", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-claude", { claude: true });
  f.turn(id);
  f.tick(1_000);
  await f.personWrites(id, "Wait for me before you push.");
  await f.nudger.poll();
  assert.deepEqual(f.registry.nudge(id), { state: "left-alone" });
  f.transcript(id, [{ kind: "prompt", at: f.now, text: "build the cache", from: "person" }], true);
  f.registry.recordActivity(id, { agentTurnRunning: false });
  f.tick(1_000);
  f.turn(id);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.deepEqual(f.typed, []);
});

test("a thread the person took over is never searched on GitHub again", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.branch(id, "origin/nexus/cache");
  f.turn(id);
  await f.personWrites(id, "Let me look at it first.");
  f.registry.recordActivity(id, { agentTurnRunning: false });
  f.tick(1_000);
  f.turn(id);
  for (let i = 0; i < 3; i++) {
    f.tick(graceMs);
    await f.nudger.poll();
  }
  assert.deepEqual(f.finds, []);
  assert.deepEqual(f.nudges(), []);
});

test("a pull request the PR watch links while GitHub is searched gets no nudge", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.branch(id, "origin/nexus/cache");
  f.searching = () => f.link(id, 12);
  f.turn(id);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.deepEqual(f.nudges(), []);
});

test("a Claude worker stopped on its usage limit is not nudged", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-claude", { claude: true });
  f.transcript(id, [{ kind: "notice", at: f.now, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt: null } }]);
  f.registry.recordReply(id, f.now);
  assert.notEqual(f.registry.thread(id)!.usageLimit, undefined);
  f.tick(graceMs);
  await f.nudger.poll();
  assert.deepEqual(f.typed, []);
  assert.equal(f.registry.attention(id), "limited");
});

test("a nudge the session could not take yet saves nothing and is sent again under the same request ID", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-claude", { claude: true });
  f.turn(id);
  f.tick(graceMs);
  f.outcome = "blocked";
  await f.nudger.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.registry.nudge(id), null);
  f.outcome = "sent";
  await f.nudger.poll();
  assert.equal(f.typed.length, 2);
  assert.equal(f.typed[1]!.requestId, f.typed[0]!.requestId);
  assert.equal(f.registry.nudge(id)?.state, "nudged");
  await f.nudger.poll();
  assert.equal(f.typed.length, 2);
});

test("archiving a thread held for the person clears the hold", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  for (let i = 0; i < 3; i++) {
    f.turn(id);
    f.tick(graceMs);
    await f.nudger.poll();
  }
  assert.equal(f.registry.nudge(id)?.state, "person");
  f.registry.setThreadStatus(id, "archived");
  await f.nudger.poll();
  assert.equal(f.registry.nudge(id), null);
  assert.notEqual(f.registry.attention(id), "decision");
});

test("a harness builder's nudge refused by a deploy's drain saves nothing and goes out once the drain ends", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  let draining = true;
  const gate = turnGate(() => draining);
  const gated = builderNudger({
    registry: f.registry, harness: f.fake.harness, now: () => f.now, log: () => {}, github: { async find() { return []; } },
    inbox: agentInbox({ registry: f.registry, harness: { send: (...args) => gate.run(() => f.fake.harness.send(...args)) }, probes: new Map(), wake() {} }),
  });
  f.turn(id);
  f.tick(graceMs);
  await gated.poll();
  assert.deepEqual(f.nudges(), []);
  assert.equal(f.registry.nudge(id), null);
  draining = false;
  await gated.poll();
  assert.equal(f.nudges().length, 1);
  assert.equal(f.registry.nudge(id)?.state, "nudged");
});
