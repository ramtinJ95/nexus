import { seedClaudeState } from "./claude-state.ts";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { attachedTerminals, attachScript, claudeTextProblem, focusScript, closeSession, dropFailedSession, interruptClaude, openSession, pausedSessionsIn, recordSessions, relaunchSessions, sendToClaude, sessionFacts, sessionsFile, type RelaunchOutcome, type SessionRecord } from "./sessions.ts";
import { fakeGuest, herdrError, herdrOk, herdrPane, herdrSnapshot, sessionsFileReply, type ExecReply, type FakeGuest } from "./fake-guest.ts";

const created = (workspace: string, pane: string) => herdrOk({ type: "workspace_created", workspace: { workspace_id: workspace, label: "x" }, tab: { tab_id: `${workspace}:t1` }, root_pane: { pane_id: pane } });
const agentStarted = herdrOk({ type: "agent_started", agent: {}, argv: [] });
/** `herdr pane process-info`: the pane's shell, plus whatever runs in its foreground, keyed by pane. */
const processInfo = (foreground: Record<string, readonly string[]>) => (argv: readonly string[]) => {
  const pane = argv[3]!;
  const fg = foreground[pane] ?? ["-bash"];
  return herdrOk({ type: "pane_process_info", process_info: { pane_id: pane, shell_pid: 100, foreground_processes: [{ pid: fg[0] === "-bash" ? 100 : 101, name: fg[0]!, argv: fg }] } });
};

/** The guest's answer to "does Claude Code have a transcript for this ID", or undefined for any other exec. */
const transcriptLookup = (argv: readonly string[], exists: boolean): ExecReply | undefined =>
  argv[0] === "sh" && argv.at(-1) === "/home/user/.claude/projects" ? { exitCode: exists ? 0 : 1, output: "" } : undefined;

/** A Herdr server that is up, with `overrides` keyed by subcommand such as "agent start". Claude Code transcripts exist unless `transcripts` is false. */
function herdrUp(overrides: Record<string, (argv: readonly string[]) => ExecReply> = {}, transcripts = true) {
  return fakeGuest((argv, herdr) => {
    if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
    if (!herdr && argv.at(-1) === sessionsFile) return { exitCode: 3, output: "" };
    if (!herdr) return transcriptLookup(argv, transcripts) ?? assert.fail(`unexpected exec ${argv.join(" ")}`);
    const sub = argv.slice(0, 2).join(" ");
    const override = overrides[sub];
    if (override) return override(argv);
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "workspace create") return created("w1", "w1:p1");
    if (sub === "agent start") return agentStarted;
    if (sub === "workspace close") return herdrOk({ type: "ok" });
    if (sub === "pane process-info") return processInfo({})(argv);
    if (sub === "pane read") return { exitCode: 0, output: "user@pylon:~$ \n" };
    throw new Error(`unscripted herdr ${argv.join(" ")}`);
  });
}

test("a Claude Code session opens in its own workspace in the checkout and resumes the given session", async () => {
  const guest = herdrUp();
  const pane = await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", resume: "bd2c2d6b" });
  assert.equal(pane, "w1:p1");
  const [create, start] = guest.execs.filter((a) => (a[3] === "workspace" && a[4] === "create") || a[3] === "agent");
  assert.deepEqual(create, ["herdr", "--session", "nexus", "workspace", "create", "--cwd", "/home/user/workspace/repo", "--label", "review", "--no-focus"]);
  assert.ok(start, "an agent start ran");
  assert.deepEqual(start.slice(3, 5), ["agent", "start"]);
  assert.match(start[5]!, /^[a-z][a-z0-9_-]{0,31}$/, "the agent name is one Herdr accepts");
  assert.deepEqual(start.slice(6), ["--kind", "claude", "--pane", "w1:p1", "--timeout", "30000", "--", "--resume", "bd2c2d6b", "--permission-mode", "bypassPermissions"]);
});

test("a pi session resumes from its session file, and a shell starts no agent", async () => {
  const pi = herdrUp();
  await openSession(pi, { harness: "pi", title: "plan", cwd: "/home/user", resume: "/home/user/.pi/agent/sessions/s.jsonl" });
  const start = pi.execs.find((a) => a[3] === "agent")!;
  assert.deepEqual(start.slice(6), ["--kind", "pi", "--pane", "w1:p1", "--timeout", "30000", "--", "--session", "/home/user/.pi/agent/sessions/s.jsonl"]);

  const shell = herdrUp();
  assert.equal(await openSession(shell, { harness: "shell", title: "sh", cwd: "/home/user" }), "w1:p1");
  assert.deepEqual(shell.herdrCalls(), ["workspace list", "workspace create"]);
});

test("a Claude Code session never prompted has no transcript, so it starts fresh under the same ID", async () => {
  const guest = herdrUp({}, false);
  await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user", resume: "d778fc1b" });
  const lookup = guest.execs.find((a) => a[0] === "sh")!;
  assert.deepEqual(lookup.slice(3), ["d778fc1b", "/home/user/.claude/projects"], "the guest looks for that ID's transcript under every project");
  assert.deepEqual(guest.execs.find((a) => a[3] === "agent")!.slice(-4), ["--session-id", "d778fc1b", "--permission-mode", "bypassPermissions"]);
});

test("a fresh Claude Code session starts under an ID of its own, and a fresh pi or resumed session gets no extra arguments", async () => {
  const claude = herdrUp();
  await openSession(claude, { harness: "claude-code", title: "review", cwd: "/home/user" });
  const start = claude.execs.find((a) => a[3] === "agent")!;
  assert.deepEqual(start.slice(-5, -3), ["--", "--session-id"]);
  assert.match(start.at(-3)!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const again = herdrUp();
  await openSession(again, { harness: "claude-code", title: "review", cwd: "/home/user" });
  assert.notEqual(again.execs.find((a) => a[3] === "agent")!.at(-3), start.at(-3), "each start names a new ID");

  const pi = herdrUp();
  await openSession(pi, { harness: "pi", title: "plan", cwd: "/home/user" });
  assert.deepEqual(pi.execs.find((a) => a[3] === "agent")!.slice(6), ["--kind", "pi", "--pane", "w1:p1", "--timeout", "30000"]);
});

test("a harness that fails to start rolls its workspace back, and the failure shows the pane's screen", async () => {
  const guest = herdrUp({
    "agent start": () => herdrError("timeout", "timed out waiting for agent"),
    "pane read": () => ({ exitCode: 0, output: "No conversation found with session ID: d778fc1b\nuser@pylon:~$ \n" }),
  });
  await assert.rejects(openSession(guest, { harness: "claude-code", title: "t", cwd: "/home/user" }), /timed out waiting for agent.*No conversation found with session ID: d778fc1b/s);
  const close = guest.execs.at(-1)!;
  assert.deepEqual(close.slice(3), ["workspace", "close", "w1"]);
});

test("a failed rollback is reported with the start failure", async () => {
  const guest = herdrUp({ "agent start": () => herdrError("timeout", "no agent"), "workspace close": () => herdrError("workspace_not_found", "gone") });
  await assert.rejects(openSession(guest, { harness: "pi", title: "t", cwd: "/home/user" }), /no agent.*rolling back workspace w1 also failed.*gone/s);
});

test("an agent blocked at startup, such as on a trust question, keeps its session open", async () => {
  const guest = herdrUp({ "agent start": () => herdrError("agent_not_ready", "agent is blocked") });
  assert.equal(await openSession(guest, { harness: "claude-code", title: "t", cwd: "/home/user" }), "w1:p1");
  assert.ok(!guest.herdrCalls().includes("workspace close"));
});

test("a pane whose shell is still starting is retried until the agent starts", async () => {
  let busy = 2;
  const guest = herdrUp({ "agent start": () => busy-- > 0 ? herdrError("agent_pane_busy") : agentStarted });
  assert.equal(await openSession(guest, { harness: "pi", title: "t", cwd: "/home/user" }), "w1:p1");
  assert.equal(guest.herdrCalls().filter((c) => c === "agent start").length, 3);
});

test("only a Claude Code start seeds Claude's state, and pi or a shell seeds nothing", async () => {
  for (const [harness, seeds] of [["claude-code", 1], ["pi", 0], ["shell", 0]] as const) {
    const guest = herdrUp();
    await openSession(guest, { harness, title: "t", cwd: "/home/user" });
    assert.equal(guest.execs.filter((a) => a[2] === seedClaudeState).length, seeds, harness);
  }
});

test("a start Herdr fails keeps a Claude Code pane that runs Claude, but rolls back a pi pane even though it runs pi", async () => {
  const failing = (agent: readonly string[]) => herdrUp({ "agent start": () => herdrError("timeout", "timed out waiting for agent"), "pane process-info": processInfo({ "w1:p1": agent }) });
  const claude = failing(["claude", "--session-id", "bd2c2d6b"]);
  assert.equal(await openSession(claude, { harness: "claude-code", title: "t", cwd: "/home/user" }), "w1:p1");
  assert.ok(!claude.herdrCalls().includes("workspace close"), "the running Claude keeps its pane");

  const pi = failing(["pi"]);
  await assert.rejects(openSession(pi, { harness: "pi", title: "t", cwd: "/home/user" }), /timed out waiting for agent/);
  assert.deepEqual(pi.herdrCalls().filter((c) => c === "pane process-info" || c === "workspace close"), ["workspace close"], "pi's pane is not inspected before the rollback");
});

test("opening a session starts a detached Herdr server when none runs", async () => {
  let running = false;
  const guest = fakeGuest((argv, herdr) => {
    if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
    if (!herdr) {
      assert.deepEqual(argv, ["sh", "-c", "setsid -f tini -s -- herdr --session nexus server </dev/null >/dev/null 2>&1"]);
      running = true;
      return { exitCode: 0, output: "" };
    }
    if (!running) return herdrError("server_not_running");
    if (argv[0] === "workspace" && argv[1] === "list") return herdrOk({ type: "workspace_list", workspaces: [] });
    return created("w1", "w1:p1");
  });
  assert.equal(await openSession(guest, { harness: "shell", title: "sh", cwd: "/home/user" }), "w1:p1");
  assert.deepEqual(guest.herdrCalls(), ["workspace list", "workspace list", "workspace create"]);
});

test("closing a pane that is gone, or with no server, closes nothing and says so; other errors reject", async () => {
  assert.equal(await closeSession(herdrUp({ "pane close": () => herdrError("pane_not_found") }), "w1:p1"), "not-open");
  assert.equal(await closeSession(herdrUp({ "pane close": () => herdrError("server_not_running") }), "w1:p1"), "not-open");
  const closed = herdrUp({ "pane close": () => herdrOk({ type: "ok" }) });
  assert.equal(await closeSession(closed, "w2:p1"), "closed");
  assert.deepEqual(closed.execs[0]!.slice(3), ["pane", "close", "w2:p1"]);
  await assert.rejects(closeSession(herdrUp({ "pane close": () => herdrError("invalid_params", "bad pane") }), "x"), /bad pane/);
});

const liveSnapshot = herdrSnapshot(
  [{ id: "w1", label: "review" }, { id: "w2", label: "plan" }, { id: "w3", label: "sh" }],
  [
    herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: "bd2c2d6b" }),
    herdrPane("w2:p1", "w2", "pi", "blocked", { kind: "path", value: "/home/user/.pi/agent/sessions/s.jsonl" }, "/home/user/app"),
    herdrPane("w3:p1", "w3", null, "unknown"),
    herdrPane("w3:p2", "w3", "codex", "idle", { kind: "id", value: "codex-1" }),
  ],
);

