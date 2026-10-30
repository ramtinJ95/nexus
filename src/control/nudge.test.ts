import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { agentInbox, type Inbox } from "./inbox.ts";
import { fakeHarness } from "./fake-harness.ts";
import { builderNudger, nudgePrefix } from "./nudge.ts";
import { prWatcher } from "./pr-watch.ts";
import type { GitHub, PullRequest } from "./github.ts";
import { ingest } from "../reconcile.ts";
import { gitPollMs } from "../git-facts.ts";
import { reviewerCaller } from "./review.ts";
import { checkCaller } from "./gate.ts";
import { turnGate } from "./drain.ts";
import { transcriptStart, type ClaudeEntry } from "../claude-transcript.ts";
import type { CommandResult, LiveHash, NodeName, PylonCommand, PylonId, PylonObservation, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";

const node = "node" as NodeName;
const session = "c0ffee00-0000-4000-8000-000000000000";
const repo = "acme/repo";

const assistant = (text: string) => ({
  role: "assistant", content: [{ type: "text", text }], stopReason: "stop", api: "x", provider: "x", model: "gpt-test", timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}) as AssistantMessage;

/**
 * Builders in an auto-review project behind the real inbox and PR watch: harness threads on the fake harness, Claude
 * workers on a fake probe. Pushed branches reach the registry only through a snapshot, as the probe reports them.
 */
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
  const prs = new Map<string, { number: number; state: PullRequest["state"] }[]>();
  const finds: string[] = [];
  let findFails = false;
  let searching = () => {};
  const logs: string[] = [];
  let now = 1_000_000;
  // Only a search in every state is the nudge's. The PR watch searches open pull requests.
  const github: Pick<GitHub, "find" | "poll"> = {
    async find(r, branch, state = "open") {
      if (state === "all") {
        finds.push(`${r} ${branch} ${state}`);
        searching();
        if (findFails) throw new Error("401 Authorization: Bearer secret");
      }
      return (prs.get(branch) ?? []).filter((pr) => state === "all" || pr.state === "open").map((pr) => pr.number);
    },
    async poll(r, number) {
      const state = [...prs.values()].flat().find((pr) => pr.number === number)?.state ?? "open";
      return {
        pr: { repo: r, number, title: "Add the cache", url: `https://github.com/${r}/pull/${number}`, state, checks: "none", review: "none", conflict: false },
        detail: { head: "a".repeat(40), branch: "nexus/cache", base: "main", body: "", mergeCommit: null }, failures: [], comments: [],
      };
    },
  };
  const watch = prWatcher({ registry, github, inbox });
  const nudger = builderNudger({ registry, inbox, harness: fake.harness, watch, log: (message) => logs.push(message), github });
  const claudes = new Set<ThreadId>();
  const claudeSeq = new Map<ThreadId, number>();
  const pushes = new Map<PylonId, { at: number; ref: string }[]>();

  /**
   * A snapshot taken now, ingested as the control plane's loop ingests one. `readAt` is when the probe read the
   * checkouts' git, which it reuses for up to a minute, so the snapshot holds only the branches pushed by then.
   */
  function observe(readAt = now, phase: "running" | "unread" | "stopped" = "running") {
    const last = registry.node(node)!.observation;
    const pylons: PylonObservation[] = [...pushes].map(([pylonId, pushed]) => phase === "stopped" ? { pylonId, phase, checkpoint: null, sessions: [] } : ({
      pylonId, phase: "running" as const, liveHash: "hash" as LiveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000" as const, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], declaredOutputs: [], attachedClients: 0,
      git: phase === "unread" ? null : { head: "a".repeat(40), branch: "main", dirty: false, branches: pushed.filter((p) => p.at <= readAt).map((p) => ({ name: p.ref.slice(p.ref.indexOf("/") + 1), head: "a".repeat(40), pushedAs: p.ref })) },
    }));
    const observation = { node, observedAt: new Date(now).toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons, grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] };
    const known = new Map(registry.pylonIdsToTick(node, [...last?.pylons ?? [], ...pylons].map((p) => p.pylonId)).map((id) => [id, last?.pylons.find((o) => o.pylonId === id) ?? "absent" as const]));
    registry.ingested(observation, ingest({ type: "snapshot", observation }, node, known, now).filter((w) => w.record === "output"));
  }

  async function add(id: string, options: { claude?: boolean; startedBy?: string; project?: string } = {}): Promise<ThreadId> {
    const thread: Thread = { id: id as ThreadId, title: id, project: (options.project ?? "reviewed") as ProjectId, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: options.claude ? null : "1", startedBy: options.startedBy ?? "nLAPTOP", createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false, working: false };
    const { desired: _, ...pylon } = newPylonRecord({ thread: thread.id, pylonId: thread.pylonId, node, desired: "running", boot: { pylonId: thread.pylonId, image: "img-000000000000", resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: `https://github.com/${repo}.git`, checkout: { branch: "main", commit: "main" } }, dotfiles: { repo: `https://github.com/${repo}.git`, ref: "main" } }, firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash" as LiveHash });
    if (options.claude) {
      registry.createThread(thread, pylon, "build the cache", "claude-opus-5-5");
      registry.setClaudeWorker(thread.id, "build the cache", "started", undefined, session);
      claudes.add(thread.id);
      claudeSeq.set(thread.id, 0);
      transcript(thread.id, [{ kind: "prompt", at: 1, text: "build the cache", from: "person" }]);
    } else {
      registry.createThread(thread, pylon);
      await fake.harness.startThread({ threadId: thread.id, pylonId: thread.pylonId });
      await fake.harness.send(thread.id, "build the cache", `brief:${id}`, "followUp");
    }
    pushes.set(thread.pylonId, []);
    observe();
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
    registry, fake, nudger, watch, github, add, turn, personWrites, transcript, nudges, typed, prs, finds, logs, observe,
    tick(ms: number) { now += ms; },
    get now() { return now; },
    set outcome(o: "sent" | "blocked") { outcome = o; },
    set findFails(v: boolean) { findFails = v; },
    set searching(v: () => void) { searching = v; },
    /** Pushes the branch `ref` names now, which reaches the outputs with the next snapshot that reads git. */
    push(id: ThreadId, ref: string) { pushes.get(registry.thread(id)!.pylonId)!.push({ at: now, ref }); },
    /** A snapshot, then a nudge pass, a PR watch pass and another nudge pass, as their timers would run them. */
    async pass(nudges = nudger) {
      observe();
      await nudges.poll();
      await watch.poll();
      await nudges.poll();
    },
    link(id: ThreadId, number: number) {
      registry.savePrWatch(id, { links: [{ pr: { repo, number, title: "Add the cache", url: `https://github.com/${repo}/pull/${number}`, state: "open", checks: "none", review: "none", conflict: false }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
    },
  };
}

test("a builder whose turn ended without a pull request gets one nudge once its pushes are known and a PR watch pass found none, under the turn's request ID", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.turn(id);
  const turnEnd = f.registry.thread(id)!.lastReplyAt!;
  f.tick(gitPollMs - 1);
  await f.pass();
  assert.deepEqual(f.nudges(), [], "nothing is sent before a snapshot holds the branches pushed before the turn ended");
  f.tick(1);
  await f.pass();
  const sent = f.nudges();
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.text.startsWith(`${nudgePrefix}\n`));
  assert.ok(!sent[0]!.text.includes("\t"), "the text is typeable");
  assert.equal(sent[0]!.sender, "nudge");
  assert.equal(sent[0]!.requestId, `nudge:${id}:${turnEnd}`);
  assert.deepEqual(f.registry.nudge(id), { state: "nudged", turn: turnEnd, count: 1 });
  f.tick(gitPollMs);
  await f.pass();
  assert.equal(f.nudges().length, 1, "a turn is nudged once");
  assert.notEqual(f.registry.attention(id), "decision");
});

test("a pull request opened before the turn ended, whose branch the probe reports after a minute, gets no nudge", async (t) => {
  // Thread th-ee9a0b3c31e6 on 2026-10-28, in seconds after its push at 07:34:15: PR #174 opened at 27, the turn ended at
  // 57.4, and the PR watch linked #174 at 232.7. The probe read git half a second before the push and reused that
  // read in the next snapshot, so the branch reached the outputs only with the snapshot after that.
  const f = fixture(t);
  const id = await f.add("th-ee9a0b3c31e6", { claude: true });
  const pushed = f.now + 500;
  const steps: [number, () => unknown][] = [
    [0, () => f.push(id, "origin/feat/node-diagnostics")],
    [27_000, () => f.prs.set("feat/node-diagnostics", [{ number: 174, state: "open" }])],
    [57_400, () => f.turn(id)],
    [59_400, () => f.observe(pushed - 500)],
    [112_700, () => f.watch.poll()],
    [121_000, () => f.observe()],
    [181_000, () => f.observe()],
    [232_700, () => f.watch.poll()],
    [241_000, () => f.observe()],
  ];
  for (let at = 60_400; at < 300_000; at += 15_000) steps.push([at, () => f.nudger.poll()]);
  steps.sort(([a], [b]) => a - b);
  for (const [at, step] of steps) {
    f.tick(pushed + at - f.now);
    await step();
  }
  assert.deepEqual(f.typed, [], "no nudge goes to a builder whose pull request exists");
  assert.deepEqual(f.registry.prWatch(id)?.links.map((l) => l.pr.number), [174]);
  assert.equal(f.registry.nudge(id), null);
});

test("a PR watch pass already running once the turn's pushes are known does not count", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  const passes = { started: 1, finished: 0 };
  const nudger = builderNudger({ registry: f.registry, inbox: async () => "delivered", harness: f.fake.harness, watch: { passes: () => passes }, log: () => {}, github: f.github });
  f.turn(id);
  f.tick(gitPollMs);
  f.observe();
  await nudger.poll();
  passes.finished = 1;
  await nudger.poll();
  assert.equal(f.registry.nudge(id), null, "the pass that was running may have read the outputs before the snapshot");
  passes.started = 2;
  await nudger.poll();
  assert.equal(f.registry.nudge(id), null);
  passes.finished = 2;
  await nudger.poll();
  assert.equal(f.registry.nudge(id)?.state, "nudged");
});

test("a pylon that paused before a git read after the turn waits for a wake, and one paused after it is still nudged", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.push(id, "origin/nexus/cache");
  f.prs.set("nexus/cache", [{ number: 12, state: "open" }]);
  f.turn(id);
  f.tick(gitPollMs);
  f.observe(f.now, "unread");
  await f.nudger.poll();
  f.observe(f.now, "stopped");
  await f.nudger.poll();
  await f.watch.poll();
  await f.nudger.poll();
  assert.deepEqual(f.nudges(), [], "the paused pylon's outputs may lack the branch");
  assert.equal(f.registry.nudge(id), null);

  const paused = await f.add("th-paused");
  f.turn(paused);
  f.tick(gitPollMs);
  f.observe();
  await f.nudger.poll();
  f.observe(f.now, "stopped");
  await f.watch.poll();
  await f.nudger.poll();
  assert.deepEqual(f.nudges().map((n) => n.thread), [paused]);
});

