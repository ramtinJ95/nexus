/**
 * Herdr sessions inside a pylon: open and close them, read them for observations, record them before a
 * pause and relaunch them on wake. Every call is a guest exec of Herdr's CLI as `user`, against the named
 * Herdr session the dashboard attaches to with `herdr --session nexus`. Nexus does not use tmux.
 *
 * Each session Nexus opens is one Herdr workspace labelled with the session's title, with the harness in
 * its root pane. A workspace rather than a tab, so every pane in the server is a session: a fresh headless
 * server needs no placeholder workspace to hold tabs, a rollback closes exactly what the open created, and
 * a relaunch never grows a stray home shell. Panes opened by hand are reported and recorded like any other.
 *
 * On a wake from a checkpoint, Herdr 0.9.5 restores its own layout, titles and cwds. The pylon's Herdr
 * config turns off its agent resume (`[session] resume_agents_on_restore = false`), because Herdr resumes
 * Claude Code with `--resume` even when it has no transcript, which exits and leaves a bare shell that
 * Herdr still reports as Claude. The relaunch is the only thing that starts agents, and it fills in only
 * what is missing, so it converges whatever Herdr restored first.
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { seedClaudeState } from "./claude-state.ts";
import type { Guest } from "./backend.ts";
import type { CommandResult, HerdrStatus, PausedSession, SessionFact, SessionIdentity } from "./protocol.ts";
import type { SessionHarness } from "./project.ts";

export const herdrSession = "nexus";
export const sessionsFile = "/home/user/.nexus/sessions.json";
export const checkoutDir = "/home/user/workspace/repo";

const home = "/home/user";
const callTimeoutMs = 10_000;
const agentStartTimeoutMs = 30_000;
const serverStartMs = 5_000;
/** pi-shepherdr's launch.ts: a new pane's shell can still be starting when the first agent start lands. */
const paneBusyRetryMs = 3_000;
const shellPromptMs = 10_000;

/**
 * The agent each harness starts in its pane: Herdr's agent kind, the launch arguments that resume a harness
 * session ID, and those of a fresh start. A shell is the pane's own login shell, so it starts nothing and
 * resumes nothing.
 */
const agents: { readonly [H in SessionHarness]: { kind: string; resume(guest: Guest, id: string): Promise<readonly string[]>; fresh(): readonly string[] } | null } = {
  // Herdr learns a Claude Code session's ID from Claude's SessionStart hook, which does not run while Claude
  // waits at its login or trust screen, nor again once the human is past it. So every Claude Code start
  // names its ID, and recordSessions reads it back from the pane's command line when Herdr has none.
  "claude-code": { kind: "claude", resume: claudeResume, fresh: () => ["--session-id", randomUUID()] },
  // pi 1.4.0 opens a missing --session path as a new session that it first writes there on its first
  // message, so unlike a Claude Code ID the path needs no check. pi reports its session file at once.
  pi: { kind: "pi", resume: async (_guest, sessionFile) => ["--session", sessionFile], fresh: () => [] },
  shell: null,
};

/**
 * Claude Code writes no transcript until its first prompt, and `--resume` of an ID without one exits, so
 * a session that was opened but never prompted would not come back. `--session-id` starts it fresh under
 * the same ID instead. The guest looks for the transcript under any project, whatever slug Claude gave the cwd.
 */
async function claudeResume(guest: Guest, id: string): Promise<readonly string[]> {
  const { exitCode, output } = await guest.exec(["sh", "-c", 'for f in "$1"/*/"$0".jsonl; do [ -e "$f" ] && exit 0; done; exit 1', id, `${home}/.claude/projects`], { cwd: home, timeoutMs: callTimeoutMs });
  if (exitCode === 0) return ["--resume", id];
  if (exitCode === 1) return ["--session-id", id];
  throw new Error(`looking for Claude Code transcript ${id} failed with exit ${exitCode}: ${output}`);
}

/** Agents Nexus does not launch, such as Codex started by hand, read as shells. */
function harnessOf(herdrAgent: string | null): SessionHarness {
  return (Object.keys(agents) as SessionHarness[]).find((h) => agents[h] !== null && agents[h].kind === herdrAgent) ?? "shell";
}

/** What ~/.nexus/sessions.json holds for each session. The checkpoint carries the file. */
export interface SessionRecord {
  herdrPane: string;
  harness: SessionHarness;
  title: string;
  cwd: string;
  harnessSessionId: string | null;
  model?: string;
}

/** A session as recordSessions reports it: what a wake brings back, and where. */
export type RecordedSession = PausedSession & { cwd: string; model?: string };

/**
 * A session the last relaunch did not bring back. It stays in the file, through any number of records,
 * until a relaunch brings it back. When the relaunch left it in a pane, such as a restored shell its agent
 * would not start in, `record.herdrPane` is that pane and the record stands for it, so closing the pane is
 * what drops the session. One in no pane is dropped by its ID (dropFailedSession).
 */
interface FailedRecord { record: SessionRecord; inPane: boolean; message: string }

/**
 * What names a session to the control plane: its pane, or for a failed session in no pane, a hash of its record. A
 * relaunch that fails again keeps the record as it was, so the ID holds from one wake to the next. The record's own
 * pane ID will not do: Herdr numbers panes by workspace (`w1:p1`), so a later session can be given it again.
 */
function idOf(f: FailedRecord): string {
  if (f.inPane) return f.record.herdrPane;
  const { herdrPane, harness, title, cwd, harnessSessionId } = f.record;
  return `failed-${createHash("sha256").update(JSON.stringify([herdrPane, harness, title, cwd, harnessSessionId])).digest("hex").slice(0, 12)}`;
}

/** The failed records that still stand for a session: every one in no pane, and each in a pane that is still open. */
function standing(file: SessionsFile | null, live: readonly LivePane[]): FailedRecord[] {
  const panes = new Set(live.map((p) => p.herdrPane));
  return (file?.failed ?? []).filter((f) => !f.inPane || panes.has(f.record.herdrPane));
}

interface SessionsFile { version: 1; recordedAt: string; sessions: readonly SessionRecord[]; failed: readonly FailedRecord[] }