test("session facts map Herdr panes to harnesses, session IDs, statuses and their workspace titles", async () => {
  const facts = await sessionFacts(herdrUp({ "api snapshot": () => herdrOk(liveSnapshot) }));
  assert.deepEqual(facts, [
    { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "bd2c2d6b", status: "working", title: "review" },
    { id: "w2:p1", state: "running", herdrPane: "w2:p1", harness: "pi", harnessSessionId: "/home/user/.pi/agent/sessions/s.jsonl", status: "blocked", title: "plan" },
    { id: "w3:p1", state: "running", herdrPane: "w3:p1", harness: "shell", harnessSessionId: null, status: "unknown", title: "sh" },
    { id: "w3:p2", state: "running", herdrPane: "w3:p2", harness: "shell", harnessSessionId: null, status: "idle", title: "sh" },
  ]);
});

test("no Herdr server means no sessions, but an unreadable Herdr rejects", async () => {
  assert.deepEqual(await sessionFacts(herdrUp({ "api snapshot": () => herdrError("server_not_running") })), []);
  await assert.rejects(sessionFacts(herdrUp({ "api snapshot": () => ({ exitCode: null, output: "" }) })), /did not finish/);
  await assert.rejects(sessionFacts(herdrUp({ "api snapshot": () => ({ exitCode: 127, output: "sh: herdr: not found" }) })), /without a JSON reply/);
});

test("recording writes every open session to the sessions file", async () => {
  const guest = herdrUp({ "api snapshot": () => herdrOk(liveSnapshot) });
  const records = await recordSessions(guest);
  assert.equal(guest.written.length, 1);
  const file = guest.written[0]!;
  assert.equal(file.path, sessionsFile);
  assert.equal(file.owner, "user");
  const content = JSON.parse(file.content);
  assert.equal(content.version, 1);
  assert.deepEqual(records, content.sessions.map((r: SessionRecord) => ({ ...r, id: r.herdrPane })), "each is reported under its pane");
  assert.deepEqual(content.sessions.slice(0, 3), [
    { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", harnessSessionId: "bd2c2d6b" },
    { herdrPane: "w2:p1", harness: "pi", title: "plan", cwd: "/home/user/app", harnessSessionId: "/home/user/.pi/agent/sessions/s.jsonl" },
    { herdrPane: "w3:p1", harness: "shell", title: "sh", cwd: "/home/user/workspace/repo", harnessSessionId: null },
  ]);
});

test("a Claude Code pane Herdr has no ID for, such as one logged in after its start, is recorded under the ID it was started with", async () => {
  const snapshot = herdrSnapshot(
    [{ id: "w1", label: "login" }, { id: "w2", label: "resumed" }, { id: "w3", label: "by hand" }, { id: "w4", label: "gone" }],
    [
      herdrPane("w1:p1", "w1", "claude", "blocked"),
      herdrPane("w2:p1", "w2", "claude", "idle"),
      herdrPane("w3:p1", "w3", "claude", "idle"),
      herdrPane("w4:p1", "w4", "claude", "idle"),
    ],
  );
  const guest = herdrUp({
    "api snapshot": () => herdrOk(snapshot),
    "pane process-info": (argv) => argv[3] === "w4:p1" ? herdrError("pane_not_found") : processInfo({
      "w1:p1": ["claude", "--session-id", "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90"],
      // An npm install runs Claude Code's script under node.
      "w2:p1": ["node", "/usr/local/bin/claude", "--resume", "bd2c2d6b"],
      "w3:p1": ["claude"],
    })(argv),
  });
  const records = await recordSessions(guest);
  assert.deepEqual(records!.map((r) => [r.title, r.harnessSessionId]), [
    ["login", "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90"],
    ["resumed", "bd2c2d6b"],
    ["by hand", null],
    ["gone", null],
  ]);
});

test("Herdr's own report of a Claude Code session wins over its command line, which a /clear outdates", async () => {
  const snapshot = herdrSnapshot([{ id: "w1", label: "review" }], [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: "after-clear" })]);
  const guest = herdrUp({ "api snapshot": () => herdrOk(snapshot) });
  assert.deepEqual((await recordSessions(guest))!.map((r) => r.harnessSessionId), ["after-clear"]);
  assert.equal(guest.herdrCalls().filter((c) => c === "pane process-info").length, 1, "only the explicit model is read from the command line");
});

test("recording reads the session ID and model back from one read of a Claude Code pane's command line, and never from a pi pane's", async () => {
  const snapshot = herdrSnapshot([{ id: "w1", label: "review" }, { id: "w2", label: "plan" }], [herdrPane("w1:p1", "w1", "claude", "idle"), herdrPane("w2:p1", "w2", "pi", "idle")]);
  const guest = herdrUp({
    "api snapshot": () => herdrOk(snapshot),
    "pane process-info": processInfo({ "w1:p1": ["claude", "--session-id", "bd2c2d6b", "--model", "opus"], "w2:p1": ["pi", "--session-id", "d778fc1b", "--model", "gpt"] }),
  });
  await recordSessions(guest);
  assert.deepEqual(JSON.parse(guest.written[0]!.content).sessions, [
    { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", model: "opus", harnessSessionId: "bd2c2d6b" },
    { herdrPane: "w2:p1", harness: "pi", title: "plan", cwd: "/home/user/workspace/repo", harnessSessionId: null },
  ]);
  assert.deepEqual(guest.execs.filter((a) => a[4] === "process-info").map((a) => a.at(-1)), ["w1:p1"], "Claude's pane is read once, and pi's never");
});

test("recording with no Herdr server leaves the last sessions file in place", async () => {
  const guest = herdrUp({ "api snapshot": () => herdrError("server_not_running") });
  assert.equal(await recordSessions(guest), null);
  assert.deepEqual(guest.written, []);
});

function withSessionsFile(records: readonly SessionRecord[] | null, herdr: (argv: readonly string[]) => ExecReply) {
  return fakeGuest((argv, isHerdr) => {
    if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
    if (isHerdr) return herdr(argv);
    const lookup = transcriptLookup(argv, true);
    if (lookup) return lookup;
    assert.equal(argv.at(-1), sessionsFile);
    return records === null ? { exitCode: 3, output: "" } : sessionsFileReply(records);
  });
}

test("relaunch opens only the recorded sessions that are not already live, into their prompt", async () => {
  const records: SessionRecord[] = [
    { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", harnessSessionId: "bd2c2d6b" }, // Herdr restored it under a new pane
    { herdrPane: "w3:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null }, // Herdr restored it in place
    { herdrPane: "w4:p1", harness: "pi", title: "plan", cwd: "/home/user/app", harnessSessionId: "/home/user/.pi/agent/sessions/old.jsonl" },
    { herdrPane: "w5:p1", harness: "shell", title: "broken", cwd: "/gone", harnessSessionId: null },
  ];
  const live = herdrSnapshot(
    [{ id: "w9", label: "review" }, { id: "w3", label: "sh" }],
    [herdrPane("w9:p1", "w9", "claude", "idle", { kind: "id", value: "bd2c2d6b" }), herdrPane("w3:p1", "w3", null, "unknown")],
  );
  const creates: string[][] = [];
  const guest = withSessionsFile(records, (argv) => {
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "api snapshot") return herdrOk(live);
    if (sub === "pane process-info") return processInfo({ "w9:p1": ["claude", "--resume", "bd2c2d6b"] })(argv);
    if (sub === "workspace create") {
      creates.push([...argv]);
      return argv.includes("/gone") ? herdrError("invalid_params", "no such directory") : created("w10", "w10:p1");
    }
    if (sub === "agent start") return agentStarted;
    throw new Error(`unscripted ${sub}`);
  });

  const outcomes = await relaunchSessions(guest);
  assert.deepEqual(outcomes.map((o) => [o.record.title, o.result, "herdrPane" in o ? o.herdrPane : null]), [
    ["review", "present", "w9:p1"],
    ["sh", "present", "w3:p1"],
    ["plan", "relaunched", "w10:p1"],
    ["broken", "failed", null],
  ]);
  assert.deepEqual(creates.map((a) => a.slice(2, 6)), [["--cwd", "/home/user/app", "--label", "plan"], ["--cwd", "/gone", "--label", "broken"]]);
  const start = guest.execs.find((a) => a[3] === "agent")!;
  assert.deepEqual(start.slice(6), ["--kind", "pi", "--pane", "w10:p1", "--timeout", "30000", "--", "--session", "/home/user/.pi/agent/sessions/old.jsonl"]);
});

test("a pylon that never paused has nothing to relaunch and starts no Herdr server", async () => {
  const guest = withSessionsFile(null, () => { throw new Error("no Herdr call expected"); });
  assert.deepEqual(await relaunchSessions(guest), []);
  assert.equal(guest.execs.length, 1);
});

test("a pane Herdr restored without its agent gets the agent started in place", async () => {
  const records: SessionRecord[] = [{ herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", harnessSessionId: "bd2c2d6b" }];
  const live = herdrSnapshot([{ id: "w1", label: "review" }], [herdrPane("w1:p1", "w1", null, "unknown")]);
  const guest = withSessionsFile(records, (argv) => {
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "api snapshot") return herdrOk(live);
    if (sub === "pane process-info") return processInfo({})(argv);
    if (sub === "agent start") return agentStarted;
    throw new Error(`unscripted ${sub}`);
  });
  assert.deepEqual((await relaunchSessions(guest)).map((o) => [o.result, "herdrPane" in o ? o.herdrPane : null]), [["relaunched", "w1:p1"]]);
  assert.deepEqual(guest.execs.find((a) => a[3] === "agent")!.slice(6), ["--kind", "claude", "--pane", "w1:p1", "--timeout", "30000", "--", "--resume", "bd2c2d6b", "--permission-mode", "bypassPermissions"]);
});

test("a Claude session whose pane cannot be inspected is neither started again nor closed in any of its panes", async () => {
  const records: SessionRecord[] = [
    { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", harnessSessionId: "bd2c2d6b" },
    { herdrPane: "w2:p1", harness: "claude-code", title: "Claude Code", cwd: "/home/user/workspace/repo", harnessSessionId: "bd2c2d6b" },
  ];
  const live = herdrSnapshot([{ id: "w1", label: "review" }, { id: "w2", label: "Claude Code" }], [
    herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: "bd2c2d6b" }),
    herdrPane("w2:p1", "w2", null, "unknown"),
  ]);
  const guest = withSessionsFile(records, (argv) => {
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "api snapshot") return herdrOk(live);
    if (sub === "pane process-info") return argv[3] === "w1:p1" ? herdrError("timeout", "process-info timed out") : processInfo({})(argv);
    throw new Error(`unscripted ${sub}`);
  });
  const outcomes = await relaunchSessions(guest);
  assert.deepEqual(outcomes.map((o) => [o.record.title, o.result, o.herdrPane]), [["review", "failed", "w1:p1"], ["Claude Code", "failed", "w2:p1"]]);
  assert.match(outcomes[0]!.result === "failed" ? outcomes[0]!.message : "", /whether w1:p1 still runs the session could not be read.*process-info timed out/);
  assert.deepEqual(guest.herdrCalls().filter((c) => c === "agent start" || c === "pane close" || c === "workspace close"), []);
});

test("a pane Herdr still reports as Claude, but that runs only its shell, gets Claude started in place", async () => {
  const records: SessionRecord[] = [{ herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "bd2c2d6b" }];
  const live = herdrSnapshot([{ id: "w1", label: "review" }], [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: "bd2c2d6b" })]);
  const guest = withSessionsFile(records, (argv) => {
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "api snapshot") return herdrOk(live);
    if (sub === "pane process-info") return processInfo({})(argv);
    if (sub === "agent start") return agentStarted;
    throw new Error(`unscripted ${sub}`);
  });
  assert.deepEqual((await relaunchSessions(guest)).map((o) => [o.result, "herdrPane" in o ? o.herdrPane : null]), [["relaunched", "w1:p1"]]);
  assert.deepEqual(guest.execs.find((a) => a[3] === "agent")!.slice(6), ["--kind", "claude", "--pane", "w1:p1", "--timeout", "30000", "--", "--resume", "bd2c2d6b", "--permission-mode", "bypassPermissions"]);
});

