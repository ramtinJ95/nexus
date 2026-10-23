/**
 * Node validation for sessions.ts against a real Herdr, which the unit tests only fake. Run it inside a
 * scratch pylon as `user`, from a copy of src/, with the image's Node 24:
 *
 *   node src/sessions.check.ts
 *
 * It drives a local Guest (execFile and fs), so every Herdr call is the one the probe makes. It stops the
 * pylon's Herdr server twice and deletes its persisted state, which ends every session in it, so never
 * run it in a pylon someone uses.
 *
 * Two wakes. RESTORE stops the server and keeps Herdr's state, the way a checkpoint carries it, so Herdr
 * restores its panes, titles and cwds. The pylon's Herdr config turns off Herdr's own agent resume, so the
 * relaunch must start each agent in its restored pane. FRESH also deletes that state with
 * `herdr session delete`, so the relaunch must recreate every pane and resume each agent from the sessions
 * file alone. In both, each agent pane must then run its agent with the flag that resumes its session.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Guest } from "./backend.ts";
import type { SessionFact } from "./protocol.ts";
import { closeSession, herdrSession, openSession, recordSessions, relaunchSessions, sessionFacts, type RelaunchOutcome, type SessionRecord } from "./sessions.ts";

const cwd = "/home/user";
const shellCwd = "/home/user/check-shell-cwd";
const guest: Guest = {
  exec: (argv, opts) => new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { cwd: opts.cwd, timeout: opts.timeoutMs }, (err, stdout, stderr) => {
      const killed = err !== null && "killed" in err && err.killed;
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 127;
      resolve({ exitCode: killed ? null : code, output: stdout + stderr, truncated: false });
    });
  }),
  async writeFiles(files) {
    for (const f of files) {
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.content, { mode: f.mode });
    }
  },
  stream: () => Promise.reject(new Error("unused")),
  services: () => Promise.reject(new Error("unused")),
  startService: () => Promise.reject(new Error("unused")),
  linkPort: () => Promise.reject(new Error("unused")),
  previewOrigin: () => { throw new Error("unused"); },
};

const step = (name: string, value: unknown) => console.log(`${name}: ${JSON.stringify(value, null, 2)}`);
const herdr = (...args: string[]) => guest.exec(["herdr", "--session", herdrSession, ...args], { cwd, timeoutMs: 70_000 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failed outcome's message carries the pane's screen, which a rollback has already closed, so print it raw. */
function stepRelaunch(name: string, outcomes: readonly RelaunchOutcome[]): void {
  step(name, outcomes);
  for (const o of outcomes) if (o.result === "failed") console.log(`${name}_FAILED ${o.record.title}:\n${o.message}`);
}

/** Polls until every agent pane among `panes` reports a harness session ID, so the facts are settled. */
async function settledFacts(panes: readonly string[]): Promise<readonly SessionFact[]> {
  let facts = await sessionFacts(guest);
  for (let deadline = Date.now() + 30_000; Date.now() < deadline; facts = await sessionFacts(guest)) {
    const mine = facts.filter((f) => panes.includes(f.herdrPane));
    if (mine.length === panes.length && mine.every((f) => f.harness === "shell" || f.harnessSessionId !== null)) break;
    await sleep(500);
  }
  return facts;
}

/**
 * The shell and foreground PIDs Herdr reports for a pane. A pane Herdr is still restoring may not answer
 * yet, so an error reply is retried for 10 s, and every raw reply that is not a process_info is logged.
 */
async function panePids(pane: string): Promise<number[]> {
  for (const deadline = Date.now() + 10_000; ;) {
    const reply = await herdr("pane", "process-info", "--pane", pane);
    const line = reply.output.trim().split("\n").findLast((l) => l.startsWith("{"));
    const parsed = line === undefined ? undefined : JSON.parse(line);
    const info = parsed?.result?.process_info;
    if (info !== undefined) {
      const foreground: { pid: number }[] = info.foreground_processes ?? [];
      return [info.shell_pid, ...foreground.map((p) => p.pid)].filter((pid): pid is number => typeof pid === "number");
    }
    step(`PROCESS_INFO_${pane}`, reply);
    if (Date.now() >= deadline) throw new Error(`herdr pane process-info --pane ${pane} gave no process_info within 10 s: ${reply.output}`);
    await sleep(500);
  }
}

/**
 * `ps -o pid,ppid,pgid,sid,stat,args` for one PID, read from /proc as ps does, because the image may not
 * ship procps. Null once the process is gone.
 */
