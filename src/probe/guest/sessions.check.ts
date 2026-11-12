/**
 * Node validation for sessions.ts against a real Herdr Core, which the unit tests only fake. Run it inside a scratch
 * pylon as `user`, from a copy of src/, with the image's Node, from a shell that is not a Core terminal, such as one
 * `nexus exec` runs, because stopping the core ends every terminal:
 *
 *   node src/probe/guest/sessions.check.ts
 *
 * It drives a local Guest (execFile and fs), so every Core call is the one the probe makes, through core.ts. It stops
 * the pylon's core twice and deletes its state once, which ends every terminal in it, so never run it in a pylon
 * someone uses.
 *
 * Two wakes. RESTORE stops the core and keeps its state, as a checkpoint carries it. The core then brings every
 * terminal, all kept, back at its address with its labels, the shell as itself and each agent as a shell in its
 * place. The relaunch must find the shell in place and resume each agent in place, in that shell. FRESH also deletes the core's state, as on the
 * first wake of a disk from before Core, so the relaunch must reopen every session, the shell included, from the
 * sessions file alone. In both, each agent's terminal must then run its agent with the flag that resumes its session.
 *
 * Assumed, not seen in spikes/herdr-core: a VM restore, whose core dies with the VM, brings back what a graceful
 * `herdr-core server stop` and start do, which is all the spike's restart-kept saw. And the core keeps its state under
 * ~/.local/state/herdr-core, where the spike's pylon-socket check found its socket.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Guest } from "../../backends/backend.ts";
import { exit } from "../../exec.ts";
import { unusedGuest } from "../../backends/fake-guest.ts";
import type { SessionFact } from "../../protocol/observations.ts";
import { closeSession, dropFailedSession, openSession, recordSessions, relaunchSessions, sendToClaude, sessionFacts, type RecordedSession, type ClaudeSessionLock, type RelaunchOutcome, type SessionRecord } from "./sessions.ts";
import { core } from "./core.ts";
import { coreRunning } from "../../guest-contract.ts";
import { claudeProjects as projects, home as cwd } from "../../../images/pylon/nexus-contract.ts";

/** Nothing else runs here, so no call needs to wait for the relaunch. */
const unlocked: ClaudeSessionLock = (_, work) => work();

const shellCwd = `${cwd}/check-shell-cwd`;
/** The pylon sets no XDG_STATE_HOME (spikes/herdr-core, pylon-socket), so the core's state is under the home's. */
const coreState = `${cwd}/.local/state/herdr-core`;
const guest: Guest = {
  async exec(argv, opts) {
    const { code, stdout, stderr } = await exit(argv[0]!, argv.slice(1), { cwd: opts.cwd, timeout: opts.timeoutMs });
    return { exitCode: code, output: stdout + stderr, truncated: false };
  },
  async writeFiles(files) {
    for (const f of files) {
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.content, { mode: f.mode });
    }
  },
  ...unusedGuest,
};

const step = (name: string, value: unknown) => console.log(`${name}: ${JSON.stringify(value, null, 2)}`);
/** `script` in sh, with `args` as $1 and on. */
const sh = (script: string, ...args: string[]) => guest.exec(["sh", "-c", script, "check", ...args], { cwd, timeoutMs: 70_000 });
const coreUp = async () => (await sh(coreRunning)).exitCode === 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failed outcome's message carries the terminal's screen, which a rollback has already closed, so print it raw. */
function stepRelaunch(name: string, outcomes: readonly RelaunchOutcome[]): void {
  step(name, outcomes);
  for (const o of outcomes) if (o.result === "failed") console.log(`${name}_FAILED ${o.record.title}:\n${o.message}`);
}

