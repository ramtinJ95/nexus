import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { join } from "node:path";
import { openRegistry, type Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import type { NodeName, PylonId, TailnetNodeId, ThreadId } from "../ids.ts";
import type { AutoReview, SecondReview } from "./project.ts";
import type { ProjectId } from "../ids.ts";
import type { SecretGrant } from "../protocol/secret-grants.ts";
import type { ChangedFile, LabelResult, MergeResult, PrSnapshot } from "./github.ts";
import type { AutomatedMessage } from "./inbox.ts";
import { holdRule, personOnly, type Hold, type HoldCode } from "./holds.ts";
import { reservedNames } from "../contract/reserved.ts";
import { carryWaiver, headHolds, holdsAt, landPress, secondReviewRule } from "./policy.ts";
import { landing } from "./dashboard/cards.ts";
import { checkBeside, liveNote, phaseNote, reviewSaid, roundNote } from "./wording.ts";
import { cannotLand, changeOf, ended, findingsOf, humanLabel, landable, personPhase, roundsSpent, type HoldCause, type Review, type Verdict, type Waiver } from "./review-model.ts";
import { reviewerFor, reviewLoop, secondReviewerFor, type ReviewDeps } from "./review.ts";
import { upgradeReview } from "./record-upgrade.ts";
import { reviewView } from "./review-view.ts";
import { defaultSecondReview } from "../contract/projects.ts";
import { agentReader, heard } from "./agent-conversation.ts";
import { agentInbox } from "./inbox.ts";
import { claudeConversations } from "./claude-conversation.ts";
import { processStream } from "../process-stream.ts";
import { claudeHook, claudeProjects } from "../../images/pylon/nexus-contract.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { fakeHarness } from "../test-support/fake-harness.ts";
import { parseRecord, transcriptStart, type ClaudeEntry } from "./claude-transcript.ts";
import { runningPylon, tempDir, until, watch } from "../test-support/kit.ts";
import { testPr, testPylon, testReview, testThread, claudeWorkerAt, observeNode, storedTranscripts } from "../test-support/registry-kit.ts";
import { checkCaller, reviewerCaller, senders, verifyCaller } from "./agent-protocol.ts";
import { desiredPhase, idlePolicy } from "./reconcile.ts";
import type { CheckState } from "./gate.ts";
import type { Start, StartRequest } from "./start-request.ts";
import { Refusal } from "./refusal.ts";

/** The lines the API words a review in. */
const reviewSaidText = (r: Review) => reviewSaid(r).join("\n");

const node = "node" as NodeName;
const self = "nCONTROL" as TailnetNodeId;
const head1 = "1".repeat(40);
const head2 = "2".repeat(40);
const merged = "m".repeat(40);
// One directory for the file, so each test's registry is closed before it is removed.
const registries = await tempDir("nexus-review-");
const tempDb = () => join(registries, `${randomUUID()}.db`);
const previous = "p".repeat(40);

/** `agentState` replaces the fake that reads replies and model failures from the fixture's maps. */
function fixture(t: import("node:test").TestContext, options: { path?: string; repo?: string; secrets?: SecretGrant[]; claudeBuilder?: boolean; autoReview?: AutoReview; secondReview?: SecondReview; agentState?: (registry: Registry) => ReviewDeps["agentState"]; personWrote?: (registry: Registry) => ReviewDeps["personWrote"] } = {}) {
  const registry = openRegistry(options.path ?? ":memory:");
  t.after(() => { try { registry.close(); } catch { /* closed by a restart */ } });
  const repo = options.repo ?? "ramtinJ95/nexus";
  const project = { id: "nexus" as ProjectId, repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: options.secrets ?? [], logins: [], preSetup: null, autoReview: options.autoReview ?? null, ...options.secondReview && { secondReview: options.secondReview } };
  if (registry.projects.project(project.id) === undefined) {
    registry.nodes.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: self });
    registry.projects.createProject(project);
  }
  /** A Claude worker thread, a harness thread, or with `bare` one with neither agent. */
  function add(id: string, claude: boolean, startedBy = "test", bare = false): ThreadId {
    if (registry.threads.thread(id as ThreadId) !== undefined) return id as ThreadId;
    const thread = testThread({ id: id as ThreadId, title: id, project: project.id, conversationId: claude || bare ? null : "1", startedBy, createdAt: 1, lastHumanActivityAt: 1 });
    const pylon = testPylon(thread, { node, boot: { repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "feature", commit: "origin/feature" } }, dotfiles: { repo: project.repoUrl, ref: "main" } }, liveHash: "hash" });
    registry.threads.createThread(thread, pylon, claude ? { claude: { prompt: "fix it", model: "claude-opus-5-5" } } : {});
    return thread.id;
  }
  const builder = add("th-builder", options.claudeBuilder ?? true);
  const pr = testPr({ repo, number: 7, title: "Add the cache" });
  registry.prWatches.savePrWatch(builder, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });

  let clock = 1_000_000;
  const replies = new Map<ThreadId, string[]>();
  const failures = new Map<ThreadId, string>();
  const sent: { to: ThreadId; message: AutomatedMessage }[] = [];
  const started: Start[] = [];
  let snapshot: PrSnapshot = { pr: { ...pr }, detail: { head: head1, branch: "feature", base: "main", body: "Adds a cache.\n\nNot checked live: the cache under real traffic.", mergeCommit: null }, failures: [], comments: [] };
  let files: ChangedFile[] = [{ path: "src/cache.ts", previous: null, patch: "@@ -0,0 +1 @@\n+export {};" }];
  /** The change at each head against the base, for a test that pins it. */
  const changes = new Map<string, ChangedFile[] | null>();
  /** Other pull requests than #7, by number. */
  const others = new Map<number, PrSnapshot>();
  const read = (n: number) => n === pr.number ? snapshot : others.get(n)!;
  const merges: string[] = [];
  let mergeAnswer: (sha: string) => MergeResult = () => ({ kind: "merged", commit: merged });
  /** The heads the base branch has moved past since, and each update of the branch the loop asked GitHub for, by head. */
  const behind = new Set<string>();
  const updates: string[] = [];
  let updateAnswer: (sha: string) => boolean = () => true;
  const labels = new Set<string>();
  const labelCalls: string[] = [];
  let labelAnswer: (name: string) => LabelResult = (name) => { labels.add(name); return { kind: "labelled" }; };
  let check: CheckState = { kind: "done", passed: true, output: "ok" };
  const checkThreads: ThreadId[] = [];
  const checkHeads: string[] = [];
  /** Check threads whose runs a restart lost, which the gate then reports as giving no verdict. */
  const forgotten = new Set<ThreadId>();
  let checkStartFails = false;
  /** Why every check start is refused, or null while none is. */
  let checkRefused: string | null = null;
  /** Whether a node has room for a check that asks for it, and whether each check start and poll asked for room or opened a run. */
  let checkRoom = true;
  const checkIfRoom: boolean[] = [];
  const steps: ThreadId[] = [];
  const discarded: ThreadId[] = [];
  let verifies = false;
  let live: CheckState = { kind: "done", passed: true, output: "fleet ok" };
  let refuse: string | null = null;
  let liveRoom = true;
  /** How many verify pylon starts fail next other than by a refusal. */
  let liveStartFails = 0;
  /**
   * The memory the node has free, which each pylon a start places takes: 4 GiB for a reviewer or check, which a start
   * beside the builder takes even past what is free unless it asks for room, and 8 GiB for a verify pylon.
   */
  let freeGiB = Infinity;
  /** Each pylon placed, in order, as `<role> of <builder>`. */
  const placed: string[] = [];
  const liveThreads: ThreadId[] = [];
  const archived: ThreadId[] = [];
  let delivery: "delivered" | "later" = "delivered";
  let delivering = 0;
  let held: { entered: () => void; released: Promise<void> } | null = null;
  let heldPoll: { skip: number; entered: () => void; released: Promise<void> } | null = null;
  let polls = 0;
  let onFiles = () => {};
  let onStart = async () => {};
  /** Why the control plane refuses a reviewer thread's start, by the start's model, or null to start it. */
  let refuseStart: (request: StartRequest) => string | null = () => null;
  /** Why a reviewer thread's start fails other than by a refusal, as when the harness is down, by the start's request, or null. */
  let failStart: (request: StartRequest) => string | null = () => null;
  const briefs = new Map<ThreadId, string>();
  const deployers = new Set(["nLAPTOP"]);
  const woken: ThreadId[] = [];
  const logged: string[] = [];
  const loop = () => reviewLoop({
    registry, harnessModel: "gpt-6-astra",
    github: {
      find: async () => [7],
      async poll(_, n) { polls++; if (heldPoll !== null && heldPoll.skip-- <= 0) { heldPoll.entered(); await heldPoll.released; } return structuredClone(read(n)); },
      files: async () => { onFiles(); return files; },
      // Unless a test says otherwise, each head's change is its own, as a push of fixes makes it.
      change: async (_, __, head) => changes.has(head) ? changes.get(head)! : files.map((f) => ({ ...f, patch: f.patch && `${f.patch}\n+// ${head}` })),
      has: async (_, __, path) => path === ".nexus/verify" && verifies,
      behind: async (_, __, head) => behind.has(head),
      async update(_, __, sha) { updates.push(sha); return updateAnswer(sha); },
      async label(_, __, name) { labelCalls.push(name); return labelAnswer(name); },
      async merge(_, n, sha) {
        merges.push(sha);
        const answer = mergeAnswer(sha);
        if (answer.kind === "merged") {
          const s = read(n);
          const next = { ...s, pr: { ...s.pr, state: "merged" as const }, detail: { ...s.detail, mergeCommit: answer.commit } };
          if (n === pr.number) snapshot = next; else others.set(n, next);
        }
        return answer;
      },
    },
    inbox: async (target, message) => { delivering++; if (held !== null) { held.entered(); await held.released; } if (delivery === "delivered") sent.push({ to: target.id, message }); return delivery; },
    agentState: options.agentState?.(registry) ?? (async (target, since) => ({
      ...heard(target, registry.threads.agent(target).kind === "claude" ? registry.threads.claudeEntries(target.id) : null, since),
      replies: replies.get(target.id) ?? [], failure: failures.get(target.id) ?? null,
    })),
    runs: () => ({
      checks: {
        async start(builder, __, head, ifRoom) {
          if (checkStartFails) throw new Error("no node took the check pylon");
          if (checkRefused !== null) return { refused: checkRefused, room: false };
          if (ifRoom && (!checkRoom || freeGiB < 4)) return { refused: "no node has room for this pylon: node is overcommitted", room: true };
          checkIfRoom.push(ifRoom === true);
          freeGiB -= 4;
          placed.push(`check of ${builder.id}`);
          const id = add(`th-check-${checkThreads.length + 1}`, false, checkCaller); checkThreads.push(id); checkHeads.push(head); return { thread: id };
        },
        step: (id) => { steps.push(id); return forgotten.has(id) ? { kind: "void" } : check; },
        result: (id) => forgotten.has(id) || check.kind !== "done" ? null : check,
        discard(id) { discarded.push(id); registry.threads.setThreadStatus(id, "deleted"); },
      },
      live: {
        async start(builder) {
          if (liveStartFails > 0) { liveStartFails--; throw new Error("the harness is unreachable"); }
          if (refuse !== null) return { refused: refuse, room: false };
          if (!liveRoom || freeGiB < 8) return { refused: "no node can run this pylon: node is overcommitted", room: true };
          freeGiB -= 8;
          placed.push(`verify pylon of ${builder.id}`);
          const id = add(`th-verify-${liveThreads.length + 1}`, false, verifyCaller); liveThreads.push(id); return { thread: id };
        },
        step: () => live,
        result: () => live.kind === "done" ? live : null,
        discard(id) { archived.push(id); registry.threads.setThreadStatus(id, "archived"); },
      },
    }),
    release: { self, repo: "ramtinJ95/nexus" },
    mayLand: (caller) => deployers.has(caller),
    wake: (target) => { woken.push(target.id); },
    log: (message) => { logged.push(message); },
    now: () => clock,
    personWrote: options.personWrote?.(registry) ?? agentReader(registry, { async watch() { throw new Error("no harness thread here"); } }, storedTranscripts).personWrote,
    brief: async (target) => { const agent = registry.threads.agent(target); return agent.kind === "claude" ? agent.worker.prompt : briefs.get(target.id) ?? null; },
    async startThread(start) {
      const refused = refuseStart(start.request);
      if (refused !== null) throw new Refusal("conflict", refused);
      const failed = failStart(start.request);
      if (failed !== null) throw new Error(failed);
      started.push(start);
      freeGiB -= 4;
      const id = add(start.id ?? `th-reviewer-${started.length}`, start.request.claude !== undefined, start.caller);
      const number = Number(/#(\d+)/.exec(start.request.title)?.[1]);
      placed.push(`${start.request.title.startsWith("Second") ? "second reviewer" : "reviewer"} of ${registry.reviews.reviews().find((r) => r.pr.number === number)?.builder}`);
      await onStart();
      return registry.threads.thread(id)!;
    },
  });
  const reply = (id: ThreadId, text: string) => {
    failures.delete(id);
    replies.set(id, [...replies.get(id) ?? [], text]);
    clock += 1_000;
    registry.threads.recordReply(id, clock);
    clock += 61_000;
  };
  /** A turn that ended because the agent's model failed with `error`, with no reply. */
  const failedTurn = (id: ThreadId, error: string) => {
    failures.set(id, error);
    clock += 1_000;
    registry.threads.recordReply(id, clock);
    clock += 61_000;
  };
  return {
    registry, builder, pr, loop, add, sent, started, merges, replies, reply, failedTurn, deployers, woken, logged, others,
    get snapshot() { return snapshot; }, set snapshot(s) { snapshot = s; },
    /** How many times the loop has read the PR from GitHub. */
    get polls() { return polls; },
    set files(f: ChangedFile[]) { files = f; },
    changes,
    /** Runs while the loop reads the PR's changed files. */
    set onFiles(hook: () => void) { onFiles = hook; },
    /** Runs once a reviewer thread exists, before startThread returns it. */
    set onStart(hook: () => Promise<void>) { onStart = hook; },
    set refuseStart(why: (request: StartRequest) => string | null) { refuseStart = why; },
    set failStart(why: (request: StartRequest) => string | null) { failStart = why; },
    /** A harness thread's first message. A Claude worker's is its prompt. */
    briefs,
    set mergeAnswer(a: (sha: string) => MergeResult) { mergeAnswer = a; },
    behind, updates, set updateAnswer(a: (sha: string) => boolean) { updateAnswer = a; },
    labels, labelCalls, set labelAnswer(a: (name: string) => LabelResult) { labelAnswer = a; },
    set check(c: CheckState) { check = c; },
    checkThreads, checkHeads, discarded,
    /** A restart: the gate holds no run for any check thread started so far. */
    forgetChecks() { for (const id of checkThreads) forgotten.add(id); },
    set checkStartFails(fails: boolean) { checkStartFails = fails; },
    set checkRefused(why: string | null) { checkRefused = why; },
    set checkRoom(room: boolean) { checkRoom = room; },
    checkIfRoom, steps,
    /** Whether the PR's head has a .nexus/verify, the live check's state, and why no node takes a verify pylon. */
    set verifies(v: boolean) { verifies = v; },
    set live(c: CheckState) { live = c; },
    set refuse(why: string | null) { refuse = why; },
    /** Whether a node has room for a verify pylon. */
    set liveRoom(room: boolean) { liveRoom = room; },
    set freeGiB(gib: number) { freeGiB = gib; },
    set liveStartFails(n: number) { liveStartFails = n; },
    /** Room that frees, as a pylon that pauses gives back. */
    free(gib: number) { freeGiB += gib; },
    placed,
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
    /** Holds every read of the PR from GitHub after the first `skip` until the returned release is called. */
    holdPolls(skip = 0) {
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      heldPoll = { skip, entered: entered.resolve, released: released.promise };
      return { entered: entered.promise, release() { heldPoll = null; released.resolve(); } };
    },
    tick(ms: number) { clock += ms; },
    get now() { return clock; },
    review: () => registry.reviews.review(builder)!,
    watched(state: "open" | "merged" | "closed") { registry.prWatches.savePrWatch(builder, { links: [{ pr: { ...pr, state }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null }); },
    attention: () => registry.threads.events("0", { kinds: ["attention.changed"], thread: builder }).map((e) => e.payload.attention),
    /** The statuses of the builder and of the review's reviewer. */
    statuses: () => [builder, registry.reviews.review(builder)!.reviewer].map((id) => registry.threads.thread(id)!.status),
  };
}

/**
 * A phase as the person reads it: a needs-person phase has one hold per reason, in its order, and shows its reasons,
 * not the loop's cause.
 */
function shown(phase: Review["phase"]) {
  if (phase.kind !== "needs-person") return phase;
  const { holds, cause: _, ...rest } = phase;
  assert.deepEqual(holds.map((h) => h.text), phase.reasons, "one hold per reason, in the same order");
  return rest;
}

/** A read of the Claude builder's transcript that finds `entries`, and the pylon's reports of `kinds` for its session. */
function claudeRead(f: ReturnType<typeof fixture>, entries: ClaudeEntry[], kinds: readonly ("session.turn-started" | "session.heartbeat")[]) {
  const from = f.registry.threads.claudeTranscript(f.builder)?.cursor ?? transcriptStart;
  f.registry.threads.appendClaudeRead(f.builder, { session: "s1", from, entries, cursor: { ...from, offset: from.offset + 1 }, reset: false, readAt: f.now });
  for (const kind of kinds) {
    f.registry.threads.reportSession(node, { sequence: (f.registry.threads.eventReceipt(node) ?? 0) + 1, time: f.now, pylon: "pylon-th-builder" as PylonId, event: { kind, session: "s1", at: f.now } });
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

const archive = (registry: ReturnType<typeof openRegistry>, id: ThreadId) => registry.threads.setThreadStatus(id, "archived");
/** Saves a record in a shape an older control plane wrote, as the registry's upgrade when it opens leaves it. */
const saveOlder = (f: { registry: Registry }, record: unknown) => f.registry.reviews.saveReview(upgradeReview(record as Review));
const verdict = (r: Review, fields: Record<string, unknown>) => `Done.\n\`\`\`nexus-review\n${JSON.stringify({ token: r.expect, verdict: "approve", findings: [], reserved: [], notCheckedLive: "the cache under real traffic", ...fields })}\n\`\`\``;
const answers = (r: Review, list: unknown[]) => `Fixed.\n\`\`\`nexus-review-answers\n${JSON.stringify({ token: r.expect, answers: list })}\n\`\`\``;
const serious = { id: "F1", priority: "P1", where: "src/cache.ts:1", summary: "The cache never expires", detail: "Add a TTL." };

test("a Claude builder's PR gets a harness reviewer, and findings, fixes and new commits go round until it approves", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  const started = await loop.start(f.builder, { land: null });
  assert.deepEqual(started.models, { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, "another model family than the builder's");
  assert.equal(started.maxRounds, 5, "a review runs 5 rounds unless asked for fewer");
  await loop.poll();
  assert.equal(f.started[0]!.request.claude, undefined, "the reviewer is a harness thread");
  assert.equal(f.started[0]!.request.branch, "feature");
  const reviewer = f.review().reviewer;
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.to, reviewer);
  assert.ok(f.sent[0]!.message.text.startsWith(senders.review.prefix));
  assert.match(f.sent[0]!.message.text, new RegExp(`git checkout --detach ${head1}`));
  for (const name of Object.values(reservedNames)) assert.ok(f.sent[0]!.message.text.includes(name), `the reviewer is told that ${name} need the person`);
  assert.match(f.sent[0]!.message.text, /Not checked live: the cache under real traffic/, "the description reaches the reviewer");
  assert.equal(f.sent[0]!.message.sender, "review");
  assert.equal(f.registry.reviews.isReviewer(reviewer), true);

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
  assert.deepEqual(f.registry.threads.events("0", { kinds: ["review.changed"] }).map((e) => [(e.payload.phase as { kind: string }).kind, e.payload.round]),
    [["reviewing", 1], ["fixing", 1], ["reviewing", 2], ["checking", 2], ["approved", 2]]);
  assert.equal(f.registry.threads.thread(f.builder)!.lastHumanActivityAt, 1, "nothing in the loop is human activity");
});

test("a builder's pylon stays up while its reviewer reads a round, so its findings need no wake, and never while the review waits on the person", async (t) => {
  // The registry reads the real clock, so the fixture's starts there, with the builder's turn just ended.
  const setUp = (idle = false) => {
    const f = fixture(t);
    f.tick(Date.now() - f.now);
    if (!idle) f.registry.threads.recordActivity(f.builder, { agent: f.now - 60_000 });
    return { f, loop: f.loop(), builder: () => desiredPhase(f.registry.threads.thread(f.builder)!, f.now) };
  };
  const { f, loop, builder } = setUp();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const reviewer = f.review().reviewer;
  f.tick(idlePolicy.agentIdleMs + 3 * 60_000);
  assert.equal(builder(), "running", "a reviewer that reads for 8 minutes finds the builder up");
  const builderPylon = f.registry.threads.pylon(f.registry.threads.thread(f.builder)!.pylonId)!;
  const held = () => f.registry.threads.pylonsWithHeldThreadsOn(builderPylon.node).map(({ pylon, thread }) => [pylon.pylonId, thread.id]);
  assert.deepEqual(held(), [[builderPylon.pylonId, f.builder]], "placement finds the held builder among its node's threads");
  f.reply(reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  const read = f.holdPolls(0);
  const pass = loop.poll();
  await read.entered;
  assert.equal(f.review().outbox?.to, "builder");
  assert.equal(builder(), "running", "findings that wait on GitHub before they go still find the builder up");
  read.release();
  await pass;
  assert.equal(f.sent.at(-1)!.to, f.builder);
  assert.equal(f.registry.threads.thread(f.builder)!.awaitedUntil, undefined, "the findings went, so the review awaits the builder no more");
  assert.deepEqual(held(), [], "and no longer once the review awaits it no more");

  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  f.registry.threads.recordActivity(f.builder, { agent: f.now });
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  await loop.poll();
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  f.tick(29 * 60_000);
  assert.equal(builder(), "running", "each round keeps it up");
  f.tick(2 * 60_000);
  assert.equal(builder(), "paused", "a reviewer that reads for over 30 minutes holds the builder's memory no longer");
  f.reply(reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.equal(builder(), "paused", "an approval that waits for the person's Land holds nothing up");

  const failing = setUp();
  await failing.loop.start(failing.f.builder, { land: null, rounds: 1 });
  await failing.loop.poll();
  failing.f.failedTurn(failing.f.review().reviewer, "Request timed out.");
  await failing.loop.poll();
  failing.f.tick(idlePolicy.agentIdleMs);
  assert.equal(failing.f.review().phase.kind, "reviewing");
  assert.equal(failing.builder(), "paused", "nor while the reviewer's model fails");
  failing.f.tick(2 * 60_000);
  await failing.loop.poll();
  failing.f.reply(failing.f.review().reviewer, verdict(failing.f.review(), { verdict: "changes", findings: [serious] }));
  await failing.loop.poll();
  assert.equal(failing.f.review().phase.kind, "needs-person");
  assert.equal(failing.builder(), "paused", "nor once the review is held for the person");

  const late = setUp(true);
  await late.loop.start(late.f.builder, { land: null });
  await late.loop.poll();
  assert.equal(late.f.review().phase.kind, "reviewing");
  assert.equal(late.builder(), "paused", "a builder already paused when its review starts is not woken to be held");

  const ended = fixture(t);
  ended.registry.threads.recordActivity(ended.builder, { agent: ended.now });
  const endedLoop = ended.loop();
  await endedLoop.start(ended.builder, { land: null });
  await endedLoop.poll();
  assert.equal(ended.review().phase.kind, "reviewing");
  assert.equal(ended.registry.threads.thread(ended.builder)!.awaitedUntil, undefined, "a hold that ended by the registry's clock is not shown");
});

test("rounds that run out, and agents that never answer in the block, end with the person's attention", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  const reviewer = f.review().reviewer;
  f.reply(reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["The reviewer still requests changes after 1 rounds, the most this review allows."], label: { state: "added" } });
  assert.equal(f.registry.threads.threads().find((th) => th.id === f.builder) && (f.registry.threads.events("0", { kinds: ["attention.changed"], thread: f.builder }).at(-1)?.payload.attention), "decision");

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

test("a reviewer whose model fails gets its request again after 2, 5 and 10 minutes, under its token and with no reminder, and goes on once it answers", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const reviewer = f.review().reviewer;
  const request = f.sent[0]!.message.text;
  const token = f.review().expect;
  for (const minutes of [2, 5, 10]) {
    f.failedTurn(reviewer, "Request timed out.");
    await loop.poll();
    const sent = f.sent.length;
    f.tick(minutes * 60_000 - 1_000);
    await loop.poll();
    assert.equal(f.sent.length, sent, `nothing goes before the ${minutes} minutes are up`);
    f.tick(1_000);
    await loop.poll();
    assert.equal(f.sent.length, sent + 1, `the request goes again after ${minutes} minutes`);
    assert.equal(f.sent.at(-1)!.message.text, request);
  }
  assert.deepEqual(f.sent.map((s) => s.message.id), [1, 2, 3, 4].map((n) => `${f.review().id}:${n}`));
  assert.equal(f.review().expect, token);
  assert.equal(f.review().nudges, 0, "a model failure is no reminder");
  assert.match(phaseNote(f.review()), /^, the reviewer's model is failing \(3 in a row, last: Request timed out\.\)/);

  f.reply(reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
});

test("nexus show and the dashboard say the agent's model is failing and when the loop tries again", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.failedTurn(f.review().reviewer, "Request timed out.");
  await loop.poll();
  assert.equal(new Date(f.now).toISOString().slice(11, 19), "00:17:42");
  assert.equal(phaseNote(f.review()), ", the reviewer's model is failing (1 in a row, last: Request timed out.), retrying at 00:19 UTC");
});

test("a model that fails a fifth time in a row ends the review for the person with its last error", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const reviewer = f.review().reviewer;
  for (const error of ["Request timed out.", "Request timed out.", "Request timed out.", "Request timed out.", "529 Overloaded"]) {
    f.failedTurn(reviewer, error);
    await loop.poll();
    f.tick(20 * 60_000);
    await loop.poll();
  }
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["The reviewer's model failed 5 times in a row (last: 529 Overloaded), in round 1. Run nexus review again once the provider recovers."] });
  assert.equal(f.sent.length, 5, "the request and four resends");
  assert.deepEqual(f.labelCalls, []);
});

test("a turn with no answer after a model failure gets a reminder, and a Claude builder whose model fails gets its findings again", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const reviewer = f.review().reviewer;
  f.failedTurn(reviewer, "Request timed out.");
  await loop.poll();
  f.tick(2 * 60_000);
  await loop.poll();
  f.reply(reviewer, "I looked and it seems fine.");
  await loop.poll();
  assert.match(f.sent.at(-1)!.message.text, /no nexus-review block/);
  assert.equal(f.review().nudges, 1);
  assert.deepEqual(f.review().phase, { kind: "reviewing" }, "a turn that did not fail ends the failures in a row");

  f.reply(reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  const findings = f.sent.at(-1)!;
  assert.equal(findings.to, f.builder);
  f.failedTurn(f.builder, "API Error: 529 Overloaded");
  await loop.poll();
  assert.equal(f.sent.at(-1), findings);
  assert.match(phaseNote(f.review()), /^, the builder's model is failing \(1 in a row, last: API Error: 529 Overloaded\)/);
  f.tick(2 * 60_000);
  await loop.poll();
  assert.equal(f.sent.at(-1)!.message.text, findings.message.text);
  assert.equal(f.sent.at(-1)!.to, f.builder);
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "reviewing" });
  assert.equal(f.review().rounds.length, 2);
});

test("a failed turn whose end is reported twice, by a Claude worker's transcript and later by its hook, counts once", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  const findings = f.sent.at(-1)!;
  f.failedTurn(f.builder, "API Error: Request timed out.");
  await loop.poll();
  f.registry.threads.recordReply(f.builder, f.now);
  f.tick(61_000);
  await loop.poll();
  assert.match(phaseNote(f.review()), /\(1 in a row,/);
  f.tick(60_000);
  await loop.poll();
  assert.equal(f.sent.at(-1)!.message.text, findings.message.text, "the findings go again 2 minutes after the failure, not 5");
});

test("a builder whose turn gives an incomplete answer and then fails on its model gets its findings again at the retry", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  const findings = f.sent.at(-1)!;
  f.replies.set(f.builder, [answers(f.review(), [])]);
  f.failedTurn(f.builder, "API Error: Request timed out.");
  await loop.poll();
  assert.match(phaseNote(f.review()), /\(1 in a row,/);
  const failing = structuredClone(f.review().phase);
  for (let i = 0; i < 3; i++) {
    f.tick(10_000);
    await loop.poll();
    assert.deepEqual(f.review().phase, failing, "the answer from the failed turn neither clears the failure nor moves its retry");
  }
  f.tick(2 * 60_000);
  await loop.poll();
  assert.equal(f.sent.at(-1)!.message.text, findings.message.text);
  assert.equal(f.sent.length, 3);
});

test("a builder that answers after a model failure is no longer failing while the loop waits for its push", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  f.failedTurn(f.builder, "API Error: Request timed out.");
  await loop.poll();
  f.tick(2 * 60_000);
  await loop.poll();
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "fixing" });
  assert.equal(phaseNote(f.review()), "");
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
  assert.equal(f.registry.threads.thread(f.builder)!.working, true, "heartbeats keep the builder working");
  assert.equal(f.registry.threads.thread(f.builder)!.lastReplyAt, null, "no turn end was reported");
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
  assert.equal(f.registry.threads.thread(f.builder)!.working, true);

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
  const gLoop = g.loop();
  const review = await gLoop.start(g.builder, { land: null });
  assert.deepEqual(review.models, { builder: "gpt-6-astra", reviewer: "claude-opus-5-5" });
  await gLoop.poll();
  assert.equal(g.started[0]!.role, "reviewer", "no /poteto-mode in front of the reviewer's request");
  assert.ok(g.started[0]!.request.claude!.startsWith(senders.review.prefix));
  assert.equal(review.outbox, null, "a Claude reviewer's request is its first prompt");
});

