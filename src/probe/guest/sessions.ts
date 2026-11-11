/**
 * Sessions inside a pylon, each one Herdr Core terminal: open and close them, read them for observations, record them
 * before a pause and relaunch them on wake. Every call goes through core.ts to the core the pylon's boot started, which
 * herdr-app and `nexus attach` reach too. Nexus does not use tmux.
 *
 * Each session Nexus opens is one terminal whose program is the harness itself, labelled with the session's title and
 * harness. Terminals opened by hand, such as from herdr-app, are reported and recorded like any other. A terminal another
 * one started, such as a shepherdr reviewer, belongs to it: it is reported, but never recorded or relaunched.
 *
 * A shell is kept, so a wake's core brings it back in place, at its address and with its labels, and the relaunch
 * finds it there. An agent is not: Core would bring it back as a bare shell. Its terminal ends with it, and the
 * relaunch, the only thing that starts agents, resumes it in a new terminal.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Guest } from "../../backends/backend.ts";
import type { TerminalStatus, PausedSession, SessionFact, SessionIdentity } from "../../protocol/observations.ts";
import type { CommandResult, InterruptClaudeOutcome } from "../../protocol/commands.ts";
import { nonEmpty, parseJson } from "../../parse.ts";
import { claudeCode, launchers, type Launcher } from "./launchers.ts";
import { agentKinds, claudeSessionId, sessionHarnessSchema, type SessionHarness } from "../../protocol/agent-kinds.ts";
import { callTimeoutMs, coreStartMs, coreViewer, ensureCore } from "../../guest-contract.ts";
import { core, CoreError, noCore, type Terminal } from "./core.ts";
import { checkoutDir, claudeLaunchesDir, home, sessionsFile } from "../../../images/pylon/nexus-contract.ts";

const agentStartTimeoutMs = 30_000;

/** What ~/.nexus/sessions.json holds for each session. The checkpoint carries the file. */
export interface SessionRecord {
  terminal: string;
  harness: SessionHarness;
  title: string;
  cwd: string;
  harnessSessionId: string | null;
  model?: string;
}

/** A session as recordSessions reports it: what a wake brings back, and where. */
export type RecordedSession = PausedSession & { cwd: string; model?: string };

/**
 * A session the last relaunch did not bring back. It stays in the file, through any number of records, until a
 * relaunch brings it back. When the relaunch left it in a terminal, such as a Claude whose launch stalled,
 * `record.terminal` is that terminal and the record stands for it, so closing the terminal is what drops the session.
 * One in no terminal is dropped by its ID (dropFailedSession), which is the address it was recorded at: Core never
 * gives an address out again, so no later session takes it.
 */
interface FailedRecord { record: SessionRecord; inTerminal: boolean; message: string }

/**
 * The failed records that still stand for a session: every one in no terminal, and each in a terminal that is still
 * live. `standsFor` holds the terminals of the second kind, which are those failed sessions rather than sessions of their own.
 */
function standing(file: SessionsFile | null, live: readonly LiveTerminal[]): { failed: FailedRecord[]; standsFor: Set<string> } {
  const addresses = new Set(live.map((p) => p.terminal));
  const failed = (file?.failed ?? []).filter((f) => !f.inTerminal || addresses.has(f.record.terminal));
  return { failed, standsFor: new Set(failed.flatMap((f) => f.inTerminal ? [f.record.terminal] : [])) };
}

interface SessionsFile { version: 1; recordedAt: string; sessions: readonly SessionRecord[]; failed: readonly FailedRecord[] }

export type RelaunchOutcome =
  | { record: SessionRecord; result: "present" | "relaunched"; terminal: string }
  | { record: SessionRecord; result: "failed"; terminal: string | null; message: string }
  /** A second record of a Claude Code session another record brings back. Its terminal, if live, is closed. */
  | { record: SessionRecord; result: "dropped"; terminal: string | null };

const titleLabel = "nexus.title";
const harnessLabel = "nexus.harness";
const labelsOf = (harness: SessionHarness, title: string) => ({ [titleLabel]: title, [harnessLabel]: harness });

/**
 * An agent's labels at its start, with the session its arguments name under its session label, so its terminal says
 * its session before the agent itself does: Claude's SessionStart hook and pi-shepherdr label it again as it changes.
 */
function agentLabels(agent: Launcher, harness: SessionHarness, title: string, args: readonly string[]): Record<string, string> {
  const { session } = startedWith(args, agent);
  return { ...labelsOf(harness, title), ...(agent.sessionLabel === undefined || session === null ? {} : { [agent.sessionLabel]: session }) };
}

/**
 * The argv of an agent's terminal. A login shell gives it the environment a person's shell has, and execs the agent,
 * so the agent is the terminal's foreground process. A core started from inside a Claude would hand that Claude's
 * session to every terminal, whose Claude would then report into it (images/pylon/nexus-heartbeat.ts), so the
 * terminal drops it.
 */