test("a pull request that merged before the PR watch could link it gets no nudge", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.push(id, "origin/nexus/cache");
  f.push(id, "fork/nexus/local-only");
  f.prs.set("nexus/cache", [{ number: 12, state: "merged" }]);
  f.turn(id);
  for (let i = 0; i < 3; i++) {
    f.tick(gitPollMs);
    await f.pass();
  }
  assert.deepEqual(f.nudges(), []);
  assert.deepEqual(f.registry.nudge(id), { state: "opened", turn: f.registry.thread(id)!.lastReplyAt });
  assert.deepEqual(f.finds, [`${repo} nexus/cache all`], "only the branch pushed to origin is searched, in every state, once per turn");
});

test("a GitHub search that fails sends nothing and logs no error text", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.push(id, "origin/nexus/cache");
  f.findFails = true;
  f.turn(id);
  f.tick(gitPollMs);
  await f.pass();
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
    f.tick(gitPollMs);
    await f.pass();
  }
  assert.equal(f.nudges().length, 2);
  assert.notEqual(f.registry.attention(id), "decision");
  f.turn(id, "I could not finish.");
  f.tick(gitPollMs);
  await f.pass();
  assert.equal(f.nudges().length, 2, "no third nudge");
  assert.equal(f.registry.attention(id), "decision");
  assert.equal(f.registry.nudge(id)?.state, "person");
  f.tick(gitPollMs);
  await f.pass();
  assert.equal(f.registry.attention(id), "decision", "the hold stays");
  f.link(id, 12);
  await f.nudger.poll();
  assert.equal(f.registry.nudge(id), null);
  assert.notEqual(f.registry.attention(id), "decision");
});