test("pi run by node counts as running from its script's name", async () => {
  const records: SessionRecord[] = [{ herdrPane: "w2:p1", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/home/user/.pi/agent/sessions/s.jsonl" }];
  const live = herdrSnapshot([{ id: "w2", label: "plan" }], [herdrPane("w2:p1", "w2", "pi", "idle", { kind: "path", value: "/home/user/.pi/agent/sessions/s.jsonl" })]);
  const guest = withSessionsFile(records, (argv) => {
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "api snapshot") return herdrOk(live);
    if (sub === "pane process-info") return processInfo({ "w2:p1": ["node", "/usr/local/bin/pi", "--session", "/home/user/.pi/agent/sessions/s.jsonl"] })(argv);
    throw new Error(`unscripted ${sub}`);
  });
  assert.deepEqual((await relaunchSessions(guest)).map((o) => o.result), ["present"]);
});

test("pi records of one session each come back in a pane of their own, and only Claude Code sessions are held while the relaunch runs", async () => {
  const records: SessionRecord[] = [
    { herdrPane: "w1:p1", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/home/user/.pi/agent/sessions/s.jsonl", model: "gpt" },
    { herdrPane: "w2:p1", harness: "pi", title: "plan again", cwd: "/home/user", harnessSessionId: "/home/user/.pi/agent/sessions/s.jsonl" },
    { herdrPane: "w3:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "bd2c2d6b", model: "opus" },
    { herdrPane: "w4:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ];
  const guest = pylon(records, []);
  const held: (readonly string[])[] = [];
  const outcomes = await relaunchSessions(guest, (sessions, work) => {
    held.push(sessions);
    return work();
  });
  assert.deepEqual(held, [["bd2c2d6b"]]);
  assert.deepEqual(placed(outcomes), [["plan", "relaunched", "w20:p1"], ["plan again", "relaunched", "w21:p1"], ["review", "relaunched", "w22:p1"], ["sh", "relaunched", "w23:p1"]]);
  assert.deepEqual(guest.execs.filter((a) => a[3] === "agent").map((a) => [a[a.indexOf("--kind") + 1], ...a.slice(a.indexOf("--") + 1)]), [
    ["pi", "--session", "/home/user/.pi/agent/sessions/s.jsonl"],
    ["pi", "--session", "/home/user/.pi/agent/sessions/s.jsonl"],
    ["claude", "--resume", "bd2c2d6b", "--model", "opus", "--permission-mode", "bypassPermissions"],
  ], "a recorded model reaches only Claude Code's launch");
});

interface FakePane { workspace: string; label: string; pane: string; cwd: string; argv: readonly string[]; agent: string | null; session: { kind: "id" | "path"; value: string } | null }

/**
 * A pylon whose Herdr and sessions file change as the calls under test act on them. A workspace create
 * adds a shell pane, an agent start runs the agent there and reports its session, a close removes panes,
 * and the sessions file reads back what was last written. `refuse` can fail an agent start.
 */
function pylon(records: readonly SessionRecord[], panes: FakePane[], refuse: (argv: readonly string[]) => ExecReply | undefined = () => undefined) {
  let next = 20;
  const flag = (argv: readonly string[], name: string) => argv[argv.indexOf(name) + 1]!;
  const guest = fakeGuest((argv, herdr) => {
    if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
    if (!herdr && argv.at(-1) === sessionsFile) {
      const last = guest.written.findLast((f) => f.path === sessionsFile)?.content;
      return last === undefined ? sessionsFileReply(records) : { exitCode: 0, output: last };
    }
    if (!herdr) return transcriptLookup(argv, true) ?? assert.fail(`unexpected exec ${argv.join(" ")}`);
    const sub = argv.slice(0, 2).join(" ");
    const pane = (id: string) => panes.find((p) => p.pane === id) ?? assert.fail(`no pane ${id}`);
    switch (sub) {
      case "workspace list": return herdrOk({ type: "workspace_list", workspaces: [] });
      case "api snapshot": return herdrOk(herdrSnapshot(
        panes.map((p) => ({ id: p.workspace, label: p.label })),
        panes.map((p) => herdrPane(p.pane, p.workspace, p.agent, p.agent === null ? "unknown" : "idle", p.session, p.cwd)),
      ));
      case "pane process-info": return processInfo({ [argv[3]!]: pane(argv[3]!).argv })(argv);
      case "workspace create": {
        const workspace = `w${next++}`;
        panes.push({ workspace, label: flag(argv, "--label"), pane: `${workspace}:p1`, cwd: flag(argv, "--cwd"), argv: ["-bash"], agent: null, session: null });
        return created(workspace, `${workspace}:p1`);
      }
      case "agent start": {
        const refused = refuse(argv);
        if (refused) return refused;
        const p = pane(flag(argv, "--pane"));
        const args = argv.slice(argv.indexOf("--") + 1);
        p.agent = flag(argv, "--kind");
        p.argv = [p.agent, ...args];
        p.session = { kind: args[0] === "--session" ? "path" : "id", value: args[1]! };
        return agentStarted;
      }
      case "workspace close":
        panes.splice(0, panes.length, ...panes.filter((p) => p.workspace !== argv[2]));
        return herdrOk({ type: "ok" });
      case "pane close":
        panes.splice(0, panes.length, ...panes.filter((p) => p.pane !== argv[2]));
        return herdrOk({ type: "ok" });
      case "pane read": return { exitCode: 0, output: "user@pylon:~$ \n" };
    }
    throw new Error(`unscripted herdr ${argv.join(" ")}`);
  });
  return guest;
}

const shellPane = (workspace: string, label: string, cwd: string): FakePane => ({ workspace, label, pane: `${workspace}:p1`, cwd, argv: ["-bash"], agent: null, session: null });
const claudePane = (workspace: string, label: string, id: string): FakePane =>
  ({ workspace, label, pane: `${workspace}:p1`, cwd: "/home/user", argv: ["claude", "--resume", id], agent: "claude", session: { kind: "id", value: id } });
const placed = (outcomes: readonly RelaunchOutcome[]) => outcomes.map((o) => [o.record.title, o.result, "herdrPane" in o ? o.herdrPane : null]);

test("relaunching twice opens nothing new, and sessions that share a title keep their own panes", async () => {
  const records: SessionRecord[] = [
    { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" },
    { herdrPane: "w2:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "bbbb" },
    { herdrPane: "w3:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ];
  const guest = pylon(records, [claudePane("w7", "review", "bbbb")]);
  assert.deepEqual(placed(await relaunchSessions(guest)), [["review", "relaunched", "w20:p1"], ["review", "present", "w7:p1"], ["sh", "relaunched", "w21:p1"]]);
  assert.deepEqual(placed(await relaunchSessions(guest)), [["review", "present", "w20:p1"], ["review", "present", "w7:p1"], ["sh", "present", "w21:p1"]]);
  assert.equal(guest.herdrCalls().filter((c) => c === "workspace create").length, 2);
});

test("an agent reporting another session is not the recorded one, even under the same title", async () => {
  const records: SessionRecord[] = [{ herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" }];
  const guest = pylon(records, [claudePane("w5", "review", "bbbb")]);
  assert.deepEqual(placed(await relaunchSessions(guest)), [["review", "relaunched", "w20:p1"]]);
  assert.deepEqual(guest.execs.find((a) => a[3] === "agent")!.slice(6, 10), ["--kind", "claude", "--pane", "w20:p1"]);
});

test("shells that share a title are told apart by their cwd", async () => {
  const records: SessionRecord[] = [
    { herdrPane: "w1:p1", harness: "shell", title: "sh", cwd: "/a", harnessSessionId: null },
    { herdrPane: "w2:p1", harness: "shell", title: "sh", cwd: "/b", harnessSessionId: null },
  ];
  // An earlier relaunch brought back /b under a new pane, and /a failed.
  const guest = pylon(records, [shellPane("w8", "sh", "/b")]);
  assert.deepEqual(placed(await relaunchSessions(guest)), [["sh", "relaunched", "w20:p1"], ["sh", "present", "w8:p1"]]);
  assert.deepEqual(guest.execs.filter((a) => a[4] === "create").map((a) => a[6]), ["/a"]);
});

test("a session whose relaunch failed is recorded until a relaunch brings it back", async () => {
  const records: SessionRecord[] = [
    { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" },
    { herdrPane: "w2:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ];
  let refusing = true;
  const guest = pylon(records, [], () => refusing ? herdrError("timeout", "the agent did not start") : undefined);
  assert.deepEqual(placed(await relaunchSessions(guest)), [["review", "failed", null], ["sh", "relaunched", "w21:p1"]]);
  const recorded = (await recordSessions(guest))!;
  // With no pane, it is named by a hash of its record, which a later Herdr pane cannot share.
  const id = recorded[1]!.id;
  assert.match(id, /^failed-[0-9a-f]{12}$/);
  assert.deepEqual(recorded, [
    { id: "w21:p1", herdrPane: "w21:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
    { ...records[0], id, herdrPane: null },
  ]);
  assert.deepEqual(pausedSessionsIn(guest.written.at(-1)!.content), recorded.map(({ cwd: _, ...s }) => s), "the file it wrote says the same, as a stopped disk's does");
  assert.deepEqual((await sessionFacts(guest)).at(-1), {
    id, state: "failed", herdrPane: null, harness: "claude-code", harnessSessionId: "aaaa", status: "unknown", title: "review", message: "herdr agent start: the agent did not start. The pane showed:\nuser@pylon:~$",
  }, "a running pylon reports it, under the ID its pause records it by, with the status a control plane older than session states stores");
  assert.equal((await recordSessions(guest))![1]!.id, id, "the ID holds from one record to the next");
  refusing = false;
  assert.deepEqual(placed(await relaunchSessions(guest)), [["sh", "present", "w21:p1"], ["review", "relaunched", "w22:p1"]]);
  assert.deepEqual((await recordSessions(guest))!.map((r) => r.herdrPane), ["w21:p1", "w22:p1"]);
  assert.deepEqual(JSON.parse(guest.written.at(-1)!.content).failed, []);
});

test("a failure left in its restored pane stands for that pane until the pane is closed", async () => {
  const records: SessionRecord[] = [{ herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" }];
  const guest = pylon(records, [shellPane("w1", "review", "/home/user")], () => herdrError("timeout", "the agent did not start"));
  assert.deepEqual(placed(await relaunchSessions(guest)), [["review", "failed", "w1:p1"]]);
  // Recorded and reported as the Claude it should be, not as the shell it is.
  assert.deepEqual(await recordSessions(guest), [{ ...records[0], id: "w1:p1" }]);
  assert.deepEqual((await sessionFacts(guest)).map((f) => [f.id, f.state, f.herdrPane, f.harness, f.status]), [["w1:p1", "failed", "w1:p1", "claude-code", "unknown"]], "with its pane's status");
  assert.equal(await closeSession(guest, "w1:p1", { harness: "claude-code", harnessSessionId: "aaaa", title: "review" }), "closed", "it is the session the failed record names");
  assert.deepEqual(await recordSessions(guest), []);
  assert.deepEqual(await sessionFacts(guest), []);
});

test("a close that names its session leaves a pane that runs another one open, such as one a wake gave that pane", async () => {
  const guest = pylon([], [claudePane("w1", "review", "bbbb"), shellPane("w2", "sh", "/home/user")]);
  const review = { harness: "claude-code", harnessSessionId: "aaaa", title: "review" } as const;
  assert.equal(await closeSession(guest, "w1:p1", review), "moved");
  assert.equal(await closeSession(guest, "w1:p1", { ...review, harness: "pi", harnessSessionId: "bbbb" }), "moved");
  assert.equal(await closeSession(guest, "w1:p1", { ...review, harnessSessionId: "bbbb", title: "plan" }), "moved");
  assert.equal(await closeSession(guest, "w9:p1", review), "not-open");
  assert.deepEqual(guest.herdrCalls().filter((c) => c === "pane close"), [], "nothing was closed");
  // What either side has not learned yet does not tell them apart.
  assert.equal(await closeSession(guest, "w2:p1", { harness: "shell", harnessSessionId: null, title: null }), "closed");
  assert.equal(await closeSession(guest, "w1:p1", { ...review, harnessSessionId: null }), "closed");
});

test("dropping a failed session in no pane removes it from the sessions file, so no wake tries it again", async () => {
  const records: SessionRecord[] = [{ herdrPane: "w1:p1", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/s.jsonl" }];
  const guest = pylon(records, [], () => herdrError("timeout", "the agent did not start"));
  assert.deepEqual(placed(await relaunchSessions(guest)), [["plan", "failed", null]]);
  const [failed] = await sessionFacts(guest);
  assert.ok(failed?.state === "failed");
  assert.equal(await dropFailedSession(guest, "w1:p1"), false, "a pane ID does not name it");
  assert.equal(await dropFailedSession(guest, failed.id), true);
  assert.deepEqual(JSON.parse(guest.written.at(-1)!.content).failed, []);
  assert.deepEqual(await sessionFacts(guest), []);
  assert.deepEqual(await relaunchSessions(guest), []);
  assert.equal(await dropFailedSession(guest, failed.id), false, "dropping it again finds nothing");
});

test("attached terminals are the guest's Herdr clients of the session, and a guest that cannot be counted rejects", async () => {
  const counting = (reply: ExecReply) => fakeGuest((argv, herdr) => {
    if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
    assert.ok(!herdr);
    assert.deepEqual(argv, ["pgrep", "-c", "-x", "-f", "herdr --session nexus"], "a client's whole command line, so the server and Herdr's own subcommands are left out");
    return reply;
  });
  assert.equal(await attachedTerminals(counting({ exitCode: 0, output: "2\n" })), 2);
  assert.equal(await attachedTerminals(counting({ exitCode: 1, output: "0\n" })), 0);
  await assert.rejects(attachedTerminals(counting({ exitCode: 127, output: "sh: pgrep: not found" })), /pgrep exited 127: sh: pgrep: not found/);
  await assert.rejects(attachedTerminals(counting({ exitCode: null, output: "" })), /pgrep exited null/);
});

test("an attached terminal is a client with exactly the command line attachedTerminals counts, after a server like a session open's", () => {
  assert.match(attachScript, /exec herdr --session nexus$/);
  assert.ok(attachScript.includes("setsid -f tini -s -- herdr --session nexus server </dev/null >/dev/null 2>&1"));
});

test("an attached terminal lands in the pane it names, as a focus does: an agent's by the agent, any other by its tab, and a closed one nowhere", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-attach-"));
  try {
    // A Herdr whose server runs, with an agent in w1:p1, a shell in w2:p1, and no other pane.
    writeFileSync(join(dir, "herdr"), `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  "--session nexus agent focus w1:p1"|"--session nexus workspace list"|"--session nexus tab focus w2:t1") exit 0 ;;
  "--session nexus pane get w2:p1") echo '{"result":{"pane":{"pane_id":"w2:p1","tab_id":"w2:t1","workspace_id":"w2"}}}' ;;
  "--session nexus") exit 0 ;;
  *) echo '{"error":{"code":"not_found"}}'; exit 1 ;;
esac
`, { mode: 0o755 });
    const attach = (pane: string) => {
      rmSync(join(dir, "calls"), { force: true });
      const run = spawnSync("sh", ["-c", attachScript, "attach", pane], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      return readFileSync(join(dir, "calls"), "utf8").trim().split("\n").slice(1);
    };
    assert.deepEqual(attach("w1:p1"), ["--session nexus agent focus w1:p1", "--session nexus"]);
    assert.deepEqual(attach("w2:p1"), ["--session nexus agent focus w2:p1", "--session nexus pane get w2:p1", "--session nexus tab focus w2:t1", "--session nexus"]);
    assert.deepEqual(attach("w9:p1"), ["--session nexus agent focus w9:p1", "--session nexus pane get w9:p1", "--session nexus"]);
    assert.deepEqual(attach(""), ["--session nexus"]);
    const focus = (pane: string) => spawnSync("sh", ["-c", focusScript, "focus", pane], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).status;
    assert.deepEqual(["w1:p1", "w2:p1", "w9:p1"].map(focus), [0, 0, 1], "a focus says whether the pane is open");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A pylon for prompted Claude launches: Herdr workspaces whose root pane runs a shell until a typed `claude` command
 * starts Claude there, the launch's files in ~/.nexus, and the transcripts Claude has written. Typing `claude` starts
 * it under the command's session ID, working, unless `starts` is false, and its UserPromptSubmit hook writes the
 * receipt unless `submits` is false. `probe()` is one probe's view of the guest. `diesAt` ends that probe at the first exec it matches, after the
 * exec ran in the guest when `ran` is true, as a guest exec runs to its end after the probe that started it exits. With
 * `ran: "held"` the exec runs only on `release()`, as one the guest started late. The dead probe's later execs never
 * reach the guest. The exec that types the launch claims it as the real one does, so a second claim types nothing.
 */
function launchPylon(options: { shellReady?: boolean; starts?: boolean; submits?: boolean; typeReply?: ExecReply; screen?: string; transcripts?: readonly string[] } = {}) {
  const files = new Map<string, string>();
  const panes = new Map<string, { workspace: string; label: string; foreground: readonly string[] }>();
  const execs: (readonly string[])[] = [];
  const held: (() => ExecReply)[] = [];
  let workspaces = 0;
  let typed = 0;
  const words = (line: string) => [...line.matchAll(/\$'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!.replace(/\\x([0-9a-f]{2})|\\(.)/g, (_, hex: string | undefined, c: string) => hex ? String.fromCharCode(parseInt(hex, 16)) : c));
  function herdrCall(argv: readonly string[]): ExecReply {
    const sub = argv.slice(0, 2).join(" ");
    const pane = (id: string) => panes.get(id) ?? assert.fail(`no pane ${id}`);
    switch (sub) {
      case "workspace list": return herdrOk({ type: "workspace_list", workspaces: [] });
      case "workspace create": {
        const workspace = `w${++workspaces}`;
        panes.set(`${workspace}:p1`, { workspace, label: argv[argv.indexOf("--label") + 1]!, foreground: ["-bash"] });
        return created(workspace, `${workspace}:p1`);
      }
      case "workspace close":
        for (const [id, p] of panes) if (p.workspace === argv[2]) panes.delete(id);
        return herdrOk({ type: "ok" });
      case "api snapshot":
        return herdrOk(herdrSnapshot([...panes.values()].map((p) => ({ id: p.workspace, label: p.label })), [...panes].map(([id, p]) =>
          p.foreground[0] === "claude" ? herdrPane(id, p.workspace, "claude", "working") : herdrPane(id, p.workspace, null, "unknown"))));
      case "pane process-info": return processInfo(Object.fromEntries([...panes].map(([id, p]) => [id, p.foreground])))(argv);
      case "pane run": {
        const argvTyped = words(argv[3]!);
        typed++;
        if (argvTyped[0] !== "claude" || pane(argv[2]!).foreground[0] !== "-bash") return assert.fail(`typed ${argv[3]} into a pane running ${pane(argv[2]!).foreground[0]}`);
        if (options.starts !== false) panes.set(argv[2]!, { ...pane(argv[2]!), foreground: argvTyped });
        const hook = JSON.parse(argvTyped[argvTyped.indexOf("--settings") + 1]!).hooks.UserPromptSubmit[0].hooks[0].command as string;
        if (options.starts !== false && options.submits !== false) files.set(/touch (\S+)$/.exec(hook)![1]!, "");
        return options.typeReply ?? { exitCode: 0, output: "" };
      }
      case "pane read": return { exitCode: 0, output: `${options.screen ?? "user@pylon:~$ "}\n` };
    }
    throw new Error(`unscripted herdr ${argv.join(" ")}`);
  }
  function run(argv: readonly string[]): ExecReply {
    execs.push(argv);
    if (argv[0] === "herdr") return herdrCall(argv.slice(3));
    if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
    if (argv[3] === "shell-ready") return { exitCode: options.shellReady === false ? 1 : 0, output: "" };
    if (argv[3] === "claude-submitted") return { exitCode: files.has(argv[4]!) ? 0 : 1, output: "" };
    if (typedExec(argv)) {
      if (argv[2]!.startsWith("mkdir") && files.has(argv[3]!)) return { exitCode: 75, output: "" };
      files.set(argv[3]!, "");
      return herdrCall(argv.slice(7));
    }
    if (argv[3]?.startsWith("/home/user/.nexus/claude-launches/")) {
      const opened = files.get(`${argv[3]}/opened`);
      return { exitCode: 0, output: opened === undefined ? "" : opened + (files.has(`${argv[3]}/typed`) ? "typed\n" : "") };
    }
    const lookup = transcriptLookup(argv, (options.transcripts ?? []).includes(argv[3]!));
    return lookup ?? assert.fail(`unexpected exec ${argv.join(" ")}`);
  }
  return {
    files, panes, execs,
    typings: () => typed,
    release: () => held.splice(0).map((exec) => exec()),
    claudes: () => [...panes.values()].filter((p) => p.foreground[0] === "claude"),
    probe(diesAt?: { exec: (argv: readonly string[]) => boolean; ran: boolean | "held" }): FakeGuest {
      let dead = false;
      const guest = fakeGuest(() => assert.fail("unused"));
      return {
        ...guest,
        async exec(argv) {
          if (dead) throw new Error("socket hang up");
          if (diesAt?.exec(argv)) {
            dead = true;
            if (diesAt.ran === "held") held.push(() => run(argv));
            else if (diesAt.ran) run(argv);
            throw new Error("socket hang up");
          }
          return { truncated: false, ...run(argv) };
        },
        async writeFiles(written) {
          if (dead) throw new Error("socket hang up");
          for (const f of written) files.set(f.path, f.content);
        },
      };
    },
  };
}

const launched = "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30";
const prompted = { harness: "claude-code" as const, title: "worker", cwd: "/home/user/workspace/repo", resume: launched, prompt: "work" };
const typedExec = (argv: readonly string[]) => argv[0] === "sh" && argv[4] === "herdr" && argv.includes("run");

test("a worker's first prompt reaches Claude as one exact argument through the pane's interactive bash", async () => {
  const { execFileSync } = await import("node:child_process");
  const pylon = launchPylon();
  const prompt = "/poteto-mode fix \"quotes\" and 'single' and `ticks` and $(not-a-shell-command) $HOME !! \\n\nthen\ttest\r\n\n  ünïcode\n";
  await openSession(pylon.probe(), { harness: "claude-code", title: "worker", cwd: "/home/user/workspace/repo", prompt, model: "claude-opus-5-5" });
  assert.equal(pylon.execs.some((a) => a[3] === "agent"), false);
  const typedAt = pylon.execs.findIndex(typedExec);
  const readyAt = pylon.execs.findIndex((a) => a[3] === "shell-ready");
  assert.ok(readyAt !== -1 && readyAt < typedAt, "the launch is typed only once the pane's shell is at its prompt");
  assert.deepEqual(pylon.execs[readyAt]!.slice(4), ["100"], "the wait watches the pane's shell");
  const command = pylon.execs[typedAt]!.at(-1)!;
  assert.doesNotMatch(command, /[\x00-\x1f\x7f]/, "nothing in the typed line is a key the terminal or readline acts on");
  const typed = `claude() { printf '%s\\0' "$@"; }\n${command}\n`;
  const argv = execFileSync("bash", ["--norc", "--noprofile", "-i"], { input: typed, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).split("\0").slice(0, -1);
  assert.deepEqual(argv.slice(0, 1), ["--session-id"]);
  assert.deepEqual(argv.slice(2, 7), ["--model", "claude-opus-5-5", "--permission-mode", "bypassPermissions", "--settings"]);
  const launch = `/home/user/.nexus/claude-launches/${argv[1]}`;
  assert.equal(JSON.parse(argv[7]!).hooks.UserPromptSubmit[0].hooks[0].command, `mkdir -p ${launch} && touch ${launch}/submitted`);
  assert.equal(argv[8], prompt);
  assert.equal(argv.length, 9);
  assert.equal(pylon.execs[typedAt]![3], `${launch}/typed`, "the exec that types the launch claims it first");
  assert.equal(pylon.files.get(`${launch}/opened`), "w1 w1:p1\n");
});

test("a worker whose shell never reaches its prompt types nothing and rolls back with the pane's screen", async () => {
  const pylon = launchPylon({ shellReady: false, screen: "still sourcing .bashrc" });
  await assert.rejects(openSession(pylon.probe(), { ...prompted, prompt: "x".repeat(5000) }), /shell did not reach an idle prompt within 10 seconds.*still sourcing \.bashrc/s);
  assert.equal(pylon.typings(), 0);
  assert.equal(pylon.panes.size, 0, "the workspace was closed");
});

test("a worker without prompt submission stalls and leaves its visible pane for takeover", async () => {
  const pylon = launchPylon({ starts: false, screen: "Choose the text style" });
  await assert.rejects(openSession(pylon.probe(), prompted), /Claude launch stalled.*Choose the text style/s);
  assert.equal(pylon.panes.size, 1);
  assert.equal(pylon.typings(), 1);
});

test("an error typing the launch is uncertain, so its receipt starts the worker and the pane is never closed", async () => {
  const pylon = launchPylon({ typeReply: herdrError("timeout", "timed out") });
  assert.equal(await openSession(pylon.probe(), { ...prompted, model: "custom-model" }), "w1:p1");
  assert.equal(pylon.panes.size, 1);
  assert.equal(pylon.typings(), 1);
  assert.match(pylon.execs.find(typedExec)!.at(-1)!, / \$'--model' \$'custom-model' /);
});

test("a lost receipt with a running busy Claude also preserves the launch", async () => {
  const pylon = launchPylon({ submits: false, typeReply: herdrError("timeout", "timed out") });
  assert.equal(await openSession(pylon.probe(), prompted), "w1:p1");
  assert.equal(pylon.panes.size, 1);
});

test("a receipt read failure preserves the pane rather than rolling back uncertain work", async () => {
  const pylon = launchPylon({ submits: false });
  await assert.rejects(openSession(pylon.probe({ exec: (a) => a[3] === "claude-submitted", ran: false }), prompted), /Claude launch stalled/);
  assert.equal(pylon.panes.size, 1);
});

test("a launch whose probe died before typing is sent again into the same pane and typed once", async () => {
  const pylon = launchPylon();
  await assert.rejects(openSession(pylon.probe({ exec: (a) => a[3] === "shell-ready", ran: false }), prompted));
  assert.equal(pylon.typings(), 0);
  assert.equal(await openSession(pylon.probe(), prompted), "w1:p1");
  assert.equal(pylon.execs.filter((a) => a[4] === "create").length, 1, "the second launch took the first one's pane");
  assert.equal(pylon.typings(), 1);
  assert.deepEqual(pylon.claudes().map((p) => p.foreground.slice(0, 3)), [["claude", "--session-id", launched]]);
});

test("a launch whose probe died while typing is not typed again, and its receipt answers the second launch", async () => {
  const pylon = launchPylon();
  await assert.rejects(openSession(pylon.probe({ exec: typedExec, ran: true }), prompted));
  assert.equal(await openSession(pylon.probe(), prompted), "w1:p1");
  assert.equal(pylon.typings(), 1);
  assert.equal(pylon.claudes().length, 1);
});

test("a typing exec the dead probe's guest starts late types nothing once the second launch has typed", async () => {
  const pylon = launchPylon();
  await assert.rejects(openSession(pylon.probe({ exec: typedExec, ran: "held" }), prompted));
  assert.equal(await openSession(pylon.probe(), prompted), "w1:p1");
  assert.deepEqual(pylon.release(), [{ exitCode: 75, output: "" }]);
  assert.equal(pylon.typings(), 1);
  assert.equal(pylon.claudes().length, 1);
});

test("a typing exec the dead probe's guest starts late wins the claim from a second launch that has not typed yet", async () => {
  const pylon = launchPylon();
  await assert.rejects(openSession(pylon.probe({ exec: typedExec, ran: "held" }), prompted));
  const second = pylon.probe();
  const exec = second.exec;
  second.exec = async (argv, options) => {
    if (typedExec(argv)) pylon.release();
    return exec(argv, options);
  };
  assert.equal(await openSession(second, prompted), "w1:p1");
  assert.equal(pylon.typings(), 1);
  assert.equal(pylon.claudes().length, 1);
});

test("a launch whose probe died waiting for its receipt is not typed again", async () => {
  const pylon = launchPylon();
  await assert.rejects(openSession(pylon.probe({ exec: (a) => a[3] === "claude-submitted", ran: false }), prompted));
  assert.equal(await openSession(pylon.probe(), prompted), "w1:p1");
  assert.equal(pylon.typings(), 1);
  assert.equal(pylon.claudes().length, 1);
});

test("a launch typed before its probe died whose Claude is gone fails with the pane's screen and types nothing", async () => {
  const pylon = launchPylon({ submits: false, screen: "claude: command not found" });
  await assert.rejects(openSession(pylon.probe({ exec: typedExec, ran: true }), prompted));
  pylon.panes.set("w1:p1", { ...pylon.panes.get("w1:p1")!, foreground: ["-bash"] });
  await assert.rejects(openSession(pylon.probe(), prompted), /Claude launch stalled: no UserPromptSubmit within 30 seconds before the probe lost the launch.*command not found/s);
  assert.equal(pylon.typings(), 1);
  assert.equal(pylon.panes.size, 1, "the pane stays for the person");
});

test("a launch an older probe typed records nothing, and its running Claude answers the second launch", async () => {
  const pylon = launchPylon();
  pylon.panes.set("w1:p1", { workspace: "w1", label: "worker", foreground: ["claude", "--session-id", launched, "--permission-mode", "bypassPermissions"] });
  assert.equal(await openSession(pylon.probe(), prompted), "w1:p1");
  assert.equal(pylon.typings(), 0);
  assert.equal(pylon.execs.some((a) => a[4] === "create"), false);
});

test("a launch an older probe lost before typing starts Claude once, beside the shell it left", async () => {
  const pylon = launchPylon();
  pylon.panes.set("w9:p1", { workspace: "w9", label: "worker", foreground: ["-bash"] });
  assert.equal(await openSession(pylon.probe(), prompted), "w1:p1");
  assert.equal(pylon.typings(), 1);
  assert.equal(pylon.claudes().length, 1);
});

test("a launch whose session already has a transcript but no running Claude types nothing", async () => {
  const pylon = launchPylon({ transcripts: [launched] });
  await assert.rejects(openSession(pylon.probe(), prompted), /already has a transcript, so its first prompt went in/);
  assert.equal(pylon.typings(), 0);
  assert.equal(pylon.panes.size, 0);
});

test("Claude user state merges onboarding, trust and bypass acceptance without losing login or hooks", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const home = await realpath(await mkdtemp(join(tmpdir(), "nexus-claude-state-")));
  const checkout = join(home, "repo");
  await mkdir(checkout);
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"));
  const original = { oauthAccount: { accountUuid: "keep" }, projects: { [checkout]: { allowedTools: ["Read"] }, "/elsewhere": { hasTrustDialogAccepted: false } } };
  const settings = { theme: "light", model: "claude-sonnet-5-5", attribution: { commit: "old trailer", pr: "old footer", extra: "keep" }, hooks: { Stop: [{ hooks: [{ command: "keep" }] }] }, enabledPlugins: { pstack: true } };
  await writeFile(join(home, ".claude.json"), JSON.stringify(original));
  await writeFile(join(home, ".claude/settings.json"), JSON.stringify(settings));
  for (let i = 0; i < 2; i++) execFileSync("node", ["-e", seedClaudeState, checkout], { env: { ...process.env, HOME: home } });
  assert.deepEqual(JSON.parse(await readFile(join(home, ".claude.json"), "utf8")), { ...original, hasCompletedOnboarding: true, projects: { ...original.projects, [checkout]: { allowedTools: ["Read"], hasTrustDialogAccepted: true } } });
  assert.deepEqual(JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8")), { ...settings, model: "claude-opus-5-5", attribution: { commit: "", pr: "", extra: "keep" }, skipDangerousModePermissionPrompt: true });
});

test("Claude seeding remerges concurrent updates, preserves modes and writes nothing once seeded", async (t) => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { runInNewContext } = await import("node:vm");
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "nexus-claude-race-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const checkout = path.join(home, "repo");
  fs.mkdirSync(checkout);
  fs.mkdirSync(path.join(home, ".claude"));
  const file = path.join(home, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: "old" }));
  fs.chmodSync(file, 0o640);
  let interleaved = false;
  const run = (guestFs: unknown) => runInNewContext(seedClaudeState, {
    require: (name: string) => name === "node:fs" ? guestFs : path,
    process: { env: { HOME: home }, argv: ["node", checkout], pid: process.pid },
  });
  run({ ...fs, writeFileSync: (target: string, ...args: [data: string, options: { mode: number }]) => {
    fs.writeFileSync(target, ...args);
    if (target.startsWith(file + ".") && !interleaved) {
      interleaved = true;
      fs.writeFileSync(file, JSON.stringify({ oauthAccount: "new", mcpServers: { added: { command: "new-server" } } }));
    }
  } });
  assert.ok(interleaved);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(state.oauthAccount, "new");
  assert.deepEqual(state.mcpServers, { added: { command: "new-server" } });
  assert.equal(state.projects[checkout].hasTrustDialogAccepted, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  run({ ...fs, writeFileSync: () => assert.fail("already seeded state must not write"), renameSync: () => assert.fail("already seeded state must not rename") });
  let writes = 0;
  fs.writeFileSync(file, "{}");
  assert.throws(() => run({ ...fs, writeFileSync: (target: string, data: string, options: { mode: number }) => {
    fs.writeFileSync(target, data, options);
    fs.writeFileSync(file, JSON.stringify({ concurrentUpdate: ++writes }));
  } }), /kept changing/);
  assert.equal(writes, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { concurrentUpdate: 5 });
  assert.equal(fs.readdirSync(home).some((name) => name.endsWith(".tmp")), false);
});

test("Claude seeding refuses root and HOME, including aliases", async (t) => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "nexus-claude-trust-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.symlinkSync(home, path.join(home, "alias"));
  for (const checkout of ["/", home, path.join(home, "alias")]) {
    assert.throws(() => execFileSync("node", ["-e", seedClaudeState, checkout], { env: { ...process.env, HOME: home }, stdio: "pipe" }), /refusing to grant Claude trust/);
  }
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false);
});

test("resuming a pane at root or HOME seeds only the pylon checkout", async () => {
  for (const cwd of ["/", "/home/user"]) {
    const records: SessionRecord[] = [{ herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd, harnessSessionId: "bd2c2d6b" }];
    const guest = pylon(records, []);
    assert.equal((await relaunchSessions(guest))[0]!.result, "relaunched");
    assert.deepEqual(guest.execs.filter((argv) => argv[2] === seedClaudeState).map((argv) => argv[3]), ["/home/user/workspace/repo"]);
  }
});


test("an explicit Claude model is recorded and passed on checkpoint relaunch", async () => {
  const records: SessionRecord[] = [{ herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa", model: "custom-model" }];
  const guest = pylon(records, []);
  await relaunchSessions(guest);
  const start = guest.execs.find((a) => a[3] === "agent" && a[4] === "start")!;
  assert.equal(start[start.indexOf("--model") + 1], "custom-model");
  const recorded = await recordSessions(guest);
  assert.equal(recorded![0]!.model, "custom-model");
});

test("a stalled relaunch keeps its new pane attached to the failure across record and relaunch", async () => {
  const records: SessionRecord[] = [{ herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" }];
  const panes: FakePane[] = [];
  const guest = pylon(records, panes);
  const exec = guest.exec;
  let unavailable = true;
  guest.exec = async (argv, options) => {
    if (unavailable && argv[3] === "pane" && argv[4] === "process-info") throw new Error("process info unavailable");
    const reply = await exec(argv, options);
    if (unavailable && argv[3] === "agent" && argv[4] === "start") return { ...herdrError("timeout", "timed out waiting for agent startup"), truncated: false };
    return reply;
  };
  assert.deepEqual(placed(await relaunchSessions(guest)), [["review", "failed", "w20:p1"]]);
  assert.equal(panes.length, 1, "the uncertain launch leaves its new pane open");
  unavailable = false;
  assert.deepEqual((await recordSessions(guest))!.map((r) => [r.harnessSessionId, r.herdrPane]), [["aaaa", "w20:p1"]]);
  assert.deepEqual(placed(await relaunchSessions(guest)), [["review", "present", "w20:p1"]]);
  assert.equal(guest.herdrCalls().filter((c) => c === "agent start").length, 1, "the recovered live session is not started twice");
  assert.equal(panes.length, 1);
  const file = JSON.parse(guest.written.findLast((f) => f.path === sessionsFile)!.content);
  assert.equal(file.sessions.length, 1);
  assert.equal(file.sessions[0].harnessSessionId, "aaaa");
  assert.deepEqual(file.failed, [], "the recovered pane supersedes the failure");
});

/**
 * A pylon with Claude Code panes, whose typing script runs for real under sh against a fake `herdr` on PATH that
 * records each call's argv. A send-text of a chunk holding FAILME fails. An agent start makes its pane an idle Claude
 * running the launch's arguments. `onSnapshot` sees each Herdr snapshot read, by count, before it is answered.
 */
function claudeWorkers(t: { after(fn: () => void): void }, panes: ReturnType<typeof herdrPane>[], foreground: Record<string, readonly string[]> = {}, onSnapshot: (reads: number) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-claude-type-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls");
  writeFileSync(join(dir, "herdr"), `#!/bin/sh
{ printf '%s\\0' "$@"; printf '\\1'; } >> '${log}'
case "$*" in *FAILME*) echo '{"error":{"code":"pane_not_found","message":"gone"},"id":"cli:test"}'; exit 1;; esac
echo '{"id":"cli:test","result":{"type":"ok"}}'
`, { mode: 0o755 });
  let reads = 0;
  const guest = fakeGuest((argv, herdr) => {
    if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
    if (!herdr && argv[3] === "claude-type") {
      const run = spawnSync(argv[0]!, argv.slice(1), { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" });
      return { exitCode: run.status, output: run.stdout + run.stderr };
    }
    if (!herdr && argv.at(-1) === sessionsFile) return { exitCode: 3, output: "" };
    if (!herdr) return transcriptLookup(argv, true) ?? assert.fail(`unexpected exec ${argv.join(" ")}`);
    const sub = argv.slice(0, 2).join(" ");
    const flag = (name: string) => argv[argv.indexOf(name) + 1]!;
    switch (sub) {
      case "api snapshot":
        onSnapshot(++reads);
        return herdrOk(herdrSnapshot([...new Set(panes.map((p) => p.workspace_id))].map((id) => ({ id, label: "Claude Code" })), panes));
      case "pane process-info": return processInfo(foreground)(argv);
      // Herdr 0.9.5 prints nothing for a key it pressed.
      case "pane send-keys": return panes.some((p) => p.pane_id === argv[2]) ? { exitCode: 0, output: "" } : herdrError("pane_not_found");
      case "workspace list": return herdrOk({ type: "workspace_list", workspaces: [] });
      case "workspace create": return created("w5", "w5:p1");
      case "agent start": {
        const pane = flag("--pane");
        const args = argv.slice(argv.indexOf("--") + 1);
        panes.splice(0, panes.length, ...panes.filter((p) => p.pane_id !== pane), herdrPane(pane, pane.split(":")[0]!, "claude", "idle", { kind: "id", value: args[1]! }));
        foreground[pane] = ["claude", ...args];
        return agentStarted;
      }
    }
    throw new Error(`unscripted herdr ${argv.join(" ")}`);
  });
  const herdrCalls = () => existsSync(log) ? readFileSync(log, "utf8").split("\x01").slice(0, -1).map((call) => call.split("\0").slice(0, -1)) : [];
  return { guest, herdrCalls, typed: () => guest.execs.some((a) => a[3] === "claude-type") };
}

const session = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
const runningClaude = { "w1:p1": ["claude", "--resume", session] };

test("a message reaches Claude's prompt exactly, typed in chunks of at most 64 characters and then submitted with one Enter", async (t) => {
  // The emoji ends the first chunk across a UTF-16 boundary, and the next chunk starts with a dash.
  const text = "x".repeat(63) + "😀" + "-n is no flag\n\"double\" 'single' `ticks` $HOME $(whoami) \\ backslash \\n\n" + "ünïcödé ".repeat(12) + "\n\n  indented\n";
  assert.equal(claudeTextProblem(text), null);
  const w = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: session })], { ...runningClaude });
  assert.deepEqual(await sendToClaude(w.guest, { session, text }), { outcome: "sent", herdrPane: "w1:p1", resumed: false });
  const calls = w.herdrCalls();
  const chunks = calls.slice(0, -1).map((call) => {
    // Herdr types every argument after the pane, so a chunk is the only one.
    assert.deepEqual(call.slice(0, 5), ["--session", "nexus", "pane", "send-text", "w1:p1"]);
    assert.equal(call.length, 6);
    return call[5]!;
  });
  assert.equal(chunks.join(""), text, "the chunks put together are the message");
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(Array.from(chunk).length <= 64, `chunk ${JSON.stringify(chunk)} is at most 64 characters`);
    assert.ok(chunk.isWellFormed(), "no chunk splits a surrogate pair");
  }
  assert.ok(chunks[1]!.startsWith("-n"));
  assert.deepEqual(calls.at(-1), ["--session", "nexus", "pane", "send-keys", "w1:p1", "Enter"]);
});

test("a message to a working Claude is typed and queued, and one to a blocked Claude types nothing", async (t) => {
  const working = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: session })], { ...runningClaude });
  assert.deepEqual(await sendToClaude(working.guest, { session, text: "also check the tests" }), { outcome: "queued", herdrPane: "w1:p1", resumed: false });
  assert.equal(working.herdrCalls().at(-1)?.[3], "send-keys");

  const blocked = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", "blocked", { kind: "id", value: session })], { ...runningClaude });
  assert.deepEqual(await sendToClaude(blocked.guest, { session, text: "yes" }), { outcome: "blocked", herdrPane: "w1:p1", resumed: false });
  assert.equal(blocked.typed(), false, "typing would answer the dialog");
  assert.deepEqual(blocked.herdrCalls(), []);
});

test("a Claude whose state Herdr cannot tell yet is waited for, and is reported starting with nothing typed if it stays so", async (t) => {
  const panes = [herdrPane("w1:p1", "w1", "claude", "unknown", { kind: "id", value: session })];
  const late = claudeWorkers(t, panes, { ...runningClaude }, (reads) => { if (reads === 3) panes[0]!.agent_status = "idle"; });
  assert.deepEqual(await sendToClaude(late.guest, { session, text: "go" }, 5_000), { outcome: "sent", herdrPane: "w1:p1", resumed: false });
  assert.equal(late.typed(), true);

  const stuck = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", "unknown", { kind: "id", value: session })], { ...runningClaude });
  assert.deepEqual(await sendToClaude(stuck.guest, { session, text: "go" }, 600), { outcome: "starting", herdrPane: "w1:p1", resumed: false });
  assert.ok(stuck.guest.herdrCalls().filter((c) => c === "api snapshot").length > 2, "it polled before giving up");
  assert.equal(stuck.typed(), false);
});

test("a pane that stops running the session before the message is typed types nothing and says so", async (t) => {
  const panes = [herdrPane("w1:p1", "w1", "claude", "unknown", { kind: "id", value: session })];
  const foreground: Record<string, readonly string[]> = { ...runningClaude };
  const toPi = claudeWorkers(t, panes, foreground, (reads) => {
    if (reads !== 2) return;
    panes[0] = herdrPane("w1:p1", "w1", "pi", "idle", { kind: "path", value: "/home/user/.pi/sessions/a.jsonl" });
    foreground["w1:p1"] = ["node", "/usr/local/bin/pi"];
  });
  assert.deepEqual(await sendToClaude(toPi.guest, { session, text: "go" }, 5_000), { outcome: "moved", herdrPane: "w1:p1", resumed: false });
  assert.equal(toPi.typed(), false, "a pi session that took the pane is not typed into");

  const others = [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: session })];
  const another = claudeWorkers(t, others, { ...runningClaude }, (reads) => {
    if (reads === 2) others[0] = herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: "another-session" });
  });
  assert.deepEqual(await sendToClaude(another.guest, { session, text: "go" }), { outcome: "moved", herdrPane: "w1:p1", resumed: false });
  assert.equal(another.typed(), false, "nor is another Claude session");
});

test("a Claude pane Herdr reports no session for is found by the session its command line started", async (t) => {
  const w = claudeWorkers(t, [
    herdrPane("w1:p1", "w1", "claude", "idle"),
    herdrPane("w2:p1", "w2", "claude", "idle", { kind: "id", value: "another-session" }),
    herdrPane("w3:p1", "w3", "claude", "idle"),
  ], { "w1:p1": ["claude", "--session-id", "another-one"], "w2:p1": ["claude", "--resume", session], "w3:p1": ["node", "/usr/local/bin/claude", "--resume", session] });
  assert.deepEqual(await sendToClaude(w.guest, { session, text: "hi" }), { outcome: "sent", herdrPane: "w3:p1", resumed: false });
  assert.ok(w.herdrCalls().every((call) => call[4] === "w3:p1"));
});

test("a session in no live pane is resumed in a new workspace in the checkout, then given the message", async (t) => {
  const w = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: "another-session" })], { "w1:p1": ["claude", "--resume", "another-session"] });
  assert.deepEqual(await sendToClaude(w.guest, { session, text: "pick it back up", model: "claude-opus-5-5" }), { outcome: "sent", herdrPane: "w5:p1", resumed: true });
  assert.deepEqual(w.guest.execs.find((a) => a[4] === "create")!.slice(5, 9), ["--cwd", "/home/user/workspace/repo", "--label", "Claude Code"]);
  const start = w.guest.execs.find((a) => a[3] === "agent")!;
  assert.deepEqual(start.slice(start.indexOf("--") + 1, -2), ["--resume", session, "--model", "claude-opus-5-5"]);
  assert.ok(w.guest.execs.indexOf(start) < w.guest.execs.findIndex((a) => a[3] === "claude-type"), "the message is typed once Claude runs");
  assert.deepEqual(w.herdrCalls().map((call) => call.slice(3, 5)), [["send-text", "w5:p1"], ["send-keys", "w5:p1"]]);
});

test("a pane that reports the session but whose Claude exited to its shell gets Claude resumed in place", async (t) => {
  const w = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: session })]);
  assert.deepEqual(await sendToClaude(w.guest, { session, text: "ls" }), { outcome: "sent", herdrPane: "w1:p1", resumed: true });
  assert.equal(w.guest.herdrCalls().includes("workspace create"), false);
  const start = w.guest.execs.find((a) => a[3] === "agent")!;
  assert.deepEqual(start.slice(start.indexOf("--pane"), start.indexOf("--pane") + 2), ["--pane", "w1:p1"]);
  assert.deepEqual(start.slice(start.indexOf("--") + 1, start.indexOf("--") + 3), ["--resume", session]);
});

test("a failed chunk stops the typing before Enter, and the error says how far it got", async (t) => {
  const w = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: session })], { ...runningClaude });
  await assert.rejects(sendToClaude(w.guest, { session, text: "a".repeat(64) + "FAILME" + "b".repeat(64) }), /part of the message may sit unsent.*typed 1 of 3 chunks/s);
  assert.deepEqual(w.herdrCalls().map((call) => call[3]), ["send-text", "send-text"]);
});

const pressed = (w: ReturnType<typeof claudeWorkers>) => w.guest.execs.filter((a) => a[3] === "pane" && a[4] === "send-keys").map((a) => a.slice(5));

test("an interrupt presses Esc, and only Esc, in the pane of a working Claude, and nothing for an idle Claude, a dialog or a state Herdr cannot tell", async (t) => {
  const working = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: session })], { ...runningClaude });
  assert.equal(await interruptClaude(working.guest, session), "interrupted");
  assert.deepEqual(pressed(working), [["w1:p1", "esc"]]);
  for (const [status, outcome] of [["idle", "idle"], ["done", "idle"], ["blocked", "blocked"], ["unknown", "unknown"]] as const) {
    const w = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", status, { kind: "id", value: session })], { ...runningClaude });
    assert.equal(await interruptClaude(w.guest, session), outcome, status);
    assert.deepEqual(pressed(w), [], `nothing is pressed for a Claude that is ${status}`);
  }
});

