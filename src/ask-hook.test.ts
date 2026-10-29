import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { answerExits, askDecision, askKey, awaitAnswer, deliverAnswer, forgetAsk, forgetSession, hookInput, parseAskAnswer, recordCall, waitingAsks, type AskAnswer } from "../images/pylon/nexus-ask.ts";

const hook = new URL("../images/pylon/nexus-claude-hook", import.meta.url).pathname;

/** AskUserQuestion's input as Claude Code 2.1.310 hands it to a PreToolUse or PermissionRequest hook. */
const input = {
  questions: [
    { question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "Hot", preview: "a cup of tea" }, { label: "Coffee", description: "Strong" }] },
    { question: "What goes in it?", header: "Extras", multiSelect: true, options: [{ label: "Milk", description: "", preview: "milk" }, { label: "Sugar", description: "" }] },
  ],
};
const answer = (session: string, { call = "toolu_1", extras = "Milk, Oat cream" } = {}): AskAnswer => ({
  session, questions: ["Which drink?", "What goes in it?"], toolUseId: call,
  answers: { "Which drink?": "Tea", "What goes in it?": extras }, annotations: { "Which drink?": { notes: "no rush" } },
});

async function asksDir(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-asks-"));
  t.after(() => rm(dir, { recursive: true }));
  return dir;
}

/**
 * An ask that waits in `dir` as the PermissionRequest hook does, after its PreToolUse recorded `call` unless that is
 * null, and whose polls the test lets through one at a time.
 */
