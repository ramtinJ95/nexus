/**
 * The kinds of session a pylon runs, as the wire contract and the control plane read them, and the checks a Claude
 * Code session ID and typed text must pass. The probe starts each kind from its launcher (probe/guest/launchers.ts),
 * keyed by the same names.
 */
import { z } from "zod";
import { chatgptTokenGrant, type SecretGrant } from "./secret-grants.ts";

/** The host a Claude token or Anthropic API key is sent to. */
export const anthropicApiHost = "api.anthropic.com";

/** A Claude Code session ID as Nexus takes one: it names the session's transcript file and its launch directory. */
export const claudeSessionId = /^[A-Za-z0-9-]{1,200}$/;

interface AgentKind {
  /** Its name on the dashboard. */
  label: string;
  /** What tells the control plane its agent is working: Herdr Core's status of the terminal, or the agent's own hooks. */
  activity: "herdr" | "hooks";
  /** The open-session fields it takes. A shell is its terminal's own login shell, so it starts nothing and resumes nothing. */
  takes: { readonly resume: boolean; readonly prompt: boolean; readonly model: boolean };
  /**
   * The secret grants that sign its agent in, any one of which serves. The control plane holds the value of a `held`
   * one and hands it to every probe, so no node's secret file sets it.
   */
  signIn: { readonly grants: readonly SecretGrant[]; readonly held: boolean } | null;
}

export const agentKinds = {
  // Herdr could keep a dead Claude's working status, so only its expiring hook lease keeps it awake.
  // deploy/credentials.ts's claudeNames, which the deployer reads without zod, names the same two grants.
  "claude-code": {
    label: "Claude Code", activity: "hooks", takes: { resume: true, prompt: true, model: true },
    signIn: { grants: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: [anthropicApiHost] }, { name: "ANTHROPIC_API_KEY", hosts: [anthropicApiHost] }], held: false },
  },
  pi: { label: "pi", activity: "herdr", takes: { resume: true, prompt: false, model: false }, signIn: { grants: [chatgptTokenGrant], held: true } },
  shell: { label: "Shell", activity: "herdr", takes: { resume: false, prompt: false, model: false }, signIn: null },
} as const satisfies Record<string, AgentKind>;

export type SessionHarness = keyof typeof agentKinds;
export const sessionHarnessSchema = z.enum(Object.keys(agentKinds) as [SessionHarness, ...SessionHarness[]]);

/** The entry of a kind an observation or a stored row names, which can be one this build does not know, as a newer probe's. */
export function harnessNamed(name: string): AgentKind | undefined {
  return Object.hasOwn(agentKinds, name) ? agentKinds[name as SessionHarness] : undefined;
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
