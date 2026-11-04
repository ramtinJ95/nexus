import { test } from "node:test";
import assert from "node:assert/strict";
import { testPylon, testRegistry, testThread } from "./test-kit.ts";
import { agentInbox } from "./inbox.ts";
import { agentReader } from "./agent-conversation.ts";
import { deadTurnResumer, resumeWaitsMs } from "./resume.ts";
import { checkCaller, resumePrefix, reviewerCaller } from "../agent-protocol.ts";
import { transcriptStart, type ClaudeEntry } from "../claude-transcript.ts";
import type { LiveHash, NodeName, ProjectId, PylonId, TailnetNodeId, ThreadId } from "../ids.ts";
import type { CommandResult, PylonCommand } from "../protocol/commands.ts";
import type { PylonEvent } from "../events.ts";
import { runningPylon, testCapacity, testObservation } from "../test-kit.ts";

const node = "node" as NodeName;
const session = "c0ffee00-0000-4000-8000-000000000000";
const minute = 60_000;

/** Claude worker threads behind the real inbox and a probe that types, or blocks, and a clock the test moves. */
function fixture(t: import("node:test").TestContext) {
  let now = 1_800_000_000_000;
  const registry = testRegistry(t, ":memory:", () => now);
  const project = { id: "nexus" as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };
  registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
  registry.createProject(project);
  registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  const typed: Extract<PylonCommand, { kind: "send-claude" }>[] = [];
  let outcome: "sent" | "blocked" = "sent";
  const probe = { async command(_: PylonId, command: PylonCommand): Promise<CommandResult> { typed.push(command as Extract<PylonCommand, { kind: "send-claude" }>); return { kind: "send-claude", outcome, herdrPane: "w1:p1", resumed: true }; } };
  const harness = { async send() { throw new Error("a Claude worker's message never reaches the harness"); } };
  const inbox = agentInbox({ registry, harness, probes: new Map([[node, probe]]), wake() {} });
  const resumer = deadTurnResumer({ registry, inbox, personWroteTo: agentReader(registry, { async watch() { throw new Error("no harness thread here"); } }).personWrote, clock: () => now, log() {} });
  let sequence = 0;
  const seq = new Map<ThreadId, number>();
  const pylons: PylonId[] = [];

  function add(id: string, startedBy = "nLAPTOP"): ThreadId {
    const thread = testThread({ id: id as ThreadId, title: id, project: project.id, conversationId: null, startedBy, createdAt: 1, lastHumanActivityAt: 1 });
    registry.createThread(thread, testPylon(thread, { node, liveHash: "hash", boot: { repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "main" } }, dotfiles: { repo: project.repoUrl, ref: "main" } } }), "/poteto-mode fix it");
    registry.setClaudeWorker(thread.id, "/poteto-mode fix it", "started", undefined, session);
    pylons.push(thread.pylonId);
    registry.ingested(testObservation(node, { pylons: pylons.map((p) => runningPylon(p, { liveHash: "hash" as LiveHash })) }), []);
    seq.set(thread.id, 0);
    transcript(thread.id, [{ kind: "prompt", at: now, text: "/poteto-mode fix it", from: "person" }, { kind: "reply", at: now, text: "On it." }]);
    return thread.id;
  }
  /** A read of the worker's transcript. `reset` replaces every entry kept so far, as a read of a new session does. */
  function transcript(id: ThreadId, entries: ClaudeEntry[], reset = false) {
    const from = seq.get(id)!;
    registry.appendClaudeRead(id, { session, from: { ...transcriptStart, offset: from }, entries, cursor: { ...transcriptStart, offset: from + 1 }, reset, readAt: now });
    seq.set(id, from + 1);
  }
  /** A hook's report from the worker's session, stamped now by the pylon's clock. */
  function report(id: ThreadId, kind: PylonEvent["kind"]) {
    registry.reportSession(node, { sequence: ++sequence, pylon: registry.thread(id)!.pylonId, time: now, event: { kind, session, at: now } });
  }
  /** The person's message, or a resume, starts a turn, which works a while and ends as `end` says. */
  function turn(id: ThreadId, end: "ok" | "session-ended" | "model-error") {
    report(id, "session.turn-started");
    now += 3_000;
    if (end === "session-ended") return report(id, "session.ended");
    if (end === "model-error") transcript(id, [{ kind: "notice", at: now, tone: "error", text: "API Error: Request timed out." }]);
    else transcript(id, [{ kind: "reply", at: now, text: "Done." }]);
    report(id, "session.turn-ended");
  }
  return {
    registry, resumer, typed, add, report, turn, transcript,
    tick(ms: number) { now += ms; },
    get now() { return now; },
    set outcome(o: "sent" | "blocked") { outcome = o; },
    resumed: (id: ThreadId) => registry.events("0", { thread: id, kinds: ["thread.resumed"] }).map((e) => e.payload),
  };
}

