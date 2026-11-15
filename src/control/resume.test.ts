import { test } from "node:test";
import assert from "node:assert/strict";
import { testPylon, testReview, testThread, claudeWorkerAt, storedTranscripts } from "../test-support/registry-kit.ts";
import { personPhase, type Phase } from "./review-model.ts";
import { agentInbox } from "./inbox.ts";
import { agentReader } from "./agent-conversation.ts";
import { deadTurnResumer, resumeWaitsMs } from "./resume.ts";
import { resumeStartMs } from "./claude-worker.ts";
import { claudeLaunch } from "./claude-launch.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { rewindTo, versionBefore } from "../test-support/schema-kit.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkCaller, reviewerCaller, senders } from "./agent-protocol.ts";
import { transcriptStart, type ClaudeEntry } from "./claude-transcript.ts";
import type { LiveHash, NodeName, ProjectId, PylonId, TailnetNodeId, ThreadId } from "../ids.ts";
import type { CommandResult, PylonCommand } from "../protocol/commands.ts";
import type { PylonEvent } from "../protocol/observations.ts";
import { runningPylon, stoppedPylon, tempDir, testCapacity, testObservation } from "../test-support/kit.ts";

const node = "node" as NodeName;
const session = "c0ffee00-0000-4000-8000-000000000000";
const minute = 60_000;

/** Claude worker threads behind the real inbox and a probe that types, or blocks, and a clock the test moves. */
function fixture(t: import("node:test").TestContext, path = ":memory:") {
  let now = 1_800_000_000_000;
  let registry = openRegistry(path, () => now);
  t.after(() => registry.close());
  const project = { id: "nexus" as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };
  registry.nodes.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
  registry.projects.createProject(project);
  registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  const typed: Extract<PylonCommand, { kind: "send-claude" }>[] = [];
  let outcome: "sent" | "blocked" = "sent";
  const probe = { async command(_: PylonId, command: PylonCommand): Promise<CommandResult> { typed.push(command as Extract<PylonCommand, { kind: "send-claude" }>); return { kind: "send-claude", outcome, terminal: "t1", resumed: true }; } };
  const harness = { async send() { throw new Error("a Claude worker's message never reaches the harness"); } };
  const resumerOf = (r: Registry) => deadTurnResumer({
    registry: r, inbox: agentInbox({ log: assert.fail, registry: r, harness, probes: new Map([[node, probe]]), wake() {} }),
    personWroteTo: agentReader(r, { async watch() { throw new Error("no harness thread here"); } }, storedTranscripts).personWrote, clock: () => now, log() {},
  });
  let resumer = resumerOf(registry);
  let sequence = 0;
  const seq = new Map<ThreadId, number>();
  const pylons: PylonId[] = [];

  function add(id: string, startedBy = "nLAPTOP", worker: "started" | "pending" = "started"): ThreadId {
    const thread = testThread({ id: id as ThreadId, title: id, project: project.id, conversationId: null, startedBy, createdAt: 1, lastHumanActivityAt: 1 });
    registry.threads.createThread(thread, testPylon(thread, { node, liveHash: "hash", boot: { repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "main" } }, dotfiles: { repo: project.repoUrl, ref: "main" } } }), { claude: { prompt: "/poteto-mode fix it" } });
    if (worker === "started") claudeWorkerAt(registry, thread.id, "started", { session });
    pylons.push(thread.pylonId);
    registry.threads.ingested(testObservation(node, { pylons: pylons.map((p) => runningPylon(p, { liveHash: "hash" as LiveHash })) }), []);
    seq.set(thread.id, 0);
    transcript(thread.id, [{ kind: "prompt", at: now, text: "/poteto-mode fix it", from: "person" }, { kind: "reply", at: now, text: "On it." }]);
    return thread.id;
  }
  /** A read of the worker's transcript. `reset` replaces every entry kept so far, as a read of a new session does. */
  function transcript(id: ThreadId, entries: ClaudeEntry[], reset = false) {
    const from = seq.get(id)!;
    registry.threads.appendClaudeRead(id, { session, from: { ...transcriptStart, offset: from }, entries, cursor: { ...transcriptStart, offset: from + 1 }, reset, readAt: now });
    seq.set(id, from + 1);
  }
  /** A hook's report from the worker's session, stamped now by the pylon's clock. */
  function report(id: ThreadId, kind: PylonEvent["kind"]) {
    registry.threads.reportSession(node, { sequence: ++sequence, pylon: registry.threads.thread(id)!.pylonId, time: now, event: { kind, session, at: now } });
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
    get registry() { return registry; },
    get resumer() { return resumer; },
    typed, add, report, turn, transcript,
    /** Closes the registry file, rewinds it to schema `version`, and opens it again, as a control plane upgraded from that version does. */
    upgradeFrom(version: number) {
      registry.close();
      rewindTo(path, version);
      registry = openRegistry(path, () => now);
      resumer = resumerOf(registry);
    },
    tick(ms: number) { now += ms; },
    get now() { return now; },
    set outcome(o: "sent" | "blocked") { outcome = o; },
    resumed: (id: ThreadId) => registry.threads.events("0", { thread: id, kinds: ["thread.resumed"] }).map((e) => e.payload),
  };
}