test("a reviewer, a check thread, a planning thread, a builder in a project without auto-review, and a running turn are never nudged", async (t) => {
  const f = fixture(t);
  const ids = [
    await f.add("th-reviewer", { startedBy: reviewerCaller }),
    await f.add("th-check", { startedBy: checkCaller }),
    await f.add("th-planning"),
    await f.add("th-plain", { project: "plain" }),
    await f.add("th-working"),
  ];
  for (const id of ids) f.turn(id);
  f.registry.savePlanning({ thread: "th-planning" as ThreadId, token: "t", read: 0, sent: [] });
  f.registry.recordActivity("th-working" as ThreadId, { agentTurnRunning: true });
  f.tick(gitPollMs);
  await f.pass();
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
  f.tick(gitPollMs);
  await f.pass();
  assert.deepEqual(f.nudges(), []);

  const held = await f.add("th-held");
  for (let i = 0; i < 3; i++) {
    f.turn(held);
    f.tick(gitPollMs);
    await f.pass();
  }
  assert.equal(f.registry.attention(held), "decision");
  await f.personWrites(held, "I'll take it from here.");
  await f.nudger.poll();
  assert.deepEqual(f.registry.nudge(held), { state: "left-alone" });
  assert.notEqual(f.registry.attention(held), "decision", "the person's message ends the hold while the turn it started runs");
  f.registry.recordActivity(held, { agentTurnRunning: false });
  f.turn(held);
  f.tick(gitPollMs);
  await f.pass();
  assert.equal(f.nudges().filter((n) => n.thread === held).length, 2, "a thread the person wrote to is not nudged again");
});

