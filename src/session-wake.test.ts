import { test } from "node:test";
import assert from "node:assert/strict";
import { seedClaudeState } from "./claude-state.ts";
import { fakeGuest, herdrArgs, herdrError, herdrOk, herdrPane, herdrSnapshot, sessionsFileReply, type ExecReply, type HerdrArgs } from "./fake-guest.ts";
import type { PylonId } from "./ids.ts";
import type { PausedSession } from "./protocol/observations.ts";
import { finishRelaunch, onePerClaudeSession, pauseSessions, recordBeforePause, relaunchAfterWake, type RelaunchMark } from "./session-wake.ts";
import { sendToClaude, sessionFacts, sessionsFile, type SessionRecord } from "./sessions.ts";

const pylonId = "pyl-session-wake" as PylonId;

function logged() {
  const lines: string[] = [];
  return { lines, log: async (line: string) => { lines.push(line); } };
}

/** A guest whose sessions file holds `records`, whose Herdr answers from `herdr`, and whose other execs from `other`. */
function withRecords(records: readonly SessionRecord[], herdr: (call: HerdrArgs) => ExecReply, other?: (argv: readonly string[]) => ExecReply) {
  return fakeGuest((argv, isHerdr) => {
    if (isHerdr) return herdr(herdrArgs(argv));
    if (argv.at(-1) !== sessionsFile && other) return other(argv);
    assert.equal(argv.at(-1), sessionsFile);
    return sessionsFileReply(records);
  });
}

const shell: SessionRecord = { herdrPane: "w1:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null };
const broken: SessionRecord = { herdrPane: "w2:p1", harness: "shell", title: "broken", cwd: "/gone", harnessSessionId: null };

test("a wake logs each session's outcome, and one that does not come back fails neither the others nor the wake", async () => {
  const guest = withRecords([shell, broken], ({ command: sub, flags }) => {
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "sh" }], [herdrPane("w1:p1", "w1", null, "unknown", null, "/home/user")]));
    if (sub === "workspace create") return herdrError("invalid_params", `no such directory ${flags["--cwd"]}`);
    throw new Error(`unscripted ${sub}`);
  });
  const { lines, log } = logged();
  const outcomes = await relaunchAfterWake(pylonId, guest, log);
  assert.deepEqual(outcomes.map((o) => o.result), ["present", "failed"]);
  assert.deepEqual(lines, [
    'sessions: "sh" (shell) was already running in w1:p1',
    'sessions: "broken" (shell) did not come back: herdr workspace create: no such directory /gone',
  ]);
  const file = JSON.parse(guest.written.at(-1)!.content);
  assert.deepEqual(file.failed.map((f: { record: SessionRecord }) => f.record.title), ["broken"], "the sessions file keeps it for the next wake");
});

test("a wake whose Herdr server does not start still succeeds, and its pylon lists every session as failed for the reason", async () => {
  const guest = fakeGuest((argv, isHerdr) => {
    if (isHerdr) return herdrError("server_not_running");
    if (argv.at(-1) !== sessionsFile) return { exitCode: 127, output: "tini: not found" }; // the detached server start
    const last = guest.written.findLast((f) => f.path === sessionsFile)?.content;
    return last === undefined ? sessionsFileReply([shell]) : { exitCode: 0, output: last };
  });
  const { lines, log } = logged();
  const why = "starting the Herdr server failed with exit 127: tini: not found";
  assert.deepEqual(await relaunchAfterWake(pylonId, guest, log), [{ record: shell, result: "failed", herdrPane: null, message: why }]);
  assert.deepEqual(lines, [`sessions: "sh" (shell) did not come back: ${why}`]);
  const [fact] = await sessionFacts(guest);
  assert.ok(fact?.state === "failed");
  assert.deepEqual({ ...fact, id: fact.id.slice(0, 7) }, { id: "failed-", state: "failed", herdrPane: null, harness: "shell", harnessSessionId: null, status: "unknown", title: "sh", message: why });
  assert.deepEqual(await relaunchAfterWake(pylonId, guest, log), [{ record: shell, result: "failed", herdrPane: null, message: why }], "the next wake tries it again");
});