const healthy = (f: ReturnType<typeof fixture>, commit: string) => {
  for (const role of ["control", "probe"] as const) f.registry.releases.reportRelease({ node, role, commit, target: commit, state: "healthy", reason: null, observedAt: Date.now() });
};
/** `commit` as the desired release, which every service reports healthy. */
const released = (f: ReturnType<typeof fixture>, commit: string) => {
  f.registry.releases.setDesiredRelease({ commit, requestedBy: "person", requestedAt: 1 });
  healthy(f, commit);
};

async function approved(f: ReturnType<typeof fixture>, land: string | null) {
  const loop = f.loop();
  await loop.start(f.builder, { land });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  return loop;
}

test("a landing under the policy merges the approved head, deploys it and waits for every service to be healthy", async (t) => {
  const dir = await tempDir("nexus-review-", t);
  const path = join(dir, "registry.db");
  const f = fixture(t, { path });
  released(f, previous);
  await approved(f, "nLAPTOP");
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.review().phase.kind, "deploying");
  assert.equal(f.registry.releases.desiredRelease()?.commit, merged);
  assert.match(f.registry.releases.desiredRelease()!.requestedBy, /^nexus review rv-/);

  f.registry.close();
  const g = fixture(t, { path });
  g.snapshot = { ...g.snapshot, pr: { ...g.snapshot.pr, state: "merged" }, detail: { ...g.snapshot.detail, mergeCommit: merged } };
  const restarted = g.loop();
  await restarted.poll();
  assert.equal(g.review().phase.kind, "deploying", "a restart, such as the deploy's own, waits on without merging or deploying again");
  assert.deepEqual(g.merges, []);
  for (const role of ["control", "probe"] as const) g.registry.releases.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: Date.now() });
  await restarted.poll();
  assert.deepEqual(g.review().phase, { kind: "landed", commit: merged });
  assert.equal(g.registry.releases.desiredRelease()?.commit, merged);
});

test("a deploy that fails rolls back to the previous release and tells the person what still needs reverting", async (t) => {
  const f = fixture(t);
  released(f, previous);
  const loop = await approved(f, "nLAPTOP");
  f.registry.releases.reportRelease({ node, role: "control", commit: previous, target: merged, state: "rolled-back", reason: "health check failed", observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.registry.releases.desiredRelease()?.commit, previous);
  assert.equal(f.review().phase.kind, "rolling-back", "a rollback is not claimed until the fleet reports it healthy");
  for (const role of ["control", "probe"] as const) f.registry.releases.reportRelease({ node, role, commit: previous, target: previous, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [
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
  assert.equal(f.registry.releases.desiredRelease(), null);
});

/** A second builder in `f`'s project whose PR #8 at `head2` merges as `merged2`, and whose review `f`'s loop starts. */
const merged2 = "n".repeat(40);
async function secondBuilder(f: ReturnType<typeof fixture>, loop: ReturnType<ReturnType<typeof fixture>["loop"]>) {
  const builder = f.add("th-builder-2", true);
  const pr = { ...f.pr, number: 8, url: "https://github.com/ramtinJ95/nexus/pull/8" };
  f.registry.prWatches.savePrWatch(builder, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  f.others.set(8, { ...f.snapshot, pr: { ...pr }, detail: { ...f.snapshot.detail, head: head2, branch: "second" } });
  f.mergeAnswer = (sha) => ({ kind: "merged", commit: sha === head1 ? merged : merged2 });
  await loop.start(builder, { land: "nLAPTOP" });
  return builder;
}

test("a wake steps only the reviews its thread takes part in, at once", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  const second = await secondBuilder(f, loop);
  // The first poll joins the pass the first start began, before the second review was saved.
  await loop.poll();
  await loop.poll();
  const first = f.review();
  const other = f.registry.reviews.review(second)!;
  f.reply(first.reviewer, verdict(first, { verdict: "changes", findings: [serious] }));
  f.reply(other.reviewer, verdict(other, { verdict: "changes", findings: [serious] }));
  const polls = f.polls;
  await loop.wake(first.reviewer);
  assert.equal(f.review().phase.kind, "fixing", "the woken reviewer's verdict moves its review on");
  assert.equal(f.registry.reviews.review(second)!.phase.kind, "reviewing", "the other review waits for its poll");
  assert.equal(f.polls, polls + 1, "only the woken review's PR is read");
  await loop.wake("th-none" as ThreadId);
  assert.equal(f.polls, polls + 1, "a thread no review holds steps nothing");
  await loop.poll();
  assert.equal(f.registry.reviews.review(second)!.phase.kind, "fixing");
});

test("a wake after close steps nothing, as from a check whose stream ends while the control plane stops", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  await loop.close();
  const polls = f.polls;
  await loop.wake(f.builder);
  assert.equal(f.polls, polls);
});

test("landings deploy one at a time: the second merges once the first is healthy, and rolls back to the first's commit", async (t) => {
  const f = fixture(t);
  released(f, previous);
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  const second = await secondBuilder(f, loop);
  await loop.poll();
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  f.reply(f.registry.reviews.review(second)!.reviewer, verdict(f.registry.reviews.review(second)!, {}));
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "the second waits before it merges, so main gains one undeployed commit at a time");
  assert.equal(f.registry.releases.desiredRelease()?.commit, merged);
  assert.equal(f.review().phase.kind, "deploying");
  assert.deepEqual(f.registry.reviews.review(second)!.phase, { kind: "merging", authorized: null, waiting: `${f.review().id} deploys` });
  assert.equal(phaseNote(f.registry.reviews.review(second)!), `, waiting while ${f.review().id} deploys`);

  healthy(f, merged);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
  assert.deepEqual(f.merges, [head1, head2]);
  assert.equal(f.registry.releases.desiredRelease()?.commit, merged2);
  assert.deepEqual(f.registry.reviews.review(second)!.phase, { kind: "deploying", commit: merged2, previous: merged, requested: true, deadline: (f.registry.reviews.review(second)!.phase as { deadline: number }).deadline });

  f.registry.releases.reportRelease({ node, role: "control", commit: merged, target: merged2, state: "rolled-back", reason: "health check failed", observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.registry.releases.desiredRelease()?.commit, merged, "the rollback goes to the first landing's commit, which was healthy");
  healthy(f, merged);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
  assert.deepEqual((f.registry.reviews.review(second)!.phase as { reasons: string[] }).reasons, [
    `The deploy of ${merged2} failed: node control rolled-back (health check failed).`,
    `Rolled back to the previous release, ${merged}, which every service reports healthy.`,
    `${merged2} is still on the default branch, so revert it before the next deploy.`,
  ]);
});

test("a landing waits to merge while the control plane drains for a deploy, and while another landing rolls back", async (t) => {
  const f = fixture(t);
  released(f, previous);
  f.registry.releases.setDrain({ commit: previous, expiresAt: Date.now() + 60_000 });
  const loop = await approved(f, "nLAPTOP");
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "merging", authorized: null, waiting: "a deploy drains the control plane" });
  f.registry.releases.setDrain(null);
  const second = await secondBuilder(f, loop);
  await loop.poll();
  await loop.poll();
  f.reply(f.registry.reviews.review(second)!.reviewer, verdict(f.registry.reviews.review(second)!, {}));
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "the second waits for the first, which merged once the drain ended");
  f.registry.releases.reportRelease({ node, role: "control", commit: previous, target: merged, state: "rolled-back", reason: "health check failed", observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.review().phase.kind, "rolling-back");
  assert.deepEqual(f.registry.reviews.review(second)!.phase, { kind: "merging", authorized: null, waiting: `${f.review().id} rolls back` });
  healthy(f, previous);
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person");
  assert.deepEqual(f.merges, [head1, head2]);
  assert.equal((f.registry.reviews.review(second)!.phase as { previous: string }).previous, previous);
});

test("a landing waits to merge while the desired release is not healthy everywhere, as after a failed deploy with nothing to roll back to", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  const second = await secondBuilder(f, loop);
  await loop.poll();
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  f.reply(f.registry.reviews.review(second)!.reviewer, verdict(f.registry.reviews.review(second)!, {}));
  await loop.poll();
  f.registry.releases.reportRelease({ node, role: "control", commit: null, target: merged, state: "failed", reason: "health check failed", observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person");
  assert.deepEqual(f.merges, [head1], "the failed release is still desired, so it must not become the second's rollback target");
  assert.deepEqual(f.registry.reviews.review(second)!.phase, { kind: "merging", authorized: null, waiting: `not every service reports ${merged.slice(0, 12)} healthy` });
  released(f, previous);
  await loop.poll();
  assert.deepEqual(f.merges, [head1, head2]);
  assert.equal((f.registry.reviews.review(second)!.phase as { previous: string }).previous, previous);
});

test("a review that lands archives its builder and reviewer, once, whether its PR deploys or not", async (t) => {
  for (const repo of ["ramtinJ95/nexus", "acme/shop"]) {
    const f = fixture(t, { repo });
    released(f, previous);
    const loop = await approved(f, "nLAPTOP");
    if (repo === "ramtinJ95/nexus") {
      assert.equal(f.review().phase.kind, "deploying");
      assert.deepEqual(f.statuses(), ["active", "active"], "a landing that still deploys archives nothing");
      for (const role of ["control", "probe"] as const) f.registry.releases.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: Date.now() });
      await loop.poll();
    }
    assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
    assert.deepEqual(f.statuses(), ["archived", "archived"], `${repo}: both threads are archived once the review lands`);
    assert.deepEqual(f.woken, [f.builder, f.review().reviewer], "the planner hears of each archive, so their pylons pause");
    f.registry.threads.setThreadStatus(f.builder, "active");
    await loop.poll();
    assert.deepEqual(f.statuses(), ["active", "archived"], "a landed builder the person unarchives stays open");
  }
});

test("a landing whose save fails archives nothing, so a release that supersedes it before the retry leaves both threads open", async (t) => {
  const f = fixture(t);
  released(f, previous);
  const loop = await approved(f, "nLAPTOP");
  const save = f.registry.reviews.saveReview;
  f.registry.reviews.saveReview = (review, archive, read) => {
    if (review.phase.kind === "landed") throw new Error("disk I/O error");
    return save(review, archive, read);
  };
  for (const role of ["control", "probe"] as const) f.registry.releases.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.review().phase.kind, "deploying");
  assert.deepEqual(f.statuses(), ["active", "active"], "no thread is archived while the landing is unsaved");
  f.registry.reviews.saveReview = save;
  f.registry.releases.setDesiredRelease({ commit: "n".repeat(40), requestedBy: "person", requestedAt: 2 });
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
  released(rolledBack, previous);
  const loop = await approved(rolledBack, "nLAPTOP");
  rolledBack.registry.releases.reportRelease({ node, role: "control", commit: previous, target: merged, state: "failed", reason: "unit failed", observedAt: Date.now() });
  await loop.poll();
  for (const role of ["control", "probe"] as const) rolledBack.registry.releases.reportRelease({ node, role, commit: previous, target: previous, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  assert.equal(rolledBack.review().phase.kind, "needs-person");
  assert.deepEqual(rolledBack.statuses(), ["active", "active"], "a merge whose deploy rolled back");

  const approval = fixture(t);
  await approved(approval, null);
  assert.equal(approval.review().phase.kind, "approved");
  assert.deepEqual(approval.statuses(), ["active", "active"], "a review without a landing");
  assert.deepEqual([...held.woken, ...rolledBack.woken, ...approval.woken], []);
});

test("a builder in a turn as its review lands, as one answering the approval's notes, is archived once that turn ends, and no holds question stays open", async (t) => {
  const f = fixture(t, { autoReview: { mode: "yolo", enabledBy: "nLAPTOP" } });
  released(f, previous);
  f.files = [{ path: "images/pylon/Dockerfile", previous: null, patch: "@@ -1 +1 @@\n-FROM a\n+FROM b" }];
  const loop = f.loop();
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  await loop.poll();
  claudeRead(f, [{ kind: "reply", at: f.now, text: "Opened #7." }, { kind: "prompt", at: f.now + 1, text: "Keep the cache small", from: "person" }], []);
  f.tick(1_000);
  f.reply(f.review().reviewer, verdict(f.review(), { findings: [{ id: "N1", priority: "P3", where: "src/cache.ts:1", summary: "Name the constant" }] }));
  await loop.poll();
  assert.match(f.sent.findLast((s) => s.to === f.builder)!.message.text, /N1 \(P3\)/, "the builder gets the approval's notes");
  f.registry.threads.recordActivity(f.builder, { agent: f.now, agentTurnRunning: true });
  for (const role of ["control", "probe"] as const) f.registry.releases.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.review().phase.kind, "landed");
  assert.deepEqual(f.statuses(), ["active", "archived"], "a builder in a turn stays open as its review lands");
  assert.deepEqual(holdQuestions(f).filter((q) => q.answer === null && q.withdrawn === undefined), [], "no holds question is open once the review landed");
  await loop.poll();
  assert.deepEqual(f.statuses(), ["active", "archived"], "its turn keeps it open");
  f.tick(60_000);
  f.registry.threads.recordActivity(f.builder, { agent: f.now, agentTurnRunning: false });
  await loop.poll();
  assert.deepEqual(f.statuses(), ["active", "archived"], "its transcript is not read since the landing");
  f.tick(1_000);
  claudeRead(f, [{ kind: "reply", at: f.now, text: "Named the constant." }], []);
  await loop.poll();
  assert.deepEqual(f.statuses(), ["archived", "archived"], "the person's message before the landing does not keep it");
  assert.deepEqual(f.woken.at(-1), f.builder, "the planner hears of the archive, so its pylon pauses");
  f.registry.threads.setThreadStatus(f.builder, "active");
  await loop.poll();
  assert.deepEqual(f.statuses(), ["active", "archived"], "a builder the person unarchives stays open");
});

test("a builder the person wrote to after its review landed stays open once its turn ends, though its transcript is read after that end", async (t) => {
  const f = fixture(t, { repo: "acme/shop" });
  f.registry.threads.recordActivity(f.builder, { agent: 1, agentTurnRunning: true });
  const loop = await approved(f, "nLAPTOP");
  assert.deepEqual(f.review().phase.kind, "landed");
  assert.deepEqual(f.statuses(), ["active", "archived"]);
  f.tick(1_000);
  const wrote = f.now;
  f.tick(1_000);
  f.registry.threads.recordActivity(f.builder, { agent: f.now, agentTurnRunning: false });
  f.registry.threads.recordReply(f.builder, f.now);
  await loop.poll();
  assert.deepEqual(f.statuses(), ["active", "archived"], "a transcript not read since the turn ended cannot say the person did not write");
  f.tick(1_000);
  claudeRead(f, [{ kind: "prompt", at: wrote, text: "Now write the follow-up", from: "person" }, { kind: "reply", at: wrote + 1, text: "On it." }], []);
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.statuses(), ["active", "archived"], "the person's message since the landing makes it theirs");
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged }, "and the loop stops reading it");
  assert.deepEqual(f.woken, [f.review().reviewer]);
});

test("a builder that starts a turn or is deleted while the loop reads whether the person wrote to it is not archived", async (t) => {
  for (const meanwhile of ["turn", "deleted"] as const) {
    const f = fixture(t, {
      repo: "acme/shop",
      personWrote: (registry) => async (target) => {
        if (meanwhile === "turn") registry.threads.recordActivity(target.id, { agent: 3, agentTurnRunning: true });
        else registry.threads.setThreadStatus(target.id, "deleted");
        return false;
      },
    });
    f.registry.threads.recordActivity(f.builder, { agent: 1, agentTurnRunning: true });
    const loop = await approved(f, "nLAPTOP");
    f.registry.threads.recordActivity(f.builder, { agent: 2, agentTurnRunning: false });
    f.tick(1_000);
    claudeRead(f, [], []);
    await loop.poll();
    assert.deepEqual(f.statuses(), [meanwhile === "turn" ? "active" : "deleted", "archived"], meanwhile);
  }
});

test("a review that ends merged, closed, cancelled by its builder's archive, or out of rounds archives its reviewer by the next pass", async (t) => {
  const ends: [Review["phase"]["kind"], (f: ReturnType<typeof fixture>) => void][] = [
    ["merged", (f) => f.watched("merged")],
    ["closed", (f) => f.watched("closed")],
    ["cancelled", (f) => archive(f.registry, f.builder)],
    ["needs-person", (f) => f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }))],
  ];
  for (const [kind, end] of ends) {
    const f = fixture(t);
    const loop = f.loop();
    await loop.start(f.builder, { land: null, rounds: 1 });
    await loop.poll();
    const reviewer = f.review().reviewer;
    end(f);
    await loop.poll();
    await loop.poll();
    assert.equal(f.review().phase.kind, kind);
    assert.equal(f.registry.threads.thread(reviewer)!.status, "archived", `${kind}: no round can go to the reviewer`);
    assert.deepEqual(f.woken, [reviewer], `${kind}: the planner hears of the archive, so its pylon pauses`);
  }
});

test("a review a new review replaces leaves its reviewer archived, and the new reviewer open", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  const first = f.review().reviewer;
  await loop.poll();
  assert.equal(f.registry.threads.thread(first)!.status, "active", "a review at approval may still land, which needs its reviewer");
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(f.registry.threads.thread(first)!.status, "archived");
  assert.equal(f.registry.threads.thread(f.review().reviewer)!.status, "active");
});

test("a reviewer in a turn as its review lands is archived on a later pass, once the turn ends", async (t) => {
  const f = fixture(t, { repo: "acme/shop" });
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  const reviewer = f.review().reviewer;
  f.registry.threads.recordActivity(reviewer, { agent: 1, agentTurnRunning: true });
  f.reply(reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
  assert.deepEqual(f.statuses(), ["archived", "active"]);
  await loop.poll();
  assert.equal(f.registry.threads.thread(reviewer)!.status, "active", "a turn keeps it open");
  f.registry.threads.recordActivity(reviewer, { agent: 2, agentTurnRunning: false });
  await loop.poll();
  assert.deepEqual(f.statuses(), ["archived", "archived"]);
});

test("a review held for the person keeps its reviewer across passes, for the rounds a land or a new head can start", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "images/pylon/Dockerfile", previous: null, patch: "@@ -1 +1 @@\n-FROM a\n+FROM b" }];
  const loop = await approved(f, "nLAPTOP");
  assert.equal(f.review().phase.kind, "needs-person");
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.statuses(), ["active", "active"]);
});

test("a merged review held for the person over its rolled-back deploy archives its reviewer by the next pass, and keeps its builder", async (t) => {
  const f = fixture(t);
  released(f, previous);
  const loop = await approved(f, "nLAPTOP");
  f.registry.releases.reportRelease({ node, role: "control", commit: previous, target: merged, state: "failed", reason: "unit failed", observedAt: Date.now() });
  await loop.poll();
  healthy(f, previous);
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person");
  await loop.poll();
  assert.deepEqual(f.statuses(), ["active", "archived"], "no round can follow a merge");
});

test("a reviewer the person has been to since it started stays open after its review ends", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const reviewer = f.review().reviewer;
  f.registry.threads.recordActivity(reviewer, { human: 2 });
  f.watched("closed");
  await loop.poll();
  await loop.poll();
  assert.equal(f.review().phase.kind, "closed");
  assert.equal(f.registry.threads.thread(reviewer)!.status, "active");
});

test("reviewers left behind before the loop archived them, by a replaced review or a crash before its review saved, are archived on the first pass", async (t) => {
  const f = fixture(t);
  const earlier = f.add("th-reviewer-earlier", false, reviewerCaller);
  const crashed = f.add("th-reviewer-crashed", false, reviewerCaller);
  const later = f.add("th-reviewer-later", false, reviewerCaller);
  archive(f.registry, later);
  archive(f.registry, f.builder);
  f.registry.reviews.saveReview(testReview({ builder: f.builder, reviewer: later, merged, phase: { kind: "landed", commit: merged } }));
  await f.loop().poll();
  assert.deepEqual([earlier, crashed].map((id) => f.registry.threads.thread(id)!.status), ["archived", "archived"]);
  assert.deepEqual(f.woken.toSorted(), [crashed, earlier]);
});

test("a review's start answers once the review is recorded, and the loop starts its reviewers after", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  const loop = f.loop();
  const starting = Promise.withResolvers<void>();
  f.onStart = () => starting.promise;
  const started = await Promise.race([loop.start(f.builder, { land: "nLAPTOP" }), setTimeout(2_000, "still starting" as const)]);
  if (started === "still starting") assert.fail("the start does not wait for a reviewer thread");
  assert.deepEqual([f.review().id, f.review().reviewer], [started.id, started.reviewer], "the answer is the recorded review");
  starting.resolve();
  await loop.poll();
  await loop.poll();
  assert.equal(f.started[0]!.id, started.reviewer, "the first reviewer starts under the ID the review was recorded with");
  assert.equal(f.review().second?.kind, "claude", "the second reviewer starts in the loop too");
  assert.deepEqual(f.sent.map((s) => s.to), [started.reviewer], "the first reviewer gets its first request once its thread exists");
  assert.deepEqual(f.statuses(), ["active", "active"]);
});

test("a restart of a review counts the rounds the PR's earlier reviews spent, and only --rounds grants more", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  await loop.poll();
  assert.equal(roundsSpent(f.review()), 2);
  loop.cancel(f.builder, "nLAPTOP");

  const restarted = await loop.start(f.builder, { land: null });
  assert.equal(restarted.maxRounds, 3, "the restart may spend what the PR's 5 rounds left");
  assert.match(reviewSaidText(restarted), /round 3 of 5/, "the person reads the rounds the PR spent, not the restart's alone");
  assert.deepEqual([reviewView(restarted, []).round, reviewView(restarted, []).maxRounds], [3, 5]);
  loop.cancel(f.builder, "nLAPTOP");

  f.registry.reviews.saveReview({ ...f.review(), reviewerStarted: true, maxRounds: 3, rounds: [head1, head2, "3".repeat(40)].map((head) => ({ head, base: "main", verdict: null, check: null, answers: null })) });
  await assert.rejects(loop.start(f.builder, { land: null }), (err: Error) => err instanceof Refusal
    && err.message === `pull request #7 has had 5 rounds over its reviews, and Nexus gives one 5 without the person's word. Run nexus review ${f.builder} --rounds N to grant it N more`);
  const granted = await loop.start(f.builder, { rounds: 2, land: null });
  assert.equal(granted.maxRounds, 2);
  assert.match(reviewSaidText(granted), /round 6 of 7/);
});

test("the rounds of a PR's reviews count for it alone, whichever review of the builder's came between", async (t) => {
  const f = fixture(t);
  const other = testPr({ repo: "ramtinJ95/nexus", number: 8, title: "Add the queue" });
  f.others.set(8, { ...f.snapshot, pr: { ...other } });
  f.registry.prWatches.savePrWatch(f.builder, { links: [{ pr: f.pr, seen: [], failed: false }, { pr: other, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const loop = f.loop();
  await loop.start(f.builder, { pr: 7, land: null });
  loop.cancel(f.builder, "nLAPTOP");
  f.registry.reviews.saveReview({ ...f.review(), reviewerStarted: true, rounds: [head1, head2, "3".repeat(40), "4".repeat(40), "5".repeat(40)].map((head) => ({ head, base: "main", verdict: null, check: null, answers: null })) });
  await loop.start(f.builder, { pr: 8, land: null });
  loop.cancel(f.builder, "nLAPTOP");
  await assert.rejects(loop.start(f.builder, { pr: 7, land: null }), /pull request #7 has had 5 rounds over its reviews/);
});

test("a PR runs one review at a time, whichever of its builders starts it, so its rounds stay within one budget", async (t) => {
  const f = fixture(t);
  const other = f.add("th-other", true);
  f.registry.prWatches.savePrWatch(other, { links: [{ pr: f.pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const loop = f.loop();
  const polled = f.holdPolls();
  const first = loop.start(f.builder, { land: null });
  await polled.entered;
  const raced = loop.start(other, { land: null });
  polled.release();
  const [a, b] = await Promise.allSettled([first, raced]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected", "a start that raced the first is refused once it would record a second review");
  assert.match((b as PromiseRejectedResult).reason.message, new RegExp(`pull request #7 is under review ${f.review().id} of ${f.builder}`));
  await assert.rejects(loop.start(other, { land: null }), /pull request #7 is under review/);
  f.registry.reviews.saveReview({ ...f.review(), phase: { kind: "approved" } });
  await assert.rejects(loop.start(other, { land: null }), (err: Error) => err.message === `pull request #7 is under review ${f.review().id} of ${f.builder}, which is approved. Land it with nexus land ${f.builder}, or start the review again from ${f.builder}`);
  f.registry.reviews.saveReview({ ...f.review(), phase: { kind: "deploying", commit: "m".repeat(40), previous: null, requested: false, deadline: 0 } });
  await assert.rejects(loop.start(other, { land: null }), /which is deploying, and a merge or deploy that has begun is seen through/);
  f.registry.reviews.saveReview({ ...f.review(), phase: { kind: "reviewing" } });
  loop.cancel(f.builder, "nLAPTOP");
  assert.equal((await loop.start(other, { land: null })).builder, other, "once that review ended, another builder's starts");
});

test("a reviewer whose start keeps failing is tried each pass for 30 minutes, then the review waits on the person", async (t) => {
  const f = fixture(t);
  f.failStart = () => "the harness is unreachable";
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.tick(29 * 60_000);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "a failure inside 30 minutes is tried again");
  assert.equal(f.review().reviewerStarted, false);
  f.tick(2 * 60_000);
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [`The reviewer thread ${f.review().reviewer} did not start within 30 minutes: the harness is unreachable.`] });
});

test("a reviewer thread that a start made before a crash is not started again", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  const r = await loop.start(f.builder, { land: null });
  await loop.poll();
  f.registry.reviews.saveReview({ ...r, reviewerStarted: false });
  f.started.length = 0;
  f.sent.length = 0;
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.started, [], "the thread under the recorded ID is the reviewer");
  assert.equal(f.review().reviewerStarted, true);
  assert.deepEqual(f.sent.map((s) => s.to), [r.reviewer], "the reviewer gets its first request");
});

test("a review whose reviewer never started spent no round of its PR's", async (t) => {
  const f = fixture(t);
  f.refuseStart = () => "no node has room for this pylon";
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [`The reviewer thread ${f.review().reviewer} did not start: no node has room for this pylon.`] });
  f.refuseStart = () => null;
  assert.equal((await loop.start(f.builder, { land: null })).maxRounds, 5);
});

test("a token that cannot merge holds the landing for the person, and a later land tries again", async (t) => {
  const f = fixture(t, { repo: "acme/shop" });
  f.mergeAnswer = () => ({ kind: "denied", message: "GitHub answered 403: Resource not accessible by personal access token" });
  const loop = await approved(f, "nLAPTOP");
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["The control plane's GitHub token cannot merge (GitHub answered 403: Resource not accessible by personal access token). Merging needs a token with write access to acme/shop's contents and pull requests, which only the person can grant."] });
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
    { path: "src/control/schema.ts", previous: null, patch: "@@ -240,3 +240,4 @@ export const migrations: readonly string[] = [\n+  `ALTER TABLE threads ADD COLUMN x TEXT;`," },
    { path: "src/control/schema.ts.bak", previous: null, patch: "" },
  ];
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, body: "Adds a cache." } };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { reserved: [{ case: "cli-breaking", why: "renames --wait" }] }));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [
    "The reviewer's quote of what could not be checked live is not in the pull request's description.",
    "Always needs the person: breaking changes to the CLI's contract, by the reviewer's reading (renames --wait).",
    "Always needs the person: pylon image rebuilds, as it changes images/pylon/Dockerfile.",
    "Always needs the person: anything irreversible, as it changes src/control/schema.ts.",
  ] });
});

test("paths under docs/ hold for no reserved case by their names, while deploy/ and shipped code still do", () => {
  const round = { head: head1, verdict: { token: "x", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: "the cache under real traffic" }, check: { passed: true, output: "" }, live: { kind: "absent" as const }, answers: null };
  const review = testReview({
    builder: "th-b" as ThreadId, reviewer: "th-r" as ThreadId, pr: { repo: "ramtinJ95/nexus", number: 199, url: "", title: "", branch: "f" }, models: { builder: "a", reviewer: "b" },
    maxRounds: 3, phase: { kind: "merging", authorized: null }, rounds: [round],
  });
  const pr: PrSnapshot = { pr: testPr({ repo: "ramtinJ95/nexus", number: 199, title: "", url: "" }), detail: { head: head1, branch: "f", base: "main", body: "Not checked live: the cache under real traffic.", mergeCommit: null }, failures: [], comments: [] };
  const holds = (...paths: string[]) => headHolds({ review, deploys: true, files: paths.map((path) => ({ path, previous: null, patch: "@@ -0,0 +1 @@\n+x" })) }).map((h) => h.text);
  const pr199 = ["README.md", "docs/explorations/install.md", "docs/roadmap.md", ...["README.md", "loopback.py", "run.ts", "standin/apt-get", "standin/github-host-keys", "standin/journalctl", "standin/qemu",
    "standin/ssh-keyscan", "standin/systemctl", "standin/tailscale", "tailnet.ts", "transcript.txt", "tsconfig.json"].map((p) => `docs/verification/fresh-install/${p}`)];
  assert.deepEqual(holds(...pr199), []);
  assert.deepEqual(holds("deploy/install.sh", "src/tailscale.ts", "src/control/credentials.ts"), [
    "Always needs the person: changes to secrets, as it changes deploy/install.sh, src/control/credentials.ts.",
    "Always needs the person: changes to the tailnets, as it changes src/tailscale.ts.",
  ]);
  assert.deepEqual(holds("src/pylon-vm/host-bridge.ts", "src/pylon-vm/network.ts", "src/project.ts"), ["Always needs the person: changes to the egress allowlist, as it changes src/pylon-vm/host-bridge.ts, src/pylon-vm/network.ts."]);
  assert.deepEqual(holds("src/control/holds.ts"), ["Always needs the person: changes to login or auth, as it changes src/control/holds.ts."]);
  assert.deepEqual(holds("src/contract/reserved.ts"), ["Always needs the person: changes to login or auth, as it changes src/contract/reserved.ts."]);
  assert.deepEqual(holds("src/protocol/routes.ts"), ["Always needs the person: changes to login or auth, as it changes src/protocol/routes.ts."]);
  assert.deepEqual(holds("src/control/api/kit.ts"), ["Always needs the person: changes to login or auth, as it changes src/control/api/kit.ts."]);
  const migration = { path: "src/control/schema.ts", previous: null, patch: "@@ -250,3 +250,4 @@ export const migrations: readonly string[] = [\n+  `ALTER TABLE threads ADD COLUMN x TEXT;`," };
  assert.deepEqual(headHolds({ review, deploys: true, files: [migration] }).map((h) => h.text), ["Always needs the person: anything irreversible, as it changes src/control/schema.ts."]);
  assert.deepEqual(holds("src/control/schema.ts", "src/control/db.ts"), []);
  const dropped = { path: "src/control/schema.ts", previous: null, patch: "@@ -250,3 +250,2 @@ export const migrations: readonly string[] = [\n-  `UPDATE threads SET x = NULL;`," };
  assert.deepEqual(headHolds({ review, deploys: true, files: [dropped] }).map((h) => h.code), ["reserved-path:irreversible"], "a hunk in the migrations holds even when it names no DDL");
  const registry = { path: "src/control/registry.ts", previous: null, patch: "" };
  assert.deepEqual(headHolds({ review, deploys: true, files: [registry] }), [], "the registry holds no migrations, so even GitHub's empty patch for it holds nothing");
});

