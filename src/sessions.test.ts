import { seedClaudeState } from "./claude-state.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachedTerminals, attachScript, closeSession, dropFailedSession, openSession, pausedSessionsIn, recordSessions, relaunchSessions, sessionFacts, sessionsFile, type RelaunchOutcome, type SessionRecord } from "./sessions.ts";
import { fakeGuest, herdrError, herdrOk, herdrPane, herdrSnapshot, type ExecReply } from "./fake-guest.ts";

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

/**
 * A Herdr server that is up, with `overrides` keyed by subcommand such as "agent start". Claude Code
 * transcripts exist unless `transcripts` is false.
 */
function herdrUp(overrides: Record<string, (argv: readonly string[]) => ExecReply> = {}, transcripts = true, submitted = true) {
  return fakeGuest((argv, herdr) => {
    if (argv[2] === seedClaudeState) return { exitCode: 0, output: "" };
    if (!herdr && argv[3] === "claude-submitted") return { exitCode: submitted ? 0 : 1, output: "" };
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
    if (sub === "pane read") return herdrOk({ type: "pane_read", read: { text: "user@pylon:~$ " } });
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
    "pane read": () => herdrOk({ type: "pane_read", read: { text: "No conversation found with session ID: d778fc1b\nuser@pylon:~$ " } }),
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
    return records === null ? { exitCode: 3, output: "" } : { exitCode: 0, output: JSON.stringify({ version: 1, recordedAt: "2027-01-01T00:00:00Z", sessions: records, failed: [] }) };
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
      return { exitCode: 0, output: last ?? JSON.stringify({ version: 1, recordedAt: "2027-01-01T00:00:00Z", sessions: records, failed: [] }) };
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
      case "pane read": return herdrOk({ type: "pane_read", read: { text: "user@pylon:~$ " } });
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

test("a worker's initial slash prompt is one literal Claude argument, not terminal input", async () => {
  const guest = herdrUp();
  const prompt = '/poteto-mode fix "quotes" and $(not-a-shell-command)\nthen test';
  await openSession(guest, { harness: "claude-code", title: "worker", cwd: "/home/user/workspace/repo", prompt });
  const start = guest.execs.find((a) => a[3] === "agent")!;
  assert.deepEqual(start.slice(-5, -3), ["--permission-mode", "bypassPermissions"]);
  assert.equal(start.at(-1), prompt);
  assert.ok(guest.execs.some((a) => a[3] === "claude-submitted"));
  assert.equal(guest.execs.some((a) => a.includes("send-text") || a.includes("send-keys")), false);
});


test("a worker without prompt submission stalls and leaves its visible pane for takeover", async () => {
  const guest = herdrUp({ "pane read": () => herdrOk({ read: { text: "Choose the text style" } }) }, true, false);
  await assert.rejects(openSession(guest, { harness: "claude-code", title: "worker", cwd: "/home/user/workspace/repo", prompt: "hello" }), /Claude launch stalled.*Choose the text style/s);
  assert.equal(guest.herdrCalls().includes("workspace close"), false);
  assert.equal(guest.herdrCalls().filter((c) => c === "agent start").length, 1);
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


test("a readiness timeout after submission is started and never closes the busy pane", async () => {
  const guest = herdrUp({ "agent start": () => herdrError("timeout", "timed out waiting for agent startup") });
  assert.equal(await openSession(guest, { harness: "claude-code", title: "worker", cwd: "/home/user/workspace/repo", prompt: "work", model: "custom-model" }), "w1:p1");
  assert.equal(guest.herdrCalls().includes("workspace close"), false);
  assert.equal(guest.herdrCalls().filter((c) => c === "agent start").length, 1);
  const start = guest.execs.find((a) => a[3] === "agent")!;
  assert.equal(start[start.indexOf("--model") + 1], "custom-model");
});

test("a lost receipt with a running busy Claude also preserves the launch", async () => {
  const guest = herdrUp({
    "agent start": () => herdrError("timeout", "timed out waiting for agent startup"),
    "pane process-info": processInfo({ "w1:p1": ["claude"] }),
    "api snapshot": () => herdrOk(herdrSnapshot([{ id: "w1", label: "worker" }], [herdrPane("w1:p1", "w1", "claude", "working")])),
  }, true, false);
  assert.equal(await openSession(guest, { harness: "claude-code", title: "worker", cwd: "/home/user/workspace/repo", prompt: "work" }), "w1:p1");
  assert.equal(guest.herdrCalls().includes("workspace close"), false);
});

test("a receipt read failure preserves the pane rather than rolling back uncertain work", async () => {
  const base = herdrUp();
  const guest = { ...base, exec: async (...args: Parameters<typeof base.exec>) => {
    if (args[0][3] === "claude-submitted") throw new Error("guest disconnected");
    return base.exec(...args);
  } };
  await assert.rejects(openSession(guest, { harness: "claude-code", title: "worker", cwd: "/home/user/workspace/repo", prompt: "work" }), /Claude launch stalled/);
  assert.equal(base.herdrCalls().includes("workspace close"), false);
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