test("a builder whose session ended three seconds into its turn is resumed once, after the first wait, under the thread and the death's request ID", async (t) => {
  // Thread th-3395408dcae4 on 2026-11-04: session.turn-started at 11:15:22Z, session.ended three seconds later, then
  // attention null and nothing for over 7 hours, until the person's message resumed the session.
  const f = fixture(t);
  const id = f.add("th-3395408dcae4");
  f.turn(id, "session-ended");
  const died = f.registry.threads.thread(id)!.turnDied;
  assert.deepEqual(died, { at: f.now, cause: "session-ended", reason: "its Claude session ended during the turn" });
  assert.equal(f.registry.threads.thread(id)!.working, false);
  await f.resumer.poll();
  assert.equal(f.typed.length, 0, "the first resume waits");
  f.tick(resumeWaitsMs[0]! - 1);
  await f.resumer.poll();
  assert.equal(f.typed.length, 0);
  f.tick(1);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.typed[0]!.session, session);
  assert.ok(f.typed[0]!.text.startsWith(senders.resume.prefix));
  const requestId = `resume:${id}:${died!.at}`;
  assert.equal(f.typed[0]!.requestId, requestId);
  assert.deepEqual(f.resumed(id), [{ turn: died!.at, count: 1, reason: died!.reason, requestId }]);
  f.tick(minute);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1, "a death gets one resume");
  assert.notEqual(f.registry.threads.attention(id), "decision");
});

test("a session that ends after its turn ended, or with no turn, did not die", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "ok");
  f.tick(1_000);
  f.report(id, "session.ended");
  assert.equal(f.registry.threads.thread(id)!.turnDied, undefined);
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
  assert.deepEqual(f.registry.threads.thread(failed)!.turnDied, { at: f.now - 1_000, cause: "model-error", reason: "API Error: Request timed out." });
  assert.equal(f.registry.threads.thread(limited)!.turnDied, undefined);
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.deepEqual(f.typed.map((c) => c.requestId), [`resume:${failed}:${f.registry.threads.thread(failed)!.turnDied!.at}`]);
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
  const record = f.registry.threads.claudeResume(id);
  assert.equal(record?.state, "person");
  assert.equal(record.state === "person" ? record.why : null, "Its turn died (API Error: Request timed out.). It died 4 times in a row, so Nexus stopped resuming it.");
  assert.equal(f.registry.threads.attention(id), "died");
  f.report(id, "session.turn-started");
  assert.notEqual(f.registry.threads.attention(id), "died", "a turn that started since ends the death");
  f.tick(3_000);
  f.transcript(id, [{ kind: "reply", at: f.now, text: "Done." }]);
  f.report(id, "session.turn-ended");
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id), null, "a turn that ends without dying ends the hold");
  assert.equal(f.registry.threads.attention(id), "reply");
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
  assert.equal(f.registry.threads.claudeResume(id), null);
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
  const record = f.registry.threads.claudeResume(id);
  assert.equal(record?.state === "person" ? record.why : null, "Its turn died (its Claude session ended during the turn). Nexus resumed it, and no turn started within 10 minutes.");
  assert.equal(f.registry.threads.attention(id), "died");
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
  assert.equal(f.registry.threads.claudeResume(id)?.state, "sending");
  f.outcome = "sent";
  await f.resumer.poll();
  assert.equal(f.typed.length, 2);
  assert.equal(f.typed[0]!.requestId, f.typed[1]!.requestId);
  assert.equal(f.registry.threads.claudeResume(id)?.state, "resumed");
  assert.equal(f.resumed(id).length, 1);
});