test("a wake whose sessions file cannot be read logs it and leaves the file as it was", async () => {
  const guest = fakeGuest((argv, isHerdr) => {
    assert.ok(!isHerdr, "nothing is relaunched");
    assert.equal(argv.at(-1), sessionsFile);
    return { exitCode: 1, output: "cat: Input/output error" };
  });
  const { lines, log } = logged();
  assert.deepEqual(await relaunchAfterWake(pylonId, guest, log), []);
  assert.deepEqual(lines, [`sessions: the relaunch failed, and the sessions file keeps every session for the next wake: reading ${sessionsFile} failed with exit 1: cat: Input/output error`]);
  assert.deepEqual(guest.written, []);
});

test("a pause logs what it recorded and returns it for the backend to keep, and one that cannot record still pauses", async () => {
  const up = fakeGuest((argv, isHerdr) => {
    if (!isHerdr) return { exitCode: 3, output: "" }; // no sessions file yet
    return herdrOk(herdrSnapshot([{ id: "w1", label: "sh" }], [herdrPane("w1:p1", "w1", null, "unknown")]));
  });
  const recorded = logged();
  assert.deepEqual(await recordBeforePause(up, recorded.log), [{ id: "w1:p1", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, title: "sh" }]);
  assert.deepEqual(recorded.lines, ["sessions: recorded 1 for the wake"]);

  const none = logged();
  assert.equal(await recordBeforePause(fakeGuest(() => herdrError("server_not_running")), none.log), null);
  assert.deepEqual(none.lines, ["sessions: no Herdr server runs, so the last record stands"]);

  const missing = logged();
  assert.equal(await recordBeforePause(fakeGuest(() => ({ exitCode: 127, output: "sh: herdr: not found\n" })), missing.log), null);
  assert.deepEqual(missing.lines, ["sessions: recording failed, so the wake relaunches what the last record holds: herdr api snapshot exited 127 without a JSON reply: sh: herdr: not found\n"]);
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
const lastRecord: PausedSession[] = [{ id: "w9:p1", herdrPane: "w9:p1", harness: "shell", harnessSessionId: null, title: "kept" }];

test("a pause whose relaunch is still pending keeps the last record without recording", async () => {
  const guest = fakeGuest(() => assert.fail("nothing is recorded"));
  const { lines, log } = logged();
  assert.deepEqual(await pauseSessions(guest, log, markOf(true, lastRecord).mark), lastRecord);
  assert.deepEqual(lines, []);
});

test("a pause that cannot record its sessions keeps the last record, and one that records keeps what it recorded", async () => {
  const failing = fakeGuest(() => ({ exitCode: 127, output: "sh: herdr: not found\n" }));
  assert.deepEqual(await pauseSessions(failing, logged().log, markOf(false, lastRecord).mark), lastRecord);
  assert.deepEqual(await pauseSessions(fakeGuest(() => herdrError("server_not_running")), logged().log, markOf(false, lastRecord).mark), lastRecord);
  const up = fakeGuest((_argv, isHerdr) => isHerdr ? herdrOk(herdrSnapshot([{ id: "w1", label: "sh" }], [herdrPane("w1:p1", "w1", null, "unknown")])) : { exitCode: 3, output: "" });
  assert.deepEqual(await pauseSessions(up, logged().log, markOf(false, lastRecord).mark), [{ id: "w1:p1", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, title: "sh" }]);
});

test("a spawn relaunches and clears the mark only when a relaunch is pending and the spawn asks for one", async () => {
  for (const [pending, relaunch] of [[false, true], [true, false], [false, false]] as const) {
    const { state, mark } = markOf(pending, null);
    await finishRelaunch(pylonId, fakeGuest(() => assert.fail("nothing is relaunched")), logged().log, mark, relaunch);
    assert.deepEqual(state, { pending, cleared: 0 }, `pending ${pending}, relaunch ${relaunch}`);
  }
  const guest = withRecords([shell], ({ command: sub }) => {
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "sh" }], [herdrPane("w1:p1", "w1", null, "unknown", null, "/home/user")]));
    throw new Error(`unscripted ${sub}`);
  });
  const { lines, log } = logged();
  const { state, mark } = markOf(true, null);
  await finishRelaunch(pylonId, guest, log, mark, true);
  assert.deepEqual(lines, ['sessions: "sh" (shell) was already running in w1:p1']);
  assert.deepEqual(state, { pending: false, cleared: 1 });
});