const launchArgv = (agent: Launcher, args: readonly string[]) =>
  ["env", "-u", "CLAUDE_CODE_SESSION_ID", "-u", "CLAUDECODE", "bash", "-lc", 'exec "$0" "$@"', agent.kind, ...args];

/**
 * Returns the new session's terminal. Rolls the terminal back if the harness exits as it starts.
 *
 * A session of a one-terminal harness, such as Claude Code, that a live terminal runs already is not started again,
 * and its terminal is returned: a core that crashed leaves its programs running, and the core this starts takes them
 * back. A prompted Claude Code launch is safe to send again under the same `resume` ID, as after the probe restarted
 * under it: its terminal is named after the session, and Core's names are unique among live terminals, so a second
 * launch finds the first one's terminal instead of starting Claude in another.
 */
export async function openSession(guest: Guest, session: { harness: SessionHarness; title: string; cwd: string; resume?: string; prompt?: string; model?: string; seeded?: boolean }): Promise<string> {
  await ensureCoreRuns(guest);
  const agent = launchers[session.harness];
  const labels = labelsOf(session.harness, session.title);
  if (agent === null) return (await core(guest, "terminal.run", { argv: ["bash", "-l"], cwd: session.cwd, labels, no_parent: true, keep: true })).address;
  if (session.prompt !== undefined && agent.hooks !== undefined) return promptedLaunch(guest, agent, session.harness, { ...session, prompt: session.prompt });
  const running = agent.oneTerminal && session.resume !== undefined ? await startedAlready(guest, agent, session.resume) : null;
  if (running !== null) return running;
  const { args } = await launchArgs(guest, agent, session);
  const { address } = await core(guest, "terminal.run", { argv: launchArgv(agent, args), cwd: session.cwd, labels: agentLabels(agent, session.harness, session.title, args), no_parent: true });
  await awaitReady(guest, agent, session.harness, address);
  return address;
}

/** How a start runs. `seeded` says the caller ran the agent's seed already, as a relaunch does once for all its starts. */
interface Start {
  resume?: string | undefined;
  model?: string | undefined;
  seeded?: boolean | undefined;
}

/** The agent's launch arguments, after its seed. `receipt` runs as the agent takes its first prompt. */
async function launchArgs(guest: Guest, agent: Launcher, start: Start, receipt?: string): Promise<{ args: string[]; hasHistory: boolean }> {
  if (!start.seeded) await agent.seed?.(guest);
  const { args, hasHistory } = start.resume === undefined ? { args: agent.fresh(), hasHistory: false } : await agent.resume(guest, start.resume);
  const model = start.model === undefined || agent.modelFlag === undefined ? [] : [agent.modelFlag, start.model];
  return { args: [...args, ...model, ...agent.flags, ...agent.hooks?.(receipt) ?? []], hasHistory };
}

/**
 * Waits up to 30 seconds for the agent to say it is ready. One blocked at startup, such as Claude Code asking whether
 * to trust the folder, or silent until then, as Claude is at that question, keeps its session open: it waits for its
 * human, who answers it in the terminal. One that exits is rolled back, with its screen in the failure.
 */
async function awaitReady(guest: Guest, agent: Launcher, harness: SessionHarness, terminal: string): Promise<void> {
  let failure: string;
  try {
    const waited = await core(guest, "terminal.wait", { terminal, timeout: agentStartTimeoutMs / 1000 }, agentStartTimeoutMs + callTimeoutMs);
    if (waited.reason !== "exit") return;
    failure = `${agentKinds[harness].label} exited${waited.exit_code == null ? "" : ` with ${waited.exit_code}`} as it started`;
  } catch (err) {
    if (agent.oneTerminal) {
      // Its label names the harness from the start, so only its foreground says whether the agent got as far as running.
      const running = await core(guest, "terminal.get", { terminal }).then((t) => t.state === "live" && harnessOf(t.foreground?.argv ?? []) === harness, () => null);
      if (running === true) return;
      if (running === null) throw new LaunchStalled(`${agentKinds[harness].label} launch stalled: ${(err as Error).message}; attach before starting another session`, terminal);
    }
    failure = (err as Error).message;
  }
  const shown = await screen(guest, terminal);
  try {
    await remove(guest, terminal);
  } catch (cleanup) {
    throw new Error(`${failure}; rolling back terminal ${terminal} also failed: ${(cleanup as Error).message}. The terminal showed:\n${shown}`);
  }
  throw new Error(`${failure}. The terminal showed:\n${shown}`);
}

/** Ends the terminal's program and removes the terminal. A kill is final, even for a kept terminal. */
async function remove(guest: Guest, terminal: string): Promise<void> {
  await core(guest, "terminal.kill", { terminal });
  await core(guest, "terminal.rm", { terminal });
}

/** The name a prompted launch claims its terminal by: Core's names are 1 to 32 of a-z 0-9 - _ . */
const launchName = (session: string) => `claude-${session.toLowerCase().replaceAll("-", "").slice(0, 25)}`;

