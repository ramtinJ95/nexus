import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnGate } from "./drain.ts";
import { fakeHarness } from "./fake-harness.ts";
import { checkCaller, verifyCaller } from "./gate.ts";
import type { PullRequest } from "./github.ts";
import { openRegistry, type Registry, type Thread, type ThreadId } from "./registry.ts";
import { queuedView, threadQueue, waitOf, type QueuedRecord } from "./queue.ts";
import { reviewerCaller, type Phase, type Review } from "./review.ts";
import { threadStarter, type StartRequest } from "./threads.ts";
import { newPylonRecord } from "../tick.ts";
import type { ImageManifest } from "../images.ts";
import type { LiveHash, NodeName, NodeObservation, PylonId, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";

const node = "rj-firebat" as NodeName;
const project = {
  id: "acme" as ProjectId, repoUrl: null, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 },
  allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const image: ImageManifest = {
  id: "img-000000000000", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "0".repeat(64),
  pins: {
    debianDigest: "d", node: "24", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s",
    gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const laptop = "nLAPTOP";

function fixture(t: import("node:test").TestContext, path = ":memory:") {
  const registry = openRegistry(path);
  t.after(() => { try { registry.close(); } catch { /* closed by a restart */ } });
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  if (registry.project(project.id) === undefined) {
    registry.createProject(project);
    registry.saveImage(image, null);
    registry.setCurrentImage(image.id);
  }
  const fake = fakeHarness();
  let draining = false;
  const gate = turnGate(() => draining);
  const start = threadStarter({ registry, harness: fake.harness, mirror: { setupInputs: () => Promise.reject(new Error("a scratch project has no remote")) }, dotfiles, wake: () => {} });
  let held: Promise<void> | null = null;
  const starts: ThreadId[] = [];
  const sent: [ThreadId, string, string][] = [];
  const queue = () => threadQueue({
    registry, gate, log: () => {},
    async startThread(request, caller, id) {
      starts.push(id!);
      await held;
      return start(request, caller, id);
    },
    async send(id, text, requestId) {
      sent.push([id, text, requestId]);
      return fake.harness.send(id, text, requestId, "followUp");
    },
  });
  /** A predecessor thread with a row of its own, as any started thread has. */
  function thread(id: string, startedBy = laptop): ThreadId {
    const t: Thread = { id: id as ThreadId, title: `Thread ${id}`, project: project.id, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: null, startedBy, createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false, working: false };
    const { desired: _, ...pylon } = newPylonRecord({ thread: id, pylonId: t.pylonId, node, desired: "running", boot: { pylonId: t.pylonId, image: image.id, resources: project.resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "empty", branch: "main" }, dotfiles }, firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash" as LiveHash });
    registry.createThread(t, pylon);
    return t.id;
  }
  const pr = (number: number, state: PullRequest["state"]): PullRequest => ({ repo: "acme/acme", number, title: `PR ${number}`, url: `https://github.com/acme/acme/pull/${number}`, state, checks: "none", review: "none", conflict: false });
  function links(id: ThreadId, ...prs: PullRequest[]) {
    registry.savePrWatch(id, { links: prs.map((p) => ({ pr: p, seen: [], failed: false })), commentWakes: 0, pending: null, error: null });
  }
  function review(id: ThreadId, phase: Phase, merged: string | null = null) {
    const r: Review = {
      id: `r-${id}`, expect: "", sent: 0, builder: id, reviewer: `${id}-reviewer` as ThreadId, pr: { repo: "acme/acme", number: 9, url: "", title: "", branch: "feature" },
      models: { builder: "a", reviewer: "b" }, reviewerKind: "harness", maxRounds: 5, land: null, auto: false, waiver: null, rounds: [], merged, phase, outbox: null, since: 0, nudges: 0, startedAt: 0,
    };
    registry.saveReview(r);
  }
  const request = (over: Partial<StartRequest> = {}): StartRequest => ({ project: project.id, title: "After", ...over });
  return {
    registry, fake, queue, thread, pr, links, review, request, starts, sent,
    set draining(d: boolean) { draining = d; },
    /** Holds every start until the returned function is called. */
    holdStarts() {
      const gate = Promise.withResolvers<void>();
      held = gate.promise;
      return () => { held = null; gate.resolve(); };
    },
  };
}

const wait = (registry: Registry, id: string) => { const { state, why } = waitOf(registry, id as ThreadId); return `${state}: ${why}`; };

test("a predecessor is waiting, landed or blocked by what its thread, review and pull requests say now", (t) => {
  const f = fixture(t);
  const q = f.queue();
  assert.equal(wait(f.registry, "th-none"), "blocked: does not exist");
  const queued = q.add(f.request(), null, [f.thread("th-a")], laptop);
  assert.equal(wait(f.registry, queued.id), "waiting: is queued");
  q.setStatus(queued.id, "archived");
  assert.equal(wait(f.registry, queued.id), "blocked: was cancelled while queued");
  q.setStatus(queued.id, "deleted");
  assert.equal(wait(f.registry, queued.id), "blocked: was deleted while queued");

  const a = "th-a" as ThreadId;
  assert.equal(wait(f.registry, a), "waiting: has no pull request yet");
  f.links(a, f.pr(3, "open"));
  assert.equal(wait(f.registry, a), "waiting: PR #3 is open");
  f.links(a, f.pr(3, "closed"));
  assert.equal(wait(f.registry, a), "blocked: PR #3 closed without merging");
  f.links(a, f.pr(3, "closed"), f.pr(4, "open"));
  assert.equal(wait(f.registry, a), "waiting: PR #4 is open", "a new PR after a closed one is waited for");
  f.links(a, f.pr(3, "merged"), f.pr(4, "open"));
  assert.equal(wait(f.registry, a), "waiting: PR #4 is open", "a merged PR lands the thread only once none is open");
  f.links(a, f.pr(3, "merged"), f.pr(4, "closed"));
  assert.equal(wait(f.registry, a), "landed: PR #3 merged");

  const b = f.thread("th-b");
  f.links(b, f.pr(5, "open"));
  f.review(b, { kind: "needs-person", reasons: ["the rounds ran out"] });
  assert.equal(wait(f.registry, b), "blocked: its review ended for the person: the rounds ran out");
  f.review(b, { kind: "landed", commit: "m" }, "m");
  assert.equal(wait(f.registry, b), "landed: PR #9 merged");
  f.review(b, { kind: "merged" });
  assert.equal(wait(f.registry, b), "landed: PR #9 merged", "a review that saw its PR merged outside it");

  const c = f.thread("th-c");
  f.links(c, f.pr(6, "open"));
  f.registry.setThreadStatus(c, "archived");
  assert.equal(wait(f.registry, c), "blocked: is archived and its pull request did not merge");
  f.links(c, f.pr(6, "merged"));
  assert.equal(wait(f.registry, c), "landed: PR #6 merged", "a merge wins over an archive");
  const d = f.thread("th-d");
  f.registry.setThreadStatus(d, "deleted");
  assert.equal(wait(f.registry, d), "blocked: is deleted and its pull request did not merge");
});

test("a queue record is checked as a start is, and freezes the size the project has then", async (t) => {
  const f = fixture(t);
  const q = f.queue();
  const a = f.thread("th-a");
  const refused = (fn: () => unknown, status: number, message: RegExp) => assert.throws(fn, (err: { status?: number; message: string }) => err.status === status && message.test(err.message));
  refused(() => q.add(f.request(), null, ["th-none"], laptop), 404, /no thread th-none/);
  refused(() => q.add(f.request({ project: "nope" }), null, [a], laptop), 404, /no project nope/);
  refused(() => q.add(f.request({ node: "nowhere" }), null, [a], laptop), 400, /no node nowhere/);
  refused(() => q.add(f.request({ commit: "abc" }), null, [a], laptop), 400, /scratch project/);
  refused(() => q.add(f.request({ claude: "fix it" }), "Fix it.", [a], laptop), 400, /message is for a Nexus agent thread/);
  refused(() => q.add(f.request(), null, [f.thread("th-review", reviewerCaller)], laptop), 400, /reviewer or check thread/);
  refused(() => q.add(f.request(), null, [f.thread("th-check", checkCaller)], laptop), 400, /reviewer or check thread/);
  refused(() => q.add(f.request(), null, [f.thread("th-verify", verifyCaller)], laptop), 400, /reviewer or check thread/);
  assert.deepEqual(f.registry.queuedThreads(), [], "a refused start records nothing");

  const record = q.add(f.request({ resources: { cpus: 4 } }), "Fix it.", [a, a], laptop);
  assert.deepEqual(record.after, [a]);
  assert.deepEqual(record.request, { project: project.id, title: "After", resources: { cpus: 4, memoryGiB: 4, diskGiB: 10 } });
  assert.match(record.id, /^th-[0-9a-f]{12}$/);
  assert.deepEqual(f.registry.queuedThread(record.id), record);
  assert.equal(queuedView(f.registry, record).node, node, "a start that names no node shows the project's default");
  assert.equal(f.registry.thread(record.id), undefined, "a queued thread has no row");
  assert.deepEqual(f.registry.threads().map((x) => x.id).sort(), ["th-a", "th-check", "th-review", "th-verify"]);
  const claude = q.add(f.request({ claude: "Fix it", node: "auto" }), null, [record.id], laptop);
  assert.deepEqual(queuedView(f.registry, f.registry.queuedThread(claude.id)!), {
    id: claude.id, title: "After", project: project.id, startedBy: laptop, createdAt: claude.createdAt, status: "queued", after: [record.id],
    waits: [{ thread: record.id, state: "waiting", why: "is queued" }], blocked: false, node: "auto", worker: "claude", model: "claude-opus-5-5",
    prompt: "Fix it", branch: null, commit: null, resources: project.resources, startNow: null, lastError: null,
  });
  await q.poll();
  assert.deepEqual(f.starts, [], "nothing starts before its predecessors land");
});

test("a queued thread starts once its predecessor's PR merged, as the PR watch or the review loop saw it, and starts like any start", async (t) => {
  const f = fixture(t);
  const q = f.queue();
  const a = f.thread("th-a");
  const b = f.thread("th-b");
  const first = q.add(f.request({ title: "After A" }), null, [a], laptop);
  const second = q.add(f.request({ title: "After B", claude: "Fix it" }), null, [b], laptop);
  f.links(a, f.pr(3, "open"));
  await q.poll();
  assert.deepEqual(f.starts, []);
  f.links(a, f.pr(3, "merged"));
  await q.poll();
  assert.deepEqual(f.starts, [first.id]);
  const started = f.registry.thread(first.id)!;
  assert.equal(started.title, "After A");
  assert.equal(started.startedBy, laptop, "the person who queued it started it");
  assert.equal(started.pylonId, `pylon-${first.id}`);
  assert.deepEqual(started.placement, { how: "default", node }, "a start that named no node is placed as one on the project's default");
  assert.deepEqual(f.registry.pylon(started.pylonId)!.boot.resources, project.resources);
  assert.equal(f.registry.queuedThread(first.id)!.status, "started");
  assert.deepEqual(f.fake.calls[0], ["start", { threadId: first.id, pylonId: started.pylonId }]);

  f.review(b, { kind: "landed", commit: "m" }, "m");
  await q.poll();
  assert.deepEqual(f.starts, [first.id, second.id]);
  assert.equal(f.registry.claudeWorker(second.id)?.prompt, "/poteto-mode Fix it", "a Claude worker starts with its recorded prompt");
  await q.poll();
  assert.deepEqual(f.starts, [first.id, second.id], "a started thread never starts again");
});

test("a closed PR blocks the queued thread and a reopened one unblocks it, and so does an archive before the merge but not after it", async (t) => {
  const f = fixture(t);
  const q = f.queue();
  const a = f.thread("th-a");
  const b = f.thread("th-b");
  const record = q.add(f.request(), null, [a, b], laptop);
  const view = () => queuedView(f.registry, f.registry.queuedThread(record.id)!);
  f.links(a, f.pr(3, "closed"));
  f.links(b, f.pr(4, "merged"));
  await q.poll();
  assert.equal(view().blocked, true);
  assert.deepEqual(view().waits.map((w) => w.state), ["blocked", "landed"]);
  assert.equal(view().status, "queued", "a blocked thread stays queued");
  f.links(a, f.pr(3, "open"));
  assert.equal(view().blocked, false, "a reopened PR unblocks it");
  f.registry.setThreadStatus(a, "archived");
  await q.poll();
  assert.equal(view().blocked, true);
  assert.deepEqual(f.starts, []);
  f.links(a, f.pr(3, "merged"));
  await q.poll();
  assert.deepEqual(f.starts, [record.id], "a predecessor archived once its PR merged still landed");
});

test("a chain starts in order: C after B, which is queued after A", async (t) => {
  const f = fixture(t);
  const q = f.queue();
  const a = f.thread("th-a");
  const b = q.add(f.request({ title: "B" }), null, [a], laptop);
  const c = q.add(f.request({ title: "C" }), null, [b.id], laptop);
  assert.deepEqual(queuedView(f.registry, f.registry.queuedThread(c.id)!).waits, [{ thread: b.id, state: "waiting", why: "is queued" }]);
  f.links(a, f.pr(3, "merged"));
  await q.poll();
  assert.deepEqual(f.starts, [b.id]);
  assert.equal(wait(f.registry, b.id), "waiting: has no pull request yet");
  f.links(b.id, f.pr(4, "merged"));
  await q.poll();
  assert.deepEqual(f.starts, [b.id, c.id]);
});

test("two passes and a start-queued at once start the thread once", async (t) => {
  const f = fixture(t);
  const one = f.queue();
  const other = f.queue();
  const a = f.thread("th-a");
  const record = one.add(f.request(), null, [a], laptop);
  f.links(a, f.pr(3, "merged"));
  const release = f.holdStarts();
  const passes = [one.poll(), one.poll()];
  const now = one.startNow(record.id, "nPHONE");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.starts, [record.id], "one queue shares its start in flight");
  const late = other.startNow(record.id, "nPHONE");
  release();
  await Promise.all(passes);
  assert.equal((await now).id, record.id);
  await assert.rejects(late, /no longer queued/, "another queue's start loses to the transaction that marked it started");
  assert.equal(f.registry.threads().filter((x) => x.id === record.id).length, 1);
  assert.deepEqual(f.registry.queuedThread(record.id)!.startNow, { by: "nPHONE", at: f.registry.queuedThread(record.id)!.startNow!.at });
  await assert.rejects(one.startNow(record.id, "nPHONE"), (err: { status: number; message: string }) => err.status === 409 && /has started/.test(err.message), "a started thread is no longer queued");
});

test("archiving a queued thread while its start is in flight leaves no thread row", async (t) => {
  const f = fixture(t);
  const q = f.queue();
  const record = q.add(f.request(), null, [f.thread("th-a")], laptop);
  const release = f.holdStarts();
  const started = q.startNow(record.id, laptop);
  await new Promise((resolve) => setImmediate(resolve));
  q.setStatus(record.id, "archived");
  release();
  await assert.rejects(started, /no longer queued/);
  assert.equal(f.registry.thread(record.id), undefined);
  assert.equal(f.registry.pylon(`pylon-${record.id}` as PylonId), undefined);
  assert.equal(f.registry.queuedThread(record.id)!.status, "archived");
  assert.throws(() => q.setStatus(record.id, "archived"), /is cancelled/);
  q.setStatus(record.id, "queued");
  assert.equal(f.registry.queuedThread(record.id)!.status, "queued", "unarchive queues it again");
  await q.startNow(record.id, laptop);
  assert.equal(f.registry.thread(record.id)?.id, record.id, "the conversation made by the start that lost is reused");
});

test("a start refused while a deploy drains stays queued with why, and the next pass starts it", async (t) => {
  const f = fixture(t);
  const q = f.queue();
  const a = f.thread("th-a");
  const record = q.add(f.request(), null, [a], laptop);
  f.links(a, f.pr(3, "merged"));
  f.draining = true;
  await q.poll();
  assert.equal(f.registry.thread(record.id), undefined);
  assert.match(f.registry.queuedThread(record.id)!.lastError!, /draining for deployment/);
  assert.equal(f.registry.queuedThread(record.id)!.status, "queued");
  f.draining = false;
  await q.poll();
  assert.equal(f.registry.thread(record.id)?.id, record.id);
  assert.equal(f.registry.queuedThread(record.id)!.lastError, null, "the start clears why the last attempt failed");
});

test("an auto start with no node that has room stays queued, then starts once room appears", async (t) => {
  const f = fixture(t);
  const q = f.queue();
  const a = f.thread("th-a");
  const record = q.add(f.request({ node: "auto" }), null, [a], laptop);
  f.links(a, f.pr(3, "merged"));
  await q.poll();
  assert.match(f.registry.queuedThread(record.id)!.lastError!, /no node can run this pylon: rj-firebat is offline/);
  await assert.rejects(q.startNow(record.id, laptop), /no node can run this pylon/);
  assert.equal(f.registry.queuedThread(record.id)!.status, "queued");
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 200, committedDiskGiB: 0 };
  f.registry.apply({ record: "node", node, state: "online", capacity });
  f.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", events: [], capacity, artifacts: [image.id] as NodeObservation["artifacts"], jobs: [], pylons: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  await q.poll();
  assert.equal(f.registry.thread(record.id)?.placement?.how, "auto");
});

test("a Nexus agent thread's first message is sent once under its queued request ID, and again under it after a crash", async (t) => {
  const f = fixture(t);
  const a = f.thread("th-a");
  const record = f.queue().add(f.request(), "Fix the checkout.\nThen push.", [a], laptop);
  f.links(a, f.pr(3, "merged"));
  await f.queue().poll();
  assert.deepEqual(f.sent, [[record.id, "Fix the checkout.\nThen push.", `queued:${record.id}`]]);
  assert.equal(f.registry.queuedThread(record.id)!.firstMessage, "sent");
  await f.queue().poll();
  assert.equal(f.sent.length, 1);

  f.registry.saveQueued({ ...f.registry.queuedThread(record.id)!, firstMessage: "pending" });
  await f.queue().poll();
  assert.deepEqual(f.sent[1], [record.id, "Fix the checkout.\nThen push.", `queued:${record.id}`], "a send the crash may have cut off goes again under the same ID");
  assert.equal(f.registry.queuedThread(record.id)!.firstMessage, "sent");
});

test("a queued thread survives a restart, and a pass after it starts the thread", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-queue-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "registry.db");
  const before = fixture(t, path);
  const a = before.thread("th-a");
  const record = before.queue().add(before.request(), null, [a], laptop);
  before.registry.close();
  const after = fixture(t, path);
  assert.deepEqual(after.registry.queuedThread(record.id), record);
  after.links(a, after.pr(3, "merged"));
  await after.queue().poll();
  assert.equal(after.registry.thread(record.id)?.id, record.id);
  assert.equal(after.registry.queuedThread(record.id)!.status, "started");
});

test("a queue record's status moves only as archive, unarchive and delete allow", (t) => {
  const f = fixture(t);
  const q = f.queue();
  const record: QueuedRecord = q.add(f.request(), null, [f.thread("th-a")], laptop);
  assert.throws(() => q.setStatus(record.id, "queued"), /is queued, not cancelled/);
  assert.throws(() => q.setStatus("th-none" as ThreadId, "archived"), /no queued thread th-none/);
  assert.equal(q.setStatus(record.id, "deleted").status, "deleted");
  assert.throws(() => q.setStatus(record.id, "deleted"), /is deleted/);
  assert.throws(() => q.setStatus(record.id, "queued"), /is deleted, not cancelled/);
});