test("a path that holds for what its patch changes holds for a change to what its case guards, not for every edit to it", () => {
  const review = testReview({ builder: "th-b" as ThreadId, reviewer: "th-r" as ThreadId, pr: { repo: "ramtinJ95/nexus", number: 199, url: "", title: "", branch: "f" }, models: { builder: "a", reviewer: "b" }, maxRounds: 3, phase: { kind: "approved" },
    rounds: [{ head: head1, verdict: { token: "x", verdict: "approve", findings: [], reserved: [], notCheckedLive: null }, check: { passed: true, output: "" }, live: { kind: "absent" }, answers: null }] });
  const holds = (path: string, ...lines: string[]) => headHolds({ review, deploys: true, files: [{ path, previous: null, patch: ["@@ -1,3 +1,3 @@ export function f(", ...lines].join("\n") }] }).map((h) => h.code);
  const patched = (path: string, patch: string, previous: string | null = null) => headHolds({ review, deploys: true, files: [{ path, previous, patch }] }).map((h) => h.code);
  // Each line is from a merged pull request the paths held for nothing reserved: #435, #441, #430, #412, #408, #440, #432.
  assert.deepEqual(holds("deploy/README.md", "+### Debug a pylon's guest commands"), []);
  assert.deepEqual(holds("src/pylon-vm/client.ts", `-for (const key of ["PATH", "HOME"])`, `+for (const key of ["PATH", "HOME", "GONDOLIN_DEBUG"])`), []);
  assert.deepEqual(holds("src/pylon-vm/guest.test.ts", "+  allowedHosts: [],"), []);
  assert.deepEqual(holds("src/pylon-vm/FORK.md", "+The guest's network is Gondolin's."), []);
  assert.deepEqual(holds("src/control/api/dashboard-routes.ts", `-return ok(home(c, {}, await peekOf(c, r.query.get("peek"))));`, `+return ok(home(c, {}, await peekOf(c, r.query.get("peek")), r.query.get("card")));`), []);
  assert.deepEqual(holds("src/control/threads.ts", `+type ThreadsRegistry = Pick<Registry, "latestHealthSample" | "node">;`), []);
  assert.deepEqual(holds("src/control/project.ts", "-export const defaultProjectResources = { cpus: 2, memoryGiB: 6 };", "+export const defaultProjectResources = { cpus: 2, memoryGiB: 4 };"), []);
  assert.deepEqual(holds("src/deploy/plan.ts", `-return { kind: "stop", reason: "agent turn still running at drain timeout" };`), []);
  assert.deepEqual(holds("src/pylon-vm/guest.ts", "+const unansweredLimit = 3;"), []);

  assert.deepEqual(holds("deploy/install.sh", "+echo ok"), ["reserved-path:secrets"], "a deploy script holds whatever it changes");
  assert.deepEqual(holds("src/control/threads.ts", "+allowedHosts: withHttpsHosts(effectiveAllowedHosts(project), [dotfilesRepo]),"), ["reserved-path:egress"]);
  assert.deepEqual(holds("src/control/project.ts", `+  claude: ["api.anthropic.com", "claude.ai"],`), ["reserved-path:egress"], "a host the allowlist gains");
  assert.deepEqual(holds("src/pylon-vm/client.ts", `+await saveJson(join(dir, "status.json"), { state: "starting" });`), [], "a quoted file name is no host");
  assert.deepEqual(patched("src/pylon-vm/client.ts", "@@ -1,3 +1,3 @@\n \t\t// a pylon's disk would take host memory\n-\t\tconst a = 1;\n+\t\tconst a = 2;\n \t/* the allowlist's hosts */"), [], "a line that is only a comment changes nothing");
  assert.deepEqual(holds("src/pylon-vm/daemon.ts", "+\t/* temporary */ await chmod(socket, 0o777);"), ["reserved-path:auth"], "code after a comment on its line");
  assert.deepEqual(holds("src/control/api/thread-routes.ts", "+  * authorized() {"), ["reserved-path:auth"], "a generator's line, which starts with a star");
  assert.deepEqual(headHolds({ review, deploys: true, files: [{ path: "src/control/live.ts", previous: null, patch: "@@ -15,3 +15,3 @@ export function pylonLive(pylon: StoredPylon) {\n-  return a;\n+  return b;" }] }).map((h) => h.code), [], "the hunk's header names no host");
  assert.deepEqual(headHolds({ review, deploys: true, files: [{ path: "src/control/live.ts", previous: null, patch: "@@ -15,3 +15,3 @@ export function liveHosts(pylon: StoredPylon) {\n-  return a;\n+  return b;" }] }).map((h) => h.code), ["reserved-path:egress"], "the hunk's header says the change is in the hosts");
  assert.deepEqual(holds("src/pylon-vm/network.ts", "+export const x = 1;"), ["reserved-path:egress"]);
  assert.deepEqual(holds("src/pylon-vm/host-bridge.ts", "+export const x = 1;"), ["reserved-path:egress"]);
  assert.deepEqual(holds("src/pylon-vm/daemon.ts", "+\tawait chmod(socket, 0o600);"), ["reserved-path:auth"], "who on the node may call the controller");
  assert.deepEqual(holds("src/backends/pylon-vm/pylon-vm-backend.ts", "+  allowedHosts: [],"), ["reserved-path:egress"], "the fork's adapter holds as the fork does");
  assert.deepEqual(holds("src/backends/pylon-vm/pylon-guest.ts", "+\tawait chmod(dir, 0o700);"), ["reserved-path:auth"]);
  assert.deepEqual(holds("src/control/api/dashboard-routes.ts", `+    ["GET", /^\\/cards$/, { person: "read the cards" }, () => ok(cards())],`), ["reserved-path:auth"], "a new route's guard");
  assert.deepEqual(holds("src/control/api/review-routes.ts", `+    ["POST", /^\\/land$/, { open: "anyone" }, () => ok(land())],`), ["reserved-path:auth"]);
  assert.deepEqual(holds("src/control/releases.ts", "-  return options !== undefined && options.deployers.has(caller) && isPerson(registry, options, caller);"), ["reserved-path:auth"]);
  assert.deepEqual(holds("src/probe/server.ts", `-    return routeAuth[route] === "control-plane" ? caller === auth.controlPlane : peers.includes(caller);`), ["reserved-path:auth"]);
  assert.deepEqual(holds("src/control/api/kit.ts", "+export const x = 1;"), ["reserved-path:auth"]);
  assert.deepEqual(holds("src/control/api/server.ts", "-    if (req.method !== \"GET\") requireJson(req);"), ["reserved-path:auth"], "the API's admission of every request");
  assert.deepEqual(holds("src/pylon-vm/runtime.ts", "+\t\t\thttpHooks: {},"), ["reserved-path:egress"], "a hook that replaces the allowlist's");
  assert.deepEqual(holds("src/probe/redact.ts", "-const minValueLength = 8;", "+const minValueLength = 32;"), ["reserved-path:secrets"], "what keeps granted secrets out of the probe's logs");
  assert.deepEqual(patched("src/control/api/thread-routes.ts", `@@ -40,4 +40,5 @@ export function threadRoutes(\n     const t = thread(m[1]!);\n+    if (r.query.has("debug")) return ok(dump(t));\n     personOnly(r.caller, "read a thread");`), ["reserved-path:auth"], "a line added beside a guard it gets around, which only the context names");
  assert.deepEqual(patched("src/probe/server.ts", `@@ -640,3 +640,4 @@ export async function startProbe(options: ProbeOptions) {\n+    if (url.searchParams.has("debug")) return backend.guest(id).stream(["sh"]);\n     if (!await authorized(req, "/v1/pylons")) return send(res, 403, "caller is not the tailnet node this route allows");`), ["reserved-path:auth"], "an unauthenticated shell into a pylon, above the probe's guard");
  assert.deepEqual(patched("src/probe/server.ts", "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;"), ["reserved-path:auth"], "the probe's request guard holds whatever it changes");
  assert.deepEqual(patched("src/pylon-vm/runtime.ts", "@@ -190,3 +190,4 @@ export class SandboxRuntime {\n \t\t\t...network,\n+\t\t\tvfs: { mounts: { \"/root/.config\": new RealFSProvider(homedir()) } },"), ["reserved-path:egress"], "host files mounted into the guest, where the VM is built");
  assert.deepEqual(patched("src/pylon-vm/relay.ts", "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", "src/pylon-vm/relay.test.ts"), ["reserved-path:egress", "reserved-path:auth"], "a test renamed into code that ships brings a body its patch does not show, so it holds as a file with no patch does");
  assert.deepEqual(patched("src/pylon-vm/relay.ts", "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", "docs/verification/relay.ts"), ["reserved-path:egress", "reserved-path:auth"], "so does code moved in from where nothing held it");
  assert.deepEqual(patched("src/pylon-vm/relay.test.ts", "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", "src/pylon-vm/old.test.ts"), [], "a test renamed to a test is still a test");
  assert.deepEqual(headHolds({ review, deploys: true, files: [{ path: "src/pylon-vm/client.ts", previous: null, patch: "" }, { path: "src/control/api/sse.ts", previous: null, patch: "" }] }).map((h) => h.code),
    ["reserved-path:egress", "reserved-path:auth"], "a file GitHub shows no patch for may change anything");
});

test("the code that enforces the policy, the dependency manifests and what the checks run hold the landing, while docs and tests still hold for nothing", () => {
  const review = testReview({ builder: "th-b" as ThreadId, reviewer: "th-r" as ThreadId, pr: { repo: "ramtinJ95/nexus", number: 199, url: "", title: "", branch: "f" }, models: { builder: "a", reviewer: "b" }, maxRounds: 3, phase: { kind: "approved" },
    rounds: [{ head: head1, verdict: { token: "x", verdict: "approve", findings: [], reserved: [], notCheckedLive: null }, check: { passed: true, output: "" }, live: { kind: "absent" }, answers: null }] });
  const changed = (path: string, patch = "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", deploys = true) => headHolds({ review, deploys, files: [{ path, previous: null, patch }] }).map((h) => h.text);
  for (const path of ["src/control/review.ts", "src/control/review-model.ts", "src/control/gate.ts", "src/control/landing.ts", "src/control/github.ts", "src/control/prompts.ts"]) {
    assert.deepEqual(changed(path), [`Always needs the person: changes to login or auth, as it changes ${path}.`], `${path} enforces the policy`);
  }
  assert.deepEqual(changed("package-lock.json", '@@ -10,3 +10,3 @@\n-      "version": "8.22.0",\n+      "version": "8.22.1",'), ["Always needs the person: changes to secrets, as it changes package-lock.json."], "a release installs the lockfile as root");
  const secrets = ["Always needs the person: changes to secrets, as it changes package.json."];
  // A hunk does not show how deep in the JSON its lines are, so no reading of one proves a line outside scripts and the dependencies.
  for (const patch of [
    '@@ -9,3 +9,4 @@\n   "scripts": {\n+    "postinstall": "sh evil.sh",\n     "build": "node src/control/dashboard/build.ts",',
    '@@ -30,3 +30,4 @@\n     "@earendil-works/chord": "1.4.0",\n+    "left-pad": "1.3.0",\n     "@earendil-works/gondolin": "0.13.0",',
    '@@ -7,6 +7,7 @@\n     "node": ">=26"\n   },\n   "scripts": {\n+  "postinstall": "sh evil.sh",\n     "build": "node src/control/dashboard/build.ts",',
    '@@ -42,4 +42,5 @@\n   "overrides": {\n     "undici": "7.30.1"\n   },\n+  "description": "x", "scripts": { "postinstall": "sh evil.sh" },\n }',
    '@@ -1,4 +1,4 @@\n {\n   "name": "nexus",\n-  "version": "0.0.0",\n+  "version": "0.0.1",',
  ]) assert.deepEqual(changed("package.json", patch), secrets, patch);
  for (const path of ["npm-shrinkwrap.json", ".npmrc", "src/control/dashboard/build.ts", "src/control/dashboard/assets.ts"]) {
    assert.deepEqual(changed(path), [`Always needs the person: changes to secrets, as it changes ${path}.`], `a release's npm ci or npm run build reads or runs ${path} as root`);
  }
  assert.deepEqual(changed("package.json", ""), [...secrets, "Always needs the person: anything irreversible, as it changes package.json."], "a manifest GitHub shows no patch for may change anything");

  const check = (paths: string) => [`The pull request changes ${paths}, the check this policy relies on or what it runs.`];
  assert.deepEqual(changed(".nexus/setup", "@@ -1 +1 @@\n+echo", false), check(".nexus/setup"), "the check pylon runs setup at boot, in any repository");
  assert.deepEqual(changed(".nexus/resume", "@@ -1 +1 @@\n+echo", false), check(".nexus/resume"), "and resume when it boots from a template");
  assert.deepEqual(changed("tsconfig.json"), check("tsconfig.json"), "what Nexus's typecheck reads");
  assert.deepEqual(changed("tsconfig.json", undefined, false), [], "which another repository's check may not read");
  assert.deepEqual(changed(".claude/skills/verify-nexus/scripts/live-check"), ["The pull request changes .claude/skills/verify-nexus/scripts/live-check, the live check this policy relies on or what it runs."]);
  assert.deepEqual(changed(".claude/skills/verify-nexus/scripts/stack.ts"), ["The pull request changes .claude/skills/verify-nexus/scripts/stack.ts, the live check this policy relies on or what it runs."]);
  assert.deepEqual(changed(".nexus/check"), ["The pull request changes .nexus/check, the check this policy relies on."], "the check itself keeps its words");

  for (const path of ["docs/merge-policy.md", "README.md", "src/control/review.test.ts", "src/control/gate.test.ts", ".claude/skills/verify-nexus/SKILL.md", ".claude/skills/verify-nexus/scripts/README.md"]) {
    assert.deepEqual(changed(path), [], `${path} holds for nothing`);
  }
});

test("the policy's review conditions: another model, an approval with no P0 to P2 open, and every blocking finding answered", () => {
  const round = { head: head1, verdict: { token: "x", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: "the cache under real traffic" }, check: { passed: true, output: "" }, live: { kind: "absent" as const }, answers: null };
  const review = testReview({
    builder: "th-b" as ThreadId, reviewer: "th-r" as ThreadId, pr: { repo: "acme/shop", number: 7, url: "", title: "", branch: "f" }, models: { builder: "m", reviewer: "m" },
    maxRounds: 3, phase: { kind: "checking", startedAt: 0, thread: null },
    rounds: [{ ...round, verdict: { ...round.verdict, verdict: "changes", findings: [{ id: "F1", priority: "P2", summary: "s" }, { id: "F2", priority: "P2", summary: "s" }, { id: "N1", priority: "P3", summary: "s" }] }, answers: [{ id: "F1", action: "rejected", reason: " " }] }, round],
  });
  const pr: PrSnapshot = { pr: testPr({ repo: "acme/shop", number: 7, title: "", url: "", checks: "pending", conflict: true }), detail: { head: head2, branch: "f", base: "main", body: "Not checked live: the cache under real traffic.", mergeCommit: null }, failures: [], comments: [] };
  assert.deepEqual(holdsAt(review, { pr }).map((h) => h.text), [
    "The builder neither fixed nor rejected with a reason finding F1 of round 1.",
    "The builder neither fixed nor rejected with a reason finding F2 of round 1.",
    `The pull request's head is ${head2}, not the approved ${head1}.`,
    "The branch conflicts with its base.",
    "The pull request's GitHub checks are pending.",
    "The reviewer ran the builder's own model, m.",
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [
    `.nexus/check could not run at ${head1}.`,
    "The check's output:\nThe repository has no executable .nexus/check at 1.",
  ] });
  assert.equal(f.sent.length, 1, "neither agent hears of it");
  assert.equal(f.review().rounds.length, 1);
  assert.deepEqual(f.discarded, f.checkThreads);
});

test("a check or live check that cannot check out a commit force-pushed away starts a round on the PR's new head", async (t) => {
  const gone = `The check pylon did not boot: pylon-th-check could not check out its commit on its template's disk: Setup exited 128\nfatal: reference is not a tree: ${head1}`;
  const forcePushed = (f: ReturnType<typeof fixture>) => { f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } }; };

  const f = fixture(t);
  f.check = { kind: "running" };
  await approved(f, null);
  assert.equal(f.review().phase.kind, "checking");
  forcePushed(f);
  f.check = { kind: "unrunnable", output: gone };
  await f.loop().poll();
  assert.equal(f.review().phase.kind, "reviewing", "the check's commit is gone, so no person is asked");
  assert.deepEqual(f.review().rounds.map((r) => r.head), [head1, head2]);
  assert.deepEqual(f.discarded, f.checkThreads);

  const g = fixture(t);
  g.check = { kind: "unrunnable", output: gone };
  const loop = g.loop();
  await loop.start(g.builder, { land: null });
  await loop.poll();
  forcePushed(g);
  g.reply(g.review().reviewer, verdict(g.review(), {}));
  await loop.poll();
  assert.equal(g.review().phase.kind, "reviewing", "the check beside the reviewer could not run at a head the PR left");
  assert.deepEqual(g.review().rounds.map((r) => r.head), [head1, head2]);

  const h = fixture(t);
  h.verifies = true;
  h.live = { kind: "running" };
  await approved(h, null);
  assert.equal(h.review().phase.kind, "verifying");
  forcePushed(h);
  h.live = { kind: "unrunnable", output: gone.replace("check pylon", "verify pylon") };
  await h.loop().poll();
  assert.equal(h.review().phase.kind, "reviewing", "the live check's commit is gone, so no person is asked");
  assert.deepEqual(h.review().rounds.map((r) => r.head), [head1, head2]);
  assert.equal(h.archived.length, 1, "the verify pylon is archived");
});

test("a failed check the builder answers without a push goes to the person at once, not back to the reviewer", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "npm error code SELF_SIGNED_CERT_IN_CHAIN" };
  await approved(f, null);
  assert.equal(f.review().phase.kind, "fixing");
  f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "rejected", reason: "npm cannot reach the registry from the check pylon." }]));
  await f.loop().poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [`.nexus/check failed at ${head1}, and the builder pushed nothing for it: Fixed the test.`, "The check's output:\n1 test failed"] });
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [`.nexus/check failed again at ${head1}, where it failed before.`, "The check's output:\n1 test failed"] });
});

test("in a review stored before priorities, a reviewer's repeat approval of an unchanged head costs no round", async (t) => {
  const f = fixture(t);
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 2 });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { findings: [serious] }));
  await loop.poll();
  // Before priorities, an approval with a serious finding was stored as an approval.
  const stored = f.review();
  f.registry.reviews.saveReview({ ...stored, rounds: [{ ...stored.rounds[0]!, verdict: { ...stored.rounds[0]!.verdict!, verdict: "approve" } }] });
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "rejected", reason: "The cache is rebuilt on every deploy." }]));
  await loop.poll();
  assert.equal(f.review().rounds[1]!.head, head1);
  f.check = { kind: "done", passed: false, output: "1 test failed" };
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing", "the failed check reaches the builder: the approval at the same head spent no round");
  assert.match(f.sent.at(-1)!.message.text, /^Round 1 of at most 2/m);
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.check = { kind: "done", passed: true, output: "ok" };
  f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "fixed", reason: "Fixed the test." }]));
  await loop.poll();
  assert.match(f.sent.at(-1)!.message.text, /^Round 2 of at most 2/m);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
});

test("a landing sees its deploy through, rolling back, though its threads are archived meanwhile", async (t) => {
  const f = fixture(t);
  released(f, previous);
  const loop = await approved(f, "nLAPTOP");
  assert.equal(f.review().phase.kind, "deploying");
  archive(f.registry, f.builder);
  archive(f.registry, f.review().reviewer);
  f.registry.releases.reportRelease({ node, role: "control", commit: previous, target: merged, state: "failed", reason: "unit failed", observedAt: Date.now() });
  await loop.poll();
  assert.equal(f.registry.releases.desiredRelease()?.commit, previous);
  f.registry.releases.reportRelease({ node, role: "control", commit: merged, target: previous, state: "failed", reason: "unit failed again", observedAt: Date.now() });
  await loop.poll();
  assert.match((f.review().phase as { reasons: string[] }).reasons[1]!, /^The rollback to p{40} failed too: node control failed \(unit failed again\)/, "a failed rollback says so");
});

test("a PR that merged at another head than the approved one is not deployed", async (t) => {
  const f = fixture(t);
  released(f, previous);
  f.mergeAnswer = () => ({ kind: "refused", message: "unused" });
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, head: head2, mergeCommit: merged } };
  await loop.poll();
  assert.equal(f.registry.releases.desiredRelease()?.commit, previous);
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
  assert.equal(f.registry.reviews.isReviewer(first), true);
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
  assert.deepEqual(f.registry.threads.events("0", { kinds: ["review.changed"] }).map((e) => (e.payload.phase as { kind: string }).kind).slice(0, 4), ["reviewing", "checking", "verifying", "merging"]);

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
  assert.deepEqual(shown(g.review().phase), { kind: "needs-person", reasons: ["No live check ran, and the pull request does not say what could not be checked live."] });
});

test("a landing stored before live checks, whose head has a .nexus/verify, is held until a landing runs its live check", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  const { live: _, ...unverified } = f.review().rounds[0]!;
  f.registry.reviews.saveReview({ ...f.review(), land: { requestedBy: "nLAPTOP" }, rounds: [unverified], phase: { kind: "merging", authorized: null } });
  f.verifies = true;
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [`The live check has not run at ${head1}.`] });
  loop.land(f.builder, "nLAPTOP");
  await loop.poll();
  assert.equal(f.liveThreads.length, 1, "landing again ran the live check");
  assert.deepEqual(f.merges, [head1]);
});

test("a verify pylon the person unarchives stays open, after its verdict, after its review is replaced, or after it timed out", async (t) => {
  const unarchive = (f: ReturnType<typeof fixture>, id: ThreadId) => { f.registry.threads.setThreadStatus(id, "active"); f.registry.threads.recordActivity(id, { human: 2 }); };
  const f = fixture(t);
  f.verifies = true;
  const loop = await approved(f, null);
  assert.deepEqual(f.archived, f.liveThreads);
  unarchive(f, f.liveThreads[0]!);
  await loop.poll();
  f.registry.reviews.saveReview({ ...f.review(), id: "rv-next", rounds: [{ head: head2, verdict: null, check: null, answers: null }], phase: { kind: "approved" } });
  await loop.poll();
  assert.equal(f.registry.threads.thread(f.liveThreads[0]!)!.status, "active", "the review that recorded it is gone");
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
  assert.equal(g.registry.threads.thread(g.liveThreads[0]!)!.status, "active");
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
  assert.throws(() => loop.land(f.builder, "nLAPTOP"), { kind: "conflict" });
  f.reply(f.builder, answers(f.review(), [{ id: "LIVE", action: "rejected", reason: "The stack is flaky." }]));
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [
    `The live check failed at ${head1}, and the builder pushed nothing for it: The stack is flaky.`,
    "The live check's output:\nverify-nexus: the thread never reported running",
  ] });
  assert.throws(() => loop.land(f.builder, "nLAPTOP"), { kind: "conflict", message: /not approved with its checks passing/ });
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
  assert.deepEqual(shown(g.review().phase), { kind: "needs-person", reasons: [
    `The live check gave no verdict within 60 minutes at ${head1}.`,
    "No node could take its verify pylon: no node can run this pylon: infra-testbench cannot give a pylon KVM of its own: its probe does not report nested virtualization",
  ] });
});

test("a verify pylon no node has room for waits past the live check's hour, starts once room frees, and its hour counts from that start", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.liveRoom = false;
  f.live = { kind: "running" };
  const loop = await approved(f, "nLAPTOP");
  f.tick(90 * 60_000);
  await loop.poll();
  assert.equal(f.review().phase.kind, "verifying", "a wait for room is no stop for the person");
  const { startedAt: _, ...waiting } = f.review().phase as Extract<Review["phase"], { kind: "verifying" }>;
  assert.deepEqual(waiting, { kind: "verifying", thread: null, refused: "no node can run this pylon: node is overcommitted", room: true });
  assert.deepEqual(f.liveThreads, []);
  f.liveRoom = true;
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "verifying", startedAt: f.now, thread: f.liveThreads[0] }, "room that frees starts the live check");
  f.tick(59 * 60_000);
  await loop.poll();
  assert.equal(f.review().phase.kind, "verifying", "the live check's hour counts from its pylon's start");
  f.live = { kind: "done", passed: true, output: "fleet ok" };
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
});

/**
 * Another builder in `f`'s project with PR `number` at `head2`, whose review the person starts with `land`, or the
 * project's setting starts on its own.
 */
async function otherBuilder(f: ReturnType<typeof fixture>, loop: ReturnType<ReturnType<typeof fixture>["loop"]>, id: string, number: number, start: "person" | "auto") {
  const builder = f.add(id, true);
  const pr = { ...f.pr, number, url: `https://github.com/ramtinJ95/nexus/pull/${number}` };
  f.registry.prWatches.savePrWatch(builder, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  f.others.set(number, { ...f.snapshot, pr: { ...pr }, detail: { ...f.snapshot.detail, head: head2, branch: id } });
  if (start === "person") await loop.start(builder, { land: "nLAPTOP" });
  else await loop.auto(f.registry.threads.thread(builder)!, pr);
  return builder;
}
const reviewOf = (f: ReturnType<typeof fixture>, builder: ThreadId) => f.registry.reviews.review(builder)!;
const behindVerify = (builder: string, pr: number) => `waits for ${builder}: PR #${pr}'s verify pylon waits for a node to have room, which goes to it first`;

test("a verify pylon that waits for room gets the room that frees before another review's reviewer or check that asked later, which start once it has it", async (t) => {
  const f = fixture(t, { autoReview: { mode: "review", enabledBy: "nLAPTOP" } });
  f.verifies = true;
  f.live = { kind: "running" };
  f.liveRoom = false;
  const loop = await approved(f, "nLAPTOP");
  f.check = { kind: "running" };
  const checked = await otherBuilder(f, loop, "th-builder-2", 8, "person");
  await loop.poll();
  assert.equal(reviewOf(f, checked).phase.kind, "reviewing");
  // From here the node frees memory 4 GiB at a time, half a verify pylon.
  f.liveRoom = true;
  f.freeGiB = 4;
  f.placed.length = 0;
  f.forgetChecks();
  const auto = await otherBuilder(f, loop, "th-builder-3", 9, "auto");
  await loop.poll();
  assert.equal(f.review().phase.kind, "verifying");
  assert.deepEqual(f.placed, [], "neither the check that starts again nor the reviewer of a later review takes the room");
  assert.match(reviewSaidText(reviewOf(f, checked)), new RegExp(`its check ${behindVerify(f.builder, 7)}`));
  assert.match(reviewSaidText(reviewOf(f, auto)), new RegExp(`its reviewer ${behindVerify(f.builder, 7)}`));
  f.free(4);
  await loop.poll();
  assert.equal(f.placed[0], `verify pylon of ${f.builder}`, "the verify pylon fits once the second piece of room frees");
  f.free(4);
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.placed, [`verify pylon of ${f.builder}`, `check of ${checked}`, `reviewer of ${auto}`], "the held reviews start once the gate has its pylon");
  assert.equal(reviewOf(f, auto).reviewerStarted, true);
  assert.doesNotMatch(reviewSaidText(reviewOf(f, checked)) + reviewSaidText(reviewOf(f, auto)), /waits for th-builder:/);
});

test("verify pylons that wait for room start in the order they began to wait, and a held one keeps its place and has no deadline", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.live = { kind: "running" };
  f.liveRoom = false;
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  const earlier = await otherBuilder(f, loop, "th-builder-2", 8, "person");
  await loop.poll();
  await loop.poll();
  f.reply(reviewOf(f, earlier).reviewer, verdict(reviewOf(f, earlier), {}));
  await loop.poll();
  assert.equal(reviewOf(f, earlier).phase.kind, "verifying");
  f.tick(60_000);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "verifying", "the later wait, whose review the loop steps first");
  f.liveRoom = true;
  f.freeGiB = 8;
  f.placed.length = 0;
  await loop.poll();
  assert.deepEqual(f.placed, [`verify pylon of ${earlier}`], "the room goes to the wait that began first");
  assert.match(reviewSaidText(f.review()), new RegExp(`its live check ${behindVerify(earlier, 8)}`));
  f.tick(90 * 60_000);
  await loop.poll();
  assert.equal(f.review().phase.kind, "verifying", "a held live check is no stop for the person");
  f.free(8);
  await loop.poll();
  assert.deepEqual(f.placed, [`verify pylon of ${earlier}`, `verify pylon of ${f.builder}`]);
});

test("a check held behind another review's wait has no deadline, and starts once that wait ends", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.live = { kind: "running" };
  f.liveRoom = false;
  const loop = f.loop();
  const earlier = await otherBuilder(f, loop, "th-builder-2", 8, "person");
  await loop.poll();
  f.reply(reviewOf(f, earlier).reviewer, verdict(reviewOf(f, earlier), {}));
  await loop.poll();
  assert.equal(reviewOf(f, earlier).phase.kind, "verifying");
  f.tick(1_000);
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "checking");
  f.tick(2 * 60 * 60_000);
  await loop.poll();
  assert.equal(f.review().phase.kind, "checking", "a held check is no stop for the person");
  assert.match(reviewSaidText(f.review()), new RegExp(`its check ${behindVerify(earlier, 8)}`));
  f.liveRoom = true;
  f.placed.length = 0;
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.placed.slice(0, 2), [`verify pylon of ${earlier}`, `check of ${f.builder}`]);
  assert.notEqual(f.review().phase.kind, "needs-person");
});

