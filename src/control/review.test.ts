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
import { landingHolds } from "./policy.ts";
import { humanLabel, reviewerCaller, reviewLoop, reviewPrefix, type Review } from "./review.ts";
import { checkCaller, type CheckState } from "./gate.ts";
import type { StartRequest } from "./threads.ts";

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
  function add(id: string, claude: boolean, startedBy = "test"): ThreadId {
    if (registry.thread(id as ThreadId) !== undefined) return id as ThreadId;
    const thread: Thread = { id: id as ThreadId, title: id, project: project.id, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: claude ? null : "1", startedBy, createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false, working: false };
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
  let delivery: "delivered" | "later" = "delivered";
  const deployers = new Set(["nLAPTOP"]);
  const loop = () => reviewLoop({
    registry, harnessModel: "gpt-6-astra",
    github: {
      find: async () => [7],
      poll: async () => structuredClone(snapshot),
      files: async () => files,
      async label(_, __, name) { labelCalls.push(name); return labelAnswer(name); },
      async merge(_, __, sha) { merges.push(sha); const answer = mergeAnswer(); if (answer.kind === "merged") snapshot = { ...snapshot, pr: { ...snapshot.pr, state: "merged" }, detail: { ...snapshot.detail, mergeCommit: answer.commit } }; return answer; },
    },
    inbox: async (target, message) => { if (delivery === "delivered") sent.push({ to: target.id, message }); return delivery; },
    replies: async (target) => replies.get(target.id) ?? [],
    checks: {
      async start() { const id = add(`th-check-${checkThreads.length + 1}`, false, checkCaller); checkThreads.push(id); return id; },
      poll: () => check,
      discard(id) { discarded.push(id); registry.setThreadStatus(id, "deleted"); },
    },
    release: { self, repo: "ramtinJ95/nexus" },
    mayLand: (caller) => deployers.has(caller),
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
    registry, builder, pr, loop, add, sent, started, merges, replies, reply, deployers,
    get snapshot() { return snapshot; }, set snapshot(s) { snapshot = s; },
    set files(f: ChangedFile[]) { files = f; },
    set mergeAnswer(a: () => MergeResult) { mergeAnswer = a; },
    labels, labelCalls, set labelAnswer(a: (name: string) => LabelResult) { labelAnswer = a; },
    set check(c: CheckState) { check = c; },
    checkThreads, discarded,
    set delivery(d: "delivered" | "later") { delivery = d; },
    tick(ms: number) { clock += ms; },
    review: () => registry.review(builder)!,
    watched(state: "open" | "merged" | "closed") { registry.savePrWatch(builder, { links: [{ pr: { ...pr, state }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null }); },
    attention: () => registry.events("0", { kinds: ["attention.changed"], thread: builder }).map((e) => e.payload.attention),
  };
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
  const round = { head: head1, verdict: { token: "x", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: "the cache under real traffic" }, check: { passed: true, output: "" }, answers: null };
  const review: Review = {
    id: "rv-1", builder: "th-b" as ThreadId, reviewer: "th-r" as ThreadId, pr: { repo: "acme/shop", number: 7, url: "", title: "", branch: "f" }, models: { builder: "m", reviewer: "m" }, reviewerKind: "harness",
    maxRounds: 3, land: null, auto: false, merged: null, expect: "rv-1:t", sent: 1, phase: { kind: "checking", startedAt: 0, thread: null }, outbox: null, since: 0, nudges: 0, startedAt: 0,
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
  assert.deepEqual(g.review().phase, { kind: "needs-person", reasons: ["The reviewer gave no answer within 3 hours in round 1."] });
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
