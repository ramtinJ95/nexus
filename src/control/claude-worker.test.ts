import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeMoves, type ClaudeMove, type ClaudeWorkerState } from "./claude-worker.ts";
import { addThread, claudeWorkerAt, seedRegistry, testNode, testRegistry } from "../test-support/registry-kit.ts";
import type { Registry } from "./registry.ts";
import type { ThreadId } from "../ids.ts";

const states: ClaudeWorkerState[] = ["pending", "starting", "started", "stalled", "failed"];

/** Every state change the worker made before its states were a table, by what made it. */
const oldChanges: [from: ClaudeWorkerState, to: ClaudeWorkerState, by: string][] = [
  ["pending", "starting", "the launch is sent"],
  ["starting", "starting", "the launch is sent again under its session"],
  ["starting", "started", "the launch reached a turn"],
  ["starting", "stalled", "the launch did not reach a turn"],
  ["starting", "failed", "the launch failed, or a restart cut it off"],
  ["started", "started", "the launch answered after its session's turn started"],
  ["starting", "started", "a turn of the launch's session started"],
  ["stalled", "started", "a turn of the launch's session started"],
  ["failed", "started", "a turn of the launch's session started"],
];

function workerThread(t: Parameters<typeof testRegistry>[0], from: ClaudeWorkerState): { registry: Registry; id: ThreadId } {
  const registry = seedRegistry(testRegistry(t));
  const { id } = addThread(registry, { claudePrompt: "fix it" });
  if (from !== "pending") claudeWorkerAt(registry, id, from, { session: "s1", message: `it went ${from}` });
  return { registry, id };
}

const moveTo = (to: ClaudeWorkerState): ClaudeMove => to === "starting" ? { to, session: "s2" } : to === "started" ? { to } : { to: to as "stalled" | "failed", message: `went ${to}` };
const failedEvents = (registry: Registry) => registry.threads.events("0", { kinds: ["thread.failed"] }).map((e) => e.payload.message);

test("the worker's moves are the state changes it made before they were a table", () => {
  const table = states.flatMap((from) => claudeMoves[from].map((to) => `${from} -> ${to}`)).sort();
  assert.deepEqual(table, [...new Set(oldChanges.map(([from, to]) => `${from} -> ${to}`))].sort());
});

for (const from of states) {
  for (const to of states.filter((s) => s !== "pending")) {
    const allowed = oldChanges.some(([f, t]) => f === from && t === to);
    test(`a ${from} worker ${allowed ? "moves" : "does not move"} to ${to}`, (t) => {
      const { registry, id } = workerThread(t, from);
      const before = registry.threads.claudeWorker(id)!;
      const failed = failedEvents(registry);
      assert.equal(registry.threads.moveClaudeWorker(id, moveTo(to)), allowed);
      const after = registry.threads.claudeWorker(id)!;
      if (!allowed) {
        assert.deepEqual(after, before, "a refused move changes nothing");
        assert.deepEqual(failedEvents(registry), failed, "a refused move appends no event");
        return;
      }
      assert.equal(after.state, to);
      assert.equal(after.session, to === "starting" ? "s2" : before.session, "only a launch names the session");
      assert.equal(after.message, to === "stalled" || to === "failed" ? `went ${to}` : undefined);
      assert.deepEqual(failedEvents(registry), to === "stalled" || to === "failed" ? [...failed, `went ${to}`] : failed, "a stall or failure appends its thread.failed");
    });
  }
}

test("a move of a thread with no worker changes nothing", (t) => {
  const registry = seedRegistry(testRegistry(t));
  const { id } = addThread(registry);
  assert.equal(registry.threads.moveClaudeWorker(id, { to: "starting", session: "s1" }), false);
  assert.equal(registry.threads.claudeWorker(id), undefined);
});

for (const from of states) {
  test(`a turn of the launch's session ${from === "pending" || from === "started" ? "leaves" : "starts"} a ${from} worker`, (t) => {
    const { registry, id } = workerThread(t, from);
    const pylon = registry.threads.thread(id)!.pylonId;
    let sequence = 0;
    const turn = (session: string) => registry.threads.reportSession(testNode, { sequence: ++sequence, pylon, time: Date.now(), event: { kind: "session.turn-started", session, at: Date.now() + sequence } });
    turn("another");
    assert.equal(registry.threads.claudeWorker(id)!.state, from, "another session's turn leaves the worker");
    turn("s1");
    const worker = registry.threads.claudeWorker(id)!;
    assert.equal(worker.state, from === "pending" ? "pending" : "started");
    if (from !== "pending") assert.equal(worker.message, undefined);
  });
}