async function waitingAsk(dir: string, session: string, { call = "toolu_1" as string | null, pid = process.pid, claude = (): boolean => true } = {}) {
  if (call !== null) await recordCall(dir, session, input, call);
  let asleep = Promise.withResolvers<void>();
  let wake = Promise.withResolvers<void>();
  const sleep = () => {
    asleep.resolve();
    return wake.promise;
  };
  const waited = awaitAnswer(dir, { session, input, pid, at: 5 }, claude, { sleep });
  await Promise.race([asleep.promise, waited]);
  return {
    waited,
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

/** Delivers the answer, letting the ask poll each time the delivery waits for it to be taken. */
const delivered = (dir: string, a: AskAnswer, ask: { poll(): Promise<void> }) => deliverAnswer(dir, a, { sleep: () => ask.poll() });

/** A delivery that waits until `go` for its first poll, and the promise of its exit code once it waits. */
async function pendingDelivery(dir: string, a: AskAnswer) {
  const waiting = Promise.withResolvers<void>();
  const go = Promise.withResolvers<void>();
  const code = deliverAnswer(dir, a, {
    sleep: () => {
      waiting.resolve();
      return go.promise;
    },
  });
  await Promise.race([waiting.promise, code]);
  return { code, go: () => go.resolve() };
}

const stillWaits = (ask: { waited: Promise<unknown> }) => Promise.race([ask.waited.then(() => false), new Promise<boolean>((resolve) => setImmediate(() => resolve(true)))]);

test("the dashboard's answer reaches the waiting ask as Claude's input with it, a retry of it succeeds, and another answer is refused", async (t) => {
  const dir = await asksDir(t);
  const ask = await waitingAsk(dir, "s1");
  const first = await pendingDelivery(dir, answer("s1"));
  assert.equal(await deliverAnswer(dir, answer("s1", { extras: "Sugar" })), answerExits.answeredOtherwise);
  assert.equal(await deliverAnswer(dir, answer("s2")), answerExits.nobodyWaits, "the same questions in another session");
  assert.equal(await delivered(dir, answer("s1"), ask), answerExits.delivered, "the same answer again before the ask takes it");
  first.go();
  assert.equal(await first.code, answerExits.delivered, "the first delivery once the ask took its answer");
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
  assert.deepEqual(await waitingAsks(dir), [], "an ask that took its answer no longer waits");
  assert.equal(await deliverAnswer(dir, answer("s1")), answerExits.delivered, "the same answer again after Claude has it");
  assert.equal(await deliverAnswer(dir, answer("s1", { extras: "Sugar" })), answerExits.nobodyWaits);
});

test("an answer to a call the terminal answered finds nobody waiting, though Claude asks the same questions again in another call", async (t) => {
  const dir = await asksDir(t);
  const first = await waitingAsk(dir, "s1", { call: "toolu_1" });
  await forgetAsk(dir, "s1", { ...input, answers: { "Which drink?": "Coffee" } });
  await first.poll();
  const second = await waitingAsk(dir, "s1", { call: "toolu_2" });
  assert.equal(await deliverAnswer(dir, answer("s1", { call: "toolu_1" })), answerExits.nobodyWaits);
  await second.poll();
  assert.ok(await stillWaits(second), "the second call does not take the first call's answer");
  assert.equal(await delivered(dir, answer("s1", { call: "toolu_2", extras: "Sugar" }), second), answerExits.delivered);
  assert.equal((await second.waited)?.answers["What goes in it?"], "Sugar");
});

test("an answer the terminal beats to the dialog after it is written is taken back, so the delivery finds nobody waiting", async (t) => {
  const dir = await asksDir(t);
  const ask = await waitingAsk(dir, "s1");
  const delivery = await pendingDelivery(dir, answer("s1"));
  await forgetAsk(dir, "s1", { ...input, answers: { "Which drink?": "Coffee" } });
  await ask.poll();
  assert.equal(await ask.waited, null, "the hook stops with nothing to print");
  delivery.go();
  assert.equal(await delivery.code, answerExits.nobodyWaits);
  assert.equal(await deliverAnswer(dir, answer("s1")), answerExits.nobodyWaits, "a retry is not acknowledged by the answer left behind");
});

test("an answer the hook does not take in time is taken back, and the hook never hands it to Claude", async (t) => {
  const dir = await asksDir(t);
  const ask = await waitingAsk(dir, "s1");
  assert.equal(await deliverAnswer(dir, answer("s1"), { giveUpMs: 0 }), answerExits.nobodyWaits);
  await ask.poll();
  assert.ok(await stillWaits(ask), "the hook still waits, with no answer to take");
  assert.equal(await delivered(dir, answer("s1", { extras: "Sugar" }), ask), answerExits.delivered, "another answer is not refused for the one taken back");
  assert.equal((await ask.waited)?.answers["What goes in it?"], "Sugar");
});

test("the asks that wait name the call PreToolUse recorded, and leave out one whose call is unknown and one whose hook is gone", async (t) => {
  const dir = await asksDir(t);
  await waitingAsk(dir, "s1");
  assert.deepEqual(await waitingAsks(dir), [{ session: "s1", toolUseId: "toolu_1", at: 5, input }]);
  await waitingAsk(dir, "s2", { call: null });
  assert.deepEqual((await waitingAsks(dir)).map((a) => a.session), ["s1"], "an ask whose PreToolUse recorded nothing cannot be named");

  await waitingAsk(dir, "s3", { pid: spawnSync(process.execPath, ["-e", ""]).pid! });
  assert.equal(await deliverAnswer(dir, answer("s3")), answerExits.nobodyWaits, "an ask whose hook died");
  const key = askKey("s4", ["Which drink?", "What goes in it?"]);
  // A pause stops every hook, and the waiting file it left names a pid that a process after the wake may have.
  await writeFile(join(dir, `${key}.waiting`), JSON.stringify({ pid: process.pid, start: 1, session: "s4", toolUseId: "toolu_4", at: 4, input }));
  assert.equal(await deliverAnswer(dir, answer("s4")), answerExits.nobodyWaits, "a waiting file whose pid another process took");
  await writeFile(join(dir, `${askKey("s5", ["Which drink?", "What goes in it?"])}.waiting`), String(process.pid));
  assert.equal(await deliverAnswer(dir, answer("s5")), answerExits.nobodyWaits, "the bare pid an image from before the record wrote");
  assert.deepEqual((await waitingAsks(dir)).map((a) => a.session), ["s1"]);
});

test("an ask the terminal answered stops at its PostToolUse with nothing to print, and an answer then finds nobody waiting", async (t) => {
  const dir = await asksDir(t);
  const ask = await waitingAsk(dir, "s1");
  await forgetAsk(dir, "s1", { ...input, answers: { "Which drink?": "Coffee" } });
  await ask.poll();
  assert.equal(await ask.waited, null);
  assert.equal(await deliverAnswer(dir, answer("s1")), answerExits.nobodyWaits);
  assert.deepEqual(await waitingAsks(dir), []);
});

test("an ask the terminal answered stops at its PostToolUse though its previews make that input longer than another hook's may be", async (t) => {
  const dir = await asksDir(t);
  const ask = await waitingAsk(dir, "s1");
  const long = { ...input, questions: input.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o, preview: "x".repeat(40 << 10) })) })) };
  const postToolUse = { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: long, tool_response: { ...long, answers: { "Which drink?": "Coffee" } } };
  const text = JSON.stringify(postToolUse);
  assert.ok(text.length > 64 << 10, `${text.length} characters`);
  const payload = await hookInput([text.slice(0, 1000), text.slice(1000)]);
  await forgetAsk(dir, "s1", payload!.tool_input);
  await ask.poll();
  assert.equal(await ask.waited, null);
  assert.equal(await deliverAnswer(dir, answer("s1")), answerExits.nobodyWaits);
  assert.equal(await hookInput([JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { stdout: "x".repeat(70 << 10) } })]), null, "another tool's input that long is left unread");
  assert.equal(await hookInput([JSON.stringify({ ...postToolUse, tool_response: "x".repeat(5 << 20) })]), null, "and an ask's past 4 MiB");
});