/**
 * Starts Claude with `prompt` as its first prompt, the last argument of its command line, and waits for the
 * UserPromptSubmit receipt in its launch directory instead of its readiness. A launch whose terminal is live under its
 * name, an earlier launch of the session or one running beside it, waits for that one's receipt instead, as does one
 * whose session a live terminal runs under no name, such as a wake's relaunch of it. One that
 * fails after Core may have started Claude does the same if the name is live by then, and is otherwise as uncertain
 * as a stalled one.
 */
async function promptedLaunch(guest: Guest, agent: Launcher, harness: SessionHarness, session: Start & { title: string; cwd: string; prompt: string }): Promise<string> {
  const id = session.resume ?? randomUUID();
  if (!claudeSessionId.test(id)) throw new Error(`a prompted Claude launch needs a session ID of letters, digits and dashes, not ${JSON.stringify(id)}`);
  const launchDir = `${claudeLaunchesDir}/${id}`;
  const name = launchName(id);
  const earlier = await liveNamed(guest, name) ?? (session.resume === undefined ? null : await startedAlready(guest, agent, id));
  if (earlier !== null) {
    await awaitSubmission(guest, earlier, launchDir, " before the probe lost the launch");
    return earlier;
  }
  const { label } = agentKinds[harness];
  const { args, hasHistory } = await launchArgs(guest, agent, { ...session, resume: id }, `mkdir -p ${launchDir} && touch ${launchDir}/submitted`);
  if (hasHistory) throw new Error(`${label} session ${id} already has a transcript, so its first prompt went in before this launch, which started nothing. Attach to check before starting another session`);
  let address: string;
  try {
    address = (await core(guest, "terminal.run", { argv: launchArgv(agent, [...args, session.prompt]), cwd: session.cwd, name, labels: agentLabels(agent, harness, session.title, args), no_parent: true })).address;
  } catch (err) {
    const claimed = await liveNamed(guest, name).catch(() => null);
    if (claimed === null) throw err;
    address = claimed;
  }
  await awaitSubmission(guest, address, launchDir, "");
  return address;
}

/** The live terminal named `name`, or null. */
async function liveNamed(guest: Guest, name: string): Promise<string | null> {
  try {
    const t = await core(guest, "terminal.get", { terminal: name });
    return t.state === "live" ? t.address : null;
  } catch (err) {
    if (err instanceof CoreError && err.kind === "not_found") return null;
    throw err;
  }
}

/**
 * Waits up to 30 seconds for the launch's UserPromptSubmit receipt. A working Claude in the terminal also shows the
 * launch went in. Anything else leaves the terminal as it is for the person, since Claude may still be starting.
 */
async function awaitSubmission(guest: Guest, terminal: string, launchDir: string, note: string): Promise<void> {
  const submitted = await guest.exec(["sh", "-c", 'i=0; until test -f "$1"; do i=$((i+1)); test "$i" -lt 300 || exit 1; sleep 0.1; done', "claude-submitted", `${launchDir}/submitted`], { cwd: home, timeoutMs: 35_000 }).catch(() => ({ exitCode: null }));
  if (submitted.exitCode === 0) return;
  const live = await liveTerminalAt(guest, terminal).catch(() => null);
  if (live?.harness === "claude-code" && live.status === "working") return;
  throw new LaunchStalled(`Claude launch stalled: no UserPromptSubmit within 30 seconds${note}; attach before starting another session. The terminal showed:\n${await screen(guest, terminal)}`, terminal);
}

/** A launch whose terminal stays live because it may have started the agent, so it is not rolled back. */
export class LaunchStalled extends Error {
  readonly terminal: string;
  constructor(message: string, terminal: string) {
    super(message);
    this.terminal = terminal;
  }
}

/** Diagnostic only, so it never throws over the failure it explains. */
async function screen(guest: Guest, terminal: string): Promise<string> {
  try {
    return (await core(guest, "terminal.read", { terminal })).text.trimEnd();
  } catch (err) {
    return `(the terminal could not be read: ${(err as Error).message})`;
  }
}

/**
 * Closes the terminal, unless it is not live, or no core runs, or `expected` names another session than the one
 * sessionFacts reports there. A caller holding a terminal from before a wake must not read any of those as its
 * session closed, since the wake may have brought the session back in another terminal.
 */
export async function closeSession(guest: Guest, terminal: string, expected?: SessionIdentity): Promise<"closed" | "not-open" | "moved"> {
  if (expected !== undefined) {
    const there = (await sessionFacts(guest)).find((f) => f.terminal === terminal);
    if (there === undefined) return "not-open";
    // An ID or title either side has not learned yet, such as a Claude Code ID before its SessionStart hook, tells nothing.
    const differ = (a: string | null | undefined, b: string | null) => a != null && b !== null && a !== b;
    if (there.harness !== expected.harness || differ(there.harnessSessionId, expected.harnessSessionId) || differ(there.title, expected.title)) return "moved";
  }
  try {
    if ((await core(guest, "terminal.get", { terminal })).state !== "live") return "not-open";
    await remove(guest, terminal);
    return "closed";
  } catch (err) {
    if (err instanceof CoreError && (err.kind === "not_found" || err.kind === "no_core")) return "not-open";
    throw err;
  }
}