test("a gate's wait holds neither its own review's steps, nor the person's review, and a refusal room cannot end holds nothing", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken, autoReview: { mode: "review", enabledBy: "nLAPTOP" } });
  f.failStart = (request) => request.model === "claude-opus-5-5" ? "the harness is unreachable" : null;
  f.checkRoom = false;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(checkBeside(f.review()), ", .nexus/check waits for a node to have room for it: no node has room for this pylon: node is overcommitted");
  assert.equal(f.review().second?.kind, "starting");
  f.failStart = () => null;
  f.tick(61_000);
  await loop.poll();
  assert.equal(f.review().second?.kind, "claude", "the review's own wait does not hold its second reviewer");

  const person = await otherBuilder(f, loop, "th-builder-2", 8, "person");
  await loop.poll();
  assert.equal(reviewOf(f, person).reviewerStarted, true, "a review the person started does not wait for its reviewer");
  assert.equal(reviewOf(f, person).second?.kind, "starting", "its second reviewer, which the loop starts, waits");
  assert.match(reviewSaidText(reviewOf(f, person)), /its second reviewer waits for th-builder: PR #7's check thread waits for a node to have room, which goes to it first/);

  f.checkRoom = true;
  f.checkRefused = "no node can run this pylon: node is offline";
  f.forgetChecks();
  const auto = await otherBuilder(f, loop, "th-builder-3", 9, "auto");
  await loop.poll();
  await loop.poll();
  assert.equal(reviewOf(f, auto).reviewerStarted, true, "a check refused for what room cannot end is no wait, so nothing waits behind it");
  assert.equal(reviewOf(f, person).second?.kind, "claude");
});

test("a verify pylon that waits for room keeps its place when a start fails other than by a refusal", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.live = { kind: "running" };
  f.liveRoom = false;
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  const earlier = await otherBuilder(f, loop, "th-builder-2", 8, "person");
  await loop.poll();
  await loop.poll();
  f.reply(reviewOf(f, earlier).reviewer, verdict(reviewOf(f, earlier), {}));
  await loop.poll();
  f.tick(60_000);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "verifying");
  f.liveRoom = true;
  f.freeGiB = 8;
  f.liveStartFails = 1;
  f.placed.length = 0;
  await loop.poll();
  assert.deepEqual(f.placed, [], "the start failed");
  assert.equal((reviewOf(f, earlier).phase as { room?: true }).room, true, "the wait keeps its room flag");
  await loop.poll();
  assert.deepEqual(f.placed, [`verify pylon of ${earlier}`], "and its place ahead of the later wait");
});

test("a live check held before it tried keeps its place, so a later one the loop steps first does not pass it", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.live = { kind: "running" };
  f.liveRoom = false;
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  const later = await otherBuilder(f, loop, "th-builder-2", 8, "person");
  const earlier = await otherBuilder(f, loop, "th-builder-3", 9, "person");
  await loop.poll();
  await loop.poll();
  for (const builder of [f.builder, earlier, later]) {
    f.reply(reviewOf(f, builder).reviewer, verdict(reviewOf(f, builder), {}));
    await loop.poll();
    assert.equal(reviewOf(f, builder).phase.kind, "verifying");
  }
  assert.match(reviewSaidText(reviewOf(f, later)), new RegExp(`its live check ${behindVerify(f.builder, 7)}`));
  f.liveRoom = true;
  f.freeGiB = 16;
  f.placed.length = 0;
  await loop.poll();
  assert.deepEqual(f.placed, [`verify pylon of ${f.builder}`, `verify pylon of ${earlier}`]);
});

test("a second reviewer held with its review's first keeps its 30 minutes for after the hold", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken, autoReview: { mode: "review", enabledBy: "nLAPTOP" } });
  f.checkRoom = false;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const auto = await otherBuilder(f, loop, "th-builder-2", 8, "auto");
  await loop.poll();
  assert.equal(reviewOf(f, auto).reviewerStarted, false);
  f.tick(31 * 60_000);
  f.checkRoom = true;
  f.failStart = (request) => request.model === "claude-opus-5-5" && request.title.startsWith("Second review of #8") ? "the harness is unreachable" : null;
  await loop.poll();
  await loop.poll();
  assert.equal(reviewOf(f, auto).reviewerStarted, true);
  assert.equal(reviewOf(f, auto).second?.kind, "starting", "a failed start right after the hold is tried again");
});

/** `f`'s own review approved with its live check waiting for room, in `f`'s loop. */
async function verifyWaits(f: ReturnType<typeof fixture>) {
  f.verifies = true;
  f.live = { kind: "running" };
  f.liveRoom = false;
  const loop = await approved(f, "nLAPTOP");
  assert.equal(f.review().phase.kind, "verifying");
  f.tick(1_000);
  return loop;
}

test("a check held beside the reviewer keeps its place in line through the reviewer's approval", async (t) => {
  const f = fixture(t);
  const loop = await verifyWaits(f);
  const earlier = await otherBuilder(f, loop, "th-builder-3", 9, "person");
  await loop.poll();
  f.tick(1_000);
  const later = await otherBuilder(f, loop, "th-builder-2", 8, "person");
  await loop.poll();
  f.reply(reviewOf(f, earlier).reviewer, verdict(reviewOf(f, earlier), {}));
  await loop.poll();
  assert.equal(reviewOf(f, earlier).phase.kind, "checking");
  f.liveRoom = true;
  f.placed.length = 0;
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.placed.slice(0, 3), [`verify pylon of ${f.builder}`, `check of ${earlier}`, `check of ${later}`]);
});

test("a check beside the reviewer that waits for room keeps its place in line through the reviewer's approval", async (t) => {
  const f = fixture(t);
  f.checkRoom = false;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.tick(1_000);
  const later = await otherBuilder(f, loop, "th-builder-2", 8, "person");
  await loop.poll();
  assert.match(reviewSaidText(reviewOf(f, later)), /its check waits for th-builder: PR #7's check thread waits for a node to have room/);
  f.placed.length = 0;
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.placed, [`check of ${f.builder}`], "the approved head's check, which never waits for room, starts in the place its wait had");
  assert.equal(f.review().phase.kind, "approved");
});

test("a held start that fails once let through ends its hold, so it holds no other start and its deadline runs", async (t) => {
  const f = fixture(t, { autoReview: { mode: "review", enabledBy: "nLAPTOP" } });
  const loop = await verifyWaits(f);
  const checked = await otherBuilder(f, loop, "th-builder-2", 8, "person");
  await loop.poll();
  f.reply(reviewOf(f, checked).reviewer, verdict(reviewOf(f, checked), {}));
  await loop.poll();
  assert.match(reviewSaidText(reviewOf(f, checked)), new RegExp(`its check ${behindVerify(f.builder, 7)}`));
  const auto = await otherBuilder(f, loop, "th-builder-3", 9, "auto");
  await loop.poll();
  assert.equal(reviewOf(f, auto).reviewerStarted, false);
  f.checkStartFails = true;
  f.liveRoom = true;
  await loop.poll();
  assert.doesNotMatch(reviewSaidText(reviewOf(f, checked)), /waits for th-builder:/);
  assert.equal(reviewOf(f, auto).reviewerStarted, true, "a start that failed holds nothing");
  assert.ok(f.logged.some((line) => line.includes(`of ${checked}: a check that waited in line did not start and will be tried again`)), "the failure is logged");
  f.tick(61 * 60_000);
  await loop.poll();
  assert.deepEqual(shown(reviewOf(f, checked).phase), { kind: "needs-person", reasons: [`.nexus/check gave no verdict within 60 minutes at ${head2}.`] });
});

test("a live check its pylon cannot run goes to the person, and a verify pylon no review holds is archived", async (t) => {
  const f = fixture(t);
  f.verifies = true;
  f.live = { kind: "unrunnable", output: "The verify pylon did not boot: This pylon asked for nested virtualization, and its guest has no /dev/kvm." };
  await approved(f, "nLAPTOP");
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [
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
  assert.deepEqual(holdsAt(review, { pr }), [
    { code: "open-findings", text: "Findings P0 to P2 are open: LIVE." },
    { code: "unanswered", text: "The builder neither fixed nor rejected with a reason finding LIVE of round 1." },
    { code: "live-failed", text: `The live check failed at ${head1}.` },
    { code: "verify-changed", text: "The pull request changes .nexus/verify, the live check this policy relies on." },
  ]);
  assert.equal(holdRule("live-failed").waivable, false);
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

test("the check runs beside the reviewer, and the round goes on once both are in, whichever comes first", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.deepEqual(f.review().rounds[0]!.check, { passed: true, output: "ok" }, "the check gave its result before the reviewer");
  assert.deepEqual(f.discarded, f.checkThreads);
  assert.equal(checkBeside(f.review()), `, .nexus/check passed at ${head1.slice(0, 12)}`);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.deepEqual(f.checkHeads, [head1], "the approval runs no check of its own");

  const g = fixture(t);
  g.check = { kind: "running" };
  const slow = g.loop();
  await slow.start(g.builder, { land: null });
  await slow.poll();
  assert.equal(checkBeside(g.review()), `, .nexus/check running at ${head1.slice(0, 12)} in check thread ${g.checkThreads[0]}`);
  g.reply(g.review().reviewer, verdict(g.review(), {}));
  await slow.poll();
  const phase = g.review().phase;
  assert.ok(phase.kind === "checking" && phase.thread === g.checkThreads[0], "the verdict waits on the check already running");
  assert.equal(checkBeside(g.review()), "");
  g.check = { kind: "done", passed: true, output: "ok" };
  await slow.poll();
  assert.deepEqual(g.review().phase, { kind: "approved" });
  assert.deepEqual(g.checkHeads, [head1]);
  assert.deepEqual(g.discarded, g.checkThreads);
});

test("a check that fails beside the reviewer reaches the builder only once the reviewer approves", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "1 test failed" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "the reviewer's verdict is still owed");
  assert.deepEqual(f.review().rounds[0]!.check, { passed: false, output: "1 test failed" });
  assert.equal(f.sent.length, 1);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  assert.match(f.sent.at(-1)!.message.text, /CHECK \(P0\) \.nexus\/check: \.nexus\/check failed at 1{40}\n {4}1 test failed/);
  assert.deepEqual(f.checkHeads, [head1]);
});

test("a reviewer that asks for changes while the check runs stops the check, and the fixed head gets its own", async (t) => {
  const f = fixture(t);
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const first = f.checkThreads[0]!;
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  assert.deepEqual(f.discarded, [first], "the check of a head the builder will move is stopped");
  assert.equal(f.registry.threads.thread(first)!.status, "deleted");
  assert.doesNotMatch(f.sent.at(-1)!.message.text, /CHECK/);
  f.check = { kind: "done", passed: false, output: "1 test failed" };
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  await loop.poll();
  assert.equal(f.review().rounds[0]!.check, null, "the stopped check reports nothing");
  assert.deepEqual(f.checkHeads, [head1, head2]);
  assert.deepEqual(f.review().rounds[1]!.check, { passed: false, output: "1 test failed" });
  assert.equal(f.review().phase.kind, "reviewing");
});

test("a builder that pushes nothing for the reviewer's changes gets a round at the same head with no second check", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.deepEqual(f.review().rounds[0]!.check, { passed: true, output: "ok" }, "the check finished before the reviewer asked for changes");
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "rejected", reason: "The cache is rebuilt on every deploy." }]));
  await loop.poll();
  assert.equal(f.review().rounds[1]!.head, head1);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.deepEqual(f.checkHeads, [head1], "head1 was checked beside the first round");
});

test("a check that cannot start beside the reviewer leaves the reviewer's reminders running, and starts once the reviewer approves", async (t) => {
  const f = fixture(t);
  f.checkStartFails = true;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, "I looked and it seems fine.");
  await loop.poll();
  assert.match(f.sent.at(-1)!.message.text, /no nexus-review block/);
  assert.equal(f.review().nudges, 1);
  assert.deepEqual(f.logged, [`review ${f.review().id} of ${f.builder}: the check beside the reviewer did not start and will be tried again (Error)`], "the passes it failed in log it once");
  f.checkStartFails = false;
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.deepEqual(f.checkHeads, [head1]);
});

test("a check start refused once the reviewer approves leaves the review checking, and the next pass starts it and approves", async (t) => {
  const f = fixture(t);
  f.checkRefused = "no image is current yet, so a pylon has nothing to boot";
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "checking");
  assert.equal((f.review().phase as { thread: ThreadId | null }).thread, null, "no check thread started");
  assert.deepEqual(f.checkThreads, []);
  f.checkRefused = null;
  await loop.poll();
  assert.deepEqual(f.checkHeads, [head1]);
  assert.deepEqual(f.review().phase, { kind: "approved" }, "the check that started passed");
});

test("a check that finished as the reviewer asked for changes keeps its result for a round at the same head", async (t) => {
  const f = fixture(t);
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.check = { kind: "done", passed: true, output: "ok" };
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  assert.deepEqual(f.review().rounds[0]!.check, { passed: true, output: "ok" });
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "rejected", reason: "The cache is rebuilt on every deploy." }]));
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.deepEqual(f.checkHeads, [head1]);
});

test("a head the branch returns to keeps the check an earlier round ran there", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  for (const head of [head2, head1]) {
    f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
    await loop.poll();
    f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head } };
    f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
    await loop.poll();
  }
  assert.deepEqual(f.review().rounds.map((r) => r.head), [head1, head2, head1]);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.deepEqual(f.checkHeads, [head1, head2], "head1 was checked in the first round");
});

test("a check beside the reviewer starts only where a node has room, and otherwise once room frees or the reviewer approves", async (t) => {
  const f = fixture(t);
  f.checkRoom = false;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.deepEqual(f.checkThreads, [], "no check pylon the node cannot hold");
  assert.equal(checkBeside(f.review()), ", .nexus/check waits for a node to have room for it: no node has room for this pylon: node is overcommitted");
  f.checkRoom = true;
  await loop.poll();
  assert.deepEqual(f.checkIfRoom, [true], "room that frees while the reviewer reads starts the check beside it");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.deepEqual(f.checkHeads, [head1]);

  const h = fixture(t);
  h.checkRoom = false;
  await approved(h, null);
  assert.deepEqual(h.review().phase, { kind: "approved" });
  assert.deepEqual(h.checkIfRoom, [false], "a check still refused at the verdict starts as it always did");

  const g = fixture(t);
  await approved(g, null);
  assert.deepEqual(g.checkIfRoom, [true], "the check beside the reviewer asks for room");
});

test("a check the pylon cannot run beside the reviewer says so, is not run again after a restart, and goes to the person on the approval", async (t) => {
  const f = fixture(t);
  f.check = { kind: "unrunnable", output: "The repository has no executable .nexus/check at 1." };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(checkBeside(f.review()), `, .nexus/check could not run at ${head1.slice(0, 12)}`);
  assert.deepEqual(f.discarded, f.checkThreads);
  f.forgetChecks();
  const restarted = f.loop();
  await restarted.poll();
  assert.equal(f.checkThreads.length, 1, "a fresh pylon would fail the same way");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await restarted.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [`.nexus/check could not run at ${head1}.`, "The check's output:\nThe repository has no executable .nexus/check at 1."] });
  assert.equal(f.sent.length, 1, "neither agent hears of it");
});

test("a check that passed while the reviewer reads says the live check waits for the approval", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(liveNote(f.review()), `no live check yet: it runs at ${head1.slice(0, 12)} once the reviewer approves it`);
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  assert.equal(liveNote(f.review()), `no live check yet: it runs at ${head1.slice(0, 12)} once the reviewer approves it`);
  const g = fixture(t);
  await approved(g, null);
  assert.equal(liveNote(g.review()), `no live check: ${head1.slice(0, 12)} has no .nexus/verify, so the landing reads the pull request's statement of what could not be checked live`);
});

test("a check beside the reviewer is not started for a pull request GitHub says merged, ahead of the PR watch", async (t) => {
  const f = fixture(t);
  f.checkStartFails = true;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.checkStartFails = false;
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, mergeCommit: merged } };
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "merged" });
  assert.deepEqual(f.checkThreads, []);
});

test("a check that failed beside a request for changes reaches the builder with the findings", async (t) => {
  const f = fixture(t);
  f.check = { kind: "done", passed: false, output: "src/cache.ts(1,1): error TS2322" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  const text = f.sent.at(-1)!.message.text;
  assert.match(text, /F1 \(P1\)/);
  assert.match(text, /\.nexus\/check also failed at 1{40} while the reviewer read it\. It needs no answer, but fix it in the same push\. Its output:\nsrc\/cache\.ts\(1,1\): error TS2322/);
  assert.doesNotMatch(text, /CHECK \(P0\)/, "the reviewer's changes are what the builder answers");
});

test("a request for changes stops a check whose pylon has not run it, without starting it", async (t) => {
  const f = fixture(t);
  f.check = { kind: "waiting" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  const stepped = f.steps.length;
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  assert.equal(f.steps.length, stepped, "the stopped check was not stepped, so it opened no run");
  assert.deepEqual(f.discarded, f.checkThreads);
});

test("a review that ends while the reviewer reads throws its check thread away", async (t) => {
  const endings: [string, (f: ReturnType<typeof fixture>) => Promise<void>][] = [
    ["out of rounds", async (f) => f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }))],
    ["reviewer silent", async (f) => { for (let i = 0; i < 3; i++) { f.reply(f.review().reviewer, "I looked and it seems fine."); await f.loop().poll(); } }],
    ["pull request closed", async (f) => f.watched("closed")],
  ];
  for (const [kind, ending] of endings) {
    const f = fixture(t);
    f.check = { kind: "running" };
    const loop = f.loop();
    await loop.start(f.builder, { land: null, rounds: 1 });
    await loop.poll();
    assert.equal(f.checkThreads.length, 1, kind);
    await ending(f);
    await loop.poll();
    assert.ok(ended(f.review()), `${kind}: ${f.review().phase.kind}`);
    assert.deepEqual(f.discarded, f.checkThreads, `${kind}: the check thread goes with the review`);
  }
});

test("a head that moves while the reviewer and the check run gets its own round and its own check", async (t) => {
  const f = fixture(t);
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "checking");
  f.check = { kind: "done", passed: true, output: "ok" };
  await loop.poll();
  assert.equal(f.review().rounds.length, 2);
  assert.deepEqual(f.review().rounds.map((r) => [r.head, r.check]), [[head1, { passed: true, output: "ok" }], [head2, { passed: true, output: "ok" }]]);
  assert.deepEqual(f.checkHeads, [head1, head2], "each head's check ran at that head");
  assert.equal(f.review().phase.kind, "reviewing");
  assert.deepEqual(f.merges, []);
});

test("a restart while the reviewer reads keeps a check that gave its result, and starts again only one that had not", async (t) => {
  const f = fixture(t);
  const crashed = f.loop();
  await crashed.start(f.builder, { land: null });
  await crashed.poll();
  assert.deepEqual(f.review().rounds[0]!.check, { passed: true, output: "ok" });
  f.forgetChecks();
  const restarted = f.loop();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await restarted.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.deepEqual(f.checkHeads, [head1], "the head checked before the restart is not checked again");

  const g = fixture(t);
  g.check = { kind: "running" };
  const lost = g.loop();
  await lost.start(g.builder, { land: null });
  await lost.poll();
  g.forgetChecks();
  const again = g.loop();
  await again.poll();
  assert.deepEqual(g.discarded, [g.checkThreads[0]], "the run the restart lost gives no verdict, so its thread goes");
  const phase = g.review().phase;
  assert.ok(phase.kind === "reviewing" && phase.check?.thread === g.checkThreads[1]);
  g.reply(g.review().reviewer, verdict(g.review(), {}));
  g.check = { kind: "done", passed: true, output: "ok" };
  await again.poll();
  assert.deepEqual(g.review().phase, { kind: "approved" });
  assert.deepEqual(g.checkHeads, [head1, head1], "one run at the head gave a verdict");
  assert.deepEqual(g.discarded, g.checkThreads);
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
  const dir = await tempDir("nexus-review-", t);
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
  assert.deepEqual(shown(g.review().phase), { kind: "needs-person", reasons: ["The pull request's GitHub checks are failed."] });
});

test("a landing whose head's checks GitHub could not read neither merges nor goes to the person, and the next complete read merges", async (t) => {
  const f = fixture(t);
  f.mergeAnswer = () => { throw new Error("GitHub is down"); };
  const loop = await approved(f, "nLAPTOP");
  assert.equal(f.review().phase.kind, "merging");
  const phase = f.review().phase;
  f.mergeAnswer = () => ({ kind: "merged", commit: merged });
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, checks: "pending" }, checksUnread: true };
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "only the attempt before the unread checks");
  assert.deepEqual(f.review().phase, phase);
  const { checksUnread: _, ...complete } = f.snapshot;
  f.snapshot = { ...complete, pr: { ...complete.pr, checks: "passing" } };
  await loop.poll();
  assert.deepEqual(f.merges, [head1, head1]);
  assert.notEqual(f.review().phase.kind, "merging");
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
  released(f, previous);
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
  assert.equal(f.registry.releases.desiredRelease()?.commit, previous, "nothing was deployed");
  const reasons = (f.review().phase as { reasons: string[] }).reasons;
  assert.equal(reasons[0], "Pull request #7 was merged outside this review, so it is not deployed.");
  assert.ok(reasons.some((r) => r.startsWith("A Claude reviewer approved it")));
  assert.ok(reasons.some((r) => r.startsWith("Always needs the person: pylon image rebuilds")));
});

test("a PR merged outside the review that the policy would have merged deploys", async (t) => {
  const f = fixture(t);
  released(f, previous);
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
  assert.equal(f.registry.releases.desiredRelease()?.commit, merged);
});

test("this review's own merge, recorded before the merge call, deploys after a crash without being judged again", async (t) => {
  const f = fixture(t);
  released(f, previous);
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
  assert.equal(f.registry.releases.desiredRelease()?.commit, merged);
});

const labelStates = (f: ReturnType<typeof fixture>) => f.registry.threads.events("0", { kinds: ["review.changed"] }).map((e) => (e.payload.phase as { label?: { state: string } }).label?.state).filter((s) => s !== undefined);

async function labelsOnceAcrossRetries(f: ReturnType<typeof fixture>, loop: ReturnType<ReturnType<typeof fixture>["loop"]>, exhaust: () => void, ...reasons: string[]) {
  f.labelAnswer = (name) => { f.labels.add(name); throw new Error("connection reset"); };
  exhaust();
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons, label: { state: "adding" } }, "a failed call leaves the label to add at the next pass");
  f.labelAnswer = (name) => { f.labels.add(name); return { kind: "labelled" }; };
  await loop.poll();
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons, label: { state: "added" } });
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
  saveOlder(f, { ...r, maxRounds: 10, phase: { kind: phase }, rounds: [round("a".repeat(40)), round("b".repeat(40)), round("c".repeat(40)), round("d".repeat(40)), last] });
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["The reviewer still requests changes after 5 rounds, the most this review allows."], label: { state: "added" } });
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
  assert.deepEqual(shown(f.review().phase), phase);
  assert.deepEqual(shown(f.registry.threads.events("0", { kinds: ["review.changed"] }).at(-1)!.payload.phase as Review["phase"]), phase, "the event log says the label could not be added");
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
  assert.ok(toBuilder[0]!.startsWith(senders.review.prefix));
  assert.match(toBuilder[0]!, new RegExp(`approved pull request #7 \\(.*\\) at ${head1} in round 1`));
  assert.match(toBuilder[0]!, /N1 \(P3\) src\/cache\.ts:1: Name the constant/);
  assert.match(toBuilder[0]!, /Do not push to this pull request's branch/);
  assert.doesNotMatch(toBuilder[0]!, /nexus-review-answers/);
  assert.deepEqual(f.registry.threads.events("0", { kinds: ["review.changed"] }).map((e) => (e.payload.phase as { kind: string }).kind), ["reviewing", "checking", "approved"], "no fixing round");
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", label: { state: "added" }, reasons: [
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
  g.checkStartFails = true;
  const loop = g.loop();
  await loop.start(g.builder, { land: null });
  await loop.poll();
  g.checkStartFails = false;
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

test("an approved review whose PR the watch reads as closed or merged outside it is not landed", async (t) => {
  for (const state of ["closed", "merged"] as const) {
    const f = fixture(t);
    const loop = await approved(f, null);
    assert.equal(f.review().phase.kind, "approved");
    f.watched(state);
    assert.throws(() => loop.land(f.builder, "nLAPTOP"), { kind: "conflict", message: new RegExp(`pull request #\\d+ is ${state} on GitHub outside this review, so there is nothing to land`) });
    assert.equal(f.review().phase.kind, "approved", `a ${state} PR starts no landing`);
  }
});

test("a review that lands still sees a merge made outside it through, and a real failure while the PR is open still asks the person", async (t) => {
  const f = fixture(t);
  released(f, previous);
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
  assert.deepEqual(shown(g.review().phase), { kind: "needs-person", reasons: ["The reviewer gave no answer Nexus could read within 3 hours in round 1."] });
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
  g.registry.threads.setThreadStatus(g.builder, "deleted");
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

test("the person cancels a review that is reviewing, fixing or checking, which archives its reviewer and leaves its builder", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const reviewer = f.review().reviewer;
  const cancelled = loop.cancel(f.builder, "nPHONE");
  assert.deepEqual(cancelled.phase, { kind: "cancelled", who: "person", by: "nPHONE" });
  assert.deepEqual(f.review(), cancelled);
  assert.deepEqual(f.statuses(), ["active", "archived"]);
  assert.deepEqual(f.woken, [reviewer], "the reviewer's pylon pauses at once");
  await loop.poll();
  assert.equal(f.sent.length, 1, "a cancelled review sends nothing more");
  assert.ok(!f.attention().includes("decision"));
  assert.throws(() => loop.cancel(f.builder, "nPHONE"), (err: Refusal) => err.kind === "conflict" && /already ended cancelled/.test(err.message));
  assert.equal((await loop.start(f.builder, { land: null })).phase.kind, "reviewing", "a cancelled review makes way for a new one");

  const g = fixture(t);
  const fixing = g.loop();
  await fixing.start(g.builder, { land: null });
  await fixing.poll();
  g.reply(g.review().reviewer, verdict(g.review(), { verdict: "changes", findings: [serious] }));
  await fixing.poll();
  assert.equal(g.review().phase.kind, "fixing");
  assert.match(String(await fixing.start(g.builder, { land: null }).catch((err: Error) => err.message)), new RegExp(`is fixing. Cancel it with nexus review --cancel ${g.builder} to start another$`));
  fixing.cancel(g.builder, "nPHONE");
  assert.deepEqual(g.review().phase, { kind: "cancelled", who: "person", by: "nPHONE" });
  assert.deepEqual(g.statuses(), ["active", "archived"]);

  const h = fixture(t);
  h.check = { kind: "running" };
  const checking = await approved(h, "nLAPTOP");
  assert.equal(h.review().phase.kind, "checking");
  checking.cancel(h.builder, "nPHONE");
  assert.equal(h.review().phase.kind, "cancelled");
  assert.deepEqual(h.discarded, h.checkThreads, "its check thread goes with it");
  h.check = { kind: "done", passed: true, output: "ok" };
  await checking.poll();
  assert.deepEqual(h.merges, [], "a cancelled landing never merges");
});

test("a review that authorized its merge, is deploying or rolling back, or has ended other than for the person is not cancelled, and says why", async (t) => {
  const f = fixture(t);
  released(f, previous);
  const loop = await approved(f, "nLAPTOP");
  assert.equal(f.review().phase.kind, "deploying");
  const seenThrough = (err: Refusal) => err.kind === "conflict" && /a merge or deploy that has begun is seen through, so it cannot be cancelled/.test(err.message);
  assert.throws(() => loop.cancel(f.builder, "nPHONE"), seenThrough);
  const deploying = f.review();
  for (const phase of [{ kind: "merging", authorized: head1 }, { kind: "rolling-back", commit: merged, previous, why: "failed", requested: true, deadline: 0 }] as const) {
    f.registry.reviews.saveReview({ ...deploying, phase });
    assert.throws(() => loop.cancel(f.builder, "nPHONE"), seenThrough, phase.kind);
  }
  assert.deepEqual(f.statuses(), ["active", "active"], "a refused cancel archives nothing");
  f.registry.reviews.saveReview({ ...deploying, merged: null, phase: { kind: "merging", authorized: null } });
  assert.equal(loop.cancel(f.builder, "nPHONE").phase.kind, "cancelled", "a landing that has not authorized its merge is cancelled");

  const g = fixture(t);
  const stopped = await approved(g, null);
  assert.equal(g.review().phase.kind, "approved");
  assert.throws(() => stopped.cancel(g.builder, "nPHONE"), (err: Refusal) => err.kind === "conflict" && /already ended approved, so there is nothing to cancel/.test(err.message));
  assert.throws(() => stopped.cancel(g.add("th-other", true), "nPHONE"), (err: Refusal) => err.kind === "conflict" && /has no review/.test(err.message));
});

test("the person cancels a review that ended for them, which ends its decision, archives its reviewer and leaves the builder", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person");
  assert.equal(f.registry.threads.attention(f.builder), "decision");
  const sent = f.sent.length;

  assert.deepEqual(loop.cancel(f.builder, "nPHONE").phase, { kind: "cancelled", who: "person", by: "nPHONE" });
  assert.notEqual(f.registry.threads.attention(f.builder), "decision");
  assert.deepEqual(f.statuses(), ["active", "archived"]);
  await loop.poll();
  assert.equal(f.sent.length, sent, "a cancelled review sends nothing more");
  assert.equal(f.review().phase.kind, "cancelled");
});

test("a pass that was stepping a review when the person cancelled it does not save over the cancel", async (t) => {
  const { f, loop } = await undelivered(t);
  f.delivery = "delivered";
  const held = f.holdDeliveries();
  const pass = loop.poll();
  await held.entered;
  loop.cancel(f.builder, "nPHONE");
  held.release();
  await pass;
  assert.deepEqual(f.review().phase, { kind: "cancelled", who: "person", by: "nPHONE" });
  assert.equal(f.review().outbox, null);
  await loop.poll();
  assert.equal(f.review().phase.kind, "cancelled", "the next pass steps from the cancel");
  assert.deepEqual(f.registry.threads.events("0", { kinds: ["review.changed"] }).map((e) => (e.payload.phase as { kind: string }).kind), ["reviewing", "cancelled"]);
});

test("a check thread or verify pylon a pass starts as the person cancels the review is thrown away at once", async (t) => {
  for (const verifies of [false, true]) {
    const f = fixture(t);
    f.verifies = verifies;
    f.check = { kind: "running" };
    const loop = f.loop();
    await loop.start(f.builder, { land: "nLAPTOP" });
    await loop.poll();
    f.reply(f.review().reviewer, verdict(f.review(), {}));
    await loop.poll();
    // The check runs beside the reviewer, so the pass held here starts the live check once the check passed, or the
    // check again after a run that gave no verdict, and each reads GitHub before it starts its thread.
    f.check = verifies ? { kind: "done", passed: true, output: "ok" } : { kind: "void" };
    const held = f.holdPolls(0);
    const pass = loop.poll();
    await held.entered;
    assert.equal(f.review().phase.kind, verifies ? "verifying" : "checking");
    loop.cancel(f.builder, "nPHONE");
    held.release();
    await pass;
    const started = verifies ? f.liveThreads : f.checkThreads.slice(1);
    assert.equal(started.length, 1, `the pass started its ${verifies ? "verify pylon" : "check thread"}`);
    assert.deepEqual(verifies ? f.archived : f.discarded.slice(1), started, "and threw it away before the pass ended");
    assert.equal(f.review().phase.kind, "cancelled");
  }
});

test("a message a pass was about to send when the person cancelled the review is never sent", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  // The pass reads GitHub once, after the send's attempt is saved and right before the send.
  const held = f.holdPolls(0);
  const pass = loop.poll();
  await held.entered;
  assert.notEqual(f.review().outbox?.attempted ?? null, null, "the findings' send is under way while the pass reads GitHub");
  loop.cancel(f.builder, "nPHONE");
  held.release();
  await pass;
  await loop.poll();
  assert.equal(f.review().phase.kind, "cancelled");
  assert.deepEqual(f.sent.map((s) => s.to), [f.review().reviewer], "the builder never got the findings");
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
/** Why a waiver at `from` did not carry to `to`, when GitHub shows no patch for the registry change at either. */
const unshownChange = (from: string, to: string) => `Nexus cannot tell whether the change at ${to.slice(0, 12)} is the one nLAPTOP pressed Land for at ${from.slice(0, 12)}, as GitHub shows no patch for src/control/schema.ts, so that waiver does not carry over. Look at the change again, and press Land to waive the holds at ${to.slice(0, 12)}.`;

test("a builder's PR in a project that lands on its own is reviewed with no command and lands for whoever turned it on", async (t) => {
  const f = fixture(t, { autoReview: { mode: "land", enabledBy: "nLAPTOP" } });
  released(f, previous);
  const loop = f.loop();
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  assert.equal(f.review().auto, true);
  assert.deepEqual(f.review().land, { requestedBy: "nLAPTOP", fromProject: true });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.review().phase.kind, "deploying");
  assert.equal(f.registry.releases.desiredRelease()?.commit, merged);
});

test("nothing starts on its own without the project's setting, for a thread the loop started, or twice for one PR", async (t) => {
  const off = fixture(t);
  await off.loop().auto(off.registry.threads.thread(off.builder)!, off.pr);
  assert.equal(off.registry.reviews.review(off.builder), null, "a project without the setting");

  const f = fixture(t, { path: tempDb(), autoReview: { mode: "review", enabledBy: "nPHONE" } });
  const loop = f.loop();
  for (const [id, by] of [["th-reviewing", reviewerCaller], ["th-checking", checkCaller]] as const) {
    await loop.auto(f.registry.threads.thread(f.add(id, true, by))!, f.pr);
    assert.equal(f.registry.reviews.review(id as ThreadId), null, `a thread started by ${by}`);
  }
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  assert.equal(f.review().land, null, "a project that only reviews stops at approval");
  const first = f.review().id;
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "approved");
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  assert.equal(f.review().id, first, "a review that ended stays ended");
  assert.equal(f.started.length, 1);
  const again = await loop.start(f.builder, { land: null });
  assert.notEqual(again.id, first, "the person can still start one");
  assert.equal(again.auto, false);
});