/**
 * A pylon whose Herdr keeps its panes in memory. An agent start makes its pane run Claude under the launch's
 * session, and a pause stops every process: Herdr restores each workspace as a shell, as with its agent resume off,
 * or with `restores` false, as before Herdr first saved its layout, nothing.
 */
function pylon(restores = true) {
  let up = true;
  let panes: ReturnType<typeof herdrPane>[] = [];
  const labels = new Map<string, string>();
  const foreground = new Map<string, readonly string[]>();
  const guest = fakeGuest((argv, isHerdr) => {
    if (!isHerdr) {
      if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
      if (argv.at(-1) === "/home/user/.claude/projects") return { exitCode: 0, output: "" };
      if (argv[3] === "claude-type") return { exitCode: 0, output: "" };
      if (argv.at(-1) === sessionsFile) {
        const last = guest.written.findLast((f) => f.path === sessionsFile);
        return last === undefined ? { exitCode: 3, output: "" } : { exitCode: 0, output: last.content };
      }
      if (argv[2]?.includes("herdr --session nexus server")) { up = true; return { exitCode: 0, output: "" }; }
      throw new Error(`unscripted ${argv.join(" ")}`);
    }
    if (!up) return herdrError("server_not_running");
    const call = herdrArgs(argv);
    switch (call.command) {
      case "workspace list": return herdrOk({ type: "workspace_list", workspaces: [] });
      case "api snapshot": return herdrOk(herdrSnapshot([...labels].map(([id, label]) => ({ id, label })), panes));
      case "pane process-info": {
        const pane = call.flags["--pane"]!;
        const fg = foreground.get(pane) ?? ["-bash"];
        return herdrOk({ type: "pane_process_info", process_info: { pane_id: pane, shell_pid: 100, foreground_processes: [{ pid: 101, name: fg[0]!, argv: fg }] } });
      }
      case "workspace create": {
        const workspace = `w${Math.max(0, ...[...labels.keys()].map((id) => Number(id.slice(1)))) + 1}`;
        labels.set(workspace, call.flags["--label"]!);
        panes.push(herdrPane(`${workspace}:p1`, workspace, null, "unknown"));
        return herdrOk({ type: "workspace_created", workspace: { workspace_id: workspace, label: call.flags["--label"] }, tab: { tab_id: `${workspace}:t1` }, root_pane: { pane_id: `${workspace}:p1` } });
      }
      case "agent start": {
        const pane = call.flags["--pane"]!;
        panes = panes.map((p) => p.pane_id === pane ? herdrPane(pane, p.workspace_id, "claude", "idle", { kind: "id", value: call.rest[1]! }) : p);
        foreground.set(pane, ["claude", ...call.rest]);
        return herdrOk({ type: "agent_started", agent: {}, argv: [] });
      }
      case "pane close": case "workspace close": {
        const id = call.operands[0]!;
        panes = panes.filter((p) => p.pane_id !== id && p.workspace_id !== id);
        for (const w of labels.keys()) if (!panes.some((p) => p.workspace_id === w)) labels.delete(w);
        foreground.delete(id);
        return herdrOk({ type: "ok" });
      }
    }
    throw new Error(`unscripted herdr ${argv.join(" ")}`);
  });
  return {
    guest,
    pause() {
      up = false;
      foreground.clear();
      panes = restores ? panes.map((p) => herdrPane(p.pane_id, p.workspace_id, null, "unknown")) : [];
      if (!restores) labels.clear();
    },
    /** The panes whose foreground runs `claude` under `session`. */
    running: (session: string) => [...foreground].filter(([, argv]) => argv[0] === "claude" && argv.includes(session)).map(([pane]) => pane),
    workspaces: () => [...labels.values()],
  };
}