test("a Claude worker builder is nudged by typing into its session, and a person's prompt after its first reply leaves it alone", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-claude", { claude: true });
  f.turn(id);
  f.tick(gitPollMs);
  await f.pass();
  assert.equal(f.typed.length, 1);
  assert.equal(f.typed[0]!.session, session);
  assert.ok(f.typed[0]!.text.startsWith(`${nudgePrefix}\n`));
  assert.equal(f.typed[0]!.requestId, `nudge:${id}:${f.registry.thread(id)!.lastReplyAt}`);
  // The nudge shows in the transcript as a prompt, which is not the person's.
  f.transcript(id, [{ kind: "prompt", at: f.now, text: f.typed[0]!.text, from: "person" }]);
  f.turn(id);
  f.tick(gitPollMs);
  await f.pass();
  assert.equal(f.typed.length, 2, "a nudge is not the person writing");

  const theirs = await f.add("th-claude-theirs", { claude: true });
  f.turn(theirs);
  await f.personWrites(theirs, "Wait for me before opening it.");
  f.registry.recordActivity(theirs, { agentTurnRunning: false });
  f.tick(1_000);
  f.turn(theirs);
  f.tick(gitPollMs);
  await f.pass();
  assert.equal(f.typed.length, 2);
  assert.deepEqual(f.registry.nudge(theirs), { state: "left-alone" });
  f.transcript(theirs, [{ kind: "prompt", at: f.now, text: "build the cache", from: "person" }], true);
  assert.ok(!f.registry.claudeEntries(theirs).some((e) => e.kind === "prompt" && e.text.startsWith("Wait for me")));
  f.tick(1_000);
  f.turn(theirs);
  f.tick(gitPollMs);
  await f.pass();
  assert.equal(f.typed.length, 2, "it stays the person's after the transcript that showed their message is gone");
});

test("a person's prompt that starts like a Nexus message, after a Claude worker's first reply, leaves it alone", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-claude", { claude: true });
  f.turn(id);
  await f.personWrites(id, "[Nexus review] says the cache is wrong. Wait for me before opening a pull request.");
  f.registry.recordActivity(id, { agentTurnRunning: false });
  f.tick(1_000);
  f.turn(id);
  f.tick(gitPollMs);
  await f.pass();
  assert.deepEqual(f.typed, []);
  assert.deepEqual(f.registry.nudge(id), { state: "left-alone" });
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
  f.tick(gitPollMs);
  await f.pass();
  assert.deepEqual(f.typed, []);
});

test("a thread the person took over is never searched on GitHub again", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.push(id, "origin/nexus/cache");
  f.turn(id);
  await f.personWrites(id, "Let me look at it first.");
  f.registry.recordActivity(id, { agentTurnRunning: false });
  f.tick(1_000);
  f.turn(id);
  for (let i = 0; i < 3; i++) {
    f.tick(gitPollMs);
    await f.pass();
  }
  assert.deepEqual(f.finds, []);
  assert.deepEqual(f.nudges(), []);
});

test("a pull request the PR watch links while GitHub is searched gets no nudge", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  f.push(id, "origin/nexus/cache");
  f.searching = () => f.link(id, 12);
  f.turn(id);
  f.tick(gitPollMs);
  await f.pass();
  assert.deepEqual(f.nudges(), []);
});

test("a Claude worker stopped on its usage limit is not nudged", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-claude", { claude: true });
  f.transcript(id, [{ kind: "notice", at: f.now, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt: null } }]);
  f.registry.recordReply(id, f.now);
  assert.notEqual(f.registry.thread(id)!.usageLimit, undefined);
  f.tick(gitPollMs);
  await f.pass();
  assert.deepEqual(f.typed, []);
  assert.equal(f.registry.attention(id), "limited");
});

