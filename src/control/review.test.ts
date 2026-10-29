import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import type { LiveHash, NodeName, PylonId, TailnetNodeId } from "../protocol.ts";
import type { AutoReview, ProjectId, SecretGrant } from "../project.ts";
import type { ChangedFile, LabelResult, MergeResult, PrSnapshot } from "./github.ts";
import type { AutomatedMessage } from "./inbox.ts";
import { holdRule, landingHolds } from "./policy.ts";
import { agentReplies, humanLabel, reviewerCaller, reviewLoop, reviewPrefix, type Review } from "./review.ts";
import { agentInbox } from "./inbox.ts";
import { fakeHarness } from "./fake-harness.ts";
import { transcriptStart, type ClaudeEntry } from "../claude-transcript.ts";
import { checkCaller, verifyCaller, type CheckState } from "./gate.ts";
import type { StartRequest } from "./threads.ts";
import { HttpError } from "./http-error.ts";

const node = "node" as NodeName;
const self = "nCONTROL" as TailnetNodeId;
const head1 = "1".repeat(40);
const head2 = "2".repeat(40);
const merged = "m".repeat(40);
const previous = "p".repeat(40);

function fixture(t: import("node:test").TestContext, options: { path?: string; repo?: string; secrets?: SecretGrant[]; claudeBuilder?: boolean; autoReview?: AutoReview } = {}) {
  const registry = openRegistry(options.path ?? ":memory:");
  t.after(() => { try { registry.close(); } catch { /* closed by a restart */ } });
  const repo = options.repo ?? "ramtinJ95/nexus";
  const project = { id: "nexus" as ProjectId, repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: options.secrets ?? [], logins: [], preSetup: null, autoReview: options.autoReview ?? null };
  if (registry.project(project.id) === undefined) {
    registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: self });
    registry.createProject(project);
  }
  /** A Claude worker thread, a harness thread, or with `bare` one with neither agent. */
  function add(id: string, claude: boolean, startedBy = "test", bare = false): ThreadId {
    if (registry.thread(id as ThreadId) !== undefined) return id as ThreadId;
    const thread: Thread = { id: id as ThreadId, title: id, project: project.id, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: claude || bare ? null : "1", startedBy, createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false, working: false };
    const { desired: _, ...pylon } = newPylonRecord({ thread: id, pylonId: thread.pylonId, node, desired: "running", boot: { pylonId: thread.pylonId, image: "img-000000000000", resources: project.resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "feature", commit: "origin/feature" } }, dotfiles: { repo: project.repoUrl, ref: "main" } }, firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash" as LiveHash });
    registry.createThread(thread, pylon, claude ? "fix it" : undefined, claude ? "claude-opus-5-5" : undefined);
    return thread.id;
  }
  const builder = add("th-builder", options.claudeBuilder ?? true);
  const pr = { repo, number: 7, title: "Add the cache", url: `https://github.com/${repo}/pull/7`, state: "open" as const, checks: "none" as const, review: "none", conflict: false };
  registry.savePrWatch(builder, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });

  let clock = 1_000_000;
  const replies = new Map<ThreadId, string[]>();
  const sent: { to: ThreadId; message: AutomatedMessage }[] = [];
  const started: StartRequest[] = [];
  let snapshot: PrSnapshot = { pr: { ...pr }, detail: { head: head1, branch: "feature", base: "main", body: "Adds a cache.\n\nNot checked live: the cache under real traffic.", mergeCommit: null }, failures: [], comments: [] };
  let files: ChangedFile[] = [{ path: "src/cache.ts", previous: null, patch: "@@ -0,0 +1 @@\n+export {};" }];
  const merges: string[] = [];
  let mergeAnswer: () => MergeResult = () => ({ kind: "merged", commit: merged });
  const labels = new Set<string>();
  const labelCalls: string[] = [];
  let labelAnswer: (name: string) => LabelResult = (name) => { labels.add(name); return { kind: "labelled" }; };
  let check: CheckState = { kind: "done", passed: true, output: "ok" };
  const checkThreads: ThreadId[] = [];
  const discarded: ThreadId[] = [];
  let verifies = false;
  let live: CheckState = { kind: "done", passed: true, output: "fleet ok" };
  let refuse: string | null = null;
  const liveThreads: ThreadId[] = [];
  const archived: ThreadId[] = [];
  let delivery: "delivered" | "later" = "delivered";
  let delivering = 0;
  let held: { entered: () => void; released: Promise<void> } | null = null;
  const deployers = new Set(["nLAPTOP"]);
  const woken: ThreadId[] = [];
  const loop = () => reviewLoop({
    registry, harnessModel: "gpt-6-astra",
    github: {
      find: async () => [7],
      poll: async () => structuredClone(snapshot),
      files: async () => files,
      has: async (_, __, path) => path === ".nexus/verify" && verifies,
      async label(_, __, name) { labelCalls.push(name); return labelAnswer(name); },
      async merge(_, __, sha) { merges.push(sha); const answer = mergeAnswer(); if (answer.kind === "merged") snapshot = { ...snapshot, pr: { ...snapshot.pr, state: "merged" }, detail: { ...snapshot.detail, mergeCommit: answer.commit } }; return answer; },
    },
    inbox: async (target, message) => { delivering++; if (held !== null) { held.entered(); await held.released; } if (delivery === "delivered") sent.push({ to: target.id, message }); return delivery; },
    replies: async (target) => replies.get(target.id) ?? [],
    checks: {
      async start() { const id = add(`th-check-${checkThreads.length + 1}`, false, checkCaller); checkThreads.push(id); return id; },
      poll: () => check,
      discard(id) { discarded.push(id); registry.setThreadStatus(id, "deleted"); },
    },
    live: {
      async start() {
        if (refuse !== null) throw new HttpError(409, refuse);
        const id = add(`th-verify-${liveThreads.length + 1}`, false, verifyCaller); liveThreads.push(id); return id;
      },
      poll: () => live,
      discard(id) { archived.push(id); registry.setThreadStatus(id, "archived"); },
    },
    release: { self, repo: "ramtinJ95/nexus" },
    mayLand: (caller) => deployers.has(caller),
    wake: (target) => { woken.push(target.id); },
    log: () => {},
    now: () => clock,
    async startThread(request, caller) { started.push(request); return registry.thread(add(`th-reviewer-${started.length}`, request.claude !== undefined, caller))!; },
  });
  const reply = (id: ThreadId, text: string) => {
    replies.set(id, [...replies.get(id) ?? [], text]);
    clock += 1_000;
    registry.recordReply(id, clock);
    clock += 61_000;
  };
  return {
    registry, builder, pr, loop, add, sent, started, merges, replies, reply, deployers, woken,
    get snapshot() { return snapshot; }, set snapshot(s) { snapshot = s; },
    set files(f: ChangedFile[]) { files = f; },
    set mergeAnswer(a: () => MergeResult) { mergeAnswer = a; },
    labels, labelCalls, set labelAnswer(a: (name: string) => LabelResult) { labelAnswer = a; },
    set check(c: CheckState) { check = c; },
    checkThreads, discarded,
    /** Whether the PR's head has a .nexus/verify, the live check's state, and why no node takes a verify pylon. */
    set verifies(v: boolean) { verifies = v; },
    set live(c: CheckState) { live = c; },
    set refuse(why: string | null) { refuse = why; },
    liveThreads, archived,
    set delivery(d: "delivered" | "later") { delivery = d; },
    /** How many deliveries the loop has begun, including one still held. */
    get delivering() { return delivering; },
    /** Holds every delivery until the returned release is called, so a test can act while a pass waits on the inbox. */
    holdDeliveries() {
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      held = { entered: entered.resolve, released: released.promise };
      return { entered: entered.promise, release() { held = null; released.resolve(); } };
    },
    tick(ms: number) { clock += ms; },
    get now() { return clock; },
    review: () => registry.review(builder)!,
    watched(state: "open" | "merged" | "closed") { registry.savePrWatch(builder, { links: [{ pr: { ...pr, state }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null }); },
    attention: () => registry.events("0", { kinds: ["attention.changed"], thread: builder }).map((e) => e.payload.attention),
    /** The statuses of the builder and of the review's reviewer. */
    statuses: () => [builder, registry.review(builder)!.reviewer].map((id) => registry.thread(id)!.status),
  };
}

/** A read of the Claude builder's transcript that finds `entries`, and the pylon's reports of `kinds` for its session. */
function claudeRead(f: ReturnType<typeof fixture>, entries: ClaudeEntry[], kinds: readonly ("session.turn-started" | "session.heartbeat")[]) {
  const from = f.registry.claudeTranscript(f.builder)?.cursor ?? transcriptStart;
  f.registry.appendClaudeRead(f.builder, { session: "s1", from, entries, cursor: { ...from, offset: from.offset + 1 }, reset: false, readAt: f.now });
  for (const kind of kinds) {
    f.registry.reportSession(node, { sequence: (f.registry.eventReceipt(node) ?? 0) + 1, time: f.now, pylon: "pylon-th-builder" as PylonId, event: { kind, session: "s1", at: f.now } });
  }
}

/**
 * A Claude builder's turn that ends in its transcript while a background shell keeps it working, as the pylon's Stop
 * hook reports it with heartbeats and no turn end.
 */
function heldTurn(f: ReturnType<typeof fixture>, text: string) {
  f.replies.set(f.builder, [...f.replies.get(f.builder) ?? [], text]);
  f.tick(1_000);
  claudeRead(f, [{ kind: "reply", at: f.now, text }, { kind: "turn", at: f.now, durationMs: 60_000 }], ["session.turn-started", "session.heartbeat"]);
  f.tick(1_000);
}

const archive = (registry: ReturnType<typeof openRegistry>, id: ThreadId) => registry.setThreadStatus(id, "archived");
const verdict = (r: Review, fields: Record<string, unknown>) => `Done.\n\`\`\`nexus-review\n${JSON.stringify({ token: r.expect, verdict: "approve", findings: [], reserved: [], notCheckedLive: "the cache under real traffic", ...fields })}\n\`\`\``;
const answers = (r: Review, list: unknown[]) => `Fixed.\n\`\`\`nexus-review-answers\n${JSON.stringify({ token: r.expect, answers: list })}\n\`\`\``;
const serious = { id: "F1", priority: "P1", where: "src/cache.ts:1", summary: "The cache never expires", detail: "Add a TTL." };

test("a Claude builder's PR gets a harness reviewer, and findings, fixes and new commits go round until it approves", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  const started = await loop.start(f.builder, { land: null });
  assert.deepEqual(started.models, { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, "another model family than the builder's");
  assert.equal(started.maxRounds, 5, "a review runs 5 rounds unless asked for fewer");
  assert.equal(f.started[0]!.claude, undefined, "the reviewer is a harness thread");
  assert.equal(f.started[0]!.branch, "feature");
  await loop.poll();
  const reviewer = f.review().reviewer;
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.to, reviewer);
  assert.ok(f.sent[0]!.message.text.startsWith(reviewPrefix));
  assert.match(f.sent[0]!.message.text, new RegExp(`git checkout --detach ${head1}`));
  assert.match(f.sent[0]!.message.text, /Not checked live: the cache under real traffic/, "the description reaches the reviewer");
  assert.equal(f.sent[0]!.message.sender, "review");
  assert.equal(f.registry.isReviewer(reviewer), true);

  f.reply(reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  assert.equal(f.sent[1]!.to, f.builder);
  assert.match(f.sent[1]!.message.text, /F1 \(P1\) src\/cache.ts:1: The cache never expires\n {4}Add a TTL\./);
  assert.match(f.sent[1]!.message.text, /```nexus-review-answers/);

  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a 5-minute TTL." }]));
  await loop.poll();
  assert.equal(f.sent.length, 2, "the loop waits for the push the builder says it made");
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  await loop.poll();
  assert.equal(f.review().rounds.length, 2);
  assert.equal(f.review().rounds[1]!.head, head2);
  assert.equal(f.sent[2]!.to, reviewer);
  assert.match(f.sent[2]!.message.text, new RegExp(`git diff ${head1}..${head2}`));
  assert.match(f.sent[2]!.message.text, /F1: fixed\. Added a 5-minute TTL\./);

  f.reply(reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" }, "approval runs the check, then stops when no landing was asked for");
  assert.deepEqual(f.review().rounds[1]!.check, { passed: true, output: "ok" });
  assert.deepEqual(f.registry.events("0", { kinds: ["review.changed"] }).map((e) => [(e.payload.phase as { kind: string }).kind, e.payload.round]),
    [["reviewing", 1], ["fixing", 1], ["reviewing", 2], ["checking", 2], ["approved", 2]]);
  assert.equal(f.registry.thread(f.builder)!.lastHumanActivityAt, 1, "nothing in the loop is human activity");
});

test("rounds that run out, and agents that never answer in the block, end with the person's attention", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  const reviewer = f.review().reviewer;
  f.reply(reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: ["The reviewer still requests changes after 1 rounds, the most this review allows."], label: { state: "added" } });
  assert.equal(f.registry.threads().find((th) => th.id === f.builder) && (f.registry.events("0", { kinds: ["attention.changed"], thread: f.builder }).at(-1)?.payload.attention), "decision");

  const g = fixture(t);
  const silent = g.loop();
  await silent.start(g.builder, { land: null });
  await silent.poll();
  const r = g.review().reviewer;
  for (let i = 0; i < 2; i++) {
    g.reply(r, "I looked and it seems fine.");
    await silent.poll();
    assert.match(g.sent.at(-1)!.message.text, /no nexus-review block/);
  }
  assert.deepEqual(g.sent.map((s) => s.message.id), [1, 2, 3].map((n) => `${g.review().id}:${n}`));
  assert.ok(g.sent.slice(1).every((s) => s.message.text.includes(g.review().expect)), "a reminder asks for the same token");
  g.reply(r, "Still fine.");
  await silent.poll();
  assert.equal(g.review().phase.kind, "needs-person");
  await silent.poll();
  assert.equal(g.sent.length, 3, "a reply in the old turn's shape is not answered twice");
  assert.equal((g.review().phase as { label?: unknown }).label, undefined, "only rounds that ran out label the PR");
  assert.deepEqual(g.labelCalls, []);
});

test("a Claude builder whose turn ends with a background shell running is read from its transcript, though it stays working", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  heldTurn(f, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a 5-minute TTL." }]));
  assert.equal(f.registry.thread(f.builder)!.working, true, "heartbeats keep the builder working");
  assert.equal(f.registry.thread(f.builder)!.lastReplyAt, null, "no turn end was reported");
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.deepEqual(f.review().rounds[0]!.answers, [{ id: "F1", action: "fixed", reason: "Added a 5-minute TTL." }]);
  assert.match(f.sent.at(-1)!.message.text, /F1: fixed\. Added a 5-minute TTL\./);
});

test("a Claude builder whose turn ends with a background shell running and no answer gets a reminder after the grace", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  const sent = f.sent.length;
  heldTurn(f, "Started the tests in the background.");
  await loop.poll();
  assert.equal(f.sent.length, sent, "no reminder within the grace a transcript may lag the turn's end by");
  f.tick(60_000);
  await loop.poll();
  assert.equal(f.sent.length, sent + 1);
  assert.equal(f.sent.at(-1)!.to, f.builder);
  assert.match(f.sent.at(-1)!.message.text, /no nexus-review-answers block/);
  assert.equal(f.review().nudges, 1);
  assert.equal(f.registry.thread(f.builder)!.working, true);

  f.tick(3 * 60 * 60_000 + 1);
  await loop.poll();
  assert.deepEqual((f.review().phase as { reasons: string[] }).reasons, ["The builder gave no answer Nexus could read within 3 hours in round 1."]);
});

test("a Claude builder that starts a newer turn after a held one gets no reminder until that turn ends too", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  const sent = f.sent.length;
  heldTurn(f, "Started the tests in the background.");
  claudeRead(f, [{ kind: "task", at: f.now, toolUseId: "b1", status: "completed", summary: "Background command finished", result: null }], ["session.turn-started"]);
  f.tick(61_000);
  await loop.poll();
  assert.equal(f.sent.length, sent, "no reminder while the turn the finished shell started runs");
  heldTurn(f, "The tests pass.");
  f.tick(60_000);
  await loop.poll();
  assert.equal(f.sent.length, sent + 1);
  assert.match(f.sent.at(-1)!.message.text, /no nexus-review-answers block/);
});

test("a Claude builder that answers it fixed findings in a turn that has not ended is waited on, and asks the person after the hours", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  const sent = f.sent.length;
  const text = answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a 5-minute TTL." }]);
  f.replies.set(f.builder, [text]);
  f.tick(1_000);
  claudeRead(f, [{ kind: "reply", at: f.now, text }], ["session.turn-started"]);
  f.tick(20 * 60_000);
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  assert.equal(f.sent.length, sent, "no reminder before the turn ends");
  f.tick(3 * 60 * 60_000);
  await loop.poll();
  assert.deepEqual((f.review().phase as { reasons: string[] }).reasons, ["The builder gave no answer Nexus could read within 3 hours in round 1."]);
});

test("a fixed failed check answered in a Claude builder's newer turn waits for that turn's end and push, not an earlier held turn's", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "1 test failed" };
  const loop = await approved(f, null);
  assert.equal(f.review().phase.kind, "fixing");
  heldTurn(f, "Started the tests in the background.");
  claudeRead(f, [{ kind: "task", at: f.now, toolUseId: "b1", status: "completed", summary: "Background command finished", result: null }], ["session.turn-started"]);
  f.tick(11 * 60_000);
  const text = answers(f.review(), [{ id: "CHECK", action: "fixed", reason: "Fixed the failing test." }]);
  f.replies.set(f.builder, [...f.replies.get(f.builder) ?? [], text]);
  claudeRead(f, [{ kind: "reply", at: f.now, text }], []);
  f.tick(1_000);
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing", "the turn that answered still runs, so its push may still come");
  f.check = { kind: "done", passed: true, output: "ok" };
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  heldTurn(f, "Pushed.");
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.equal(f.review().rounds[1]!.head, head2);
});

test("a message the inbox cannot deliver yet is sent again under the same request ID, never twice", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  f.delivery = "later";
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(f.sent.length, 0);
  assert.ok(f.review().outbox);
  f.delivery = "delivered";
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.sent.map((s) => s.message.id), [`${f.review().id}:1`]);
});

/** Reads whether the promise has settled, after the turns of the event loop it would need to. */
function watch(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; });
  return async () => { await new Promise((resolve) => setImmediate(resolve)); return settled; };
}

/** A review whose request to the reviewer the inbox keeps putting off, so each pass tries to deliver it once. */
async function undelivered(t: import("node:test").TestContext) {
  const f = fixture(t);
  const loop = f.loop();
  f.delivery = "later";
  await loop.start(f.builder, { land: null });
  await loop.close();
  return { f, loop, before: f.delivering };
}

test("a poll while a pass runs joins it and settles after it, and a poll after it settles runs a new pass", async (t) => {
  const { f, loop, before } = await undelivered(t);
  const held = f.holdDeliveries();
  const first = loop.poll();
  await held.entered;
  const second = watch(loop.poll());
  assert.equal(await second(), false, "the joined poll waits for the pass it joined");
  held.release();
  await first;
  assert.equal(await second(), true);
  assert.equal(f.delivering, before + 1, "one pass ran for both polls");
  await loop.poll();
  assert.equal(f.delivering, before + 2);
});

test("close waits for the pass in flight", async (t) => {
  const { f, loop, before } = await undelivered(t);
  const held = f.holdDeliveries();
  void loop.poll();
  await held.entered;
  const closed = watch(loop.close());
  assert.equal(await closed(), false);
  f.delivery = "delivered";
  held.release();
  assert.equal(await closed(), true);
  assert.equal(f.delivering, before + 1);
  assert.equal(f.sent.length, 1, "the pass delivered before close resolved");
});

test("a harness builder gets a Claude reviewer only where the project grants a Claude token, and its prompt runs as given", async (t) => {
  const f = fixture(t, { claudeBuilder: false });
  await assert.rejects(f.loop().start(f.builder, { land: null }), /no reviewer on another model can run/);
  const g = fixture(t, { claudeBuilder: false, secrets: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }] });
  const review = await g.loop().start(g.builder, { land: null });
  assert.deepEqual(review.models, { builder: "gpt-6-astra", reviewer: "claude-opus-5-5" });
  assert.equal(g.started[0]!.raw, true, "no /poteto-mode in front of the reviewer's request");
  assert.ok(g.started[0]!.claude!.startsWith(reviewPrefix));
  assert.equal(review.outbox, null, "a Claude reviewer's request is its first prompt");
});

async function approved(f: ReturnType<typeof fixture>, land: string | null) {
  const loop = f.loop();
  await loop.start(f.builder, { land });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  return loop;
}

test("a landing under the policy merges the approved head, deploys it and waits for every service to be healthy", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-review-")); t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "registry.db");
  const f = fixture(t, { path });
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  await approved(f, "nLAPTOP");
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.review().phase.kind, "deploying");
  assert.equal(f.registry.desiredRelease()?.commit, merged);
  assert.match(f.registry.desiredRelease()!.requestedBy, /^nexus review rv-/);

  f.registry.close();
  const g = fixture(t, { path });
  g.snapshot = { ...g.snapshot, pr: { ...g.snapshot.pr, state: "merged" }, detail: { ...g.snapshot.detail, mergeCommit: merged } };
  const restarted = g.loop();
  await restarted.poll();
  assert.equal(g.review().phase.kind, "deploying", "a restart, such as the deploy's own, waits on without merging or deploying again");
  assert.deepEqual(g.merges, []);
  for (const role of ["control", "probe"] as const) g.registry.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: Date.now() });
  await restarted.poll();
  assert.deepEqual(g.review().phase, { kind: "landed", commit: merged });
  assert.equal(g.registry.desiredRelease()?.commit, merged);
});

test("a deploy that fails rolls back to the previous release and tells the person what still needs reverting", async (t) => {
  const f = fixture(t);
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  const loop = await approved(f, "nLAPTOP");
  f.registry.reportRelease({ node, role: "control", commit: previous, target: merged, state: "rolled-back", reason: "health check failed", observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.registry.desiredRelease()?.commit, previous);
  assert.equal(f.review().phase.kind, "rolling-back", "a rollback is not claimed until the fleet reports it healthy");
  for (const role of ["control", "probe"] as const) f.registry.reportRelease({ node, role, commit: previous, target: previous, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [
    `The deploy of ${merged} failed: node control rolled-back (health check failed).`,
    `Rolled back to the previous release, ${previous}, which every service reports healthy.`,
    `${merged} is still on the default branch, so revert it before the next deploy.`,
  ] });
  assert.throws(() => loop.land(f.builder, "nLAPTOP"), /already merged/, "a merged review cannot land again");
});

test("another repository's PR merges without a deploy", async (t) => {
  const f = fixture(t, { repo: "acme/shop" });
  await approved(f, "nLAPTOP");
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
  assert.equal(f.registry.desiredRelease(), null);
});

test("a review that lands archives its builder and reviewer, once, whether its PR deploys or not", async (t) => {
  for (const repo of ["ramtinJ95/nexus", "acme/shop"]) {
    const f = fixture(t, { repo });
    f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
    const loop = await approved(f, "nLAPTOP");
    if (repo === "ramtinJ95/nexus") {
      assert.equal(f.review().phase.kind, "deploying");
      assert.deepEqual(f.statuses(), ["active", "active"], "a landing that still deploys archives nothing");
      for (const role of ["control", "probe"] as const) f.registry.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: Date.now() });
      await loop.poll();
    }
    assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
    assert.deepEqual(f.statuses(), ["archived", "archived"], `${repo}: both threads are archived once the review lands`);
    assert.deepEqual(f.woken, [f.builder, f.review().reviewer], "the planner hears of each archive, so their pylons pause");
    f.registry.setThreadStatus(f.builder, "active");
    await loop.poll();
    assert.deepEqual(f.statuses(), ["active", "archived"], "a landed builder the person unarchives stays open");
  }
});

test("a landing whose save fails archives nothing, so a release that supersedes it before the retry leaves both threads open", async (t) => {
  const f = fixture(t);
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  const loop = await approved(f, "nLAPTOP");
  const save = f.registry.saveReview;
  f.registry.saveReview = (review, archive) => {
    if (review.phase.kind === "landed") throw new Error("disk I/O error");
    save(review, archive);
  };
  for (const role of ["control", "probe"] as const) f.registry.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.review().phase.kind, "deploying");
  assert.deepEqual(f.statuses(), ["active", "active"], "no thread is archived while the landing is unsaved");
  f.registry.saveReview = save;
  f.registry.setDesiredRelease({ commit: "n".repeat(40), requestedBy: "person", requestedAt: 2 });
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person");
  assert.deepEqual(f.statuses(), ["active", "active"]);
  assert.deepEqual(f.woken, []);
});

test("a review held for the person, or one that stops at approval, archives nothing", async (t) => {
  const held = fixture(t);
  held.files = [{ path: "images/pylon/Dockerfile", previous: null, patch: "@@ -1 +1 @@\n-FROM a\n+FROM b" }];
  await approved(held, "nLAPTOP");
  assert.equal(held.review().phase.kind, "needs-person");
  assert.deepEqual(held.merges, []);
  assert.deepEqual(held.statuses(), ["active", "active"], "a landing the policy holds");

  const rolledBack = fixture(t);
  rolledBack.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  const loop = await approved(rolledBack, "nLAPTOP");
  rolledBack.registry.reportRelease({ node, role: "control", commit: previous, target: merged, state: "failed", reason: "unit failed", observedAt: Date.now() });
  await loop.poll();
  for (const role of ["control", "probe"] as const) rolledBack.registry.reportRelease({ node, role, commit: previous, target: previous, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  assert.equal(rolledBack.review().phase.kind, "needs-person");
  assert.deepEqual(rolledBack.statuses(), ["active", "active"], "a merge whose deploy rolled back");

  const approval = fixture(t);
  await approved(approval, null);
  assert.equal(approval.review().phase.kind, "approved");
  assert.deepEqual(approval.statuses(), ["active", "active"], "a review without a landing");
  assert.deepEqual([...held.woken, ...rolledBack.woken, ...approval.woken], []);
});

test("a thread in a turn as its review lands stays open, and the other is archived", async (t) => {
  const f = fixture(t, { repo: "acme/shop" });
  f.registry.recordActivity(f.builder, { agent: 1, agentTurnRunning: true });
  const loop = await approved(f, "nLAPTOP");
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
  assert.deepEqual(f.statuses(), ["active", "archived"]);
  f.registry.recordActivity(f.builder, { agent: 2, agentTurnRunning: false });
  await loop.poll();
  assert.deepEqual(f.statuses(), ["active", "archived"], "the person archives a builder that was busy as it landed");
});

test("a token that cannot merge holds the landing for the person, and a later land tries again", async (t) => {
  const f = fixture(t, { repo: "acme/shop" });
  f.mergeAnswer = () => ({ kind: "denied", message: "GitHub answered 403: Resource not accessible by personal access token" });
  const loop = await approved(f, "nLAPTOP");
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: ["The control plane's GitHub token cannot merge (GitHub answered 403: Resource not accessible by personal access token). Merging needs a token with write access to acme/shop's contents and pull requests, which only the person can grant."] });
  f.mergeAnswer = () => ({ kind: "merged", commit: merged });
  assert.throws(() => loop.land(f.builder, "nLAPTOP", "f".repeat(40)), /is at [0-9a-f]{40}, not f{40}, so it was not landed/, "a land for another commit than the approved one does nothing");
  assert.equal(f.review().phase.kind, "needs-person");
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
  assert.deepEqual(f.merges, [head1, head1]);
});

test("the policy names every condition that fails and every reserved case, and holds without merging", async (t) => {
  const f = fixture(t);
  f.files = [
    { path: "images/pylon/Dockerfile", previous: null, patch: "@@ -1 +1 @@\n-FROM a\n+FROM b" },
    { path: "src/control/registry.ts", previous: null, patch: "@@ -240,3 +240,4 @@ const migrations: readonly string[] = [\n+  `ALTER TABLE threads ADD COLUMN x TEXT;`," },
    { path: "src/control/registry.ts.bak", previous: null, patch: "" },
  ];
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, body: "Adds a cache." } };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { reserved: [{ case: "cli-breaking", why: "renames --wait" }] }));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [
    "The reviewer's quote of what could not be checked live is not in the pull request's description.",
    "Always needs the person: breaking changes to the CLI's contract, by the reviewer's reading (renames --wait).",
    "Always needs the person: pylon image rebuilds, as it changes images/pylon/Dockerfile.",
    "Always needs the person: anything irreversible, as it changes src/control/registry.ts.",
  ] });
});

test("the policy's review conditions: another model, an approval with no P0 to P2 open, and every blocking finding answered", () => {
  const round = { head: head1, verdict: { token: "x", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: "the cache under real traffic" }, check: { passed: true, output: "" }, live: { kind: "absent" as const }, answers: null };
  const review: Review = {
    id: "rv-1", builder: "th-b" as ThreadId, reviewer: "th-r" as ThreadId, pr: { repo: "acme/shop", number: 7, url: "", title: "", branch: "f" }, models: { builder: "m", reviewer: "m" }, reviewerKind: "harness",
    maxRounds: 3, land: null, auto: false, merged: null, waiver: null, expect: "rv-1:t", sent: 1, phase: { kind: "checking", startedAt: 0, thread: null }, outbox: null, since: 0, nudges: 0, startedAt: 0,
    rounds: [{ ...round, verdict: { ...round.verdict, verdict: "changes", findings: [{ id: "F1", priority: "P2", summary: "s" }, { id: "F2", priority: "P2", summary: "s" }, { id: "N1", priority: "P3", summary: "s" }] }, answers: [{ id: "F1", action: "rejected", reason: " " }] }, round],
  };
  const pr: PrSnapshot = { pr: { repo: "acme/shop", number: 7, title: "", url: "", state: "open", checks: "pending", review: "none", conflict: true }, detail: { head: head2, branch: "f", base: "main", body: "Not checked live: the cache under real traffic.", mergeCommit: null }, failures: [], comments: [] };
  assert.deepEqual(landingHolds({ review, pr, files: [], nexus: false }), [
    "The reviewer ran the builder's own model, m.",
    "The builder neither fixed nor rejected with a reason finding F1 of round 1.",
    "The builder neither fixed nor rejected with a reason finding F2 of round 1.",
    `The pull request's head is ${head2}, not the approved ${head1}.`,
    "The branch conflicts with its base.",
    "The pull request's GitHub checks are pending.",
  ]);
});