test("a resume delivered just before a crash, whose record says sending, is not typed again", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  const turn = f.registry.threads.thread(id)!.turnDied!.at;
  f.registry.threads.saveClaudeResume(id, { state: "sending", turn, count: 1, from: f.now, since: f.now });
  await f.resumer.poll();
  assert.equal(f.typed.length, 1, "the inbox answers the request ID it already typed");
  assert.equal(f.registry.threads.claudeResume(id)?.state, "resumed");
});

test("a builder the person wrote to before its turn died is resumed, as a conductor's steering answers no later death", async (t) => {
  // th-1362c77311b2, th-77f2eaaf7e39 and th-7efcaa555e4a on 2026-11-15: each had a `nexus send` from the conductor, so
  // their deaths in a DNS outage were left alone, read as a reply, and their pylons paused mid-work.
  const f = fixture(t);
  const id = f.add("th-1362c77311b2");
  f.tick(1_000);
  f.transcript(id, [{ kind: "prompt", at: f.now, text: "main moved, rebase onto it", from: "person" }]);
  f.registry.threads.recordActivity(id, { human: f.now });
  f.turn(id, "ok");
  f.tick(1_000);
  f.turn(id, "model-error");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.ok(f.typed[0]!.text.startsWith(senders.resume.prefix));
  assert.equal(f.registry.threads.claudeResume(id)?.state, "resumed");
});

test("a death the person wrote to the thread after is theirs, and one whose message starts no turn is told as died", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  f.tick(1_000);
  f.transcript(id, [{ kind: "prompt", at: f.now, text: "also check the docs", from: "person" }]);
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.deepEqual(f.typed, [], "the person's message answers the death");
  assert.equal(f.registry.threads.claudeResume(id)?.state, "answered");
  f.tick(10 * minute);
  await f.resumer.poll();
  const record = f.registry.threads.claudeResume(id);
  assert.equal(record?.state === "person" ? record.why : null, "Its turn died (its Claude session ended during the turn). You wrote to it since, and no turn started within 10 minutes.");
  assert.equal(f.registry.threads.attention(id), "died");
  assert.deepEqual(f.typed, []);
});

test("a thread an older release left alone for good is resumed at its next death", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.registry.threads.saveClaudeResume(id, { state: "left-alone" } as never);
  assert.equal(f.registry.threads.claudeResume(id), null);
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
});

test("a reviewer, a check thread, an archived thread and a running turn get no resume", async (t) => {
  const f = fixture(t);
  const reviewer = f.add("th-reviewer", reviewerCaller);
  const check = f.add("th-check", checkCaller);
  const archived = f.add("th-archived");
  const running = f.add("th-running");
  for (const id of [reviewer, check, archived]) f.turn(id, "session-ended");
  f.registry.threads.setThreadStatus(archived, "archived");
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
  assert.equal(f.registry.threads.claudeResume(id)?.state, "resumed", "a read from before the turn's end shows no error yet");
  f.tick(1_000);
  f.transcript(id, [{ kind: "notice", at: f.now - 1_000, tone: "error", text: "API Error: Request timed out." }]);
  await f.resumer.poll();
  const record = f.registry.threads.claudeResume(id);
  assert.deepEqual(record, { state: "waiting", turn: f.now - 1_000, count: 2, from: f.now, due: f.now + resumeWaitsMs[1]! });
});

test("a resume delivered just before a crash, whose turn then died, counts toward the deaths in a row", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  const first = f.registry.threads.thread(id)!.turnDied!.at;
  f.registry.threads.saveClaudeResume(id, { state: "sending", turn: first, count: 1, from: f.now, since: f.now });
  f.tick(1_000);
  f.turn(id, "session-ended");
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id)?.state, "resumed");
  await f.resumer.poll();
  const record = f.registry.threads.claudeResume(id);
  assert.equal(record?.state === "waiting" ? record.count : null, 2);
  f.tick(resumeWaitsMs[1]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 2);
});

