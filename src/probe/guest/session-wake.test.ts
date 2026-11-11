import { test } from "node:test";
import assert from "node:assert/strict";
import { seedClaudeState } from "./launchers.ts";
import { coreError, coreNotRunning, fakeCore, fakeGuest, sessionsFileReply, type ExecReply, type FakeCore } from "../../backends/fake-guest.ts";
import type { PylonId } from "../../ids.ts";
import type { PausedSession } from "../../protocol/observations.ts";
import { claudeSessionLock, finishRelaunch, pauseSessions, recordBeforePause, relaunchAfterWake, type RelaunchMark } from "./session-wake.ts";
import { openSession, sendToClaude, sessionFacts, type SessionRecord } from "./sessions.ts";
import { ensureCore } from "../../guest-contract.ts";
import { claudeProjects, sessionsFile } from "../../../images/pylon/nexus-contract.ts";

const pylonId = "pyl-session-wake" as PylonId;

function logged() {
  const lines: string[] = [];
  return { lines, log: async (line: string) => { lines.push(line); } };
}

/** A guest whose sessions file holds `records`, whose core is `core`, and whose other execs answer from `other`. */
function withRecords(records: readonly SessionRecord[], core: FakeCore, other?: (argv: readonly string[]) => ExecReply) {
  return fakeGuest((argv) => {
    const answered = core.reply(argv);
    if (answered !== undefined) return answered;
    if (argv.at(-1) !== sessionsFile && other) return other(argv);
    assert.equal(argv.at(-1), sessionsFile);
    return sessionsFileReply(records);
  });
}

/** A core that kept the shell `title` in `cwd` through the wake, as its first terminal. */
function keptShell(title: string, cwd: string, options: Parameters<typeof fakeCore>[0] = {}) {
  const core = fakeCore(options);
  core.add({ labels: { "nexus.title": title, "nexus.harness": "shell" }, cwd, keep: true });
  return core;
}