const claudeReadyMs = 15_000;
const claudeReadyPollMs = 250;
/** A send waits while a person has an unfinished draft in the terminal, up to Core's `draft_wait`, 60 seconds by default. */
const sendTimeoutMs = 75_000;

/**
 * Pastes `message.text` into the Claude Code session `message.session` as a prompt and submits it, as `hc send` does.
 * A session in no live terminal is resumed first, under `message.model` if given. The text goes in exactly as written,
 * so a leading `!` runs it as a shell command and a leading `/` as a slash command. Core waits for a person's
 * unfinished draft in an attached terminal before it pastes. Claude wraps a long paste in `<pasted_content>` tags,
 * which the conversation readers unwrap only from PR #651 (feat/activity-pasted-content) on, which this change needs.
 *
 * Claude taking nothing is an outcome: `blocked` when Claude waits at a dialog in its terminal, which the text would
 * answer, `starting` when Claude has said nothing yet after `readyWithinMs`, or Core still refuses the text as
 * starting by then, and `moved` when the terminal no longer runs the session by the time it is ready. The caller runs
 * one send per session at a time.
 *
 * The core starts first: a session in no terminal is resumed in one, and a core that crashed left its Claude running
 * for this one to take back, so the send finds it rather than resuming it beside itself.
 */
export async function sendToClaude(guest: Guest, message: { session: string; text: string; model?: string }, readyWithinMs = claudeReadyMs): Promise<Omit<Extract<CommandResult, { kind: "send-claude" }>, "kind">> {
  await ensureCoreRuns(guest);
  const found = await claudeTerminal(guest, message.session);
  const resumed = found === null;
  const terminal = found?.terminal ?? await openSession(guest, await resumeOf(guest, message.session, message.model));
  const closed = () => new Error(`Claude's terminal ${terminal} closed before it could take the message, so nothing was sent`);
  const deadline = Date.now() + readyWithinMs;
  let live = await liveTerminalAt(guest, terminal, closed);
  while (live.status === "unknown" && Date.now() < deadline) {
    await delay(claudeReadyPollMs);
    live = await liveTerminalAt(guest, terminal, closed);
  }
  if (live.status === "unknown") return { outcome: await atDialog(guest, terminal) ? "blocked" : "starting", terminal, resumed };
  if (live.status === "blocked") return { outcome: "blocked", terminal, resumed };
  if (!runsSession(live, claudeCode, message.session)) return { outcome: "moved", terminal, resumed };
  for (;;) {
    try {
      const sent = await core(guest, "terminal.send", { terminal, text: message.text }, sendTimeoutMs);
      return { outcome: sent.status === "working" ? "queued" : "sent", terminal, resumed };
    } catch (err) {
      // Core refuses before it pastes anything a blocked program, and as `unavailable` one whose output has not
      // settled, saying nothing was typed (spikes/herdr-core/README.md, send-starting), so that send can be tried again.
      if (err instanceof CoreError && err.kind === "blocked") return { outcome: "blocked", terminal, resumed };
      if (!(err instanceof CoreError && err.kind === "unavailable")) {
        throw new Error(`sending to Claude's terminal ${terminal} failed, so whether the message went in is unknown: ${(err as Error).message}`, { cause: err });
      }
      if (Date.now() >= deadline) return { outcome: "starting", terminal, resumed };
      await delay(claudeReadyPollMs);
    }
  }
}

/**
 * How a send resumes a Claude session in no live terminal: as the sessions file records it, with its title, cwd and
 * model, as when a message reaches a wake's session before the relaunch does. A session the file does not hold opens
 * in the checkout.
 */
async function resumeOf(guest: Guest, session: string, model: string | undefined) {
  const file = await readSessionsFile(guest);
  const r = [...file?.sessions ?? [], ...file?.failed.map((f) => f.record) ?? []].find((r) => r.harness === "claude-code" && r.harnessSessionId === session);
  const kept = model ?? r?.model;
  return { harness: "claude-code" as const, title: r?.title ?? agentKinds["claude-code"].label, cwd: r?.cwd ?? checkoutDir, resume: session, ...(kept === undefined ? {} : { model: kept }) };
}

/**
 * Claude's own words on the screens it says nothing at, which a starting Claude does not show. A pattern missed only
 * reports the session starting rather than blocked, since neither sends anything.
 */
const dialogs = [/Yes, I trust this folder/, /Do you trust the files in this folder/, /Select login method/, /Choose the text style/, /Press Enter to continue/];