test("a turn the person's message started is resumed when it dies", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.tick(1_000);
  f.transcript(id, [{ kind: "prompt", at: f.now, text: "also check the docs", from: "person" }]);
  f.registry.threads.recordActivity(id, { human: f.now });
  f.report(id, "session.turn-started");
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id), null);
  f.tick(3_000);
  f.report(id, "session.ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
});

test("a builder whose review is not finished gets no resume for a model error, nor for any death once the review is the person's", async (t) => {
  const f = fixture(t);
  const phases: [string, Phase, "model-error" | "session-ended", boolean][] = [
    ["th-fixing-error", { kind: "fixing" }, "model-error", false],
    ["th-person-error", personPhase("agent", "The builder's model failed 5 times in a row. Run nexus review again once the provider recovers."), "model-error", false],
    ["th-person-ended", personPhase("agent", "The builder gave no answer Nexus could read within 3 hours in round 1."), "session-ended", false],
    ["th-checking-error", { kind: "checking", startedAt: 0, thread: null }, "model-error", false],
    ["th-fixing-ended", { kind: "fixing" }, "session-ended", true],
    ["th-merged-error", { kind: "merged" }, "model-error", true],
  ];
  for (const [i, [name, phase, death]] of phases.entries()) {
    const id = f.add(name);
    f.registry.reviews.saveReview(testReview({ id: `rv-${i}`, builder: id, reviewer: `th-reviewer-${i}` as ThreadId, phase }));
    f.turn(id, death);
  }
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.deepEqual(f.typed.map((c) => c.requestId!.split(":")[1]).sort(), phases.filter(([, , , resumed]) => resumed).map(([name]) => name).sort());
});

test("a death in a builder whose review waits on the person is told to them with why, beside the review, until a turn of it starts", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.registry.reviews.saveReview(testReview({ id: "rv-1", builder: id, reviewer: "th-reviewer" as ThreadId, phase: personPhase("agent", "The builder gave no answer Nexus could read within 3 hours in round 1.") }));
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id), null, "a builder that did not die has no record");
  f.report(id, "session.turn-started");
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id), null, "nor has one whose turn runs");
  f.tick(3_000);
  f.report(id, "session.ended");
  const died = f.registry.threads.thread(id)!.turnDied!;
  await f.resumer.poll();
  const record = { state: "person", turn: died.at, count: 0, why: `Its turn died (${died.reason}). Its review waits on you, so Nexus did not resume it.`, review: true };
  assert.deepEqual(f.registry.threads.claudeResume(id), record);
  assert.equal(f.registry.threads.attention(id), "decision", "the review still comes first");
  f.tick(resumeWaitsMs[0]! + resumeStartMs);
  await f.resumer.poll();
  assert.equal(f.typed.length, 0, "and no resume goes out");
  assert.deepEqual(f.registry.threads.claudeResume(id), record);

  f.tick(1_000);
  f.report(id, "session.turn-started");
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id), null, "the turn the person's message started ends the death");
});

test("a death left to the person only for a review that waits on them is resumed once the review moves on", async (t) => {
  const f = fixture(t);
  const held = personPhase("agent", "The builder gave no answer Nexus could read within 3 hours in round 1.");
  const fresh = f.add("th-fresh");
  const old = f.add("th-old");
  const gone = f.add("th-gone");
  for (const [i, id] of [fresh, old, gone].entries()) f.registry.reviews.saveReview(testReview({ id: `rv-${i}`, builder: id, reviewer: `th-reviewer-${i}` as ThreadId, phase: held }));
  f.turn(old, "session-ended");
  f.tick(61 * minute);
  f.turn(fresh, "session-ended");
  f.turn(gone, "session-ended");
  await f.resumer.poll();
  for (const id of [fresh, old, gone]) assert.equal(f.registry.threads.claudeResume(id)?.state, "person");

  for (const [i, id] of [fresh, old, gone].entries()) f.registry.reviews.saveReview(testReview({ id: `rv-${i}`, builder: id, reviewer: `th-reviewer-${i}` as ThreadId, phase: { kind: "fixing" } }));
  f.tick(1_000);
  f.report(gone, "session.turn-started");
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(fresh)?.state, "waiting", "the death waits for its resume, as one in a builder under no held review");
  const kept = f.registry.threads.claudeResume(old);
  assert.equal(kept?.state === "person" && kept.review, undefined, "a death more than an hour old stays the person's, for that reason now");
  assert.match(kept?.state === "person" ? kept.why : "", /more than 60 minutes before Nexus saw it/);
  assert.equal(f.registry.threads.claudeResume(gone), null, "a turn that started since ends the record");
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.deepEqual(f.typed.map((c) => c.requestId!.split(":")[1]), ["th-fresh"]);
});