test("an interrupt finds the session's pane as a send does, and resumes nothing when no Claude runs it", async (t) => {
  const byCommandLine = claudeWorkers(t, [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: "another-session" }), herdrPane("w2:p1", "w2", "claude", "working")],
    { "w1:p1": ["claude", "--resume", session], "w2:p1": ["claude", "--resume", session] });
  assert.equal(await interruptClaude(byCommandLine.guest, session), "interrupted");
  assert.deepEqual(pressed(byCommandLine), [["w2:p1", "esc"]], "a pane whose Claude moved on to another session, as after /clear, is not pressed");

  for (const [why, panes, foreground] of [
    ["another session", [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: "another-session" })], { "w1:p1": ["claude", "--resume", "another-session"] }],
    ["a Claude that exited to its shell", [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: session })], {}],
    ["no pane", [], {}],
  ] as const) {
    const w = claudeWorkers(t, [...panes], { ...foreground });
    assert.equal(await interruptClaude(w.guest, session), "not-running", why);
    assert.deepEqual(pressed(w), [], why);
    assert.equal(w.guest.herdrCalls().some((c) => c === "workspace create" || c === "agent start"), false, `${why}: nothing is resumed`);
  }

  const asking = [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: session })];
  const dialog = claudeWorkers(t, asking, { ...runningClaude }, (reads) => { if (reads === 1) queueMicrotask(() => { asking[0]!.agent_status = "blocked"; }); });
  assert.equal(await interruptClaude(dialog.guest, session), "blocked", "a dialog that opened while the pane was found");
  assert.deepEqual(pressed(dialog), []);

  const panes = [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: session })];
  const closing = claudeWorkers(t, panes, { ...runningClaude }, (reads) => { if (reads === 1) queueMicrotask(() => panes.splice(0)); });
  assert.equal(await interruptClaude(closing.guest, session), "not-running", "a pane that closed before Esc reached it");
});