export type RelaunchOutcome =
  | { record: SessionRecord; result: "present" | "relaunched"; herdrPane: string }
  | { record: SessionRecord; result: "failed"; herdrPane: string | null; message: string }
  /** A second record of a Claude Code session another record brings back. Its pane, if open, is closed. */
  | { record: SessionRecord; result: "dropped"; herdrPane: string | null };

/** A Herdr CLI error. `code` is Herdr's, such as `pane_not_found`, `server_not_running` or `agent_not_ready`. */
export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Returns the new session's Herdr pane. Rolls the workspace back if the harness does not start.
 *
 * A prompted Claude Code launch is safe to send again under the same `resume` ID, as after the probe restarted
 * under it: it reads how far the earlier one got (claudeLaunch) and carries on from there. It types the command at
 * most once, reuses the earlier one's pane if nothing was typed, and never starts Claude in a second pane.
 */
export async function openSession(guest: Guest, session: { harness: SessionHarness; title: string; cwd: string; resume?: string; prompt?: string; model?: string }): Promise<string> {
  await ensureServer(guest);
  const prompted = session.harness === "claude-code" && session.prompt !== undefined;
  const resume = prompted ? session.resume ?? randomUUID() : session.resume;
  const launch = prompted ? await claudeLaunch(guest, resume!) : null;
  if (launch?.progress === "typed") {
    await awaitSubmission(guest, launch.pane, launch.dir, " before the probe lost the launch");
    return launch.pane;
  }
  if (launch !== null) {
    // A probe older than the launch record types without recording it, so its launch shows only as a running Claude.
    const running = await claudePane(guest, resume!);
    if (running?.runs === true) return running.pane.herdrPane;
  }
  let opened: { workspace: string; pane: string } | null = launch?.progress === "opened" && (await livePanes(guest)).some((p) => p.herdrPane === launch.pane) ? launch : null;
  if (opened === null) {
    const created = record(await herdr(guest, ["workspace", "create", "--cwd", session.cwd, "--label", session.title, "--no-focus"]), "workspace create");
    opened = { workspace: string(record(created.workspace, "workspace create .workspace").workspace_id, "workspace_id"), pane: string(record(created.root_pane, "workspace create .root_pane").pane_id, "pane_id") };
    if (launch !== null) await guest.writeFiles([{ path: `${launch.dir}/opened`, mode: 0o644, owner: "user", content: `${opened.workspace} ${opened.pane}\n` }]);
  }
  try {
    await startHarness(guest, opened.pane, session.harness, resume, session.prompt, session.model, launch?.dir);
  } catch (err) {
    if (err instanceof ClaudeLaunchStalled) throw err;
    try {
      await herdr(guest, ["workspace", "close", opened.workspace]);
    } catch (cleanup) {
      throw new Error(`${(err as Error).message}; rolling back workspace ${opened.workspace} also failed: ${(cleanup as Error).message}`, { cause: err });
    }
    throw err;
  }
  return opened.pane;
}

const launchesDir = `${home}/.nexus/claude-launches`;

/**
 * How far a prompted Claude Code launch got: `opened` once its workspace exists, `typed` once the command to start
 * Claude is on its way into the pane, and `submitted` once Claude took the first prompt. `typed` is written by the
 * same guest exec that types the command, before it types, and only the exec that creates it types. A guest exec runs
 * to its end even when the probe that started it exits, so a launch without it typed nothing, though an exec its
 * probe outlived may still claim it.
 */
type ClaudeLaunch = { dir: `/${string}` } & ({ progress: "none" } | { progress: "opened" | "typed"; workspace: string; pane: string });

async function claudeLaunch(guest: Guest, session: string): Promise<ClaudeLaunch> {
  if (!/^[A-Za-z0-9-]{1,200}$/.test(session)) throw new Error(`a prompted Claude launch needs a session ID of letters, digits and dashes, not ${JSON.stringify(session)}`);
  const dir = `${launchesDir}/${session}` as const;
  const { exitCode, output } = await guest.exec(["sh", "-c", 'test -f "$0/opened" || exit 0; cat "$0/opened"; test -e "$0/typed" && echo typed; exit 0', dir], { cwd: home, timeoutMs: callTimeoutMs });
  if (exitCode !== 0) throw new Error(`reading Claude launch ${dir} failed with exit ${exitCode}: ${output}`);
  const [opened, ...stages] = output.trim().split("\n");
  if (opened === undefined || opened === "") return { dir, progress: "none" };
  const [workspace, pane] = opened.split(" ");
  return { dir, progress: stages.includes("typed") ? "typed" : "opened", workspace: string(workspace, `${dir}/opened workspace`), pane: string(pane, `${dir}/opened pane`) };
}