/** Polls until every agent terminal among `terminals` reports a harness session ID, so the facts are settled. */
async function settledFacts(terminals: readonly string[]): Promise<readonly SessionFact[]> {
  let facts = await sessionFacts(guest);
  for (let deadline = Date.now() + 30_000; Date.now() < deadline; facts = await sessionFacts(guest)) {
    const mine = facts.filter((f) => f.terminal !== null && terminals.includes(f.terminal));
    if (mine.length === terminals.length && mine.every((f) => f.harness === "shell" || f.harnessSessionId !== null)) break;
    await sleep(500);
  }
  return facts;
}

/**
 * A terminal as `herdr-core get --json` gives it whole, which core.ts slims to what the probe reads: the check also
 * needs its `keep` and its foreground's `pid`. Guarded as core.ts is, so it never starts a core.
 */
async function terminalJson(terminal: string): Promise<{ keep?: unknown; foreground?: { pid?: unknown } | null }> {
  const { exitCode, output } = await sh(`${coreRunning} || exit 69; exec herdr-core get "$1" --json 2>/dev/null`, terminal);
  const at = output.indexOf("{");
  if (exitCode !== 0 || at === -1) throw new Error(`herdr-core get ${terminal} --json exited ${exitCode}: ${output}`);
  return JSON.parse(output.slice(at));
}

/** The fields of /proc/<pid>/stat after the command name, which sits in parentheses and may itself hold spaces or parentheses. */
function statOf(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/**
 * The PIDs of the terminal's own program and foreground job, which a core stop ends: its foreground process group, read
 * from /proc. A terminal the core is still bringing back may name no foreground yet, so that is retried for 10 s, and
 * every reply without one is logged.
 */
async function terminalPids(terminal: string): Promise<number[]> {
  for (const deadline = Date.now() + 10_000; ;) {
    const got = await terminalJson(terminal);
    const pid = got.foreground?.pid;
    if (typeof pid === "number") {
      const pgid = statOf(pid)?.[2];
      return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number).filter((p) => p === pid || (pgid !== undefined && statOf(p)?.[2] === pgid));
    }
    step(`GET_${terminal}`, got);
    if (Date.now() >= deadline) throw new Error(`herdr-core get ${terminal} named no foreground PID within 10 s`);
    await sleep(500);
  }
}

/** `ps -o pid,ppid,pgid,sid,stat,args` for one PID, read from /proc as ps does, because the image may not ship procps. Null once the process is gone. */
function psRow(pid: number): string | null {
  const stat = statOf(pid);
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
  if (stat === null) return null;
  const [state, ppid, pgid, sid] = stat;
  const args = cmdline.split("\0").join(" ").trim();
  return [pid, ppid, pgid, sid, state, args].join(" ");
}

async function stopCore(stage: string, terminals: readonly string[]): Promise<void> {
  const pids = [...new Set((await Promise.all(terminals.map(terminalPids))).flat())];
  step(`${stage}_PS_BEFORE_STOP`, ["PID PPID PGID SID STAT ARGS", ...pids.flatMap((pid) => psRow(pid) ?? [])]);
  step(`${stage}_CORE_STOP`, await guest.exec(["herdr-core", "server", "stop"], { cwd, timeoutMs: 70_000 }));
  for (const deadline = Date.now() + 10_000; await coreUp() && Date.now() < deadline;) await sleep(100);
  assert.equal(await coreUp(), false, `${stage}: herdr-core server stop ends the core`);
  assert.deepEqual(await sessionFacts(guest), [], "with no core, no session reads as running");
  assert.equal(await coreUp(), false, `${stage}: reading the sessions with no core starts none`);
  const remaining = () => pids.filter((pid) => psRow(pid) !== null);
  for (let deadline = Date.now() + 5_000; remaining().length > 0 && Date.now() < deadline;) await sleep(100);
  step(`${stage}_PS_AFTER_STOP`, ["PID PPID PGID SID STAT ARGS", ...pids.flatMap((pid) => psRow(pid) ?? [])]);
  // Gone means reaped too: a zombie here would mean nothing reaps what the core's terminals leave, which tini does.
  assert.deepEqual(remaining(), [], `${stage}: stopping the core ends and reaps every terminal's program and foreground job`);
}