test("a builder whose session ended three seconds into its turn is resumed once, after the first wait, under the thread and the death's request ID", async (t) => {
  // Thread th-3395408dcae4 on 2026-11-04: session.turn-started at 11:15:22Z, session.ended three seconds later, then
  // attention null and nothing for over 7 hours, until the person's message resumed the session.
  const f = fixture(t);
  const id = f.add("th-3395408dcae4");
  f.turn(id, "session-ended");
  const died = f.registry.thread(id)!.turnDied;
  assert.deepEqual(died, { at: f.now, cause: "session-ended", reason: "its Claude session ended during the turn" });
  assert.equal(f.registry.thread(id)!.working, false);
  await f.resumer.poll();
  assert.equal(f.typed.length, 0, "the first resume waits");
  f.tick(resumeWaitsMs[0]! - 1);
  await f.resumer.poll();
  assert.equal(f.typed.length, 0);
  f.tick(1);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.typed[0]!.session, session);
  assert.ok(f.typed[0]!.text.startsWith(resumePrefix));
  const requestId = `resume:${id}:${died!.at}`;
  assert.equal(f.typed[0]!.requestId, requestId);
  assert.deepEqual(f.resumed(id), [{ turn: died!.at, count: 1, reason: died!.reason, requestId }]);
  f.tick(minute);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1, "a death gets one resume");
  assert.notEqual(f.registry.attention(id), "decision");
});

test("a session that ends after its turn ended, or with no turn, did not die", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "ok");
  f.tick(1_000);
  f.report(id, "session.ended");
  assert.equal(f.registry.thread(id)!.turnDied, undefined);
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.deepEqual(f.typed, []);
});

test("a turn that ended on a model error is resumed, and one its usage limit stopped is not", async (t) => {
  const f = fixture(t);
  const failed = f.add("th-1");
  const limited = f.add("th-2");
  f.turn(failed, "model-error");
  f.report(limited, "session.turn-started");
  f.tick(1_000);
  f.transcript(limited, [{ kind: "notice", at: f.now, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt: null } }]);
  f.report(limited, "session.turn-ended");
  assert.deepEqual(f.registry.thread(failed)!.turnDied, { at: f.now - 1_000, cause: "model-error", reason: "API Error: Request timed out." });
  assert.equal(f.registry.thread(limited)!.turnDied, undefined);
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.deepEqual(f.typed.map((c) => c.requestId), [`resume:${failed}:${f.registry.thread(failed)!.turnDied!.at}`]);
});

test("each death in a row waits longer, and the death after the last resume goes to the person with a line saying why", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "model-error");
  for (const [i, wait] of resumeWaitsMs.entries()) {
    await f.resumer.poll();
    f.tick(wait - 1);
    await f.resumer.poll();
    assert.equal(f.typed.length, i, `resume ${i + 1} waits ${wait / minute} minutes`);
    f.tick(1);
    await f.resumer.poll();
    assert.equal(f.typed.length, i + 1);
    f.turn(id, "model-error");
  }
  f.tick(60 * minute);
  await f.resumer.poll();
  assert.equal(f.typed.length, resumeWaitsMs.length, "a provider outage does not loop");
  const record = f.registry.claudeResume(id);
  assert.equal(record?.state, "person");
  assert.equal(record.state === "person" ? record.why : null, "Its turn died 4 times in a row (last: API Error: Request timed out.), so Nexus stopped resuming it.");
  assert.equal(f.registry.attention(id), "decision");
  f.turn(id, "ok");
  await f.resumer.poll();
  assert.equal(f.registry.claudeResume(id), null, "a turn that ends without dying ends the hold");
  assert.notEqual(f.registry.attention(id), "decision");
});

test("a turn that ends without dying ends the deaths in a row", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  f.tick(1_000);
  f.turn(id, "ok");
  await f.resumer.poll();
  assert.equal(f.registry.claudeResume(id), null);
  f.tick(1_000);
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 2, "the next death waits the first wait again");
});