async function atDialog(guest: Guest, terminal: string): Promise<boolean> {
  const text = await core(guest, "terminal.read", { terminal }).then((r) => r.text, () => "");
  return dialogs.some((d) => d.test(text));
}

/**
 * Presses Esc in the terminal that runs `session` while Claude works, which interrupts its turn as it does at the
 * terminal. Esc is the only key it ever presses. It presses nothing while Claude waits at a dialog, which Esc would
 * cancel, and nothing while Claude is idle. A session in no live terminal is not resumed, since it runs no turn.
 */
export async function interruptClaude(guest: Guest, session: string): Promise<InterruptClaudeOutcome> {
  const found = await claudeTerminal(guest, session);
  if (found === null) return "not-running";
  if (found.status !== "working") return found.status === "blocked" || found.status === "unknown" ? found.status : "idle";
  try {
    await core(guest, "terminal.keys", { terminal: found.terminal, keys: ["esc"] });
  } catch (err) {
    if (err instanceof CoreError && (err.kind === "not_found" || err.kind === "finished" || err.kind === "no_core")) return "not-running";
    throw err;
  }
  return "interrupted";
}

/** The live terminal that runs the Claude Code session `session`. */
async function claudeTerminal(guest: Guest, session: string): Promise<LiveTerminal | null> {
  return (await liveTerminals(guest).catch(noCore([]))).find((p) => runsSession(p, claudeCode, session)) ?? null;
}

/** The live terminal of no other one that runs `session`, which a start of the session must not start it beside. */
async function startedAlready(guest: Guest, agent: Launcher, session: string): Promise<string | null> {
  return (await liveTerminals(guest)).find((p) => !p.child && runsSession(p, agent, session))?.terminal ?? null;
}

/** Whether the agent runs `session` in the terminal: the terminal is the agent's, and its label or command line names the session. */
function runsSession(live: LiveTerminal, agent: Launcher, session: string): boolean {
  return launchers[live.harness] === agent && live.harnessSessionId === session;
}

/** The live terminal at `address`. Throws `gone()` when it is not live. */
async function liveTerminalAt(guest: Guest, address: string, gone = () => new Error(`terminal ${address} is not live`)): Promise<LiveTerminal> {
  const t = await core(guest, "terminal.get", { terminal: address }).catch((err: unknown) => {
    if (err instanceof CoreError && (err.kind === "not_found" || err.kind === "no_core")) throw gone();
    throw err;
  });
  if (t.state !== "live") throw gone();
  return liveTerminal(t);
}

/** Forgets a failed session in no terminal, by its ID, so no wake tries it again. False when the file holds no such session. */
export async function dropFailedSession(guest: Guest, id: string): Promise<boolean> {
  const file = await readSessionsFile(guest);
  if (file === null) return false;
  const failed = file.failed.filter((f) => f.inTerminal || f.record.terminal !== id);
  if (failed.length === file.failed.length) return false;
  await writeSessionsFile(guest, { ...file, failed });
  return true;
}

/**
 * The facts an observation carries: each live terminal, from one `terminal.list` exec, and each session the last wake
 * failed to bring back, from the sessions file. A terminal a failed record stands for is that failed session. No core
 * means no terminals. Any other failure rejects, so the caller can tell "none" from "unknown", such as a core that
 * crashed, whose programs still run until the next core takes them back.
 */
export async function sessionFacts(guest: Guest, timeoutMs = callTimeoutMs): Promise<readonly SessionFact[]> {
  const [terminals, file] = await Promise.all([liveTerminals(guest, timeoutMs).catch(noCore([])), readSessionsFile(guest, timeoutMs)]);
  const { failed, standsFor } = standing(file, terminals);
  const statusOf = new Map(terminals.map((p) => [p.terminal, p.status]));
  return [
    ...terminals.filter((p) => !standsFor.has(p.terminal)).map(({ terminal, harness, harnessSessionId, status, title }): SessionFact => ({
      id: terminal, state: "running", terminal, harness, harnessSessionId, status, title,
    })),
    ...failed.map((f): SessionFact => ({
      id: f.record.terminal, state: "failed", terminal: f.inTerminal ? f.record.terminal : null, harness: f.record.harness, harnessSessionId: f.record.harnessSessionId,
      status: f.inTerminal ? statusOf.get(f.record.terminal)! : "unknown", title: f.record.title, message: f.message,
    })),
  ];
}

/**
 * Writes every live session to ~/.nexus/sessions.json, before the disk checkpoint, and returns every session a
 * relaunch would bring back, under the IDs sessionFacts gave them. Sessions the last relaunch failed to bring back are
 * kept, except one whose terminal has since closed. With no core the file is left as it is and this returns null: a
 * core that never came up after the last wake must not erase the sessions that wake failed to relaunch. A core that
 * crashed rejects, so the last record stands then too.
 */