test("a check that fails after an approval with P3 notes asks the builder to answer only the check, under a new token", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "src/cache.ts(1,1): error TS2322" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { findings: [{ id: "M1", priority: "P3", summary: "Name the constant" }] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  const toBuilder = f.sent.filter((s) => s.to === f.builder).map((s) => s.message.text);
  assert.equal(toBuilder.length, 2, "the approval's notes, then the check's failure");
  const ids = f.sent.map((s) => s.message.id);
  assert.equal(new Set(ids).size, ids.length, "every message has its own request ID");
  assert.match(toBuilder[1]!, /CHECK \(P0\) \.nexus\/check: \.nexus\/check failed at 1{40}\n {4}src\/cache\.ts\(1,1\): error TS2322/);
  assert.doesNotMatch(toBuilder[1]!, /M1/, "the notes came with the approval already");
  assert.ok(toBuilder[1]!.includes(f.review().expect));
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "fixed", reason: "Fixed the type." }]));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "the check is the only finding to answer");
  assert.equal(f.review().rounds.at(-1)!.head, head2);
});

test("commits pushed with answers that fixed nothing still get another round", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "flaky" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "rejected", reason: "The check is flaky." }]));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.equal(f.review().rounds.at(-1)!.head, head2);
});

test("a check the pylon cannot run goes to the person with its output, and costs the builder nothing", async (t) => {
  const f = fixture(t);
  f.check = { kind: "unrunnable", output: "The repository has no executable .nexus/check at 1." };
  await approved(f, null);
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [
    `.nexus/check could not run at ${head1}.`,
    "The check's output:\nThe repository has no executable .nexus/check at 1.",
  ] });
  assert.equal(f.sent.length, 1, "neither agent hears of it");
  assert.equal(f.review().rounds.length, 1);
  assert.deepEqual(f.discarded, f.checkThreads);
});