test("a turn's start or end, or its session's end, stops the session's waiting asks and leaves another session's", async (t) => {
  const dir = await asksDir(t);
  const interrupted = await waitingAsk(dir, "s1");
  const others = await waitingAsk(dir, "s2", { call: "toolu_2" });
  await forgetSession(dir, "s1");
  await interrupted.poll();
  assert.equal(await interrupted.waited, null);
  assert.deepEqual((await waitingAsks(dir)).map((a) => [a.session, a.toolUseId]), [["s2", "toolu_2"]]);
  assert.equal(await delivered(dir, answer("s2", { call: "toolu_2" }), others), answerExits.delivered);
});

test("an ask whose Claude is gone stops waiting, and an answer then finds nobody waiting", async (t) => {
  const dir = await asksDir(t);
  let claude = true;
  const ask = await waitingAsk(dir, "s1", { claude: () => claude });
  claude = false;
  await ask.poll();
  assert.equal(await ask.waited, null);
  assert.equal(await deliverAnswer(dir, answer("s1")), answerExits.nobodyWaits);
});

test("a PermissionRequest takes the call its PreToolUse recorded, so a later ask of the same questions never names that call", async (t) => {
  const dir = await asksDir(t);
  const interrupted = await waitingAsk(dir, "s1");
  await forgetSession(dir, "s1");
  await interrupted.poll();
  await waitingAsk(dir, "s1", { call: null });
  assert.deepEqual(await waitingAsks(dir), []);
});

test("nexus-claude-hook answer exits 64 for an argument that is not an answer, and 20 with nothing printed when no ask waits, and asks prints a list", async () => {
  for (const arg of ["", "{", JSON.stringify({ ...answer("s1"), questions: [] }), JSON.stringify({ ...answer("s1"), toolUseId: undefined }), JSON.stringify({ ...answer("s1"), toolUseId: 1 }), JSON.stringify({ ...answer("s1"), answers: { "Which drink?": 1 } }), JSON.stringify({ ...answer("s1"), annotations: { "Which drink?": "notes" } })]) {
    assert.equal(parseAskAnswer(arg), null, arg);
  }
  assert.deepEqual(parseAskAnswer(JSON.stringify(answer("s1"))), answer("s1"));
  const run = (...args: string[]) => promisify(execFile)(hook, args).then(({ stdout }) => ({ code: 0, stdout }), (err: { code: number; stdout: string }) => ({ code: err.code, stdout: err.stdout }));
  assert.deepEqual(await run("answer", "{"), { code: answerExits.malformed, stdout: "" });
  assert.deepEqual(await run("answer", JSON.stringify(answer(`never-asked-${randomUUID()}`))), { code: answerExits.nobodyWaits, stdout: "" });
  const asks = await run("asks");
  assert.equal(asks.code, 0);
  assert.ok(Array.isArray(JSON.parse(asks.stdout)), asks.stdout);
});
