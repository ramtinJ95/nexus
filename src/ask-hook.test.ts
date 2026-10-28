import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { answerExits, askDecision, askKey, awaitAnswer, deliverAnswer, forgetAsk, parseAskAnswer, type AskAnswer } from "../images/pylon/nexus-ask.ts";

const hook = new URL("../images/pylon/nexus-claude-hook", import.meta.url).pathname;

/** AskUserQuestion's input as Claude Code 2.1.310 hands it to a PermissionRequest hook. */
const input = {
  questions: [
    { question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "Hot", preview: "a cup of tea" }, { label: "Coffee", description: "Strong" }] },
    { question: "What goes in it?", header: "Extras", multiSelect: true, options: [{ label: "Milk", description: "", preview: "milk" }, { label: "Sugar", description: "" }] },
  ],
};
const answer = (session: string, extras = "Milk, Oat cream"): AskAnswer => ({
  session, questions: ["Which drink?", "What goes in it?"],
  answers: { "Which drink?": "Tea", "What goes in it?": extras }, annotations: { "Which drink?": { notes: "no rush" } },
});

/** An ask that waits in `dir` as the PermissionRequest hook does, whose polls the test lets through one at a time. */
async function waitingAsk(t: { after(fn: () => Promise<void>): void }, session: string, claude = () => true) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-asks-"));
  t.after(() => rm(dir, { recursive: true }));
  let asleep = Promise.withResolvers<void>();
  let wake = Promise.withResolvers<void>();
  const sleep = () => {
    asleep.resolve();
    return wake.promise;
  };
  const waited = awaitAnswer(dir, askKey(session, ["Which drink?", "What goes in it?"]), process.pid, claude, { sleep });
  await Promise.race([asleep.promise, waited]);
  return {
    dir, waited,
    /** Lets the ask poll again, and resolves once it sleeps or returns. */
    async poll() {
      asleep = Promise.withResolvers<void>();
      const woken = wake;
      wake = Promise.withResolvers<void>();
      woken.resolve();
      await Promise.race([asleep.promise, waited]);
    },
  };
}

test("the dashboard's answer reaches the waiting ask as Claude's input with it, a retry of it succeeds, and another answer is refused", async (t) => {
  const ask = await waitingAsk(t, "s1");
  assert.equal(await deliverAnswer(ask.dir, answer("s1")), answerExits.delivered);
  assert.equal(await deliverAnswer(ask.dir, answer("s1")), answerExits.delivered, "the same answer again before the ask takes it");
  assert.equal(await deliverAnswer(ask.dir, answer("s1", "Sugar")), answerExits.answeredOtherwise);
  assert.equal(await deliverAnswer(ask.dir, answer("s2")), answerExits.nobodyWaits, "the same questions in another session");
  await ask.poll();
  const taken = await ask.waited;
  assert.deepEqual(askDecision(input, taken!), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: {
          ...input,
          answers: { "Which drink?": "Tea", "What goes in it?": "Milk, Oat cream" },
          annotations: { "Which drink?": { preview: "a cup of tea", notes: "no rush" } },
        },
      },
    },
  }, "a single-select pick's preview from Claude's own input, and none for a multi-select one");
  assert.equal(await deliverAnswer(ask.dir, answer("s1")), answerExits.delivered, "the same answer again after Claude has it");
  assert.equal(await deliverAnswer(ask.dir, answer("s1", "Sugar")), answerExits.nobodyWaits);
});

test("an ask the terminal answered stops at its PostToolUse with nothing to print, and an answer then finds nobody waiting", async (t) => {
  const ask = await waitingAsk(t, "s1");
  await forgetAsk(ask.dir, "s1", { ...input, answers: { "Which drink?": "Coffee" } });
  await ask.poll();
  assert.equal(await ask.waited, null);
  assert.equal(await deliverAnswer(ask.dir, answer("s1")), answerExits.nobodyWaits);
});

test("an ask whose Claude is gone stops waiting, and an answer to an ask whose hook died finds nobody waiting", async (t) => {
  let claude = true;
  const ask = await waitingAsk(t, "s1", () => claude);
  claude = false;
  await ask.poll();
  assert.equal(await ask.waited, null);
  assert.equal(await deliverAnswer(ask.dir, answer("s1")), answerExits.nobodyWaits);

  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const dir = await mkdtemp(join(tmpdir(), "nexus-asks-"));
  t.after(() => rm(dir, { recursive: true }));
  const asleep = Promise.withResolvers<void>();
  void awaitAnswer(dir, askKey("s1", ["Which drink?", "What goes in it?"]), dead, () => true, { sleep: () => { asleep.resolve(); return new Promise(() => {}); } });
  await asleep.promise;
  assert.equal(await deliverAnswer(dir, answer("s1")), answerExits.nobodyWaits);
});

test("nexus-claude-hook answer exits 64 for an argument that is not an answer, and 20 with nothing printed when no ask waits", async () => {
  for (const arg of ["", "{", JSON.stringify({ ...answer("s1"), questions: [] }), JSON.stringify({ ...answer("s1"), answers: { "Which drink?": 1 } }), JSON.stringify({ ...answer("s1"), annotations: { "Which drink?": "notes" } })]) {
    assert.equal(parseAskAnswer(arg), null, arg);
  }
  assert.deepEqual(parseAskAnswer(JSON.stringify(answer("s1"))), answer("s1"));
  const run = (arg: string) => promisify(execFile)(hook, ["answer", arg]).then(() => ({ code: 0, stdout: "" }), (err: { code: number; stdout: string }) => ({ code: err.code, stdout: err.stdout }));
  assert.deepEqual(await run("{"), { code: answerExits.malformed, stdout: "" });
  assert.deepEqual(await run(JSON.stringify(answer(`never-asked-${randomUUID()}`))), { code: answerExits.nobodyWaits, stdout: "" });
});