test("a failed check the builder answers without a push goes to the person at once, not back to the reviewer", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "npm error code SELF_SIGNED_CERT_IN_CHAIN" };
  await approved(f, null);
  assert.equal(f.review().phase.kind, "fixing");
  f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "rejected", reason: "npm cannot reach the registry from the check pylon." }]));
  await f.loop().poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [
    `.nexus/check failed at ${head1}, and the builder pushed nothing for it: npm cannot reach the registry from the check pylon.`,
    "The check's output:\nnpm error code SELF_SIGNED_CERT_IN_CHAIN",
  ] });
  assert.equal(f.sent.length, 2, "the reviewer is not asked to approve the same head again");
  assert.equal(f.checkThreads.length, 1);
});

test("a failed check answered as fixed with no push goes to the person once the push grace ends", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "1 test failed" };
  const loop = await approved(f, null);
  f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "fixed", reason: "Fixed the test." }]));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing", "a push may land a little after the turn");
  f.tick(10 * 60_000);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [`.nexus/check failed at ${head1}, and the builder pushed nothing for it: Fixed the test.`, "The check's output:\n1 test failed"] });
  assert.equal(f.sent.length, 2, "no reminder, and no round for the reviewer");
});

test("a check that fails again at a head where it failed before goes to the person", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "1 test failed" };
  const loop = await approved(f, null);
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "fixed", reason: "Fixed the test." }]));
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head1 } };
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Reverted to the first head." }]));
  await loop.poll();
  assert.equal(f.review().rounds.at(-1)!.head, head1);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [`.nexus/check failed again at ${head1}, where it failed before.`, "The check's output:\n1 test failed"] });
});

