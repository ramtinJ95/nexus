/**
 * nexus answer, against the control plane's real API with a fake harness behind it. A run on a terminal is `main` with
 * a stdin and stderr that claim one, where the person types their confirmation.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import type { Thread } from "../control/thread-store.ts";
import type { Question } from "../control/questions.ts";
import { main } from "./main.ts";
import { laptop, phone, setup, type Run } from "../test-support/cli-kit.ts";

/** The CLI on a terminal whose person types `typed` at the first prompt, and what it showed them on stderr. */
async function onTerminal(s: Awaited<ReturnType<typeof setup>>, args: readonly string[], typed: string): Promise<Run> {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = Object.assign(new PassThrough(), { isTTY: true });
  let shown = "";
  stderr.on("data", (chunk: Buffer) => {
    shown += chunk.toString();
    if (shown.endsWith("Type yes to answer it: ")) stdin.write(`${typed}\n`);
  });
  let stdout = "";
  const out = new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } });
  const code = await main(args, { stdin, stdout: out, stderr, env: s.env() });
  return { code, stdout, stderr: shown };
}

async function asking(t: TestContext) {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Image"]);
  const ask = (id: string, answerer: Question["answerer"], askedAt: number) => s.registry.questions.askQuestion({
    kind: "judgment", id, thread: thread.id, failure: askedAt, text: "Rebuild the pylon image?\nIt changes the base layer.", options: ["Rebuild", "Not now"], reserved: null, answerer, askedAt,
  });
  return { s, thread, ask };
}

test("answer lists a thread's open questions, or one question by its ID, with how to answer each", async (t) => {
  const { s, thread, ask } = await asking(t);
  assert.deepEqual(await s.nexus(["answer", thread.id]), { code: 0, stdout: `${thread.id} asks no open question\n`, stderr: "" });
  ask("qn-person", "person", 1);
  ask("qn-deployer", "deployer", 2);
  ask("qn-done", "person", 3);
  s.registry.questions.answerQuestion(s.registry.questions.question("qn-done")!, { option: "Rebuild", by: laptop, at: 4 });
  const listed = await s.nexus(["answer", thread.id]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listed.stdout, [
    "question qn-person: Rebuild the pylon image?", '  options: "Rebuild", "Not now"', "  needs you", "  answer it with `nexus answer qn-person <option>`",
    "question qn-deployer: Rebuild the pylon image?", '  options: "Rebuild", "Not now"', "  needs a deployer", "  answer it with `nexus answer qn-deployer <option>`", "",
  ].join("\n"), "only the open questions, as show prints them");
  assert.deepEqual((await s.json(["answer", thread.id.slice(3, 8)])).map((q: Question) => q.id), ["qn-person", "qn-deployer"], "a thread by a prefix of its ID");
  assert.deepEqual((await s.json(["answer", "qn-done"])).map((q: Question) => q.answer?.option), ["Rebuild"], "a question by its ID, answered or not");
  const unknown = await s.nexus(["answer", "qn-nosuch"]);
  assert.deepEqual([unknown.code, unknown.stderr], [4, "nexus: no question or thread qn-nosuch\n"]);
});

test("answer records the option once the person types yes, and nothing otherwise", async (t) => {
  const { s, thread, ask } = await asking(t);
  ask("qn-person", "person", 1);
  const declined = await onTerminal(s, ["answer", "qn-person", "Not now"], "no");
  assert.equal(declined.code, 1);
  assert.match(declined.stderr, /question qn-person is not answered, as you did not confirm/);
  assert.equal(s.registry.questions.question("qn-person")!.answer, null);
  const bad = await onTerminal(s, ["answer", "qn-person", "Maybe"], "yes");
  assert.deepEqual([bad.code, bad.stderr], [64, `nexus: "Maybe" is not an option of question qn-person, which are "Rebuild", "Not now". Run nexus answer --help for usage\n`], "an option it lacks asks nothing");
  const answered = await onTerminal(s, ["answer", thread.id, "Not now"], "yes");
  assert.equal(answered.code, 0, answered.stderr);
  assert.equal(answered.stderr, `Answer question qn-person of thread ${thread.id} with "Not now":\n  Rebuild the pylon image?\n  It changes the base layer.\nType yes to answer it: `);
  assert.equal(answered.stdout, 'Answered question qn-person "Not now"\n');
  assert.deepEqual(s.registry.questions.question("qn-person")!.answer && { ...s.registry.questions.question("qn-person")!.answer, at: 0 }, { option: "Not now", by: laptop, at: 0 });
  ask("qn-a", "person", 2);
  ask("qn-b", "person", 3);
  const which = await onTerminal(s, ["answer", thread.id, "Rebuild"], "yes");
  assert.deepEqual([which.code, which.stderr], [64, `nexus: ${thread.id} asks 2 open questions, qn-a, qn-b. Name the one to answer by its ID\n`]);
});

test("answer with an option refuses without a terminal before it sends anything, so an agent cannot answer for the person", async (t) => {
  const { s, ask } = await asking(t);
  ask("qn-person", "person", 1);
  const before = s.requests();
  const refused = await s.nexus(["answer", "qn-person", "Rebuild"]);
  assert.equal(refused.code, 64);
  assert.match(refused.stderr, /stdin or stderr is not a terminal/);
  assert.equal(s.requests(), before, "no request, the health read included");
  assert.equal(s.registry.questions.question("qn-person")!.answer, null);
});

test("answer passes the server's refusal through, as a person who is no deployer answering a deployer question", async (t) => {
  const { s, ask } = await asking(t);
  ask("qn-deployer", "deployer", 1);
  s.callAs(phone);
  const refused = await onTerminal(s, ["answer", "qn-deployer", "Rebuild"], "yes");
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /nexus: caller may not answer this question: its answer may deploy, so only deployers may\n$/);
  assert.equal(s.registry.questions.question("qn-deployer")!.answer, null);
});

test("answer points a Claude worker's ask at its pylon's terminal, since one option cannot answer it", async (t) => {
  const { s, thread } = await asking(t);
  const questions = [{ question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "" }, { label: "Coffee", description: "" }] }];
  s.registry.questions.askQuestion({ kind: "ask", id: "ask-toolu_1", thread: thread.id, text: "Drink: Which drink?", options: [], reserved: null, answerer: "person", askedAt: 1, ask: { session: "s1", toolUseId: "toolu_1", questions } });
  assert.match((await s.nexus(["answer", thread.id])).stdout, new RegExp(`^ {2}answer it in its pylon's terminal with \`nexus attach ${thread.id}\`, or on the dashboard$`, "m"));
  const refused = await onTerminal(s, ["answer", "ask-toolu_1", "Tea"], "yes");
  assert.equal(refused.code, 64);
  assert.match(refused.stderr, /is a Claude worker's AskUserQuestion/);
});
