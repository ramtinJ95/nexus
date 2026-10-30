import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnGate } from "./drain.ts";
import { fakeHarness } from "./fake-harness.ts";
import type { PullRequest } from "./github.ts";
import { itemPhase, itemThread, itemView, pipeline, type ItemId } from "./pipeline.ts";
import { threadQueue } from "./queue.ts";
import { openRegistry, type Registry, type ThreadId } from "./registry.ts";
import { personPhase, type Phase, type Review } from "./review.ts";
import { threadStarter, type StartRequest } from "./threads.ts";
import type { NodeName, TailnetNodeId } from "../protocol.ts";
import type { PipelineSetting, ProjectId } from "../project.ts";
import { testImage } from "../test-kit.ts";

const node = "rj-firebat" as NodeName;
const image = testImage({ id: "img-000000000000", sha256: "0".repeat(64) });
const laptop = "nLAPTOP";

function fixture(t: import("node:test").TestContext, setting: PipelineSetting | null = { autoStart: true }, path = ":memory:") {
  const registry = openRegistry(path);
  t.after(() => { try { registry.close(); } catch { /* closed by a restart */ } });
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  if (registry.project("acme" as ProjectId) === undefined) {
    registry.createProject({ id: "acme" as ProjectId, repoUrl: null, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null, pipeline: setting });
    registry.saveImage(image, null);
    registry.setCurrentImage(image.id);
  }
  const fake = fakeHarness();
  const start = threadStarter({ registry, harness: fake.harness, mirror: { setupInputs: () => Promise.reject(new Error("a scratch project has no remote")) }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, wake: () => {} });
  const queue = threadQueue({ registry, gate: turnGate(() => false), startThread: start, send: (id, text, requestId) => fake.harness.send(id, text, requestId, "followUp") });
  const items = pipeline({ registry, queue });
  t.after(async () => { await items.close(); await queue.close(); });
  const request = (title: string, over: Partial<StartRequest> = {}): StartRequest => ({ project: "acme", title, ...over });
  const pr = (number: number, state: PullRequest["state"]): PullRequest => ({ repo: "acme/acme", number, title: `PR ${number}`, url: `https://github.com/acme/acme/pull/${number}`, state, checks: "none", review: "none", conflict: false });
  return {
    registry, queue, items, fake, request, pr,
    add: (title: string, after: readonly ItemId[] = [], over: Partial<StartRequest> = {}) => items.add(request(title, over), over.claude === undefined ? `Build ${title}.` : null, after, laptop).id,
    /** A pass of the pipeline, then of the queue, as their timers run them. */
    async passes() { await items.poll(); await queue.poll(); },
    links(id: ThreadId, ...prs: PullRequest[]) { registry.savePrWatch(id, { links: prs.map((p) => ({ pr: p, seen: [], failed: false })), commentWakes: 0, pending: null, error: null }); },
    review(id: ThreadId, phase: Phase, land: string | null = null) {
      const r: Review = {
        id: `r-${id}`, expect: "", sent: 0, builder: id, reviewer: `${id}-reviewer` as ThreadId, pr: { repo: "acme/acme", number: 9, url: "", title: "", branch: "feature" },
        models: { builder: "a", reviewer: "b" }, reviewerKind: "harness", maxRounds: 5, land: land === null ? null : { requestedBy: land, fromProject: true }, auto: true, waiver: null,
        rounds: [{ head: "h", verdict: null, check: null, answers: null }], merged: phase.kind === "landed" ? phase.commit : null, phase, outbox: null, asked: "", since: 0, nudges: 0, startedAt: 0,
      };
      registry.saveReview(r);
    },
    setPipeline(next: PipelineSetting | null) { registry.editProject("acme" as ProjectId, (p) => ({ ...p, pipeline: next })); },
  };
}

const phase = (registry: Registry, id: ItemId) => { const { kind, why } = itemPhase(registry, registry.item(id)!); return `${kind}: ${why}`; };
const thread = (registry: Registry, id: ItemId) => itemThread(registry, id)!;