function assertResumed(stage: string, recorded: readonly RecordedSession[], facts: readonly SessionFact[]): void {
  for (const r of recorded) {
    if (r.harnessSessionId === null || unpromptedTitles.includes(r.title)) continue;
    assert.ok(facts.some((f) => f.harness === r.harness && f.harnessSessionId === r.harnessSessionId), `${stage}: ${r.title} came back as its own ${r.harness} session`);
  }
}

/**
 * Agent sessions that have a session ID but were never prompted, so neither has a session file: Claude
 * Code has written no transcript and pi no session file. What a user would see is the test: after a
 * relaunch each terminal runs a live agent under the same session ID, not an agent that exited at its start.
 * Findings are collected rather than asserted at once, so one run reports both stages.
 */
const unprompted = { claude: "check-claude-unprompted", pi: "check-pi-unprompted" } as const;
const unpromptedTitles: readonly string[] = Object.values(unprompted);
const findings: string[] = [];
const others = (outcomes: readonly RelaunchOutcome[]) => outcomes.filter((o) => !unpromptedTitles.includes(o.record.title));

/** The files on disk that hold a harness session: Claude Code's transcript, or pi's session file itself. */
const sessionFiles = (harness: SessionRecord["harness"], id: string): string[] => harness === "pi"
  ? existsSync(id) ? [id] : []
  : existsSync(projects) ? readdirSync(projects).map((dir) => join(projects, dir, `${id}.jsonl`)).filter((file) => existsSync(file)) : [];

/** The terminal's screen, or why it could not be read. */
const screenOf = (terminal: string) => core(guest, "terminal.read", { terminal }).then((r) => r.text.trimEnd(), (err: Error) => `(unreadable: ${err.message})`);

async function checkUnprompted(stage: string, title: string, outcomes: readonly RelaunchOutcome[], facts: readonly SessionFact[]): Promise<void> {
  const o = outcomes.find((x) => x.record.title === title);
  if (o === undefined) return void findings.push(`${stage}: no record of ${title}`);
  if (o.result === "failed" || o.result === "dropped") return void findings.push(`${stage}: ${title} did not come back: ${o.result === "failed" ? o.message : "dropped"}`);
  const fact = facts.find((f) => f.terminal === o.terminal);
  const sameSessionId = fact?.harnessSessionId === o.record.harnessSessionId;
  step(`${stage}_${title}`, { outcome: o.result, fact, sameSessionId });
  // Always, because an agent can report idle while it shows an error or a session picker.
  step(`${stage}_${title}_PS`, ["PID PPID PGID SID STAT ARGS", ...(await terminalPids(o.terminal)).flatMap((pid) => psRow(pid) ?? [])]);
  console.log(`${stage}_${title}_SCREEN:\n${await screenOf(o.terminal)}`);
  if (fact?.harness !== o.record.harness) findings.push(`${stage}: ${title}'s terminal ${o.terminal} reads as ${fact?.harness ?? "nothing"}, not ${o.record.harness}`);
  else if (!sameSessionId) findings.push(`${stage}: ${title} came back as ${fact.harnessSessionId}, not ${o.record.harnessSessionId}`);
}

