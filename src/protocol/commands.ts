/**
 * Probe contract, synchronous commands to a pylon's guest, and their results.
 *
 * The wire encoding (JSON bodies) is private to this module. Callers see the domain types below. The probe reads
 * through `parsePylonCommand`, and the control plane through `parseCommandResult`.
 */
import { z } from "zod";
import { reservedPortMessage, reservedPorts } from "./ports.ts";
import { claudeSessionId, claudeTextProblem, agentKinds, sessionHarnessSchema, type SessionHarness } from "./agent-kinds.ts";
import { asSent, nonEmpty, parseJson, unchecked } from "../parse.ts";
import type { ServiceFact, SessionIdentity } from "./observations.ts";

// Synchronous guest operations. They are not reconciled and not queued behind lifecycle jobs.
// Everything runs as `user`. pi-sandbox fixes the shell user for the life of an instance, and `user`
// has passwordless sudo, so a root command is `["sudo", ...]`. What each kind waits for and whether it publishes a
// snapshot is commandPolicies in probe/run.ts.

export type PylonCommand =
  /** When the timeout passes, the probe calls pi-sandbox's exec-kill and returns exitCode null. Timeout at most 60 s. */
  | { kind: "exec"; argv: readonly string[]; cwd: string; timeoutMs: number }
  | { kind: "open-session"; harness: SessionHarness; title: string; resume?: string; prompt?: string; model?: string }
  /**
   * `session` is who the control plane last saw in the terminal, so a terminal that runs another session since a wake
   * is left open. None for a terminal no observation has listed yet, such as one opened a moment ago.
   */
  | { kind: "close-session"; terminal: string; session?: SessionIdentity }
  /** Forgets a failed session the last wake left in no terminal, so no wake tries it again. */
  | { kind: "drop-failed-session"; id: string }
  /**
   * Pastes `text` into the Claude Code session `session` as a prompt and submits it, resuming the session first, under
   * `model` if given, when no live terminal runs it. `text` holds no control character but newlines (claudeTextProblem).
   * The probe remembers the send under `requestId`, for send-claude-outcome. A control plane older than it sends none.
   */
  | { kind: "send-claude"; session: string; text: string; model?: string; requestId?: string }
  /**
   * What became of the send-claude under `requestId`, answered once it settles. It never types: a send still waiting
   * behind another to the same session is waited for, so a control plane whose wait ran out asks this, not again.
   */
  | { kind: "send-claude-outcome"; requestId: string }
  /**
   * Presses Esc in the terminal that runs the Claude Code session `session`, which interrupts its turn as it does at the
   * terminal. It presses no other key, and none at all unless Claude is working.
   */
  | { kind: "interrupt-claude"; session: string }
  | { kind: "service"; op: "ensure" | "restart" | "stop" | "logs"; name?: string; lines?: number }
  /** Previews a port that already listens, or will, as `nexus preview <port>` in the pylon does. */
  | { kind: "link-port"; port: number }
  /** Stops previewing a linked port. A port not linked succeeds, and a port a service's preview owns is refused. */
  | { kind: "unlink-port"; port: number };

export const sendClaudeOutcomes = ["sent", "queued", "blocked", "starting", "moved"] as const;
export type SendClaudeOutcome = typeof sendClaudeOutcomes[number];
export const interruptClaudeOutcomes = ["interrupted", "idle", "blocked", "unknown", "not-running"] as const;
export type InterruptClaudeOutcome = typeof interruptClaudeOutcomes[number];
export const closeSessionOutcomes = ["closed", "not-open", "moved"] as const;
export type CloseSessionOutcome = typeof closeSessionOutcomes[number];

export type CommandResult =
  | { kind: "exec"; exitCode: number | null; output: string; truncated: boolean }
  /**
   * `stalled`: a prompted launch showed no sign its first prompt went in, so its terminal stays open for a person to check,
   * and this says why.
   */
  | { kind: "open-session"; terminal: string; stalled?: string }
  /**
   * `not-open`: no such terminal is live. `moved`: the terminal runs another session than the command names, such as
   * one a `/clear` started there. Both leave every terminal as it was.
   */
  | { kind: "close-session"; outcome: CloseSessionOutcome }
  /** `dropped` is false when the pylon holds no such failed session. */
  | { kind: "drop-failed-session"; dropped: boolean }
  /**
   * `sent`: Claude was idle, so the message starts a turn. `queued`: Claude was working, so Claude Code queues the message
   * as it queues input typed during a turn, and takes it at its next tool boundary or after the turn. Both mean it was
   * typed. `blocked`: Claude waits at a prompt in its terminal, such as a trust or permission dialog, which typing would
   * answer. `starting`: Claude had reported no state yet. `moved`: the terminal stopped running the session before
   * anything was typed, as when a `/clear` started another session in it. These mean nothing was typed, so the message
   * can be sent again. A failed command may have typed the message.
   * `terminal` is the terminal Claude runs in, and `resumed` says the session had no live terminal and was resumed into
   * one first.
   */
  | { kind: "send-claude"; outcome: SendClaudeOutcome; terminal: string; resumed: boolean }
  /**
   * The send's own result, `failed` for a send that failed and so may have typed part of the message, or `unknown`
   * when the probe holds no send under the ID: it never got one, or forgot it in a restart or an hour after it settled.
   */
  | { kind: "send-claude-outcome"; send: { outcome: SendClaudeOutcome; terminal: string; resumed: boolean } | "failed" | "unknown" }
  /**
   * `interrupted`: Esc was pressed while Claude worked. The rest press nothing. `idle`: Claude was not working, and a second
   * Esc there opens its rewind picker. `blocked`: Claude waits at a dialog, which Esc would cancel. `unknown`:
   * Claude had reported no state yet. `not-running`: no live terminal runs the session.
   */
  | { kind: "interrupt-claude"; outcome: InterruptClaudeOutcome }
  | { kind: "service"; services: readonly ServiceFact[]; logs?: string }
  /** The service the port is previewed under: `port-<port>`, or the service that already owns the port. */
  | { kind: "link-port"; service: string }
  /** `refused` says why the pylon left a port a service's preview owns, for a person to read. Null once the port is not linked. */
  | { kind: "unlink-port"; refused: string | null };