/** Starts at the shell prompt; prompted Claude launches use submission evidence instead of readiness. */
async function startHarness(guest: Guest, pane: string, harness: SessionHarness, resume: string | undefined, prompt?: string, model?: string, launchDir?: string): Promise<void> {
  const agent = agents[harness];
  if (agent === null) return;
  if (harness === "claude-code") {
    const seeded = await guest.exec(["node", "-e", seedClaudeState, checkoutDir], { cwd: home, timeoutMs: callTimeoutMs });
    if (seeded.exitCode !== 0) throw new Error(`seeding Claude state failed: ${seeded.output}`);
  }
  const args = resume === undefined ? agent.fresh() : await agent.resume(guest, resume);
  const launch = [...args];
  if (harness === "claude-code" && model !== undefined) launch.push("--model", model);
  if (harness === "claude-code") launch.push("--permission-mode", "bypassPermissions");
  if (harness === "claude-code" && prompt !== undefined && launchDir !== undefined) {
    if (args[0] === "--resume") throw new Error(`Claude session ${resume} already has a transcript, so its first prompt went in before this launch, which typed nothing. Attach to check before starting another session`);
    const command = `mkdir -p ${launchDir} && touch ${launchDir}/submitted`;
    launch.push("--settings", JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] } }), prompt);
    await awaitShellPrompt(guest, pane);
    // Herdr 0.9.5's agent start refuses an argument holding a newline or another control character, as a multi-line
    // prompt does, so this launch types its own command. Once typed, any error is as uncertain as a readiness timeout:
    // the receipt decides, and the pane and the submission fence stay.
    const typed = await herdr(guest, ["pane", "run", pane, [agent.kind, ...launch].map(shellWord).join(" ")], callTimeoutMs, `${launchDir}/typed`).then(() => "", (err: Error) => ` after ${err.message}`);
    await awaitSubmission(guest, pane, launchDir, typed);
    return;
  }
  if (prompt !== undefined) launch.push(prompt);
  const argv = ["agent", "start", `nx-${randomUUID().slice(0, 8)}`, "--kind", agent.kind, "--pane", pane, "--timeout", String(agentStartTimeoutMs)];
  if (launch.length > 0) argv.push("--", ...launch);
  const busyUntil = Date.now() + paneBusyRetryMs;
  for (;;) {
    try {
      await herdr(guest, argv, agentStartTimeoutMs + callTimeoutMs);
      return;
    } catch (err) {
      // Blocked at startup, such as Claude Code asking whether to trust the folder: the session is open
      // and waits for its human, who answers it in the terminal.
      if (err instanceof HerdrError && err.code === "agent_not_ready") return;
      if (err instanceof HerdrError && err.code === "agent_pane_busy" && Date.now() < busyUntil) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      if (harness === "claude-code") {
        const running = await runsAgent(guest, pane, "claude").catch(() => null);
        if (running === true) return;
        if (running === null) throw new ClaudeLaunchStalled(`Claude launch stalled: ${(err as Error).message}; attach before starting another session`, pane);
      }
      // A rollback closes the pane, so its screen, such as the harness's own error, goes into the failure.
      throw new Error(`${(err as Error).message}. The pane showed:\n${await screen(guest, pane)}`, { cause: err });
    }
  }
}

/**
 * Waits up to 30 seconds for the launch's UserPromptSubmit receipt. A live, working Claude in the pane also shows the
 * launch went in. Anything else leaves the pane as it is for the person, since Claude may still be starting.
 */
async function awaitSubmission(guest: Guest, pane: string, launchDir: string, typed: string): Promise<void> {
  const submitted = await guest.exec(["sh", "-c", 'i=0; until test -f "$1"; do i=$((i+1)); test "$i" -lt 300 || exit 1; sleep 0.1; done', "claude-submitted", `${launchDir}/submitted`], { cwd: home, timeoutMs: 35_000 }).catch(() => ({ exitCode: null }));
  if (submitted.exitCode === 0) return;
  if (await runsAgent(guest, pane, "claude").catch(() => false) && (await livePanes(guest).catch(() => [])).some((p) => p.herdrPane === pane && p.status === "working")) return;
  throw new ClaudeLaunchStalled(`Claude launch stalled: no UserPromptSubmit within 30 seconds${typed}; attach before starting another session. The pane showed:\n${await screen(guest, pane)}`, pane);
}

/**
 * Waits until the pane's shell reads a line with readline: its process group holds the terminal, which is out of
 * canonical mode. Before that, as while bash runs its startup files, the terminal's line discipline holds typed input
 * and drops a line past its 4 KB limit, as a long first prompt makes. Throws before anything is typed, so the caller
 * can roll the pane back.
 */
async function awaitShellPrompt(guest: Guest, pane: string): Promise<void> {
  const shell = record(record(await herdr(guest, ["pane", "process-info", "--pane", pane]), "pane process-info").process_info, "process_info").shell_pid;
  if (typeof shell !== "number") throw new Error(`Herdr pane ${pane} reports no shell_pid`);
  const ready = await guest.exec(["sh", "-c", shellPrompt, "shell-ready", String(shell)], { cwd: home, timeoutMs: shellPromptMs + callTimeoutMs });
  if (ready.exitCode !== 0) throw new Error(`the pane's shell did not reach an idle prompt within ${shellPromptMs / 1000} seconds, so the Claude launch was not typed. The pane showed:\n${await screen(guest, pane)}`);
}

/** Polls `$1`, the shell's PID: field 8 of its stat is the terminal's foreground process group. */
const shellPrompt = `pid=$1; i=0; until s=$(cat /proc/$pid/stat) && set -- \${s##*) } && test "$6" = "$pid" && stty -a -F /proc/$pid/fd/0 | grep -q -- -icanon; do i=$((i+1)); test "$i" -lt ${shellPromptMs / 100} || exit 1; sleep 0.1; done`;

/**
 * `arg` as one bash word, typed into the pane's shell. ANSI-C quoting spells control characters, `'` and `!` as
 * escapes, so the typed line holds nothing the terminal, readline or history expansion acts on.
 */
function shellWord(arg: string): string {
  return `$'${arg.replace(/[\\'!\x00-\x1f\x7f]/g, (c) => c === "\\" ? "\\\\" : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}'`;
}

export class ClaudeLaunchStalled extends Error {
  readonly herdrPane: string;
  constructor(message: string, herdrPane: string) {
    super(message);
    this.herdrPane = herdrPane;
  }
}

/** Diagnostic only, so it never throws over the failure it explains. */
async function screen(guest: Guest, pane: string): Promise<string> {
  try {
    const { output } = await guest.exec(["herdr", "--session", herdrSession, "pane", "read", pane, "--source", "recent-unwrapped", "--lines", "20"], { cwd: home, timeoutMs: callTimeoutMs });
    const line = output.trimEnd().split("\n").findLast((l) => l.startsWith("{"));
    const text: unknown = line === undefined ? undefined : JSON.parse(line).result?.read?.text;
    return typeof text === "string" ? text.trimEnd().slice(-8192) : output.trimEnd().slice(-8192);
  } catch (err) {
    return `(the pane could not be read: ${(err as Error).message})`;
  }
}

/**
 * Closes the pane, unless it is not open, or no Herdr server runs, or `expected` names another session than the one
 * sessionFacts reports there. A caller holding a pane ID from before a wake must not read any of those as its session
 * closed, since the wake may have brought the session back in another pane, and given this one to another session.
 */
