/** Standing rules: a project's Markdown that each builder thread it starts gets with its first message. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCaller, reviewerCaller, verifyCaller } from "./agent-protocol.ts";
import { checkGate, verifyGate } from "./gate.ts";
import type { PipelineItem } from "./pipeline.ts";
import type { QueuedThread } from "../contract/threads.ts";
import type { Thread } from "./thread-store.ts";
import type { ThreadDetail, ThreadRow } from "./wire.ts";
import type { ImageId, ProjectId, ThreadId } from "../ids.ts";
import { node, project, image, observeNode, testApi, withImage, withQueue } from "../test-support/api-kit.ts";
import { seedRegistry, testPylon, testRegistry, testThread } from "../test-support/registry-kit.ts";

const rules = "- Run npm test before you push.\n- Keep commits small.";
const section = (text: string) => `\n\n## Standing rules for this project\n\n${text}`;
type Api = Awaited<ReturnType<typeof testApi>>;
const setRules = async (s: Api, standingRules: string | null) => {
  const edited = await s.call("PATCH", "/v1/projects/acme", { standingRules });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  return edited.body.standingRules;
};
const revisionOf = async (s: Api, id: string) => ((await s.call("GET", `/v1/threads/${id}`)).body as ThreadDetail).thread.standingRulesRevision;

test("a person sets, changes and clears a project's standing rules, and each change counts a revision that never goes back", async (t) => {
  const s = await testApi(t);
  assert.deepEqual(await s.call("POST", "/v1/projects", project), { status: 201, body: project });
  assert.deepEqual(await setRules(s, `\n  ${rules}  \n`), { text: rules, revision: 1 }, "the text is kept trimmed");
  assert.deepEqual(await setRules(s, rules), { text: rules, revision: 1 }, "the same text is no change");
  assert.deepEqual(await setRules(s, "- Rebase first."), { text: "- Rebase first.", revision: 2 });
  assert.deepEqual(await setRules(s, null), { text: null, revision: 3 });
  assert.deepEqual(await setRules(s, null), { text: null, revision: 3 });
  assert.deepEqual(await setRules(s, rules), { text: rules, revision: 4 }, "a set after a clear counts on");
  assert.deepEqual((await s.call("PATCH", "/v1/projects/acme", { defaultBranch: "trunk" })).body.standingRules, { text: rules, revision: 4 }, "another edit keeps them");
  assert.deepEqual((await s.call("GET", "/v1/projects")).body, [{ ...project, defaultBranch: "trunk", standingRules: { text: rules, revision: 4 } }]);

  const stored = s.registry.project("acme" as ProjectId);
  for (const standingRules of ["", "  \n ", "x".repeat(8_193), "a\0b", 7, { text: "x", revision: 9 }]) {
    assert.equal((await s.call("PATCH", "/v1/projects/acme", { standingRules })).status, 400, JSON.stringify(standingRules).slice(0, 40));
  }
  assert.deepEqual(s.registry.project("acme" as ProjectId), stored, "no refused edit changed the project");
  assert.deepEqual(await setRules(s, "x".repeat(8_192)), { text: "x".repeat(8_192), revision: 5 }, "8192 characters fit");

  const added = await s.call("POST", "/v1/projects", { ...project, id: "ruled", standingRules: rules });
  assert.deepEqual(added, { status: 201, body: { ...project, id: "ruled", standingRules: { text: rules, revision: 1 } } });
  assert.deepEqual(s.registry.project("ruled" as ProjectId)?.standingRules, { text: rules, revision: 1 });
  for (const standingRules of ["", "x".repeat(8_193), { text: rules, revision: 7 }]) {
    assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "refused", standingRules })).status, 400);
  }
  assert.equal(s.registry.project("refused" as ProjectId), undefined);

  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "plain" })).status, 201);
  assert.deepEqual((await s.call("PATCH", "/v1/projects/plain", { standingRules: null })).body, { ...project, id: "plain" }, "clearing rules never set leaves none");
});

test("a Claude worker's first prompt carries the project's standing rules after its brief, and the thread records their revision", async (t) => {
  const s = await withImage(t);
  const plain = await s.call("POST", "/v1/threads", { project: "acme", title: "Before", claude: "fix the bug" });
  assert.equal(s.registry.claudeWorker(plain.body.id)!.prompt, "/poteto-mode fix the bug");
  assert.equal(await revisionOf(s, plain.body.id), undefined, "a project without rules gives none");

  await setRules(s, rules);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Ruled", claude: "fix the bug" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(s.registry.claudeWorker(started.body.id)!.prompt, `/poteto-mode fix the bug${section(rules)}`);
  assert.equal((started.body as Thread).standingRulesRevision, 1);
  assert.equal(await revisionOf(s, started.body.id), 1);
  assert.equal(((await s.call("GET", "/v1/threads")).body as ThreadRow[]).find((r) => r.id === started.body.id)?.standingRulesRevision, 1, "the thread's row has it too");
  const named = await s.call("POST", "/v1/threads", { project: "acme", title: "Named", claude: "/poteto-mode fix it" });
  assert.equal(s.registry.claudeWorker(named.body.id)!.prompt, `/poteto-mode fix it${section(rules)}`);

  await setRules(s, "- Rebase first.");
  assert.equal(s.registry.claudeWorker(started.body.id)!.prompt, `/poteto-mode fix the bug${section(rules)}`, "a started thread keeps what it got");
  assert.equal(await revisionOf(s, started.body.id), 1);
  assert.equal(await revisionOf(s, plain.body.id), undefined, "a thread started before the rules gets none later");
});

test("a Claude prompt that the project's standing rules push past 16384 characters is refused before anything starts", async (t) => {
  const s = await withImage(t);
  const long = "r".repeat(8_192);
  await setRules(s, long);
  const room = 16_384 - "/poteto-mode ".length - section(long).length;
  const fits = await s.call("POST", "/v1/threads", { project: "acme", title: "Fits", claude: "b".repeat(room) });
  assert.equal(fits.status, 201, JSON.stringify(fits.body));
  assert.equal(s.registry.claudeWorker(fits.body.id)!.prompt.length, 16_384);
  const over = await s.call("POST", "/v1/threads", { project: "acme", title: "Over", claude: "b".repeat(room + 1) });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /Claude prompt including \/poteto-mode and project acme's standing rules exceeds 16384 characters/);
  assert.equal(s.registry.threads().length, 1, "the refused start made no thread");
  await setRules(s, null);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Cleared", claude: "b".repeat(room + 1) })).status, 201, "without rules the brief fits");
});

test("a Nexus agent thread's first message carries the rules it recorded, and a repeat of its start sends that text again after the rules change", async (t) => {
  const s = await withImage(t);
  await setRules(s, rules);
  const body = { project: "acme", title: "Brief", message: "Fix the checkout bug.", requestId: "start:1" };
  const first = await s.call("POST", "/v1/threads", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const id = (first.body as Thread).id;
  assert.equal((first.body as Thread).standingRulesRevision, 1);
  assert.deepEqual(s.fake.transcript(id).messages.map((m) => m.content), [`Fix the checkout bug.${section(rules)}`]);

  await setRules(s, "- Rebase first.");
  const again = await s.call("POST", "/v1/threads", body);
  assert.equal((again.body as Thread).id, id);
  assert.deepEqual(s.calls.filter((c) => c[0] === "send").map((c) => c[2]), [`Fix the checkout bug.${section(rules)}`, `Fix the checkout bug.${section(rules)}`], "the repeat sends what the first did");
  assert.equal(await revisionOf(s, id), 1);

  assert.equal((await s.call("POST", `/v1/threads/${id}/messages`, { text: "Also the cart.", requestId: "msg:1" })).status, 202);
  assert.equal(s.fake.transcript(id).messages.at(-1)!.content, "Also the cart.", "a later message carries none");

  const next = await s.call("POST", "/v1/threads", { project: "acme", title: "Next", message: "Fix the cart." });
  assert.equal((next.body as Thread).standingRulesRevision, 2);
  assert.equal(s.fake.transcript((next.body as Thread).id).messages[0]!.content, `Fix the cart.${section("- Rebase first.")}`);

});

test("a Nexus agent thread started without a first message gets the rules it started with on the first message the person sends", async (t) => {
  const s = await withImage(t);
  await setRules(s, rules);
  const started = (await s.call("POST", "/v1/threads", { project: "acme", title: "No brief" })).body as Thread;
  assert.equal(started.standingRulesRevision, undefined, "nothing carried them yet");
  await setRules(s, "- Rebase first.");
  assert.equal((await s.call("POST", `/v1/threads/${started.id}/messages`, { text: "Fix the cart.", requestId: "msg:1" })).status, 202);
  assert.equal(await revisionOf(s, started.id), 1, "the rules it started with");
  assert.equal((await s.call("POST", `/v1/threads/${started.id}/messages`, { text: "Fix the cart.", requestId: "msg:1" })).status, 202);
  assert.equal((await s.call("POST", `/v1/threads/${started.id}/messages`, { text: "And the tests.", requestId: "msg:2" })).status, 202);
  assert.deepEqual(s.calls.filter((c) => c[0] === "send" && c[1] === started.id).map((c) => c[2]),
    [`Fix the cart.${section(rules)}`, `Fix the cart.${section(rules)}`, "And the tests."], "a resend of that message carries them again, and the next carries none");
});

test("two messages sent at once before either carried the rules: the first the harness takes carries them, and retries compose the same text", async (t) => {
  const s = await withImage(t);
  await setRules(s, rules);
  const started = (await s.call("POST", "/v1/threads", { project: "acme", title: "No brief" })).body as Thread;
  const send = s.fake.harness.send;
  t.after(() => { s.fake.harness.send = send; });
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const reached: string[] = [];
  s.fake.harness.send = async (...args) => {
    reached.push(args[2]);
    if (args[2] === "msg:1") { entered.resolve(); await held.promise; }
    return send(...args);
  };
  const first = s.call("POST", `/v1/threads/${started.id}/messages`, { text: "Fix the cart.", requestId: "msg:1" });
  await entered.promise;
  const second = s.call("POST", `/v1/threads/${started.id}/messages`, { text: "And the tests.", requestId: "msg:2" });
  assert.equal(await Promise.race([second.then(() => "sent"), new Promise((resolve) => setTimeout(resolve, 200, "waiting"))]), "waiting");
  assert.deepEqual(reached, ["msg:1"], "the second waits for the first");
  held.resolve();
  assert.equal((await first).status, 202);
  assert.equal((await second).status, 202);
  for (const requestId of ["msg:1", "msg:2"]) {
    assert.equal((await s.call("POST", `/v1/threads/${started.id}/messages`, { text: requestId === "msg:1" ? "Fix the cart." : "And the tests.", requestId })).status, 202);
  }
  assert.deepEqual(s.calls.filter((c) => c[0] === "send" && c[1] === started.id).map((c) => [c[3], c[2]]), [
    ["msg:1", `Fix the cart.${section(rules)}`], ["msg:2", "And the tests."], ["msg:1", `Fix the cart.${section(rules)}`], ["msg:2", "And the tests."],
  ]);
  assert.equal(await revisionOf(s, started.id), 1);
});

test("a first message the harness never took leaves the rules for the person's next message", async (t) => {
  const s = await withImage(t);
  await setRules(s, rules);
  const send = s.fake.harness.send;
  t.after(() => { s.fake.harness.send = send; });
  s.fake.harness.send = async () => { throw new Error("the harness is unreachable"); };
  const failed = await s.call("POST", "/v1/threads", { project: "acme", title: "Brief", message: "Fix the checkout bug." });
  assert.match(failed.body.error, /its first message was not sent: the harness is unreachable\. Send it with POST \/v1\/threads\/(th-[0-9a-f]+)\/messages/);
  const id = /\/v1\/threads\/(th-[0-9a-f]+)\/messages/.exec(failed.body.error)![1]!;
  assert.equal(await revisionOf(s, id), undefined, "no message carried them");
  s.fake.harness.send = send;
  assert.equal((await s.call("POST", `/v1/threads/${id}/messages`, { text: "Fix the checkout bug.", requestId: "msg:1" })).status, 202);
  assert.equal(s.fake.transcript(id).messages[0]!.content, `Fix the checkout bug.${section(rules)}`);
  assert.equal(await revisionOf(s, id), 1);
});

test("a queued Claude worker that rules lengthened past the prompt limit is held for the person, not retried on every pass", async (t) => {
  const s = await withQueue(t);
  await setRules(s, "- Short.");
  const queued = (await s.call("POST", "/v1/threads", { project: "acme", title: "Long", after: [s.first.id], claude: "b".repeat(15_000) })).body as QueuedThread;
  assert.equal(queued.blocked, false);
  await setRules(s, "r".repeat(8_192));
  const refused = await s.call("POST", `/v1/threads/${queued.id}/start`);
  assert.equal(refused.status, 400);
  const view = (await s.call("GET", `/v1/queued/${queued.id}`)).body as QueuedThread;
  assert.equal(view.blocked, true, "held for the person");
  assert.match(view.lastError!, /project acme's standing rules exceeds 16384 characters/);
  assert.ok(s.registry.queuedThread(queued.id as ThreadId)!.refused !== undefined, "the queue reads it again only after a wait or a start-queued");
  await setRules(s, "- Short.");
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/start`)).status, 201, "shorter rules let it start");
});

test("a queued thread gets the rules as they are when it starts, not when it was queued", async (t) => {
  const s = await withQueue(t);
  const queued = (await s.call("POST", "/v1/threads", { project: "acme", title: "Then", after: [s.first.id], message: "Fix the next bug." })).body as QueuedThread;
  assert.equal(queued.prompt, "Fix the next bug.");
  await setRules(s, rules);
  const started = await s.call("POST", `/v1/threads/${queued.id}/start`);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual(s.calls.at(-1), ["send", queued.id, `Fix the next bug.${section(rules)}`, `queued:${queued.id}`, "followUp"]);
  assert.equal((started.body as Thread).standingRulesRevision, 1, "the start answers the revision its delivered message carried");
  assert.equal(await revisionOf(s, queued.id), 1);

  const claude = (await s.call("POST", "/v1/threads", { project: "acme", title: "Later", after: [s.first.id], claude: "Fix it" })).body as QueuedThread;
  assert.equal((await s.call("POST", `/v1/threads/${claude.id}/start`)).status, 201);
  assert.equal(s.registry.claudeWorker(claude.id)!.prompt, `/poteto-mode Fix it${section(rules)}`);
  assert.equal(await revisionOf(s, claude.id), 1);
});

test("a pipeline item's thread gets the rules with its brief, and a planning thread's first message carries none", async (t) => {
  const s = await testApi(t, { pipeline: true });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { pipeline: { autoStart: true } })).status, 200);
  await setRules(s, rules);

  const item = (await s.call("POST", "/v1/items", { project: "acme", title: "A", message: "Build A." })).body as PipelineItem;
  await s.queue!.poll();
  const thread = ((await s.call("GET", `/v1/items/${item.id}`)).body as PipelineItem).thread as ThreadId | null;
  assert.ok(thread !== null && s.registry.thread(thread) !== undefined, "the item's thread started");
  assert.equal(s.fake.transcript(thread).messages[0]!.content, `Build A.${section(rules)}`);
  assert.equal(await revisionOf(s, thread), 1);

  const plan = await s.call("POST", "/v1/threads", { project: "acme", title: "Plan", planning: true, message: "Plan the wave." });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const first = s.fake.transcript(plan.body.id).messages[0]!.content as string;
  assert.ok(first.endsWith("\n\nPlan the wave."), "the guide, then the person's message as written");
  assert.ok(!first.includes(rules), "its builders get the rules on their own");
  assert.equal(await revisionOf(s, plan.body.id), undefined);
});

test("the review loop's reviewers and check and live-check threads get no standing rules", async (t) => {
  const s = await withImage(t);
  await setRules(s, rules);
  const builder = (await s.call("POST", "/v1/threads", { project: "acme", title: "Builder", message: "Build it." })).body as Thread;
  observeNode(s, node, { total: 64, committed: 0 }, { nestedVirtualization: true });
  // The starts the review loop makes, of a Claude reviewer and a Nexus agent one, which the loop sends its request itself.
  const claudeReviewer = await s.startThread({ request: { project: "acme", title: "Review of #1", branch: "main", claude: "Review PR #1.", model: "claude-opus-5-5" }, caller: reviewerCaller, role: "reviewer" });
  assert.equal(s.registry.claudeWorker(claudeReviewer.id)!.prompt, "Review PR #1.");
  const harnessReviewer = await s.startThread({ request: { project: "acme", title: "Review of #1", branch: "main" }, caller: reviewerCaller, role: "reviewer" });
  const head = "a".repeat(40);
  const check = await s.startThread({ request: checkGate.request(builder, "main", head, 2), caller: checkCaller, role: "check" });
  const verify = await s.startThread({ request: verifyGate.request(builder, "main", head, 2), caller: verifyCaller, role: "verify" });
  for (const started of [claudeReviewer, harnessReviewer, check, verify]) {
    assert.equal(started.standingRulesRevision, undefined, started.title);
    assert.equal(await revisionOf(s, started.id), undefined, started.title);
  }
  assert.equal((await s.call("POST", `/v1/threads/${harnessReviewer.id}/messages`, { text: "Look again.", requestId: "msg:r" })).status, 202);
  assert.equal(s.fake.transcript(harnessReviewer.id).messages.at(-1)!.content, "Look again.", "a message to a reviewer carries none");
  assert.equal(await revisionOf(s, harnessReviewer.id), undefined);
});

test("which starts carry standing rules: a person's builder and queued starts do, planning and the review loop's starts do not", async (t) => {
  const s = await testApi(t, { queue: true, planning: true });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  await setRules(s, rules);
  const builder = (await s.call("POST", "/v1/threads", { project: "acme", title: "Builder" })).body as Thread;
  observeNode(s, node, { total: 64, committed: 0 }, { nestedVirtualization: true });
  const head = "a".repeat(40);
  const viaApi = async (body: object) => {
    const started = await s.call("POST", "/v1/threads", { project: "acme", ...body });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    return started.body.id as ThreadId;
  };
  const queued = async (body: object) => {
    const record = (await s.call("POST", "/v1/threads", { project: "acme", after: [builder.id], ...body })).body as QueuedThread;
    assert.equal((await s.call("POST", `/v1/threads/${record.id}/start`)).status, 201);
    return record.id;
  };
  const table: [string, () => Promise<ThreadId>, boolean][] = [
    ["a person's Nexus agent thread", () => viaApi({ title: "Agent" }), true],
    ["a person's Claude worker", () => viaApi({ title: "Claude", claude: "Fix it." }), true],
    ["a person's planning thread", () => viaApi({ title: "Plan", planning: true }), false],
    ["a queued Nexus agent thread", () => queued({ title: "Queued agent" }), true],
    ["a queued Claude worker", () => queued({ title: "Queued Claude", claude: "Fix it." }), true],
    ["the review loop's Claude reviewer", async () => (await s.startThread({ request: { project: "acme", title: "Review", branch: "main", claude: "Review PR #1.", model: "claude-opus-5-5" }, caller: reviewerCaller, role: "reviewer" })).id, false],
    ["the review loop's Nexus agent reviewer", async () => (await s.startThread({ request: { project: "acme", title: "Review", branch: "main" }, caller: reviewerCaller, role: "reviewer" })).id, false],
    ["a check thread", async () => (await s.startThread({ request: checkGate.request(builder, "main", head, 2), caller: checkCaller, role: "check" })).id, false],
    ["a verify pylon's thread", async () => (await s.startThread({ request: verifyGate.request(builder, "main", head, 2), caller: verifyCaller, role: "verify" })).id, false],
  ];
  for (const [name, start, carries] of table) {
    const id = await start();
    assert.equal(s.registry.standingRulesOf(id) !== null, carries, name);
  }
});

test("each registry orders its own sends: one waiting to carry the rules holds up no send to the same thread ID in another registry", async (t) => {
  const [a, b] = [testRegistry(t), testRegistry(t)].map((registry) => {
    seedRegistry(registry);
    const thread = testThread();
    registry.createThread({ ...thread, standingRules: { revision: 1, text: rules, carriedBy: null } }, testPylon(thread));
    return { registry, id: thread.id };
  });
  let release!: () => void;
  const held = a!.registry.sendWithStandingRules(a!.id, "msg:a", "Hello.", () => new Promise<void>((resolve) => { release = resolve; }));
  const sent = await b!.registry.sendWithStandingRules(b!.id, "msg:b", "Hello.", async (text) => text);
  assert.equal(sent, `Hello.${section(rules)}`);
  release();
  await held;
});