test("a session that ends after a turn the transcript shows ended, with a background task still running, did not die", async (t) => {
  const f = fixture(t);
  const finished = f.add("th-finished");
  const interrupted = f.add("th-interrupted");
  for (const [id, entry] of [[finished, { kind: "turn", durationMs: 2_000 }], [interrupted, { kind: "notice", tone: "info", text: "Interrupted" }]] as const) {
    f.report(id, "session.turn-started");
    f.tick(2_000);
    f.transcript(id, [{ ...entry, at: f.now } as ClaudeEntry]);
    f.report(id, "session.heartbeat");
    f.tick(60_000);
    f.report(id, "session.ended");
    assert.equal(f.registry.threads.thread(id)!.turnDied, undefined, entry.kind);
  }
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 0);
});

test("a death more than an hour old, as one from before this control plane watched, is not resumed and is told as died", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "model-error");
  f.tick(60 * minute + 1);
  for (const wait of resumeWaitsMs) {
    await f.resumer.poll();
    f.tick(wait);
  }
  await f.resumer.poll();
  assert.equal(f.typed.length, 0);
  const record = f.registry.threads.claudeResume(id);
  assert.equal(record?.state === "person" ? record.why : null, "Its turn died (API Error: Request timed out.). It died more than 60 minutes before Nexus saw it, so Nexus did not resume it.");
  assert.equal(f.registry.threads.attention(id), "died");
});

test("a resume the session never takes goes to the person once it has tried for ten minutes", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  f.outcome = "blocked";
  await f.resumer.poll();
  f.tick(10 * minute - 1);
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id)?.state, "sending");
  f.tick(1);
  await f.resumer.poll();
  const record = f.registry.threads.claudeResume(id);
  assert.equal(record?.state === "person" ? record.why : null, "Its turn died (its Claude session ended during the turn). Nexus could not type its resume into the session for 10 minutes.");
  assert.equal(f.registry.threads.attention(id), "died");
  const tries = f.typed.length;
  f.tick(minute);
  await f.resumer.poll();
  assert.equal(f.typed.length, tries, "it stops trying");
});

test("a first prompt a pause cut before its turn's hook reached Nexus is resumed after the wake, and its late hook keeps the death", async (t) => {
  // th-050a77cdcaa3 on 2026-11-14: paused 15 s after its worker took its first prompt, before any hook reported the
  // turn. The prompt's turn never ran again, and nothing said so.
  const f = fixture(t);
  const id = f.add("th-050a77cdcaa3");
  const pylon = f.registry.threads.thread(id)!.pylonId;
  const launched = f.now;
  f.registry.threads.moveClaudeWorker(id, { to: "started", at: launched });
  assert.equal(f.registry.threads.thread(id)!.turnDied, undefined, "a launched turn that runs did not die");
  f.tick(15_000);
  f.registry.threads.ingested(testObservation(node, { pylons: [stoppedPylon(pylon, { sessions: null })] }), []);
  assert.deepEqual(f.registry.threads.thread(id)!.turnDied, { at: launched, cause: "session-ended", reason: "its pylon stopped during the turn, which ended its Claude session" });
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 0, "the paused pylon takes no message yet");
  assert.equal(f.registry.threads.claudeResume(id)?.state, "sending");
  f.registry.threads.ingested(testObservation(node, { pylons: [runningPylon(pylon, { liveHash: "hash" as LiveHash, bootedAt: new Date(f.now).toISOString() })] }), []);
  f.registry.threads.reportSession(node, { sequence: 1_000, pylon, time: f.now, event: { kind: "session.turn-started", session, at: launched } });
  assert.equal(f.registry.threads.thread(id)!.working, false, "a turn from before the wake does not run");
  assert.equal(f.registry.threads.thread(id)!.turnDied?.at, launched);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.ok(f.typed[0]!.text.startsWith(senders.resume.prefix));
  f.tick(1_000);
  f.registry.threads.reportSession(node, { sequence: 1_001, pylon, time: f.now, event: { kind: "session.turn-started", session, at: f.now } });
  assert.equal(f.registry.threads.thread(id)!.turnDied, undefined, "the resumed turn ends the death");
});

