import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import type { LiveHash, NodeName, PylonId, TailnetNodeId } from "../protocol.ts";
import type { ProjectId, SecretGrant } from "../project.ts";
import type { ChangedFile, MergeResult, PrSnapshot } from "./github.ts";
import type { AutomatedMessage } from "./inbox.ts";
import { landingHolds } from "./policy.ts";
import { reviewLoop, reviewPrefix, type CheckState, type Review } from "./review.ts";
import type { StartRequest } from "./threads.ts";

const node = "node" as NodeName;
const self = "nCONTROL" as TailnetNodeId;
const head1 = "1".repeat(40);
const head2 = "2".repeat(40);
const merged = "m".repeat(40);
const previous = "p".repeat(40);

function fixture(t: import("node:test").TestContext, options: { path?: string; repo?: string; secrets?: SecretGrant[]; claudeBuilder?: boolean } = {}) {
  const registry = openRegistry(options.path ?? ":memory:");
  t.after(() => { try { registry.close(); } catch { /* closed by a restart */ } });
  const repo = options.repo ?? "ramtinJ95/nexus";
  const project = { id: "nexus" as ProjectId, repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: options.secrets ?? [], logins: [], preSetup: null };
  if (registry.project(project.id) === undefined) {
    registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: self });
    registry.createProject(project);
  }
  function add(id: string, claude: boolean, startedBy = "test"): ThreadId {
    if (registry.thread(id as ThreadId) !== undefined) return id as ThreadId;
    const thread: Thread = { id: id as ThreadId, title: id, project: project.id, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: claude ? null : "1", startedBy, createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false };
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
  let check: CheckState = { kind: "done", passed: true, output: "ok" };
  let delivery: "delivered" | "later" = "delivered";
  const loop = () => reviewLoop({
    registry, harnessModel: "gpt-6-astra",
    github: {
      find: async () => [7],
      poll: async () => structuredClone(snapshot),
      files: async () => files,
      async merge(_, __, sha) { merges.push(sha); const answer = mergeAnswer(); if (answer.kind === "merged") snapshot = { ...snapshot, pr: { ...snapshot.pr, state: "merged" }, detail: { ...snapshot.detail, mergeCommit: answer.commit } }; return answer; },
    },
    inbox: async (target, message) => { if (delivery === "delivered") sent.push({ to: target.id, message }); return delivery; },
    replies: async (target) => replies.get(target.id) ?? [],
    check: async () => check,
    release: { self, repo: "ramtinJ95/nexus" },
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
    registry, builder, loop, add, sent, started, merges, replies, reply,
    get snapshot() { return snapshot; }, set snapshot(s) { snapshot = s; },
    set files(f: ChangedFile[]) { files = f; },
    set mergeAnswer(a: () => MergeResult) { mergeAnswer = a; },
    set check(c: CheckState) { check = c; },
    set delivery(d: "delivered" | "later") { delivery = d; },
    tick(ms: number) { clock += ms; },
    review: () => registry.review(builder)!,
  };
}

const archive = (registry: ReturnType<typeof openRegistry>, id: ThreadId) => registry.setThreadStatus(id, "archived");
const verdict = (r: Review, fields: Record<string, unknown>) => `Done.\n\`\`\`nexus-review\n${JSON.stringify({ token: r.expect, verdict: "approve", findings: [], reserved: [], notCheckedLive: "the cache under real traffic", ...fields })}\n\`\`\``;
const answers = (r: Review, list: unknown[]) => `Fixed.\n\`\`\`nexus-review-answers\n${JSON.stringify({ token: r.expect, answers: list })}\n\`\`\``;
const serious = { id: "F1", severity: "serious", where: "src/cache.ts:1", summary: "The cache never expires", detail: "Add a TTL." };

test("a Claude builder's PR gets a harness reviewer, and findings, fixes and new commits go round until it approves", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  const started = await loop.start(f.builder, { land: null });
  assert.deepEqual(started.models, { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, "another model family than the builder's");
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
  assert.match(f.sent[1]!.message.text, /F1 \(serious\) src\/cache.ts:1: The cache never expires\n {4}Add a TTL\./);
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
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: ["The reviewer still requests changes after 1 rounds, the most this review allows."] });
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
  assert.deepEqual(f.review().phase, { kind: "needs-person", reasons: [
    `The deploy of ${merged} failed: node control rolled-back (health check failed).`,
    `Rolled back to the previous release, ${previous}.`,
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
  loop.land(f.builder, "nLAPTOP");
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

test("the policy's review conditions: another model, an approval with nothing serious open, and every finding answered", () => {
  const round = { head: head1, verdict: { token: "x", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: "the cache under real traffic" }, check: { passed: true, output: "" }, answers: null };
  const review: Review = {
    id: "rv-1", builder: "th-b" as ThreadId, reviewer: "th-r" as ThreadId, pr: { repo: "acme/shop", number: 7, url: "", title: "" }, models: { builder: "m", reviewer: "m" },
    maxRounds: 3, land: null, merged: null, expect: "rv-1:t", sent: 1, phase: { kind: "checking", startedAt: 0 }, outbox: null, since: 0, nudges: 0, startedAt: 0,
    rounds: [{ ...round, verdict: { ...round.verdict, verdict: "changes", findings: [{ id: "F1", severity: "minor", summary: "s" }, { id: "F2", severity: "minor", summary: "s" }] }, answers: [{ id: "F1", action: "rejected", reason: " " }] }, round],
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

test("a check that fails after minor findings were answered reaches the builder as a new request, which old answers cannot satisfy", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { findings: [{ id: "M1", severity: "minor", summary: "Name the constant" }] }));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing", "an approval with a minor finding still asks the builder to answer it");
  const first = f.review().expect;
  f.check = { kind: "done", passed: false, output: "src/cache.ts(1,1): error TS2322" };
  f.reply(f.builder, answers(f.review(), [{ id: "M1", action: "rejected", reason: "The name is the convention here." }]));
  await loop.poll();
  assert.equal(f.review().phase.kind, "fixing");
  const ids = f.sent.map((s) => s.message.id);
  assert.equal(new Set(ids).size, ids.length, "every message has its own request ID");
  assert.notEqual(f.review().expect, first, "the check's findings ask for a new token");
  assert.match(f.sent.at(-1)!.message.text, /CHECK \(serious\) \.nexus\/check: \.nexus\/check failed at 1{40}\n {4}src\/cache\.ts\(1,1\): error TS2322/);
  f.tick(120_000);
  await loop.poll();
  assert.equal(f.sent.length, ids.length, "the builder's earlier answers do not answer the check");
  assert.equal(f.review().nudges, 0);
});

test("commits pushed with answers that fixed nothing still get another round", async (t) => {
  const f = fixture(t);
  const loop = f.loop();
  await loop.start(f.builder, { land: null });
  await loop.poll();
  f.reply(f.review().reviewer, verdict(f.review(), { findings: [{ id: "M1", severity: "minor", summary: "Name the constant" }] }));
  await loop.poll();
  f.snapshot = { ...f.snapshot, detail: { ...f.snapshot.detail, head: head2 } };
  f.reply(f.builder, answers(f.review(), [{ id: "M1", action: "rejected", reason: "The name is the convention here." }]));
  await loop.poll();
  assert.equal(f.review().phase.kind, "reviewing");
  assert.equal(f.review().rounds.at(-1)!.head, head2);
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
  assert.match((f.review().phase as { reasons: string[] }).reasons[1]!, /Rolled back/);
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