export async function recordSessions(guest: Guest): Promise<readonly RecordedSession[] | null> {
  const terminals = await liveTerminals(guest).catch(noCore(null));
  if (terminals === null) return null;
  const { failed, standsFor } = standing(await readSessionsFile(guest), terminals);
  const sessions = terminals.filter((p) => !p.child && !standsFor.has(p.terminal))
    .map(({ terminal, harness, title, cwd, harnessSessionId, model }): SessionRecord => ({ terminal, harness, title, cwd, ...(model === undefined ? {} : { model }), harnessSessionId }));
  const file: SessionsFile = { version: 1, recordedAt: new Date().toISOString(), sessions, failed };
  await writeSessionsFile(guest, file);
  return relaunchedFrom(file);
}

/**
 * What a sessions file read from a stopped disk says its wake brings back, as recordSessions would have returned it,
 * such as one whose pause stopped it and died before it could keep the list.
 */
export function pausedSessionsIn(text: string): readonly PausedSession[] {
  return relaunchedFrom(parseSessionsFile(text)).map(toPaused);
}

export function toPaused({ id, terminal, harness, harnessSessionId, title }: RecordedSession): PausedSession {
  return { id, terminal, harness, harnessSessionId, title };
}

function relaunchedFrom(file: SessionsFile): RecordedSession[] {
  const recorded = (r: SessionRecord, inTerminal: boolean): RecordedSession => ({ ...r, id: r.terminal, terminal: inTerminal ? r.terminal : null });
  return [...file.sessions.map((r) => recorded(r, true)), ...file.failed.map((f) => recorded(f.record, f.inTerminal))];
}

/**
 * On wake: start the core, then bring back each recorded session that is not already live. Running it again
 * converges: each live terminal answers for at most one record, so neither a kept shell the core brought back nor an
 * earlier relaunch is opened twice. One failure does not stop the rest, and the sessions file is rewritten with each
 * session's terminal and with the failures, so a later record keeps them. A core that does not start fails every
 * session, for its reason.
 *
 * A session of a one-terminal harness, such as Claude Code, comes back in one terminal only: the first record of it
 * whose terminal still runs it, or else its first record. Every other record of it is dropped and its terminal
 * closed. `lock` runs the relaunch while no send or launch of those sessions does, so none of them starts a session the
 * relaunch is bringing back.
 */
export async function relaunchSessions(guest: Guest, lock: ClaudeSessionLock): Promise<readonly RelaunchOutcome[]> {
  const file = await readSessionsFile(guest);
  if (file === null) return [];
  const records = [...file.sessions, ...file.failed.map((f) => f.record)];
  if (records.length === 0) return [];
  return lock(records.flatMap((r) => launchers[r.harness]?.oneTerminal && r.harnessSessionId !== null ? [r.harnessSessionId] : []), () => relaunch(guest, file, records));
}

/** Runs `work` while no other work holds any of `claudeSessions`, and holds them until it settles. */
export type ClaudeSessionLock = <T>(claudeSessions: readonly string[], work: () => Promise<T>) => Promise<T>;

async function relaunch(guest: Guest, file: SessionsFile, records: readonly SessionRecord[]): Promise<readonly RelaunchOutcome[]> {
  let unclaimed: LiveTerminal[];
  try {
    await ensureCoreRuns(guest);
    unclaimed = (await liveTerminals(guest)).filter((p) => !p.child);
  } catch (err) {
    const outcomes = records.map((record): RelaunchOutcome => ({ record, result: "failed", terminal: null, message: (err as Error).message }));
    await recordOutcomes(guest, file, outcomes);
    return outcomes;
  }
  const recordedIds = new Set(records.flatMap((r) => r.harnessSessionId ?? []));
  // A terminal whose agent runs another session is that session, not this one. A record with no ID can take a
  // terminal whose ID no record has, such as the one an earlier relaunch of it started.
  const sameSession = (r: SessionRecord, p: LiveTerminal) => p.harnessSessionId === null || p.harnessSessionId === r.harnessSessionId
    || (r.harnessSessionId === null && !recordedIds.has(p.harnessSessionId));
  // In order of confidence. Each pass gives every unmatched record the first unclaimed terminal it accepts. A terminal
  // runs a record's session only if it is the record's harness's.
  const matchers: ((r: SessionRecord, p: LiveTerminal) => boolean)[] = [
    (r, p) => r.harnessSessionId !== null && p.harnessSessionId === r.harnessSessionId,
    // A kept shell the core brought back in place.
    (r, p) => p.terminal === r.terminal && p.title === r.title && sameSession(r, p),
    // An earlier relaunch, or an agent whose session is not known yet, in a new terminal. Shells have no session to
    // tell them apart, so a shell also needs its cwd.
    (r, p) => p.title === r.title && sameSession(r, p) && (r.harness !== "shell" || p.cwd === r.cwd),
  ];
  const claimed = new Map<SessionRecord, LiveTerminal>();
  for (const matches of matchers) {
    for (const r of records) {
      if (claimed.has(r)) continue;
      const i = unclaimed.findIndex((p) => p.harness === r.harness && matches(r, p));
      if (i !== -1) claimed.set(r, unclaimed.splice(i, 1)[0]!);
    }
  }
  const recordsOf = (r: SessionRecord) => launchers[r.harness]?.oneTerminal && r.harnessSessionId !== null
    ? records.filter((other) => other.harness === r.harness && other.harnessSessionId === r.harnessSessionId) : [r];
  const kept = (r: SessionRecord) => r === (recordsOf(r).find((other) => claimed.has(other)) ?? recordsOf(r)[0]);
  // One seed before the starts serves them all. A seed that fails fails only the sessions of its agent.
  const seeds = new Map<Launcher["seed"], Error | null>();
  for (const r of records) {
    const seed = launchers[r.harness]?.seed;
    if (seed !== undefined && !claimed.has(r) && !seeds.has(seed)) seeds.set(seed, await seed(guest).then(() => null, (err: Error) => err));
  }

  const outcomes: RelaunchOutcome[] = [];
  for (const r of records) {
    const live = claimed.get(r);
    const resume = r.harnessSessionId ?? undefined;
    try {
      if (!kept(r)) {
        if (live) await closeSession(guest, live.terminal);
        outcomes.push({ record: r, result: "dropped", terminal: live?.terminal ?? null });
      } else if (live) {
        outcomes.push({ record: r, result: "present", terminal: live.terminal });
      } else {
        const unseeded = seeds.get(launchers[r.harness]?.seed);
        if (unseeded) throw unseeded;
        const terminal = await openSession(guest, { harness: r.harness, title: r.title, cwd: r.cwd, seeded: true, ...(r.model === undefined ? {} : { model: r.model }), ...(resume === undefined ? {} : { resume }) });
        outcomes.push({ record: r, result: "relaunched", terminal });
      }
    } catch (err) {
      outcomes.push({ record: r, result: "failed", terminal: err instanceof LaunchStalled ? err.terminal : null, message: (err as Error).message });
    }
  }
  await recordOutcomes(guest, file, outcomes);
  await removeFinished(guest);
  return outcomes;
}

