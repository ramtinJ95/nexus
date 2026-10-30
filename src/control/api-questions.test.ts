/** Questions a thread asks, and a Claude worker's AskUserQuestion. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadDetail } from "./wire.ts";
import type { Question } from "./questions.ts";
import type { ImageId, TailnetNodeId } from "../ids.ts";
import { node, laptop, phone, project, image, claudeSession, testApi, withThread, deployment, withClaude } from "./api-test-kit.ts";

test("a person answers a question, a deployer question needs a deployer, and no node or pylon answers one", async (t) => {
  const s = await withThread(t, { deployment });
  const ask = (id: string, answerer: Question["answerer"]) => s.registry.askQuestion({
    id, thread: s.thread.id, text: "Rebuild the pylon image?\nIt changes the base layer.", options: ["Rebuild", "Not now"], reserved: "image-rebuild", answerer, askedAt: 1,
  });
  ask("qn-person", "person");
  ask("qn-deployer", "deployer");
  const answer = (id: string, option: string) => s.call("POST", `/v1/questions/${id}/answer`, { option });
  const detail = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail;
  assert.equal((await detail()).attention, "decision");
  assert.deepEqual((await detail()).questions.map((q) => q.id), ["qn-deployer", "qn-person"], "by when they were asked, then by ID");

  s.callAs("nFIREBAT" as TailnetNodeId);
  for (const id of ["qn-person", "qn-deployer"]) {
    assert.deepEqual(await answer(id, "Rebuild"), { status: 403, body: { error: "caller may not answer this question: only a person's device may, never infrastructure nodes or pylons" } });
  }
  s.callAs(phone);
  assert.deepEqual(await answer("qn-deployer", "Rebuild"), { status: 403, body: { error: "caller may not answer this question: its answer may deploy, so only deployers may" } });
  assert.deepEqual(await answer("qn-unknown", "Rebuild"), { status: 404, body: { error: "no question qn-unknown" } });
  assert.deepEqual(await answer("qn-person", "Maybe"), { status: 400, body: { error: `"Maybe" is not an option of question qn-person, which are "Rebuild", "Not now"` } });
  assert.equal((await s.call("POST", "/v1/questions/qn-person/answer", { option: "Rebuild", by: laptop })).status, 400, "the answerer is the caller, never the body");

  const answered = await answer("qn-person", "Not now");
  assert.equal(answered.status, 200);
  const first = answered.body as Question;
  assert.deepEqual(first.answer && { option: first.answer.option, by: first.answer.by }, { option: "Not now", by: phone });
  assert.equal((await detail()).attention, "decision", "the deployer question is still open");
  s.callAs(laptop);
  assert.deepEqual(await answer("qn-person", "Not now"), { status: 200, body: first }, "a retried answer gets the first one's record");
  assert.deepEqual(await answer("qn-person", "Rebuild"), { status: 409, body: { error: `question qn-person was answered "Not now" by ${phone}` } });
  assert.equal((await answer("qn-deployer", "Rebuild")).status, 200);
  const after = await detail();
  assert.notEqual(after.attention, "decision");
  assert.deepEqual(after.questions.map((q) => [q.id, q.answer?.option, q.answer?.by]), [["qn-deployer", "Rebuild", laptop], ["qn-person", "Not now", phone]]);
});

test("without deployment options the control node is unknown, so no one answers a question or starts or messages a thread", async (t) => {
  const s = await testApi(t, { deployment: null });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const thread = await s.startThread({ project: "acme", title: "Fix checkout" }, laptop);
  for (const answerer of ["person", "deployer"] as const) {
    s.registry.askQuestion({ id: `qn-${answerer}`, thread: thread.id, text: "Go?", options: ["Yes", "No"], reserved: null, answerer, askedAt: 1 });
  }
  for (const caller of [laptop, "nFIREBAT" as TailnetNodeId]) {
    s.callAs(caller);
    for (const id of ["qn-person", "qn-deployer"]) assert.equal((await s.call("POST", `/v1/questions/${id}/answer`, { option: "Yes" })).status, 403, `${caller} answered ${id}`);
    assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Another" })).status, 403, `${caller} started a thread`);
    assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "Go." })).status, 403, `${caller} messaged a thread`);
  }
});

const drink = { question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "Hot", preview: "a cup of tea" }, { label: "Coffee", description: "Strong" }] };
const extras = { question: "What goes in it?", header: "Extras", multiSelect: true, options: [{ label: "Milk", description: "" }, { label: "Sugar", description: "" }] };

/**
 * A Claude worker thread in a running turn whose pylon's hook reports an AskUserQuestion dialog waiting, which a read
 * of its conversation found, though Claude has written no transcript yet.
 */
async function claudeAsking(t: import("node:test").TestContext) {
  const s = await withClaude(t);
  const at = Date.now();
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: at, event: { kind: "session.turn-started", session: claudeSession, at } });
  s.pylon.asks = [{ session: claudeSession, toolUseId: "toolu_1", at: at + 1, input: { questions: [drink, extras] } }];
  const read = () => s.call("GET", `/v1/threads/${s.thread.id}/conversation`);
  assert.equal((await read()).status, 200);
  const delivered = () => s.commands.filter(([, c]) => c.kind === "exec");
  const answer = (body: unknown) => s.call("POST", "/v1/questions/ask-toolu_1/answer", body);
  const detail = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail;
  const exec = (exitCode: number | null, output: string) => s.probeAnswers(async (c) => c.kind === "exec" ? { kind: "exec", exitCode, output, truncated: false } : assert.fail(`unexpected ${c.kind}`));
  return { ...s, read, delivered, answer, detail, exec };
}