test("in a review stored before priorities, a reviewer's repeat approval of an unchanged head costs no round", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 2 });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { findings: [serious] }));
  await loop.poll();
  // Before priorities, an approval with a serious finding was stored as an approval.
  const stored = f.review();
  f.registry.saveReview({ ...stored, rounds: [{ ...stored.rounds[0]!, verdict: { ...stored.rounds[0]!.verdict!, verdict: "approve" } }] });
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "rejected", reason: "The cache is rebuilt on every deploy." }]));
  await loop.poll();
  assert.equal(f.review().rounds[1]!.head, head1);
  f.check = { kind: "done", passed: false, output: "1 test failed" };
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing", "the failed check reaches the builder: the approval at the same head spent no round");
  assert.match(f.sent.at(-1)!.message.text, /^Round 1 of at most 2/m);
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "fixed", reason: "Fixed the test." }]));
  await loop.poll();
  assert.match(f.sent.at(-1)!.message.text, /^Round 2 of at most 2/m);
  f.check = { kind: "done", passed: true, output: "ok" };
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
});

test("a landing sees its deploy through, rolling back, though its threads are archived meanwhile", async (t) => {
  const f = fixture(t);
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  const loop = await approved(f, "nLAPTOP");
  assert.equal(f.review().phase.kind, "deploying");
  archive(f.registry, f.builder);
  archive(f.registry, f.review().reviewer);
  f.registry.reportRelease({ node, role: "control", commit: previous, target: merged, state: "failed", reason: "unit failed", observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.registry.desiredRelease()?.commit, previous);
  f.registry.reportRelease({ node, role: "control", commit: merged, target: previous, state: "failed", reason: "unit failed again", observedAt: Date.now() });
  await loop.poll();
  assert.match((f.review().phase as { reasons: string[] }).reasons[1]!, /^The rollback to p{40} failed too: node control failed \(unit failed again\)/, "a failed rollback says so");
});

test("a PR that merged at another head than the approved one is not deployed", async (t) => {
  const f = fixture(t);
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  f.mergeAnswer = () => ({ kind: "refused", message: "unused" });
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, head: head2, mergeCommit: merged } };
  await loop.poll();
  assert.equal(f.registry.desiredRelease()?.commit, previous);
  assert.equal(f.review().phase.kind, "needs-person");
});

test("a reviewer a later review replaced is still a reviewer, and an archived builder cannot land", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  const first = f.review().reviewer;
  f.reply(first, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  await loop.start(f.builder, { land: null });
  assert.notEqual(f.review().reviewer, first);
  assert.equal(f.registry.isReviewer(first), true);
  archive(f.registry, f.builder);
  assert.throws(() => loop.land(f.builder, "nLAPTOP"), /archived/);
});

test("each check runs in its own check thread, thrown away after its verdict, and a check thread no review holds is thrown away", async (t) => {
  const f = fixture(t);
  await approved(f, null);
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.equal(f.checkThreads.length, 1);
  assert.deepEqual(f.discarded, f.checkThreads, "the check thread goes once it gave its verdict");
  assert.notEqual(f.checkThreads[0], f.review().reviewer, "the check never runs in the reviewer's pylon");
  const orphan = f.add("th-check-orphan", false, checkCaller);
  await f.loop().poll();
  assert.ok(f.discarded.includes(orphan));
});

test("a head with a .nexus/verify lands once its live check passes in a verify pylon, which stands in for the statement of what was not checked live", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, body: "Adds a cache." } };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { notCheckedLive: null }));
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
  assert.deepEqual(f.review().rounds.at(-1)!.live, { kind: "ran", thread: f.liveThreads[0], passed: true, output: "fleet ok" });
  assert.equal(f.liveThreads.length, 1);
  assert.deepEqual(f.archived, f.liveThreads, "the verify pylon is archived once it gave its verdict");
  assert.deepEqual(f.registry.events("0", { kinds: ["review.changed"] }).map((e) => (e.payload.phase as { kind: string }).kind).slice(0, 4), ["reviewing", "checking", "verifying", "merging"]);

  const g = fixture(t, { path: ":memory:" });
  g.snapshot = { ...g.snapshot, detail: { ...g.snapshot.detail, body: "Adds a cache." } };
  const gLoop = g.loop();
  await gLoop.start(g.builder, { land: "nLAPTOP" });
  await gLoop.poll();
  g.reply(g.review().reviewer, verdict(g.review(), { notCheckedLive: null }));
  await gLoop.poll();
  assert.deepEqual(g.merges, [], "a head without .nexus/verify still needs the statement");
  assert.deepEqual(g.liveThreads, []);
  assert.deepEqual(g.review().rounds.at(-1)!.live, { kind: "absent" });
  assert.deepEqual(g.review().phase, { kind: "needs-person", reasons: ["No live check ran, and the pull request does not say what could not be checked live."] });
});

test("a landing stored before live checks, whose head has a .nexus/verify, is held until a landing runs its live check", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  const { live: _, ...unverified } = f.review().rounds[0]!;
  f.registry.saveReview({ ...f.review(), land: { requestedBy: "nLAPTOP" }, rounds: [unverified], phase: { kind: "merging", authorized: null } });
  f.verifies = true;
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [`The live check has not run at ${head1}.`] });
  loop.land(f.builder, "nLAPTOP");
  await loop.poll();
  assert.equal(f.liveThreads.length, 1, "landing again ran the live check");
  assert.deepEqual(f.merges, [head1]);
});

test("a verify pylon the person unarchives stays open, after its verdict, after its review is replaced, or after it timed out", async (t) => {
  const unarchive = (f: ReturnType<typeof fixture>, id: ThreadId) => { f.registry.setThreadStatus(id, "active"); f.registry.recordActivity(id, { human: 2 }); };
  const f = fixture(t);
  f.verifies = true;
  const loop = await approved(f, null);
  assert.deepEqual(f.archived, f.liveThreads);
  unarchive(f, f.liveThreads[0]!);
  await loop.poll();
  f.registry.saveReview({ ...f.review(), id: "rv-next", rounds: [{ head: head2, verdict: null, check: null, answers: null }], phase: { kind: "approved" } });
  await loop.poll();
  assert.equal(f.registry.thread(f.liveThreads[0]!)!.status, "active", "the review that recorded it is gone");
  assert.equal(f.archived.length, 1);

  const g = fixture(t, { path: ":memory:" });
  g.verifies = true;
  g.live = { kind: "running" };
  const gLoop = await approved(g, null);
  g.tick(61 * 60_000);
  await gLoop.poll();
  assert.equal(g.review().phase.kind, "needs-person");
  assert.deepEqual(g.archived, g.liveThreads, "the timed-out verify pylon was archived as its review ended");
  unarchive(g, g.liveThreads[0]!);
  await gLoop.poll();
  assert.equal(g.registry.thread(g.liveThreads[0]!)!.status, "active");
});

test("a live check that fails holds the landing like a failed check: the builder answers it as a P0, and a failure it does not push for goes to the person", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.live = { kind: "done", passed: false, output: "verify-nexus: the thread never reported running" };
  const loop = await approved(f, "nLAPTOP");
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().phase.kind, "fixing");
  const toBuilder = f.sent.filter((s) => s.to === f.builder).map((s) => s.message.text).at(-1)!;
  assert.match(toBuilder, /the live check failed after the reviewer approved and the repository's checks passed/);
  assert.match(toBuilder, /LIVE \(P0\) \.nexus\/verify: The live check failed at 1{40}\n {4}verify-nexus: the thread never reported running/);
  assert.throws(() => loop.land(f.builder, "nLAPTOP"), { status: 409 });
  f.reply(f.builder, answers(f.review(), [{ id: "LIVE", action: "rejected", reason: "The stack is flaky." }]));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [
    `The live check failed at ${head1}, and the builder pushed nothing for it: The stack is flaky.`,
    "The live check's output:\nverify-nexus: the thread never reported running",
  ] });
  assert.throws(() => loop.land(f.builder, "nLAPTOP"), { status: 409, message: /not approved with its checks passing/ });
  assert.deepEqual(f.archived, f.liveThreads);

  const g = fixture(t, { path: ":memory:" });
  g.verifies = true;
  g.live = { kind: "done", passed: false, output: "boom" };
  const gLoop = await approved(g, "nLAPTOP");
  g.snapshot = { ...g.snapshot, detail: { ...g.snapshot.detail, head: head2 } };
  g.reply(g.builder, answers(g.review(), [{ id: "LIVE", action: "fixed", reason: "Fixed the boot." }]));
  await gLoop.poll();
  assert.equal(g.review().phase.kind, "reviewing", "a pushed fix gets a new round");
  g.live = { kind: "done", passed: true, output: "fleet ok" };
  g.reply(g.review().reviewer, verdict(g.review(), {}));
  await gLoop.poll();
  assert.deepEqual(g.merges, [head2]);
  assert.equal(g.liveThreads.length, 2, "each head gets a fresh verify pylon");
});

test("a verify pylon no node can take yet is tried again, and the person hears why once the live check's hour is up", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.refuse = "no node can run this pylon: rj-firebat is offline";
  const loop = await approved(f, "nLAPTOP");
  const { startedAt: _, ...waiting } = f.review().phase as Extract<Review["phase"], { kind: "verifying" }>;
  assert.deepEqual(waiting, { kind: "verifying", thread: null, refused: "no node can run this pylon: rj-firebat is offline" });
  f.tick(30 * 60_000);
  f.refuse = null;
  await loop.poll();
  assert.equal(f.liveThreads.length, 1, "a node that came back takes it");
  assert.deepEqual(f.merges, [head1]);

  const g = fixture(t, { path: ":memory:" });
  g.verifies = true;
  g.refuse = "no node can run this pylon: infra-testbench cannot give a pylon KVM of its own: its probe does not report nested virtualization";
  const gLoop = await approved(g, "nLAPTOP");
  g.tick(61 * 60_000);
  await gLoop.poll();
  assert.deepEqual(g.review().phase, { kind: "needs-person", reasons: [
    `The live check gave no verdict within 60 minutes at ${head1}.`,
    "No node could take its verify pylon: no node can run this pylon: infra-testbench cannot give a pylon KVM of its own: its probe does not report nested virtualization",
  ] });
});