test("a resume that starts no turn goes to the person", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  f.tick(10 * minute);
  await f.resumer.poll();
  const record = f.registry.claudeResume(id);
  assert.equal(record?.state === "person" ? record.why : null, "Nexus resumed it after its turn died, and no turn started within 10 minutes.");
  assert.equal(f.registry.attention(id), "decision");
});

test("a resume the session could not take yet is sent again under the same request ID", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  f.outcome = "blocked";
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.registry.claudeResume(id)?.state, "sending");
  f.outcome = "sent";
  await f.resumer.poll();
  assert.equal(f.typed.length, 2);
  assert.equal(f.typed[0]!.requestId, f.typed[1]!.requestId);
  assert.equal(f.registry.claudeResume(id)?.state, "resumed");
  assert.equal(f.resumed(id).length, 1);
});

test("a resume delivered just before a crash, whose record says sending, is not typed again", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  const turn = f.registry.thread(id)!.turnDied!.at;
  f.registry.saveClaudeResume(id, { state: "sending", turn, count: 1 });
  await f.resumer.poll();
  assert.equal(f.typed.length, 1, "the inbox answers the request ID it already typed");
  assert.equal(f.registry.claudeResume(id)?.state, "resumed");
});

test("the person writing to the thread after its first reply leaves it alone", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.transcript(id, [{ kind: "prompt", at: f.now, text: "also check the docs", from: "person" }]);
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.deepEqual(f.typed, []);
  assert.deepEqual(f.registry.claudeResume(id), { state: "left-alone" });
  assert.notEqual(f.registry.attention(id), "decision");
});

test("a reviewer, a check thread, an archived thread and a running turn get no resume", async (t) => {
  const f = fixture(t);
  const reviewer = f.add("th-reviewer", reviewerCaller);
  const check = f.add("th-check", checkCaller);
  const archived = f.add("th-archived");
  const running = f.add("th-running");
  for (const id of [reviewer, check, archived]) f.turn(id, "session-ended");
  f.registry.setThreadStatus(archived, "archived");
  f.turn(running, "model-error");
  f.tick(1_000);
  f.report(running, "session.turn-started");
  for (const wait of resumeWaitsMs) {
    f.tick(wait);
    await f.resumer.poll();
  }
  assert.deepEqual(f.typed, []);
});

test("a turn end the transcript has not been read past yet keeps the deaths in a row", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "model-error");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  f.tick(1_000);
  f.report(id, "session.turn-started");
  f.tick(3_000);
  f.report(id, "session.turn-ended");
  await f.resumer.poll();
  assert.equal(f.registry.claudeResume(id)?.state, "resumed", "a read from before the turn's end shows no error yet");
  f.tick(1_000);
  f.transcript(id, [{ kind: "notice", at: f.now - 1_000, tone: "error", text: "API Error: Request timed out." }]);
  await f.resumer.poll();
  const record = f.registry.claudeResume(id);
  assert.deepEqual(record, { state: "waiting", turn: f.now - 1_000, count: 2, due: f.now + resumeWaitsMs[1]! });
});

test("a resume delivered just before a crash, whose turn then died, counts toward the deaths in a row", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  const first = f.registry.thread(id)!.turnDied!.at;
  f.registry.saveClaudeResume(id, { state: "sending", turn: first, count: 1 });
  f.tick(1_000);
  f.turn(id, "session-ended");
  await f.resumer.poll();
  assert.equal(f.registry.claudeResume(id)?.state, "resumed");
  await f.resumer.poll();
  const record = f.registry.claudeResume(id);
  assert.equal(record?.state === "waiting" ? record.count : null, 2);
  f.tick(resumeWaitsMs[1]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 2);
});

test("a person's message seen while the turn it started runs keeps the thread theirs after the transcript drops it", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.tick(1_000);
  f.transcript(id, [{ kind: "prompt", at: f.now, text: "also check the docs", from: "person" }]);
  f.registry.recordActivity(id, { human: f.now });
  f.report(id, "session.turn-started");
  await f.resumer.poll();
  assert.deepEqual(f.registry.claudeResume(id), { state: "left-alone" });
  f.transcript(id, [{ kind: "reply", at: f.now, text: "Checked." }], true);
  f.tick(3_000);
  f.report(id, "session.ended");
  for (const wait of resumeWaitsMs) {
    f.tick(wait);
    await f.resumer.poll();
  }
  assert.equal(f.typed.length, 0);
});