test("a pylon paused after its turn ended, or one that runs on through the turn, cuts no turn", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  const pylon = f.registry.threads.thread(id)!.pylonId;
  f.turn(id, "ok");
  f.tick(6 * minute);
  f.registry.threads.ingested(testObservation(node, { pylons: [stoppedPylon(pylon, { sessions: null })] }), []);
  assert.equal(f.registry.threads.thread(id)!.turnDied, undefined);
  f.registry.threads.ingested(testObservation(node, { pylons: [runningPylon(pylon, { liveHash: "hash" as LiveHash, bootedAt: new Date(f.now).toISOString() })] }), []);
  f.tick(1_000);
  f.report(id, "session.turn-started");
  f.tick(1_000);
  f.registry.threads.ingested(testObservation(node, { pylons: [runningPylon(pylon, { liveHash: "hash" as LiveHash, bootedAt: new Date(f.now - 2_000).toISOString() })] }), []);
  assert.equal(f.registry.threads.thread(id)!.turnDied, undefined);
  assert.equal(f.registry.threads.thread(id)!.working, true);
});

test("a batch of reports a link gap held back keeps a turn that ran through the gap working, and resumes the deaths in it", async (t) => {
  // 2026-11-15 on infra-testbench: the network was down from 00:23 to 00:36, and the control plane recorded the turns
  // that ended in between at 00:37, all at once.
  const f = fixture(t);
  const long = f.add("th-long");
  const died = f.add("th-1362c77311b2");
  const steered = f.add("th-77f2eaaf7e39");
  f.transcript(steered, [{ kind: "prompt", at: f.now, text: "main moved, rebase onto it", from: "person" }]);
  const pylon = (id: ThreadId) => f.registry.threads.thread(id)!.pylonId;
  let sequence = 5_000;
  const late = (id: ThreadId, kind: PylonEvent["kind"], at: number) => f.registry.threads.reportSession(node, { sequence: ++sequence, pylon: pylon(id), time: f.now, event: { kind, session, at } });
  const start = f.now;
  for (const id of [long, died, steered]) late(id, "session.turn-started", start);
  f.tick(60 * minute);
  assert.equal(f.registry.threads.thread(long)!.working, false, "an hour without a report reads as idle");
  for (let at = start + 5 * minute; at < f.now; at += 5 * minute) late(long, "session.heartbeat", at);
  for (const id of [died, steered]) {
    f.transcript(id, [{ kind: "notice", at: start + 14 * minute, tone: "error", text: "API Error: 502 Bad Gateway: host dns lookup failed for api.anthropic.com (EAI_AGAIN)" }]);
    late(id, "session.turn-ended", start + 14 * minute);
  }
  assert.equal(f.registry.threads.thread(long)!.working, true, "its late heartbeats say it ran through the gap");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.deepEqual(f.typed.map((c) => c.requestId!.split(":")[1]).sort(), [died, steered].sort());
});

test("a resume's ten minutes to be typed, and then to start a turn, count only while its node is online", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  f.registry.threads.apply({ record: "node", node, state: "offline", capacity: testCapacity() });
  await f.resumer.poll();
  for (let i = 0; i < 4; i++) {
    f.tick(5 * minute);
    await f.resumer.poll();
  }
  assert.equal(f.registry.threads.claudeResume(id)?.state, "sending", "twenty minutes offline use none of the ten");
  f.registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
  assert.equal(f.registry.threads.claudeResume(id)?.state, "resumed");
  f.registry.threads.apply({ record: "node", node, state: "offline", capacity: testCapacity() });
  f.tick(20 * minute);
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id)?.state, "resumed", "a turn the offline node could not report yet may have started");
  f.registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  f.tick(10 * minute);
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id)?.state, "person");
});

