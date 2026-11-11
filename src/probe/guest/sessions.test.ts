import { labelClaudeSession, seedClaudeState } from "./launchers.ts";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { attachedTerminals, closeSession, dropFailedSession, interruptClaude, LaunchStalled, openSession, pausedSessionsIn, recordSessions, relaunchSessions, sendToClaude, sessionFacts, type ClaudeSessionLock, type RelaunchOutcome, type SessionRecord } from "./sessions.ts";
import { claudeTextProblem } from "../../protocol/agent-kinds.ts";
import { coreError, coreOk, fakeCore, fakeGuest, launchedProgram, sessionsFileReply, slowStart, stillStarting, type ExecReply, type FakeCore, type FakeTerminal } from "../../backends/fake-guest.ts";
import { coreViewer, ensureCore } from "../../guest-contract.ts";
import { coreCall } from "./core.ts";
import { checkoutDir, claudeLaunchesDir, claudeProjects, piSessions, sessionsFile } from "../../../images/pylon/nexus-contract.ts";

/** Nothing else runs here, so no call needs to wait for the relaunch. */
const unlocked: ClaudeSessionLock = (_, work) => work();
const ok: ExecReply = { exitCode: 0, output: "" };

interface PylonOptions {
  /** The sessions file before any write: its records, its text, or null for none. Later reads get the last write. */
  file?: readonly SessionRecord[] | string | null;
  /** The Claude Code session IDs that have a transcript, or true for every one. */
  transcripts?: boolean | readonly string[];
  seed?: ExecReply;
  /** Whether a prompted launch's UserPromptSubmit receipt shows up. */
  submitted?: boolean;
  /** What an ensureCore that starts no core answers, or undefined for one that starts the fake core. */
  coreStart?: ExecReply;
}

/** A pylon whose core is `core`. Options are read at each exec, so a test can change them between calls. */
function pylon(core: FakeCore, options: PylonOptions = {}) {
  const guest = fakeGuest((argv) => {
    if (argv[2] === ensureCore && options.coreStart !== undefined) return options.coreStart;
    return core.reply(argv) ?? other(argv);
  });
  function other(argv: readonly string[]): ExecReply {
    if (argv[0] === "node" && argv[2] === seedClaudeState) return options.seed ?? ok;
    if (argv[0] === "sh" && argv.at(-1) === sessionsFile) {
      const last = guest.written.findLast((f) => f.path === sessionsFile)?.content;
      if (last !== undefined) return { exitCode: 0, output: last };
      const file = options.file ?? null;
      return file === null ? { exitCode: 3, output: "" } : typeof file === "string" ? { exitCode: 0, output: file } : sessionsFileReply(file);
    }
    if (argv[0] === "sh" && argv.at(-1) === claudeProjects) {
      const transcripts = options.transcripts ?? true;
      return { exitCode: transcripts === true || (transcripts !== false && transcripts.includes(argv[3]!)) ? 0 : 1, output: "" };
    }
    if (argv[0] === "sh" && argv[3] === "claude-submitted") return { exitCode: options.submitted === false ? 1 : 0, output: "" };
    return assert.fail(`unexpected exec ${argv.join(" ")}`);
  }
  return guest;
}

const startedCore = (guest: { execs: readonly (readonly string[])[] }) => guest.execs.some((argv) => argv[2] === ensureCore);
const runs = (core: FakeCore) => core.calls.filter((c) => c.method === "terminal.run");
const program = (t: FakeTerminal) => launchedProgram(t.argv);
const exits = (t: FakeTerminal, exitCode: number | null, screen: string) => Object.assign(t, { state: "finished" as const, foreground: null, status: null, exitCode, screen });
const status = (state: string | null) => state === null ? null : { state };
const labels = (harness: string, title: string) => ({ "nexus.title": title, "nexus.harness": harness });
const placed = (outcomes: readonly RelaunchOutcome[]) => outcomes.map((o) => [o.record.title, o.result, o.terminal]);
const lastFile = (guest: { written: readonly { path: string; content: string }[] }) => JSON.parse(guest.written.findLast((f) => f.path === sessionsFile)!.content) as { sessions: SessionRecord[]; failed: { record: SessionRecord; inTerminal: boolean; message: string }[] };
const settingsOf = (argv: readonly string[]) => JSON.parse(argv[argv.indexOf("--settings") + 1]!) as unknown;
const hook = (command: string) => [{ hooks: [{ type: "command", command }] }];
/** A `terminal.keep` from outside Nexus, as herdr-app's Nexus mod makes to show a terminal in a pane. */
const keptByHand = (core: FakeCore, terminal: string) => assert.equal(core.reply(["sh", "-c", coreCall, "core", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "terminal.keep", params: { terminal, keep: true } })])?.exitCode, 0);
const launchWrapper = ["env", "-u", "CLAUDE_CODE_SESSION_ID", "-u", "CLAUDECODE", "bash", "-lc", 'exec "$0" "$@"'];

test("a Claude Code session opens in a terminal of its own that resumes the given session, labelled with its title and harness, starting a core when none runs", async () => {
  const core = fakeCore({ running: false });
  const guest = pylon(core);
  const address = await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user/app", resume: "bd2c2d6b" });
  assert.ok(startedCore(guest));
  assert.equal(core.terminals.length, 1);
  const t = core.terminals[0]!;
  assert.equal(address, t.address);
  assert.deepEqual([t.state, t.cwd, t.labels, t.keep], ["live", "/home/user/app", { ...labels("claude-code", "review"), "claude.session_id": "bd2c2d6b" }, false]);
  assert.deepEqual(t.argv.slice(0, -1), [...launchWrapper, "claude", "--resume", "bd2c2d6b", "--permission-mode", "bypassPermissions", "--settings"]);
  assert.deepEqual(settingsOf(t.argv), { hooks: { SessionStart: hook(labelClaudeSession) } }, "an unprompted launch labels its session and takes no receipt");
  assert.equal(runs(core)[0]!.params.no_parent, true, "the terminal belongs to no other");
  const lookup = guest.execs.find((argv) => argv.at(-1) === claudeProjects)!;
  assert.deepEqual(lookup.slice(3), ["bd2c2d6b", claudeProjects], "the guest looks for that ID's transcript under every project");
});

test("a Claude Code session never prompted has no transcript, so it starts fresh under the same ID", async () => {
  const core = fakeCore();
  await openSession(pylon(core, { transcripts: false }), { harness: "claude-code", title: "review", cwd: "/home/user", resume: "d778fc1b" });
  assert.deepEqual(program(core.terminals[0]!).slice(0, 5), ["claude", "--session-id", "d778fc1b", "--permission-mode", "bypassPermissions"]);
});

