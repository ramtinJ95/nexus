import { test } from "node:test";
import assert from "node:assert/strict";
import { driveCalls } from "./drive.ts";
import { fakeHarness } from "./fake-harness.ts";
import { agentInbox } from "./inbox.ts";
import type { PullRequest } from "./github.ts";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import type { Review } from "./review.ts";
import { threadStarts } from "./starts.ts";
import { maxChildren, threadStarter } from "./threads.ts";
import { maxWatches, watchPass } from "./watches.ts";
import type { ImageManifest } from "../images.ts";
import type { NodeName, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";

const node = "rj-firebat" as NodeName;
const project = "acme" as ProjectId;
const laptop = "nLAPTOP";
const brief = (title: string) => ({ project, title, brief: `Do ${title}.`, agent: "nexus" as const });

function fixture(t: import("node:test").TestContext) {
  const registry = openRegistry(":memory:");
  t.after(() => registry.close());
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  // A repository, so the project can review its builders' pull requests on its own, as the nudge test needs.
  registry.createProject({ id: project, repoUrl: "https://github.com/acme/acme.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 }, allowedHosts: [], secrets: [], logins: [], preSetup: null, autoReview: { land: false, by: laptop } } as never);
  registry.saveImage({ id: "img-000000000000", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "0".repeat(64), pins: {} } as unknown as ImageManifest, null);
  registry.setCurrentImage("img-000000000000" as never);
  const fake = fakeHarness();
  let held: Promise<void> | null = null;
  const harness = { ...fake.harness, async startThread(...args: Parameters<typeof fake.harness.startThread>) { await held; return fake.harness.startThread(...args); } };
  const startThread = threadStarter({ registry, harness, mirror: { setupInputs: () => Promise.reject(new Error("unread")) }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, wake: () => {} });
  const start = threadStarts({ registry, startThread, send: (id, text, requestId, sender) => harness.send(id, text, requestId, "followUp", ...sender === undefined ? [] : [sender]), queue: () => assert.fail("nothing queues") });
  const inbox = agentInbox({ registry, harness, probes: new Map(), wake: () => {} });
  const watches = watchPass({ registry, inbox, log: () => {} });
  const drive = driveCalls({ registry, start, inbox, harness, watches: { poll: async () => {} } });
  const planner = async (title = "Plan") => await start({ project, title, drive: true }, laptop) as Thread;
  const messages = (id: string) => fake.transcript(id).messages.map((m) => m.content as string);
  return { registry, fake, start, drive, watches, planner, messages, hold() { const gate = Promise.withResolvers<void>(); held = gate.promise; return () => { held = null; gate.resolve(); }; } };
}

test("a thread with the drive tools starts children up to the cap, and an archived child gives its place back", async (t) => {
  const { registry, drive, planner } = fixture(t);
  const plan = await planner();
  const ids: string[] = [];
  for (let i = 1; i <= maxChildren; i++) ids.push((await drive.start(plan.id, brief(`Build ${i}`), `tool:1:call-${i}`) as Thread).id);
  assert.deepEqual(registry.children(plan.id).map((c) => [c.id, c.parent, c.drive, c.startedBy]), ids.map((id) => [id, plan.id, undefined, laptop]), "each child records its parent, has no drive tools, and acts for the person");
  await assert.rejects(drive.start(plan.id, brief("Build 4"), "tool:1:call-4"), { status: 409, message: new RegExp(`thread ${plan.id} has 3 live children \\(${ids.join(", ")}\\), the most a thread may have`) });
  assert.equal(registry.startRequest("tool:1:call-4"), undefined, "a refused start stores nothing under its request ID");
  registry.setThreadStatus(ids[0] as ThreadId, "archived");
  const fourth = await drive.start(plan.id, brief("Build 4"), "tool:1:call-4") as Thread;
  assert.equal(registry.thread(fourth.id)?.parent, plan.id);
});

test("two starts at once for a parent's last place start one thread", async (t) => {
  const { registry, drive, planner, hold } = fixture(t);
  const plan = await planner();
  for (let i = 1; i < maxChildren; i++) await drive.start(plan.id, brief(`Build ${i}`), `tool:1:call-${i}`);
  const release = hold();
  const racing = [drive.start(plan.id, brief("Build A"), "tool:1:call-a"), drive.start(plan.id, brief("Build B"), "tool:1:call-b")];
  release();
  const [a, b] = await Promise.allSettled(racing);
  assert.deepEqual([a!.status, b!.status].sort(), ["fulfilled", "rejected"], "both passed the first check, and the check before the row refused one");
  assert.equal(registry.children(plan.id).length, maxChildren);
});

test("only a person's start gives a thread the drive tools, and a thread without them starts, sends and watches nothing", async (t) => {
  const { registry, start, drive, planner } = fixture(t);
  const plan = await planner();
  const child = await drive.start(plan.id, brief("Build"), "tool:1:call-1") as Thread;
  const plain = await start({ project, title: "Plain" }, laptop) as Thread;
  for (const caller of [child.id, plain.id]) {
    await assert.rejects(drive.start(caller, brief("Grandchild"), `tool:2:${caller}`), { status: 403, message: `thread ${caller} has no drive tools` });
    await assert.rejects(drive.read(caller, plan.id), { status: 403 });
    await assert.rejects(drive.send(caller, plan.id, "hi", `tool:3:${caller}`), { status: 403 });
    await assert.rejects(drive.wait(caller, plan.id, "turn-ended", `tool:4:${caller}`), { status: 403 });
  }
  await assert.rejects(start({ project, title: "Grandchild", parent: child.id }, laptop), { status: 403, message: /a thread a tool started never has them/ });
  await assert.rejects(start({ project, title: "Child with tools", parent: plan.id, drive: true }, laptop), { status: 400, message: "a thread a tool starts gets no drive tools" });
  await assert.rejects(start({ project, title: "Claude planner", claude: "Plan.", drive: true }, laptop), { status: 400, message: /a Claude worker or a bare thread cannot have them/ });
  assert.equal(registry.children(child.id).length, 0);
  registry.setThreadStatus(plan.id, "archived");
  await assert.rejects(drive.start(plan.id, brief("Late"), "tool:1:call-9"), { status: 409, message: `thread ${plan.id} is archived, so its tools act on nothing` });
});

test("a nexus_start repeated under its request ID answers the same child and sends its brief once, from the parent", async (t) => {
  const { registry, drive, planner, messages, fake } = fixture(t);
  const plan = await planner();
  const first = await drive.start(plan.id, brief("Build"), "tool:1:call-1") as Thread;
  const again = await drive.start(plan.id, brief("Build"), "tool:1:call-1") as Thread;
  assert.equal(again.id, first.id);
  assert.equal(registry.children(plan.id).length, 1);
  assert.deepEqual(messages(first.id), [`From thread ${plan.id} "Plan", which started this thread with nexus_start:\n\nDo Build.`]);
  assert.deepEqual(fake.calls.filter((c) => c[0] === "send" && c[1] === first.id).map((c) => [c[3], c[5]]), [[`brief:${first.id}`, "thread"], [`brief:${first.id}`, "thread"]], "the repeat sends the brief again under the same ID, which delivers it once");
  await assert.rejects(drive.start(plan.id, brief("Other"), "tool:1:call-1"), { status: 409, message: new RegExp(`started thread ${first.id} with another body`) });
  const claude = await drive.start(plan.id, { ...brief("Review"), agent: "claude", model: "claude-opus-5-5" }, "tool:1:call-2") as Thread;
  assert.deepEqual([registry.claudeWorker(claude.id)?.prompt, registry.claudeWorker(claude.id)?.model], [`/poteto-mode From thread ${plan.id} "Plan", which started this thread with nexus_start:\n\nDo Review.`, "claude-opus-5-5"]);
  await assert.rejects(drive.start(plan.id, { ...brief("Bad"), model: "x" }, "tool:1:call-3"), { status: 400, message: /model is a Claude worker's/ });
});

test("nexus_send marks its message as the sending thread's, and nexus_read reads a thread's children and conversation", async (t) => {
  const { registry, start, drive, planner, messages, fake } = fixture(t);
  const plan = await planner();
  const child = await drive.start(plan.id, brief("Build"), "tool:1:call-1") as Thread;
  const other = await start({ project, title: "Someone else's" }, laptop) as Thread;
  assert.deepEqual(await drive.send(plan.id, other.id, "Rebase on main.", "tool:1:call-2"), { thread: other.id, delivered: true });
  assert.deepEqual(await drive.send(plan.id, other.id, "Rebase on main.", "tool:1:call-2"), { thread: other.id, delivered: true });
  assert.deepEqual(messages(other.id), [`[Nexus thread ${plan.id} "Plan" — sent with nexus_send, not by the person]\nRebase on main.`], "a repeated call delivers once");
  assert.equal(fake.calls.filter((c) => c[0] === "send" && c[1] === other.id).every((c) => c[5] === "thread"), true);
  await assert.rejects(drive.send(plan.id, plan.id, "hi", "tool:1:call-3"), { status: 400, message: "a thread cannot message itself" });
  registry.setThreadStatus(other.id, "archived");
  await assert.rejects(drive.send(plan.id, other.id, "hi", "tool:1:call-4"), { status: 409 });

  fake.transcript(child.id).messages.push({ role: "assistant", content: [{ type: "text", text: "x".repeat(3_000) }] } as never);
  const read = await drive.read(plan.id, child.id) as { parent: string; children: unknown[]; conversation: { from: string; text: string }[] };
  assert.equal(read.parent, plan.id);
  assert.deepEqual(read.conversation.map((s) => [s.from, s.text.length]), [["thread", messages(child.id)[0]!.length], ["agent", 2_001]], "the brief is from the thread, and a long reply is cut");
  assert.deepEqual((await drive.read(plan.id, plan.id) as { children: unknown[] }).children, [{ id: child.id, title: "Build", status: "active" }]);
  await assert.rejects(drive.read(plan.id, "th-000000000000"), { status: 404 });
});

const merged = (number: number): PullRequest => ({ repo: "acme/acme", number, title: `PR ${number}`, url: `https://github.com/acme/acme/pull/${number}`, state: "merged", checks: "passing", review: "none", conflict: false });
const landed = (builder: ThreadId): Review => ({
  id: `r-${builder}`, expect: "", sent: 0, builder, reviewer: `${builder}-r` as ThreadId, pr: { repo: "acme/acme", number: 9, url: "https://github.com/acme/acme/pull/9", title: "", branch: "b" },
  models: { builder: "a", reviewer: "b" }, reviewerKind: "harness", maxRounds: 5, land: null, auto: false, waiver: null, rounds: [], merged: "c0ffee", phase: { kind: "landed", commit: "c0ffee" }, outbox: null, since: 0, nudges: 0, startedAt: 0,
});

test("each watch sends its waiter one message once its condition holds of the watched thread, and not before", async (t) => {
  const cases: { until: "turn-ended" | "review-ended" | "merged" | "failed" | "archived"; agent?: "claude"; happen(registry: ReturnType<typeof openRegistry>, id: ThreadId): void; what: RegExp }[] = [
    { until: "turn-ended", happen: (r, id) => r.recordReply(id, 5_000), what: /its turn ended/ },
    { until: "review-ended", happen: (r, id) => r.saveReview(landed(id)), what: /its review of https:\/\/github.com\/acme\/acme\/pull\/9 ended landed/ },
    { until: "merged", happen: (r, id) => r.savePrWatch(id, { links: [{ pr: merged(4), seen: [], failed: false }], commentWakes: 0, pending: null, error: null }), what: /its pull request https:\/\/github.com\/acme\/acme\/pull\/4 merged/ },
    { until: "failed", agent: "claude", happen: (r, id) => r.setClaudeWorker(id, "p", "failed", "launch failed"), what: /it failed: launch failed/ },
    { until: "archived", happen: (r, id) => r.setThreadStatus(id, "archived"), what: /it was archived/ },
  ];
  for (const c of cases) {
    await t.test(c.until, async (t) => {
      const { registry, drive, watches, planner, messages } = fixture(t);
      const plan = await planner();
      const child = await drive.start(plan.id, { ...brief("Build"), agent: c.agent ?? "nexus" }, "tool:1:call-1") as Thread;
      const until = c.until === "archived" ? "turn-ended" : c.until;
      const answer = await drive.wait(plan.id, child.id, until, "tool:1:call-2") as { watch: string; delivered: boolean };
      assert.deepEqual([answer.watch, answer.delivered], ["tool:1:call-2", false]);
      await watches.poll();
      assert.deepEqual(messages(plan.id), [], "nothing happened yet");
      c.happen(registry, child.id);
      await watches.poll();
      await watches.poll();
      assert.equal(messages(plan.id).length, 1);
      assert.match(messages(plan.id)[0]!, new RegExp(`^\\[Nexus watch — automated, not a message from the person\\]\nThread ${child.id} "Build", which you watched until ${until}: ${c.what.source}`));
      assert.equal(registry.pendingWatches().length, 0);
      assert.equal((await drive.wait(plan.id, child.id, until, "tool:1:call-2") as { delivered: boolean }).delivered, true, "a repeated call finds the delivered watch");
    });
  }
});

test("a review that had ended before the watch started does not end it, and a waiter's watches are capped", async (t) => {
  const { registry, start, drive, watches, planner, messages } = fixture(t);
  const plan = await planner();
  const other = await start({ project, title: "Builder" }, laptop) as Thread;
  registry.saveReview(landed(other.id));
  await drive.wait(plan.id, other.id, "review-ended", "tool:1:w0");
  await watches.poll();
  assert.deepEqual(messages(plan.id), []);
  registry.saveReview({ ...landed(other.id), id: "r-later" });
  await watches.poll();
  assert.match(messages(plan.id)[0]!, /ended landed/);

  for (let i = 1; i <= maxWatches; i++) await drive.wait(plan.id, other.id, "turn-ended", `tool:1:w${i}`);
  await assert.rejects(drive.wait(plan.id, other.id, "turn-ended", "tool:1:w-over"), { status: 409, message: /already waits on 10 watches/ });
  await drive.wait(plan.id, other.id, "turn-ended", "tool:1:w1");
  await assert.rejects(drive.wait(plan.id, plan.id, "turn-ended", "tool:1:w-self"), { status: 400, message: "a thread cannot watch itself" });
  registry.setThreadStatus(plan.id, "deleted");
  registry.recordReply(other.id, 9_000);
  await watches.poll();
  assert.equal(registry.pendingWatches().length, 0, "a deleted waiter's watches end without a message");
});