test("a branch that conflicts at landing goes back to the builder to rebase, and the rebased head is reviewed again, then lands", async (t) => {
  const f = fixture(t);
  released(f, previous);
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["The branch conflicts with main, and the builder did not rebase it: main rewrote the cache this PR adds, so one side has to go."] });

  const last = fixture(t, { path: tempDb() });
  const capped = last.loop();
  await capped.start(last.builder, { land: "nLAPTOP", rounds: 1 });
  await capped.poll();
  conflicting(last);
  last.reply(last.review().reviewer, verdict(last.review(), {}));
  await capped.poll();
  assert.equal(last.review().phase.kind, "fixing", "the builder rebases after the last round too, since a rebase that keeps the change needs no round");
  rebased(last);
  last.reply(last.builder, answers(last.review(), [{ id: "CONFLICT", action: "fixed", reason: "Rebased onto main." }]));
  await capped.poll();
  assert.deepEqual(shown(last.review().phase), { kind: "needs-person", label: { state: "added" }, reasons: [`The builder pushed fixes after round 1, the last this review allows, so they are unreviewed.`] }, "a rebase that changed the change has no round left");
});

test("a landing reads the PR again before the merge it authorized, so checks that fail meanwhile hold it", async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.onFiles = () => { if (++reads === 1) f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, checks: "failed" } }; };
  await approved(f, "nLAPTOP");
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().phase.kind, "needs-person");
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

test("a landing checked on a base that moved since brings the branch up to date and checks the new head before it merges", async (t) => {
  const f = fixture(t);
  released(f, previous);
  const change = [{ path: "src/cache.ts", previous: null, patch: "@@ -0,0 +1 @@\n+export {};" }];
  f.changes.set(head1, change);
  f.changes.set(head2, change);
  f.behind.add(head1);
  f.updateAnswer = () => { f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } }; return true; };
  const loop = await approved(f, "nLAPTOP");
  await loop.poll();
  assert.deepEqual(f.updates, [head1], "the branch checked on the old base is brought up to date");
  assert.deepEqual(f.checkHeads, [head1, head2], "the check runs again at the updated head");
  assert.deepEqual(f.merges, [head2], "only the head checked against the current base merges");
  assert.deepEqual(f.review().rounds.map((r) => [r.head, r.carried?.from]), [[head1, undefined], [head2, head1]], "the approval carries, so the reviewer gets no round");
  assert.equal(f.review().phase.kind, "deploying");
});

test("an update GitHub accepted but has not pushed yet is asked for once a minute, and nothing merges meanwhile", async (t) => {
  const f = fixture(t);
  f.behind.add(head1);
  const loop = await approved(f, "nLAPTOP");
  await loop.poll();
  assert.deepEqual(f.updates, [head1], "one update while GitHub works on it");
  assert.deepEqual(f.review().phase, { kind: "merging", authorized: null, updated: f.now }, "a merge of the stale head meanwhile is not this review's");
  f.tick(60_000);
  await loop.poll();
  assert.deepEqual(f.updates, [head1, head1]);
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().phase.kind, "merging");
});

test("a branch behind its base that GitHub cannot bring up to date goes to the builder to rebase", async (t) => {
  const f = fixture(t);
  f.behind.add(head1);
  f.updateAnswer = () => false;
  await approved(f, "nLAPTOP");
  assert.deepEqual(f.merges, []);
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["nLAPTOP, who asked for this landing, is not among the control plane's deployers, so only the person can land it."] });

  const auto = fixture(t, { path: tempDb(), autoReview: { mode: "land", enabledBy: "nLAPTOP" } });
  const own = auto.loop();
  await own.auto(auto.registry.threads.thread(auto.builder)!, auto.pr);
  await own.poll();
  auto.registry.projects.editProject("nexus" as ProjectId, ({ autoReview: _, ...p }) => p);
  auto.reply(auto.review().reviewer, verdict(auto.review(), {}));
  await own.poll();
  assert.deepEqual(auto.merges, []);
  assert.deepEqual(shown(auto.review().phase), { kind: "needs-person", reasons: ["Project nexus no longer lands its builders' pull requests on its own, so this one is the person's to land."] });
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
    else f.registry.threads.setThreadStatus(f.builder, how);
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
  g.registry.prWatches.savePrWatch(g.builder, { ...g.registry.prWatches.prWatch(g.builder)!, commentWakes: 10 });
  g.snapshot = { ...g.snapshot, pr: { ...g.snapshot.pr, state: "closed" } };
  await held.poll();
  assert.deepEqual(g.review().phase, { kind: "closed" });
});

test("a PR that another thread on its branch has a review of gets none on its own", async (t) => {
  const f = fixture(t, { autoReview: { mode: "review", enabledBy: "nLAPTOP" } });
  const loop = f.loop();
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  await loop.auto(f.registry.threads.thread(f.add("th-twin", true))!, f.pr);
  assert.equal(f.registry.reviews.review("th-twin" as ThreadId), null);
  assert.equal(f.started.length, 1);
});

test("a PR stays reviewed once its builder's record moves on to a review of another PR", async (t) => {
  const f = fixture(t, { autoReview: { mode: "review", enabledBy: "nLAPTOP" } });
  const loop = f.loop();
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "approved");
  f.registry.reviews.saveReview({ ...f.review(), id: "rv-next", pr: { ...f.review().pr, number: f.pr.number + 1 }, phase: { kind: "reviewing" } });
  await loop.auto(f.registry.threads.thread(f.add("th-twin", true))!, f.pr);
  assert.equal(f.registry.reviews.review("th-twin" as ThreadId), null, "the twin's link of the first PR starts nothing");
  assert.equal(f.started.length, 1);
});

const reservedHolds = [
  "Always needs the person: anything irreversible, as it changes src/control/schema.ts.",
];

test("a held reserved path holds again when landed, and lands once the person waives it at the approved head", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "@@ -240,3 +240,4 @@ export const migrations: readonly string[] = [\n+  `CREATE TABLE x (a TEXT) STRICT;`," }];
  const loop = await approved(f, "nLAPTOP");
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: reservedHolds });
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: reservedHolds }, "landing again meets the same hold");
  assert.deepEqual(f.merges, []);

  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.review().phase.kind, "deploying");
  const { at, change, ...waiver } = f.review().waiver!;
  assert.deepEqual(waiver, { head: head1, holds: reservedHolds, codes: ["reserved-path:irreversible"], by: "nLAPTOP" }, "the review records who waived which holds, at which commit");
  assert.equal(change?.kind, "known", "and the change at that commit");
  assert.equal(typeof at, "number");
  assert.deepEqual(f.registry.threads.events("0", { kinds: ["review.waived"], thread: f.builder }).map((e) => e.payload), [{ review: f.review().id, repo: "ramtinJ95/nexus", pr: 7, ...waiver, at }]);
  for (const role of ["control", "probe"] as const) f.registry.releases.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: Date.now() });
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
});

test("a waiver lets the landing past only the holds it names, and only at the commit it names", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }, { path: "images/pylon/Dockerfile", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head2, reservedHolds), { kind: "conflict", message: new RegExp(`is at ${head1}, not ${head2}`) });
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1, ["The pull request's GitHub checks are pending."]), { kind: "conflict", message: /not held by/ });

  const image = "Always needs the person: pylon image rebuilds, as it changes images/pylon/Dockerfile.";
  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [...reservedHolds, image] },
    "a hold the waiver did not name still holds, and the person sees every hold again, those waived too, to confirm them together");

  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, checks: "failed" } };
  loop.land(f.builder, "nLAPTOP", head1, [...reservedHolds, image]);
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["The pull request's GitHub checks are failed.", ...reservedHolds, image] }, "a waiver never waives failing checks");
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1, ["The pull request's GitHub checks are failed."]), { kind: "conflict", message: /cannot be waived/ });

  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, checks: "passing" } };
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.equal(f.review().waiver, null, "a landing that names no holds waives nothing");
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [...reservedHolds, image] });

  loop.land(f.builder, "nLAPTOP", head1, [...reservedHolds, image]);
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "confirming every hold the card shows lands it");
});

test("a Claude reviewer's approval is not waivable, and a change to .nexus/check is", async (t) => {
  const f = fixture(t, { claudeBuilder: false, secrets: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }] });
  const loop = await approved(f, "nLAPTOP");
  const [claude] = (f.review().phase as { reasons: string[] }).reasons;
  assert.match(claude!, /A Claude reviewer approved it/);
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1, [claude!]), { kind: "conflict", message: /cannot be waived/ });

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
  const waivable: HoldCode[] = ["reserved:secrets", "reserved-path:auth", "check-changed", "verify-changed"];
  const never: HoldCode[] = [
    "open-findings", "not-approved", "unanswered", "check-failed", "github-checks", "not-approved-head", "conflict", "pr-not-open",
    "claude-approved", "same-model", "not-checked-live", "live-failed", "stale-head", "loop",
  ];
  for (const code of waivable) assert.equal(holdRule(code).waivable, true, code);
  for (const code of never) {
    assert.equal(holdRule(code).waivable, false, code);
    assert.notEqual(holdRule(code).why, "", code);
  }
  assert.match(holdRule("claude-approved").why, /stands in for a harness reviewer's approval/);
});

test("a waived landing whose branch conflicts goes back to the builder to rebase, and the rebased head needs the person's waiver again", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [unshownChange(head1, head2), ...reservedHolds] }, "the waiver was for the head before the rebase");
});

test("a review stored before hold codes reads its holds and its waiver with codes, and lands past the hold it waived", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
  await approved(f, "nLAPTOP");
  const { holds: _, cause: __, ...reasonsOnly } = f.review().phase as Extract<Review["phase"], { kind: "needs-person" }>;
  saveOlder(f, { ...f.review(), phase: reasonsOnly });
  assert.deepEqual(f.review().phase, { kind: "needs-person", cause: "unrecorded", reasons: reservedHolds, holds: [{ code: "reserved-path:irreversible", text: reservedHolds[0] }] });

  const waiver = { head: head1, holds: reservedHolds, by: "nLAPTOP", at: 1 };
  saveOlder(f, { ...f.review(), land: { requestedBy: "nLAPTOP" }, waiver, phase: { kind: "merging", authorized: null } });
  assert.deepEqual(f.review().waiver, { ...waiver, codes: ["reserved-path:irreversible"], change: { kind: "unknown", why: "the waiver was saved before Nexus recorded the change it waives" } });
  const loop = f.loop();
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
  assert.equal(f.registry.threads.events("0", { kinds: ["review.waived"], thread: f.builder }).length, 1, "the codes it gains on its next save are no new waiver");
});

test("a waiver covers its hold by code, whatever the hold's text, and the reviewer's reading of a case never covers the paths that hit it", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  f.registry.reviews.saveReview({ ...f.review(), land: { requestedBy: "nLAPTOP" }, phase: { kind: "merging", authorized: null },
    waiver: { head: head1, holds: ["Always needs the person: anything irreversible, in words an older control plane used."], codes: ["reserved-path:irreversible"], by: "nLAPTOP", at: 1, change: null } });
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);

  const g = fixture(t, { path: ":memory:" });
  g.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
  const gLoop = g.loop();
  await gLoop.start(g.builder, { land: "nLAPTOP" });
  await gLoop.poll();
  g.reply(g.review().reviewer, verdict(g.review(), { reserved: [{ case: "irreversible", why: "drops a column" }] }));
  await gLoop.poll();
  const reading = "Always needs the person: anything irreversible, by the reviewer's reading (drops a column).";
  assert.deepEqual(shown(g.review().phase), { kind: "needs-person", reasons: [reading, ...reservedHolds] });
  gLoop.land(g.builder, "nLAPTOP", head1, [reading]);
  await gLoop.poll();
  assert.deepEqual(g.merges, [], "the waiver names the reviewer's reading, not the path the person may not have seen");
  assert.deepEqual((g.review().phase as Extract<Review["phase"], { kind: "needs-person" }>).holds.map((h) => h.code), ["reserved:irreversible", "reserved-path:irreversible"]);
});

test("a harness, a Claude worker and a bare thread each give the replies and take the messages of their kind", async (t) => {
  const f = fixture(t, { claudeBuilder: false });
  const fake = fakeHarness();
  const harness = f.registry.threads.thread(f.builder)!;
  await fake.harness.startThread({ threadId: harness.id, pylonId: harness.pylonId });
  fake.transcript(harness.id).messages.push(
    { role: "user", content: "fix it", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Fixed" }, { type: "thinking", thinking: "no" }, { type: "text", text: " it." }], timestamp: 2 } as never,
  );
  const claude = f.registry.threads.thread(f.add("th-claude", true))!;
  claudeWorkerAt(f.registry, claude.id, "started", { session: "s1" });
  f.registry.threads.appendClaudeRead(claude.id, { session: "s1", from: transcriptStart, entries: [{ kind: "prompt", at: 1, text: "fix it", from: "person" }, { kind: "reply", at: 2, text: "Done." }], cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: 3 });
  const bare = f.registry.threads.thread(f.add("th-check-bare", false, checkCaller, true))!;

  const replies = agentReader(f.registry, fake.harness, storedTranscripts).replies;
  assert.deepEqual(await replies(harness), ["Fixed it."]);
  assert.deepEqual(await replies(claude), ["Done."], "a Claude worker's replies are its transcript's, and never reach the harness");
  await assert.rejects(replies(bare), "a bare thread has no replies to read");
  assert.ok(!fake.calls.some(([, id]) => id === claude.id), "nothing of a Claude worker's reaches the harness");

  const woken: ThreadId[] = [];
  const inbox = agentInbox({ log: assert.fail, registry: f.registry, harness: fake.harness, probes: new Map(), wake: (th) => { woken.push(th.id); } });
  const message = { id: "rv-1:1", text: "Review this", sender: "review" as const };
  assert.equal(await inbox(harness, message), "delivered");
  assert.deepEqual(fake.calls.at(-1), ["send", harness.id, "Review this", "rv-1:1", "followUp", "review"]);
  assert.equal(await inbox(claude, message), "later", "a Claude worker whose pylon does not run takes it later");
  await assert.rejects(inbox(bare, message), "a bare thread takes no message");
  assert.deepEqual(woken, [harness.id, claude.id], "a message a bare thread refused wakes nothing");
  assert.ok(f.registry.threads.thread(claude.id)!.lastAgentActivityAt > 0);
});

test("a model failure is a harness turn's last message that stopped on an error, or a Claude worker's API error with nothing after it", async (t) => {
  const f = fixture(t, { claudeBuilder: false });
  const fake = fakeHarness();
  const harness = f.registry.threads.thread(f.builder)!;
  await fake.harness.startThread({ threadId: harness.id, pylonId: harness.pylonId });
  const read = agentReader(f.registry, fake.harness, storedTranscripts).conversation;
  const failure = async (th: Thread) => (await read(th)).failure;
  fake.transcript(harness.id).messages.push({ role: "user", content: "review it", timestamp: 1 });
  for (let i = 0; i < 4; i++) fake.transcript(harness.id).messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "Request timed out.", timestamp: 2 + i } as never);
  fake.commit(harness.id);
  assert.equal(await failure(harness), "Request timed out.");
  fake.transcript(harness.id).messages.push({ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: 9 } as never);
  fake.commit(harness.id);
  assert.equal(await failure(harness), null, "a turn the model finished did not fail");

  const claude = f.registry.threads.thread(f.add("th-claude", true))!;
  claudeWorkerAt(f.registry, claude.id, "started", { session: "s1" });
  const [overloaded] = (await readFile(new URL("../fixtures/claude-api-errors.jsonl", import.meta.url), "utf8")).split("\n").filter((line) => line !== "").slice(3).map(parseRecord);
  const append = (entries: ClaudeEntry[], offset: number) => f.registry.threads.appendClaudeRead(claude.id, { session: "s1", from: { ...transcriptStart, offset: offset - 1 }, entries, cursor: { ...transcriptStart, offset }, reset: false, readAt: 3 });
  append([{ kind: "prompt", at: 1, text: "fix it", from: "person" }, ...overloaded!, { kind: "turn", at: 5, durationMs: 100 }], 1);
  assert.match((await failure(claude))!, /^API Error: 529 Overloaded\./);
  append([{ kind: "prompt", at: 6, text: "fix it", from: "other" }, { kind: "reply", at: 7, text: "Done." }], 2);
  assert.equal(await failure(claude), null);
});

test("a conversation's harness watch is stopped when its projection throws", async (t) => {
  const f = fixture(t, { claudeBuilder: false });
  const fake = fakeHarness();
  const harness = f.registry.threads.thread(f.builder)!;
  await fake.harness.startThread({ threadId: harness.id, pylonId: harness.pylonId });
  fake.transcript(harness.id).messages.push({ role: "assistant", content: "not a list of parts", timestamp: 1 } as never);
  fake.commit(harness.id);
  await assert.rejects(agentReader(f.registry, fake.harness, storedTranscripts).replies(harness));
  assert.equal(fake.watching(harness.id), 0);
});

/** A fake harness behind the loop's real agent reads, whose reads of Claude transcripts `entries` counts. */
function realReads(t: import("node:test").TestContext) {
  const fake = fakeHarness();
  const counted = { entries: 0 };
  const f = fixture(t, { agentState: (registry) => agentReader({ ...registry, threads: { ...registry.threads, claudeEntries: (...args) => { counted.entries++; return registry.threads.claudeEntries(...args); } } }, fake.harness, storedTranscripts).state });
  /** A harness thread's turn that ended with `text`. */
  const say = (id: ThreadId, text: string) => {
    fake.transcript(id).messages.push({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 } as never);
    fake.commit(id);
    f.reply(id, text);
  };
  return { f, fake, counted, say };
}

test("a step reads a waiting Claude builder's transcript once", async (t) => {
  const { f, fake, counted, say } = realReads(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await fake.harness.startThread({ threadId: f.review().reviewer, pylonId: `pylon-${f.review().reviewer}` as PylonId });
  await loop.poll();
  say(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  f.tick(1_000);
  claudeRead(f, [{ kind: "reply", at: f.now, text: answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]) }, { kind: "turn", at: f.now, durationMs: 1_000 }], []);
  f.tick(1_000);
  counted.entries = 0;
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing", "the loop waits for the push the builder says it made");
  assert.equal(counted.entries, 1);
});

test("a Claude builder's answer that only its transcript holds is heard, though the read its session's event started came before it", async (t) => {
  const fake = fakeHarness();
  const projects = await tempDir("nexus-review-projects-");
  const file = join(projects, "-home-user-workspace-repo", "s1.jsonl");
  await mkdir(join(projects, "-home-user-workspace-repo"));
  const record = JSON.parse((await readFile(new URL("../fixtures/claude-transcript.jsonl", import.meta.url), "utf8")).split("\n")[40]!);
  const line = (text: string) => `${JSON.stringify({ ...record, uuid: randomUUID(), message: { ...record.message, id: randomUUID(), content: [{ type: "text", text }] } })}\n`;
  const probe: Pick<ProbeClient, "stream"> = {
    stream: async (_, argv) => argv[0] === claudeHook ? processStream("printf", ["[]\n"], () => {})
      : processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {}),
  };
  const f = fixture(t, {
    agentState(registry) {
      const claude = claudeConversations({ registry, probes: new Map([[node, probe]]), log: assert.fail });
      t.after(() => claude.close());
      return agentReader(registry, fake.harness, claude).state;
    },
  });
  claudeWorkerAt(f.registry, f.builder, "started", { session: "s1" });
  observeNode(f.registry, { node, pylons: [runningPylon("pylon-th-builder" as PylonId)] });
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const reviewer = f.review().reviewer;
  await fake.harness.startThread({ threadId: reviewer, pylonId: `pylon-${reviewer}` as PylonId });
  fake.transcript(reviewer).messages.push({ role: "assistant", content: [{ type: "text", text: verdict(f.review(), { verdict: "changes", findings: [serious] }) }], stopReason: "stop", timestamp: 1 } as never);
  fake.commit(reviewer);
  f.reply(reviewer, "");
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");

  await writeFile(file, line("Looking at the finding."));
  f.registry.threads.reportSession(node, { sequence: (f.registry.threads.eventReceipt(node) ?? 0) + 1, time: f.now, pylon: "pylon-th-builder" as PylonId, event: { kind: "session.turn-started", session: "s1", at: f.now } });
  await until("the session's event read the transcript", () => f.registry.threads.claudeEntries(f.builder).length === 1);
  await appendFile(file, line(answers(f.review(), [{ id: "F1", action: "rejected", reason: "The cache lives for one request." }])));
  const sent = f.sent.length;
  f.reply(f.builder, "");
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "the answer went to the reviewer");
  assert.equal(f.sent.length, sent + 1);
  assert.equal(f.sent.at(-1)!.to, reviewer, "the builder got no reminder");
});

test("a builder that sends its answers again with only some of them keeps the others it sent", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const reviewer = f.review().reviewer;
  f.reply(reviewer, verdict(f.review(), { verdict: "changes", findings: [serious, { ...serious, id: "F2", summary: "The cache has no bound" }] }));
  await loop.poll();
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }, { id: "F2", action: "rejected", reason: "It holds one key." }]));
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a 5-minute TTL." }]));
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.deepEqual(f.review().rounds[0]!.answers, [{ id: "F1", action: "fixed", reason: "Added a 5-minute TTL." }, { id: "F2", action: "rejected", reason: "It holds one key." }]);
});

test("a harness reviewer that ended no turn since the request is not read", async (t) => {
  const { f, fake, say } = realReads(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const reviewer = f.review().reviewer;
  await fake.harness.startThread({ threadId: reviewer, pylonId: `pylon-${reviewer}` as PylonId });
  for (let i = 0; i < 3; i++) {
    await loop.poll();
    f.tick(15_000);
  }
  const watches = () => fake.calls.filter(([kind, id]) => kind === "watch" && id === reviewer).length;
  assert.equal(watches(), 0);
  say(reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(watches(), 1, "the turn that ended is read");
  assert.deepEqual(f.review().phase, { kind: "approved" });
});

test("a message a step queued after it read the PR is stamped and sent with no other read in that pass", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  const before = f.polls;
  await loop.poll();
  assert.equal(f.sent.at(-1)!.to, f.review().reviewer, "the next round went to the reviewer");
  assert.equal(f.review().outbox, null);
  assert.equal(f.polls - before, 1);
});

test("a held review whose PR watch hit its comment cap reads the PR once per PR watch interval", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person");
  f.registry.prWatches.savePrWatch(f.builder, { ...f.registry.prWatches.prWatch(f.builder)!, commentWakes: 10 });
  const before = f.polls;
  for (let i = 0; i < 7; i++) {
    await loop.poll();
    f.tick(15_000);
  }
  assert.equal(f.polls - before, 1, "seven passes within two minutes read GitHub once");
  f.tick(15_000);
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "closed" } };
  await loop.poll();
  assert.equal(f.polls - before, 2);
  assert.deepEqual(f.review().phase, { kind: "closed" });
});

/** A push of `head` to the PR's branch, as GitHub and then the PR watch's next read see it. */
const pushed = (f: ReturnType<typeof fixture>, head: string) => {
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, conflict: false }, detail: { ...f.snapshot.detail, head } };
  f.registry.prWatches.savePrWatch(f.builder, { ...f.registry.prWatches.prWatch(f.builder)!, links: [{ pr: { ...f.pr, head }, seen: [], failed: false }] });
};

test("a landing held for the person reviews a head pushed after the hold in a new round, and holds again there without the old head's waiver", async (t) => {
  const f = fixture(t);
  const image = "Always needs the person: pylon image rebuilds, as it changes images/pylon/Dockerfile.";
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }, { path: "images/pylon/Dockerfile", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [...reservedHolds, image] });
  pushed(f, head1);
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person", "a read of the same head changes nothing");

  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [unshownChange(head1, head2), ...reservedHolds] }, "the waiver named the head before the push");
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
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP", rounds: 1 });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: reservedHolds });
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
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1), { kind: "conflict" }, "the old head is no longer offered for landing");

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
  assert.deepEqual(shown(g.review().phase), { kind: "needs-person", reasons });
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
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["The branch conflicts with main, and the builder did not rebase it: I will rebase once main settles."] });
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
  assert.deepEqual(shown(g.review().phase), { kind: "needs-person", reasons: [`.nexus/check failed at ${head1}, and the builder pushed nothing for it: The test is flaky.`, "The check's output:\n1 test failed"] });
  g.check = { kind: "done", passed: true, output: "ok" };
  pushed(g, head2);
  await gave.poll();
  assert.equal(g.review().phase.kind, "reviewing");
  g.reply(g.review().reviewer, verdict(g.review(), {}));
  await gave.poll();
  assert.deepEqual(g.review().phase, { kind: "approved" });
  assert.deepEqual(g.review().rounds[1]!.check, { passed: true, output: "ok" }, "the check runs at the new head");
});

/** Ends three turns of `id` in a row without the block the loop waits for. */
const silent = async (f: ReturnType<typeof fixture>, id: ThreadId) => {
  for (let i = 0; i < 3; i++) { f.reply(id, "I looked and it seems fine."); await f.loop().poll(); }
};
const holds: { kind: string; hold(f: ReturnType<typeof fixture>): Promise<void>; cause: HoldCause; reasons: string[]; landable: boolean; round: boolean }[] = [
  { kind: "rounds", cause: "rounds", reasons: ["The reviewer still requests changes after 1 rounds, the most this review allows."], landable: false, round: false, async hold(f) {
    const loop = f.loop();
    await loop.start(f.builder, { land: null, rounds: 1 });
    await loop.poll();
    f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
    await loop.poll();
  } },
  { kind: "gate", cause: "gate", reasons: [`.nexus/check failed at ${head1}, and the builder pushed nothing for it: The test is flaky.`, "The check's output:\n1 test failed"], landable: false, round: true, async hold(f) {
    f.check = { kind: "done", passed: false, output: "1 test failed" };
    await approved(f, null);
    f.reply(f.builder, answers(f.review(), [{ id: "CHECK", action: "rejected", reason: "The test is flaky." }]));
    await f.loop().poll();
  } },
  { kind: "no verdict from the check", cause: "no-verdict", reasons: [`.nexus/check could not run at ${head1}.`, "The check's output:\nno .nexus/check"], landable: false, round: false, async hold(f) {
    f.check = { kind: "unrunnable", output: "no .nexus/check" };
    await approved(f, null);
  } },
  { kind: "no verdict from the live check", cause: "no-verdict", reasons: [`The live check gave no verdict within 60 minutes at ${head1}.`, "No node could take its verify pylon: every node is offline"], landable: true, round: true, async hold(f) {
    f.verifies = true;
    f.refuse = "every node is offline";
    await approved(f, null);
    f.tick(61 * 60_000);
    await f.loop().poll();
  } },
  { kind: "agent while reviewing", cause: "agent", reasons: ["The reviewer ended 3 turns in a row without an answer Nexus could read, in round 1."], landable: false, round: false, async hold(f) {
    const loop = f.loop();
    await loop.start(f.builder, { land: null });
    await loop.poll();
    await silent(f, f.review().reviewer);
  } },
  { kind: "agent while fixing a gate finding", cause: "agent", reasons: ["The builder ended 3 turns in a row without an answer Nexus could read, in round 1."], landable: false, round: true, async hold(f) {
    f.check = { kind: "done", passed: false, output: "1 test failed" };
    await approved(f, null);
    await silent(f, f.builder);
  } },
  { kind: "policy", cause: "policy", reasons: reservedHolds, landable: true, round: true, async hold(f) {
    f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
    await approved(f, "nLAPTOP");
  } },
  { kind: "thread while reviewing", cause: "thread", reasons: ["The reviewer thread <reviewer> is idle, so the review stopped."], landable: false, round: false, async hold(f) {
    await f.loop().start(f.builder, { land: null });
    await f.loop().poll();
    f.registry.threads.setThreadStatus(f.review().reviewer, "idle");
    await f.loop().poll();
    f.registry.threads.setThreadStatus(f.review().reviewer, "active");
  } },
  { kind: "thread while verifying", cause: "thread", reasons: ["The reviewer thread <reviewer> is idle, so the review stopped."], landable: true, round: true, async hold(f) {
    f.verifies = true;
    f.refuse = "every node is offline";
    await approved(f, null);
    f.registry.threads.setThreadStatus(f.review().reviewer, "idle");
    await f.loop().poll();
    f.registry.threads.setThreadStatus(f.review().reviewer, "active");
  } },
];

