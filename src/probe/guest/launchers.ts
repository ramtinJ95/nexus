/**
 * How the probe starts the agent of each session kind in its pane, and how a pylon signs it in at boot, keyed by
 * protocol/agent-kinds.ts's names. A kind whose sessions take a prompt or a model has the launch arguments for them
 * here, and one that takes neither has none.
 */
import { randomUUID } from "node:crypto";
import type { Guest } from "../../backends/backend.ts";
import type { agentKinds, SessionHarness } from "../../protocol/agent-kinds.ts";
import { defaultClaudeModel } from "../../protocol/models.ts";
import { chatgptTokenGrant } from "../../protocol/secret-grants.ts";
import { shellQuote as q } from "../../shell.ts";
import { callTimeoutMs, onClaudeTranscript } from "../../guest-contract.ts";
import { checkoutDir, claudeProjects, home } from "../../../images/pylon/nexus-contract.ts";

export interface Launcher {
  /** Herdr's agent kind, which Herdr names after the agent's executable. */
  kind: string;
  /** The launch arguments that resume a harness session ID, and whether the session already took a prompt, which a prompted launch must not repeat. */
  resume(guest: Guest, id: string): Promise<{ args: readonly string[]; hasHistory: boolean }>;
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
  /** A shell command that runs as user on every boot of a pylon granted one of its kind's sign-in grants, after the dotfiles pull. */
  login?: string;
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

/**
 * Sets pi's `openai` entry in ~/.pi/agent/auth.json, keeping every other provider's, to a ChatGPT sign-in whose access
 * token is the chatgpt login's placeholder, which the host swaps for the real token toward api.openai.com only. With no
 * refresh token and an expiry in 2100, pi never tries a refresh.
 */
const piChatgptLogin = `
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(process.env.HOME, ".pi", "agent");
const file = path.join(dir, "auth.json");
const access = process.env.${chatgptTokenGrant.name};
if (!access) {
  console.log("pi: ${chatgptTokenGrant.name} is not set, so ~/.pi/agent/auth.json is left as it is");
  process.exit(1);
}
let auth = {};
try {
  auth = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") auth = null;
}
if (auth === null || typeof auth !== "object" || Array.isArray(auth)) {
  console.log("pi: ~/.pi/agent/auth.json is not a readable JSON object, so it is left as it is");
  process.exit(1);
}
auth.openai = { type: "oauth", access, refresh: "", expires: 4102444800000 };
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(file + ".nexus-tmp", JSON.stringify(auth, null, 2) + "\\n", { mode: 0o600 });
fs.renameSync(file + ".nexus-tmp", file);
console.log("pi: signed in to ChatGPT as its openai provider");
`;

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
  pi: {
    kind: "pi",
    resume: async (_guest, sessionFile) => ({ args: ["--session", sessionFile], hasHistory: true }),
    fresh: () => [],
    flags: [],
    login: `node -e ${q(piChatgptLogin)}`,
    onePane: false,
  },
  shell: null,
} satisfies { [H in SessionHarness]: LauncherOf<H> };

export const launchers: { readonly [H in SessionHarness]: Launcher | null } = table;
export const claudeCode: Launcher = table["claude-code"];

/**
 * Claude Code writes no transcript until its first prompt, and `--resume` of an ID without one exits, so
 * a session that was opened but never prompted would not come back. `--session-id` starts it fresh under
 * the same ID instead.
 */
async function claudeResume(guest: Guest, id: string): Promise<{ args: readonly string[]; hasHistory: boolean }> {
  const { exitCode, output } = await guest.exec(["sh", "-c", onClaudeTranscript(":", 1), id, claudeProjects], { cwd: home, timeoutMs: callTimeoutMs });
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
  state.effortLevel = 'high';
  state.attribution = { ...state.attribution, commit: '', pr: '' };
  state.skipDangerousModePermissionPrompt = true;
});
`;