test("an item moves through every phase its records put it in, from planned to landed", async (t) => {
  const f = fixture(t, null);
  const r = f.registry;
  assert.throws(() => f.add("A"), /the pipeline does not run for project acme/, "a project without the pipeline takes no items");
  f.setPipeline({ autoStart: false });
  const a = f.add("A");
  const b = f.add("B", [a]);
  f.setPipeline(null);
  assert.equal(phase(r, a), "planned: the pipeline does not run for project acme");
  f.setPipeline({ autoStart: false });
  await f.passes();
  assert.equal(phase(r, a), "held: project acme waits for the person to approve each item: nexus item approve " + a);
  assert.equal(phase(r, b), "planned: waits for A to be queued");
  assert.equal(itemThread(r, a), null, "an item waiting for approval is not queued");

  f.items.approve(a, laptop);
  await f.items.poll();
  assert.notEqual(itemThread(r, a), null, "an approved item is queued on the next pass");
  assert.equal(phase(r, b), "held: project acme waits for the person to approve each item: nexus item approve " + b);
  f.items.approve(b, laptop);
  await f.passes();
  const ta = thread(r, a);
  assert.equal(r.thread(ta)?.title, "A", "an item with nothing ahead of it starts on the queue's next pass");
  assert.equal(r.thread(ta)?.startedBy, laptop, "its thread is started by whoever added the item");
  assert.equal(phase(r, a), "building: no pull request yet");
  assert.equal(phase(r, b), `queued: waits for A: has no pull request yet`);

  f.links(ta, f.pr(3, "open"));
  assert.equal(phase(r, a), "reviewing: PR #3 is open, before its review");
  f.review(ta, { kind: "reviewing" });
  assert.equal(phase(r, a), "reviewing: PR #9, round 1: reviewing");
  f.review(ta, { kind: "verifying", startedAt: 0, thread: "th-verify" as ThreadId });
  assert.equal(phase(r, a), "reviewing: PR #9, round 1: live check running .nexus/verify at h in verify pylon th-verify");
  f.review(ta, { kind: "verifying", startedAt: 0, thread: null, refused: "no node can run this pylon: rj-firebat is offline" });
  assert.equal(phase(r, a), "reviewing: PR #9, round 1: live check waiting for a node to take its verify pylon: no node can run this pylon: rj-firebat is offline");
  f.review(ta, { kind: "fixing" });
  assert.equal(phase(r, a), "reviewing: PR #9, round 1: fixing");
  f.review(ta, { kind: "approved" }, laptop);
  assert.equal(phase(r, a), "landing: PR #9 is approved");
  f.review(ta, { kind: "merging", authorized: "h" }, laptop);
  assert.equal(phase(r, a), "landing: PR #9 is merging");
  f.review(ta, { kind: "merging", authorized: null, waiting: "rv-other deploys" }, laptop);
  assert.equal(phase(r, a), "landing: PR #9 is merging, waiting while rv-other deploys");
  f.review(ta, { kind: "deploying", commit: "c".repeat(40), previous: null, requested: true, deadline: 0 }, laptop);
  assert.equal(phase(r, a), "landing: PR #9 is deploying");
  f.review(ta, { kind: "landed", commit: "c".repeat(40) }, laptop);
  r.setThreadStatus(ta, "archived");
  assert.equal(phase(r, a), `landed: PR #9 merged as ${"c".repeat(12)}`, "a landed item stays landed once the review loop archives its thread");
  await f.passes();
  const tb = thread(r, b);
  assert.equal(r.thread(tb)?.title, "B", "the second item starts once the first one's pull request merged");
  assert.equal(phase(r, b), "building: no pull request yet");
});

test("an item is held for the person by its review, its thread's attention, a blocked queue or a cancelled item ahead", async (t) => {
  const f = fixture(t);
  const r = f.registry;
  const a = f.add("A"), b = f.add("B"), c = f.add("C"), d = f.add("D");
  await f.passes();
  const [ta, tb, tc, td] = [a, b, c, d].map((id) => thread(r, id));
  f.review(ta!, personPhase("rounds", "the rounds ran out"));
  assert.equal(phase(r, a), "held: its review ended for the person: the rounds ran out");
  f.review(tb!, { kind: "approved" });
  assert.equal(phase(r, b), `held: PR #9 is approved, and lands once the person runs nexus land ${tb}`);
  r.askQuestion({ id: "q1", thread: tc!, text: "Rebuild the image?", options: ["yes", "no"], reserved: "image-rebuild", answerer: "deployer", askedAt: 1 });
  assert.equal(phase(r, c), "held: its thread needs the person's decision");
  f.links(td!, f.pr(4, "closed"));
  assert.equal(phase(r, d), "held: PR #4 closed without merging");

  const after = f.add("After D", [d]);
  await f.items.poll();
  assert.equal(phase(r, after), "held: blocked by D: PR #4 closed without merging", "a queued item whose predecessor is blocked waits on the person");
  const planned = f.add("Planned");
  const behind = f.add("Behind", [planned]);
  f.items.cancel(planned, laptop);
  await f.passes();
  assert.equal(phase(r, planned), `cancelled: cancelled by ${laptop}`);
  assert.equal(phase(r, behind), "held: Planned was cancelled, so this never starts. Cancel it, or add it again after other items");
  assert.equal(itemThread(r, behind), null);
});