test("each kind of hold says whether nexus land takes the review and whether a head pushed after it gets a round", async (t) => {
  for (const { kind, hold, cause, reasons, landable: lands, round } of holds) {
    const f = fixture(t);
    await hold(f);
    const r = f.review();
    assert.equal(r.phase.kind, "needs-person", kind);
    assert.deepEqual({ cause: (r.phase as { cause: HoldCause }).cause, reasons: (r.phase as { reasons: string[] }).reasons.map((text) => text.replace(r.reviewer, "<reviewer>")) }, { cause, reasons }, kind);
    assert.equal(landable(r), lands, kind);
    pushed(f, head2);
    await f.loop().poll();
    assert.equal(f.review().rounds.length, r.rounds.length + (round ? 1 : 0), `${kind}: ${round ? "a new round" : "no round"} for the pushed head`);
    assert.equal(f.review().phase.kind, round ? "reviewing" : "needs-person", kind);
  }
});

test("a hold stored before causes reads back as rounds that ran out when it has the label, and unrecorded otherwise", async (t) => {
  const f = fixture(t);
  await holds[0]!.hold(f);
  const { cause: _, ...uncaused } = f.review().phase as Extract<Review["phase"], { kind: "needs-person" }>;
  saveOlder(f, { ...f.review(), phase: uncaused });
  assert.equal((f.review().phase as { cause: HoldCause }).cause, "rounds");
  const { label: __, ...unlabelled } = uncaused;
  saveOlder(f, { ...f.review(), phase: unlabelled });
  assert.equal((f.review().phase as { cause: HoldCause }).cause, "unrecorded");
});

test("each gate that stops an approval goes to the builder as its P0 finding, and to the person once the builder pushes nothing for it", async (t) => {
  const gates: { id: string; land: string | null; fail(f: ReturnType<typeof fixture>): void; finding: string; codes: HoldCode[]; reasons: string[] }[] = [
    { id: "CHECK", land: null, fail(f) { f.check = { kind: "done", passed: false, output: "boom" }; }, finding: `CHECK (P0) .nexus/check: .nexus/check failed at ${head1}\n    boom`,
      codes: ["check-failed", "loop"], reasons: [`.nexus/check failed at ${head1}, and the builder pushed nothing for it: Not this branch.`, "The check's output:\nboom"] },
    { id: "LIVE", land: null, fail(f) { f.verifies = true; f.live = { kind: "done", passed: false, output: "boom" }; }, finding: `LIVE (P0) .nexus/verify: The live check failed at ${head1}\n    boom`,
      codes: ["live-failed", "loop"], reasons: [`The live check failed at ${head1}, and the builder pushed nothing for it: Not this branch.`, "The live check's output:\nboom"] },
    { id: "CONFLICT", land: "nLAPTOP", fail: conflicting, finding: `CONFLICT (P0) origin/main: The branch conflicts with main, so ${head1} cannot merge`,
      codes: ["loop"], reasons: ["The branch conflicts with main, and the builder did not rebase it: Not this branch."] },
  ];
  for (const { id, land, fail, finding, codes, reasons } of gates) {
    const f = fixture(t);
    fail(f);
    await approved(f, land);
    assert.equal(f.review().phase.kind, "fixing", id);
    assert.ok(f.sent.at(-1)!.message.text.includes(finding), id);
    f.reply(f.builder, answers(f.review(), [{ id, action: "rejected", reason: "Not this branch." }]));
    await f.loop().poll();
    const phase = f.review().phase as Extract<Review["phase"], { kind: "needs-person" }>;
    assert.deepEqual({ cause: phase.cause, codes: phase.holds.map((h) => h.code), reasons: phase.reasons }, { cause: "gate", codes, reasons }, id);
  }
});

test("a conflict answered as fixed with no push gets a reminder to push once the push grace ends, not the person", async (t) => {
  const f = fixture(t);
  conflicting(f);
  const loop = await approved(f, "nLAPTOP");
  f.reply(f.builder, answers(f.review(), [{ id: "CONFLICT", action: "fixed", reason: "Rebased onto main." }]));
  f.tick(10 * 60_000);
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  assert.match(f.sent.at(-1)!.message.text, new RegExp(`the pull request's head is still ${head1}\\. Push the fixes\\.`));
});

test("a review that merged and is held over its deploy stays as it is whatever the PR watch reads", async (t) => {
  const f = fixture(t);
  released(f, previous);
  const loop = await approved(f, "nLAPTOP");
  f.registry.releases.reportRelease({ node, role: "control", commit: previous, target: merged, state: "failed", reason: "unit failed", observedAt: Date.now() });
  await loop.poll();
  for (const role of ["control", "probe"] as const) f.registry.releases.reportRelease({ node, role, commit: previous, target: previous, state: "healthy", reason: null, observedAt: Date.now() });
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
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
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
  f.registry.prWatches.savePrWatch(f.builder, { ...f.registry.prWatches.prWatch(f.builder)!, commentWakes: 10 });
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
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  pushed(f, head2);
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: reservedHolds });
  pushed(f, head1);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.deepEqual(f.review().rounds.map((round) => round.head), [head1, head2, head1]);
});

/** The registry migration the reserved-path rule holds, whose hunk starts at `line`. */
const migration = (line: number, table = "x"): ChangedFile[] => [{ path: "src/control/schema.ts", previous: null, patch: `@@ -${line},3 +${line},4 @@ export const migrations: readonly string[] = [\n   \`CREATE TABLE a (b TEXT) STRICT;\`,\n+  \`CREATE TABLE ${table} (a TEXT) STRICT;\`,` }, { path: "src/cache.ts", previous: null, patch: "@@ -0,0 +1 @@\n+export {};" }];
const carriedEvents = (f: ReturnType<typeof fixture>) => f.registry.threads.events("0", { kinds: ["review.approval-carried", "review.waiver-carried", "review.waived"], thread: f.builder }).map((e) => [e.kind, e.payload.from, e.payload.to]);

/** A landing the person waived at head1, whose branch then conflicts, so the builder rebases it to head2 with `change`. */
async function waivedThenRebased(t: import("node:test").TestContext, change: ChangedFile[] | null, rounds?: number, check?: CheckState) {
  const f = fixture(t);
  f.files = migration(240);
  f.changes.set(head1, migration(240));
  f.changes.set(head2, change);
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP", rounds });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: reservedHolds });
  conflicting(f);
  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  const reviewerRequests = f.sent.filter((s) => s.to === f.review().reviewer).length;
  rebased(f);
  if (check !== undefined) f.check = check;
  f.reply(f.builder, answers(f.review(), [{ id: "CONFLICT", action: "fixed", reason: "Rebased onto main." }]));
  await loop.poll();
  return { f, loop, reviewerRequests };
}

test("a landing the person waived, rebased to a head with the same change, lands there without the person, a reviewer round or a round spent", async (t) => {
  const { f, reviewerRequests } = await waivedThenRebased(t, migration(250), 1);
  assert.deepEqual(f.merges, [head2], "the waiver carried to the rebased head");
  assert.equal(f.review().phase.kind, "deploying");
  assert.equal(f.sent.filter((s) => s.to === f.review().reviewer).length, reviewerRequests, "the reviewer gets no round for the rebase");
  assert.deepEqual(f.review().rounds.map((r) => [r.head, r.carried?.from]), [[head1, undefined], [head2, head1]]);
  assert.deepEqual(f.review().rounds[1]!.check, { passed: true, output: "ok" }, "the check runs at the rebased head");
  assert.deepEqual(f.review().rounds[1]!.live, { kind: "absent" }, "and the live check would");
  assert.equal(roundsSpent(f.review()), 1, "the carried approval spends no round, so a review with one round still lands its rebase");
  assert.equal(roundNote(f.review()), `approval carried from ${head1.slice(0, 12)} to ${head2.slice(0, 12)}: same change after a rebase`);
  assert.deepEqual({ ...f.review().waiver, at: 0, change: null }, { head: head2, from: head1, holds: reservedHolds, codes: ["reserved-path:irreversible"], by: "nLAPTOP", at: 0, change: null });
  assert.deepEqual(carriedEvents(f), [["review.waived", undefined, undefined], ["review.approval-carried", head1, head2], ["review.waiver-carried", head1, head2]], "the event log records each carry with both heads, and the person's waiver once");
});

test("a landing the person waived, rebased with a changed line, gets a counted round and goes back to the person with the file that differs", async (t) => {
  const { f, loop, reviewerRequests } = await waivedThenRebased(t, migration(250, "y"));
  assert.equal(f.review().phase.kind, "reviewing", "a changed change gets a reviewer round");
  assert.equal(f.sent.filter((s) => s.to === f.review().reviewer).length, reviewerRequests + 1);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(roundsSpent(f.review()), 2);
  assert.equal(f.review().rounds[1]!.carried, undefined);
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [
    `The change at ${head2.slice(0, 12)} differs from the one nLAPTOP pressed Land for at ${head1.slice(0, 12)}, in src/control/schema.ts, so that waiver does not carry over. Look at that file again, and press Land to waive the holds at ${head2.slice(0, 12)}.`,
    ...reservedHolds,
  ] });
  assert.equal(f.review().waiver!.head, head1, "the waiver stays at the head the person pressed Land at");
  assert.equal((f.review().phase as Extract<Review["phase"], { kind: "needs-person" }>).holds[0]!.code, "waiver-not-carried");
  loop.land(f.builder, "nLAPTOP", head2, reservedHolds);
  await loop.poll();
  assert.deepEqual(f.merges, [head2], "one look and one Land lands it");
});

test("a rebased head with the same change merged outside the review during its checks deploys on the carried waiver, and records it", async (t) => {
  const { f, loop } = await waivedThenRebased(t, migration(250), undefined, { kind: "running" });
  assert.equal(f.review().phase.kind, "checking");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, mergeCommit: merged } };
  f.check = { kind: "done", passed: true, output: "ok" };
  await loop.poll();
  assert.deepEqual(f.merges, [], "someone else merged it");
  assert.equal(f.review().phase.kind, "deploying", "the policy, with the person's waiver carried, would have let it merge");
  assert.equal(f.review().waiver!.head, head2);
  assert.deepEqual(carriedEvents(f).at(-1), ["review.waiver-carried", head1, head2]);
});

test("a rebase GitHub cannot show in full keeps neither the approval nor the waiver", async (t) => {
  const { f, loop } = await waivedThenRebased(t, null);
  assert.equal(f.review().phase.kind, "reviewing");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.match((f.review().phase as Extract<Review["phase"], { kind: "needs-person" }>).reasons[0]!, /as GitHub did not show the whole change, so that waiver does not carry over/);
});

test("an approval carried to the same change never carries past a hold the person did not waive", () => {
  const review = testReview({ rounds: [{ head: head1, verdict: null, check: null, answers: null }, { head: head2, verdict: null, check: null, answers: null, carried: { from: head1 } }] });
  const waiver: Waiver = { head: head1, holds: reservedHolds, codes: ["reserved-path:irreversible"], by: "nLAPTOP", at: 1, change: changeOf("main", migration(240)) };
  const irreversible = { code: "reserved-path:irreversible" as const, text: reservedHolds[0]! };
  const image = { code: "reserved-path:image-rebuild" as const, text: "Always needs the person: pylon image rebuilds, as it changes images/pylon/Dockerfile." };
  const same = changeOf("main", migration(270));
  assert.deepEqual(carryWaiver({ ...review, waiver }, same, [irreversible]).review.waiver, { ...waiver, head: head2, from: head1 }, "the same change, hunks moved, carries the waiver");
  assert.deepEqual(carryWaiver({ ...review, waiver }, same, [irreversible, image]), { review: { ...review, waiver }, why: null }, "a new hold holds, and the waiver stays where it was");
  const { change: _, ...legacy } = waiver;
  assert.match(carryWaiver(upgradeReview({ ...review, waiver: legacy as Waiver }), same, [irreversible]).why!.text, /the waiver was saved before Nexus recorded the change it waives/, "a waiver saved before changes holds at its own head alone");
  assert.deepEqual(changeOf("main", [{ path: "a.ts", previous: null, patch: "@@ -1 +1 @@\n-a\n+b" }]), changeOf("main", [{ path: "a.ts", previous: null, patch: "@@ -9 +9 @@ function f() {\n-a\n+b" }]), "only hunk headers are ignored");
  assert.notDeepEqual(changeOf("main", [{ path: "a.ts", previous: null, patch: "@@ -1 +1 @@\n-a\n+b" }]), changeOf("main", [{ path: "a.ts", previous: "z.ts", patch: "@@ -1 +1 @@\n-a\n+b" }]), "a rename's old path is part of the change");
  const script = (modes: [string, string]) => changeOf("main", [{ path: "a.sh", previous: null, patch: "@@ -1 +1 @@\n-a\n+b", modes }]);
  assert.notDeepEqual(script(["100755", "100755"]), script(["100755", "100644"]), "so is a file's mode, which its patch does not show");
  assert.notDeepEqual(script(["100755", "100755"]), script(["100644", "100755"]), "and its mode before, so a base that dropped a mode the head keeps is a mode change");
  assert.match(carryWaiver({ ...review, waiver }, changeOf("release/1", migration(270)), [irreversible]).why!.text, /as the pull request's base moved from main to release\/1/, "a waiver never carries to another base");
});

test("an approved review rebased with the same change runs its checks again without a reviewer round, and one with a changed line runs a counted round", async (t) => {
  for (const [change, carried] of [[migration(250), true], [migration(250, "y"), false]] as const) {
    const f = fixture(t);
    f.files = migration(240);
    f.changes.set(head1, migration(240));
    f.changes.set(head2, [...change]);
    const loop = await approved(f, null);
    assert.deepEqual(f.review().phase, { kind: "approved" });
    pushed(f, head2);
    await loop.poll();
    assert.equal(f.review().phase.kind, carried ? "approved" : "reviewing");
    assert.equal(f.checkThreads.length, 2, "the check runs again at head2, at once at the same change and beside the reviewer at a changed one");
    assert.equal(roundsSpent(f.review()), carried ? 1 : 2);
    assert.deepEqual(f.review().rounds[1]!.carried, carried ? { from: head1 } : undefined);
  }
});

test("an approval never carries to a head on another base, nor from a round saved before rounds recorded their base", async (t) => {
  for (const retarget of [true, false]) {
    const f = fixture(t);
    f.files = migration(240);
    f.changes.set(head1, migration(240));
    f.changes.set(head2, migration(250));
    const loop = await approved(f, null);
    if (retarget) f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, base: "release/1" } };
    else f.registry.reviews.saveReview({ ...f.review(), rounds: f.review().rounds.map(({ base: _, ...round }) => round) });
    pushed(f, head2);
    await loop.poll();
    assert.equal(f.review().phase.kind, "reviewing", retarget ? "a new base adds its own commits to the change" : "an old round's base is unknown");
    assert.equal(roundsSpent(f.review()), 2);
  }
});

test("a review whose rounds ran out, rebased with the same change, stays held at the new head with its reasons, and one with a changed line gains the stale head", async (t) => {
  const ranOut: { kind: string; reasons: string[]; check?: CheckState; hold(f: ReturnType<typeof fixture>): Promise<void> }[] = [
    { kind: "changes requested", reasons: ["The reviewer still requests changes after 1 rounds, the most this review allows."], async hold(f) {
      f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
    } },
    { kind: "check failed", reasons: [`.nexus/check failed at ${head1} after the last round this review allows.`, "The check's output:\n1 test failed"], check: { kind: "done", passed: false, output: "1 test failed" }, async hold(f) {
      f.reply(f.review().reviewer, verdict(f.review(), {}));
    } },
  ];
  for (const { kind, reasons, check, hold } of ranOut) {
    for (const [change, carried] of [[migration(250), true], [migration(250, "y"), false]] as const) {
      const f = fixture(t);
      f.files = migration(240);
      f.changes.set(head1, migration(240));
      f.changes.set(head2, [...change]);
      if (check !== undefined) f.check = check;
      const loop = f.loop();
      await loop.start(f.builder, { land: null, rounds: 1 });
      await loop.poll();
      await hold(f);
      await loop.poll();
      assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons, label: { state: "added" } }, kind);
      const [sent, checks] = [f.sent.length, f.checkThreads.length];
      pushed(f, head2);
      await loop.poll();
      const r = f.review();
      assert.equal(r.phase.kind, "needs-person", `${kind}: a review with no reviewer round left stays the person's`);
      assert.deepEqual([f.sent.length, f.checkThreads.length, roundsSpent(r)], [sent, checks, 1], `${kind}: nothing restarts`);
      if (carried) {
        assert.deepEqual(shown(r.phase), { kind: "needs-person", reasons, label: { state: "added" } }, `${kind}: the same change keeps the reasons, with no stale head`);
        assert.equal(r.rounds.at(-1)!.head, head2, `${kind}: the review is at the PR's head`);
        assert.deepEqual(r.rounds.at(-1)!.carried, { from: head1, held: true }, kind);
        assert.equal(r.rounds.at(-1)!.check, null, `${kind}: a check result belongs to the head it ran at`);
        assert.equal(roundNote(r), `hold carried from ${head1.slice(0, 12)} to ${head2.slice(0, 12)}: same change after a rebase`, kind);
        assert.deepEqual(carriedEvents(f), [], `${kind}: no approval carried to a review that stays held`);
        assert.doesNotMatch(cannotLand(r, f.registry.threads.thread(f.builder)!, { state: "open" })!, /moved to/, `${kind}: Land refuses for the reasons, not a stale head`);
      } else {
        assert.equal(r.rounds.at(-1)!.head, head1, kind);
        assert.deepEqual((r.phase as { unreviewed?: string }).unreviewed, head2, `${kind}: a changed line is unreviewed`);
        assert.match((r.phase as { reasons: string[] }).reasons.at(-1)!, /moved to 2{40} after this review was held/, kind);
      }
    }
  }
});

test("a review stored before carried approvals and waiver changes still loads, and its waiver holds at its own head alone", async (t) => {
  const f = fixture(t);
  f.files = migration(240);
  f.changes.set(head1, migration(240));
  f.changes.set(head2, migration(250));
  const loop = await approved(f, "nLAPTOP");
  conflicting(f);
  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  const { change: _, ...old } = f.review().waiver!;
  saveOlder(f, { ...f.review(), waiver: old });
  await loop.poll();
  assert.deepEqual(f.review().waiver!.change, { kind: "unknown", why: "the waiver was saved before Nexus recorded the change it waives" }, "the old waiver loads with an unknown change, and the landing records none for it");
  rebased(f);
  f.reply(f.builder, answers(f.review(), [{ id: "CONFLICT", action: "fixed", reason: "Rebased onto main." }]));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().rounds[1]!.carried?.from, head1, "the reviewer's approval carries, which needs nothing the old record lacks");
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [
    `Nexus cannot tell whether the change at ${head2.slice(0, 12)} is the one nLAPTOP pressed Land for at ${head1.slice(0, 12)}, as the waiver was saved before Nexus recorded the change it waives, so that waiver does not carry over. Look at the change again, and press Land to waive the holds at ${head2.slice(0, 12)}.`,
    ...reservedHolds,
  ] });
});

test("an approved review in a project that leaves landing to the person waits on them until it lands, merges or closes outside it, or its builder is archived", async (t) => {
  const reviewOnly = { autoReview: { mode: "review" as const, enabledBy: "nLAPTOP" }, repo: "acme/app" };
  const approve = async (f: ReturnType<typeof fixture>) => {
    const loop = f.loop();
    await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
    await loop.poll();
    f.reply(f.review().reviewer, verdict(f.review(), {}));
    await loop.poll();
    assert.deepEqual(f.review().phase, { kind: "approved" });
    assert.equal(f.attention().at(-1), "decision", "an approval the person must land waits on them");
    return loop;
  };
  const f = fixture(t, reviewOnly);
  const loop = await approve(f);
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
  assert.notEqual(f.attention().at(-1), "decision", "a landed review waits on no one");

  for (const state of ["merged", "closed"] as const) {
    const g = fixture(t, { ...reviewOnly, path: ":memory:" });
    const gLoop = await approve(g);
    g.watched(state);
    await gLoop.poll();
    assert.deepEqual(g.review().phase, { kind: state }, `a pull request ${state} outside the review ends it`);
    assert.notEqual(g.attention().at(-1), "decision", `a review whose pull request ${state} outside it waits on no one`);
  }

  const h = fixture(t, { ...reviewOnly, path: ":memory:" });
  const hLoop = await approve(h);
  archive(h.registry, h.builder);
  await hLoop.poll();
  assert.deepEqual(h.review().phase, { kind: "cancelled", who: "builder", status: "archived" }, "archiving the builder ends it, as it ends a held review");
  assert.notEqual(h.attention().at(-1), "decision", "a cancelled review waits on no one");
});

test("a Land press the policy can never take is refused, so the route and the dashboard agree on what lands", async (t) => {
  const f = fixture(t, { claudeBuilder: false, secrets: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }] });
  const loop = await approved(f, "nLAPTOP");
  assert.equal(f.review().phase.kind, "needs-person");
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1), { kind: "conflict", message: /A Claude reviewer approved it/ }, "a press that would only hold again is refused with what holds it");
  assert.equal(f.review().phase.kind, "needs-person", "and the review stays as it was");
});

test("a description that says what could not be checked live only after the approving round lands once the person presses Land, through the reviewer's quote", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/api/server.ts", previous: null, patch: "" }];
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, body: "Adds a cache." } };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  const reviewer = f.review().reviewer;
  f.reply(reviewer, verdict(f.review(), { notCheckedLive: null }));
  await loop.poll();
  const auth = "Always needs the person: changes to login or auth, as it changes src/control/api/server.ts.";
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["No live check ran, and the pull request does not say what could not be checked live.", auth] });

  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, body: "Adds a cache.\n\n## Not checked live\n\nThe cache under real traffic on the fleet." } };
  const sent = f.sent.length;
  loop.land(f.builder, "nLAPTOP", head1, [auth]);
  await loop.poll();
  assert.equal(f.sent.length, sent + 1, "the press asks the reviewer");
  const ask = f.sent.at(-1)!;
  assert.equal(ask.to, reviewer);
  assert.match(ask.message.text, /The cache under real traffic on the fleet\./, "with the description as it is now");
  assert.deepEqual(f.merges, [], "nothing merges before the reviewer quotes it");
  f.reply(reviewer, `Quoted.\n\`\`\`nexus-quote\n${JSON.stringify({ token: f.review().expect, notCheckedLive: "The cache under real traffic on the fleet." })}\n\`\`\``);
  await loop.poll();
  assert.equal(f.review().rounds.length, 1, "the quote is no new round");
  assert.equal(f.review().rounds[0]!.verdict!.notCheckedLive, "The cache under real traffic on the fleet.");
  assert.deepEqual(f.merges, [head1], "the reviewer's quote clears the hold, and the press lands");
});

test("a press whose description still does not say what could not be checked live holds again on the reviewer's answer", async (t) => {
  const f = fixture(t, { repo: "acme/app" });
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, body: "Adds a cache." } };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { notCheckedLive: null }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person");
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.equal(f.review().phase.kind, "quoting");
  f.reply(f.review().reviewer, `None.\n\`\`\`nexus-quote\n${JSON.stringify({ token: f.review().expect, notCheckedLive: null })}\n\`\`\``);
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["No live check ran, and the pull request does not say what could not be checked live."] });
});

test("for every hold, and for an approval, the land route takes a press exactly when the dashboard offers Land", async (t) => {
  const codes: HoldCode[] = [
    "same-model", "not-approved", "open-findings", "unanswered", "check-failed", "live-failed", "github-checks", "not-approved-head", "conflict", "pr-not-open",
    "not-checked-live", "claude-approved", "check-changed", "verify-changed", "reserved:auth", "reserved-path:secrets", "stale-head", "waiver-not-carried", "loop",
  ];
  const f = fixture(t);
  const loop = await approved(f, null);
  const base = f.review();
  const round = base.rounds[0]!;
  const reviews: [string, Review][] = [
    ...codes.map((code): [string, Review] => [`held by ${code}`, { ...base, land: { requestedBy: "nLAPTOP" }, phase: personPhase("policy", { code, text: `held by ${code}` }) }]),
    ["approved", base],
    ["approved, reserved by the reviewer", { ...base, rounds: [{ ...round, verdict: { ...round.verdict!, reserved: [{ case: "auth", why: "it changes the login" }] } }] }],
    ["approved by a Claude reviewer", { ...base, reviewerKind: "claude" }],
    ["approved on the builder's own model", { ...base, models: { builder: "gpt-6-astra", reviewer: "gpt-6-astra" } }],
  ];
  const c = { deploys: () => false, landRefusal: null, caller: "nLAPTOP" } as never;
  const unescape = (attr: string) => attr.replace(/&(quot|#39|lt|gt|amp);/g, (_, e: string) => ({ quot: '"', "#39": "'", lt: "<", gt: ">", amp: "&" })[e]!);
  for (const [name, review] of reviews) {
    f.registry.reviews.saveReview(review);
    const card = landing(c, { thread: f.registry.threads.thread(f.builder)!, review, pullRequests: [f.pr], questions: [], prWatch: { enabled: true, stopped: false, error: null } } as never, false)?.text ?? "";
    const offered = card.includes('data-action="land"');
    const waive = /data-holds="([^"]*)"/.exec(card)?.[1];
    let took = true;
    try { loop.land(f.builder, "nLAPTOP", head1, waive === undefined ? undefined : JSON.parse(unescape(waive))); } catch (err) { if ((err as Refusal).kind !== "conflict") throw err; took = false; }
    assert.equal(took, offered, `${name}: the route ${took ? "takes" : "refuses"} a press the dashboard ${offered ? "offers" : "does not offer"}`);
    if (took) await loop.poll();
    else assert.deepEqual(f.review(), review, `${name}: a refused press leaves the review as it was`);
  }
});

test("an approval under a stopped PR watch still learns its pull request merged outside it, and stops waiting on the person", async (t) => {
  const f = fixture(t, { repo: "acme/app" });
  const loop = await approved(f, null);
  f.registry.prWatches.savePrWatch(f.builder, { ...f.registry.prWatches.prWatch(f.builder)!, commentWakes: 10 });
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, mergeCommit: merged } };
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "merged" });
  assert.notEqual(f.attention().at(-1), "decision");
});

const egress: Hold = { code: "reserved-path:egress", text: "Always needs the person: changes to the egress allowlist, as it changes src/control/threads.ts." };

test("an approved review of a Nexus pull request shows the path holds its head meets, and one press waiving them lands it", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/threads.ts", previous: null, patch: "@@ -1 +1 @@\n-type Hosts = 1;\n+type Hosts = 2;" }];
  const loop = await approved(f, null);
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.deepEqual(holdsAt(f.review()), [egress], "the card shows the hold the landing will meet at that head");
  const press = landPress(f.review());
  assert.deepEqual(press, { kind: "lands", waives: [egress], quotes: false });
  loop.land(f.builder, "nLAPTOP", head1, [egress.text]);
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "one press with the waivers the card showed merges");
  assert.equal(f.review().phase.kind, "deploying");
});

test("an approved review of another repository's pull request has no path holds", async (t) => {
  const f = fixture(t, { repo: "acme/app" });
  f.files = [{ path: "src/control/threads.ts", previous: null, patch: "@@ -1 +1 @@\n-type Hosts = 1;\n+type Hosts = 2;" }];
  const loop = await approved(f, null);
  assert.deepEqual(holdsAt(f.review()), []);
  assert.deepEqual(landPress(f.review()), { kind: "lands", waives: [], quotes: false });
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
});

test("a review approved before Nexus recorded what holds its head reads them on the next pass", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/threads.ts", previous: null, patch: "@@ -1 +1 @@\n-type Hosts = 1;\n+type Hosts = 2;" }];
  const loop = await approved(f, null);
  const { heldAt, ...round } = f.review().rounds[0]!;
  f.registry.reviews.saveReview({ ...f.review(), rounds: [round] });
  assert.deepEqual(holdsAt(f.review()), [], "until then it shows what its record alone decides");
  await loop.poll();
  assert.deepEqual(holdsAt(f.review()), [egress], "the card shows the path hold");
  assert.deepEqual(landPress(f.review()), { kind: "lands", waives: [egress], quotes: false });
  assert.deepEqual(f.review().phase, { kind: "approved" });
});

