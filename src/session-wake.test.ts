import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGuest, herdrError, herdrOk, herdrPane, herdrSnapshot, type ExecReply } from "./fake-guest.ts";
import { recordBeforePause, relaunchAfterWake } from "./session-wake.ts";
import { sessionsFile, type SessionRecord } from "./sessions.ts";

function logged() {
  const lines: string[] = [];
  return { lines, log: async (line: string) => { lines.push(line); } };
}

/** A guest whose sessions file holds `records`, whose Herdr answers from `herdr`, and whose other execs from `other`. */
function withRecords(records: readonly SessionRecord[], herdr: (sub: string, argv: readonly string[]) => ExecReply, other?: (argv: readonly string[]) => ExecReply) {
  return fakeGuest((argv, isHerdr) => {
    if (isHerdr) return herdr(argv.slice(0, 2).join(" "), argv);
    if (argv.at(-1) !== sessionsFile && other) return other(argv);
    assert.equal(argv.at(-1), sessionsFile);
    return { exitCode: 0, output: JSON.stringify({ version: 1, recordedAt: "2027-01-01T00:00:00Z", sessions: records, failed: [] }) };
  });
}

const shell: SessionRecord = { herdrPane: "w1:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null };
const broken: SessionRecord = { herdrPane: "w2:p1", harness: "shell", title: "broken", cwd: "/gone", harnessSessionId: null };

test("a wake logs each session's outcome, and one that does not come back fails neither the others nor the wake", async () => {
  const guest = withRecords([shell, broken], (sub, argv) => {
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "sh" }], [herdrPane("w1:p1", "w1", null, "unknown", null, "/home/user")]));
    if (sub === "workspace create") return herdrError("invalid_params", `no such directory ${argv[3]}`);
    throw new Error(`unscripted ${sub}`);
  });
  const { lines, log } = logged();
  const outcomes = await relaunchAfterWake(guest, log);
  assert.deepEqual(outcomes.map((o) => o.result), ["present", "failed"]);
  assert.deepEqual(lines, [
    'sessions: "sh" (shell) was already running in w1:p1',
    'sessions: "broken" (shell) did not come back: herdr workspace create: no such directory /gone',
  ]);
  const file = JSON.parse(guest.written.at(-1)!.content);
  assert.deepEqual(file.failed.map((f: { record: SessionRecord }) => f.record.title), ["broken"], "the sessions file keeps it for the next wake");
});

test("a wake whose Herdr server never answers logs it and still succeeds", async () => {
  const guest = withRecords([shell], (sub) => {
    if (sub === "workspace list") return herdrError("server_not_running");
    throw new Error(`unscripted ${sub}`);
  }, () => ({ exitCode: 127, output: "tini: not found" })); // the detached server start
  const { lines, log } = logged();
  assert.deepEqual(await relaunchAfterWake(guest, log), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^sessions: the relaunch failed, and the sessions file keeps every session for the next wake: starting the Herdr server failed with exit 127: tini: not found$/);
  assert.deepEqual(guest.written, [], "the sessions file is left as it was");
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
