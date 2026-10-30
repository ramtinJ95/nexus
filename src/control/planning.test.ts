import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { turnGate } from "./drain.ts";
import { fakeHarness } from "./fake-harness.ts";
import { pipeline } from "./pipeline.ts";
import { planBlocks, planning, proposalItem } from "./planning.ts";
import { planningPrefix } from "../agent-protocol.ts";
import { threadQueue } from "./queue.ts";
import { openRegistry, type Thread } from "./registry.ts";
import { agentReader } from "./agent-conversation.ts";
import { threadStarter } from "./threads.ts";
import type { NodeName, TailnetNodeId } from "../ids.ts";
import type { ProjectId } from "../project.ts";
import { tempDir, testImage } from "../test-kit.ts";

const node = "rj-firebat" as NodeName;
const image = testImage({ id: "img-000000000000", sha256: "0".repeat(64) });
const laptop = "nLAPTOP" as TailnetNodeId;
const block = (token: string, items: unknown[]) => `\`\`\`nexus-plan\n${JSON.stringify({ token, items })}\n\`\`\``;
const a = { key: "a", title: "A", brief: "Build A." };
const b = { key: "b", title: "B", brief: "Build B.", after: ["a"] };
/** Each pass asks at a later millisecond, so a later block's cards list after an earlier one's rather than by block hash. */
let asked = Date.now();

test("a plan block is read only with its thread's token, as an ordered list of items each waiting on earlier ones or on pipeline items", () => {
  const [plan] = planBlocks([`Here is the plan.\n${block("tok", [a, { ...b, after: ["a", "it-0123456789ab"] }])}`], "tok");
  assert.deepEqual(plan!.map(({ block: _, ...p }) => p), [
    { index: 1, key: "a", title: "A", brief: "Build A.", after: [] },
    { index: 2, key: "b", title: "B", brief: "Build B.", after: ["a", "it-0123456789ab"] },
  ]);
  assert.equal(new Set(plan!.map((p) => p.block)).size, 1, "a block's items share its hash");
  assert.deepEqual(planBlocks([block("tok", [a])], "tok")[0]![0]!.block, planBlocks(["Again:", block("tok", [a])], "tok")[0]![0]!.block, "the same items hash the same");
  assert.notEqual(planBlocks([block("tok", [a])], "tok")[0]![0]!.block, planBlocks([block("tok", [{ ...a, brief: "Build A well." }])], "tok")[0]![0]!.block);

  assert.deepEqual(planBlocks([block("other", [a])], "tok"), [], "another token");
  assert.deepEqual(planBlocks(["```nexus-plan\n{not json\n```"], "tok"), []);
  assert.deepEqual(planBlocks([block("tok", [])], "tok"), [], "no items");
  assert.deepEqual(planBlocks([block("tok", [a, { ...a, title: "A again" }])], "tok"), [], "a key used twice");
  assert.deepEqual(planBlocks([block("tok", [{ ...b, after: ["a"] }, a])], "tok"), [], "an item waits on a later one, so no cycle can be written");
  assert.deepEqual(planBlocks([block("tok", [{ ...a, after: ["nope"] }])], "tok"), [], "an item waits on neither a key nor an item ID");
  assert.deepEqual(planBlocks([block("tok", [{ ...a, title: " " }])], "tok"), [], "a blank title");
  assert.equal(planBlocks([block("tok", [a]), "No change.", block("tok", [a, b])], "tok").length, 2, "every block, oldest first");
  const fenced = "Add this:\n```ts\nexport const x = 1;\n```\nThen test it.";
  assert.equal(planBlocks([block("tok", [{ ...a, brief: fenced }])], "tok")[0]?.[0]?.brief, fenced, "a brief that quotes fenced code stays whole");
  assert.equal(planBlocks([`\`\`\`nexus-plan\n${JSON.stringify({ token: "tok", items: [{ ...a, brief: fenced }] }, null, 2)}\n\`\`\``], "tok")[0]?.[0]?.brief, fenced, "and in pretty-printed JSON");
});

/** `fake` stands for the harness storage, which outlives a restart of the control plane. */
async function fixture(t: import("node:test").TestContext, path = ":memory:", fake = fakeHarness()) {
  const registry = openRegistry(path);
  t.after(() => { try { registry.close(); } catch { /* closed by a restart */ } });
  if (registry.project("acme" as ProjectId) === undefined) {
    registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
    registry.createProject({ id: "acme" as ProjectId, repoUrl: null, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null, pipeline: { autoStart: true } });
    registry.saveImage(image, null);
    registry.setCurrentImage(image.id);
  }
  const start = threadStarter({ registry, harness: fake.harness, mirror: { setupInputs: () => Promise.reject(new Error("a scratch project has no remote")) }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, wake: () => {} });
  const queue = threadQueue({ registry, gate: turnGate(() => false), startThread: start, send: (id, text, requestId) => fake.harness.send(id, text, requestId, "followUp") });
  const items = pipeline({ registry, queue });
  const plans = planning({ registry, pipeline: items, replies: agentReader(registry, fake.harness).replies, now: () => ++asked });
  t.after(async () => { await plans.close(); await items.close(); await queue.close(); });
  return {
    registry, fake, plans, items, queue,
    async planner(): Promise<Thread> {
      const thread = await start({ project: "acme", title: "Plan" }, laptop);
      plans.begin(thread);
      return thread;
    },
    /** The thread's agent ends a turn with this reply. */
    reply(thread: Thread, text: string) {
      fake.transcript(thread.id).messages.push({ role: "assistant", content: [{ type: "text", text }] } as never);
      registry.recordReply(thread.id, Date.now());
    },
  };
}