/** The longest prompt an open session starts with, and the longest message a Claude session is sent. */
export const maxPromptChars = 16_384;

const port = z.int().min(1).max(65535).refine((p) => !reservedPorts.has(p), reservedPortMessage);
/** Refuses an open-session field that only some kinds of session take, and names them. */
function onlyFor(field: "prompt" | "model") {
  const labels = sessionHarnessSchema.options.filter((h) => agentKinds[h].takes[field]).map((h) => agentKinds[h].label);
  return z.never({ error: `only a ${labels.join(" or ")} session takes it` }).exactOptional();
}
const openSession = (harness: SessionHarness) => {
  const { takes } = agentKinds[harness];
  return z.looseObject({
    kind: z.literal("open-session"), title: nonEmpty, harness: z.literal(harness),
    resume: takes.resume ? nonEmpty.exactOptional() : z.never({ error: `a ${harness} session has nothing to resume` }).exactOptional(),
    prompt: takes.prompt ? nonEmpty.max(maxPromptChars).exactOptional() : onlyFor("prompt"),
    model: takes.model ? nonEmpty.max(200).exactOptional() : onlyFor("model"),
  });
};
const claudeSession = z.string().regex(claudeSessionId, "expected a Claude Code session ID");
const pylonCommandSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("exec"), argv: z.array(z.string()).min(1), cwd: z.string().startsWith("/", "expected an absolute path"), timeoutMs: z.int().min(1).max(60_000) }),
  z.discriminatedUnion("harness", sessionHarnessSchema.options.map(openSession) as [ReturnType<typeof openSession>, ...ReturnType<typeof openSession>[]]),
  z.looseObject({
    kind: z.literal("close-session"), terminal: nonEmpty,
    session: z.looseObject({ harness: sessionHarnessSchema, harnessSessionId: nonEmpty.nullable(), title: nonEmpty.nullable() }).exactOptional(),
  }),
  z.looseObject({ kind: z.literal("drop-failed-session"), id: nonEmpty }),
  z.looseObject({
    kind: z.literal("send-claude"),
    session: claudeSession,
    text: nonEmpty.max(maxPromptChars).superRefine((t, ctx) => {
      const problem = claudeTextProblem(t);
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
    }),
    model: nonEmpty.max(200).exactOptional(),
    requestId: nonEmpty.exactOptional(),
  }),
  z.looseObject({ kind: z.literal("send-claude-outcome"), requestId: nonEmpty }),
  z.looseObject({ kind: z.literal("interrupt-claude"), session: claudeSession }),
  z.looseObject({
    kind: z.literal("service"), op: z.enum(["ensure", "restart", "stop", "logs"]), name: nonEmpty.exactOptional(),
    lines: z.number().min(1).refine(Number.isInteger, "expected an integer").exactOptional(),
  }),
  z.looseObject({ kind: z.literal("link-port"), port }),
  z.looseObject({ kind: z.literal("unlink-port"), port }),
]) satisfies z.ZodType<PylonCommand>;

/**
 * The probe's side of POST /v1/pylons/{id}/commands. Throws with a message for a 400. A pylon that is
 * not running gets a 409, which the client reports as not-running.
 */
export function parsePylonCommand(body: string): PylonCommand {
  return parseJson(asSent(pylonCommandSchema), body, "command");
}

const sendSchema = z.looseObject({ outcome: z.enum(sendClaudeOutcomes), terminal: nonEmpty, resumed: z.boolean() });
const commandResultSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("exec"), exitCode: unchecked<number | null>(), output: unchecked<string>(), truncated: unchecked<boolean>() }),
  z.looseObject({ kind: z.literal("open-session"), terminal: nonEmpty, stalled: nonEmpty.exactOptional() }),
  z.looseObject({ kind: z.literal("close-session"), outcome: z.enum(closeSessionOutcomes) }),
  z.looseObject({ kind: z.literal("drop-failed-session"), dropped: z.boolean() }),
  z.looseObject({ kind: z.literal("send-claude"), ...sendSchema.shape }),
  z.looseObject({ kind: z.literal("send-claude-outcome"), send: z.union([z.enum(["failed", "unknown"]), sendSchema], { error: "expected failed, unknown or what the send became" }) }),
  z.looseObject({ kind: z.literal("interrupt-claude"), outcome: z.enum(interruptClaudeOutcomes) }),
  z.looseObject({ kind: z.literal("service"), services: unchecked<readonly ServiceFact[]>(), logs: unchecked<string>() }),
  z.looseObject({ kind: z.literal("link-port"), service: nonEmpty }),
  z.looseObject({ kind: z.literal("unlink-port"), refused: nonEmpty.nullable() }),
]);

export function parseCommandResult(command: PylonCommand, body: string): CommandResult {
  const result = parseJson(asSent(commandResultSchema), body, "result");
  if (result.kind !== command.kind) throw new Error(`a ${command.kind} command got a ${result.kind} result`);
  return result;
}
