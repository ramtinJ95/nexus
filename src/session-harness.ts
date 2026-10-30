/**
 * The session harnesses: everything Nexus does differently for one kind of session, and the checks a Claude Code
 * session ID and typed text must pass. The protocol parses harness names against this table, so it imports no Herdr.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { seedClaudeState } from "./claude-state.ts";

/** Where the repository is checked out in every pylon. */
export const checkoutDir = "/home/user/workspace/repo";
/** A Claude Code session ID as Nexus takes one: it names the session's transcript file and its launch directory. */
export const claudeSessionId = /^[A-Za-z0-9-]{1,200}$/;

export const home = "/home/user";
export const callTimeoutMs = 10_000;

/** backend.ts's Guest satisfies it. This file stays free of backend.ts and of the Herdr driver. */
interface Guest {
  exec(argv: readonly string[], opts: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number | null; output: string }>;
}

/** A session harness: everything Nexus does differently for one kind of session. */
interface Harness {
  /** Its name on the dashboard. */
  label: string;
  /** What tells the control plane its agent is working: Herdr's status of the pane, or the agent's own hooks. */
  activity: "herdr" | "hooks";
  /** The agent it starts in its pane. A shell is the pane's own login shell, so it starts nothing and resumes nothing. */
  agent: Agent | null;
}

export interface Agent {
  /** Herdr's agent kind, which Herdr names after the agent's executable. */
  kind: string;
  /** The launch arguments that resume a harness session ID, and whether the session already took a prompt, which a prompted launch must not repeat. */
  resume(guest: Guest, id: string): Promise<{ args: readonly string[]; hasHistory: boolean }>;
  /** The launch arguments of a fresh start. */
  fresh(): readonly string[];
  /** Arguments every launch passes, after those and any model. */
  flags: readonly string[];
  /** The flag a launch passes a model with, which recordSessions reads back. A harness without one takes no model. */
  modelFlag?: string;
  /** The flags its command line names its session ID with, which recordSessions reads when Herdr has learned none. */
  sessionFlags?: readonly string[];
  /** Launch arguments that make the agent run `command` as it takes its first prompt. A harness without them takes no prompt. */
  promptReceipt?(command: string): readonly string[];
  /** Runs before a start. It is idempotent, so one run serves every start after it. */
  seed?(guest: Guest): Promise<void>;
  /**
   * A session runs in one pane only. A relaunch brings it back in one and holds it from sends and launches meanwhile,
   * and a start Herdr reports failed is kept while its pane runs the agent, so the session is never started twice.
   */
  onePane: boolean;
}

const sessionHarnesses = {
  "claude-code": {
    label: "Claude Code",
    // Herdr can retain a dead Claude's working status; only its expiring hook lease keeps it awake.
    activity: "hooks",
    agent: {
      kind: "claude",
      resume: claudeResume,
      // Herdr learns a Claude Code session's ID from Claude's SessionStart hook, which does not run while Claude
      // waits at its login or trust screen, nor again once the human is past it. So every Claude Code start
      // names its ID, and recordSessions reads it back from the pane's command line when Herdr has none.
      fresh: () => ["--session-id", randomUUID()],
      flags: ["--permission-mode", "bypassPermissions"],
      modelFlag: "--model",
      sessionFlags: ["--session-id", "--resume"],
      promptReceipt: (command) => ["--settings", JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] } })],
      seed: seedClaude,
      onePane: true,
    },
  },
  pi: {
    label: "pi",
    activity: "herdr",
    // pi 1.4.0 opens a missing --session path as a new session that it first writes there on its first
    // message, so unlike a Claude Code ID the path needs no check, and its history is not looked for. pi reports its
    // session file at once.
    agent: { kind: "pi", resume: async (_guest, sessionFile) => ({ args: ["--session", sessionFile], hasHistory: true }), fresh: () => [], flags: [], onePane: false },
  },
  shell: { label: "Shell", activity: "herdr", agent: null },
} satisfies Record<string, Harness>;

export type SessionHarness = keyof typeof sessionHarnesses;
export const claudeCode = sessionHarnesses["claude-code"].agent;
export const harnesses: { readonly [H in SessionHarness]: Harness } = sessionHarnesses;
export const sessionHarnessSchema = z.enum(Object.keys(harnesses) as [SessionHarness, ...SessionHarness[]]);

/** The entry of a harness an observation or a stored row names, which can be one this build does not know, as a newer probe's. */
export function harnessNamed(name: string): Harness | undefined {
  return Object.hasOwn(harnesses, name) ? harnesses[name as SessionHarness] : undefined;
}

/**
 * Claude Code writes no transcript until its first prompt, and `--resume` of an ID without one exits, so
 * a session that was opened but never prompted would not come back. `--session-id` starts it fresh under
 * the same ID instead. The guest looks for the transcript under any project, whatever slug Claude gave the cwd.
 */
async function claudeResume(guest: Guest, id: string): Promise<{ args: readonly string[]; hasHistory: boolean }> {
  const { exitCode, output } = await guest.exec(["sh", "-c", 'for f in "$1"/*/"$0".jsonl; do [ -e "$f" ] && exit 0; done; exit 1', id, `${home}/.claude/projects`], { cwd: home, timeoutMs: callTimeoutMs });
  if (exitCode === 0) return { args: ["--resume", id], hasHistory: true };
  if (exitCode === 1) return { args: ["--session-id", id], hasHistory: false };
  throw new Error(`looking for Claude Code transcript ${id} failed with exit ${exitCode}: ${output}`);
}

async function seedClaude(guest: Guest): Promise<void> {
  const seeded = await guest.exec(["node", "-e", seedClaudeState, checkoutDir], { cwd: home, timeoutMs: callTimeoutMs });
  if (seeded.exitCode !== 0) throw new Error(`seeding Claude state failed: ${seeded.output}`);
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