test("a review approved before Nexus recorded its holds, under a stopped PR watch, whose head moved reads GitHub a bounded number of times", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  const { heldAt, ...round } = f.review().rounds[0]!;
  f.registry.reviews.saveReview({ ...f.review(), rounds: [round] });
  pushed(f, head2);
  f.registry.prWatches.savePrWatch(f.builder, { ...f.registry.prWatches.prWatch(f.builder)!, commentWakes: 10 });
  let files = 0;
  f.onFiles = () => { files++; };
  const polls = f.polls;
  for (let i = 0; i < 8; i++) {
    await loop.poll();
    f.tick(15_000);
  }
  assert.equal(f.review().rounds.at(-1)!.head, head2, "the moved head GitHub showed gets its own round");
  assert.equal(files, 1);
  assert.ok(f.polls - polls <= 6, `${f.polls - polls} reads of the PR in 8 passes`);
});

test("a review approved before Nexus recorded its holds reads them at most once per PR watch interval while GitHub fails", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  const { heldAt, ...round } = f.review().rounds[0]!;
  f.registry.reviews.saveReview({ ...f.review(), rounds: [round] });
  let files = 0;
  f.onFiles = () => { files++; throw new Error("GitHub is down"); };
  for (let i = 0; i < 8; i++) {
    await loop.poll();
    f.tick(15_000);
  }
  assert.equal(files, 1, "eight passes in two minutes read the files once");
  f.tick(120_000);
  f.onFiles = () => { files++; };
  await loop.poll();
  assert.equal(files, 2);
  assert.notEqual(f.review().rounds[0]!.heldAt, undefined);
});

test("a pull request retargeted after its approval does not land on it: the landing reviews the head against the new base, or holds for the person with no round left", async (t) => {
  for (const rounds of [5, 1]) {
    const f = fixture(t);
    const loop = f.loop();
    await loop.start(f.builder, { land: null, rounds });
    await loop.poll();
    f.reply(f.review().reviewer, verdict(f.review(), {}));
    await loop.poll();
    assert.deepEqual(f.review().phase, { kind: "approved" });
    f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, base: "release" } };
    loop.land(f.builder, "nLAPTOP", head1);
    await loop.poll();
    assert.deepEqual(f.merges, [], "the approval was of the change against main");
    const r = f.review();
    if (rounds === 1) {
      assert.deepEqual(shown(r.phase), { kind: "needs-person", label: { state: "added" }, unreviewed: head1, reasons: [`The pull request's base changed from main to release after round 1, the last this review allows, so ${head1} is unreviewed.`] });
      assert.throws(() => loop.land(f.builder, "nLAPTOP", head1), /base changed from main to release/);
      continue;
    }
    assert.equal(r.phase.kind, "reviewing");
    assert.deepEqual(r.rounds.map((round) => [round.head, round.base]), [[head1, "main"], [head1, "release"]]);
    assert.equal(roundNote(r), `a new round reviews ${head1.slice(0, 12)} against release, since the pull request's base changed from main after its approval`);
    const asked = f.sent.at(-1)!.message.text;
    assert.match(asked, /The pull request's base changed from main to release after you approved 1{40}\./);
    assert.match(asked, /git diff origin\/release\.\.\.1{40}/);
    f.reply(r.reviewer, verdict(r, {}));
    await loop.poll();
    assert.deepEqual(f.merges, [head1], "the approval against release lands");
    assert.equal(roundsSpent(f.review()), 2, "the round against release reviewed another change, so it counts");
  }
});

test("fixes pushed to a pull request retargeted meanwhile are reviewed against the new base, not as commits on the old head", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, base: "release" } };
  pushed(f, head2);
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  const asked = f.sent.at(-1)!.message.text;
  assert.match(asked, /The pull request's base also changed from main to release\./);
  assert.match(asked, /git diff origin\/release\.\.\.2{40}/);
  assert.doesNotMatch(asked, /git diff 1{40}\.\.2{40}/, "the builder's commits alone leave out what the new base adds");
});

test("a landing the person waived, retargeted at the same head, needs the person's waiver again after its new round", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: reservedHolds });
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, base: "release" } };
  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.equal(f.review().waiver, null, "the person waived the change against main");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: reservedHolds });
});

test("a waived landing retargeted with a push, then reset to the waived head, needs the person's waiver again", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
  const loop = await approved(f, "nLAPTOP");
  loop.land(f.builder, "nLAPTOP", head1, reservedHolds);
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, base: "release" } };
  pushed(f, head2);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.equal(f.review().waiver, null, "the person waived the change against main");
  pushed(f, head1);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: reservedHolds });
});

test("a round saved before rounds recorded their base never detects a retarget, and its new round drops the person's waiver", async (t) => {
  const legacy = (f: ReturnType<typeof fixture>) => f.registry.reviews.saveReview({ ...f.review(), rounds: f.review().rounds.map(({ base: _, ...round }) => round) });
  const f = fixture(t);
  const loop = await approved(f, null);
  legacy(f);
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, base: "release" } };
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "with no base recorded, the landing has nothing to compare the new base with");

  const g = fixture(t);
  g.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
  const held = await approved(g, "nLAPTOP");
  legacy(g);
  held.land(g.builder, "nLAPTOP", head1, reservedHolds);
  pushed(g, head2);
  await held.poll();
  assert.equal(g.review().phase.kind, "reviewing");
  assert.equal(g.review().waiver, null, "a base it cannot compare is not taken for the same base");
});

test("a pull request retargeted and merged outside the review during its checks is not deployed", async (t) => {
  const f = fixture(t);
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "checking");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, base: "release", mergeCommit: merged } };
  f.check = { kind: "done", passed: true, output: "ok" };
  await loop.poll();
  assert.deepEqual(f.merges, [], "someone else merged it");
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [`Pull request #7 was merged outside this review into release, not main, the base its approval was of, so it is not deployed.`] });
  assert.equal(f.registry.releases.desiredRelease(), null);
});

test("a pull request retargeted and merged after the review authorized its merge into the old base is not deployed", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  f.registry.reviews.saveReview({ ...f.review(), land: { requestedBy: "nLAPTOP" }, phase: { kind: "merging", authorized: head1 } });
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" }, detail: { ...f.snapshot.detail, base: "release", mergeCommit: merged } };
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [`Pull request #7 was merged outside this review into release, not main, the base its approval was of, so it is not deployed.`] });
  assert.equal(f.registry.releases.desiredRelease(), null);
});

test("a pull request retargeted at its approved head has its path holds read again at the landing", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  assert.deepEqual(holdsAt(f.review()), []);
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, base: "release" } };
  f.files = [{ path: "src/control/threads.ts", previous: null, patch: "@@ -1 +1 @@\n-type Hosts = 1;\n+type Hosts = 2;" }];
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "a new base takes a round first");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [egress.text] });
  assert.deepEqual(holdsAt(f.review()), [egress]);
});

test("a retargeted landing held for the person shows the holds read at the new base, not those recorded at the old one", async (t) => {
  const f = fixture(t);
  f.files = [{ path: "src/control/threads.ts", previous: null, patch: "@@ -1 +1 @@\n-type Hosts = 1;\n+type Hosts = 2;" }];
  const loop = await approved(f, null);
  assert.deepEqual(holdsAt(f.review()), [egress]);
  f.registry.reviews.saveReview({ ...f.review(), land: { requestedBy: "nLAPTOP" }, phase: { kind: "merging", authorized: null } });
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, base: "release" } };
  f.files = [{ path: "src/control/schema.ts", previous: null, patch: "" }];
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "a new base takes a round first");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().phase.kind, "needs-person");
  assert.deepEqual(holdsAt(f.review()).map((h) => h.text), reservedHolds, "the egress hold the old base's files met is gone");
});

test("a step that fails the same way every pass is logged once, by its error's name", async (t) => {
  const f = fixture(t);
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  f.check = { kind: "done", passed: true, output: "ok" };
  f.onFiles = () => { throw new Error("GitHub is down"); };
  for (let i = 0; i < 3; i++) await loop.poll();
  assert.deepEqual(f.logged, [`review ${f.review().id} of ${f.builder}: a step failed and will be retried (Error)`]);
});

test("a check that passed keeps its thread until the holds of its head are read", async (t) => {
  const f = fixture(t);
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  f.check = { kind: "done", passed: true, output: "ok" };
  f.onFiles = () => { throw new Error("GitHub is down"); };
  await loop.poll();
  assert.equal(f.review().phase.kind, "checking");
  assert.deepEqual(f.discarded, [], "the check's result is not lost with the failed read");
  f.onFiles = () => {};
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.equal(f.checkThreads.length, 1, "no second check ran");
  assert.equal(f.review().rounds[0]!.check?.passed, true);
});

test("a Land press at a head whose check passed keeps that check and merges", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  assert.equal(f.checkThreads.length, 1);
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.equal(f.checkThreads.length, 1, "no check thread started for the press");
  assert.deepEqual(f.merges, [head1]);
});

test("a landing held for checks that later pass lands on the next press at the same head with no second check", async (t) => {
  const f = fixture(t);
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, checks: "pending" } };
  await approved(f, "nLAPTOP");
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: ["The pull request's GitHub checks are pending."] });
  const loop = f.loop();
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, checks: "passing" } };
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.equal(f.checkThreads.length, 1, "the press kept the check that passed at that head");
  assert.deepEqual(f.merges, [head1]);
});

test("a Land press on a round with no check runs it before merging", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  f.registry.reviews.saveReview({ ...f.review(), rounds: [{ ...f.review().rounds[0]!, check: null }] });
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.equal(f.checkThreads.length, 2, "the press ran the check");
  assert.deepEqual(f.merges, [head1]);
});

test("an approval by a reviewer on the builder's own model offers no Land press, before any landing tries", async (t) => {
  const f = fixture(t);
  const loop = await approved(f, null);
  const review = { ...f.review(), models: { builder: "gpt-6-astra", reviewer: "gpt-6-astra" } };
  f.registry.reviews.saveReview({ ...review, rounds: [{ ...review.rounds[0]!, heldAt: { base: "main", holds: headHolds({ review, files: [], deploys: true }) } }] });
  assert.equal(landPress(f.review()).kind, "stuck");
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1), { kind: "conflict", message: /builder's own model/ });
  assert.deepEqual(f.review().phase, { kind: "approved" });
});

test("a reviewer asked to quote is reminded of the nexus-quote block, and a pull request closed meanwhile ends the review", async (t) => {
  const f = fixture(t, { repo: "acme/app" });
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, body: "Adds a cache." } };
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { notCheckedLive: null }));
  await loop.poll();
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  f.reply(f.review().reviewer, "Nothing to quote.");
  await loop.poll();
  assert.equal(f.review().phase.kind, "quoting");
  assert.match(f.sent.at(-1)!.message.text, /no nexus-quote block with the token/, "the reminder names the block the request asked for");
  f.watched("closed");
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "closed" });
  assert.deepEqual(f.merges, []);
});

test("one press lands a description whose statement changed after the reviewer quoted it, through a quote of the new one, and a quote not in it holds without asking again", async (t) => {
  const f = fixture(t, { repo: "acme/app" });
  const loop = await approved(f, null);
  assert.equal(f.review().rounds[0]!.verdict!.notCheckedLive, "the cache under real traffic");
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, body: "Adds a cache.\n\n## Not checked live\n\nThe cache's hit rate on the fleet." } };
  loop.land(f.builder, "nLAPTOP", head1);
  await loop.poll();
  assert.equal(f.review().phase.kind, "quoting", "the landing finds the quote gone from the description and asks the reviewer");
  const ask = f.sent.at(-1)!.message.text;
  assert.match(ask, /The cache's hit rate on the fleet\./);
  assert.match(ask, /check it against the change you approved at that commit/, "the reviewer judges the passage, not only copies it");
  f.reply(f.review().reviewer, `Quoted.\n\`\`\`nexus-quote\n${JSON.stringify({ token: f.review().expect, notCheckedLive: "The cache's hit rate on the fleet." })}\n\`\`\``);
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "one press lands it");

  const g = fixture(t, { repo: "acme/app", path: ":memory:" });
  const gLoop = await approved(g, null);
  g.snapshot = { ...g.snapshot, detail: { ...g.snapshot.detail, body: "Adds a cache.\n\n## Not checked live\n\nThe cache's hit rate on the fleet." } };
  gLoop.land(g.builder, "nLAPTOP", head1);
  await gLoop.poll();
  const sent = g.sent.length;
  g.reply(g.review().reviewer, `Quoted.\n\`\`\`nexus-quote\n${JSON.stringify({ token: g.review().expect, notCheckedLive: "the hit rate of the cache on the fleet" })}\n\`\`\``);
  await gLoop.poll();
  assert.deepEqual(g.merges, []);
  assert.equal(g.sent.length, sent, "a quote that is not in the description it came from is not asked for again");
  assert.deepEqual(shown(g.review().phase), { kind: "needs-person", reasons: ["The reviewer's quote of what could not be checked live is not in the pull request's description."] });
});

test("a fresh busy drain extends a landing past its deadline without rollback or needs-person", async (t) => {
  const f = fixture(t);
  released(f, previous);
  const loop = await approved(f, "nLAPTOP");
  f.tick(31 * 60_000);
  f.registry.releases.reportRelease({ node, role: "control", commit: previous, target: merged, state: "waiting-for-idle", reason: "Waiting for th-builder", observedAt: f.now });
  await loop.poll();
  assert.equal(f.review().phase.kind, "deploying");
  assert.equal(f.registry.releases.desiredRelease()?.commit, merged);
  for (const role of ["control", "probe"] as const) f.registry.releases.reportRelease({ node, role, commit: merged, target: merged, state: "healthy", reason: null, observedAt: f.now });
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "landed", commit: merged });
});

const imageHold = "Always needs the person: pylon image rebuilds, as it changes images/pylon/Dockerfile.";
const dockerfile: ChangedFile[] = [{ path: "images/pylon/Dockerfile", previous: null, patch: "@@ -1 +1 @@\n-FROM a\n+FROM b" }];
/** The builder's questions about its review's holds, oldest first. */
const holdQuestions = (f: ReturnType<typeof fixture>) => f.registry.questions.questions(f.builder).filter((q) => q.kind === "holds");
const openHolds = (f: ReturnType<typeof fixture>) => holdQuestions(f).filter((q) => q.answer === null);

test("a round asks the person about the holds its head's paths decide as it starts, and Land then lands it once the reviewer approves and the check passes", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  f.check = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  const [question, ...more] = holdQuestions(f);
  assert.deepEqual(more, []);
  assert.deepEqual({ ...question!, id: "", askedAt: 0 }, {
    kind: "holds", id: "", thread: f.builder, askedAt: 0, answer: null, options: ["Land", "Leave it"], reserved: "image-rebuild", answerer: "deployer",
    text: `Land pull request #7, "Add the cache", at ${head1.slice(0, 12)}, waiving pylon image rebuilds?\n- ${imageHold}\nLand waives these at ${head1.slice(0, 12)}, and at a rebase of it that leaves the change as it is. Nexus still lands it only once the reviewer approves it and its checks pass, then deploys it. Leave it, and nothing is waived.`,
    holds: { review: f.review().id, head: head1, base: "main", holds: [{ code: "reserved-path:image-rebuild", text: imageHold }] },
  }, "one question names the hold by its case, while the reviewer reads and the check runs");
  assert.equal(f.registry.threads.attention(f.builder), "decision");
  await loop.poll();
  assert.equal(holdQuestions(f).length, 1, "a pass that finds the same holds asks nothing new");

  loop.answerHolds(question!, "Land", "nLAPTOP" as TailnetNodeId);
  assert.equal(f.review().phase.kind, "reviewing", "an early Land waits for the reviewer and the check");
  assert.deepEqual({ ...f.review().waiver!, at: 0 }, { head: head1, holds: [imageHold], codes: ["reserved-path:image-rebuild"], by: "nLAPTOP", at: 0, change: null }, "the waiver a Land press at that head gives");
  assert.deepEqual(f.review().land, { requestedBy: "nLAPTOP", head: head1, base: "main" }, "for the head and base the person saw");
  assert.equal(f.registry.questions.question(question!.id)!.answer?.option, "Land");
  assert.notEqual(f.registry.threads.attention(f.builder), "decision");
  await loop.poll();
  assert.deepEqual(f.merges, []);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, [], "the reviewer approved, but the check still runs");
  f.check = { kind: "done", passed: true, output: "ok" };
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
  assert.deepEqual(openHolds(f), []);
});

test("holds known only later ask again: the reviewer's reserved case replaces the open question, and a Land answer on a held review is the Land press", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  const [first] = openHolds(f);
  const cli = { code: "reserved:cli-breaking" as const, text: `${personOnly}${reservedNames["cli-breaking"]}, by the reviewer's reading (it renames a flag).` };
  f.reply(f.review().reviewer, verdict(f.review(), { reserved: [{ case: "cli-breaking", why: "it renames a flag" }] }));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [cli.text, imageHold] });
  assert.equal(f.registry.questions.question(first!.id), null, "the question the person never answered is gone, so an answer to it finds nothing");
  const [second, ...more] = openHolds(f);
  assert.deepEqual(more, []);
  assert.deepEqual(second!.holds.holds, [cli, { code: "reserved-path:image-rebuild", text: imageHold }]);
  assert.match(second!.text, /^Land pull request #7, "Add the cache", at 111111111111, waiving breaking changes to the CLI's contract and pylon image rebuilds\?\n/);
  assert.equal(second!.reserved, "cli-breaking");

  loop.answerHolds(second!, "Land", "nLAPTOP" as TailnetNodeId);
  assert.equal(f.review().phase.kind, "checking", "as a Land press does");
  assert.deepEqual(f.review().waiver!.codes, ["reserved:cli-breaking", "reserved-path:image-rebuild"]);
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
});

test("a Land answer given before a hold appears does not cover it: the landing holds and asks the whole set again", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const [first] = openHolds(f);
  loop.answerHolds(first!, "Land", "nLAPTOP" as TailnetNodeId);
  f.reply(f.review().reviewer, verdict(f.review(), { reserved: [{ case: "irreversible", why: "it drops a table" }] }));
  await loop.poll();
  assert.deepEqual(f.merges, [], "a waiver of the set the person saw never lands a larger one");
  assert.equal(f.review().phase.kind, "needs-person");
  const [again] = openHolds(f);
  assert.deepEqual(again!.holds.holds.map((h) => h.code), ["reserved:irreversible", "reserved-path:image-rebuild"]);
  assert.match(again!.text, /waiving anything irreversible and pylon image rebuilds\?/);
});

const yolo = { mode: "yolo" as const, enabledBy: "nLAPTOP" };

test("a yolo project's review answers its own holds question with Land for whoever turned it on, and lands with the waiver naming the setting", async (t) => {
  const f = fixture(t, { autoReview: yolo });
  f.files = dockerfile;
  const loop = f.loop();
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  await loop.poll();
  const [question, ...more] = holdQuestions(f);
  assert.deepEqual(more, []);
  assert.deepEqual({ option: question!.answer?.option, by: question!.answer?.by }, { option: "Land", by: "nLAPTOP" }, "answered in the pass that asked it");
  const { at, ...waiver } = f.review().waiver!;
  assert.deepEqual(waiver, { head: head1, holds: [imageHold], codes: ["reserved-path:image-rebuild"], by: "nLAPTOP", change: null, yolo: "nexus" });
  assert.equal(f.registry.threads.events("0", { kinds: ["review.waived"], thread: f.builder }).at(-1)?.payload.yolo, "nexus");
  assert.notEqual(f.registry.threads.attention(f.builder), "decision");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, [head1]);
});

test("a yolo project's waiver never covers what the policy lets no one waive: a failed check still stops the landing", async (t) => {
  const f = fixture(t, { autoReview: yolo });
  f.files = dockerfile;
  f.check = { kind: "done", passed: false, output: "boom" };
  const loop = f.loop();
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  await loop.poll();
  assert.deepEqual(f.review().waiver?.yolo, "nexus");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.equal(f.review().phase.kind, "fixing", "the failed check goes back to the builder, as it would without the waiver");
  assert.ok(f.review().waiver!.codes.every((code) => code === "reserved-path:image-rebuild"), "the waiver covers only the hold the person may waive");
});

test("a project switched from yolo to land answers no more holds questions, and the one it answered stays answered", async (t) => {
  const f = fixture(t, { autoReview: yolo });
  f.files = dockerfile;
  const loop = f.loop();
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  await loop.poll();
  const [first] = holdQuestions(f);
  assert.equal(first!.answer?.option, "Land");
  f.registry.projects.editProject("nexus" as ProjectId, (p) => ({ ...p, autoReview: { mode: "land", enabledBy: "nLAPTOP" } }));
  f.reply(f.review().reviewer, verdict(f.review(), { reserved: [{ case: "cli-breaking", why: "it renames a flag" }] }));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  const [open, ...more] = openHolds(f);
  assert.deepEqual(more, []);
  assert.deepEqual(open!.holds.holds.map((h) => h.code), ["reserved:cli-breaking", "reserved-path:image-rebuild"], "the new holds wait on the person");
  assert.equal(f.registry.questions.question(first!.id)?.answer?.option, "Land");
});

test("a landing a yolo setting answered at approval holds again once the project stops landing on its own", async (t) => {
  const f = fixture(t, { autoReview: yolo });
  const loop = f.loop();
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { reserved: [{ case: "cli-breaking", why: "it renames a flag" }] }));
  f.check = { kind: "running" };
  await loop.poll();
  assert.equal(f.review().waiver?.yolo, "nexus", "answered once the reviewer named the case");
  assert.deepEqual(f.review().land, { requestedBy: "nLAPTOP", fromProject: true }, "still the project's landing");
  f.registry.projects.editProject("nexus" as ProjectId, (p) => ({ ...p, autoReview: { mode: "review", enabledBy: "nLAPTOP" } }));
  f.check = { kind: "done", passed: true, output: "ok" };
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [
    "Project nexus no longer lands its builders' pull requests on its own, so this one is the person's to land.",
    `${personOnly}${reservedNames["cli-breaking"]}, by the reviewer's reading (it renames a flag).`,
  ] });
});

test("a yolo setting turned on by someone who is not a deployer answers nothing", async (t) => {
  const f = fixture(t, { autoReview: { mode: "yolo", enabledBy: "nPHONE" } });
  f.files = dockerfile;
  const loop = f.loop();
  await loop.auto(f.registry.threads.thread(f.builder)!, f.pr);
  await loop.poll();
  assert.equal(openHolds(f).length, 1);
  assert.equal(f.review().waiver, null);
});

test("Leave it waives nothing, and the review holds for the person without asking the same holds again", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  const [question] = openHolds(f);
  loop.answerHolds(question!, "Leave it", "nLAPTOP" as TailnetNodeId);
  assert.equal(f.review().waiver, null);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [imageHold] });
  assert.deepEqual(openHolds(f), []);
  assert.deepEqual(holdQuestions(f).map((q) => q.answer?.option), ["Leave it"]);
});

test("a review held for the person before it asked about its holds asks on the next pass, and the land route's waiver answers that question", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = await approved(f, "nLAPTOP");
  assert.equal(f.review().phase.kind, "needs-person");
  f.registry.questions.replaceQuestions(f.builder, "holds-", null);
  assert.deepEqual(holdQuestions(f), [], "as a review held before this change has no question");
  const restarted = f.loop();
  await restarted.poll();
  const [question] = openHolds(f);
  assert.deepEqual(question!.holds.holds.map((h) => h.text), [imageHold]);
  restarted.land(f.builder, "nLAPTOP", head1, [imageHold]);
  assert.deepEqual({ option: f.registry.questions.question(question!.id)!.answer?.option, by: f.registry.questions.question(question!.id)!.answer?.by }, { option: "Land", by: "nLAPTOP" });
  await restarted.poll();
  assert.deepEqual(f.merges, [head1]);
});

test("an answer to a question about holds at a head the review left waives nothing", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const [question] = openHolds(f);
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  pushed(f, head2);
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  await loop.poll();
  assert.equal(f.review().rounds.at(-1)!.head, head2);
  assert.throws(() => loop.answerHolds(question!, "Land", "nLAPTOP" as TailnetNodeId), { kind: "conflict", message: /moved on/ });
  assert.equal(f.review().waiver, null);
  assert.deepEqual(openHolds(f).map((q) => q.holds.head), [head2], "the new head asks for itself");
});

test("a review that cannot land, or ended, asks nothing, and a cancel drops its open question", async (t) => {
  const f = fixture(t, { claudeBuilder: false, secrets: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }] as SecretGrant[] });
  f.files = dockerfile;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(f.review().reviewerKind, "claude");
  assert.deepEqual(openHolds(f), [], "no press lands what a Claude reviewer approves, so there is nothing to ask");

  const g = fixture(t);
  g.files = dockerfile;
  const gLoop = g.loop();
  await gLoop.start(g.builder, { land: null });
  await gLoop.poll();
  assert.equal(openHolds(g).length, 1);
  gLoop.cancel(g.builder, "nLAPTOP");
  assert.deepEqual(openHolds(g), []);
  assert.notEqual(g.registry.threads.attention(g.builder), "decision");
});

test("a waiver given while the reviewer reads carries to a rebase that keeps the change, without asking again", async (t) => {
  const f = fixture(t);
  f.files = migration(240);
  f.changes.set(head1, migration(240));
  f.changes.set(head2, migration(250));
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  const [question] = openHolds(f);
  assert.deepEqual(question!.holds.holds.map((h) => h.text), reservedHolds);
  loop.answerHolds(question!, "Land", "nLAPTOP" as TailnetNodeId);
  await loop.poll();
  assert.equal(f.review().waiver!.change?.kind, "known", "the change the person waived is read at once, as a landing reads it");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  conflicting(f);
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing", "the conflict goes back to the builder");
  rebased(f);
  f.reply(f.builder, answers(f.review(), [{ id: "CONFLICT", action: "fixed", reason: "Rebased onto main." }]));
  await loop.poll();
  assert.deepEqual(f.merges, [head2]);
  assert.deepEqual(openHolds(f), []);
  assert.deepEqual(holdQuestions(f).map((q) => q.answer?.option), ["Land"], "the person was asked once");
});

test("an answer to a question asked against another base waives nothing, as a retarget at the same head is another change", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = await approved(f, null);
  const [question] = openHolds(f);
  assert.equal(question!.holds.base, "main");
  const round = f.review().rounds.at(-1)!;
  f.registry.reviews.saveReview({ ...f.review(), rounds: [...f.review().rounds, { head: round.head, base: "release", verdict: null, check: null, answers: null }], phase: { kind: "reviewing" }, waiver: null });
  assert.throws(() => loop.answerHolds(question!, "Land", "nLAPTOP" as TailnetNodeId), { kind: "conflict", message: /moved on/ });
  assert.equal(f.review().waiver, null);
  assert.throws(() => loop.land(f.builder, "nLAPTOP", head1, [imageHold]), { kind: "conflict" });
});

test("a cancel while the loop reads the head's change leaves no question open", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = f.loop();
  let cancelled = false;
  f.changes.has = (head: string) => {
    if (!cancelled) { cancelled = true; loop.cancel(f.builder, "nLAPTOP"); }
    return Map.prototype.has.call(f.changes, head);
  };
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.ok(cancelled);
  assert.equal(f.review().phase.kind, "cancelled");
  assert.deepEqual(openHolds(f), [], "the step that read the change before the cancel asks nothing");
  assert.notEqual(f.registry.threads.attention(f.builder), "decision");
});

test("a Land answer to an early question lands a review the live check left with the person before its holds were recorded", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  f.verifies = true;
  f.live = { kind: "running" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "verifying");
  f.tick(61 * 60_000);
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person", "the live check gave no verdict");
  assert.equal(f.review().rounds.at(-1)!.heldAt, undefined, "its holds were never recorded");
  const [question] = openHolds(f);
  assert.deepEqual(question!.holds.holds.map((h) => h.text), [imageHold], "the early question is still the one to answer");
  loop.answerHolds(question!, "Land", "nLAPTOP" as TailnetNodeId);
  assert.deepEqual(f.review().waiver!.codes, ["reserved-path:image-rebuild"]);
  f.live = { kind: "done", passed: true, output: "fleet ok" };
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "the landing reads the holds from GitHub's files, and the waiver gets it past them");
});

test("a live check that failed after an early question leaves nothing to land, so the question goes", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  f.verifies = true;
  f.live = { kind: "done", passed: false, output: "broken" };
  const loop = f.loop();
  await loop.start(f.builder, { land: null, rounds: 1 });
  await loop.poll();
  assert.equal(openHolds(f).length, 1);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  await loop.poll();
  assert.equal(f.review().phase.kind, "needs-person");
  assert.equal(landable(f.review()), false);
  assert.deepEqual(openHolds(f), []);
});

test("an early Land asks for the landing of the head it named only: a new head that changes the change stops at approval for the person", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const [question] = openHolds(f);
  loop.answerHolds(question!, "Land", "nLAPTOP" as TailnetNodeId);
  assert.deepEqual(f.review().land, { requestedBy: "nLAPTOP", head: head1, base: "main" }, "the request names the head and base the person saw");
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  f.files = [{ path: "src/cache.ts", previous: null, patch: "@@ -0,0 +1 @@\n+export const ttl = 1;" }];
  pushed(f, head2);
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Added a TTL." }]));
  await loop.poll();
  assert.equal(f.review().rounds.at(-1)!.head, head2);
  assert.equal(f.review().land, null, "the press was for a change the new head no longer is");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "approved" }, "as on main, the person lands what they have not seen");
});

test("an early Land on a review started with --land keeps its request, and one for a head carries with its waiver to a rebase that keeps the change", async (t) => {
  const g = fixture(t);
  g.files = dockerfile;
  const gLoop = g.loop();
  await gLoop.start(g.builder, { land: "nLAPTOP" });
  await gLoop.poll();
  const [asked] = openHolds(g);
  gLoop.answerHolds(asked!, "Land", "nLAPTOP" as TailnetNodeId);
  assert.deepEqual(g.review().land, { requestedBy: "nLAPTOP" });

  const f = fixture(t);
  f.files = migration(240);
  f.changes.set(head1, migration(240));
  f.changes.set(head2, migration(250));
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const [question] = openHolds(f);
  loop.answerHolds(question!, "Land", "nLAPTOP" as TailnetNodeId);
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  conflicting(f);
  await loop.poll();
  rebased(f);
  f.reply(f.builder, answers(f.review(), [{ id: "CONFLICT", action: "fixed", reason: "Rebased onto main." }]));
  await loop.poll();
  assert.deepEqual(f.merges, [head2], "the same change is the one the person saw");
});