const worker = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
const quiet = async () => {};

/** A worker launched in its thread's workspace, as the control plane's prompted launch leaves it. */
async function launched(p: ReturnType<typeof pylon>): Promise<void> {
  const herdr = (...args: string[]) => p.guest.exec(["herdr", "--session", "nexus", ...args], { cwd: "/home/user", timeoutMs: 1 });
  await herdr("workspace", "create", "--cwd", "/home/user/workspace/repo", "--label", "Fix the login page", "--no-focus");
  await herdr("agent", "start", "nx-1", "--kind", "claude", "--pane", "w1:p1", "--timeout", "1", "--", "--session-id", worker);
}

/** A pause, then a wake whose relaunch a message reaches at once, through the probe's lock as a send-claude command takes it. */
async function wakeWithMessage(p: ReturnType<typeof pylon>, text: string) {
  await recordBeforePause(p.guest, quiet);
  p.pause();
  const [outcomes, sent] = await Promise.all([
    relaunchAfterWake(pylonId, p.guest, quiet),
    onePerClaudeSession(pylonId, [worker], () => sendToClaude(p.guest, { session: worker, text })),
  ]);
  return { outcomes, sent };
}

test("every wake brings the worker back in its own pane, though a message reaches it while the wake relaunches it", async () => {
  const p = pylon();
  await launched(p);
  for (const wake of [1, 2, 3]) {
    const { sent } = await wakeWithMessage(p, `wake ${wake}`);
    assert.deepEqual(p.running(worker), ["w1:p1"], `after wake ${wake}, one Claude runs the worker's session`);
    assert.equal(sent.herdrPane, "w1:p1", `the message of wake ${wake} went to it`);
  }
  assert.deepEqual(p.workspaces(), ["Fix the login page"]);
});

test("a wake whose Herdr restored nothing opens the worker once, whichever of the relaunch and a message comes first", async () => {
  const p = pylon(false);
  await launched(p);
  for (const wake of [1, 2]) {
    const { sent } = await wakeWithMessage(p, `wake ${wake}`);
    const running = p.running(worker);
    assert.equal(running.length, 1, `after wake ${wake}, one Claude runs the worker's session, not ${running.length}`);
    assert.equal(sent.herdrPane, running[0], "and the message went to it");
  }
});

test("a pylon whose earlier wakes left the worker in several panes comes back with one, in the first", async () => {
  const p = pylon();
  await launched(p);
  const herdr = (...args: string[]) => p.guest.exec(["herdr", "--session", "nexus", ...args], { cwd: "/home/user", timeoutMs: 1 });
  for (const w of ["w2", "w3"]) {
    await herdr("workspace", "create", "--cwd", "/home/user/workspace/repo", "--label", "Claude Code", "--no-focus");
    await herdr("agent", "start", "nx-2", "--kind", "claude", "--pane", `${w}:p1`, "--timeout", "1", "--", "--resume", worker);
  }
  await recordBeforePause(p.guest, quiet);
  p.pause();
  const { lines, log } = logged();
  await relaunchAfterWake(pylonId, p.guest, log);
  assert.deepEqual(p.running(worker), ["w1:p1"]);
  assert.deepEqual(p.workspaces(), ["Fix the login page"], "the other panes are closed");
  assert.deepEqual(lines, [
    'sessions: relaunched "Fix the login page" (claude-code) in w1:p1',
    `sessions: dropped "Claude Code" (claude-code), a second record of Claude Code session ${worker}, and closed its pane w2:p1`,
    `sessions: dropped "Claude Code" (claude-code), a second record of Claude Code session ${worker}, and closed its pane w3:p1`,
  ]);
  const file = JSON.parse(p.guest.written.findLast((f) => f.path === sessionsFile)!.content);
  assert.deepEqual(file.sessions.map((r: SessionRecord) => r.herdrPane), ["w1:p1"], "the next pause records one");
  assert.deepEqual(file.failed, []);
});
