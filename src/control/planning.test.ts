import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnGate } from "./drain.ts";
import { fakeHarness } from "./fake-harness.ts";
import { pipeline } from "./pipeline.ts";
import { planBlocks, planning, proposalItem } from "./planning.ts";
import { threadQueue } from "./queue.ts";
import { openRegistry, type Thread } from "./registry.ts";
import { agentReplies } from "./review.ts";
import { threadStarter } from "./threads.ts";
import type { ImageManifest } from "../images.ts";
import type { NodeName, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";

const node = "rj-firebat" as NodeName;
const image: ImageManifest = {
  id: "img-000000000000", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "0".repeat(64),
  pins: {
    debianDigest: "d", node: "24", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s",
    gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
const laptop = "nLAPTOP" as TailnetNodeId;
const block = (token: string, items: unknown[]) => `\`\`\`nexus-plan\n${JSON.stringify({ token, items })}\n\`\`\``;
const a = { key: "a", title: "A", brief: "Build A." };
const b = { key: "b", title: "B", brief: "Build B.", after: ["a"] };

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
  const plans = planning({ registry, pipeline: items, replies: agentReplies(registry, fake.harness) });
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
  const path = join(await mkdtemp(join(tmpdir(), "nexus-planning-")), "registry.db");
  const first = await fixture(t, path);
  const thread = await first.planner();
  const token = first.registry.planning(thread.id)!.token;
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