test("an archived thread, a cancelled queued thread and a PR merged outside any review each end their item", async (t) => {
  const f = fixture(t);
  const r = f.registry;
  const a = f.add("A"), b = f.add("B"), c = f.add("C");
  await f.passes();
  const queuedBehind = f.add("Behind A", [a]);
  await f.items.poll();
  const [ta, tb] = [thread(r, a), thread(r, b)];
  r.setThreadStatus(ta, "archived");
  assert.equal(phase(r, a), "archived: its thread is archived");
  f.queue.setStatus(thread(r, queuedBehind), "archived");
  assert.equal(phase(r, queuedBehind), "cancelled: its queued thread was cancelled");
  f.links(tb, f.pr(5, "merged"));
  assert.equal(phase(r, b), "landed: PR #5 merged");
  const tc = thread(r, c);
  f.links(tc, f.pr(6, "closed"));
  f.review(tc, { kind: "closed" });
  assert.equal(phase(r, c), "held: PR #6 closed without merging");
  f.links(tc, f.pr(6, "merged"));
  assert.equal(phase(r, c), "landed: PR #6 merged", "a pull request reopened and merged after its review closed lands the item");
  f.links(tc, f.pr(6, "open"));
  f.review(tc, { kind: "cancelled", who: "builder", status: "deleted" });
  r.setThreadStatus(tc, "deleted");
  assert.equal(phase(r, c), "archived: its thread is deleted");
  assert.throws(() => f.items.cancel(b, laptop), (err: { status: number; message: string }) => err.status === 409 && err.message.includes(`is thread ${tb} now`));
});

test("an item is queued once across passes and restarts, under its request ID", async (t) => {
  const path = join(await mkdtemp(join(tmpdir(), "nexus-pipeline-")), "registry.db");
  const first = fixture(t, { autoStart: true }, path);
  const a = first.add("A");
  const b = first.add("B", [a], { claude: "Build B" });
  await Promise.all([first.items.poll(), first.items.poll(), first.items.poll()]);
  const ta = thread(first.registry, a), tb = thread(first.registry, b);
  assert.deepEqual(first.registry.queuedThread(tb)!.after, [ta], "the second waits on the first item's thread");
  assert.equal(first.registry.queuedThread(tb)!.request.claude, "Build B");
  await first.items.close();
  await first.queue.close();
  first.registry.close();

  const second = fixture(t, { autoStart: true }, path);
  await second.passes();
  await second.passes();
  assert.equal(second.registry.queuedThreads().length, 2, "a restart queues nothing again");
  assert.equal(thread(second.registry, a), ta);
  assert.equal(second.registry.thread(ta)?.title, "A");
  assert.deepEqual(itemView(second.registry, second.registry.item(b)!), {
    id: b, project: "acme", title: "B", addedBy: laptop, addedAt: second.registry.item(b)!.addedAt, after: [a], worker: "claude", model: "claude-opus-5-5",
    brief: "Build B", thread: tb, phase: { kind: "queued", why: "waits for A: has no pull request yet" }, approved: null,
  });
});

test("an item is checked as a start is, and its pass records why a queue refused it", async (t) => {
  const f = fixture(t);
  const refused = (fn: () => unknown, status: number, message: RegExp) => assert.throws(fn, (err: { status?: number; message: string }) => err.status === status && message.test(err.message));
  refused(() => f.items.add(f.request("X", { project: "nope" }), "Go.", [], laptop), 404, /no project nope/);
  refused(() => f.items.add(f.request("X"), "Go.", ["it-000000000000"], laptop), 404, /no item it-000000000000/);
  refused(() => f.items.add(f.request("X", { claude: "Go" }), "Go.", [], laptop), 400, /message is for a Nexus agent thread/);
  refused(() => f.items.add(f.request("X"), null, [], laptop), 400, /an item needs a brief/);
  refused(() => f.items.add(f.request("X", { model: "m" }), "Go.", [], laptop), 400, /model requires claude/);
  refused(() => f.items.approve(f.add("A"), laptop), 409, /starts its items on their own/);
  assert.equal(f.registry.items().length, 1, "a refused item records nothing");

  const gone = f.add("On a node that goes", [], { node });
  f.registry.saveItem({ ...f.registry.item(gone)!, request: { ...f.registry.item(gone)!.request, node: "nowhere" } });
  await f.items.poll();
  assert.equal(phase(f.registry, gone), "planned: was not queued: no node nowhere");
  assert.equal(f.registry.item(gone)!.lastError, "no node nowhere");
});
