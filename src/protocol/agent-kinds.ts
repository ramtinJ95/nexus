/**
 * The kinds of session a pylon runs, as the wire contract and the control plane read them, and the checks a Claude
 * Code session ID and typed text must pass. The probe starts each kind from its launcher (probe/guest/launchers.ts),
 * keyed by the same names.
 */
import { z } from "zod";

/** A Claude Code session ID as Nexus takes one: it names the session's transcript file and its launch directory. */
export const claudeSessionId = /^[A-Za-z0-9-]{1,200}$/;

interface AgentKind {
  /** Its name on the dashboard. */
  label: string;
  /** What tells the control plane its agent is working: Herdr's status of the pane, or the agent's own hooks. */
  activity: "herdr" | "hooks";
  /** The open-session fields it takes. A shell is the pane's own login shell, so it starts nothing and resumes nothing. */
  takes: { readonly resume: boolean; readonly prompt: boolean; readonly model: boolean };
}

export const agentKinds = {
  // Herdr can retain a dead Claude's working status; only its expiring hook lease keeps it awake.
  "claude-code": { label: "Claude Code", activity: "hooks", takes: { resume: true, prompt: true, model: true } },
  pi: { label: "pi", activity: "herdr", takes: { resume: true, prompt: false, model: false } },
  shell: { label: "Shell", activity: "herdr", takes: { resume: false, prompt: false, model: false } },
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