export async function closeSession(guest: Guest, herdrPane: string, expected?: SessionIdentity): Promise<"closed" | "not-open" | "moved"> {
  if (expected !== undefined) {
    const there = (await sessionFacts(guest)).find((f) => f.herdrPane === herdrPane);
    if (there === undefined) return "not-open";
    // An ID or title either side has not learned yet, such as a Claude Code ID before its SessionStart hook, tells nothing.
    const differ = (a: string | null | undefined, b: string | null) => a != null && b !== null && a !== b;
    if (there.harness !== expected.harness || differ(there.harnessSessionId, expected.harnessSessionId) || differ(there.title, expected.title)) return "moved";
  }
  try {
    await herdr(guest, ["pane", "close", herdrPane]);
    return "closed";
  } catch (err) {
    if (err instanceof HerdrError && (err.code === "pane_not_found" || err.code === "server_not_running")) return "not-open";
    throw err;
  }
}

/**
 * Why `text` cannot be typed into Claude Code's prompt exactly as it is, for a person to act on, or null. A newline
 * types a line break and Enter submits, so the only control character the prompt takes as typed is `\n`. A tab is
 * swallowed, a carriage return would submit early, and an escape sequence would drive the terminal.
 */
export function claudeTextProblem(text: string): string | null {
  if (!text.isWellFormed()) return "the message holds an unpaired UTF-16 surrogate, which is not text";
  if (text.trim() === "") return "the message is blank, and Claude ignores a blank prompt";
  const control = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.exec(text);
  if (control === null) return null;
  if (control[0] === "\t") return "the message holds a tab, which Claude's prompt swallows. Replace tabs with spaces";
  if (control[0] === "\r") return "the message holds a carriage return, which would submit it early. End lines with a newline alone";
  const code = control[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
  return `the message holds control character U+${code} at offset ${control.index}, which Claude's prompt cannot take as typed. Remove it`;
}

/** Claude Code takes a burst of typed input as a paste and wraps it in `<pasted_content>` tags, so text goes in chunks this short. */
const typedChunkCodePoints = 64;
const claudeReadyMs = 15_000;
const claudeReadyPollMs = 250;
/** Each chunk is a Herdr CLI call, and a 16 KB message is 256 of them. */
const typeTimeoutMs = 30_000;

/**
 * Pane ID, then one argument per chunk. Arguments reach Herdr unparsed, so quotes, backticks and `$` are text. Herdr
 * 0.9.5 types every argument after the pane, `--` and a leading `-` included, joined by spaces, so each chunk is
 * exactly one argument. Claude reads an Enter that follows a burst of input as a newline in it, so the Enter waits.
 * It stops at the first failure and says how far it got.
 */
const typeChunks = `pane=$1; shift; i=0
for chunk; do
  out=$(herdr --session ${herdrSession} pane send-text "$pane" "$chunk" 2>&1) || { printf '%s\\n' "$out"; echo "typed $i of $# chunks"; exit 1; }
  i=$((i+1))
done
sleep 0.5
out=$(herdr --session ${herdrSession} pane send-keys "$pane" Enter 2>&1) || { printf '%s\\n' "$out"; echo "typed all $# chunks but not the Enter that submits them"; exit 1; }`;

/**
 * Types `message.text` into the Claude Code session `message.session` as a prompt and submits it, as a person at its
 * terminal would. A session in no live pane is resumed first, under `message.model` if given. The text goes in
 * exactly as typed, so a leading `!` runs it as a shell command and a leading `/` as a slash command, and text a
 * person has half-typed in an attached terminal is joined to it. The prompt is not cleared first, because Esc
 * interrupts Claude and Ctrl+C can exit it.
 *
 * Claude typing nothing is an outcome: `blocked` when Claude waits at a dialog in its terminal, which typing would
 * answer, `starting` when Herdr still cannot tell Claude's state after `readyWithinMs`, and `moved` when the pane no
 * longer runs the session by the time it is ready, as when another agent was started in it. A rejection may come after
 * part of the text was typed. The caller runs one send per session at a time, since two would interleave their chunks.
 */
export async function sendToClaude(guest: Guest, message: { session: string; text: string; model?: string }, readyWithinMs = claudeReadyMs): Promise<Omit<Extract<CommandResult, { kind: "send-claude" }>, "kind">> {
  const found = await claudePane(guest, message.session) ?? await restoredPane(guest, message.session);
  const resumed = found?.runs !== true;
  const herdrPane = found?.pane.herdrPane ?? await openSession(guest, { harness: "claude-code", title: "Claude Code", cwd: checkoutDir, resume: message.session, ...(message.model === undefined ? {} : { model: message.model }) });
  // A pane whose Claude exited still reports the session, and a restored one is recorded with it. Starting it there, as a
  // relaunch does, keeps the session in one pane.
  if (found?.runs === false) await startHarness(guest, herdrPane, "claude-code", message.session, undefined, message.model);
  let pane = await livePane(guest, herdrPane);
  for (const deadline = Date.now() + readyWithinMs; pane.status === "unknown" && Date.now() < deadline;) {
    await delay(claudeReadyPollMs);
    pane = await livePane(guest, herdrPane);
  }
  const { status } = pane;
  if (status === "blocked" || status === "unknown") return { outcome: status === "blocked" ? "blocked" : "starting", herdrPane, resumed };
  if (!await runsSession(guest, pane, message.session)) return { outcome: "moved", herdrPane, resumed };
  const chunks: string[] = [];
  const points = Array.from(message.text);
  for (let i = 0; i < points.length; i += typedChunkCodePoints) chunks.push(points.slice(i, i + typedChunkCodePoints).join(""));
  const typed = await guest.exec(["sh", "-c", typeChunks, "claude-type", herdrPane, ...chunks], { cwd: home, timeoutMs: typeTimeoutMs });
  if (typed.exitCode === null) throw new Error(`typing into Claude's pane ${herdrPane} did not finish within ${typeTimeoutMs / 1000} seconds, so part of the message may sit unsent in its prompt`);
  if (typed.exitCode !== 0) throw new Error(`typing into Claude's pane ${herdrPane} failed, so part of the message may sit unsent in its prompt: ${typed.output.trim().slice(-500)}`);
  return { outcome: status === "working" ? "queued" : "sent", herdrPane, resumed };
}

/**
 * The Claude Code pane that runs `session`, by Herdr's report of its ID or, for a pane Herdr has none for, by its
 * command line. `runs` is false for a pane that reports the session but whose Claude has exited to the shell.
 */
async function claudePane(guest: Guest, session: string): Promise<{ pane: LivePane; runs: boolean } | null> {
  const panes = await livePanes(guest).catch(noServer([]));
  for (const pane of panes) if (await runsSession(guest, pane, session)) return { pane, runs: true };
  const exited = panes.find((p) => p.harness === "claude-code" && p.harnessSessionId === session);
  return exited ? { pane: exited, runs: false } : null;
}

/**
 * The shell Herdr restored the pane the sessions file records `session` in as, before a relaunch starts Claude in it.
 * Herdr restores its panes as its server starts, so a send that comes before the relaunch starts it.
 */
async function restoredPane(guest: Guest, session: string): Promise<{ pane: LivePane; runs: false } | null> {
  const file = await readSessionsFile(guest);
  if (file === null) return null;
  await ensureServer(guest);
  const panes = await livePanes(guest);
  const records = [...file.sessions, ...file.failed.flatMap((f) => f.inPane ? [f.record] : [])];
  const pane = records.flatMap((r) => r.harness === "claude-code" && r.harnessSessionId === session
    ? panes.filter((p) => p.herdrPane === r.herdrPane && p.title === r.title && p.harness === "shell") : [])[0];
  return pane === undefined ? null : { pane, runs: false };
}

/** Whether Claude runs `session` in the pane: Herdr reports the session and Claude in its foreground, or, before Herdr learns an ID, Claude's command line names it. */
async function runsSession(guest: Guest, pane: LivePane, session: string): Promise<boolean> {
  if (pane.harness !== "claude-code") return false;
  if (pane.harnessSessionId === null) return await launchedClaudeSession(guest, pane.herdrPane) === session;
  return pane.harnessSessionId === session && await runsAgent(guest, pane.herdrPane, agents["claude-code"]!.kind);
}

async function livePane(guest: Guest, herdrPane: string): Promise<LivePane> {
  const pane = (await livePanes(guest)).find((p) => p.herdrPane === herdrPane);
  if (pane === undefined) throw new Error(`Claude's pane ${herdrPane} closed before it could take the message, so nothing was typed`);
  return pane;
}

/** Forgets a failed session in no pane, by its ID, so no wake tries it again. False when the file holds no such session. */
export async function dropFailedSession(guest: Guest, id: string): Promise<boolean> {
  const file = await readSessionsFile(guest);
  if (file === null) return false;
  const failed = file.failed.filter((f) => f.inPane || idOf(f) !== id);
  if (failed.length === file.failed.length) return false;
  await writeSessionsFile(guest, { ...file, failed });
  return true;
}

/**
 * The facts an observation carries: each open pane, from one `herdr api snapshot` exec, and each session the last
 * wake failed to bring back, from the sessions file. A pane a failed record stands for is that failed session. No
 * Herdr server means no panes. Any other failure rejects, so the caller can tell "none" from "unknown".
 */
export async function sessionFacts(guest: Guest, timeoutMs = callTimeoutMs): Promise<readonly SessionFact[]> {
  const [panes, file] = await Promise.all([livePanes(guest, timeoutMs).catch(noServer([])), readSessionsFile(guest, timeoutMs)]);
  const failed = standing(file, panes);
  const standsFor = new Set(failed.flatMap((f) => f.inPane ? [f.record.herdrPane] : []));
  const statusOf = new Map(panes.map((p) => [p.herdrPane, p.status]));
  return [
    ...panes.filter((p) => !standsFor.has(p.herdrPane)).map(({ herdrPane, harness, harnessSessionId, status, title }): SessionFact => ({
      id: herdrPane, state: "running", herdrPane, harness, harnessSessionId, status, title,
    })),
    ...failed.map((f): SessionFact => ({
      id: idOf(f), state: "failed", herdrPane: f.inPane ? f.record.herdrPane : null, harness: f.record.harness, harnessSessionId: f.record.harnessSessionId,
      status: f.inPane ? statusOf.get(f.record.herdrPane)! : "unknown", title: f.record.title, message: f.message,
    })),
  ];
}

/**
 * Writes every open session to ~/.nexus/sessions.json, before the disk checkpoint, and returns every
 * session a relaunch would bring back, under the IDs sessionFacts gave them. Sessions the last relaunch failed
 * to bring back are kept, except one whose pane has since closed. With no Herdr server the file is left as it is
 * and this returns null: a server that never came up after the last wake must not erase the sessions that wake
 * failed to relaunch.
 */
export async function recordSessions(guest: Guest): Promise<readonly RecordedSession[] | null> {
  const panes = await livePanes(guest).catch(noServer(null));
  if (panes === null) return null;
  const failed = standing(await readSessionsFile(guest), panes);
  const standsFor = new Set(failed.flatMap((f) => f.inPane ? [f.record.herdrPane] : []));
  const sessions = await Promise.all(panes.filter((p) => !standsFor.has(p.herdrPane))
    .map(async ({ herdrPane, harness, title, cwd, harnessSessionId }): Promise<SessionRecord> => ({
      herdrPane, harness, title, cwd,
      ...(harness === "claude-code" ? await launchedClaudeModel(guest, herdrPane) : {}),
      harnessSessionId: harnessSessionId ?? (harness === "claude-code" ? await launchedClaudeSession(guest, herdrPane) : null),
    })));
  const file: SessionsFile = { version: 1, recordedAt: new Date().toISOString(), sessions, failed };
  await writeSessionsFile(guest, file);
  return relaunchedFrom(file);
}

/**
 * What a sessions file read from a stopped disk says its wake brings back, as recordSessions would have returned it,
 * such as one whose pause stopped it and died before it could keep the list.
 */
export function pausedSessionsIn(text: string): readonly PausedSession[] {
  return relaunchedFrom(parseSessionsFile(text)).map(({ cwd: _, ...session }) => session);
}

function relaunchedFrom(file: SessionsFile): RecordedSession[] {
  const recorded = (r: SessionRecord, id: string, inPane: boolean): RecordedSession => ({ ...r, id, herdrPane: inPane ? r.herdrPane : null });
  return [...file.sessions.map((r) => recorded(r, r.herdrPane, true)), ...file.failed.map((f) => recorded(f.record, idOf(f), f.inPane))];
}

/**
 * On wake: start Herdr, then bring back each recorded session that is not already live, into its prompt.
 * Running it again converges: each live pane answers for at most one record, so neither Herdr's own
 * restore nor an earlier relaunch is opened twice. One failure does not stop the rest, and the sessions
 * file is rewritten with each session's pane and with the failures, so a later record keeps them. A Herdr that
 * does not start fails every session, for its reason.
 *
 * A Claude Code session comes back in one pane only: the first record of it whose pane still runs it, or else its
 * first record. Every other record of it is dropped and its pane closed. `exclusive` runs the relaunch while no send
 * or launch of those sessions does, so none of them starts a session the relaunch is bringing back.
 */
export async function relaunchSessions(guest: Guest, exclusive: <T>(claudeSessions: readonly string[], work: () => Promise<T>) => Promise<T> = (_, work) => work()): Promise<readonly RelaunchOutcome[]> {
  const file = await readSessionsFile(guest);
  if (file === null) return [];
  const records = [...file.sessions, ...file.failed.map((f) => f.record)];
  if (records.length === 0) return [];
  return exclusive(records.flatMap((r) => r.harness === "claude-code" && r.harnessSessionId !== null ? [r.harnessSessionId] : []), () => relaunch(guest, file, records));
}

async function relaunch(guest: Guest, file: SessionsFile, records: readonly SessionRecord[]): Promise<readonly RelaunchOutcome[]> {
  let unclaimed: LivePane[];
  try {
    await ensureServer(guest);
    unclaimed = await livePanes(guest);
  } catch (err) {
    const outcomes = records.map((record): RelaunchOutcome => ({ record, result: "failed", herdrPane: null, message: (err as Error).message }));
    await recordOutcomes(guest, file, outcomes);
    return outcomes;
  }
  const recordedIds = new Set(records.flatMap((r) => r.harnessSessionId ?? []));
  // A pane whose agent reports another session is that session, not this one. A record with no ID can take
  // a pane whose ID no record has, such as the one an earlier relaunch of it started.
  const sameSession = (r: SessionRecord, p: LivePane) => p.harnessSessionId === null || p.harnessSessionId === r.harnessSessionId
    || (r.harnessSessionId === null && !recordedIds.has(p.harnessSessionId));
  // In order of confidence. Each pass gives every unmatched record the first unclaimed pane it accepts.
  const matchers: ((r: SessionRecord, p: LivePane) => boolean)[] = [
    (r, p) => r.harnessSessionId !== null && p.harnessSessionId === r.harnessSessionId,
    // Herdr restored the pane in place. A plain shell there means it restored the layout but not the agent.
    (r, p) => p.herdrPane === r.herdrPane && p.title === r.title && (p.harness === r.harness || p.harness === "shell") && sameSession(r, p),
    // An earlier relaunch, or an agent that has not reported a session yet, under a new pane ID. Shells have
    // no session to tell them apart, so a shell also needs its cwd.
    (r, p) => p.harness === r.harness && p.title === r.title && sameSession(r, p) && (r.harness !== "shell" || p.cwd === r.cwd),
  ];
  const claimed = new Map<SessionRecord, LivePane>();
  for (const matches of matchers) {
    for (const r of records) {
      if (claimed.has(r)) continue;
      const i = unclaimed.findIndex((p) => matches(r, p));
      if (i !== -1) claimed.set(r, unclaimed.splice(i, 1)[0]!);
    }
  }

  // Herdr's agent fact outlives a failed start, so an agent counts as present only if its pane runs it.
  const present = new Set<SessionRecord>();
  const unreadable = new Map<SessionRecord, Error>();
  for (const [r, pane] of claimed) {
    const agent = agents[r.harness];
    try {
      if (agent === null ? pane.harness === "shell" : await runsAgent(guest, pane.herdrPane, agent.kind)) present.add(r);
    } catch (err) {
      unreadable.set(r, err as Error);
    }
  }
  const recordsOf = (r: SessionRecord) => r.harness === "claude-code" && r.harnessSessionId !== null
    ? records.filter((other) => other.harness === "claude-code" && other.harnessSessionId === r.harnessSessionId) : [r];
  // Any of a session's panes might still run it, so none of them is started or closed.
  const doubt = (r: SessionRecord) => recordsOf(r).flatMap((other) => unreadable.has(other) ? [{ pane: claimed.get(other)!.herdrPane, err: unreadable.get(other)! }] : [])[0];
  const kept = (r: SessionRecord) => r === (recordsOf(r).find((other) => present.has(other)) ?? recordsOf(r)[0]);

  const outcomes: RelaunchOutcome[] = [];
  for (const r of records) {
    const pane = claimed.get(r);
    const resume = r.harnessSessionId ?? undefined;
    try {
      const unsure = present.has(r) ? undefined : doubt(r);
      if (unsure) throw new Error(`whether ${unsure.pane} still runs the session could not be read, so it was not started again: ${unsure.err.message}`);
      if (!kept(r)) {
        if (pane) await closeSession(guest, pane.herdrPane);
        outcomes.push({ record: r, result: "dropped", herdrPane: pane?.herdrPane ?? null });
      } else if (present.has(r)) {
        outcomes.push({ record: r, result: "present", herdrPane: pane!.herdrPane });
      } else if (pane) {
        await startHarness(guest, pane.herdrPane, r.harness, resume, undefined, r.model);
        outcomes.push({ record: r, result: "relaunched", herdrPane: pane.herdrPane });
      } else {
        const herdrPane = await openSession(guest, { harness: r.harness, title: r.title, cwd: r.cwd, ...(r.model === undefined ? {} : { model: r.model }), ...(resume === undefined ? {} : { resume }) });
        outcomes.push({ record: r, result: "relaunched", herdrPane });
      }
    } catch (err) {
      outcomes.push({ record: r, result: "failed", herdrPane: err instanceof ClaudeLaunchStalled ? err.herdrPane : pane?.herdrPane ?? null, message: (err as Error).message });
    }
  }
  await recordOutcomes(guest, file, outcomes);
  return outcomes;
}

/** Each record now names the pane it is in, so a failure is not recorded a second time as the shell it left. */
async function recordOutcomes(guest: Guest, file: SessionsFile, outcomes: readonly RelaunchOutcome[]): Promise<void> {
  await writeSessionsFile(guest, {
    ...file,
    sessions: outcomes.flatMap((o) => o.result === "present" || o.result === "relaunched" ? [{ ...o.record, herdrPane: o.herdrPane }] : []),
    failed: outcomes.flatMap((o): FailedRecord[] => o.result !== "failed" ? []
      : [{ record: { ...o.record, herdrPane: o.herdrPane ?? o.record.herdrPane }, inPane: o.herdrPane !== null, message: o.message }]),
  });
}

/** Whether a foreground process in the pane is the agent's executable, which Herdr names its agent kind after. */
async function runsAgent(guest: Guest, pane: string, kind: string): Promise<boolean> {
  return (await agentProcesses(guest, pane, kind)).length > 0;
}

/** The argv of each foreground process in the pane that is the agent's executable. */
async function agentProcesses(guest: Guest, pane: string, kind: string): Promise<readonly (readonly unknown[])[]> {
  const info = record(record(await herdr(guest, ["pane", "process-info", "--pane", pane]), "pane process-info").process_info, "process_info");
  return array(info.foreground_processes ?? [], "foreground_processes").flatMap((value) => {
    const p = record(value, "foreground process");
    const argv: readonly unknown[] = Array.isArray(p.argv) ? p.argv : [p.argv0, p.name];
    // An agent run by node, such as pi, shows its script as the second argument.
    return argv.slice(0, 2).some((arg) => typeof arg === "string" && arg.split("/").at(-1) === kind) ? [argv] : [];
  });
}

/** Keep an explicit model override across checkpoint relaunches. */
async function launchedClaudeModel(guest: Guest, pane: string): Promise<{ model?: string }> {
  for (const argv of await agentProcesses(guest, pane, "claude").catch((err) => {
    if (err instanceof HerdrError && err.code === "pane_not_found") return [];
    throw err;
  })) {
    const i = argv.indexOf("--model");
    if (i !== -1 && typeof argv[i + 1] === "string") return { model: argv[i + 1] as string };
  }
  return {};
}

/**
 * The session ID a Claude Code pane was started under, `--session-id <id>` or `--resume <id>` on its command
 * line, for a pane Herdr reports no ID for. Null when its Claude was started without one, such as by hand, or
 * when the pane closed meanwhile.
 */
async function launchedClaudeSession(guest: Guest, pane: string): Promise<string | null> {
  let processes: Awaited<ReturnType<typeof agentProcesses>>;
  try {
    processes = await agentProcesses(guest, pane, agents["claude-code"]!.kind);
  } catch (err) {
    if (err instanceof HerdrError && err.code === "pane_not_found") return null;
    throw err;
  }
  for (const argv of processes) {
    const i = argv.findIndex((arg) => arg === "--session-id" || arg === "--resume");
    const id = i === -1 ? undefined : argv[i + 1];
    if (typeof id === "string" && id !== "" && !id.startsWith("-")) return id;
  }
  return null;
}

/**
 * setsid detaches the server from the exec, and the redirects let the exec return without waiting on its output.
 * PID 1 in a pylon is Gondolin's sandboxd, which never reaps the orphans it adopts, so an agent whose pane
 * shell exits first would stay a zombie. tini -s is the subreaper for everything under Herdr instead. It
 * is unconditional because the base image guarantees /usr/bin/tini.
 */
const startServer = `setsid -f tini -s -- herdr --session ${herdrSession} server </dev/null >/dev/null 2>&1`;

/**
 * The shell command a human's terminal runs in the pylon to attach to its Herdr session. With no server yet, it
 * starts one as a session open does, so the server outlives the terminal and runs under tini, and waits for it.
 * `herdr --session nexus` is the whole command line of each attached client, which attachedTerminals counts.
 */
export const attachScript = `herdr --session ${herdrSession} workspace list >/dev/null 2>&1 || { ${startServer}; i=0; until herdr --session ${herdrSession} workspace list >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt ${serverStartMs / 100} ] || break; sleep 0.1; done; }; exec herdr --session ${herdrSession}`;

/**
 * How many terminals are attached to the pylon's Herdr session, such as `nexus attach` from a Mac, which count as
 * a human's presence. Rejects when the guest cannot be counted, so the caller decides what that means.
 */
export async function attachedTerminals(guest: Guest, timeoutMs = callTimeoutMs): Promise<number> {
  const { exitCode, output } = await guest.exec(["pgrep", "-c", "-x", "-f", `herdr --session ${herdrSession}`], { cwd: home, timeoutMs });
  // pgrep prints the count, 0 included, and exits 1 when it is 0.
  const count = Number(output.trim());
  if ((exitCode !== 0 && exitCode !== 1) || output.trim() === "" || !Number.isInteger(count)) {
    throw new Error(`counting attached terminals: pgrep exited ${exitCode}: ${output.trim().slice(-200)}`);
  }
  return count;
}

async function ensureServer(guest: Guest): Promise<void> {
  if (await serverRunning(guest)) return;
  const start = await guest.exec(["sh", "-c", startServer], { cwd: home, timeoutMs: callTimeoutMs });
  if (start.exitCode !== 0) throw new Error(`starting the Herdr server failed with exit ${start.exitCode}: ${start.output}`);
  const deadline = Date.now() + serverStartMs;
  while (!await serverRunning(guest)) {
    if (Date.now() >= deadline) throw new Error(`the Herdr server did not answer within ${serverStartMs} ms of starting`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** `herdr status server` exits 0 whether or not a server runs, so ask the API and read its error code. */
async function serverRunning(guest: Guest): Promise<boolean> {
  return herdr(guest, ["workspace", "list"]).then(() => true, noServer(false));
}

function noServer<T>(value: T): (err: unknown) => T {
  return (err) => {
    if (err instanceof HerdrError && err.code === "server_not_running") return value;
    throw err;
  };
}

interface LivePane {
  herdrPane: string;
  harness: SessionHarness;
  title: string;
  cwd: string;
  harnessSessionId: string | null;
  status: HerdrStatus;
}

const statuses: ReadonlySet<unknown> = new Set(["working", "idle", "blocked", "done", "unknown"] satisfies HerdrStatus[]);

async function livePanes(guest: Guest, timeoutMs = callTimeoutMs): Promise<LivePane[]> {
  const snapshot = record(record(await herdr(guest, ["api", "snapshot"], timeoutMs), "api snapshot").snapshot, "api snapshot .snapshot");
  const labels = new Map(array(snapshot.workspaces, "workspaces").map((w) => {
    const workspace = record(w, "workspace");
    return [string(workspace.workspace_id, "workspace_id"), string(workspace.label, "workspace label")] as const;
  }));
  return array(snapshot.panes, "panes").map((value): LivePane => {
    const pane = record(value, "pane");
    const herdrPane = string(pane.pane_id, "pane_id");
    const agent = nullableString(pane.agent, `${herdrPane} agent`);
    const harness = harnessOf(agent);
    if (!statuses.has(pane.agent_status)) throw new Error(`Herdr pane ${herdrPane} has unknown status ${JSON.stringify(pane.agent_status)}`);
    const session = pane.agent_session === null || pane.agent_session === undefined ? null : record(pane.agent_session, `${herdrPane} agent_session`);
    const title = labels.get(string(pane.workspace_id, "workspace_id"));
    if (title === undefined) throw new Error(`Herdr pane ${herdrPane} is in a workspace the snapshot does not list`);
    return {
      herdrPane,
      harness,
      title,
      cwd: nullableString(pane.foreground_cwd, "foreground_cwd") ?? nullableString(pane.cwd, "cwd") ?? checkoutDir,
      harnessSessionId: harness !== "shell" && session !== null && session.agent === agent ? string(session.value, "agent_session.value") : null,
      status: pane.agent_status as HerdrStatus,
    };
  });
}

/** A missing file means a pylon that has never paused, so there is nothing to relaunch. */
async function readSessionsFile(guest: Guest, timeoutMs = callTimeoutMs): Promise<SessionsFile | null> {
  const { exitCode, output } = await guest.exec(["sh", "-c", 'test -e "$0" || exit 3; exec cat -- "$0"', sessionsFile], { cwd: home, timeoutMs });
  if (exitCode === 3) return null;
  if (exitCode !== 0) throw new Error(`reading ${sessionsFile} failed with exit ${exitCode}: ${output}`);
  return parseSessionsFile(output);
}

function parseSessionsFile(text: string): SessionsFile {
  const file = record(JSON.parse(text), sessionsFile);
  if (file.version !== 1) throw new Error(`${sessionsFile} has unknown version ${JSON.stringify(file.version)}`);
  return {
    version: 1,
    recordedAt: string(file.recordedAt, "recordedAt"),
    sessions: array(file.sessions, "sessions").map(sessionRecord),
    failed: array(file.failed, "failed").map((value): FailedRecord => {
      const f = record(value, "failed record");
      if (typeof f.inPane !== "boolean") throw new Error(`${sessionsFile} has a failed record without inPane`);
      return { record: sessionRecord(f.record), inPane: f.inPane, message: string(f.message, "message") };
    }),
  };
}

function sessionRecord(value: unknown): SessionRecord {
  const r = record(value, "session record");
  if (typeof r.harness !== "string" || !(r.harness in agents)) throw new Error(`${sessionsFile} names unknown harness ${JSON.stringify(r.harness)}`);
  return {
    herdrPane: string(r.herdrPane, "herdrPane"),
    harness: r.harness as SessionHarness,
    title: string(r.title, "title"),
    cwd: string(r.cwd, "cwd"),
    harnessSessionId: nullableString(r.harnessSessionId, "harnessSessionId"),
    ...(r.model === undefined ? {} : { model: string(r.model, "model") }),
  };
}

async function writeSessionsFile(guest: Guest, file: SessionsFile): Promise<void> {
  await guest.writeFiles([{ path: sessionsFile, mode: 0o644, owner: "user", content: JSON.stringify(file, null, 2) + "\n" }]);
}

/**
 * Runs its arguments only if it creates the directory `$0`, which only one exec can, so a launch typed by an exec its
 * probe outlived is never typed again by a later probe. Exits 75 when another exec created it first.
 */
const claimThenRun = 'mkdir "$0" 2>/dev/null && exec "$@"; test -d "$0" && exit 75; mkdir "$0"';

/**
 * One Herdr CLI call. Control commands print one JSON line, `{ id, result }` or `{ id, error }`, and the
 * exec merges stderr into the output, so the reply is the last line that starts with `{`.
 */
async function herdr(guest: Guest, args: readonly string[], timeoutMs = callTimeoutMs, marker?: string): Promise<unknown> {
  const what = `herdr ${args.slice(0, 2).join(" ")}`;
  const argv = ["herdr", "--session", herdrSession, ...args];
  const { exitCode, output } = await guest.exec(marker === undefined ? argv : ["sh", "-c", claimThenRun, marker, ...argv], { cwd: home, timeoutMs });
  if (exitCode === null) throw new Error(`${what} did not finish within ${timeoutMs} ms`);
  if (marker !== undefined && exitCode === 75) throw new Error(`${what} ran nothing, because another exec had already claimed ${marker}`);
  const line = output.trimEnd().split("\n").findLast((l) => l.startsWith("{"));
  // `pane run` succeeds silently.
  if (line === undefined && exitCode === 0 && output.trim() === "") return undefined;
  if (line === undefined) throw new Error(`${what} exited ${exitCode} without a JSON reply: ${output.slice(-500)}`);
  const reply = record(JSON.parse(line), `${what} reply`);
  if (reply.error !== undefined) {
    const error = record(reply.error, `${what} error`);
    throw new HerdrError(string(error.code, "error code"), `${what}: ${string(error.message, "error message")}`);
  }
  if (exitCode !== 0) throw new Error(`${what} exited ${exitCode}: ${output.slice(-500)}`);
  return reply.result;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}
function string(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${what} is not a non-empty string`);
  return value;
}
function nullableString(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : string(value, what);
}