test("a nudge the session could not take yet is kept and sent again under the same request ID", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-claude", { claude: true });
  f.turn(id);
  f.tick(gitPollMs);
  f.outcome = "blocked";
  await f.pass();
  assert.equal(f.typed.length, 1);
  assert.equal(f.registry.nudge(id)?.state, "sending", "the send is kept for the next pass");
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
    f.tick(gitPollMs);
    await f.pass();
  }
  assert.equal(f.registry.nudge(id)?.state, "person");
  f.registry.setThreadStatus(id, "archived");
  await f.nudger.poll();
  assert.equal(f.registry.nudge(id), null);
  assert.notEqual(f.registry.attention(id), "decision");
});

test("a harness builder's nudge refused by a deploy's drain is kept and goes out once the drain ends", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  let draining = true;
  const gate = turnGate(() => draining);
  const gated = builderNudger({
    registry: f.registry, harness: f.fake.harness, watch: f.watch, log: () => {}, github: f.github,
    inbox: agentInbox({ registry: f.registry, harness: { send: (...args) => gate.run(() => f.fake.harness.send(...args)) }, probes: new Map(), wake() {} }),
  });
  f.turn(id);
  f.tick(gitPollMs);
  await f.pass(gated);
  assert.deepEqual(f.nudges(), []);
  assert.equal(f.registry.nudge(id)?.state, "sending", "the send is kept for the next pass");
  draining = false;
  await gated.poll();
  assert.equal(f.nudges().length, 1);
  assert.equal(f.registry.nudge(id)?.state, "nudged");
});

test("a nudge delivered just before a crash still counts after the builder ended another turn", async (t) => {
  const f = fixture(t);
  const id = await f.add("th-1");
  const inbox = agentInbox({ registry: f.registry, harness: f.fake.harness, probes: new Map(), wake() {} });
  const nudger = (crash: boolean) => builderNudger({
    registry: f.registry, harness: f.fake.harness, watch: f.watch, log: () => {}, github: f.github,
    inbox: async (th, message) => { const result = await inbox(th, message); if (crash) throw new Error("the control plane stopped"); return result; },
  });
  const sent = () => new Set(f.nudges().map((n) => n.requestId)).size;
  f.turn(id);
  const first = f.registry.thread(id)!.lastReplyAt!;
  f.tick(gitPollMs);
  await f.pass(nudger(true));
  assert.equal(sent(), 1);
  f.tick(1_000);
  f.turn(id);
  f.tick(gitPollMs);
  const restarted = nudger(false);
  await f.pass(restarted);
  assert.equal(sent(), 1, "the earlier send is finished under its own request ID, which delivers nothing new");
  assert.deepEqual(f.registry.nudge(id), { state: "nudged", turn: first, count: 1 });
  for (let i = 0; i < 2; i++) {
    await f.pass(restarted);
    f.turn(id);
    f.tick(gitPollMs);
  }
  await f.pass(restarted);
  assert.equal(sent(), 2, "two nudges in all");
  assert.equal(f.registry.attention(id), "decision");
});

test("a nudge the drain held goes to neither a running turn nor a thread the person wrote to meanwhile", async (t) => {
  const f = fixture(t);
  let draining = true;
  const gate = turnGate(() => draining);
  const gated = builderNudger({
    registry: f.registry, harness: f.fake.harness, watch: f.watch, log: () => {}, github: f.github,
    inbox: agentInbox({ registry: f.registry, harness: { send: (...args) => gate.run(() => f.fake.harness.send(...args)) }, probes: new Map(), wake() {} }),
  });
  const running = await f.add("th-running");
  const theirs = await f.add("th-theirs");
  for (const id of [running, theirs]) f.turn(id);
  f.tick(gitPollMs);
  await f.pass(gated);
  for (const id of [running, theirs]) assert.equal(f.registry.nudge(id)?.state, "sending");
  f.registry.recordActivity(running, { agentTurnRunning: true });
  await f.personWrites(theirs, "Hold off, I will look at it.");
  f.registry.recordActivity(theirs, { agentTurnRunning: false });
  f.tick(1_000);
  f.turn(theirs);
  draining = false;
  await gated.poll();
  assert.deepEqual(f.nudges(), [], "nothing reaches the running turn or the person's thread");
  assert.equal(f.registry.nudge(running)?.state, "sending", "the send waits for the turn to end");
  assert.deepEqual(f.registry.nudge(theirs), { state: "left-alone" });
  f.registry.recordActivity(running, { agentTurnRunning: false });
  f.turn(running);
  await gated.poll();
  assert.deepEqual(f.nudges().map((n) => n.thread), [running], "it goes out once the turn ended");
});