test("a fresh Claude Code session starts under an ID of its own and its model, and a fresh pi session under a session file of its own", async () => {
  const core = fakeCore();
  const guest = pylon(core);
  await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user", model: "claude-opus-5-5" });
  await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user" });
  const [first, second] = core.terminals.map(program);
  assert.deepEqual([first![1], first!.slice(3, 7)], ["--session-id", ["--model", "claude-opus-5-5", "--permission-mode", "bypassPermissions"]]);
  assert.match(first![2]!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(second![2], first![2], "each start names a new ID");

  await openSession(guest, { harness: "pi", title: "plan", cwd: "/home/user" });
  const pi = program(core.terminals[2]!);
  assert.deepEqual(pi.slice(0, 2), ["pi", "--session"]);
  assert.match(pi[2]!, new RegExp(`^${piSessions}/nexus-[0-9a-f-]{36}\\.jsonl$`));
  assert.equal(pi.length, 3);
  assert.deepEqual(core.terminals.map((t) => t.labels["claude.session_id"] ?? t.labels["pi.session_file"]), [first![2], second![2], pi[2]], "each terminal names its session from its start");
});

test("a pi session resumes from its session file, and a shell is a kept login shell that starts no agent", async () => {
  const core = fakeCore();
  const guest = pylon(core);
  const pi = await openSession(guest, { harness: "pi", title: "plan", cwd: "/home/user", resume: "/home/user/.pi/agent/sessions/s.jsonl" });
  assert.deepEqual(core.terminals.find((t) => t.address === pi)!.argv, [...launchWrapper, "pi", "--session", "/home/user/.pi/agent/sessions/s.jsonl"]);

  const shell = await openSession(guest, { harness: "shell", title: "sh", cwd: "/home/user" });
  const t = core.terminals.find((x) => x.address === shell)!;
  assert.deepEqual([t.argv, t.keep, t.cwd, t.labels], [["bash", "-l"], true, "/home/user", labels("shell", "sh")]);
});

test("only a Claude Code start seeds Claude's state, and pi or a shell seeds nothing", async () => {
  for (const [harness, seeds] of [["claude-code", 1], ["pi", 0], ["shell", 0]] as const) {
    const guest = pylon(fakeCore());
    await openSession(guest, { harness, title: "t", cwd: "/home/user" });
    assert.equal(guest.execs.filter((a) => a[2] === seedClaudeState).length, seeds, harness);
  }
});

test("an agent that exits as it starts is rolled back, and the failure shows its screen", async () => {
  const core = fakeCore({ start: (t) => exits(t, 1, "No conversation found with session ID: d778fc1b\nuser@pylon:~$ \n") });
  await assert.rejects(openSession(pylon(core), { harness: "claude-code", title: "t", cwd: "/home/user", resume: "d778fc1b" }),
    { message: "Claude Code exited with 1 as it started. The terminal showed:\nNo conversation found with session ID: d778fc1b\nuser@pylon:~$" });
  assert.deepEqual(core.terminals, [], "the terminal is gone from the core");

  const silent = fakeCore({ start: (t) => exits(t, null, "") });
  await assert.rejects(openSession(pylon(silent), { harness: "pi", title: "t", cwd: "/home/user" }), /^Error: pi exited as it started/);
  assert.deepEqual(silent.terminals, []);
});

test("a failed rollback is reported with the start failure", async () => {
  const core = fakeCore({
    start: (t) => exits(t, 1, "boom"),
    answer: (method) => method === "terminal.rm" ? coreError("live", "t1 is still running") : undefined,
  });
  await assert.rejects(openSession(pylon(core), { harness: "pi", title: "t", cwd: "/home/user" }), /pi exited with 1 as it started; rolling back terminal t1 also failed: terminal\.rm: t1 is still running.*boom/s);
});

test("an agent blocked at startup, such as on a trust question, or silent until then keeps its session open", async () => {
  for (const state of ["blocked", null]) {
    const core = fakeCore({ start: (t) => { t.status = status(state); } });
    assert.equal(await openSession(pylon(core), { harness: "claude-code", title: "t", cwd: "/home/user" }), "t1", String(state));
    assert.deepEqual(core.terminals.map((t) => t.state), ["live"], String(state));
  }
});

test("a readiness wait that fails keeps a terminal that runs Claude, stalls on one it cannot read, and rolls back pi or a Claude gone to its shell", async () => {
  const failingWait = (read: boolean, start?: (t: FakeTerminal) => void) => fakeCore({
    ...(start === undefined ? {} : { start }),
    answer: (method) => method === "terminal.wait" || (!read && method === "terminal.get") ? { exitCode: null, output: "" } : undefined,
  });
  const running = failingWait(true);
  assert.equal(await openSession(pylon(running), { harness: "claude-code", title: "t", cwd: "/home/user" }), "t1");
  assert.deepEqual(running.terminals.map((t) => t.state), ["live"], "the running Claude keeps its terminal");

  const unreadable = failingWait(false);
  await assert.rejects(openSession(pylon(unreadable), { harness: "claude-code", title: "t", cwd: "/home/user" }),
    (err) => err instanceof LaunchStalled && err.terminal === "t1" && /Claude Code launch stalled: terminal\.wait did not finish/.test(err.message));
  assert.deepEqual(unreadable.terminals.map((t) => t.state), ["live"], "a launch that may have started Claude is left for the person");

  const shell = failingWait(true, (t) => { t.foreground = { argv: ["-bash"], cwd: t.cwd, name: "bash" }; });
  await assert.rejects(openSession(pylon(shell), { harness: "claude-code", title: "t", cwd: "/home/user" }), /terminal\.wait did not finish/);
  assert.deepEqual(shell.terminals, []);

  const pi = failingWait(true);
  await assert.rejects(openSession(pylon(pi), { harness: "pi", title: "t", cwd: "/home/user" }), /terminal\.wait did not finish/);
  assert.deepEqual(pi.terminals, [], "pi is rolled back even though it runs");
});

const launched = "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30";
const launchDir = `${claudeLaunchesDir}/${launched}`;
const prompted = { harness: "claude-code" as const, title: "worker", cwd: "/home/user/workspace/repo", resume: launched, prompt: "work" };
const tricky = "/poteto-mode fix \"quotes\" and 'single' and `ticks` and $(not-a-shell-command) $HOME !! \\n\nthen\ttest\r\n\n  ünïcode\n";

test("a worker starts Claude with its first prompt as the last argument, in a terminal named after the session, and waits for the prompt's receipt", async () => {
  const core = fakeCore();
  const guest = pylon(core, { transcripts: false });
  assert.equal(await openSession(guest, { ...prompted, prompt: tricky, model: "claude-opus-5-5" }), "t1");
  const t = core.terminals[0]!;
  assert.equal(t.name, "claude-6f1c2a9e3b7d4e058c219d4b7");
  assert.deepEqual([t.cwd, t.labels], ["/home/user/workspace/repo", { ...labels("claude-code", "worker"), "claude.session_id": "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30" }]);
  const argv = program(t);
  assert.deepEqual(argv.slice(0, -2), ["claude", "--session-id", launched, "--model", "claude-opus-5-5", "--permission-mode", "bypassPermissions", "--settings"]);
  assert.equal(argv.at(-1), tricky);
  assert.deepEqual(settingsOf(argv), { hooks: { SessionStart: hook(labelClaudeSession), UserPromptSubmit: hook(`mkdir -p ${launchDir} && touch ${launchDir}/submitted`) } });
  assert.deepEqual(guest.execs.find((a) => a[3] === "claude-submitted")!.slice(4), [`${launchDir}/submitted`], "the wait watches the receipt the hook writes");

  const fresh = fakeCore();
  await openSession(pylon(fresh, { transcripts: false }), { harness: "claude-code", title: "worker", cwd: "/home/user", prompt: "work" });
  const id = program(fresh.terminals[0]!)[2]!;
  assert.equal(fresh.terminals[0]!.name, `claude-${id.replaceAll("-", "").slice(0, 25)}`, "a fresh worker is named after the ID it starts under");
});

test("a worker's first prompt reaches the program byte-exact through the launch's login shell, which drops the parent Claude's session", (t) => {
  const core = fakeCore();
  return openSession(pylon(core, { transcripts: false }), { ...prompted, prompt: tricky }).then(() => {
    const argv = core.terminals[0]!.argv;
    const at = argv.indexOf('exec "$0" "$@"') + 1;
    const dir = mkdtempSync(join(tmpdir(), "nexus-launch-argv-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "argv");
    const printer = ["sh", "-c", 'printf "%s\\0" "${CLAUDE_CODE_SESSION_ID-unset}" "${CLAUDECODE-unset}" "$@" > "$OUT"', "sh"];
    const real = [...argv.slice(0, at), ...printer, ...argv.slice(at + 1)];
    const run = spawnSync(real[0]!, real.slice(1), { env: { ...process.env, HOME: dir, OUT: out, CLAUDE_CODE_SESSION_ID: "parent", CLAUDECODE: "1" }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const got = readFileSync(out, "utf8").split("\0").slice(0, -1);
    assert.deepEqual(got.slice(0, 2), ["unset", "unset"]);
    assert.deepEqual(got.slice(2), program(core.terminals[0]!).slice(1));
    assert.equal(got.at(-1), tricky);
  });
});

test("a second launch under the same session finds the first one's terminal instead of starting Claude again", async () => {
  const core = fakeCore();
  const guest = pylon(core, { transcripts: false });
  assert.equal(await openSession(guest, prompted), "t1");
  assert.equal(await openSession(guest, prompted), "t1");
  assert.equal(core.terminals.length, 1);
  assert.equal(runs(core).length, 1);
});

test("a launch that loses its name to one started beside it takes that one's terminal", async () => {
  let raced = false;
  const core = fakeCore({
    answer: (method, params, fake) => {
      if (method !== "terminal.run" || raced) return undefined;
      raced = true;
      fake.add({ name: params.name as string, argv: params.argv as string[], labels: params.labels as Record<string, string> });
      return coreError("name_taken", `a live terminal is already named ${JSON.stringify(params.name)}`);
    },
  });
  assert.equal(await openSession(pylon(core, { transcripts: false }), prompted), "t1");
  assert.equal(core.terminals.length, 1);
});

test("a launch sent again once a wake's relaunch runs its session, in a terminal of no name, waits for its receipt there and starts nothing", async () => {
  for (const transcripts of [false, [launched]]) {
    const core = fakeCore();
    const relaunched = core.add({ argv: [...launchWrapper, "claude", "--resume", launched], labels: { ...labels("claude-code", "worker"), "claude.session_id": launched }, status: status("idle") });
    assert.equal(await openSession(pylon(core, { transcripts }), prompted), relaunched.address, `transcripts ${String(transcripts)}`);
    assert.deepEqual(runs(core), [], `transcripts ${String(transcripts)}`);
  }
});

test("a launch whose receipt never comes stalls and leaves its terminal for the person, unless Claude is working on it", async () => {
  const idle = fakeCore({ start: (t) => { t.screen = "Choose the text style\n"; } });
  await assert.rejects(openSession(pylon(idle, { transcripts: false, submitted: false }), prompted),
    (err) => err instanceof LaunchStalled && err.terminal === "t1" && /Claude launch stalled: no UserPromptSubmit within 30 seconds; attach.*Choose the text style/s.test(err.message));
  assert.deepEqual(idle.terminals.map((t) => t.state), ["live"]);

  const working = fakeCore({ start: (t) => { t.status = status("working"); } });
  assert.equal(await openSession(pylon(working, { transcripts: false, submitted: false }), prompted), "t1");
});

test("a launch whose session already has a transcript starts nothing, and one under an ID Claude cannot take is refused", async () => {
  const core = fakeCore();
  await assert.rejects(openSession(pylon(core, { transcripts: [launched] }), prompted), /already has a transcript, so its first prompt went in before this launch, which started nothing/);
  await assert.rejects(openSession(pylon(core), { ...prompted, resume: "not an id" }), /needs a session ID of letters, digits and dashes/);
  assert.deepEqual([runs(core), core.terminals], [[], []]);
});

test("session facts read each terminal's harness from its foreground, its session from its label over its command line, its status from Core's word and its title from its label or name", async () => {
  const core = fakeCore();
  core.add({ argv: ["claude", "--resume", "aaaa"], labels: { "nexus.title": "review", "claude.session_id": "after-clear" }, status: status("working") });
  core.add({ argv: ["node", "/usr/local/bin/pi", "--session", "/s.jsonl"], name: "plan", status: status("idle") });
  core.add({ argv: ["pi", "--session", "/old.jsonl"], labels: { "pi.session_file": "/new.jsonl" }, status: status("done") });
  core.add({ argv: ["node", "/usr/local/bin/claude", "--session-id", "bbbb"], status: status("error") });
  core.add({ argv: ["claude", "--resume", "--model", "opus"], status: status("blocked") });
  core.add({ argv: ["codex", "resume", "cccc"], labels: { "nexus.title": "codex" }, status: status("idle") });
  core.add({ argv: ["bash", "-l"] });
  core.add({ argv: ["claude", "--resume", "dddd"], status: status("asleep") });
  const running = (terminal: string, harness: string, harnessSessionId: string | null, s: string, title: string) => ({ id: terminal, state: "running", terminal, harness, harnessSessionId, status: s, title });
  assert.deepEqual(await sessionFacts(pylon(core)), [
    running("t1", "claude-code", "after-clear", "working", "review"),
    running("t2", "pi", "/s.jsonl", "idle", "plan"),
    running("t3", "pi", "/new.jsonl", "idle", "pi"),
    running("t4", "claude-code", "bbbb", "idle", "Claude Code"),
    running("t5", "claude-code", null, "blocked", "Claude Code"),
    running("t6", "shell", null, "idle", "codex"),
    running("t7", "shell", null, "unknown", "Shell"),
    running("t8", "claude-code", "dddd", "unknown", "Claude Code"),
  ]);
});

test("a terminal Nexus started an agent in is that agent's while its launch's env and login shell still start it, so a pause then records the agent", async () => {
  const core = fakeCore();
  const starting = core.add({ argv: [...launchWrapper, "claude", "--resume", session, "--model", "opus"], labels: { ...labels("claude-code", "review"), "claude.session_id": session }, cwd: "/home/user/app" });
  slowStart(starting);
  const handRun = core.add({ argv: ["bash", "-l"], labels: labels("shell", "sh"), keep: true, foreground: { argv: ["claude", "--resume", "bbbb"], cwd: "/home/user", name: "claude" }, status: status("idle") });
  const guest = pylon(core);
  for (const foreground of [null, "env", "bash"]) {
    assert.deepEqual((await sessionFacts(guest)).map((f) => [f.terminal, f.harness, f.harnessSessionId, f.status]), [
      [starting.address, "claude-code", session, "unknown"],
      [handRun.address, "claude-code", "bbbb", "idle"],
    ], `while its foreground is ${foreground ?? "none"}`);
  }
  slowStart(starting);
  assert.deepEqual((await recordSessions(guest))!.map((r) => [r.terminal, r.harness, r.harnessSessionId, r.model]), [
    [starting.address, "claude-code", session, "opus"],
    [handRun.address, "claude-code", "bbbb", undefined],
  ], "a Claude a person started in a shell is that Claude's, by its foreground");
});

test("a core that cannot be read rejects rather than reading as no sessions", async () => {
  for (const [reply, error] of [
    [{ exitCode: null, output: "" }, /terminal\.list did not finish/],
    [{ exitCode: 127, output: "sh: herdr-core: not found" }, /terminal\.list exited 127 without a JSON reply/],
    [coreError("internal", "boom"), /terminal\.list: boom/],
    [coreOk({ terminals: [{ address: "t1", state: "asleep" }] }), Error],
  ] as const) {
    const core = fakeCore({ answer: (method) => method === "terminal.list" ? reply : undefined });
    await assert.rejects(sessionFacts(pylon(core)), error);
  }
});

test("recording writes every live terminal of this machine but those another terminal started, with its foreground's cwd and its model", async () => {
  const core = fakeCore();
  core.add({ argv: [...launchWrapper, "claude", "--resume", "aaaa", "--model", "opus"], labels: labels("claude-code", "review"), cwd: "/home/user/app", foreground: { argv: ["claude", "--resume", "aaaa", "--model", "opus"], cwd: "/home/user/app/src", name: "claude" } });
  core.add({ argv: ["pi", "--session", "/s.jsonl", "--model", "gpt"], labels: labels("pi", "plan"), cwd: "/home/user" });
  core.add({ argv: ["bash", "-l"], labels: labels("shell", "sh"), cwd: "/home/user", keep: true });
  core.add({ argv: ["claude", "--session-id", "child"], parent: "t1", name: "reviewer" });
  exits(core.add({ argv: ["make"] }), 0, "");
  core.add({ address: "laptop/t1", argv: ["bash", "-l"] });
  const guest = pylon(core);
  const recorded = await recordSessions(guest);
  assert.equal(guest.written.length, 1);
  const { path, owner, mode } = guest.written[0]!;
  assert.deepEqual([path, owner, mode], [sessionsFile, "user", 0o644]);
  const sessions: SessionRecord[] = [
    { terminal: "t1", harness: "claude-code", title: "review", cwd: "/home/user/app/src", model: "opus", harnessSessionId: "aaaa" },
    { terminal: "t2", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/s.jsonl" },
    { terminal: "t3", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ];
  assert.deepEqual(lastFile(guest), { version: 2, recordedAt: JSON.parse(guest.written[0]!.content).recordedAt, sessions, failed: [] });
  assert.deepEqual(recorded, sessions.map((r) => ({ ...r, id: r.terminal })), "each is reported under its terminal");
  assert.deepEqual((await sessionFacts(guest)).map((f) => f.terminal), ["t1", "t2", "t3", "t4"], "the child is reported, and no other machine's terminal is");
});

test("a read never starts a core: with none, a pylon reports only its failed sessions, records nothing and interrupts nothing", async () => {
  const failed = { record: { terminal: "t91", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/s.jsonl" }, inTerminal: false, message: "pi did not start" };
  const core = fakeCore({ running: false });
  const guest = pylon(core, { file: JSON.stringify({ version: 2, recordedAt: "2027-01-01T00:00:00Z", sessions: [], failed: [failed] }) });
  assert.deepEqual(await sessionFacts(guest), [{ id: "t91", state: "failed", terminal: null, harness: "pi", harnessSessionId: "/s.jsonl", status: "unknown", title: "plan", message: "pi did not start" }]);
  assert.equal(await recordSessions(guest), null);
  assert.deepEqual(guest.written, [], "the last sessions file stays in place");
  assert.equal(await interruptClaude(guest, "bd2c2d6b"), "not-running");
  assert.equal(await closeSession(guest, "t1"), "not-open");
  assert.equal(startedCore(guest), false);
  assert.equal(core.running, false);
});

const session = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
const claudeRunning = (core: FakeCore, state: string | null, extra: Partial<FakeTerminal> = {}) => core.add({ argv: ["claude", "--resume", session], status: status(state), ...extra });

test("after a core crash Claude runs on without a core: a read is unknown and records nothing, and a send or start takes it back where it runs rather than resume it beside itself", async () => {
  const core = fakeCore();
  const guest = pylon(core, { transcripts: true });
  const t = await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user", resume: session });
  core.crash();
  await assert.rejects(sessionFacts(guest), (err) => err instanceof Error && /no Herdr Core runs, but the programs of one that crashed still do/.test(err.message));
  await assert.rejects(recordSessions(guest), /crashed/);
  assert.deepEqual(guest.written, [], "the last record stands");
  assert.deepEqual(await sendToClaude(guest, { session, text: "still there?" }), { outcome: "sent", terminal: t, resumed: false });
  core.crash();
  assert.equal(await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user", resume: session }), t);
  assert.equal(runs(core).length, 1, "one Claude runs the session");
  assert.deepEqual(core.terminals.map((x) => [x.address, x.state, x.sent]), [[t, "live", ["still there?"]]]);
});

test("a message reaches Claude exactly as written in one send, queued behind a turn Claude is working on", async () => {
  const text = "x".repeat(63) + "😀" + "-n is no flag\n\"double\" 'single' `ticks` $HOME $(whoami) \\ backslash \\n\n!ls\n\n  indented\n";
  for (const [state, outcome] of [["idle", "sent"], ["done", "sent"], ["error", "sent"], ["working", "queued"]] as const) {
    const core = fakeCore();
    const t = claudeRunning(core, state);
    assert.deepEqual(await sendToClaude(pylon(core), { session, text }), { outcome, terminal: "t1", resumed: false }, state);
    assert.deepEqual(t.sent, [text], state);
  }
});

test("a message to a blocked Claude sends nothing, whether its status says so or Core refuses it", async () => {
  const core = fakeCore();
  const t = claudeRunning(core, "blocked");
  assert.deepEqual(await sendToClaude(pylon(core), { session, text: "yes" }), { outcome: "blocked", terminal: "t1", resumed: false });
  assert.deepEqual(t.sent, [], "the text would answer the dialog");

  const refusing = fakeCore({ answer: (method) => method === "terminal.send" ? coreError("blocked", "t1 is blocked") : undefined });
  const r = claudeRunning(refusing, "idle");
  assert.deepEqual(await sendToClaude(pylon(refusing), { session, text: "yes" }), { outcome: "blocked", terminal: "t1", resumed: false });
  assert.deepEqual(r.sent, []);
});

test("a send Core refuses as still starting, which types nothing, is sent again until Claude is ready, and reports starting once that runs out", async () => {
  let refusals = 2;
  const settling = fakeCore({ answer: (method, params) => method === "terminal.send" && refusals-- > 0 ? stillStarting(params.terminal as string) : undefined });
  const t = claudeRunning(settling, "idle");
  assert.deepEqual(await sendToClaude(pylon(settling), { session, text: "go" }, 5_000), { outcome: "sent", terminal: "t1", resumed: false });
  assert.deepEqual([t.sent, settling.calls.filter((c) => c.method === "terminal.send").length], [["go"], 3]);

  const unsettled = fakeCore({ answer: (method, params) => method === "terminal.send" ? stillStarting(params.terminal as string) : undefined });
  const never = claudeRunning(unsettled, "idle");
  assert.deepEqual(await sendToClaude(pylon(unsettled), { session, text: "go" }, 300), { outcome: "starting", terminal: "t1", resumed: false });
  assert.deepEqual(never.sent, []);
});

test("a Claude that has said nothing yet is waited for, and one still silent is reported blocked at a dialog or starting, with nothing sent", async () => {
  let gets = 0;
  const late = fakeCore({ answer: (method, _, fake) => { if (method === "terminal.get" && ++gets === 2) fake.terminals[0]!.status = status("idle"); return undefined; } });
  const answered = claudeRunning(late, null);
  assert.deepEqual(await sendToClaude(pylon(late), { session, text: "go" }, 5_000), { outcome: "sent", terminal: "t1", resumed: false });
  assert.deepEqual(answered.sent, ["go"]);

  for (const [screen, outcome] of [["Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n", "blocked"], ["", "starting"]] as const) {
    const core = fakeCore();
    const t = claudeRunning(core, null, { screen });
    assert.deepEqual(await sendToClaude(pylon(core), { session, text: "go" }, 300), { outcome, terminal: "t1", resumed: false }, outcome);
    assert.deepEqual(t.sent, [], outcome);
  }
});

test("a terminal that stops running the session before the send is sent nothing and says so", async () => {
  for (const [why, change] of [
    ["another Claude session", (t: FakeTerminal) => { t.labels["claude.session_id"] = "another-session"; }],
    ["pi", (t: FakeTerminal) => { t.foreground = { argv: ["node", "/usr/local/bin/pi"], cwd: t.cwd, name: "node" }; }],
  ] as const) {
    let changed = false;
    const core = fakeCore({ answer: (method, _, fake) => { if (method === "terminal.get" && !changed) { changed = true; change(fake.terminals[0]!); } return undefined; } });
    const t = claudeRunning(core, "idle");
    assert.deepEqual(await sendToClaude(pylon(core), { session, text: "go" }), { outcome: "moved", terminal: "t1", resumed: false }, why);
    assert.deepEqual(t.sent, [], why);
  }
});

test("a Claude terminal with no session label is found by the session its command line started", async () => {
  const core = fakeCore();
  const moved = claudeRunning(core, "idle", { labels: { "claude.session_id": "another-session" } });
  const other = core.add({ argv: ["claude", "--session-id", "another-one"], status: status("idle") });
  const found = core.add({ argv: ["node", "/usr/local/bin/claude", "--resume", session], status: status("idle") });
  assert.deepEqual(await sendToClaude(pylon(core), { session, text: "hi" }), { outcome: "sent", terminal: "t3", resumed: false });
  assert.deepEqual([moved.sent, other.sent, found.sent], [[], [], ["hi"]], "a terminal whose Claude moved on to another session, as after /clear, is not sent to");
});

test("a session in no live terminal is resumed in a new terminal in the checkout, then given the message", async () => {
  const core = fakeCore();
  claudeRunning(core, "idle", { labels: { "claude.session_id": "another-session" } });
  assert.deepEqual(await sendToClaude(pylon(core), { session, text: "pick it back up", model: "claude-opus-5-5" }), { outcome: "sent", terminal: "t2", resumed: true });
  const t = core.terminals[1]!;
  assert.deepEqual([t.cwd, t.labels], [checkoutDir, { ...labels("claude-code", "Claude Code"), "claude.session_id": session }]);
  assert.deepEqual(program(t).slice(0, 5), ["claude", "--resume", session, "--model", "claude-opus-5-5"]);
  assert.deepEqual(t.sent, ["pick it back up"]);
});

test("an agent's terminal a person kept is the agent's while it runs it, and the shell Core gives in its place is no session: a send resumes the agent and types into it only, and an interrupt or a close leaves the shell alone", async () => {
  const core = fakeCore();
  const guest = pylon(core, { transcripts: true });
  const t = await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user", resume: session });
  keptByHand(core, t);
  assert.deepEqual((await sessionFacts(guest)).map((f) => [f.terminal, f.harness, f.harnessSessionId]), [[t, "claude-code", session]], "a kept Claude that runs is Claude's");
  core.restart();
  const shell = core.terminals[0]!;
  assert.deepEqual([shell.state, shell.argv, shell.labels["nexus.harness"], shell.labels["claude.session_id"]], ["live", ["/bin/bash"], "claude-code", session], "Core gave a shell in Claude's place, under Claude's labels");
  assert.deepEqual(await sessionFacts(guest), [], "the shell is no session");
  assert.equal(await interruptClaude(guest, session), "not-running");
  assert.equal(await closeSession(guest, t, { harness: "claude-code", harnessSessionId: session, title: "review" }), "not-open");
  assert.deepEqual(await sendToClaude(guest, { session, text: "rm -rf ~/app" }), { outcome: "sent", terminal: "t2", resumed: true });
  assert.deepEqual([shell.state, shell.sent, shell.keys], ["live", [], []], "nothing was typed into the shell");
  const resumed = core.terminals.find((x) => x.address === "t2")!;
  assert.deepEqual([program(resumed).slice(0, 3), resumed.sent], [["claude", "--resume", session], ["rm -rf ~/app"]]);
});

test("a message reaching a recorded session before the relaunch resumes it as it was recorded, under the message's model if it names one", async () => {
  const file: SessionRecord[] = [{ terminal: "t91", harness: "claude-code", title: "review", cwd: "/home/user/app", harnessSessionId: session, model: "opus" }];
  for (const [model, started] of [[undefined, "opus"], ["sonnet", "sonnet"]] as const) {
    const core = fakeCore({ running: false });
    const guest = pylon(core, { file });
    assert.deepEqual(await sendToClaude(guest, { session, text: "go", ...(model === undefined ? {} : { model }) }), { outcome: "sent", terminal: "t1", resumed: true });
    const t = core.terminals[0]!;
    assert.deepEqual([t.cwd, t.labels, program(t).slice(0, 5)], ["/home/user/app", { ...labels("claude-code", "review"), "claude.session_id": session }, ["claude", "--resume", session, "--model", started]], started);
  }
});

test("a send that fails other than as blocked rejects, saying whether the message went in is unknown, and a terminal gone before it sends nothing", async () => {
  const failing = fakeCore({ answer: (method) => method === "terminal.send" ? { exitCode: null, output: "" } : undefined });
  claudeRunning(failing, "idle");
  await assert.rejects(sendToClaude(pylon(failing), { session, text: "go" }), /sending to Claude's terminal t1 failed, so whether the message went in is unknown: terminal\.send did not finish/);

  const gone = fakeCore({ answer: (method) => method === "terminal.get" ? coreError("not_found", "no terminal") : undefined });
  const t = claudeRunning(gone, "idle");
  await assert.rejects(sendToClaude(pylon(gone), { session, text: "go" }), /Claude's terminal t1 closed before it could take the message, so nothing was sent/);
  assert.deepEqual(t.sent, []);
});

test("an interrupt presses Esc, and only Esc, for a working Claude, and nothing for an idle Claude, a dialog or a state Core cannot tell", async () => {
  const core = fakeCore();
  const working = claudeRunning(core, "working");
  assert.equal(await interruptClaude(pylon(core), session), "interrupted");
  assert.deepEqual(working.keys, [["esc"]]);
  for (const [state, outcome] of [["idle", "idle"], ["done", "idle"], ["error", "idle"], ["blocked", "blocked"], [null, "unknown"]] as const) {
    const other = fakeCore();
    const t = claudeRunning(other, state);
    assert.equal(await interruptClaude(pylon(other), session), outcome, String(state));
    assert.deepEqual(t.keys, [], `nothing is pressed for a Claude that is ${state}`);
  }
});

test("an interrupt presses nothing and resumes nothing when no Claude runs the session", async () => {
  for (const [why, add] of [
    ["another session", (core: FakeCore) => claudeRunning(core, "working", { labels: { "claude.session_id": "another-session" } })],
    ["a shell", (core: FakeCore) => core.add({ argv: ["bash", "-l"], labels: { "claude.session_id": session } })],
    ["no terminal", () => undefined],
  ] as const) {
    const core = fakeCore();
    const t = add(core);
    assert.equal(await interruptClaude(pylon(core), session), "not-running", why);
    assert.deepEqual(t?.keys ?? [], [], why);
    assert.deepEqual(runs(core), [], `${why}: nothing is resumed`);
  }
  const closing = fakeCore({ answer: (method) => method === "terminal.keys" ? coreError("not_found", "no terminal") : undefined });
  claudeRunning(closing, "working");
  assert.equal(await interruptClaude(pylon(closing), session), "not-running", "a terminal that closed before Esc reached it");
});

test("closing a session removes its terminal, closes nothing that is gone or finished or with no core, and rejects other errors", async () => {
  const core = fakeCore();
  const guest = pylon(core);
  core.add({ argv: ["bash", "-l"], keep: true });
  exits(core.add({ argv: ["make"] }), 0, "");
  assert.equal(await closeSession(guest, "t1"), "closed");
  assert.deepEqual(core.terminals.map((t) => t.address), ["t2"], "the terminal is gone from the core");
  assert.equal(await closeSession(guest, "t2"), "not-open");
  assert.equal(await closeSession(guest, "t9"), "not-open");
  assert.equal(await closeSession(pylon(fakeCore({ running: false })), "t1"), "not-open");

  const failing = fakeCore({ answer: (method) => method === "terminal.kill" ? coreError("internal", "boom") : undefined });
  failing.add({});
  await assert.rejects(closeSession(pylon(failing), "t1"), /terminal\.kill: boom/);
});

test("a close that names its session leaves a terminal that runs another one open, such as one a wake gave that address", async () => {
  const core = fakeCore();
  core.add({ argv: ["claude", "--resume", "bbbb"], labels: labels("claude-code", "review"), status: status("idle") });
  core.add({ argv: ["bash", "-l"], labels: labels("shell", "sh") });
  const guest = pylon(core);
  const review = { harness: "claude-code", harnessSessionId: "aaaa", title: "review" } as const;
  assert.equal(await closeSession(guest, "t1", review), "moved");
  assert.equal(await closeSession(guest, "t1", { ...review, harness: "pi", harnessSessionId: "bbbb" }), "moved");
  assert.equal(await closeSession(guest, "t1", { ...review, harnessSessionId: "bbbb", title: "plan" }), "moved");
  assert.equal(await closeSession(guest, "t9", review), "not-open");
  assert.equal(core.terminals.length, 2, "nothing was closed");
  assert.equal(await closeSession(guest, "t2", { harness: "shell", harnessSessionId: null, title: null }), "closed", "what either side has not learned yet does not tell them apart");
  assert.equal(await closeSession(guest, "t1", { ...review, harnessSessionId: null }), "closed");
  assert.deepEqual(core.terminals, []);
});

test("a pylon that never paused has nothing to relaunch and starts no core", async () => {
  const core = fakeCore({ running: false });
  const guest = pylon(core);
  assert.deepEqual(await relaunchSessions(guest, unlocked), []);
  assert.equal(guest.execs.length, 1);
  assert.equal(startedCore(guest), false);
});

test("a wake brings a kept shell back in place and relaunches each agent in a new terminal under its session and model, and relaunching again opens nothing new", async () => {
  const core = fakeCore();
  const guest = pylon(core);
  await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user/app", resume: "aaaa", model: "opus" });
  await openSession(guest, { harness: "pi", title: "plan", cwd: "/home/user", resume: "/home/user/.pi/agent/sessions/s.jsonl" });
  await openSession(guest, { harness: "shell", title: "sh", cwd: "/home/user" });
  await recordSessions(guest);
  const byHand = core.add({ argv: ["make", "test"] });
  core.restart();

  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["review", "relaunched", "t5"], ["plan", "relaunched", "t6"], ["sh", "present", "t3"]]);
  const at = (address: string) => core.terminals.find((t) => t.address === address)!;
  assert.deepEqual([at("t5").cwd, at("t5").labels, program(at("t5")).slice(0, 7)], ["/home/user/app", { ...labels("claude-code", "review"), "claude.session_id": "aaaa" }, ["claude", "--resume", "aaaa", "--model", "opus", "--permission-mode", "bypassPermissions"]]);
  assert.deepEqual([at("t6").labels, program(at("t6"))], [{ ...labels("pi", "plan"), "pi.session_file": "/home/user/.pi/agent/sessions/s.jsonl" }, ["pi", "--session", "/home/user/.pi/agent/sessions/s.jsonl"]]);
  assert.deepEqual(core.terminals.map((t) => t.address), ["t3", byHand.address, "t5", "t6"], "the finished terminals Nexus opened are removed, and one opened by hand is left");
  assert.deepEqual(lastFile(guest).sessions.map((r) => r.terminal), ["t5", "t6", "t3"]);

  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["review", "present", "t5"], ["plan", "present", "t6"], ["sh", "present", "t3"]]);
  assert.equal(runs(core).length, 5, "the second relaunch started nothing");
});

test("a wake resumes, once, an agent whose kept terminal Core brought back as a shell, and removes that shell", async () => {
  const core = fakeCore();
  const guest = pylon(core, { transcripts: true });
  const t = await openSession(guest, { harness: "claude-code", title: "review", cwd: "/home/user/app", resume: session });
  const sh = await openSession(guest, { harness: "shell", title: "sh", cwd: "/home/user" });
  keptByHand(core, t);
  await recordSessions(guest);
  core.restart();

  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["review", "relaunched", "t3"], ["sh", "present", sh]]);
  assert.deepEqual(core.terminals.map((x) => x.address), [sh, "t3"], "the shell left in Claude's place is gone");
  assert.deepEqual(program(core.terminals[1]!).slice(0, 3), ["claude", "--resume", session]);
  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["review", "present", "t3"], ["sh", "present", sh]]);
  assert.equal(runs(core).length, 3, "Claude was resumed once");
});

test("a relaunch seeds Claude's state once for every Claude session it starts", async () => {
  const records: SessionRecord[] = [
    { terminal: "t91", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" },
    { terminal: "t92", harness: "claude-code", title: "plan", cwd: "/home/user", harnessSessionId: "bbbb" },
  ];
  const guest = pylon(fakeCore(), { file: records });
  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["review", "relaunched", "t1"], ["plan", "relaunched", "t2"]]);
  assert.equal(guest.execs.filter((a) => a[2] === seedClaudeState).length, 1);
});

test("a relaunch whose Claude seed fails fails only its Claude sessions", async () => {
  const records: SessionRecord[] = [
    { terminal: "t91", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" },
    { terminal: "t92", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ];
  const outcomes = await relaunchSessions(pylon(fakeCore(), { file: records, seed: { exitCode: 1, output: "invalid JSON" } }), unlocked);
  assert.deepEqual(outcomes.map((o) => [o.record.title, o.result, o.result === "failed" ? o.message : null]), [["review", "failed", "seeding Claude state failed: invalid JSON"], ["sh", "relaunched", null]]);
});

test("a core that does not start fails every session for its reason, and records them all as failed", async () => {
  const records: SessionRecord[] = [
    { terminal: "t91", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" },
    { terminal: "t92", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ];
  for (const [output, message] of [["", "Herdr Core did not start within 5 seconds"], ["tini: not found\n", "Herdr Core did not start within 5 seconds: tini: not found"]] as const) {
    const core = fakeCore({ running: false });
    const guest = pylon(core, { file: records, coreStart: { exitCode: 1, output } });
    const outcomes = await relaunchSessions(guest, unlocked);
    assert.deepEqual(outcomes.map((o) => [o.result, o.terminal, o.result === "failed" ? o.message : null]), [["failed", null, message], ["failed", null, message]]);
    assert.deepEqual(lastFile(guest), { ...lastFile(guest), sessions: [], failed: records.map((record) => ({ record, inTerminal: false, message })) });
    assert.deepEqual(core.calls, [], "no core call ran");
  }
});

test("shells that share a title are told apart by their cwd", async () => {
  const records: SessionRecord[] = [
    { terminal: "t91", harness: "shell", title: "sh", cwd: "/a", harnessSessionId: null },
    { terminal: "t92", harness: "shell", title: "sh", cwd: "/b", harnessSessionId: null },
  ];
  const core = fakeCore();
  core.add({ argv: ["bash", "-l"], labels: labels("shell", "sh"), cwd: "/b", keep: true });
  assert.deepEqual(placed(await relaunchSessions(pylon(core, { file: records }), unlocked)), [["sh", "relaunched", "t2"], ["sh", "present", "t1"]]);
  assert.equal(core.terminals[1]!.cwd, "/a");
});

test("an agent running another session is not the recorded one, even under the same title", async () => {
  const records: SessionRecord[] = [{ terminal: "t91", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" }];
  const core = fakeCore();
  const other = core.add({ argv: ["claude", "--resume", "bbbb"], labels: labels("claude-code", "review"), status: status("idle") });
  assert.deepEqual(placed(await relaunchSessions(pylon(core, { file: records }), unlocked)), [["review", "relaunched", "t2"]]);
  assert.deepEqual(program(core.terminals[1]!).slice(0, 3), ["claude", "--resume", "aaaa"]);
  assert.equal(other.state, "live", "the other session is left running");
});

test("a terminal another terminal started is neither claimed nor closed by a relaunch", async () => {
  const records: SessionRecord[] = [{ terminal: "t91", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" }];
  const core = fakeCore();
  const child = core.add({ argv: ["claude", "--resume", "aaaa"], labels: labels("claude-code", "review"), parent: "t50", status: status("idle") });
  assert.deepEqual(placed(await relaunchSessions(pylon(core, { file: records }), unlocked)), [["review", "relaunched", "t2"]]);
  assert.equal(child.state, "live");
});

test("a second record of one Claude session is dropped, and its terminal closed", async () => {
  const records: SessionRecord[] = [
    { terminal: "t91", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" },
    { terminal: "t92", harness: "claude-code", title: "Claude Code", cwd: "/home/user", harnessSessionId: "aaaa" },
  ];
  const both = fakeCore();
  both.add({ argv: ["claude", "--resume", "aaaa"], labels: labels("claude-code", "review"), status: status("idle") });
  both.add({ argv: ["claude", "--resume", "aaaa"], labels: labels("claude-code", "Claude Code"), status: status("idle") });
  const guest = pylon(both, { file: records });
  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["review", "present", "t1"], ["Claude Code", "dropped", "t2"]]);
  assert.deepEqual(both.terminals.map((t) => t.address), ["t1"]);
  assert.deepEqual(lastFile(guest).sessions.map((r) => r.title), ["review"]);

  const none = fakeCore();
  assert.deepEqual(placed(await relaunchSessions(pylon(none, { file: records }), unlocked)), [["review", "relaunched", "t1"], ["Claude Code", "dropped", null]]);
  assert.equal(runs(none).length, 1);
});

test("pi records of one session each come back in a terminal of their own, and only Claude Code sessions are held while the relaunch runs", async () => {
  const records: SessionRecord[] = [
    { terminal: "t91", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/s.jsonl" },
    { terminal: "t92", harness: "pi", title: "plan again", cwd: "/home/user", harnessSessionId: "/s.jsonl" },
    { terminal: "t93", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "bd2c2d6b" },
    { terminal: "t94", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ];
  const held: (readonly string[])[] = [];
  const outcomes = await relaunchSessions(pylon(fakeCore(), { file: records }), (sessions, work) => {
    held.push(sessions);
    return work();
  });
  assert.deepEqual(held, [["bd2c2d6b"]]);
  assert.deepEqual(placed(outcomes), [["plan", "relaunched", "t1"], ["plan again", "relaunched", "t2"], ["review", "relaunched", "t3"], ["sh", "relaunched", "t4"]]);
});

test("a session whose relaunch failed is recorded under its old address until a relaunch brings it back", async () => {
  const records: SessionRecord[] = [
    { terminal: "t91", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/s.jsonl" },
    { terminal: "t92", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ];
  let failing = true;
  const core = fakeCore({ start: (t) => { if (failing && t.foreground?.argv[0] === "pi") exits(t, 1, "pi: cannot open /s.jsonl\n"); } });
  const guest = pylon(core, { file: records });
  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["plan", "failed", null], ["sh", "relaunched", "t2"]]);
  const recorded = (await recordSessions(guest))!;
  assert.deepEqual(recorded, [
    { id: "t2", terminal: "t2", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
    { ...records[0], id: "t91", terminal: null },
  ], "Core never gives an address out again, so its old one names it");
  assert.deepEqual(pausedSessionsIn(guest.written.at(-1)!.content), recorded.map(({ cwd: _, ...s }) => s), "the file it wrote says the same, as a stopped disk's does");
  assert.deepEqual((await sessionFacts(guest)).at(-1), {
    id: "t91", state: "failed", terminal: null, harness: "pi", harnessSessionId: "/s.jsonl", status: "unknown", title: "plan", message: "pi exited with 1 as it started. The terminal showed:\npi: cannot open /s.jsonl",
  });
  assert.equal((await recordSessions(guest))![1]!.id, "t91", "the ID holds from one record to the next");
  failing = false;
  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["sh", "present", "t2"], ["plan", "relaunched", "t3"]]);
  assert.deepEqual((await recordSessions(guest))!.map((r) => r.terminal), ["t2", "t3"]);
  assert.deepEqual(lastFile(guest).failed, []);
});

test("a stalled relaunch keeps its terminal as the failed session's, until a relaunch finds it running", async () => {
  const records: SessionRecord[] = [{ terminal: "t91", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" }];
  let stalling = true;
  const core = fakeCore({ answer: (method) => stalling && (method === "terminal.wait" || method === "terminal.get") ? { exitCode: null, output: "" } : undefined });
  const guest = pylon(core, { file: records });
  const [outcome] = await relaunchSessions(guest, unlocked);
  assert.deepEqual([outcome!.result, outcome!.terminal], ["failed", "t1"]);
  assert.match(outcome!.result === "failed" ? outcome!.message : "", /Claude Code launch stalled/);
  stalling = false;
  assert.equal(await dropFailedSession(guest, "t1"), false, "one in a terminal is dropped by closing the terminal, not by its ID");
  assert.deepEqual(await recordSessions(guest), [{ ...records[0], terminal: "t1", id: "t1" }]);
  assert.deepEqual((await sessionFacts(guest)).map((f) => [f.id, f.state, f.terminal, f.harness, f.harnessSessionId, f.status]), [["t1", "failed", "t1", "claude-code", "aaaa", "idle"]], "its terminal is the failed session, with its status");
  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["review", "present", "t1"]]);
  assert.equal(runs(core).length, 1, "the session is not started twice");
  assert.deepEqual(lastFile(guest), { ...lastFile(guest), sessions: [{ ...records[0], terminal: "t1" }], failed: [] });
});

test("a failed session left in its terminal is dropped by closing that terminal", async () => {
  const records: SessionRecord[] = [{ terminal: "t91", harness: "claude-code", title: "review", cwd: "/home/user", harnessSessionId: "aaaa" }];
  let stalling = true;
  const core = fakeCore({ answer: (method) => stalling && (method === "terminal.wait" || method === "terminal.get") ? { exitCode: null, output: "" } : undefined });
  const guest = pylon(core, { file: records });
  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["review", "failed", "t1"]]);
  stalling = false;
  assert.equal(await closeSession(guest, "t1", { harness: "claude-code", harnessSessionId: "aaaa", title: "review" }), "closed", "it is the session the failed record names");
  assert.deepEqual(await recordSessions(guest), []);
  assert.deepEqual(await sessionFacts(guest), []);
});

test("dropping a failed session in no terminal removes it from the sessions file, so no wake tries it again", async () => {
  const records: SessionRecord[] = [{ terminal: "t91", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/s.jsonl" }];
  const guest = pylon(fakeCore({ start: (t) => exits(t, 1, "") }), { file: records });
  assert.deepEqual(placed(await relaunchSessions(guest, unlocked)), [["plan", "failed", null]]);
  assert.equal(await dropFailedSession(guest, "t1"), false, "another address does not name it");
  assert.equal(await dropFailedSession(guest, "t91"), true);
  assert.deepEqual(lastFile(guest).failed, []);
  assert.deepEqual(await sessionFacts(guest), []);
  assert.deepEqual(await relaunchSessions(guest, unlocked), []);
  assert.equal(await dropFailedSession(guest, "t91"), false, "dropping it again finds nothing");
  assert.equal(await dropFailedSession(pylon(fakeCore()), "t91"), false, "nor does a pylon that never paused");
});

test("Claude user state merges onboarding, trust and bypass acceptance without losing login or hooks", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm, realpath } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  const home = await realpath(await mkdtemp(join(tmpdir(), "nexus-claude-state-")));
  const checkout = join(home, "repo");
  await mkdir(checkout);
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"));
  const original = { oauthAccount: { accountUuid: "keep" }, projects: { [checkout]: { allowedTools: ["Read"] }, "/elsewhere": { hasTrustDialogAccepted: false } } };
  const settings = { theme: "light", effortLevel: "low", model: "claude-sonnet-5-5", attribution: { commit: "old trailer", pr: "old footer", extra: "keep" }, hooks: { Stop: [{ hooks: [{ command: "keep" }] }] }, enabledPlugins: { pstack: true } };
  await writeFile(join(home, ".claude.json"), JSON.stringify(original));
  await writeFile(join(home, ".claude/settings.json"), JSON.stringify(settings));
  for (let i = 0; i < 2; i++) execFileSync("node", ["-e", seedClaudeState, checkout], { env: { ...process.env, HOME: home } });
  assert.deepEqual(JSON.parse(await readFile(join(home, ".claude.json"), "utf8")), { ...original, hasCompletedOnboarding: true, projects: { ...original.projects, [checkout]: { allowedTools: ["Read"], hasTrustDialogAccepted: true } } });
  assert.deepEqual(JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8")), { ...settings, model: "claude-opus-5-5", effortLevel: "high", attribution: { commit: "", pr: "", extra: "keep" }, skipDangerousModePermissionPrompt: true });
});

test("Claude seeding remerges concurrent updates, preserves modes and writes nothing once seeded", async (t) => {
  const fs = await import("node:fs");
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

test("resuming a session at root or HOME seeds only the pylon checkout", async () => {
  for (const cwd of ["/", "/home/user"]) {
    const records: SessionRecord[] = [{ terminal: "t91", harness: "claude-code", title: "review", cwd, harnessSessionId: "bd2c2d6b" }];
    const guest = pylon(fakeCore(), { file: records });
    assert.equal((await relaunchSessions(guest, unlocked))[0]!.result, "relaunched");
    assert.deepEqual(guest.execs.filter((argv) => argv[2] === seedClaudeState).map((argv) => argv[3]), [checkoutDir]);
  }
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
  const claude = { terminal: "t1", harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", harnessSessionId: "s-1", model: "opus" };
  const shell = { terminal: "t2", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null };
  const failed = { record: { terminal: "t3", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/s.jsonl" }, inTerminal: false, message: "pi did not start" };
  const file = { version: 2, recordedAt: "2027-01-01T00:00:00Z", sessions: [{ ...claude, ...unknown }, { ...shell, ...unknown }], failed: [{ ...failed, record: { ...failed.record, ...unknown }, ...unknown }], ...unknown };
  assert.deepEqual(pausedSessionsIn(JSON.stringify(file)), [
    { id: "t1", terminal: "t1", harness: "claude-code", title: "review", harnessSessionId: "s-1" },
    { id: "t2", terminal: "t2", harness: "shell", title: "sh", harnessSessionId: null },
    { id: "t3", terminal: null, harness: "pi", title: "plan", harnessSessionId: "/s.jsonl" },
  ]);
  const { harnessSessionId: _, ...noSessionId } = shell;
  const bad: unknown[] = [
    null, [], { ...file, version: 3 }, { ...file, recordedAt: "" }, { ...file, sessions: null }, { ...file, failed: undefined },
    { ...file, sessions: [{ ...shell, harness: "codex" }] }, { ...file, sessions: [{ ...shell, title: "" }] }, { ...file, sessions: [{ ...shell, cwd: 1 }] }, { ...file, sessions: [{ ...shell, terminal: undefined }] },
    { ...file, sessions: [{ ...claude, model: "" }] }, { ...file, sessions: [{ ...shell, harnessSessionId: "" }] }, { ...file, sessions: [null] },
    { ...file, sessions: [{ ...shell, harness: "toString" }] }, { ...file, sessions: [{ ...shell, harness: "constructor" }] },
    { ...file, failed: [{ ...failed, inTerminal: "no" }] }, { ...file, failed: [{ ...failed, message: "" }] }, { ...file, failed: [{ ...failed, record: null }] },
  ];
  for (const value of bad) assert.throws(() => pausedSessionsIn(JSON.stringify(value)), Error, JSON.stringify(value));
  assert.deepEqual(pausedSessionsIn(JSON.stringify({ ...file, sessions: [noSessionId], failed: [] })), [{ id: "t2", terminal: "t2", harness: "shell", title: "sh", harnessSessionId: null }], "a missing session ID reads as none");
});

test("a sessions file a probe of contract 1 wrote under herdrPane and inPane is read as its sessions, and the wake's record writes version 2", async () => {
  const shell = { herdrPane: "t1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null };
  const pi = { herdrPane: "t2", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/s.jsonl" };
  const failed = { record: { herdrPane: "t3", harness: "pi", title: "notes", cwd: "/home/user", harnessSessionId: "/n.jsonl" }, inPane: false, message: "pi did not start" };
  const old = { version: 1, recordedAt: "2027-01-01T00:00:00Z", sessions: [shell, pi], failed: [failed] };
  assert.deepEqual(pausedSessionsIn(JSON.stringify(old)), [
    { id: "t1", terminal: "t1", harness: "shell", title: "sh", harnessSessionId: null },
    { id: "t2", terminal: "t2", harness: "pi", title: "plan", harnessSessionId: "/s.jsonl" },
    { id: "t3", terminal: null, harness: "pi", title: "notes", harnessSessionId: "/n.jsonl" },
  ]);
  const { herdrPane, ...renamed } = shell;
  for (const value of [{ ...old, sessions: [{ ...renamed, terminal: herdrPane }] }, { ...old, version: 2 }, { ...old, failed: [{ record: failed.record, inTerminal: false, message: failed.message }] }]) {
    assert.throws(() => pausedSessionsIn(JSON.stringify(value)), Error, `each version takes only its own names: ${JSON.stringify(value)}`);
  }

  const core = fakeCore();
  const guest = pylon(core, { file: JSON.stringify(old) });
  assert.deepEqual((await relaunchSessions(guest, unlocked)).map((o) => [o.record.title, o.result]), [["sh", "relaunched"], ["plan", "relaunched"], ["notes", "relaunched"]]);
  const file = JSON.parse(guest.written.findLast((f) => f.path === sessionsFile)!.content) as { version: number; sessions: Record<string, unknown>[]; failed: unknown[] };
  assert.equal(file.version, 2);
  assert.deepEqual(file.sessions.map((r) => [r["title"], typeof r["terminal"], "herdrPane" in r]), [["sh", "string", false], ["plan", "string", false], ["notes", "string", false]]);
  assert.deepEqual(file.failed, []);
});

test("attached terminals are the core's viewers, which pgrep counts, and a count pgrep did not give rejects", async () => {
  const counting = (reply: ExecReply) => fakeGuest(() => reply);
  const guest = counting({ exitCode: 0, output: "2\n" });
  assert.equal(await attachedTerminals(guest), 2);
  assert.deepEqual(guest.execs, [["pgrep", "-c", "-x", "-f", coreViewer]]);
  assert.equal(await attachedTerminals(counting({ exitCode: 1, output: "0\n" })), 0, "pgrep exits 1 for none");
  await assert.rejects(attachedTerminals(counting({ exitCode: 2, output: "pgrep: bad regex\n" })), /counting attached terminals: pgrep exited 2: pgrep: bad regex/);
  await assert.rejects(attachedTerminals(counting({ exitCode: 0, output: "" })), /pgrep exited 0/);
});