/**
 * Removes the finished terminals Nexus opened, such as the agents a wake's core brought back as finished, which a
 * relaunch resumed in new ones, so they do not crowd herdr-app's list. One that cannot be removed is only clutter, so
 * it is left for the next wake.
 */
async function removeFinished(guest: Guest): Promise<void> {
  const all = await core(guest, "terminal.list", { all: true }).catch(() => ({ terminals: [] }));
  for (const t of all.terminals) {
    if (t.state === "finished" && t.labels[harnessLabel] !== undefined) await core(guest, "terminal.rm", { terminal: t.address }).catch(() => undefined);
  }
}

/** Each record now names the terminal it is in, so a failure is recorded once, at the terminal it left. */
async function recordOutcomes(guest: Guest, file: SessionsFile, outcomes: readonly RelaunchOutcome[]): Promise<void> {
  await writeSessionsFile(guest, {
    ...file,
    sessions: outcomes.flatMap((o) => o.result === "present" || o.result === "relaunched" ? [{ ...o.record, terminal: o.terminal }] : []),
    failed: outcomes.flatMap((o): FailedRecord[] => o.result !== "failed" ? []
      : [{ record: { ...o.record, terminal: o.terminal ?? o.record.terminal }, inTerminal: o.terminal !== null, message: o.message }]),
  });
}

/**
 * How many terminals are attached to the pylon's core, such as `nexus attach` from a Mac, which count as a human's
 * presence. Rejects when the guest cannot be counted, so the caller decides what that means.
 */
export async function attachedTerminals(guest: Guest, timeoutMs = callTimeoutMs): Promise<number> {
  const { exitCode, output } = await guest.exec(["pgrep", "-c", "-x", "-f", coreViewer], { cwd: home, timeoutMs });
  // pgrep prints the count, 0 included, and exits 1 when it is 0.
  const count = Number(output.trim());
  if ((exitCode !== 0 && exitCode !== 1) || output.trim() === "" || !Number.isInteger(count)) {
    throw new Error(`counting attached terminals: pgrep exited ${exitCode}: ${output.trim().slice(-200)}`);
  }
  return count;
}

async function ensureCoreRuns(guest: Guest): Promise<void> {
  const { exitCode, output } = await guest.exec(["sh", "-c", ensureCore], { cwd: home, timeoutMs: coreStartMs + callTimeoutMs });
  if (exitCode !== 0) throw new Error(`Herdr Core did not start within ${coreStartMs / 1000} seconds${output.trim() === "" ? "" : `: ${output.trim().slice(-500)}`}`);
}

interface LiveTerminal {
  terminal: string;
  harness: SessionHarness;
  title: string;
  cwd: string;
  harnessSessionId: string | null;
  status: TerminalStatus;
  /** The model its agent was started with, which a relaunch keeps. */
  model?: string;
  /** Another terminal started it, and it belongs to that one. */
  child: boolean;
}