/**
 * What a user sees in each agent's terminal: the agent runs its recorded session. The terminal's facts are not
 * evidence, because they read the same command line the launch wrote. A Claude must run with the flag that resumes its
 * session, as /proc shows it. pi's flags cannot be read back, because its CLI sets process.title, which overwrites its
 * argv in /proc, so a pi must instead write a prompt into the session file at the recorded path.
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
    if (o.result === "failed" || o.result === "dropped") {
      fail(title, `${stage}: ${title} did not come back: ${o.result === "failed" ? o.message : "dropped"}`);
      continue;
    }
    if (harness === "pi") {
      const finding = await piWrites(stage, title, o.terminal, id);
      if (finding !== null) fail(title, finding);
      continue;
    }
    const flag = title === unprompted.claude ? "--session-id" : "--resume";
    const rows = (await terminalPids(o.terminal)).flatMap((pid) => psRow(pid) ?? []);
    step(`${stage}_RUNS_${title}`, ["PID PPID PGID SID STAT ARGS", ...rows]);
    if (!rows.some((row) => row.includes(` ${flag} ${id}`))) fail(title, `${stage}: ${title}'s terminal runs no ${harness} with ${flag} ${id}`);
  }
  return broken;
}

/** Polls up to `withinMs` until `test` holds, and says whether it did. */
async function within(withinMs: number, test: () => boolean): Promise<boolean> {
  for (const deadline = Date.now() + withinMs; !test() && Date.now() < deadline;) await sleep(250);
  return test();
}

/**
 * Sends a prompt to a pi terminal and waits for the message to reach `file`: a resumed session's file grows, and an
 * unprompted session's file first appears. The placeholder key makes the reply fail, but pi writes the user message
 * first. Returns the finding, or null.
 */
async function piWrites(stage: string, title: string, terminal: string, file: string): Promise<string | null> {
  const size = () => existsSync(file) ? statSync(file).size : null;
  const before = size();
  step(`${stage}_PROMPT_${title}`, await core(guest, "terminal.send", { terminal, text: "Reply with OK." }, 75_000));
  const wrote = () => {
    const after = size();
    return after !== null && (before === null || after > before);
  };
  await within(60_000, wrote);
  step(`${stage}_${title}_SESSION_FILE`, { file, before, after: size() });
  if (title === unprompted.pi ? before !== null : before === null) return `${stage}: ${title}'s session file ${before === null ? "was missing" : "already existed"} before the prompt`;
  return wrote() ? null : `${stage}: a prompt to ${title} never reached its session file ${file}`;
}

/** At record time an unprompted session must still have no session file, or its stage tests nothing. */
function expectNoSessionFiles(stage: string, records: readonly RecordedSession[]): void {
  for (const r of records) {
    if (!unpromptedTitles.includes(r.title) || r.harnessSessionId === null) continue;
    const files = sessionFiles(r.harness, r.harnessSessionId);
    step(`${stage}_${r.title}_FILES_AT_RECORD`, { id: r.harnessSessionId, files });
    if (files.length > 0) findings.push(`${stage}: ${r.title} had a session file before any prompt: ${files.join(", ")}`);
  }
}