test("a live check its pylon cannot run goes to the person, and a verify pylon no review holds is archived", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.live = { kind: "unrunnable", output: "The verify pylon did not boot: This pylon asked for nested virtualization, and its guest has no /dev/kvm." };
  await approved(f, "nLAPTOP");
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [
    `The live check could not run at ${head1}.`,
    "The live check's output:\nThe verify pylon did not boot: This pylon asked for nested virtualization, and its guest has no /dev/kvm.",
  ] });
  assert.deepEqual(f.merges, []);
  const orphan = f.add("th-verify-orphan", false, verifyCaller);
  await f.loop().poll();
  assert.ok(f.archived.includes(orphan));
});

test("the policy reads a live check: a failure holds, a pass needs no statement, and a change to .nexus/verify is the person's to waive", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.files = [{ path: ".nexus/verify", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  const holds = (f.review().phase as { reasons: string[] }).reasons;
  assert.deepEqual(holds, ["The pull request changes .nexus/verify, the live check this policy relies on."]);
  loop.land(f.builder, "nLAPTOP", head1, holds);
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.liveThreads.length, 1, "the landing kept the live check that passed at the same head");

  const review = { ...f.review(), rounds: [{ ...f.review().rounds[0]!, live: { kind: "ran" as const, thread: f.liveThreads[0]!, passed: false, output: "boom" } }] };
  const pr: PrSnapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "open" }, detail: { ...f.snapshot.detail, mergeCommit: null } };
  assert.deepEqual(landingHolds({ review, pr, files: [], nexus: false }), [
    "Findings P0 to P2 are open: LIVE.", "The builder neither fixed nor rejected with a reason finding LIVE of round 1.", `The live check failed at ${head1}.`,
  ]);
  assert.equal(holdRule(`The live check failed at ${head1}.`).waivable, false);
});

test("a check run that cannot give a verdict starts again in a fresh check thread", async (t) => {
  const f = fixture(t);
  f.check = { kind: "void" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "checking");
  f.check = { kind: "done", passed: true, output: "ok" };
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.ok(f.checkThreads.length >= 2, "the void run's thread was replaced");
  assert.deepEqual(f.discarded, f.checkThreads);
});

test("a Claude reviewer's approval does not land, and goes to the person", async (t) => {
  const f = fixture(t, { claudeBuilder: false, secrets: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }] });
  await approved(f, "nLAPTOP");
  assert.equal(f.review().reviewerKind, "claude");
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().phase.kind, "needs-person");
  assert.match((f.review().phase as { reasons: string[] }).reasons.join("\n"), /A Claude reviewer approved it/);
  assert.equal((f.review().phase as { label?: unknown }).label, undefined, "a held approval is not a review that ran out of rounds");
  assert.deepEqual(f.labelCalls, []);
});

test("every merge attempt checks the policy again, so checks that fail after approval, or across a restart, hold it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-review-")); t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "registry.db");
  const f = fixture(t, { path, repo: "acme/shop" });
  f.mergeAnswer = () => { throw new Error("GitHub is down"); };
  await approved(f, "nLAPTOP");
  assert.equal(f.review().phase.kind, "merging", "a failed attempt leaves the landing merging, to try again");
  f.registry.close();
  const g = fixture(t, { path, repo: "acme/shop" });
  g.snapshot = { ...g.snapshot, pr: { ...g.snapshot.pr, checks: "failed" } };
  await g.loop().poll();
  assert.deepEqual(g.merges, []);
  assert.deepEqual(g.review().phase, { kind: "needs-person", reasons: ["The pull request's GitHub checks are failed."] });
});

test("a reply that came while a delivered message was not yet cleared is still read after a crash", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  f.delivery = "later";
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const attempted = f.review().outbox!.attempted!;
  assert.ok(attempted > 0, "the first send's start is saved before it");
  // The send went through, the reviewer answered, and the crash came before the outbox was cleared.
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  f.delivery = "delivered";
  await loop.poll();
  assert.equal(f.review().since, attempted);
  assert.notEqual(f.review().phase.kind, "reviewing", "the reply that came meanwhile was read");
});

test("a PR merged outside the review is held by the policy like this review's own merge, and never deployed past a hold", async (t) => {
  const f = fixture(t, { claudeBuilder: false, secrets: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }] });
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  f.files = [{ path: "images/pylon/Dockerfile", previous: null, patch: "@@ -1 +1 @@\n-FROM a\n+FROM b" }];
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "checking");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, mergeCommit: merged } };
  f.check = { kind: "done", passed: true, output: "ok" };
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.equal(f.registry.desiredRelease()?.commit, previous, "nothing was deployed");
  const reasons = (f.review().phase as { reasons: string[] }).reasons;
  assert.equal(reasons[0], "Pull request #7 was merged outside this review, so it is not deployed.");
  assert.ok(reasons.some((r) => r.startsWith("A Claude reviewer approved it")));
  assert.ok(reasons.some((r) => r.startsWith("Always needs the person: pylon image rebuilds")));
});

test("a PR merged outside the review that the policy would have merged deploys", async (t) => {
  const f = fixture(t);
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, mergeCommit: merged } };
  f.check = { kind: "done", passed: true, output: "ok" };
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().phase.kind, "deploying");
  assert.equal(f.registry.desiredRelease()?.commit, merged);
});

test("this review's own merge, recorded before the merge call, deploys after a crash without being judged again", async (t) => {
  const f = fixture(t);
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  f.mergeAnswer = () => {
    // GitHub merged it, then the control plane crashed before it saw the answer.
    f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, mergeCommit: merged } };
    throw new Error("connection reset");
  };
  await approved(f, "nLAPTOP");
  assert.deepEqual(f.review().phase, { kind: "merging", authorized: head1 }, "the head is authorized before the merge call");
  f.files = [{ path: "images/pylon/Dockerfile", previous: null, patch: "" }];
  await f.loop().poll();
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.review().phase.kind, "deploying");
  assert.equal(f.registry.desiredRelease()?.commit, merged);
});

const labelStates = (f: ReturnType<typeof fixture>) => f.registry.events("0", { kinds: ["review.changed"] }).map((e) => (e.payload.phase as { label?: { state: string } }).label?.state).filter((s) => s !== undefined);

async function labelsOnceAcrossRetries(f: ReturnType<typeof fixture>, loop: ReturnType<ReturnType<typeof fixture>["loop"]>, exhaust: () => void, ...reasons: string[]) {
  f.labelAnswer = (name) => { f.labels.add(name); throw new Error("connection reset"); };
  exhaust();
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons, label: { state: "adding" } }, "a failed call leaves the label to add at the next pass");
  f.labelAnswer = (name) => { f.labels.add(name); return { kind: "labelled" }; };
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons, label: { state: "added" } });
  assert.deepEqual([...f.labels], [humanLabel]);
  assert.equal(f.labelCalls.length, 2, "once more after the failed call, then never again");
  assert.deepEqual(labelStates(f), ["adding", "added"]);
}

test("a reviewer that still requests changes after the last round gets the PR labelled for the person, once across retries", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  await labelsOnceAcrossRetries(f, loop, () => f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] })),
    "The reviewer still requests changes after 1 rounds, the most this review allows.");
});

test("a check that fails after the last round gets the PR labelled for the person, once across retries", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "error" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  await labelsOnceAcrossRetries(f, loop, () => f.reply(f.review().reviewer, verdict(f.review(), {})), `.nexus/check failed at ${head1} after the last round this review allows.`, "The check's output:\nerror");
});

/** A review saved before the cap and priorities: 10 rounds allowed, findings with a severity, and 5 rounds run. */
function legacyReview(f: ReturnType<typeof fixture>, phase: "reviewing" | "fixing"): void {
  const r = f.review();
  const old = { id: "F1", severity: "serious", where: "src/cache.ts:1", summary: "The cache never expires" };
  const round = (head: string) => ({ head, verdict: { token: "x", verdict: "changes", findings: [old, { id: "M1", severity: "minor", summary: "Name the constant" }], reserved: [], notCheckedLive: null }, check: null, answers: [{ id: "F1", action: "fixed", reason: "TTL" }] });
  const last = phase === "reviewing" ? { head: head1, verdict: null, check: null, answers: null } : { ...round(head1), answers: null };
  f.registry.saveReview({ ...r, maxRounds: 10, phase: { kind: phase }, rounds: [round("a".repeat(40)), round("b".repeat(40)), round("c".repeat(40)), round("d".repeat(40)), last] } as never as Review);
}

test("a review stored with more rounds reads back capped at 5 with priorities, and stops at round 5 with the label", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  legacyReview(f, "reviewing");
  assert.equal(f.review().maxRounds, 5);
  assert.deepEqual(f.review().rounds[0]!.verdict!.findings.map((x) => [x.id, x.priority]), [["F1", "P1"], ["M1", "P3"]], "serious reads as P1 and minor as P3");
  assert.equal("severity" in f.review().rounds[0]!.verdict!.findings[0]!, false);
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: ["The reviewer still requests changes after 5 rounds, the most this review allows."], label: { state: "added" } });
  assert.deepEqual(f.labelCalls, [humanLabel]);
});

test("a builder that pushes fixes after the last round gets the PR labelled for the person, once across retries", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  legacyReview(f, "fixing");
  await labelsOnceAcrossRetries(f, loop, () => {
    f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
    f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  }, "The builder pushed fixes after round 5, the last this review allows, so they are unreviewed.");
});

test("a token that cannot label tells the person why, and the loop does not try again", async (t) => {
  const f = fixture(t);
  f.labelAnswer = () => ({ kind: "denied", message: "GitHub answered 403: Resource not accessible by personal access token" });
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  const phase = { kind: "needs-person", reasons: [
    "The reviewer still requests changes after 1 rounds, the most this review allows.",
    `Nexus could not add the label "needs human review" to pull request #7 (GitHub answered 403: Resource not accessible by personal access token). Labelling needs a token that may write issues or pull requests, which only the person can grant.`,
  ], label: { state: "failed", why: "GitHub answered 403: Resource not accessible by personal access token" } };
  assert.deepEqual(f.review().phase, phase);
  assert.deepEqual(f.registry.events("0", { kinds: ["review.changed"] }).at(-1)!.payload.phase, phase, "the event log says the label could not be added");
  await loop.poll();
  await loop.poll();
  assert.equal(f.labelCalls.length, 1);
  assert.deepEqual(f.labels, new Set());
});

test("an approval with only P3 findings goes straight to the check, sending the builder its notes with nothing to answer", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { findings: [{ id: "N1", priority: "P3", where: "src/cache.ts:1", summary: "Name the constant" }] }));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.equal(f.review().rounds.length, 1);
  const toBuilder = f.sent.filter((s) => s.to === f.builder).map((s) => s.message.text);
  assert.equal(toBuilder.length, 1);
  assert.ok(toBuilder[0]!.startsWith(reviewPrefix));
  assert.match(toBuilder[0]!, new RegExp(`approved pull request #7 \\(.*\\) at ${head1} in round 1`));
  assert.match(toBuilder[0]!, /N1 \(P3\) src\/cache\.ts:1: Name the constant/);
  assert.match(toBuilder[0]!, /Do not push to this pull request's branch/);
  assert.doesNotMatch(toBuilder[0]!, /nexus-review-answers/);
  assert.deepEqual(f.registry.events("0", { kinds: ["review.changed"] }).map((e) => (e.payload.phase as { kind: string }).kind), ["reviewing", "checking", "approved"], "no fixing round");
});