/** The harness a command line runs. Agents Nexus does not launch, such as Codex started by hand, read as shells. An agent run by node, such as pi, shows its script as the second argument. */
function harnessOf(argv: readonly string[]): SessionHarness {
  const names = argv.slice(0, 2).map((arg) => arg.split("/").at(-1));
  return sessionHarnessSchema.options.find((h) => launchers[h] !== null && names.includes(launchers[h].kind)) ?? "shell";
}

/**
 * Core's status words, which are the program's own. `done` is a turn over that no one has looked at yet, and `error`
 * one that ended in an error, which a send may follow. A program that has said nothing is `unknown`, as every shell is.
 */
const statusWords: Readonly<Record<string, TerminalStatus>> = { working: "working", idle: "idle", done: "idle", error: "idle", blocked: "blocked" };

/**
 * A terminal Nexus started an agent in is that agent's from its start, by its label, while its foreground is still
 * the launch's env and login shell, since it ends with the agent. Any other terminal runs what its foreground does,
 * such as a Claude a person started in a shell.
 */
function liveTerminal(t: Terminal): LiveTerminal {
  const labelled = sessionHarnessSchema.safeParse(t.labels[harnessLabel]).data;
  const started = labelled !== undefined && launchers[labelled] !== null;
  const argv = started ? t.argv : t.foreground?.argv ?? [];
  const harness = started ? labelled : harnessOf(argv);
  const agent = launchers[harness];
  const args = agent === null ? { session: null } : startedWith(argv, agent);
  const sessionLabelled = agent?.sessionLabel === undefined ? undefined : t.labels[agent.sessionLabel];
  return {
    terminal: t.address,
    harness,
    title: t.labels[titleLabel] ?? t.name ?? agentKinds[harness].label,
    cwd: t.foreground?.cwd ?? t.cwd,
    harnessSessionId: sessionLabelled || args.session,
    status: t.status === null ? "unknown" : statusWords[t.status.state] ?? "unknown",
    ...(args.model === undefined ? {} : { model: args.model }),
    child: t.parent !== null,
  };
}

/** Each live terminal on this machine. A machine the person added to the pylon's core has terminals of its own, which are not the pylon's. */
async function liveTerminals(guest: Guest, timeoutMs = callTimeoutMs): Promise<LiveTerminal[]> {
  return (await core(guest, "terminal.list", {}, timeoutMs)).terminals.filter((t) => !t.address.includes("/")).map(liveTerminal);
}

/**
 * What the terminal's agent was started with, read from its command line: the model it was passed, which a relaunch
 * keeps, and the session it was named, such as Claude Code's `--session-id <id>` or `--resume <id>`, for a terminal
 * with no session label. The session is null when its agent was started without one, such as by hand.
 */
function startedWith(argv: readonly string[], { modelFlag, sessionFlags = [] }: Launcher): { model?: string; session: string | null } {
  const m = modelFlag === undefined ? -1 : argv.indexOf(modelFlag);
  const model = m === -1 ? undefined : argv[m + 1];
  const i = argv.findIndex((arg) => sessionFlags.includes(arg));
  const id = i === -1 ? undefined : argv[i + 1];
  return { ...(model === undefined ? {} : { model }), session: id !== undefined && id !== "" && !id.startsWith("-") ? id : null };
}

/** A missing file means a pylon that has never paused, so there is nothing to relaunch. */
async function readSessionsFile(guest: Guest, timeoutMs = callTimeoutMs): Promise<SessionsFile | null> {
  const { exitCode, output } = await guest.exec(["sh", "-c", 'test -e "$0" || exit 3; exec cat -- "$0"', sessionsFile], { cwd: home, timeoutMs });
  if (exitCode === 3) return null;
  if (exitCode !== 0) throw new Error(`reading ${sessionsFile} failed with exit ${exitCode}: ${output}`);
  return parseSessionsFile(output);
}

const sessionRecordSchema = z.object({
  terminal: nonEmpty,
  harness: sessionHarnessSchema,
  title: nonEmpty,
  cwd: nonEmpty,
  harnessSessionId: nonEmpty.nullish().transform((id) => id ?? null),
  model: nonEmpty.exactOptional(),
}) satisfies z.ZodType<SessionRecord>;
const sessionsFileSchema = z.object({
  version: z.literal(1),
  recordedAt: nonEmpty,
  sessions: z.array(sessionRecordSchema),
  failed: z.array(z.object({ record: sessionRecordSchema, inTerminal: z.boolean(), message: nonEmpty })),
}) satisfies z.ZodType<SessionsFile>;

function parseSessionsFile(text: string): SessionsFile {
  return parseJson(sessionsFileSchema, text, sessionsFile);
}

async function writeSessionsFile(guest: Guest, file: SessionsFile): Promise<void> {
  await guest.writeFiles([{ path: sessionsFile, mode: 0o644, owner: "user", content: JSON.stringify(file, null, 2) + "\n" }]);
}