/** A stop can let an agent write its session file as it exits. A pylon stopped hard leaves none, so remove it. */
function dropAppearedSessionFiles(stage: string, records: readonly RecordedSession[]): void {
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

assert.equal(process.env.HC_TERMINAL_ID, undefined, "the check runs outside a Core terminal, which stopping the core would end");
assert.ok(await coreUp(), "the pylon's boot started its Herdr Core");

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
const byTerminal = new Map(facts.map((f) => [f.terminal, f]));
assert.equal(byTerminal.get(opened.shell)?.harness, "shell");
assert.equal(byTerminal.get(opened.claude)?.harness, "claude-code", "Claude Code is its terminal's foreground");
assert.equal(byTerminal.get(opened.pi)?.harness, "pi", "pi is its terminal's foreground");
assert.ok(byTerminal.get(opened.claude)?.harnessSessionId, "Claude Code's terminal names its session ID");
assert.ok(byTerminal.get(opened.pi)?.harnessSessionId, "pi's terminal names its session file");
assert.ok(byTerminal.get(opened.unpromptedClaude)?.harnessSessionId, "an unprompted Claude Code's terminal names its session ID too");
assert.equal(byTerminal.get(opened.unpromptedPi)?.harness, "pi", "an unprompted pi is its terminal's foreground");
assert.ok(byTerminal.get(opened.unpromptedPi)?.harnessSessionId, "an unprompted pi's terminal names its session file too");
// What RESTORE turns on: the core gives a kept terminal a shell when its program is lost, which the relaunch resumes an agent in.
for (const [title, terminal] of Object.entries(opened)) assert.equal((await terminalJson(terminal)).keep, true, `${title}'s terminal ${terminal} is kept`);

// A session is only worth resuming once it has a conversation, and Claude Code cannot resume an ID with
// no transcript. The placeholder key makes the reply fail, but the prompt is still written down.
const claudeId = byTerminal.get(opened.claude)!.harnessSessionId!;
const piFile = byTerminal.get(opened.pi)!.harnessSessionId!;
const sent = await sendToClaude(guest, { session: claudeId, text: "Reply with OK." });
step(`PROMPT_${opened.claude}`, sent);
assert.ok(sent.outcome === "sent" || sent.outcome === "queued", `Claude Code takes the first prompt: ${sent.outcome}`);
step(`PROMPT_${opened.pi}`, await core(guest, "terminal.send", { terminal: opened.pi, text: "Reply with OK." }, 75_000));
assert.ok(await within(60_000, () => sessionFiles("claude-code", claudeId).length > 0 && sessionFiles("pi", piFile).length > 0), "each prompt reaches its session's file");
step("TRANSCRIPTS", { claude: sessionFiles("claude-code", claudeId), pi: sessionFiles("pi", piFile), all: transcripts() });

// RESTORE: the core's own state survives, as it does in a checkpoint.
const recorded = await recordSessions(guest);
step("RESTORE_RECORDED", recorded);
assert.ok(recorded !== null && recorded.length === 5, "the five sessions are recorded");
expectNoSessionFiles("RESTORE", recorded);
await stopCore("RESTORE", Object.values(opened));
dropAppearedSessionFiles("RESTORE", recorded);
const restored = await relaunchSessions(guest, unlocked);
stepRelaunch("RESTORE_RELAUNCH_1", restored);
assert.ok(others(restored).every((o) => o.result !== "failed"), "every recorded session comes back");
// The core kept every terminal, so each session is back at its address: the shell as itself, each agent resumed in place.
for (const o of restored) {
  const want = o.record.harness === "shell" ? "present" : "resumed-in-place";
  if (o.result !== want || o.terminal !== o.record.terminal) findings.push(`RESTORE: ${o.record.title} is ${o.result} in ${o.terminal ?? "no terminal"}, not ${want} in ${o.record.terminal}`);
}
const afterRelaunch = (await core(guest, "terminal.list", { all: true })).terminals;
step("RESTORE_TERMINALS", afterRelaunch.map(({ address, state, labels }) => ({ address, state, labels })));
if (afterRelaunch.length !== recorded.length) findings.push(`RESTORE: the core holds ${afterRelaunch.length} terminals, not the ${recorded.length} recorded`);
const brokenByRestore = await expectRuns("RESTORE", restored);
const restoredAgain = await relaunchSessions(guest, unlocked);
stepRelaunch("RESTORE_RELAUNCH_2", restoredAgain);
assert.ok(others(restoredAgain).every((o) => o.result === "present"), "a second relaunch opens nothing");
const restoredTerminals = restoredAgain.flatMap((o) => o.result === "present" ? [o.terminal] : []);
const afterRestore = await settledFacts(restoredTerminals);
step("RESTORE_FACTS", afterRestore);
assertResumed("RESTORE", recorded, afterRestore);
for (const title of unpromptedTitles) await checkUnprompted("RESTORE", title, restoredAgain, afterRestore);
// FRESH needs unprompted sessions of its own: RESTORE's prompt gave the unprompted pi a session file, and
// an unprompted Claude that RESTORE broke may be left as a failed record or a terminal that runs nothing it can resume.
for (const [harness, title] of [["claude-code", unprompted.claude], ["pi", unprompted.pi]] as const) {
  if (harness === "claude-code" && !brokenByRestore.has(title)) continue;
  // Every record under its title: one in a terminal is closed with it, and a failed one in none is dropped.
  for (const r of (await recordSessions(guest)) ?? []) {
    if (r.title !== title) continue;
    if (r.terminal === null) {
      assert.ok(await dropFailedSession(guest, r.id), `FRESH: the failed record of ${title} is dropped`);
      continue;
    }
    await closeSession(guest, r.terminal);
    if (restoredTerminals.includes(r.terminal)) restoredTerminals.splice(restoredTerminals.indexOf(r.terminal), 1);
  }
  const terminal = await openSession(guest, { harness, title, cwd });
  restoredTerminals.push(terminal);
  step(`FRESH_${title}_REOPENED`, (await settledFacts([terminal])).find((f) => f.terminal === terminal));
}

// FRESH: the core's state is gone, so only the sessions file can bring the sessions back.
const recordedAgain = await recordSessions(guest);
step("FRESH_RECORDED", recordedAgain);
assert.ok(recordedAgain !== null && recordedAgain.length === 5);
const restoredShell = recordedAgain.find((r) => r.harness === "shell");
if (restoredShell?.title !== "check-shell" || restoredShell.cwd !== shellCwd) findings.push(`RESTORE: the shell came back as ${JSON.stringify(restoredShell)}`);
for (const title of unpromptedTitles) assert.ok(recordedAgain.find((r) => r.title === title)?.harnessSessionId, `${title} is recorded with its ID`);
expectNoSessionFiles("FRESH", recordedAgain);
await stopCore("FRESH", restoredTerminals);
assert.ok(existsSync(coreState), `the stopped core's state is at ${coreState}`);
step("FRESH_CORE_STATE", (await sh('find "$1"', coreState)).output.trim().split("\n"));
rmSync(coreState, { recursive: true });
dropAppearedSessionFiles("FRESH", recordedAgain);
const fresh = await relaunchSessions(guest, unlocked);
stepRelaunch("FRESH_RELAUNCH_1", fresh);
// A shell found present here would mean the deleted directory was not all of the core's state.
assert.deepEqual(others(fresh).map((o) => o.result), ["relaunched", "relaunched", "relaunched"], "with no core state, every session is reopened, the kept shell included");
const freshTerminals = fresh.flatMap((o) => o.result === "relaunched" ? [o.terminal] : []);
const afterFresh = await settledFacts(freshTerminals);
step("FRESH_FACTS", afterFresh);
assertResumed("FRESH", recordedAgain, afterFresh);
for (const title of unpromptedTitles) await checkUnprompted("FRESH", title, fresh, afterFresh);
await expectRuns("FRESH", fresh);
const freshRecords = await recordSessions(guest);
step("FRESH_RECORDS", freshRecords);
const freshShell = fresh.find((o) => o.record.harness === "shell");
const shell = freshRecords?.find((r) => freshShell?.result === "relaunched" && r.terminal === freshShell.terminal);
assert.deepEqual(shell && { harness: shell.harness, title: shell.title, cwd: shell.cwd }, { harness: "shell", title: "check-shell", cwd: shellCwd }, "the shell comes back with its title and cwd");
const freshAgain = await relaunchSessions(guest, unlocked);
stepRelaunch("FRESH_RELAUNCH_2", freshAgain);
assert.ok(others(freshAgain).every((o) => o.result === "present"), "a second relaunch after a fresh one opens nothing");

for (const o of freshAgain) if (o.result === "present") await closeSession(guest, o.terminal);
assert.equal(await closeSession(guest, "tzzzzzz"), "not-open", "closing a terminal the core never had closes nothing");
const closed = await sessionFacts(guest);
step("FACTS_AFTER_CLOSE", closed);
assert.deepEqual(closed.filter((f) => f.terminal !== null && freshTerminals.includes(f.terminal)), [], "closed sessions are gone");
step("FINDINGS", findings);
assert.deepEqual(findings, [], "after both wakes every agent's terminal runs its agent, resumed with the right flag");
console.log("SESSIONS_CHECK_PASS");
