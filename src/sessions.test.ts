import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSession, openSession, recordSessions, relaunchSessions, sessionFacts, sessionsFile, type SessionRecord } from "./sessions.ts";
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
function herdrUp(overrides: Record<string, (argv: readonly string[]) => ExecReply> = {}, transcripts = true) {
  return fakeGuest((argv, herdr) => {
    if (!herdr) return transcriptLookup(argv, transcripts) ?? assert.fail(`unexpected exec ${argv.join(" ")}`);
    const sub = argv.slice(0, 2).join(" ");
    const override = overrides[sub];
    if (override) return override(argv);
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "workspace create") return created("w1", "w1:p1");
    if (sub === "agent start") return agentStarted;
    if (sub === "workspace close") return herdrOk({ type: "ok" });
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
  assert.deepEqual(start.slice(6), ["--kind", "claude", "--pane", "w1:p1", "--timeout", "30000", "--", "--resume", "bd2c2d6b"]);
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
  assert.deepEqual(guest.execs.find((a) => a[3] === "agent")!.slice(-2), ["--session-id", "d778fc1b"]);
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
    if (!herdr) {
      assert.equal(argv[0], "sh");
      assert.match(argv[2]!, /setsid -f tini -s -- herdr --session "\$0" server <\/dev\/null >\/dev\/null 2>&1/);
      assert.equal(argv[3], "nexus");
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

test("closing a pane that is gone, or with no server, succeeds; other errors reject", async () => {
  await closeSession(herdrUp({ "pane close": () => herdrError("pane_not_found") }), "w1:p1");
  await closeSession(herdrUp({ "pane close": () => herdrError("server_not_running") }), "w1:p1");
  const closed = herdrUp({ "pane close": () => herdrOk({ type: "ok" }) });
  await closeSession(closed, "w2:p1");
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

test("session facts map Herdr panes to harnesses, session IDs and statuses", async () => {
  const facts = await sessionFacts(herdrUp({ "api snapshot": () => herdrOk(liveSnapshot) }));
  assert.deepEqual(facts, [
    { herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "bd2c2d6b", status: "working" },
    { herdrPane: "w2:p1", harness: "pi", harnessSessionId: "/home/user/.pi/agent/sessions/s.jsonl", status: "blocked" },
    { herdrPane: "w3:p1", harness: "shell", harnessSessionId: null, status: "unknown" },
    { herdrPane: "w3:p2", harness: "shell", harnessSessionId: null, status: "idle" },
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
  assert.deepEqual(content.sessions, records);
  assert.deepEqual(content.sessions.slice(0, 3), [
    { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", harnessSessionId: "bd2c2d6b" },
    { herdrPane: "w2:p1", harness: "pi", title: "plan", cwd: "/home/user/app", harnessSessionId: "/home/user/.pi/agent/sessions/s.jsonl" },
    { herdrPane: "w3:p1", harness: "shell", title: "sh", cwd: "/home/user/workspace/repo", harnessSessionId: null },
  ]);
});

test("recording with no Herdr server leaves the last sessions file in place", async () => {
  const guest = herdrUp({ "api snapshot": () => herdrError("server_not_running") });
  assert.equal(await recordSessions(guest), null);
  assert.deepEqual(guest.written, []);
});

function withSessionsFile(records: readonly SessionRecord[] | null, herdr: (argv: readonly string[]) => ExecReply) {
  return fakeGuest((argv, isHerdr) => {
    if (isHerdr) return herdr(argv);
    const lookup = transcriptLookup(argv, true);
    if (lookup) return lookup;
    assert.equal(argv.at(-1), sessionsFile);
    return records === null ? { exitCode: 3, output: "" } : { exitCode: 0, output: JSON.stringify({ version: 1, recordedAt: "2027-01-01T00:00:00Z", sessions: records }) };
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
  assert.deepEqual(guest.execs.find((a) => a[3] === "agent")!.slice(6), ["--kind", "claude", "--pane", "w1:p1", "--timeout", "30000", "--", "--resume", "bd2c2d6b"]);
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
  assert.deepEqual(guest.execs.find((a) => a[3] === "agent")!.slice(6), ["--kind", "claude", "--pane", "w1:p1", "--timeout", "30000", "--", "--resume", "bd2c2d6b"]);
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

test("relaunching twice opens nothing new, and sessions that share a title keep their own panes", async () => {
  const records: SessionRecord[] = [
    { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" },
    { herdrPane: "w2:p1", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "bbbb" },
    { herdrPane: "w3:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ];
  // The first relaunch already brought back "bbbb" and the shell, under new pane IDs. "aaaa" is still missing.
  const live = herdrSnapshot(
    [{ id: "w7", label: "review" }, { id: "w8", label: "sh" }],
    [herdrPane("w7:p1", "w7", "claude", "idle", { kind: "id", value: "bbbb" }), herdrPane("w8:p1", "w8", null, "unknown")],
  );
  const guest = withSessionsFile(records, (argv) => {
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "api snapshot") return herdrOk(live);
    if (sub === "pane process-info") return processInfo({ "w7:p1": ["claude", "--resume", "bbbb"] })(argv);
    if (sub === "workspace create") return created("w9", "w9:p1");
    if (sub === "agent start") return agentStarted;
    throw new Error(`unscripted ${sub}`);
  });
  assert.deepEqual((await relaunchSessions(guest)).map((o) => [o.record.harnessSessionId, o.result, "herdrPane" in o ? o.herdrPane : null]), [
    ["aaaa", "relaunched", "w9:p1"],
    ["bbbb", "present", "w7:p1"],
    [null, "present", "w8:p1"],
  ]);
  assert.equal(guest.herdrCalls().filter((c) => c === "workspace create").length, 1);
});