test("the same holds in another order are the same question, so a Leave it is not asked again", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { reserved: [{ case: "cli-breaking", why: "it renames a flag" }] }));
  await loop.poll();
  const [question] = openHolds(f);
  loop.answerHolds(question!, "Leave it", "nLAPTOP" as TailnetNodeId);
  const phase = f.review().phase as Extract<Review["phase"], { kind: "needs-person" }>;
  f.registry.reviews.saveReview({ ...f.review(), phase: { ...phase, ...personPhase("policy", ...[...phase.holds].reverse()) } });
  await f.loop().poll();
  assert.deepEqual(openHolds(f), []);
});

test("a review saved settled while its question was open leaves no question open after the next pass", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(openHolds(f).length, 1);
  f.registry.reviews.saveReview({ ...f.review(), merged, phase: { kind: "landed", commit: merged }, outbox: null });
  await loop.poll();
  assert.deepEqual(openHolds(f), []);
  assert.notEqual(f.registry.threads.attention(f.builder), "decision");
});

test("an early Land is for the base it was asked against too: a retarget at the same head stops at approval for the person", async (t) => {
  const f = fixture(t);
  f.files = dockerfile;
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const [question] = openHolds(f);
  loop.answerHolds(question!, "Land", "nLAPTOP" as TailnetNodeId);
  assert.deepEqual(f.review().land, { requestedBy: "nLAPTOP", head: head1, base: "main" });
  f.files = [{ path: "src/cache.ts", previous: null, patch: "@@ -0,0 +1 @@\n+export {};" }];
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, base: "release" } };
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().rounds.map((r) => [r.head, r.base]), [[head1, "main"], [head1, "release"]], "the retarget gets a round of its own");
  assert.equal(f.review().land, null, "the press was for the change against main");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  await loop.poll();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.review().phase, { kind: "approved" });
});

const claudeToken: SecretGrant[] = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }];
const secondOn: SecondReview = { always: false, lines: 150, reserved: true };
/** A change of `lines` added lines to each of `paths`. */
const sized = (lines: number, ...paths: string[]): ChangedFile[] => paths.map((path) => ({ path, previous: null, patch: `@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+const line${i} = ${i};`).join("\n")}` }));
const secondOf = (r: Review) => {
  assert.equal(r.second?.kind, "claude");
  return r.second as Extract<NonNullable<Review["second"]>, { kind: "claude" }>;
};
const secondVerdict = (r: Review, fields: Record<string, unknown>) => verdict({ ...r, expect: secondOf(r).expect }, fields);

test("a project without a second reviewer's setting, or a change its rule does not name, gets one reviewer as before", async (t) => {
  const f = fixture(t);
  f.files = sized(400, "src/cache.ts");
  const loop = f.loop();
  const review = await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(review.second, undefined);
  assert.equal(f.started.length, 1);
  assert.equal(review.rounds[0]!.secondVerdict, undefined);
  const g = fixture(t, { secondReview: secondOn, secrets: claudeToken });
  g.files = sized(20, "src/cache.ts");
  assert.equal((await g.loop().start(g.builder, { land: null })).second, undefined, "20 lines and no reserved path");
});

test("the second reviewer's rule names a change by its lines, tests and docs included, by a hold on its paths, or every change", () => {
  const rule = { always: false, lines: 150, reserved: false } as const;
  assert.equal(secondReviewRule(rule, sized(149, "src/a.ts"), true), null);
  assert.equal(secondReviewRule(rule, [...sized(100, "src/a.ts"), ...sized(50, "docs/a.md")], true), "the change has 150 changed lines, at least the 150 the project sets");
  assert.equal(secondReviewRule(rule, [{ path: "src/a.ts", previous: null, patch: "@@ -1,3 +1,3 @@\n-a\n+b\n c" }], true), null, "context lines do not count");
  assert.match(secondReviewRule(rule, [{ path: "logo.png", previous: null, patch: "" }], true)!, /GitHub shows no patch for logo.png/);
  const reserved = { always: false, lines: null, reserved: true } as const;
  assert.equal(secondReviewRule(reserved, sized(1, "src/control/policy.ts"), true), "the change has holds for the person on its paths: reserved-path:auth");
  assert.equal(secondReviewRule(reserved, sized(1, "src/control/policy.ts"), false), null, "another repository's paths are not Nexus's");
  assert.match(secondReviewRule(reserved, sized(1, ".nexus/check"), false)!, /check-changed/);
  assert.equal(secondReviewRule(reserved, sized(400, "src/a.ts"), true), null);
  assert.equal(secondReviewRule({ always: true }, sized(1, "src/a.ts"), true), "the project gives every pull request one");
});

test("each builder model gets the same first and second reviewer", () => {
  const table: [builder: { claude: boolean; model: string }, first: string, second: string][] = [
    [{ claude: true, model: "claude-opus-5-5" }, "gpt-6-astra", "claude-opus-5-5"],
    [{ claude: true, model: "claude-opus-5-5[1m]" }, "gpt-6-astra", "claude-opus-5-5"],
    [{ claude: true, model: "opus" }, "gpt-6-astra", "claude-opus-5-5"],
    [{ claude: true, model: "claude-fable-5-1" }, "gpt-6-astra", "claude-opus-5-5"],
    [{ claude: true, model: "claude-sonnet-5-5" }, "gpt-6-astra", "claude-opus-5-5"],
    [{ claude: true, model: "claude-haiku-5-5" }, "gpt-6-astra", "claude-opus-5-5"],
    [{ claude: false, model: "gpt-6-astra" }, "claude-opus-5-5", "claude-opus-5-5"],
    [{ claude: false, model: "gpt-6-astra-mini" }, "claude-opus-5-5", "claude-opus-5-5"],
  ];
  for (const [builder, first, second] of table) {
    const reviewer = reviewerFor(builder, claudeToken, "gpt-6-astra");
    assert.deepEqual(reviewer, { claude: !builder.claude, model: first }, builder.model);
    assert.deepEqual(secondReviewerFor([builder.model, first], claudeToken), { model: second }, builder.model);
  }
});

test("the second reviewer always runs Opus, even when another participant does, or refuses without a token", () => {
  assert.deepEqual(secondReviewerFor(["claude-opus-5-5", "gpt-6-astra"], claudeToken), { model: "claude-opus-5-5" });
  assert.deepEqual(secondReviewerFor(["claude-fable-5-1", "gpt-6-astra"], claudeToken), { model: "claude-opus-5-5" });
  assert.deepEqual(secondReviewerFor(["opus", "gpt-6-astra"], claudeToken), { model: "claude-opus-5-5" }, "a builder alias does not exclude Opus");
  assert.deepEqual(secondReviewerFor(["claude-opus-5-5[1m]", "gpt-6-astra"], claudeToken), { model: "claude-opus-5-5" });
  assert.match((secondReviewerFor(["claude-opus-5-5", "gpt-6-astra"], []) as { why: string }).why, /harness runs only claude-opus-5-5 and gpt-6-astra, and the project grants no Claude token/);
  assert.deepEqual(secondReviewerFor(["claude-opus-5-5", "claude-opus-5-5"], claudeToken), { model: "claude-opus-5-5" });
});

test("a second reviewer reads the same change beside the first, unaware of it, and the round approves only once both approve", async (t) => {
  const f = fixture(t, { secondReview: secondOn, secrets: claudeToken });
  f.files = sized(160, "src/cache.ts");
  const loop = f.loop();
  const started = await loop.start(f.builder, { land: null });
  assert.deepEqual(started.models, { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" });
  await loop.poll();
  const second = secondOf(f.review());
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal(second.rule, "the change has 160 changed lines, at least the 150 the project sets");
  assert.deepEqual([f.started[1]!.request.claude !== undefined, f.started[1]!.request.model, f.started[1]!.role], [true, "claude-opus-5-5", "reviewer"]);
  assert.equal(f.registry.reviews.isReviewer(second.thread), true);
  const reviewer = f.review().reviewer;
  const first = f.sent.find((s) => s.to === reviewer)!.message.text;
  assert.equal(f.started[1]!.request.claude, first.replace("you run on gpt-6-astra", "you run on claude-opus-5-5").replace(f.review().expect, second.expect), "the second gets the first's request, on its own model and token");

  f.reply(reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "one approval is not the round's");
  assert.equal(f.review().rounds[0]!.verdict?.verdict, "approve");
  assert.equal(f.review().rounds[0]!.secondVerdict, null);
  assert.ok(reviewSaidText(f.review()).includes(`the reviewer ${reviewer} on gpt-6-astra approves, and the second reviewer ${second.thread} on claude-opus-5-5 has not answered`));
  assert.equal(f.sent.filter((s) => s.to === f.builder).length, 0);

  f.reply(second.thread, secondVerdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  const fix = f.sent.at(-1)!;
  assert.equal(fix.to, f.builder);
  assert.match(fix.message.text, /by a reviewer on gpt-6-astra and a second reviewer on claude-opus-5-5: changes requested/);
  assert.match(fix.message.text, /From the second reviewer on claude-opus-5-5:\n\n2\.F1 \(P1\) src\/cache.ts:1: The cache never expires/);
  assert.ok(reviewSaidText(f.review()).includes(`${reviewer} on gpt-6-astra approves, and the second reviewer ${second.thread} on claude-opus-5-5 asks for changes (P1)`));

  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Wrong ID." }]));
  await loop.poll();
  assert.match(f.sent.at(-1)!.message.text, /leave 2\.F1 without a fix/, "the builder answers the second reviewer's finding by its own ID");
  f.reply(f.builder, answers(f.review(), [{ id: "2.F1", action: "fixed", reason: "Added a 5-minute TTL." }]));
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.tick(10 * 60_000);
  await loop.poll();
  assert.equal(f.review().rounds.length, 2);
  assert.equal(f.review().rounds[1]!.secondVerdict, null);
  const toFirst = f.sent.filter((s) => s.to === reviewer).at(-1)!.message.text;
  const toSecond = f.sent.filter((s) => s.to === second.thread).at(-1)!.message.text;
  assert.doesNotMatch(toFirst, /TTL|2\.F1/, "the first reviewer never hears the second's findings");
  assert.match(toFirst, /The builder pushed new commits after the round you reviewed/);
  assert.match(toSecond, /The builder answered your findings:\nF1: fixed\. Added a 5-minute TTL\./);
  assert.match(toSecond, new RegExp(`git diff ${head1}..${head2}`));

  f.reply(secondOf(f.review()).thread, secondVerdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  f.reply(reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  assert.equal(roundsSpent(f.review()), 2, "one round runs both reviewers");
  assert.ok(reviewSaidText(f.review()).includes(`round 2: the reviewer ${reviewer} on gpt-6-astra approves, and the second reviewer ${second.thread} on claude-opus-5-5 approves`));
  assert.deepEqual(f.registry.threads.events("0", { kinds: ["review.changed"] }).map((e) => e.payload.second), [undefined, ...Array(4).fill(second.thread)], "the review's events name the second reviewer once it started");
});

test("a second reviewer that never answers, answers without the block or whose model keeps failing holds the review for the person, never approving it", async (t) => {
  const silent = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  let loop = silent.loop();
  await loop.start(silent.builder, { land: null });
  await loop.poll();
  silent.reply(silent.review().reviewer, verdict(silent.review(), {}));
  await loop.poll();
  silent.tick(4 * 3_600_000);
  await loop.poll();
  assert.deepEqual(shown(silent.review().phase), { kind: "needs-person", reasons: ["The second reviewer gave no answer Nexus could read within 3 hours in round 1."] });
  assert.equal(landable(silent.review()), false);

  const garbled = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  loop = garbled.loop();
  await loop.start(garbled.builder, { land: null });
  await loop.poll();
  garbled.reply(garbled.review().reviewer, verdict(garbled.review(), {}));
  for (let i = 0; i < 3; i++) {
    garbled.reply(secondOf(garbled.review()).thread, "```nexus-review\n{\"verdict\": \"approve\"}\n```");
    await loop.poll();
  }
  assert.equal(garbled.sent.filter((s) => s.to === secondOf(garbled.review()).thread).length, 2, "two reminders, under its own token");
  assert.ok(garbled.sent.filter((s) => s.to === secondOf(garbled.review()).thread).every((s) => s.message.text.includes(secondOf(garbled.review()).expect)));
  assert.deepEqual(shown(garbled.review().phase), { kind: "needs-person", reasons: ["The second reviewer ended 3 turns in a row without an answer Nexus could read, in round 1."] });

  const failing = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  loop = failing.loop();
  await loop.start(failing.builder, { land: null });
  await loop.poll();
  failing.failedTurn(secondOf(failing.review()).thread, "overloaded_error");
  await loop.poll();
  assert.match(phaseNote(failing.review()), /the second reviewer's model is failing \(1 in a row, last: overloaded_error\)/);
  for (const wait of [2, 5, 10, 20]) {
    failing.tick(wait * 60_000);
    await loop.poll();
    assert.equal(failing.sent.at(-1)!.to, secondOf(failing.review()).thread, "the same request goes again");
    failing.failedTurn(secondOf(failing.review()).thread, "overloaded_error");
    await loop.poll();
  }
  assert.equal(failing.review().phase.kind, "needs-person");
  assert.match((failing.review().phase as { reasons: string[] }).reasons[0]!, /The second reviewer's model failed 5 times in a row/);
});

test("a second reviewer whose thread the person archives stops the review for them, and both reviewers go once it lands or is cancelled", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.registry.threads.setThreadStatus(secondOf(f.review()).thread, "archived");
  await loop.poll();
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [`The second reviewer thread ${secondOf(f.review()).thread} is archived, so the review stopped.`] });

  const g = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  const cancelling = g.loop();
  await cancelling.start(g.builder, { land: null });
  await cancelling.poll();
  cancelling.cancel(g.builder, "nLAPTOP");
  assert.deepEqual([g.review().reviewer, secondOf(g.review()).thread].map((id) => g.registry.threads.thread(id)!.status), ["archived", "archived"]);
  assert.equal(secondOf(g.review()).outbox, null);

  const h = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  const landing = h.loop();
  await landing.start(h.builder, { land: "nLAPTOP" });
  await landing.poll();
  h.reply(h.review().reviewer, verdict(h.review(), {}));
  h.reply(secondOf(h.review()).thread, secondVerdict(h.review(), {}));
  await landing.poll();
  assert.deepEqual(h.merges, [head1]);
  released(h, merged);
  await landing.poll();
  assert.deepEqual(h.review().phase, { kind: "landed", commit: merged });
  assert.deepEqual([h.builder, h.review().reviewer, secondOf(h.review()).thread].map((id) => h.registry.threads.thread(id)!.status), ["archived", "archived", "archived"]);
});

test("a review whose rule asks for a second reviewer that no other model can run says so, and holds its landing for the person to waive", async (t) => {
  const f = fixture(t, { secondReview: { always: true } });
  const loop = f.loop();
  const review = await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  assert.equal(f.started.length, 1, "the same model is never started twice");
  assert.deepEqual(review.second, { kind: "none", rule: "the project gives every pull request one", why: "the harness runs only claude-opus-5-5 and gpt-6-astra, and the project grants no Claude token for a Claude worker. Grant CLAUDE_CODE_OAUTH_TOKEN for api.anthropic.com to the project (`nexus project edit`)" });
  assert.match(reviewSaidText(review), /No second reviewer runs, though the project gives every pull request one: the harness runs only/);
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.merges, []);
  const hold = `The project asks for an independent second reviewer on Claude Opus 5.5, since the project gives every pull request one, and none could run: ${review.second!.kind === "none" && review.second!.why}.`;
  assert.deepEqual(shown(f.review().phase), { kind: "needs-person", reasons: [hold] });
  assert.deepEqual(holdRule("no-second-reviewer"), { holdsAgain: true, waivable: true, why: "Landing on one reviewer's approval where the project asks for two is yours to accept, and pressing Land here is you accepting it." });
  loop.land(f.builder, "nLAPTOP", head1, [hold]);
  await loop.poll();
  assert.deepEqual(f.merges, [head1], "the person's waiver lands it");
});

test("a stored round of a review with a second reviewer that lacks its verdict has none, so the first reviewer's approval alone does not approve it", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const { secondVerdict: _, ...lost } = f.review().rounds[0]!;
  saveOlder(f, { ...f.review(), rounds: [lost] });
  assert.equal(f.review().rounds[0]!.secondVerdict, null);
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
});

test("a second reviewer's finding IDs never meet the first's, and the builder can answer every finding of both", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const long = "F".repeat(40);
  const many = (prefix: string) => Array.from({ length: 50 }, (_, i) => ({ ...serious, id: i === 0 ? long : `${prefix}${i}` }));
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [{ ...serious, id: "2-F1" }, ...many("A").slice(1)] }));
  f.reply(secondOf(f.review()).thread, secondVerdict(f.review(), { verdict: "changes", findings: [{ ...serious, id: "F1" }, ...many("B")].slice(0, 50) }));
  await loop.poll();
  const ids = findingsOf(f.review().rounds[0]!).map((finding) => finding.id);
  assert.equal(new Set(ids).size, 100, "no two findings share an ID");
  assert.ok(ids.includes("2-F1") && ids.includes("2.F1") && ids.includes(`2.${long}`));
  f.reply(f.builder, answers(f.review(), ids.map((id) => ({ id, action: "rejected", reason: "Not a bug." }))));
  f.tick(10 * 60_000);
  await loop.poll();
  assert.equal(f.review().rounds[0]!.answers?.length, 100, "every answer reads");
  assert.equal(f.review().rounds.length, 2);
  assert.match(f.sent.filter((s) => s.to === f.review().reviewer).at(-1)!.message.text, /2-F1: rejected/, "the first reviewer's own 2-F1 answer goes to it");
  assert.doesNotMatch(f.sent.filter((s) => s.to === secondOf(f.review()).thread).at(-1)!.message.text, /2-F1|A1:/);
});

test("the policy holds a landing the second reviewer has not approved, and reads its reserved cases", () => {
  const second = { kind: "claude", rule: "the project gives every pull request one", thread: "th-second" as ThreadId, model: "claude-opus-5-5", expect: "rv-1:s", asked: "", since: 1, nudges: 0, outbox: null } as const;
  const approval = { token: "t", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: "the cache under real traffic" };
  const round = (secondVerdict: Verdict | null) => ({ head: head1, base: "main", verdict: approval, secondVerdict, check: { passed: true, output: "ok" }, live: { kind: "absent" } as const, answers: null, heldAt: { base: "main", holds: [] } });
  const pr: PrSnapshot = { pr: testPr({ number: 7, head: head1, checks: "passing" }), detail: { head: head1, branch: "feature", base: "main", body: "Not checked live: the cache under real traffic.", mergeCommit: null }, failures: [], comments: [] };
  const held = (r: Review) => holdsAt(r, { pr }).map((h) => h.text);
  assert.deepEqual(held(testReview({ second, rounds: [round(null)] })), ["The second reviewer has not approved the latest commits."]);
  const { secondVerdict: _, ...lost } = round(null);
  assert.deepEqual(held(testReview({ second, rounds: [lost] })), ["The second reviewer has not approved the latest commits."], "a round that lost the verdict has no approval");
  assert.deepEqual(held(testReview({ second, rounds: [round(approval)] })), []);
  const reserved = { ...approval, reserved: [{ case: "auth" as const, why: "it loosens the probe's guard" }] };
  assert.deepEqual(headHolds({ review: testReview({ second, rounds: [round(reserved)] }), files: [], deploys: true }).map((h) => [h.code, h.text]),
    [["reserved:auth", `${personOnly}${reservedNames.auth}, by the second reviewer's reading (it loosens the probe's guard).`]]);
});

/**
 * The pull requests of 2026-11-04 whose serious bug a diff read on a second model found after Nexus's reviewer passed
 * them or while it read them: their changed files at the head with the bug, and the finding, as the builder recorded it.
 */
const missed: readonly { pr: number; files: ChangedFile[]; finding: { id: string; priority: "P1"; where: string; summary: string; detail: string } }[] = [
  {
    pr: 442,
    files: [...sized(60, "src/deploy/worker.ts"), ...sized(40, "src/deploy/plan.ts"), ...sized(9, "src/deploy/install.ts"), ...sized(130, "src/deploy/worker.test.ts"), ...sized(10, "deploy/README.md")],
    finding: { id: "F1", priority: "P1", where: "src/deploy/worker.ts:215", summary: "A read error after the stop leaves the control plane stopped", detail: "rollbackRefused stops nexus-control, then reads the registry's schema. If that read throws, the start never runs, install.ts records failed, and the control plane stays down with no API." },
  },
  {
    pr: 444,
    files: [...sized(57, "src/control/policy.ts"), ...sized(70, "src/control/review.test.ts"), ...sized(31, "docs/merge-policy.md")],
    finding: { id: "F1", priority: "P1", where: "src/control/policy.ts:40", summary: "A line added beside a guard skips the reserved path hold", detail: "changes reads only added, deleted and hunk header lines, so `if (url.searchParams.has(\"debug\")) return backend.guest(id).stream([\"sh\"]);` above the probe's authorized() check holds nothing: an unauthenticated shell into a pylon." },
  },
  {
    pr: 445,
    files: [...sized(59, "src/control/review.ts"), ...sized(130, "src/control/review.test.ts"), ...sized(31, "docs/design.md")],
    finding: { id: "F1", priority: "P1", where: "src/control/review.ts:144", summary: "A retargeted PR's next round reviews only the new commits", detail: "rewritten ignores retargeted, so after fixes on a PR retargeted from a stacked branch to main the reviewer reads git diff old..new and never the change against the new base." },
  },
];

test("each pull request a second model caught on 2026-11-04 gets a second reviewer by default, and its finding stops the approval the first reviewer gave", async (t) => {
  for (const { pr, files, finding } of missed) {
    const f = fixture(t, { secondReview: defaultSecondReview, secrets: claudeToken });
    f.files = files;
    const loop = f.loop();
    const review = await loop.start(f.builder, { land: "nLAPTOP" });
    await loop.poll();
    assert.equal(f.review().second?.kind, "claude", `#${pr} gets a second reviewer: ${f.review().second?.rule}`);
    f.reply(review.reviewer, verdict(f.review(), {}));
    f.reply(secondOf(f.review()).thread, secondVerdict(f.review(), { verdict: "changes", findings: [finding] }));
    await loop.poll();
    assert.equal(f.review().phase.kind, "fixing", `#${pr} goes back to its builder`);
    assert.deepEqual(f.merges, [], `#${pr} does not land on the first reviewer's approval`);
    assert.equal(landable(f.review()), false);
    assert.match(f.sent.at(-1)!.message.text, new RegExp(`From the second reviewer on claude-opus-5-5:\\n\\n2\\.F1 \\(P1\\) ${finding.where}: ${finding.summary}`));
  }
  assert.match(secondReviewRule(defaultSecondReview, missed[1]!.files, true)!, /^the change has 158 changed lines/);
  assert.equal(secondReviewRule({ always: false, lines: null, reserved: true }, missed[2]!.files, true), "the change has holds for the person on its paths: reserved-path:auth", "#445 changed the review loop, which holds as the policy's own code");
});

test("both reviewers get the builder's brief, cut as the description is, so a change that leaves out what it asked for can be found", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const first = f.sent.find((s) => s.to === f.review().reviewer)!.message.text;
  assert.match(first, /The brief the builder was given, which says what the change must do\. .*\n<brief>\nfix it\n<\/brief>/);
  assert.match(f.started[1]!.request.claude!, /<brief>\nfix it\n<\/brief>/, "the second reviewer gets the same brief");

  const g = fixture(t, { claudeBuilder: false, secrets: claudeToken });
  g.briefs.set(g.builder, "x".repeat(9_000));
  const gLoop = g.loop();
  await gLoop.start(g.builder, { land: null });
  await gLoop.poll();
  assert.equal(g.review().brief, "x".repeat(8_000), "a harness builder's first message, cut at 8,000 characters");
  assert.match(g.started[0]!.request.claude!, new RegExp(`<brief>\\n${"x".repeat(8_000)}\\n</brief>`));
});

test("a builder's brief is its Claude worker's prompt or its harness conversation's first message, and a bare thread has none", async (t) => {
  const f = fixture(t, { claudeBuilder: false });
  const fake = fakeHarness();
  const harness = f.registry.threads.thread(f.builder)!;
  await fake.harness.startThread({ threadId: harness.id, pylonId: harness.pylonId });
  fake.transcript(harness.id).messages.push({ role: "user", content: "Add the cache", timestamp: 1 }, { role: "user", content: "and a TTL", timestamp: 2 });
  const brief = agentReader(f.registry, fake.harness, storedTranscripts).brief;
  assert.equal(await brief(harness), "Add the cache");
  assert.equal(await brief(f.registry.threads.thread(f.add("th-claude", true))!), "fix it");
  assert.equal(await brief(f.registry.threads.thread(f.add("th-check-bare", false, checkCaller, true))!), null);
});

test("a pull request that grows into the second reviewer's rule in a fix round, or in a push after approval, gets one from that round on", async (t) => {
  const f = fixture(t, { secondReview: { always: false, lines: 150, reserved: false }, secrets: claudeToken });
  f.files = sized(20, "src/cache.ts");
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  assert.equal(f.review().second, undefined);
  f.reply(f.review().reviewer, verdict(f.review(), { verdict: "changes", findings: [serious] }));
  await loop.poll();
  f.reply(f.builder, answers(f.review(), [{ id: "F1", action: "fixed", reason: "Rewrote it." }]));
  f.files = sized(200, "src/cache.ts");
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.tick(10 * 60_000);
  await loop.poll();
  const second = secondOf(f.review());
  assert.equal(second.rule, "the change has 200 changed lines, at least the 150 the project sets");
  assert.equal(f.review().rounds[0]!.secondVerdict, undefined, "the round before it had none");
  assert.equal(f.review().rounds[1]!.secondVerdict, null);
  assert.match(f.started.at(-1)!.request.claude!, new RegExp(`git checkout --detach ${head2}`), "it reads the whole change at the round's head");
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "the round waits for it");
  f.reply(second.thread, secondVerdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });

  const g = fixture(t, { secondReview: { always: false, lines: 150, reserved: false }, secrets: claudeToken });
  g.files = sized(20, "src/cache.ts");
  const pushed = g.loop();
  await pushed.start(g.builder, { land: null });
  await pushed.poll();
  g.reply(g.review().reviewer, verdict(g.review(), {}));
  await pushed.poll();
  assert.deepEqual(g.review().phase, { kind: "approved" });
  g.files = sized(200, "src/cache.ts");
  const head3 = "3".repeat(40);
  g.snapshot = { ...g.snapshot, detail: { ...g.snapshot.detail, head: head3 } };
  g.watched("open");
  g.registry.prWatches.savePrWatch(g.builder, { links: [{ pr: { ...g.pr, head: head3 }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  await pushed.poll();
  assert.equal(g.review().rounds.at(-1)!.head, head3);
  assert.equal(secondOf(g.review()).rule, "the change has 200 changed lines, at least the 150 the project sets");
});

test("a second reviewer whose start keeps failing other than by a refusal goes the way a refused one does", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  f.failStart = (request) => request.model === "claude-opus-5-5" ? "the harness is unreachable" : null;
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  assert.deepEqual({ ...f.review().second, since: 0, tried: 0 }, { kind: "starting", rule: "the project gives every pull request one", model: "claude-opus-5-5", since: 0, tried: 0, why: "the harness is unreachable" });
  f.tick(31 * 60_000);
  await loop.poll();
  assert.deepEqual(f.review().second, { kind: "none", rule: "the project gives every pull request one", why: "its thread did not start within 30 minutes: the harness is unreachable" });
});

test("a second reviewer whose thread does not start yet is tried again each minute, and only after 30 minutes does the review go on without it", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  f.refuseStart = (request) => request.model === "claude-opus-5-5" ? "no node has room for this pylon" : null;
  const loop = f.loop();
  await loop.start(f.builder, { land: "nLAPTOP" });
  await loop.poll();
  assert.deepEqual({ ...f.review().second, since: 0, tried: 0 }, { kind: "starting", rule: "the project gives every pull request one", model: "claude-opus-5-5", since: 0, tried: 0, why: "no node has room for this pylon" });
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing", "a reviewer that has not started has not approved");
  assert.match(reviewSaidText(f.review()), /the second reviewer on claude-opus-5-5 is starting, after a start that failed: no node has room/);
  f.refuseStart = () => null;
  f.tick(60_000);
  await loop.poll();
  const second = secondOf(f.review());
  assert.equal(f.started.at(-1)!.request.model, "claude-opus-5-5");
  f.reply(second.thread, secondVerdict(f.review(), {}));
  await loop.poll();
  assert.notEqual(f.review().phase.kind, "reviewing");

  const g = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  g.refuseStart = (request) => request.model === "claude-opus-5-5" ? "no node has room for this pylon" : null;
  const refused = g.loop();
  await refused.start(g.builder, { land: "nLAPTOP" });
  await refused.poll();
  g.reply(g.review().reviewer, verdict(g.review(), {}));
  // The first reviewer's reply took the clock a minute on.
  for (let minute = 0; minute < 28; minute++) {
    g.tick(60_000);
    await refused.poll();
    assert.equal(g.review().second?.kind, "starting");
  }
  g.tick(60_000);
  await refused.poll();
  await refused.poll();
  assert.deepEqual(g.review().second, { kind: "none", rule: "the project gives every pull request one", why: "its thread did not start within 30 minutes: no node has room for this pylon" });
  assert.deepEqual(g.merges, []);
  assert.deepEqual(shown(g.review().phase), { kind: "needs-person", reasons: ["The project asks for an independent second reviewer on Claude Opus 5.5, since the project gives every pull request one, and none could run: its thread did not start within 30 minutes: no node has room for this pylon."] });
});

test("a second reviewer is archived once both approve and the review waits on the person, and a new round starts it again", async (t) => {
  const f = fixture(t, { secondReview: { always: true }, secrets: claudeToken });
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  const first = secondOf(f.review()).thread;
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  f.reply(first, secondVerdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
  await loop.poll();
  assert.equal(f.registry.threads.thread(first)!.status, "archived", "its pylon can pause");
  assert.equal(f.registry.threads.thread(f.review().reviewer)!.status, "active", "the first reviewer may be asked to quote");
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.registry.prWatches.savePrWatch(f.builder, { links: [{ pr: { ...f.pr, head: head2 }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  const again = secondOf(f.review());
  assert.notEqual(again.thread, first, "a fresh thread reads the new head");
  assert.match(f.started.at(-1)!.request.claude!, new RegExp(`git checkout --detach ${head2}`));
  f.reply(f.review().reviewer, verdict(f.review(), {}));
  f.reply(again.thread, secondVerdict(f.review(), {}));
  await loop.poll();
  assert.deepEqual(f.review().phase, { kind: "approved" });
});
