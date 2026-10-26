import { test } from "node:test";
import assert from "node:assert/strict";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { agentInbox } from "./inbox.ts";
import { usageLimitPrefix, usageLimitResumer } from "./usage-limit.ts";
import { transcriptStart, type ClaudeEntry } from "../claude-transcript.ts";
import type { CommandResult, LiveHash, NodeName, PylonCommand, PylonId, TailnetNodeId } from "../protocol.ts";
import type { ProjectId } from "../project.ts";

const node = "node" as NodeName;
const session = "c0ffee00-0000-4000-8000-000000000000";
const resetsAt = 10_000_000;
const graceMs = 60_000;

/** A Claude worker thread whose transcript ends on a usage limit, behind the real inbox and a probe that types or blocks. */
function fixture(t: import("node:test").TestContext, limit: { resetsAt: number | null } = { resetsAt }) {
  const registry = openRegistry(":memory:");
  t.after(() => registry.close());
  const project = { id: "project" as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };
  registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
  registry.createProject(project);
  const thread: Thread = { id: "th-1" as ThreadId, title: "test", project: project.id, pylonId: "pylon-th-1" as PylonId, status: "active", conversationId: null, startedBy: "test", createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false };
  const { desired: _, ...pylon } = newPylonRecord({ thread: thread.id, pylonId: thread.pylonId, node, desired: "running", boot: { pylonId: thread.pylonId, image: "img-000000000000", resources: project.resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "main" } }, dotfiles: { repo: project.repoUrl, ref: "main" } }, firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash" as LiveHash });
  registry.createThread(thread, pylon, "/poteto-mode fix it");
  registry.setClaudeWorker(thread.id, "/poteto-mode fix it", "started", undefined, session);
  const stop: ClaudeEntry = { kind: "notice", at: 5000, tone: "error", text: "You've hit your session limit", usageLimit: limit };
  registry.appendClaudeRead(thread.id, { session, from: transcriptStart, entries: [stop], cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: 1 });
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  const running = { pylonId: thread.pylonId, phase: "running" as const, liveHash: "hash" as LiveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000" as const, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0 };
  registry.apply({ record: "node", node, state: "online", capacity });
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [running], grants: { secrets: [], gitSsh: false }, previewRoutes: [] }, []);
  const typed: Extract<PylonCommand, { kind: "send-claude" }>[] = [];
  let outcome: "sent" | "blocked" = "sent";
  const probe = { async command(_: PylonId, command: PylonCommand): Promise<CommandResult> { typed.push(command as Extract<PylonCommand, { kind: "send-claude" }>); return { kind: "send-claude", outcome, herdrPane: "w1:p1", resumed: false }; } };
  const inbox = agentInbox({ registry, harness: { async send() { throw new Error("a Claude worker's message never reaches the harness"); } }, probes: new Map([[node, probe]]), wake() {} });
  let now = resetsAt + graceMs;
  const resumer = usageLimitResumer({ registry, inbox, clock: () => now, graceMs });
  const continued = () => registry.events("0", { kinds: ["usage-limit.continued"] });
  return { registry, id: thread.id, typed, resumer, continued, setNow(at: number) { now = at; }, setOutcome(o: typeof outcome) { outcome = o; } };
}

test("a worker stopped on its usage limit is told to continue once, after the reset and its grace, under the stop's request ID", async (t) => {
  const f = fixture(t);
  f.setNow(resetsAt + graceMs - 1);
  await f.resumer.poll();
  assert.equal(f.typed.length, 0, "nothing is typed before the reset and its grace pass");
  f.setNow(resetsAt + graceMs);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.typed[0]!.session, session);
  assert.equal(f.typed[0]!.text, `${usageLimitPrefix} The usage limit reset. Continue where you stopped.`);
  const requestId = `usage-limit:${session}:5000`;
  assert.deepEqual(f.continued().map((e) => e.payload), [{ session, stoppedAt: 5000, resetsAt, requestId }]);
  assert.notEqual(f.registry.claudeMessage(f.id, requestId), undefined);
  assert.ok(f.registry.thread(f.id)!.usageLimit, "the thread still shows the stop until Claude's next turn starts");
  await f.resumer.poll();
  assert.equal(f.typed.length, 1, "a stop gets one message");
  assert.equal(f.continued().length, 1);
});

test("a worker whose usage limit names no reset, or whose thread is archived, is not told to continue", async (t) => {
  const unknown = fixture(t, { resetsAt: null });
  unknown.setNow(Number.MAX_SAFE_INTEGER);
  await unknown.resumer.poll();
  assert.equal(unknown.typed.length, 0);
  const archived = fixture(t);
  archived.registry.setThreadStatus(archived.id, "archived");
  await archived.resumer.poll();
  assert.equal(archived.typed.length, 0);
  assert.equal(archived.continued().length, 0);
});

test("a message the session could not take yet is sent again on the next poll", async (t) => {
  const f = fixture(t);
  f.setOutcome("blocked");
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.continued().length, 0, "a message that typed nothing did not continue the worker");
  f.setOutcome("sent");
  await f.resumer.poll();
  assert.equal(f.typed.length, 2);
  assert.equal(f.continued().length, 1);
});