test("the findings decide the verdict: changes with only P3 findings is an approval, and an approval with a P2 finding requests changes", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [{ id: "N1", priority: "P3", summary: "Name the constant" }] }));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });

  const g = fixture(t);
  const other = g.loop();
  await other.start(g.builder, { land: null });
  await other.poll();
  g.reply(g.review().reviewer, verdict(g.review(), { findings: [{ id: "T1", priority: "P2", summary: "No test for the expiry" }] }));
  await other.poll();
  assert.equal(g.review().phase.kind, "fixing");
  assert.equal(g.review().rounds[0]!.verdict!.verdict, "changes");
});

test("a check that fails again at an earlier head in the last round still gets the PR labelled", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "1 test failed" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 3 });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "fixed", reason: "Fixed the test." }]));
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head1 } };
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Reverted to the first head." }]));
  await loop.poll();
  assert.equal(f.review().rounds.length, 3);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", label: { state: "added" }, reasons: [
    `.nexus/check failed at ${head1} after the last round this review allows.`, `.nexus/check failed again at ${head1}, where it failed before.`, "The check's output:\n1 test failed",
  ] });
  assert.deepEqual([...f.labels], ["needs human review"]);
});

test("a reviewer's verdict in the old severity shape still reads: serious blocks as P1, minor is a P3 note", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [{ id: "F1", severity: "serious", summary: "The cache never expires" }, { id: "M1", severity: "minor", summary: "Name the constant" }] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  const text = f.sent.at(-1)!.message.text;
  assert.match(text, /F1 \(P1\): The cache never expires\n/);
  assert.match(text, /These P3 notes do not block and need no answer[^\n]*\n\nM1 \(P3\): Name the constant/);
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "the P3 note needs no answer");
});

test("a PR merged or closed outside a review that does not land ends it quietly, with no check, round, label or decision", async (t) => {
  const f = fixture(t);
  f.check = { kind: "running" };
  await approved(f, null);
  assert.equal(f.review().phase.kind, "checking");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, mergeCommit: merged } };
  f.check = { kind: "unrunnable", output: "The check pylon did not boot: Setup exited 128" };
  await f.loop().poll();
  assert.deepEqual(f.review().phase, { kind: "merged" }, "a check the merge broke is not the person's");
  assert.deepEqual(f.discarded, f.checkThreads);
  assert.deepEqual(f.labelCalls, []);
  assert.ok(!f.attention().includes("decision"));
  assert.equal(f.sent.length, 1);

  const g = fixture(t);
  const loop = g.loop();
  await loop.start(g.builder, { land: null });
  await loop.poll();
  g.snapshot = { ...g.snapshot, pr: { ...g.snapshot.pr, state: "merged" }, detail: { ...g.snapshot.detail, mergeCommit: merged } };
  g.reply(g.review().reviewer, verdict(g.review(), {}));
  await loop.poll();
  assert.deepEqual(g.review().phase, { kind: "merged" }, "GitHub is read before a check starts, ahead of the PR watch");
  assert.deepEqual(g.checkThreads, []);

  const h = fixture(t);
  const silent = h.loop();
  await silent.start(h.builder, { land: null });
  await silent.poll();
  h.watched("closed");
  h.reply(h.review().reviewer, "I looked and it seems fine.");
  await silent.poll();
  assert.deepEqual(h.review().phase, { kind: "closed" }, "the PR watch's state ends it before the reviewer is reminded");
  assert.equal(h.sent.length, 1);
  assert.ok(!h.attention().includes("decision"));
  h.tick(4 * 60 * 60_000);
  await silent.poll();
  assert.deepEqual(h.review().phase, { kind: "closed" });

  const i = fixture(t);
  const fixing = i.loop();
  await fixing.start(i.builder, { land: null });
  await fixing.poll();
  i.reply(i.review().reviewer, verdict(i.review(), { verdict: "changes", findings: [serious] }));
  await fixing.poll();
  i.snapshot = { ...i.snapshot, pr: { ...i.snapshot.pr, state: "closed" } };
  i.reply(i.builder, answers(i.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  await fixing.poll();
  assert.deepEqual(i.review().phase, { kind: "closed" });
  assert.equal(i.sent.length, 2, "the reviewer gets no next round");
});

test("a review that lands still sees a merge made outside it through, and a real failure while the PR is open still asks the person", async (t) => {
  const f = fixture(t);
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  f.check = { kind: "running" };
  await approved(f, "nLAPTOP");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, mergeCommit: merged } };
  f.watched("merged");
  f.check = { kind: "done", passed: true, output: "ok" };
  await f.loop().poll();
  assert.equal(f.review().phase.kind, "deploying", "the landing decides whether the merge deploys");

  const g = fixture(t);
  const silent = g.loop();
  await silent.start(g.builder, { land: null });
  await silent.poll();
  g.tick(4 * 60 * 60_000);
  await silent.poll();
  assert.deepEqual(g.review().phase, { kind: "needs-person", reasons: ["The reviewer gave no answer Nexus could read within 3 hours in round 1."] });
  assert.equal(g.attention().at(-1), "decision");
});

test("a builder or reviewer thread the person archives or deletes cancels the review, with no label or decision", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  archive(f.registry, f.review().reviewer);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "cancelled", who: "reviewer", status: "archived" });
  assert.deepEqual(f.labelCalls, []);
  assert.ok(!f.attention().includes("decision"));
  const restarted = await loop.start(f.builder, { land: null });
  assert.equal(restarted.phase.kind, "reviewing", "a cancelled review makes way for a new one");

  const g = fixture(t);
  const fixing = g.loop();
  await fixing.start(g.builder, { land: null });
  await fixing.poll();
  g.reply(g.review().reviewer, verdict(g.review(), { verdict: "changes", findings: [serious] }));
  await fixing.poll();
  g.registry.setThreadStatus(g.builder, "deleted");
  await fixing.poll();
  assert.deepEqual(g.review().phase, { kind: "cancelled", who: "builder", status: "deleted" });

  const h = fixture(t);
  h.check = { kind: "running" };
  await approved(h, null);
  assert.equal(h.review().phase.kind, "checking");
  archive(h.registry, h.review().reviewer);
  await h.loop().poll();
  assert.equal(h.review().phase.kind, "cancelled");
  assert.deepEqual(h.discarded, h.checkThreads, "its check thread goes with it");
});

test("a message that waits to be delivered is not sent once the PR merged, and a PR closed before the landing merges ends closed", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.delivery = "later";
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().outbox?.to, "builder");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, mergeCommit: merged } };
  f.delivery = "delivered";
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "merged" });
  assert.equal(f.sent.length, 1, "the builder never gets the findings");

  const g = fixture(t);
  g.check = { kind: "running" };
  await approved(g, "nLAPTOP");
  g.snapshot = { ...g.snapshot, pr: { ...g.snapshot.pr, state: "closed" } };
  g.watched("closed");
  g.check = { kind: "done", passed: true, output: "ok" };
  await g.loop().poll();
  assert.deepEqual(g.review().phase, { kind: "closed" });
  assert.deepEqual(g.merges, []);
  assert.ok(!g.attention().includes("decision"));
});

test("a check that passes after the PR merged or closed, before the PR watch saw it, ends the review merged or closed, not approved", async (t) => {
  for (const state of ["merged", "closed"] as const) {
    const f = fixture(t);
    f.check = { kind: "running" };
    await approved(f, null);
    assert.equal(f.review().phase.kind, "checking");
    f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state }, detail: { ...f.snapshot.detail, mergeCommit: state === "merged" ? merged : null } };
    f.check = { kind: "done", passed: true, output: "ok" };
    await f.loop().poll();
    assert.deepEqual(f.review().phase, { kind: state });
    assert.deepEqual(f.discarded, f.checkThreads, "the check thread is still thrown away");
  }
});

const conflicting = (f: ReturnType<typeof fixture>) => { f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, conflict: true } }; };
const rebased = (f: ReturnType<typeof fixture>) => { f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, conflict: false }, detail: { ...f.snapshot.detail, head: head2 } }; };

test("a builder's PR in a project that lands on its own is reviewed with no command and lands for whoever turned it on", async (t) => {
  const f = fixture(t, { autoReview: { land: true, enabledBy: "nLAPTOP" } });
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  const loop = f.loop();
  await loop.auto(f.registry.thread(f.builder)!, f.pr);
  assert.equal(f.review().auto, true);
  assert.deepEqual(f.review().land, { requestedBy: "nLAPTOP", fromProject: true });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.review().phase.kind, "deploying");
  assert.equal(f.registry.desiredRelease()?.commit, merged);
});

test("nothing starts on its own without the project's setting, for a thread the loop started, or twice for one PR", async (t) => {
  const off = fixture(t);
  await off.loop().auto(off.registry.thread(off.builder)!, off.pr);
  assert.equal(off.registry.review(off.builder), null, "a project without the setting");

  const f = fixture(t, { path: join(await mkdtemp(join(tmpdir(), "nexus-review-")), "registry.db"), autoReview: { land: false, enabledBy: "nPHONE" } });
  const loop = f.loop();
  for (const [id, by] of [["th-reviewing", reviewerCaller], ["th-checking", checkCaller]] as const) {
    await loop.auto(f.registry.thread(f.add(id, true, by))!, f.pr);
    assert.equal(f.registry.review(id as ThreadId), null, `a thread started by ${by}`);
  }
  await loop.auto(f.registry.thread(f.builder)!, f.pr);
  assert.equal(f.review().land, null, "a project that only reviews stops at approval");
  const first = f.review().id;
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "approved");
  await loop.auto(f.registry.thread(f.builder)!, f.pr);
  assert.equal(f.review().id, first, "a review that ended stays ended");
  assert.equal(f.started.length, 1);
  const again = await loop.start(f.builder, { land: null });
  assert.notEqual(again.id, first, "the person can still start one");
  assert.equal(again.auto, false);
});

test("a branch that conflicts at landing goes back to the builder to rebase, and the rebased head is reviewed again, then lands", async (t) => {
  const f = fixture(t);
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  conflicting(f);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, [], "a conflicting branch does not merge");
  assert.equal(f.review().phase.kind, "fixing");
  assert.deepEqual(f.review().rounds[0]!.conflict, { base: "main" });
  const request = f.sent.at(-1)!;
  assert.equal(request.to, f.builder);
  assert.match(request.message.text, /the reviewer approved, but the branch conflicts with main, so it cannot merge/);
  assert.match(request.message.text, /CONFLICT \(P0\) origin\/main: The branch conflicts with main/);
  assert.match(request.message.text, /git rebase origin\/main/);
  assert.match(request.message.text, /git push --force-with-lease/);

  rebased(f);
  f.reply(f.builder, answers(f.review(), [{ id: "CONFLICT", action: "fixed", reason: "Rebased onto main, kept both sides' cache settings, the tests pass." }]));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.equal(f.review().rounds[1]!.head, head2, "the rebased head is a new round");
  assert.match(f.sent.at(-1)!.message.text, /CONFLICT: fixed\. Rebased onto main/);
  assert.match(f.sent.at(-1)!.message.text, new RegExp(`git diff origin/main\\.\\.\\.${head2}\\n  git range-diff origin/main ${head1} ${head2}`));
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, [head2]);
  assert.equal(f.review().phase.kind, "deploying");
});