test("a block makes each card once, read twice, by passes that overlap, or again after a restart cut its read short", async (t) => {
  const path = join(await tempDir("nexus-planning-"), "registry.db");
  const first = await fixture(t, path);
  const thread = await first.planner();
  const token = first.registry.planning(thread.id)!.token;
  assert.match(token, new RegExp(`^${thread.id}:[0-9a-f]{12}$`), "the token is the thread's ID and random hex, as the review loop's are");
  first.plans.begin(thread);
  assert.equal(first.registry.planning(thread.id)!.token, token, "a second begin keeps the token");
  first.reply(thread, `Plan:\n${block(token, [a, b])}`);
  await Promise.all([first.plans.poll(), first.plans.poll()]);
  const ids = first.registry.questions(thread.id).map((q) => q.id);
  assert.equal(ids.length, 2);
  assert.equal(first.registry.attention(thread.id), "decision");
  assert.deepEqual([first.registry.items().length, first.registry.queuedThreads().length], [0, 0], "cards, not items or threads, though the project's items start on their own");

  first.reply(thread, "Nothing new.");
  await first.plans.poll();
  assert.deepEqual(first.registry.questions(thread.id).map((q) => q.id), ids, "a later turn reads the block again and asks nothing new");
  // A restart before the read was saved reads every reply again.
  first.registry.savePlanning({ ...first.registry.planning(thread.id)!, read: 0 });
  await first.plans.close();
  first.registry.close();

  const second = await fixture(t, path, first.fake);
  await second.plans.poll();
  assert.deepEqual(second.registry.questions(thread.id).map((q) => q.id), ids, "the restart asks nothing again");
  assert.equal(second.registry.planning(thread.id)!.read, second.registry.thread(thread.id)!.lastReplyAt);

  second.reply(thread, `Revised:\n${block(token, [a, { ...b, brief: "Build B later." }])}`);
  await second.plans.poll();
  assert.equal(second.registry.questions(thread.id).length, 4, "a revised block is a new block, with a card for each of its items");
});

test("a message the harness did not take leaves the guide and the answers for the next one, and a resend of its ID gets the same text", async (t) => {
  const f = await fixture(t);
  const thread = await f.planner();
  const failed = f.plans.compose(thread, "msg:1", "Plan it.");
  assert.ok(failed.startsWith(planningPrefix) && failed.includes(f.registry.planning(thread.id)!.token));
  const retried = f.plans.compose(thread, "msg:2", "Plan it, please.");
  assert.ok(retried.includes(f.registry.planning(thread.id)!.token), "the guide goes again, since msg:1 was never taken");
  f.plans.sent(thread, "msg:2");
  assert.equal(f.plans.compose(thread, "msg:2", "Plan it, please."), retried);
  assert.equal(f.plans.compose(thread, "msg:3", "And then?"), "And then?");

  f.reply(thread, block(f.registry.planning(thread.id)!.token, [a]));
  await f.plans.poll();
  f.registry.answerQuestion(f.registry.questions(thread.id)[0]!.id, { option: "reject", by: laptop, at: 1 });
  assert.match(f.plans.compose(thread, "msg:4", "Why?"), /rejected "A" \(key a\)/);
  assert.match(f.plans.compose(thread, "msg:5", "Why?"), /rejected "A" \(key a\)/, "msg:4 was not taken, so msg:5 tells it");
  f.plans.sent(thread, "msg:5");
  assert.equal(f.plans.compose(thread, "msg:6", "Go on."), "Go on.");
});

test("an item waits on a pipeline item named by its ID even when a later proposal of the block has that ID as its key", async (t) => {
  const f = await fixture(t);
  const thread = await f.planner();
  f.reply(thread, block(f.registry.planning(thread.id)!.token, [{ ...a, after: ["it-0123456789ab"] }, { key: "it-0123456789ab", title: "Later", brief: "Build later.", after: ["a"] }]));
  await f.plans.poll();
  const [qa] = f.registry.questions(thread.id);
  assert.match(qa!.text, /It waits on pipeline item it-0123456789ab\./);
  assert.throws(() => f.registry.answerQuestion(qa!.id, { option: "accept", by: laptop, at: 1 }, f.plans.answered), (err: { status?: number; message: string }) => err.status === 404 && /no item it-0123456789ab/.test(err.message));
});

test("an accepted proposal adds the item named from its question once, and one after a rejected proposal cannot be accepted", async (t) => {
  const f = await fixture(t);
  const thread = await f.planner();
  f.reply(thread, block(f.registry.planning(thread.id)!.token, [a, b]));
  await f.plans.poll();
  const [qa, qb] = f.registry.questions(thread.id);
  const answer = (id: string, option: string) => f.registry.answerQuestion(id, { option, by: laptop, at: 1 }, f.plans.answered);
  answer(qa!.id, "reject");
  assert.throws(() => answer(qb!.id, "accept"), (err: { status?: number; message: string }) => err.status === 409 && /which was rejected, so it cannot be added/.test(err.message));
  assert.equal(f.registry.question(qb!.id)!.answer, null, "the refused answer is not recorded");
  answer(qb!.id, "reject");
  assert.deepEqual(f.registry.items(), []);

  f.reply(thread, block(f.registry.planning(thread.id)!.token, [{ ...a, title: "A, smaller" }, b]));
  await f.plans.poll();
  const [, , qa2, qb2] = f.registry.questions(thread.id);
  answer(qa2!.id, "accept");
  answer(qb2!.id, "accept");
  answer(qb2!.id, "accept");
  assert.deepEqual(f.registry.items().map((i) => [i.id, i.title, i.after, i.addedBy]), [
    [proposalItem(qa2!.id), "A, smaller", [], laptop],
    [proposalItem(qb2!.id), "B", [proposalItem(qa2!.id)], laptop],
  ], "each once, the second after the first");
});