test("a message Claude's prompt cannot take exactly is refused with a reason, and newlines are fine", () => {
  assert.equal(claudeTextProblem("line one\nline two\n"), null);
  assert.equal(claudeTextProblem("ünïcödé 😀 `$x`"), null);
  assert.match(claudeTextProblem("a\tb")!, /tab.*Replace tabs with spaces/);
  assert.match(claudeTextProblem("a\r\nb")!, /carriage return/);
  assert.match(claudeTextProblem("a\x1b[2Jb")!, /U\+001B at offset 1/);
  assert.match(claudeTextProblem("a\x00")!, /U\+0000/);
  assert.match(claudeTextProblem("a\x9b")!, /U\+009B/);
  assert.match(claudeTextProblem("bad \ud800 half")!, /surrogate/);
  assert.match(claudeTextProblem(" \n \n")!, /blank/);
});

test("a sessions file is read as the sessions it records, without its models or fields Nexus does not know, and one that fails a check is refused", () => {
  const unknown = { zzUnknown: 1 };
  const claude = { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", harnessSessionId: "s-1", model: "opus" };
  const shell = { herdrPane: "w2:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null };
  const failed = { record: { herdrPane: "w3:p1", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/s.jsonl" }, inPane: false, message: "pi did not start" };
  const file = { version: 1, recordedAt: "2027-01-01T00:00:00Z", sessions: [{ ...claude, ...unknown }, { ...shell, ...unknown }], failed: [{ ...failed, record: { ...failed.record, ...unknown }, ...unknown }], ...unknown };
  assert.deepEqual(pausedSessionsIn(JSON.stringify(file)), [
    { id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code", title: "review", harnessSessionId: "s-1" },
    { id: "w2:p1", herdrPane: "w2:p1", harness: "shell", title: "sh", harnessSessionId: null },
    { id: "failed-f513fc00e70b", herdrPane: null, harness: "pi", title: "plan", harnessSessionId: "/s.jsonl" },
  ]);
  const { harnessSessionId: _, ...noSessionId } = shell;
  const bad: unknown[] = [
    null, [], { ...file, version: 2 }, { ...file, recordedAt: "" }, { ...file, sessions: null }, { ...file, failed: undefined },
    { ...file, sessions: [{ ...shell, harness: "codex" }] }, { ...file, sessions: [{ ...shell, title: "" }] }, { ...file, sessions: [{ ...shell, cwd: 1 }] }, { ...file, sessions: [{ ...shell, herdrPane: undefined }] },
    { ...file, sessions: [{ ...claude, model: "" }] }, { ...file, sessions: [{ ...shell, harnessSessionId: "" }] }, { ...file, sessions: [null] },
    { ...file, sessions: [{ ...shell, harness: "toString" }] }, { ...file, sessions: [{ ...shell, harness: "constructor" }] },
    { ...file, failed: [{ ...failed, inPane: "no" }] }, { ...file, failed: [{ ...failed, message: "" }] }, { ...file, failed: [{ ...failed, record: null }] },
  ];
  for (const value of bad) assert.throws(() => pausedSessionsIn(JSON.stringify(value)), Error, JSON.stringify(value));
  assert.deepEqual(pausedSessionsIn(JSON.stringify({ ...file, sessions: [noSessionId], failed: [] })), [{ id: "w2:p1", herdrPane: "w2:p1", harness: "shell", title: "sh", harnessSessionId: null }], "a missing session ID reads as none");
});

test("Herdr's panes are read without the fields Nexus does not use, and a snapshot that fails a check rejects", async () => {
  const pane = { ...herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: "s-1" }), zzUnknown: 1 };
  const snapshot = (panes: unknown[], workspaces: unknown[] = [{ workspace_id: "w1", label: "review", zzUnknown: 1 }]) => ({ type: "snapshot", snapshot: { workspaces, panes, zzUnknown: 1 } });
  const facts = (value: unknown) => sessionFacts(herdrUp({ "api snapshot": () => herdrOk(value) }));
  assert.deepEqual(await facts(snapshot([pane])), [{ id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s-1", status: "working", title: "review" }]);
  assert.deepEqual(await facts(snapshot([{ ...pane, agent: "codex", agent_session: { agent: "codex", value: 1 } }])), [{ id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, status: "working", title: "review" }]);
  assert.deepEqual(await facts(snapshot([{ ...pane, agent_session: { agent: "pi", value: "p" } }])), [{ id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: null, status: "working", title: "review" }]);
  const bad: unknown[] = [
    null, { snapshot: null }, snapshot([pane], null as never), snapshot(null as never), snapshot([null]), snapshot([pane], [{ workspace_id: "w1" }]), snapshot([pane], [{ workspace_id: "", label: "x" }]),
    snapshot([{ ...pane, pane_id: "" }]), snapshot([{ ...pane, agent: "" }]), snapshot([{ ...pane, agent_status: "asleep" }]), snapshot([{ ...pane, agent_session: "s-1" }]),
    snapshot([{ ...pane, workspace_id: "w9" }]), snapshot([{ ...pane, foreground_cwd: "" }]), snapshot([{ ...pane, foreground_cwd: null, cwd: 1 }]),
    snapshot([{ ...pane, agent_session: { agent: "claude", value: "" } }]),
  ];
  for (const value of bad) await assert.rejects(facts(value), Error, JSON.stringify(value));
});

test("a Herdr reply without the fields Nexus reads rejects, and an error reply names Herdr's code", async () => {
  const open = (reply: () => ExecReply) => openSession(herdrUp({ "workspace create": reply }), { harness: "shell", title: "sh", cwd: "/home/user" });
  assert.equal(await open(() => herdrOk({ workspace: { workspace_id: "w5", zzUnknown: 1 }, root_pane: { pane_id: "w5:p1" } })), "w5:p1");
  for (const result of [null, {}, { workspace: { workspace_id: "w5" } }, { workspace: { workspace_id: "" }, root_pane: { pane_id: "w5:p1" } }, { workspace: { workspace_id: "w5" }, root_pane: { pane_id: 1 } }]) {
    await assert.rejects(open(() => herdrOk(result)), Error, JSON.stringify(result));
  }
  const close = (reply: ExecReply) => closeSession(herdrUp({ "pane close": () => reply }), "w1:p1");
  assert.equal(await close(herdrError("pane_not_found")), "not-open");
  for (const error of [{}, { code: "pane_not_found" }, { code: "", message: "m" }, "pane_not_found"]) {
    await assert.rejects(close({ exitCode: 1, output: `${JSON.stringify({ id: "cli:1", error })}\n` }), (err: Error) => err.name === "Error", JSON.stringify(error));
  }
  await assert.rejects(close({ exitCode: 0, output: "[1]\n" }), Error);
});

test("a prompted launch waits on the shell_pid Herdr gave, whatever number it is", async () => {
  const pylon = launchPylon();
  const guest = pylon.probe();
  const exec = guest.exec.bind(guest);
  guest.exec = async (argv, options) => {
    const reply = await exec(argv, options);
    return argv[3] === "pane" && argv[4] === "process-info" ? { ...reply, output: reply.output.replace('"shell_pid":100', '"shell_pid":1e400') } : reply;
  };
  assert.equal(await openSession(guest, prompted), "w1:p1");
  assert.ok(pylon.execs.some((argv) => argv[3] === "shell-ready" && argv[4] === "Infinity"));
});