test("a launch's turn whose hooks come late, stamped before the control plane heard the launch answer, ends, and a pause after it cuts nothing", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1", "nLAPTOP", "pending");
  const pylon = f.registry.threads.thread(id)!.pylonId;
  let hookAt = 0;
  const probe = {
    async command(): Promise<CommandResult> {
      hookAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { kind: "open-session", terminal: "t1" };
    },
  };
  const launches = claudeLaunch({ registry: f.registry, log: assert.fail, retryMs: 1_000, shutdown: new AbortController().signal });
  assert.equal(launches.step(f.registry.threads.thread(id)!, pylon, f.registry.nodes.node(node)!.observation, { probe, snapshot: async () => true, wake() {} }), "skip");
  await launches.settled();
  assert.equal(f.registry.threads.claudeWorker(id)?.state, "started");
  const launched = f.registry.threads.claudeWorker(id)!.session!;
  f.registry.threads.reportSession(node, { sequence: 2_000, pylon, time: hookAt, event: { kind: "session.turn-started", session: launched, at: hookAt } });
  f.registry.threads.reportSession(node, { sequence: 2_001, pylon, time: hookAt, event: { kind: "session.turn-ended", session: launched, at: hookAt + 10 } });
  f.registry.threads.ingested(testObservation(node, { pylons: [stoppedPylon(pylon, { sessions: null })] }), []);
  assert.equal(f.registry.threads.thread(id)!.turnDied, undefined);
});

test("a death seen while the pylon was stopped stands through a boot soon after, and the turn from before does not run", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  const pylon = f.registry.threads.thread(id)!.pylonId;
  const started = f.now;
  f.report(id, "session.turn-started");
  f.tick(15_000);
  f.registry.threads.ingested(testObservation(node, { pylons: [stoppedPylon(pylon, { sessions: null })] }), []);
  f.tick(15_000);
  f.registry.threads.ingested(testObservation(node, { pylons: [runningPylon(pylon, { liveHash: "hash" as LiveHash, bootedAt: new Date(f.now).toISOString() })] }), []);
  const thread = f.registry.threads.thread(id)!;
  assert.equal(thread.working, false);
  assert.equal(thread.turnDied?.at, started);
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.typed.length, 1);
});

test("a resume keeps its pylon's hold while its node is offline, and so does a waiting record an older release saved", async (t) => {
  const f = fixture(t);
  const id = f.add("th-1");
  f.turn(id, "session-ended");
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(id)?.state, "resumed");
  f.registry.threads.apply({ record: "node", node, state: "offline", capacity: testCapacity() });
  for (let i = 0; i < 6; i++) {
    f.tick(minute);
    await f.resumer.poll();
  }
  assert.ok((f.registry.threads.thread(id)!.awaitedUntil ?? 0) > f.now, "six minutes offline keep the hold");
  const old = f.add("th-2");
  f.turn(old, "session-ended");
  const died = f.registry.threads.thread(old)!.turnDied!.at;
  f.registry.threads.saveClaudeResume(old, { state: "waiting", turn: died, count: 2, due: f.now + resumeWaitsMs[1]! } as never);
  f.tick(6 * minute);
  assert.ok((f.registry.threads.thread(old)!.awaitedUntil ?? 0) > f.now, "an older waiting record is held from its death");
});

const dbDir = await tempDir("nexus-resume-");

test("an upgrade keeps a death a session's end recorded mid-turn, so it is resumed, and so a resume that waited on it goes out", async (t) => {
  const f = fixture(t, join(dbDir, `${randomUUID()}.db`));
  const unrecorded = f.add("th-unrecorded");
  const waiting = f.add("th-waiting");
  f.turn(unrecorded, "session-ended");
  f.turn(waiting, "session-ended");
  const died = (id: ThreadId) => f.registry.threads.thread(id)!.turnDied?.at;
  const waitedOn = died(waiting)!;
  await f.resumer.poll();
  assert.equal(f.registry.threads.claudeResume(waiting)?.state, "waiting");
  f.registry.threads.saveClaudeResume(unrecorded, null);
  const before = { unrecorded: died(unrecorded), waiting: waitedOn };
  f.upgradeFrom(versionBefore(/ADD COLUMN turn_ended_at\b/));
  assert.deepEqual({ unrecorded: died(unrecorded), waiting: died(waiting) }, before, "the upgrade keeps both deaths");
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  f.tick(resumeWaitsMs[0]!);
  await f.resumer.poll();
  assert.deepEqual(f.typed.map((c) => c.requestId!.split(":")[1]).sort(), [unrecorded, waiting].sort());
});