test("a person answers a Claude worker's AskUserQuestion with a choice per question, which the hook in its pylon hands to Claude before it is recorded", async (t) => {
  const s = await claudeAsking(t);
  const [asked] = (await s.detail()).questions;
  assert.deepEqual(asked && { id: asked.id, text: asked.text, options: asked.options, ask: asked.ask, answer: asked.answer }, {
    id: "ask-toolu_1", text: "Drink: Which drink?\nExtras: What goes in it?", options: [], ask: { session: claudeSession, toolUseId: "toolu_1", questions: [drink, extras] }, answer: null,
  });
  assert.equal((await s.detail()).attention, "decision");
  const choices = [{ picked: ["Tea"], notes: "no rush" }, { picked: ["Milk"], own: "Oat cream" }];

  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual(await s.answer({ choices }), { status: 403, body: { error: "caller may not answer this question: only a person's device may, never infrastructure nodes or pylons" } });
  s.callAs(laptop);
  assert.deepEqual(await s.answer({ option: "Tea" }), { status: 400, body: { error: `question ask-toolu_1 is a Claude worker's AskUserQuestion, answered with {"choices": [...]}, a choice for each question it asks` } });
  for (const bad of [{ choices: choices.slice(1) }, { choices: [{ picked: ["Juice"] }, choices[1]] }, { choices: [{ picked: ["Tea"], own: "Water" }, choices[1]] }, { choices, option: "Tea" }]) {
    assert.equal((await s.answer(bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(s.delivered(), [], "nothing refused reaches the pylon");

  s.exec(0, "delivered\n");
  const answered = await s.answer({ choices: [{ picked: ["Tea"], notes: " no rush " }, { picked: ["Milk"], own: "Oat cream" }] });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const first = answered.body as Question;
  assert.deepEqual(first.answer && { ...first.answer, at: 0 }, { option: "Drink: Tea; Extras: Milk, Oat cream", by: laptop, at: 0, choices });
  assert.deepEqual(s.delivered().map(([pylon, c]) => [pylon, c.kind === "exec" && { ...c, argv: c.argv.slice(0, 2) }]), [[s.thread.pylonId, { kind: "exec", argv: ["/usr/local/bin/nexus-claude-hook", "answer"], cwd: "/", timeoutMs: 15_000 }]]);
  const [, command] = s.delivered()[0]!;
  assert.deepEqual(JSON.parse(command.kind === "exec" ? command.argv[2]! : ""), {
    session: claudeSession, questions: ["Which drink?", "What goes in it?"], toolUseId: "toolu_1",
    answers: { "Which drink?": "Tea", "What goes in it?": "Milk, Oat cream" }, annotations: { "Which drink?": { notes: "no rush" } },
  });
  assert.notEqual((await s.detail()).attention, "decision");

  s.callAs(phone);
  assert.deepEqual(await s.answer({ choices }), { status: 200, body: first }, "a retried answer gets the first one's record");
  assert.deepEqual(await s.answer({ choices: [{ picked: ["Coffee"] }, { picked: ["Sugar"] }] }), { status: 409, body: { error: `question ask-toolu_1 was answered "Drink: Tea; Extras: Milk, Oat cream" by ${laptop}` } });
  assert.equal(s.delivered().length, 1, "an answered ask is not handed to Claude again");
  s.registry.askQuestion({ id: "qn-plain", thread: s.thread.id, text: "Go?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: 1 });
  assert.deepEqual(await s.call("POST", "/v1/questions/qn-plain/answer", { choices }), { status: 400, body: { error: `question qn-plain is answered with {"option": "<one of its options>"}` } });
});

test("an answer to an AskUserQuestion nobody waits for any more withdraws it, and one a pylon's image cannot hand to Claude says to answer in its terminal", async (t) => {
  const s = await claudeAsking(t);
  const choices = [{ picked: ["Tea"] }, { picked: ["Milk"] }];
  const open = async () => (await s.detail()).questions.map((q) => [q.id, q.answer]);
  const old = `pylon ${s.thread.pylonId} runs an image from before AskUserQuestion could be answered from the dashboard, so answer it in the pylon's terminal (\`nexus attach ${s.thread.id}\`)`;
  s.exec(127, "sh: 1: /usr/local/bin/nexus-claude-hook: not found\n");
  assert.deepEqual(await s.answer({ choices }), { status: 409, body: { error: old } });
  s.exec(0, "");
  assert.deepEqual(await s.answer({ choices }), { status: 409, body: { error: old } }, "a hook from before asks exits 0 for a kind it does not know");
  s.exec(21, "");
  assert.deepEqual(await s.answer({ choices }), { status: 409, body: { error: "another answer to question ask-toolu_1 reached Claude first" } });
  s.exec(null, "");
  assert.equal((await s.answer({ choices })).status, 502);
  assert.deepEqual(await open(), [["ask-toolu_1", null]], "an answer Claude did not get is not recorded");

  // Each answer above started a read, whose report from before the hook stopped would ask the question again.
  await s.read();
  s.pylon.asks = [];
  s.exec(20, "");
  assert.deepEqual(await s.answer({ choices }), { status: 409, body: { error: "Claude no longer waits for this answer: it was answered in the terminal, its turn ended, or its pylon paused since. Send it to Claude as a message instead" } });
  assert.deepEqual(await open(), []);
  assert.notEqual((await s.detail()).attention, "decision");
  await s.read();
  assert.deepEqual(await open(), [], "the pylon's next report agrees");
});