const shell: SessionRecord = { herdrPane: "t1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null };
const broken: SessionRecord = { herdrPane: "t2", harness: "shell", title: "broken", cwd: "/gone", harnessSessionId: null };

test("a wake logs each session's outcome, and one that does not come back fails neither the others nor the wake", async () => {
  const core = keptShell("sh", "/home/user", { answer: (method, params) => method === "terminal.run" && params.cwd === "/gone" ? coreError("invalid_params", "no such directory /gone") : undefined });
  const guest = withRecords([shell, broken], core);
  const { lines, log } = logged();
  const outcomes = await relaunchAfterWake(pylonId, guest, log);
  assert.deepEqual(outcomes.map((o) => o.result), ["present", "failed"]);
  assert.deepEqual(lines, [
    'sessions: "sh" (shell) was already running in t1',
    'sessions: "broken" (shell) did not come back: terminal.run: no such directory /gone',
  ]);
  const file = JSON.parse(guest.written.at(-1)!.content);
  assert.deepEqual(file.failed.map((f: { record: SessionRecord }) => f.record.title), ["broken"], "the sessions file keeps it for the next wake");
});

test("a wake whose Herdr Core does not start still succeeds, and its pylon lists every session as failed for the reason, under its old address", async () => {
  const guest = fakeGuest((argv) => {
    if (argv[2] === ensureCore) return { exitCode: 1, output: "tini: not found\n" };
    if (argv.at(-1) !== sessionsFile) return coreNotRunning;
    const last = guest.written.findLast((f) => f.path === sessionsFile)?.content;
    return last === undefined ? sessionsFileReply([shell]) : { exitCode: 0, output: last };
  });
  const { lines, log } = logged();
  const why = "Herdr Core did not start within 5 seconds: tini: not found";
  assert.deepEqual(await relaunchAfterWake(pylonId, guest, log), [{ record: shell, result: "failed", herdrPane: null, message: why }]);
  assert.deepEqual(lines, [`sessions: "sh" (shell) did not come back: ${why}`]);
  assert.deepEqual(await sessionFacts(guest), [{ id: "t1", state: "failed", herdrPane: null, harness: "shell", harnessSessionId: null, status: "unknown", title: "sh", message: why }]);
  assert.deepEqual(await relaunchAfterWake(pylonId, guest, log), [{ record: shell, result: "failed", herdrPane: null, message: why }], "the next wake tries it again");
});

test("a wake whose sessions file cannot be read logs it and leaves the file as it was", async () => {
  const guest = fakeGuest((argv) => {
    assert.equal(argv.at(-1), sessionsFile, "nothing is relaunched");
    return { exitCode: 1, output: "cat: Input/output error" };
  });
  const { lines, log } = logged();
  assert.deepEqual(await relaunchAfterWake(pylonId, guest, log), []);
  assert.deepEqual(lines, [`sessions: the relaunch failed, and the sessions file keeps every session for the next wake: reading ${sessionsFile} failed with exit 1: cat: Input/output error`]);
  assert.deepEqual(guest.written, []);
});

/** A guest whose core runs the shell "sh" and that has no sessions file yet. */
const upWithShell = () => {
  const core = keptShell("sh", "/home/user");
  return fakeGuest((argv) => core.reply(argv) ?? { exitCode: 3, output: "" });
};
const recordedShell: PausedSession[] = [{ id: "t1", herdrPane: "t1", harness: "shell", harnessSessionId: null, title: "sh" }];

test("a pause logs what it recorded and returns it for the backend to keep, and one that cannot record still pauses", async () => {
  const recorded = logged();
  assert.deepEqual(await recordBeforePause(upWithShell(), recorded.log), recordedShell);
  assert.deepEqual(recorded.lines, ["sessions: recorded 1 for the wake"]);

  const none = logged();
  assert.equal(await recordBeforePause(fakeGuest(() => coreNotRunning), none.log), null);
  assert.deepEqual(none.lines, ["sessions: no Herdr Core runs, so the last record stands"]);

  const missing = logged();
  assert.equal(await recordBeforePause(fakeGuest(() => ({ exitCode: 127, output: "sh: herdr-core: not found\n" })), missing.log), null);
  assert.deepEqual(missing.lines, ["sessions: recording failed, so the wake relaunches what the last record holds: terminal.list exited 127 without a JSON reply: sh: herdr-core: not found\n"]);
});

/** A mark held in memory, as a backend's storage would hold it. */
function markOf(pending: boolean, lastRecorded: readonly PausedSession[] | null) {
  const state = { pending, cleared: 0 };
  const mark: RelaunchMark = {
    pending: async () => state.pending,
    clear: async () => { state.pending = false; state.cleared++; },
    lastRecorded: async () => lastRecorded,
  };
  return { state, mark };
}
const lastRecord: PausedSession[] = [{ id: "t9", herdrPane: "t9", harness: "shell", harnessSessionId: null, title: "kept" }];

test("a pause whose relaunch is still pending keeps the last record without recording", async () => {
  const guest = fakeGuest(() => assert.fail("nothing is recorded"));
  const { lines, log } = logged();
  assert.deepEqual(await pauseSessions(guest, log, markOf(true, lastRecord).mark), lastRecord);
  assert.deepEqual(lines, []);
});

test("a pause that cannot record its sessions keeps the last record, and one that records keeps what it recorded", async () => {
  const failing = fakeGuest(() => ({ exitCode: 127, output: "sh: herdr-core: not found\n" }));
  assert.deepEqual(await pauseSessions(failing, logged().log, markOf(false, lastRecord).mark), lastRecord);
  assert.deepEqual(await pauseSessions(fakeGuest(() => coreNotRunning), logged().log, markOf(false, lastRecord).mark), lastRecord);
  assert.deepEqual(await pauseSessions(upWithShell(), logged().log, markOf(false, lastRecord).mark), recordedShell);
});

test("a spawn relaunches and clears the mark only when a relaunch is pending and the spawn asks for one", async () => {
  for (const [pending, relaunch] of [[false, true], [true, false], [false, false]] as const) {
    const { state, mark } = markOf(pending, null);
    await finishRelaunch(pylonId, fakeGuest(() => assert.fail("nothing is relaunched")), logged().log, mark, relaunch);
    assert.deepEqual(state, { pending, cleared: 0 }, `pending ${pending}, relaunch ${relaunch}`);
  }
  const guest = withRecords([shell], keptShell("sh", "/home/user"));
  const { lines, log } = logged();
  const { state, mark } = markOf(true, null);
  await finishRelaunch(pylonId, guest, log, mark, true);
  assert.deepEqual(lines, ['sessions: "sh" (shell) was already running in t1']);
  assert.deepEqual(state, { pending: false, cleared: 1 });
});

/**
 * A pylon whose core keeps its terminals in memory, and whose Claude sessions all have a transcript. A pause stops
 * every process: the wake's core brings each kept terminal back and finishes every other, or, with `keeps` false, as
 * a core whose state was lost, has none.
 */
function pylon(keeps = true) {
  const core = fakeCore();
  const guest = fakeGuest((argv) => {
    const answered = core.reply(argv);
    if (answered !== undefined) return answered;
    if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
    if (argv.at(-1) === claudeProjects) return { exitCode: 0, output: "" };
    if (argv.at(-1) === sessionsFile) {
      const last = guest.written.findLast((f) => f.path === sessionsFile);
      return last === undefined ? { exitCode: 3, output: "" } : { exitCode: 0, output: last.content };
    }
    throw new Error(`unscripted ${argv.join(" ")}`);
  });
  const live = () => core.terminals.filter((t) => t.state === "live");
  return {
    guest,
    pause() {
      core.restart();
      if (!keeps) core.terminals.length = 0;
      core.running = false;
    },
    /** The terminals whose foreground runs `claude` under `session`. */
    running: (session: string) => live().filter((t) => t.foreground?.argv[0] === "claude" && t.foreground.argv.includes(session)).map((t) => t.address),
    titles: () => live().map((t) => t.labels["nexus.title"]),
  };
}

const worker = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
const quiet = async () => {};

/** A worker started under its thread's title, as the control plane's launch leaves it. */
async function launched(p: ReturnType<typeof pylon>): Promise<string> {
  return openSession(p.guest, { harness: "claude-code", title: "Fix the login page", cwd: "/home/user/workspace/repo", resume: worker });
}

/** A pause, then a wake whose relaunch a message reaches at once, through the probe's lock as a send-claude command takes it. */
async function wakeWithMessage(p: ReturnType<typeof pylon>, text: string) {
  await recordBeforePause(p.guest, quiet);
  p.pause();
  const [outcomes, sent] = await Promise.all([
    relaunchAfterWake(pylonId, p.guest, quiet),
    claudeSessionLock(pylonId)([worker], () => sendToClaude(p.guest, { session: worker, text })),
  ]);
  return { outcomes, sent };
}

for (const keeps of [true, false]) {
  test(`every wake brings the worker back in one terminal under its title, though a message reaches it while the wake relaunches it${keeps ? "" : ", and when the core kept nothing"}`, async () => {
    const p = pylon(keeps);
    await launched(p);
    for (const wake of [1, 2, 3]) {
      const { sent } = await wakeWithMessage(p, `wake ${wake}`);
      const running = p.running(worker);
      assert.equal(running.length, 1, `after wake ${wake}, one Claude runs the worker's session, not ${running.length}`);
      assert.equal(sent.herdrPane, running[0], `the message of wake ${wake} went to it`);
    }
    assert.deepEqual(p.titles(), ["Fix the login page"]);
  });
}

test("a pylon whose earlier wakes left the worker in several terminals comes back with one, in the first", async () => {
  const p = pylon();
  const first = await launched(p);
  const others = [];
  for (const title of ["Claude Code", "Claude Code"]) others.push(await openSession(p.guest, { harness: "claude-code", title, cwd: "/home/user/workspace/repo", resume: worker }));
  await recordBeforePause(p.guest, quiet);
  p.pause();
  const { lines, log } = logged();
  await relaunchAfterWake(pylonId, p.guest, log);
  const [running] = p.running(worker);
  assert.equal(p.running(worker).length, 1);
  assert.deepEqual(p.titles(), ["Fix the login page"], "the other records are dropped");
  assert.deepEqual(lines, [
    `sessions: relaunched "Fix the login page" (claude-code) in ${running}`,
    `sessions: dropped "Claude Code" (claude-code), a second record of Claude Code session ${worker}`,
    `sessions: dropped "Claude Code" (claude-code), a second record of Claude Code session ${worker}`,
  ]);
  assert.notEqual(running, first);
  assert.ok(!others.includes(running!));
  const file = JSON.parse(p.guest.written.findLast((f) => f.path === sessionsFile)!.content);
  assert.deepEqual(file.sessions.map((r: SessionRecord) => r.herdrPane), [running], "the next pause records one");
  assert.deepEqual(file.failed, []);
});