test("a builder that cannot rebase, or a conflict after the last round, goes to the person with why", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  conflicting(f);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  f.reply(f.builder, answers(f.review(), [{ id: "CONFLICT", action: "rejected", reason: "main rewrote the cache this PR adds, so one side has to go." }]));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: ["The branch conflicts with main, and the builder did not rebase it: main rewrote the cache this PR adds, so one side has to go."] });

  const last = fixture(t, { path: join(await mkdtemp(join(tmpdir(), "nexus-review-")), "registry.db") });
  const capped = last.loop();
  await capped.start(last.builder, { land: "nLAPTOP", rounds: 1 });
  await capped.poll();
  conflicting(last);
  last.reply(last.review().reviewer, verdict(last.review(), {}));
  await capped.poll();
  assert.deepEqual(last.review().phase, { kind: "needs-person", label: { state: "added" }, reasons: ["The branch conflicts with main, and round 1 was the last this review allows, so a rebase could not be reviewed."] });
  assert.deepEqual(last.sent.filter((s) => s.to === last.builder), [], "the builder is not asked for a rebase no round can review");
});

test("a merge GitHub refuses for a conflict it only now reports goes to the builder to rebase", async (t) => {
  const f = fixture(t);
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, conflict: null } };
  f.mergeAnswer = () => { conflicting(f); return { kind: "refused", message: "GitHub answered 405: Pull Request is not mergeable" }; };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.review().phase.kind, "fixing");
  assert.match(f.sent.at(-1)!.message.text, /git rebase origin\/main/);
});

test("a head pushed after the approval gets its own round instead of the person", async (t) => {
  const f = fixture(t);
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  rebased(f);
  f.check = { kind: "done", passed: true, output: "ok" };
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().phase.kind, "reviewing");
  assert.equal(f.review().rounds[1]!.head, head2);
  assert.match(f.sent.at(-1)!.message.text, new RegExp(`New commits were pushed to the branch after you approved ${head1}`));
});

test("each landing asks again whether its lander may deploy, and whether the project still lands on its own", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.deployers.delete("nLAPTOP");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: ["nLAPTOP, who asked for this landing, is not among the control plane's deployers, so only the person can land it."] });

  const auto = fixture(t, { path: join(await mkdtemp(join(tmpdir(), "nexus-review-")), "registry.db"), autoReview: { land: true, enabledBy: "nLAPTOP" } });
  const own = auto.loop();
  await own.auto(auto.registry.thread(auto.builder)!, auto.pr);
  await own.poll();
  auto.registry.editProject("nexus" as ProjectId, ({ autoReview: _, ...p }) => p);
  auto.reply(auto.review().reviewer, verdict(auto.review(), {}));
  await own.poll();
  assert.deepEqual(auto.merges, []);
  assert.deepEqual(auto.review().phase, { kind: "needs-person", reasons: ["Project nexus no longer lands its builders' pull requests on its own, so this one is the person's to land."] });
});

test("a review held for the person ends once the person closes its PR or archives or deletes its builder, and asks nothing more", async (t) => {
  for (const [how, ending] of [
    ["closed", { kind: "closed" }],
    ["archived", { kind: "cancelled", who: "builder", status: "archived" }],
    ["deleted", { kind: "cancelled", who: "builder", status: "deleted" }],
  ] as const) {
    const f = fixture(t);
    const loop = f.loop();
    await loop.start(f.builder, { land: null, rounds: 1 });
    await loop.poll();
    f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
    await loop.poll();
    assert.equal(f.review().phase.kind, "needs-person");
    assert.equal(f.attention().at(-1), "decision");
    if (how === "closed") f.watched("closed");
    else f.registry.setThreadStatus(f.builder, how);
    await loop.poll();
    assert.deepEqual(f.review().phase, ending, `a held review whose ${how === "closed" ? "PR was closed" : `builder was ${how}`}`);
    assert.notEqual(f.attention().at(-1), "decision", "the builder no longer needs a decision");
  }
});

test("a held review ends before its label is retried, and one whose PR watch stopped asks GitHub whether its PR closed", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  f.labelAnswer = () => { throw new Error("GitHub is down"); };
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.deepEqual((f.review().phase as { label?: unknown }).label, { state: "adding" });
  archive(f.registry, f.builder);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "cancelled", who: "builder", status: "archived" });

  const g = fixture(t);
  const held = g.loop();
  await held.start(g.builder, { land: null, rounds: 1 });
  await held.poll();
  g.reply(g.review().reviewer, verdict(g.review(), { verdict: "changes", findings: [serious] }));
  await held.poll();
  g.registry.savePrWatch(g.builder, { ...g.registry.prWatch(g.builder)!, commentWakes: 10 });
  g.snapshot = { ...g.snapshot, pr: { ...g.snapshot.pr, state: "closed" } };
  await held.poll();
  assert.deepEqual(g.review().phase, { kind: "closed" });
});

test("a PR that another thread on its branch has a review of gets none on its own", async (t) => {
  const f = fixture(t, { autoReview: { land: false, enabledBy: "nLAPTOP" } });
  const loop = f.loop();
  await loop.auto(f.registry.thread(f.builder)!, f.pr);
  await loop.auto(f.registry.thread(f.add("th-twin", true))!, f.pr);
  assert.equal(f.registry.review("th-twin" as ThreadId), null);
  assert.equal(f.started.length, 1);
});

test("a PR stays reviewed once its builder's record moves on to a review of another PR", async (t) => {
  const f = fixture(t, { autoReview: { land: false, enabledBy: "nLAPTOP" } });
  const loop = f.loop();
  await loop.auto(f.registry.thread(f.builder)!, f.pr);
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "approved");
  f.registry.saveReview({ ...f.review(), id: "rv-next", pr: { ...f.review().pr, number: f.pr.number + 1 }, phase: { kind: "reviewing" } });
  await loop.auto(f.registry.thread(f.add("th-twin", true))!, f.pr);
  assert.equal(f.registry.review("th-twin" as ThreadId), null, "the twin's link of the first PR starts nothing");
  assert.equal(f.started.length, 1);
});

const reservedHolds = [
  "Always needs the person: anything irreversible, as it changes src/control/registry.ts.",
];

test("a held reserved path holds again when landed, and lands once the person waives it at the approved head", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/registry.ts", previous: null, patch: "@@ -240,3 +240,4 @@ const migrations: readonly string[] = [\n+  `CREATE TABLE x (a TEXT) STRICT;`," }];
  const loop = await approved(f, "nLAPTOP");
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: reservedHolds });
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: reservedHolds }, "landing again meets the same hold");
  assert.deepEqual(f.merges, []);

  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.review().phase.kind, "deploying");
  const { at, ...waiver } = f.review().waiver!;
  assert.deepEqual(waiver, { head: head1, holds: reservedHolds, by: "nLAPTOP" }, "the review records who waived which holds, at which commit");
  assert.equal(typeof at, "number");
  assert.deepEqual(f.registry.events("0", { kinds: ["review.waived"], thread: f.builder }).map((e) => e.payload), [{ review: f.review().id, repo: "ramtinJ95/nexus", pr: 7, ...waiver, at }]);
  for (const role of ["control", "probe"] as const) f.registry.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
});

test("a waiver lets the landing past only the holds it names, and only at the commit it names", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/registry.ts", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head2, reservedHolds), { status: 409, message: new RegExp(`is at ${head1}, not ${head2}`) });
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1, ["The pull request's GitHub checks are pending."]), { status: 409, message: /not held by/ });

  const image = "Always needs the person: pylon image rebuilds, as it changes images/pylon/Dockerfile.";
  f.files = [{ path: "src/control/registry.ts", previous: null, patch: "" }, { path: "images/pylon/Dockerfile", previous: null, patch: "" }];
  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [...reservedHolds, image] },
    "a hold the waiver did not name still holds, and the person sees every hold again, those waived too, to confirm them together");

  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, checks: "failed" } };
  loop.land(f.builder, "nLAPTOP", head1, [...reservedHolds, image]);
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: ["The pull request's GitHub checks are failed.", ...reservedHolds, image] }, "a waiver never waives failing checks");
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1, ["The pull request's GitHub checks are failed."]), { status: 409, message: /cannot be waived/ });

  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, checks: "passing" } };
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.equal(f.review().waiver, null, "a landing that names no holds waives nothing");
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [...reservedHolds, image] });

  loop.land(f.builder, "nLAPTOP", head1, [...reservedHolds, image]);
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "confirming every hold the card shows lands it");
});

test("a Claude reviewer's approval is not waivable, and a change to .nexus/check is", async (t) => {
  const f = fixture(t, { claudeBuilder: false, secrets: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }] });
  const loop = await approved(f, "nLAPTOP");
  const [claude] = (f.review().phase as { reasons: string[] }).reasons;
  assert.match(claude!, /A Claude reviewer approved it/);
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1, [claude!]), { status: 409, message: /cannot be waived/ });

  const g = fixture(t, { path: ":memory:" });
  g.files = [{ path: ".nexus/check", previous: null, patch: "" }];
  const gLoop = await approved(g, "nLAPTOP");
  const holds = (g.review().phase as { reasons: string[] }).reasons;
  assert.deepEqual(holds, ["The pull request changes .nexus/check, the check this policy relies on."]);
  gLoop.land(g.builder, "nLAPTOP", head1, holds);
  await gLoop.poll();
  assert.deepEqual(g.merges, [head1]);
});

test("the person may waive the reserved cases, the reserved paths and a changed .nexus/check, and nothing else the policy holds for", () => {
  const waivable = [
    "Always needs the person: changes to secrets, by the reviewer's reading (rotates the token).",
    "Always needs the person: changes to login or auth, as it changes src/control/api.ts.",
    "The pull request changes .nexus/check, the check this policy relies on.",
    "The pull request changes .nexus/verify, the live check this policy relies on.",
  ];
  const never = [
    "Findings P0 to P2 are open: F1.",
    "The reviewer has not approved the latest commits.",
    "The builder neither fixed nor rejected with a reason finding F1 of round 1.",
    `.nexus/check failed at ${head1}.`,
    `.nexus/check has not run at ${head1}.`,
    "The pull request's GitHub checks are failed.",
    "The pull request's GitHub checks are pending.",
    `The pull request's head is ${head2}, not the approved ${head1}.`,
    "The branch conflicts with its base.",
    "Pull request #7 is closed.",
    "A Claude reviewer approved it. Its verdict is read from its transcript in its pylon, where code it runs could write, so only the person can land what it approved.",
    "The reviewer ran the builder's own model, gpt-6-astra.",
    "No live check ran, and the pull request does not say what could not be checked live.",
    "GitHub refused the merge: Base branch was modified.",
    `The live check failed at ${head1}.`,
    `The live check gave no verdict within 60 minutes at ${head1}.`,
  ];
  for (const reason of waivable) assert.equal(holdRule(reason).waivable, true, reason);
  for (const reason of never) {
    assert.equal(holdRule(reason).waivable, false, reason);
    assert.notEqual(holdRule(reason).why, "", reason);
  }
  assert.match(holdRule(never[10]!).why, /stands in for a harness reviewer's approval/);
});

test("a waived landing whose branch conflicts goes back to the builder to rebase, and the rebased head needs the person's waiver again", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/registry.ts", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  conflicting(f);
  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().phase.kind, "fixing", "the conflict is the only hold the waiver does not get past, so the builder rebases");

  rebased(f);
  f.reply(f.builder, answers(f.review(), [{ id: "CONFLICT", action: "fixed", reason: "Rebased onto main." }]));
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: reservedHolds }, "the waiver was for the head before the rebase");
});

