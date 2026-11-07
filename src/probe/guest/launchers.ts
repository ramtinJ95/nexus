/**
 * How the probe starts the agent of each session kind in its pane, keyed by protocol/agent-kinds.ts's names. A kind
 * whose sessions take a prompt or a model has the launch arguments for them here, and one that takes neither has none.
 */
import { randomUUID } from "node:crypto";
import type { Guest } from "../../backends/backend.ts";
import { defaultClaudeModel, type agentKinds, type SessionHarness } from "../../protocol/agent-kinds.ts";
import { checkoutDir } from "../../protocol/spawn.ts";

export const home = "/home/user";
export const callTimeoutMs = 10_000;

export interface Launcher {
  /** Herdr's agent kind, which Herdr names after the agent's executable. */
  kind: string;
  /** The launch arguments that resume a harness session ID, and whether the session already took a prompt, which a prompted launch must not repeat. */
  resume(guest: Guest, id: string): Promise<{ args: readonly string[]; hasHistory: boolean }>;
  /** The launch arguments of a fresh start. */
  fresh(): readonly string[];
  /** Arguments every launch passes, after those and any model. */
  flags: readonly string[];
  /** The flag a launch passes a model with, which recordSessions reads back. */
  modelFlag?: string;
  /** The flags its command line names its session ID with, which recordSessions reads when Herdr has learned none. */
  sessionFlags?: readonly string[];
  /** Launch arguments that make the agent run `command` as it takes its first prompt. */
  promptReceipt?(command: string): readonly string[];
  /** Runs before a start. It is idempotent, so one run serves every start after it. */
  seed?(guest: Guest): Promise<void>;
  /**
   * A session runs in one pane only. A relaunch brings it back in one and holds it from sends and launches meanwhile,
   * and a start Herdr reports failed is kept while its pane runs the agent, so the session is never started twice.
   */
  onePane: boolean;
}

type Takes<H extends SessionHarness> = (typeof agentKinds)[H]["takes"];
/** A kind that resumes nothing starts nothing. One has the prompt and model arguments exactly when its sessions take them. */
type LauncherOf<H extends SessionHarness> = Takes<H>["resume"] extends false ? null : Launcher
  & (Takes<H>["prompt"] extends true ? Required<Pick<Launcher, "promptReceipt">> : { promptReceipt?: never })
  & (Takes<H>["model"] extends true ? Required<Pick<Launcher, "modelFlag">> : { modelFlag?: never });

const table = {
  "claude-code": {
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
  // pi 1.4.0 opens a missing --session path as a new session that it first writes there on its first
  // message, so unlike a Claude Code ID the path needs no check, and its history is not looked for. pi reports its
  // session file at once.
  pi: { kind: "pi", resume: async (_guest, sessionFile) => ({ args: ["--session", sessionFile], hasHistory: true }), fresh: () => [], flags: [], onePane: false },
  shell: null,
} satisfies { [H in SessionHarness]: LauncherOf<H> };

export const launchers: { readonly [H in SessionHarness]: Launcher | null } = table;
export const claudeCode: Launcher = table["claude-code"];

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

/** Runs in the guest before Claude starts, preserving credentials and unrelated user state. */
export const seedClaudeState = `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const cwd = fs.realpathSync(process.argv[1]);
if (cwd === path.parse(cwd).root || cwd === fs.realpathSync(home)) {
  throw new Error('refusing to grant Claude trust to root or HOME');
}
function snapshot(file) {
  try { return { text: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o7777 }; }
  catch (err) { if (err.code !== 'ENOENT') throw err; return { text: null, mode: 0o600 }; }
}
function merge(file, update) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = snapshot(file);
    const state = before.text === null ? {} : JSON.parse(before.text);
    const original = JSON.stringify(state);
    update(state);
    if (JSON.stringify(state) === original) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\\n', { mode: before.mode });
      fs.chmodSync(tmp, before.mode);
      const current = snapshot(file);
      if (current.text !== before.text || current.mode !== before.mode) continue;
      fs.renameSync(tmp, file);
      return;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  throw new Error('Claude state kept changing while seeding ' + file);
}
merge(path.join(home, '.claude.json'), state => {
  state.hasCompletedOnboarding = true;
  state.projects ??= {};
  state.projects[cwd] ??= {};
  state.projects[cwd].hasTrustDialogAccepted = true;
});
merge(path.join(home, '.claude/settings.json'), state => {
  state.theme ??= 'dark';
  state.model = '${defaultClaudeModel}';
  state.attribution = { ...state.attribution, commit: '', pr: '' };
  state.skipDangerousModePermissionPrompt = true;
});
`;