function psRow(pid: number): string | null {
  let stat: string, cmdline: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
  // The command name sits in parentheses and may itself contain spaces or parentheses.
  const [state, ppid, pgid, sid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const args = cmdline.split("\0").join(" ").trim();
  return [pid, ppid, pgid, sid, state, args].join(" ");
}

async function stopServer(stage: string, panes: readonly string[]): Promise<void> {
  const pids = [...new Set((await Promise.all(panes.map(panePids))).flat())];
  step(`${stage}_PS_BEFORE_STOP`, ["PID PPID PGID SID STAT ARGS", ...pids.flatMap((pid) => psRow(pid) ?? [])]);
  step(`${stage}_SERVER_STOP`, await herdr("server", "stop"));
  assert.deepEqual(await sessionFacts(guest), [], "no Herdr server reads as no sessions");
  const remaining = () => pids.filter((pid) => psRow(pid) !== null);
  for (let deadline = Date.now() + 5_000; remaining().length > 0 && Date.now() < deadline;) await sleep(100);
  step(`${stage}_PS_AFTER_STOP`, ["PID PPID PGID SID STAT ARGS", ...pids.flatMap((pid) => psRow(pid) ?? [])]);
  // Gone means reaped too: a zombie here would mean tini is not the subreaper over Herdr's panes.
  assert.deepEqual(remaining(), [], `${stage}: stopping the server ends and reaps every pane's processes`);
}

function assertResumed(stage: string, recorded: readonly SessionRecord[], facts: readonly SessionFact[]): void {
  for (const r of recorded) {
    if (r.harnessSessionId === null || unpromptedTitles.includes(r.title)) continue;
    assert.ok(facts.some((f) => f.harness === r.harness && f.harnessSessionId === r.harnessSessionId), `${stage}: ${r.title} came back as its own ${r.harness} session`);
  }
}

/**
 * Agent sessions that have a session ID but were never prompted, so neither has a session file: Claude
 * Code has written no transcript and pi no session file. What a user would see is the test: after a
 * relaunch each pane runs a live agent under the same session ID, not an agent's exit at a shell prompt.
 * Findings are collected rather than asserted at once, so one run reports both stages.
 */
const unprompted = { claude: "check-claude-unprompted", pi: "check-pi-unprompted" } as const;
const unpromptedTitles: readonly string[] = Object.values(unprompted);
const findings: string[] = [];
const others = (outcomes: readonly RelaunchOutcome[]) => outcomes.filter((o) => !unpromptedTitles.includes(o.record.title));
const projects = "/home/user/.claude/projects";

/** The files on disk that hold a harness session: Claude Code's transcript, or pi's session file itself. */
const sessionFiles = (harness: SessionRecord["harness"], id: string): string[] => harness === "pi"
  ? existsSync(id) ? [id] : []
  : existsSync(projects) ? readdirSync(projects).map((dir) => join(projects, dir, `${id}.jsonl`)).filter((file) => existsSync(file)) : [];

async function checkUnprompted(stage: string, title: string, outcomes: readonly RelaunchOutcome[], facts: readonly SessionFact[]): Promise<void> {
  const o = outcomes.find((x) => x.record.title === title);
  if (o === undefined) return void findings.push(`${stage}: no record of ${title}`);
  if (o.result === "failed") return void findings.push(`${stage}: ${title} failed to relaunch: ${o.message}`);
  const fact = facts.find((f) => f.herdrPane === o.herdrPane);
  const sameSessionId = fact?.harnessSessionId === o.record.harnessSessionId;
  step(`${stage}_${title}`, { outcome: o.result, fact, sameSessionId });
  // Always, because Herdr can call an agent idle while it shows an error or a session picker.
  step(`${stage}_${title}_PS`, ["PID PPID PGID SID STAT ARGS", ...(await panePids(o.herdrPane)).flatMap((pid) => psRow(pid) ?? [])]);
  const read = (await herdr("pane", "read", o.herdrPane, "--source", "recent-unwrapped", "--lines", "40")).output.trim();
  let text: unknown = read;
  try {
    text = JSON.parse(read.split("\n").at(-1)!).result?.read?.text ?? read;
  } catch {
    // Not a JSON reply, so the raw output is the screen.
  }
  console.log(`${stage}_${title}_SCREEN:\n${text}`);
  if (fact?.harness !== o.record.harness) findings.push(`${stage}: ${title}'s pane ${o.herdrPane} reads as ${fact?.harness ?? "nothing"}, not ${o.record.harness}`);
  else if (!sameSessionId) findings.push(`${stage}: ${title} came back as ${fact.harnessSessionId}, not ${o.record.harnessSessionId}`);
}

/**
 * What a user sees in each agent's pane: the agent runs its recorded session. Herdr's agent fact is not
 * evidence, because it stays `claude` after Claude exits. A Claude must run with the flag that resumes its
 * session. pi's flags cannot be read back, because its CLI sets process.title, which overwrites its argv
 * in /proc, so a pi must instead write a prompt into the session file at the recorded path.
 */
async function expectRuns(stage: string, outcomes: readonly RelaunchOutcome[]): Promise<ReadonlySet<string>> {
  const broken = new Set<string>();
  const fail = (title: string, finding: string) => {
    broken.add(title);
    findings.push(finding);
  };
  for (const o of outcomes) {
    const { harness, harnessSessionId: id, title } = o.record;
    if (harness === "shell" || id === null) continue;
    if (o.result === "failed") {
      fail(title, `${stage}: ${title} failed to relaunch: ${o.message}`);
      continue;
    }
    if (harness === "pi") {
      const finding = await piWrites(stage, title, o.herdrPane, id);
      if (finding !== null) fail(title, finding);
      continue;
    }
    const flag = title === unprompted.claude ? "--session-id" : "--resume";
    const rows = (await panePids(o.herdrPane)).flatMap((pid) => psRow(pid) ?? []);
    step(`${stage}_RUNS_${title}`, ["PID PPID PGID SID STAT ARGS", ...rows]);
    if (!rows.some((row) => row.includes(` ${flag} ${id}`))) fail(title, `${stage}: ${title}'s pane runs no ${harness} with ${flag} ${id}`);
  }
  return broken;
}

/**
 * Prompts a pi pane and waits for the message to reach `file`: a resumed session's file grows, and an
 * unprompted session's file first appears. The placeholder key makes the reply fail, but pi writes the
 * user message first. Returns the finding, or null.
 */
async function piWrites(stage: string, title: string, pane: string, file: string): Promise<string | null> {
  const size = () => existsSync(file) ? statSync(file).size : null;
  const before = size();
  step(`${stage}_PROMPT_${title}`, await herdr("agent", "prompt", pane, "Reply with OK.", "--wait", "--timeout", "60000"));
  const wrote = () => {
    const after = size();
    return after !== null && (before === null || after > before);
  };
  for (const deadline = Date.now() + 10_000; !wrote() && Date.now() < deadline;) await sleep(250);
  step(`${stage}_${title}_SESSION_FILE`, { file, before, after: size() });
  if (title === unprompted.pi ? before !== null : before === null) return `${stage}: ${title}'s session file ${before === null ? "was missing" : "already existed"} before the prompt`;
  return wrote() ? null : `${stage}: a prompt to ${title} never reached its session file ${file}`;
}

/** At record time an unprompted session must still have no session file, or its stage tests nothing. */
function expectNoSessionFiles(stage: string, records: readonly SessionRecord[]): void {
  for (const r of records) {
    if (!unpromptedTitles.includes(r.title) || r.harnessSessionId === null) continue;
    const files = sessionFiles(r.harness, r.harnessSessionId);
    step(`${stage}_${r.title}_FILES_AT_RECORD`, { id: r.harnessSessionId, files });
    if (files.length > 0) findings.push(`${stage}: ${r.title} had a session file before any prompt: ${files.join(", ")}`);
  }
}

/** A stop can let an agent write its session file as it exits. A pylon stopped hard leaves none, so remove it. */
function dropAppearedSessionFiles(stage: string, records: readonly SessionRecord[]): void {
  step(`${stage}_TRANSCRIPTS_BEFORE_RELAUNCH`, transcripts());
  for (const r of records) {
    if (!unpromptedTitles.includes(r.title) || r.harnessSessionId === null) continue;
    const files = sessionFiles(r.harness, r.harnessSessionId);
    step(`${stage}_${r.title}_FILES_BEFORE_RELAUNCH`, { id: r.harnessSessionId, files });
    for (const file of files) {
      step(`${stage}_${r.title}_FILE_APPEARED`, { file, bytes: statSync(file).size, content: readFileSync(file, "utf8").slice(0, 2000) });
      rmSync(file);
    }
  }
}

/** Every Claude Code transcript on disk, with its size, so a log shows when one appears. */
const transcripts = () => existsSync(projects)
  ? readdirSync(projects).flatMap((dir) => readdirSync(join(projects, dir)).filter((f) => f.endsWith(".jsonl")).map((f) => `${dir}/${f} ${statSync(join(projects, dir, f)).size}`))
  : [];

// Herdr's own agent resume would run `claude --resume` for an unprompted Claude, which exits to a bare shell.
const herdrConfig = process.env.HERDR_CONFIG_PATH ?? "/home/user/.config/herdr/config.toml";
const herdrToml = existsSync(herdrConfig) ? readFileSync(herdrConfig, "utf8") : "";
step("HERDR_CONFIG", { path: herdrConfig, content: herdrToml });
assert.match(herdrToml, /^\[session\][^[]*^\s*resume_agents_on_restore\s*=\s*false\s*$/m, `${herdrConfig} turns off Herdr's own agent resume`);

// OPEN
await mkdir(shellCwd, { recursive: true });
const opened = {
  shell: await openSession(guest, { harness: "shell", title: "check-shell", cwd: shellCwd }),
  claude: await openSession(guest, { harness: "claude-code", title: "check-claude", cwd }),
  pi: await openSession(guest, { harness: "pi", title: "check-pi", cwd }),
  unpromptedClaude: await openSession(guest, { harness: "claude-code", title: unprompted.claude, cwd }),
  unpromptedPi: await openSession(guest, { harness: "pi", title: unprompted.pi, cwd }),
};
step("OPENED", opened);
const facts = await settledFacts(Object.values(opened));
step("FACTS", facts);
const byPane = new Map(facts.map((f) => [f.herdrPane, f]));
assert.equal(byPane.get(opened.shell)?.harness, "shell");
assert.equal(byPane.get(opened.claude)?.harness, "claude-code", "Herdr detects Claude Code in its pane");
assert.equal(byPane.get(opened.pi)?.harness, "pi", "Herdr detects pi in its pane");
assert.ok(byPane.get(opened.claude)?.harnessSessionId, "Claude Code reports its session ID through Herdr's integration");
assert.ok(byPane.get(opened.pi)?.harnessSessionId, "pi reports its session file through Herdr's integration");
assert.ok(byPane.get(opened.unpromptedClaude)?.harnessSessionId, "an unprompted Claude Code reports its session ID too");
assert.equal(byPane.get(opened.unpromptedPi)?.harness, "pi", "Herdr detects an unprompted pi in its pane");
assert.ok(byPane.get(opened.unpromptedPi)?.harnessSessionId, "an unprompted pi reports its session file too");

// A session is only worth resuming once it has a conversation, and Claude Code cannot resume an ID with
// no transcript. The placeholder key makes the reply fail, but the prompt is still written down.
for (const pane of [opened.claude, opened.pi]) step(`PROMPT_${pane}`, await herdr("agent", "prompt", pane, "Reply with OK.", "--wait", "--timeout", "60000"));
step("TRANSCRIPTS", {
  claude: sessionFiles("claude-code", byPane.get(opened.claude)!.harnessSessionId!),
  pi: sessionFiles("pi", byPane.get(opened.pi)!.harnessSessionId!),
  all: transcripts(),
});

// RESTORE: Herdr's own state survives, as it does in a checkpoint.
const recorded = await recordSessions(guest);
step("RESTORE_RECORDED", recorded);
assert.ok(recorded !== null && recorded.length === 5, "the five sessions are recorded");
expectNoSessionFiles("RESTORE", recorded);
await stopServer("RESTORE", Object.values(opened));
dropAppearedSessionFiles("RESTORE", recorded);
const restored = await relaunchSessions(guest);
stepRelaunch("RESTORE_RELAUNCH_1", restored);
assert.ok(others(restored).every((o) => o.result !== "failed"), "every recorded session comes back");
// Herdr keeps the layout, so each session is back in its own pane, and only the relaunch started agents.
for (const o of restored) {
  const want = o.record.harness === "shell" ? "present" : "relaunched";
  if (o.result !== want || o.herdrPane !== o.record.herdrPane) findings.push(`RESTORE: ${o.record.title} is ${o.result} in ${"herdrPane" in o ? o.herdrPane : "no pane"}, not ${want} in its restored pane ${o.record.herdrPane}`);
}
const brokenByRestore = await expectRuns("RESTORE", restored);
const restoredAgain = await relaunchSessions(guest);
stepRelaunch("RESTORE_RELAUNCH_2", restoredAgain);
assert.ok(others(restoredAgain).every((o) => o.result === "present"), "a second relaunch opens nothing");
const restoredPanes = restoredAgain.flatMap((o) => o.result === "failed" ? [] : [o.herdrPane]);
const afterRestore = await settledFacts(restoredPanes);
step("RESTORE_FACTS", afterRestore);
assertResumed("RESTORE", recorded, afterRestore);
for (const title of unpromptedTitles) await checkUnprompted("RESTORE", title, restoredAgain, afterRestore);
// FRESH needs unprompted sessions of its own: RESTORE's prompt gave the unprompted pi a session file, and
// an unprompted Claude that RESTORE broke would be recorded as a shell.
for (const [harness, title] of [["claude-code", unprompted.claude], ["pi", unprompted.pi]] as const) {
  if (harness === "claude-code" && !brokenByRestore.has(title)) continue;
  // Every pane left under its title, including a restored shell that a failed relaunch leaves behind.
  for (const r of (await recordSessions(guest)) ?? []) {
    if (r.title !== title) continue;
    await closeSession(guest, r.herdrPane);
    if (restoredPanes.includes(r.herdrPane)) restoredPanes.splice(restoredPanes.indexOf(r.herdrPane), 1);
  }
  const pane = await openSession(guest, { harness, title, cwd });
  restoredPanes.push(pane);
  step(`FRESH_${title}_REOPENED`, (await settledFacts([pane])).find((f) => f.herdrPane === pane));
}

// FRESH: Herdr's state is gone, so only the sessions file can bring the sessions back.
const recordedAgain = await recordSessions(guest);
step("FRESH_RECORDED", recordedAgain);
assert.ok(recordedAgain !== null && recordedAgain.length === 5);
const restoredShell = recordedAgain.find((r) => r.harness === "shell");
if (restoredShell?.title !== "check-shell" || restoredShell.cwd !== shellCwd) findings.push(`RESTORE: the shell came back as ${JSON.stringify(restoredShell)}`);
for (const title of unpromptedTitles) assert.ok(recordedAgain.find((r) => r.title === title)?.harnessSessionId, `${title} is recorded with its ID`);
expectNoSessionFiles("FRESH", recordedAgain);
await stopServer("FRESH", restoredPanes);
const deleted = await herdr("session", "delete", herdrSession, "--json");
step("FRESH_SESSION_DELETE", deleted);
assert.equal(deleted.exitCode, 0, "Herdr deletes the stopped session's state");
dropAppearedSessionFiles("FRESH", recordedAgain);
const fresh = await relaunchSessions(guest);
stepRelaunch("FRESH_RELAUNCH_1", fresh);
assert.deepEqual(others(fresh).map((o) => o.result), ["relaunched", "relaunched", "relaunched"], "with no Herdr state, every session is recreated");
const freshPanes = fresh.flatMap((o) => o.result === "relaunched" ? [o.herdrPane] : []);
const afterFresh = await settledFacts(freshPanes);
step("FRESH_FACTS", afterFresh);
assertResumed("FRESH", recordedAgain, afterFresh);
for (const title of unpromptedTitles) await checkUnprompted("FRESH", title, fresh, afterFresh);
await expectRuns("FRESH", fresh);
const freshRecords = await recordSessions(guest);
step("FRESH_RECORDS", freshRecords);
const freshShell = fresh.find((o) => o.record.harness === "shell");
const shell = freshRecords?.find((r) => freshShell?.result === "relaunched" && r.herdrPane === freshShell.herdrPane);
assert.deepEqual(shell && { harness: shell.harness, title: shell.title, cwd: shell.cwd }, { harness: "shell", title: "check-shell", cwd: shellCwd }, "the shell comes back with its title and cwd");
const freshAgain = await relaunchSessions(guest);
stepRelaunch("FRESH_RELAUNCH_2", freshAgain);
assert.ok(others(freshAgain).every((o) => o.result === "present"), "a second relaunch after a fresh one opens nothing");

// CLOSE
for (const o of freshAgain) if (o.result !== "failed") await closeSession(guest, o.herdrPane);
await closeSession(guest, "w999:p999");
const closed = await sessionFacts(guest);
step("FACTS_AFTER_CLOSE", closed);
assert.deepEqual(closed.filter((f) => freshPanes.includes(f.herdrPane)), [], "closed sessions are gone");
step("FINDINGS", findings);
assert.deepEqual(findings, [], "after both wakes every agent pane runs its agent, resumed with the right flag");
console.log("SESSIONS_CHECK_PASS");