test("a harness, a Claude worker and a bare thread each give the replies and take the messages of their kind", async (t) => {
  const f = fixture(t, { claudeBuilder: false });
  const fake = fakeHarness();
  const harness = f.registry.thread(f.builder)!;
  await fake.harness.startThread({ threadId: harness.id, pylonId: harness.pylonId });
  fake.transcript(harness.id).messages.push(
    { role: "user", content: "fix it", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Fixed" }, { type: "thinking", thinking: "no" }, { type: "text", text: " it." }], timestamp: 2 } as never,
  );
  const claude = f.registry.thread(f.add("th-claude", true))!;
  f.registry.setClaudeWorker(claude.id, "fix it", "started", undefined, "s1");
  f.registry.appendClaudeRead(claude.id, { session: "s1", from: transcriptStart, entries: [{ kind: "prompt", at: 1, text: "fix it", from: "person" }, { kind: "reply", at: 2, text: "Done." }], cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: 3 });
  const bare = f.registry.thread(f.add("th-check-bare", false, checkCaller, true))!;

  const replies = agentReplies(f.registry, fake.harness);
  assert.deepEqual(await replies(harness), ["Fixed it."]);
  assert.deepEqual(await replies(claude), ["Done."], "a Claude worker's replies are its transcript's, and never reach the harness");
  await assert.rejects(replies(bare), "a bare thread has no replies to read");
  assert.ok(!fake.calls.some(([, id]) => id === claude.id), "nothing of a Claude worker's reaches the harness");

  const woken: ThreadId[] = [];
  const inbox = agentInbox({ registry: f.registry, harness: fake.harness, probes: new Map(), wake: (th) => { woken.push(th.id); } });
  const message = { id: "rv-1:1", text: "Review this", sender: "review" as const };
  assert.equal(await inbox(harness, message), "delivered");
  assert.deepEqual(fake.calls.at(-1), ["send", harness.id, "Review this", "rv-1:1", "followUp", "review"]);
  assert.equal(await inbox(claude, message), "later", "a Claude worker whose pylon does not run takes it later");
  await assert.rejects(inbox(bare, message), "a bare thread takes no message");
  assert.deepEqual(woken, [harness.id, claude.id], "a message a bare thread refused wakes nothing");
  assert.ok(f.registry.thread(claude.id)!.lastAgentActivityAt > 0);
});

/** A push of `head` to the PR's branch, as GitHub and then the PR watch's next read see it. */
const pushed = (f: ReturnType<typeof fixture>, head: string) => {
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, conflict: false }, detail: { ...f.snapshot.detail, head } };
  f.registry.savePrWatch(f.builder, { ...f.registry.prWatch(f.builder)!, links: [{ pr: { ...f.pr, head }, seen: [], failed: false }] });
};

test("a landing held for the person reviews a head pushed after the hold in a new round, and holds again there without the old head's waiver", async (t) => {
  const f = fixture(t);
  const image = "Always needs the person: pylon image rebuilds, as it changes images/pylon/Dockerfile.";
  f.files = [{ path: "src/control/registry.ts", previous: null, patch: "" }, { path: "images/pylon/Dockerfile", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [...reservedHolds, image] });
  pushed(f, head1);
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person", "a read of the same head changes nothing");

  f.files = [{ path: "src/control/registry.ts", previous: null, patch: "" }];
  pushed(f, head2);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.deepEqual(f.review().rounds.map((round) => round.head), [head1, head2]);
  const request = f.sent.at(-1)!;
  assert.equal(request.to, f.review().reviewer);
  assert.match(request.message.text, new RegExp(`New commits were pushed to the branch after you approved ${head1}\\.`));
  assert.match(request.message.text, new RegExp(`git range-diff origin/main ${head1} ${head2}`));

  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().rounds[1]!.check, { passed: true, output: "ok" }, "the check runs at the new head");
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: reservedHolds }, "the waiver named the head before the push");
  await loop.poll();
  assert.equal(f.review().rounds.length, 2);
  loop.land(f.builder, "nLAPTOP", head2, reservedHolds);
  await loop.poll();
  assert.deepEqual(f.merges, [head2]);
});

test("a review that stopped at approval reviews a head pushed after it in a new round, and stops at approval again", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  assert.deepEqual(f.review().phase, { kind: "approved" });
  pushed(f, head2);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.equal(f.review().rounds[1]!.head, head2);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.deepEqual(f.review().rounds[1]!.check, { passed: true, output: "ok" });
  assert.deepEqual(f.merges, []);
});

test("a held review with no round left, or one held with the reviewer's changes open, names the head pushed after it and starts no round", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/registry.ts", previous: null, patch: "" }];
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP", rounds: 1 });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: reservedHolds });
  pushed(f, head2);
  await loop.poll();
  await loop.poll();
  const phase = f.review().phase as Extract<Review["phase"], { kind: "needs-person" }>;
  assert.equal(phase.kind, "needs-person");
  assert.deepEqual(phase.reasons, [`The pull request's head moved to ${head2} after round 1, the last this review allows, so ${head2} is unreviewed.`]);
  assert.deepEqual(phase.label, { state: "added" });
  assert.deepEqual(f.labelCalls, [humanLabel], "the label is added once");
  assert.equal(f.review().rounds.length, 1);
  assert.equal(f.sent.filter((s) => s.to === f.review().reviewer).length, 1, "the reviewer gets no round");
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1), { status: 409 }, "the old head is no longer offered for landing");

  const g = fixture(t);
  const gave = g.loop();
  await gave.start(g.builder, { land: null });
  await gave.poll();
  g.reply(g.review().reviewer, verdict(g.review(), { verdict: "changes", findings: [serious] }));
  await gave.poll();
  g.reply(g.builder, answers(g.review(), [{ id: "F1", action: "rejected", reason: "" }]));
  await gave.poll();
  g.reply(g.builder, "I think the cache is fine.");
  await gave.poll();
  g.reply(g.builder, "Still fine.");
  await gave.poll();
  const reasons = ["The builder ended 3 turns in a row without an answer Nexus could read, in round 1."];
  assert.deepEqual(g.review().phase, { kind: "needs-person", reasons });
  pushed(g, head2);
  await gave.poll();
  await gave.poll();
  assert.deepEqual((g.review().phase as { reasons: string[] }).reasons, [...reasons,
    `The pull request's head moved to ${head2} after this review was held, so none of its rounds reviewed that commit. Run nexus review ${g.builder} to review it.`], "changes the reviewer requested stay the person's");
  assert.equal(g.review().rounds.length, 1);
  assert.deepEqual(g.labelCalls, []);
});

test("a review held after an approval for a conflict the builder did not rebase, or a check it pushed nothing for, reviews a head pushed after the hold", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  conflicting(f);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  f.reply(f.builder, answers(f.review(), [{ id: "CONFLICT", action: "rejected", reason: "I will rebase once main settles." }]));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: ["The branch conflicts with main, and the builder did not rebase it: I will rebase once main settles."] });
  pushed(f, head2);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.deepEqual(f.review().rounds.map((round) => round.head), [head1, head2]);
  assert.equal(f.sent.at(-1)!.to, f.review().reviewer);
  assert.match(f.sent.at(-1)!.message.text, new RegExp(`git range-diff origin/main ${head1} ${head2}`));
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, [head2], "the rebased head lands as the review asked");

  const g = fixture(t);
  g.check = { kind: "done", passed: false, output: "1 test failed" };
  const gave = await approved(g, null);
  g.reply(g.builder, answers(g.review(), [{ id: "CHECK", action: "rejected", reason: "The test is flaky." }]));
  await gave.poll();
  assert.deepEqual(g.review().phase, { kind: "needs-person", reasons: [`.nexus/check failed at ${head1}, and the builder pushed nothing for it: The test is flaky.`, "The check's output:\n1 test failed"] });
  g.check = { kind: "done", passed: true, output: "ok" };
  pushed(g, head2);
  await gave.poll();
  assert.equal(g.review().phase.kind, "reviewing");
  g.reply(g.review().reviewer, verdict(g.review(), {}));
  await gave.poll();
  assert.deepEqual(g.review().phase, { kind: "approved" });
  assert.deepEqual(g.review().rounds[1]!.check, { passed: true, output: "ok" }, "the check runs at the new head");
});

test("a review that merged and is held over its deploy stays as it is whatever the PR watch reads", async (t) => {
  const f = fixture(t);
  f.registry.setDesiredRelease({ commit: previous, requestedBy: "person", requestedAt: 1 });
  const loop = await approved(f, "nLAPTOP");
  f.registry.reportRelease({ node, role: "control", commit: previous, target: merged, state: "failed", reason: "unit failed", observedAt: Date.now() });
  await loop.poll();
  for (const role of ["control", "probe"] as const) f.registry.reportRelease({ node, role, commit: previous, target: previous, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  const held = f.review();
  assert.equal(held.phase.kind, "needs-person");
  assert.equal(held.merged, merged);
  pushed(f, head2);
  await loop.poll();
  assert.deepEqual(f.review(), held);
});

test("a held review settles on the head GitHub reports when the PR watch read an older push, and still gets its label", async (t) => {
  const f = fixture(t);
  const head3 = "3".repeat(40);
  f.files = [{ path: "src/control/registry.ts", previous: null, patch: "" }];
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP", rounds: 1 });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  pushed(f, head2);
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head3 } };
  await loop.poll();
  const settled = f.review();
  assert.deepEqual((settled.phase as { reasons: string[] }).reasons, [`The pull request's head moved to ${head3} after round 1, the last this review allows, so ${head3} is unreviewed.`]);
  assert.deepEqual((settled.phase as { label?: unknown }).label, { state: "added" }, "the label is added while the watch still reads the older push");
  await loop.poll();
  assert.deepEqual(f.review(), settled);
});

test("a review that stopped at approval under a stopped PR watch waits for its landing, which reviews the moved head", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  pushed(f, head2);
  f.registry.savePrWatch(f.builder, { ...f.registry.prWatch(f.builder)!, commentWakes: 10 });
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" }, "a stopped watch's head is not current, so nothing reads it");
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.equal(f.review().rounds[1]!.head, head2);
  assert.deepEqual(f.merges, []);
});

test("a force-push back to a head an earlier round reviewed gets a new round", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/registry.ts", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  pushed(f, head2);
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: reservedHolds });
  pushed(f, head1);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.deepEqual(f.review().rounds.map((round) => round.head), [head1, head2, head1]);
});
