import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Thread } from "../control/registry.ts";
import { openDriveStack, project, type CrashArgs } from "./drive-fixture.ts";
import type { HarnessHost } from "./host.ts";

const laptop = "nLAPTOP";
const fixture = join(import.meta.dirname, "drive-fixture.ts");

async function scratch(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-drive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { registryPath: join(dir, "registry.db"), storagePath: join(dir, "harness.sqlite") };
}

/** Each tool result in the thread's conversation, in order. */
async function toolResults(harness: HarnessHost, threadId: string) {
  const watch = await harness.watch(threadId);
  try {
    return watch.value.entries.flatMap((e) => e.model ?? []).flatMap((m) => m.role === "toolResult"
      ? [{ tool: m.toolName, isError: m.isError, text: m.content.flatMap((c) => c.type === "text" ? [c.text] : []).join("") }] : []);
  } finally {
    await watch.stop();
  }
}

/** The user messages of the thread's conversation, with each one's entry kind. */
async function userMessages(harness: HarnessHost, threadId: string) {
  const watch = await harness.watch(threadId);
  try {
    return watch.value.entries.flatMap((e) => (e.model ?? []).flatMap((m) => m.role === "user" ? [{ kind: e.kind, text: typeof m.content === "string" ? m.content : m.content.flatMap((c) => c.type === "text" ? [c.text] : []).join("") }] : []));
  } finally {
    await watch.stop();
  }
}

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 1_000; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting until ${what}`);
}

async function killedAt(args: CrashArgs) {
  const child = spawn(process.execPath, [fixture, JSON.stringify(args)], { stdio: ["ignore", "pipe", "inherit"] });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(signal, "SIGKILL", `the control plane was killed at its ${args.killAt} point, not ended with ${code}`);
}

test("the drive tools answer while the thread's pylon is paused, where bash cannot run", async (t) => {
  const stack = await openDriveStack(await scratch(t));
  t.after(() => stack.close());
  const planner = await stack.start({ project, title: "Plan", drive: true }, laptop) as Thread;
  await stack.harness.send(planner.id, `tool: nexus_start ${JSON.stringify({ project, title: "Build", brief: "Fix the flaky test.", agent: "nexus" })}`, "m1", "followUp");
  await stack.harness.send(planner.id, `tool: nexus_read ${JSON.stringify({ thread: planner.id })}`, "m2", "followUp");
  await stack.harness.send(planner.id, "bash: true", "m3", "followUp");
  const [started, read, bash] = await until(() => toolResults(stack.harness, planner.id), (r) => r.length === 3, "all three calls answered");

  assert.equal(started!.isError, false, started!.text);
  const child = stack.registry.children(planner.id);
  assert.equal(child.length, 1);
  assert.equal(JSON.parse(started!.text).id, child[0]!.id);
  assert.deepEqual(child[0]!.parent, planner.id, "the child records its parent");
  assert.equal(read!.isError, false, read!.text);
  assert.deepEqual(JSON.parse(read!.text).children, [{ id: child[0]!.id, title: "Build", status: "active" }]);
  assert.equal(bash!.isError, true, "bash needs the pylon, which stays paused");
  assert.match(bash!.text, /is paused/);
});

test("a control plane killed mid nexus_start, after the child's row was written, starts no second thread", async (t) => {
  const paths = await scratch(t);
  const first = await openDriveStack(paths);
  const planner = await first.start({ project, title: "Plan", drive: true }, laptop) as Thread;
  await first.close();
  await killedAt({ ...paths, killAt: "start", send: { thread: planner.id, message: `tool: nexus_start ${JSON.stringify({ project, title: "Build", brief: "Fix the flaky test.", agent: "nexus" })}` } });

  const stack = await openDriveStack(paths);
  t.after(() => stack.close());
  const written = stack.registry.children(planner.id);
  assert.equal(written.length, 1, "the killed call wrote its child before the kill");
  const [result] = await until(() => toolResults(stack.harness, planner.id), (r) => r.length === 1, "the call a restart ran again answered");
  assert.equal(result!.isError, false, result!.text);
  assert.equal(JSON.parse(result!.text).id, written[0]!.id, "the rerun answers the thread the killed call started");
  assert.deepEqual(stack.registry.children(planner.id).map((c) => c.id), [written[0]!.id], "and starts no second");
  const briefs = await until(() => userMessages(stack.harness, written[0]!.id), (m) => m.length > 0, "the child got its brief");
  assert.deepEqual(briefs.map((m) => m.kind), ["nexus.thread"], "the brief arrives once, from the parent thread");
  assert.match(briefs[0]!.text, /Fix the flaky test\./);
});

test("a watch whose message was sent just before the control plane was killed delivers once", async (t) => {
  const paths = await scratch(t);
  const first = await openDriveStack(paths);
  const planner = await first.start({ project, title: "Plan", drive: true }, laptop) as Thread;
  const child = await first.start({ project, title: "Build", parent: planner.id, message: "Say hello." }, laptop) as Thread;
  const firstTurn = await until(() => first.registry.thread(child.id)!.lastReplyAt, (at) => at !== null, "the child's first turn ended");
  await first.harness.send(planner.id, `tool: nexus_wait ${JSON.stringify({ thread: child.id, until: "turn-ended" })}`, "m1", "followUp");
  const [waited] = await until(() => toolResults(first.harness, planner.id), (r) => r.length === 1, "nexus_wait answered");
  assert.equal(waited!.isError, false, waited!.text);
  await first.harness.send(child.id, "Again.", "m2", "followUp");
  await until(() => first.registry.thread(child.id)!.lastReplyAt, (at) => at !== firstTurn, "the child's next turn ended");
  assert.equal(first.registry.pendingWatches(planner.id).length, 1, "no pass ran since, so the watch waits");
  await first.close();
  await killedAt({ ...paths, killAt: "watch" });

  const stack = await openDriveStack(paths);
  t.after(() => stack.close());
  const watchMessages = async () => (await userMessages(stack.harness, planner.id)).filter((m) => m.kind === "nexus.watch");
  assert.equal(stack.registry.pendingWatches(planner.id).length, 1, "the kill came after the send and before the save");
  assert.equal((await watchMessages()).length, 1, "the killed pass sent the message");
  await stack.watches.poll();
  assert.equal(stack.registry.pendingWatches(planner.id).length, 0, "the pass after the restart saved it delivered");
  // A second message would wait in the inbox behind the turn the first one started, so count once both are answered.
  await new Promise((r) => setTimeout(r, 500));
  await until(() => stack.registry.thread(planner.id)!.agentTurnRunning, (running) => !running, "the planner answered");
  const watched = await watchMessages();
  assert.equal(watched.length, 1, "and the planner still has the message once");
  assert.match(watched[0]!.text, new RegExp(`Thread ${child.id} "Build", which you watched until turn-ended: its turn ended`));
});
