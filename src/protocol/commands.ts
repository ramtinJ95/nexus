/**
 * Probe contract, synchronous commands to a pylon's guest, and their results.
 *
 * The wire encoding (JSON bodies) is private to this module. Callers see the domain types below. The probe reads
 * through `parsePylonCommand`, and the control plane through `parseCommandResult`.
 */
import { z } from "zod";
import { reservedPortMessage, reservedPorts } from "../services-file.ts";
import { claudeSessionId, claudeTextProblem, harnesses, sessionHarnessSchema, type SessionHarness } from "../session-harness.ts";
import { asSent, nonEmpty, parseJson, unchecked } from "../parse.ts";
import type { ServiceFact, SessionIdentity } from "./observations.ts";

// Synchronous guest operations. They are not reconciled and not queued behind lifecycle jobs.
// Everything runs as `user`. pi-sandbox fixes the shell user for the life of an instance, and `user`
// has passwordless sudo, so a root command is `["sudo", ...]`. What each kind waits for, whether it publishes a
// snapshot and whether a caller may send it again is commandPolicies in probe/run.ts.

export type PylonCommand =
  /** When the timeout passes, the probe calls pi-sandbox's exec-kill and returns exitCode null. Timeout at most 60 s. */
  | { kind: "exec"; argv: readonly string[]; cwd: string; timeoutMs: number }
  | { kind: "open-session"; harness: SessionHarness; title: string; resume?: string; prompt?: string; model?: string }
  /**
   * `session` is who the control plane last saw in the pane, so a pane a wake has since given to another session is
   * left open. None for a pane no observation has listed yet, such as one opened a moment ago.
   */
  | { kind: "close-session"; herdrPane: string; session?: SessionIdentity }
  /** Forgets a failed session the last wake left in no pane, so no wake tries it again. */
  | { kind: "drop-failed-session"; id: string }
  /**
   * Types `text` into the Claude Code session `session` as a prompt and submits it, resuming the session first, under
   * `model` if given, when no live pane runs it. `text` holds no control character but newlines (claudeTextProblem).
   * The probe remembers the send under `requestId`, for send-claude-outcome. A control plane older than it sends none.
   */
  | { kind: "send-claude"; session: string; text: string; model?: string; requestId?: string }
  /**
   * What became of the send-claude under `requestId`, answered once it settles. It never types: a send still waiting
   * behind another to the same session is waited for, so a control plane whose wait ran out asks this, not again.
   */
  | { kind: "send-claude-outcome"; requestId: string }
  /**
   * Presses Esc in the pane that runs the Claude Code session `session`, which interrupts its turn as it does at the
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
   * `stalled`: a prompted launch showed no sign its first prompt went in, so its pane stays open for a person to check,
   * and this says why. A probe from before the field throws a stall as an error instead.
   */
  | { kind: "open-session"; herdrPane: string; stalled?: string }
  /**
   * `not-open`: no such pane is open. `moved`: the pane runs another session than the command names, such as one a wake
   * put there after moving the named one. Both leave every pane as it was. A probe older than the field sends none.
   */
  | { kind: "close-session"; outcome: CloseSessionOutcome }
  /** `dropped` is false when the pylon holds no such failed session. */
  | { kind: "drop-failed-session"; dropped: boolean }
  /**
   * `sent`: Claude was idle, so the message starts a turn. `queued`: Claude was working, so Claude Code queues the message
   * as it queues input typed during a turn, and takes it at its next tool boundary or after the turn. Both mean it was
   * typed. `blocked`: Claude waits at a prompt in its terminal, such as a trust or permission dialog, which typing would
   * answer. `starting`: Herdr could not yet tell Claude's state. `moved`: the pane stopped running the session before
   * anything was typed, as when another agent started in it. These mean nothing was typed, so the message can be sent
   * again. A failed command may have typed part of the message.
   * `herdrPane` is the pane Claude runs in, and `resumed` says the session had no live pane and was resumed into it first.
   */
  | { kind: "send-claude"; outcome: SendClaudeOutcome; herdrPane: string; resumed: boolean }
  /**
   * The send's own result, `failed` for a send that failed and so may have typed part of the message, or `unknown`
   * when the probe holds no send under the ID: it never got one, or forgot it in a restart or an hour after it settled.
   */
  | { kind: "send-claude-outcome"; send: { outcome: SendClaudeOutcome; herdrPane: string; resumed: boolean } | "failed" | "unknown" }
  /**
   * `interrupted`: Esc was pressed while Claude worked. The rest press nothing. `idle`: Claude was not working, and a second
   * Esc there opens its rewind picker. `blocked`: Claude waits at a dialog, which Esc would cancel. `unknown`:
   * Herdr could not tell Claude's state. `not-running`: no live pane runs the session.
   */
  | { kind: "interrupt-claude"; outcome: InterruptClaudeOutcome }
  | { kind: "service"; services: readonly ServiceFact[]; logs?: string }
  /** The service the port is previewed under: `port-<port>`, or the service that already owns the port. */
  | { kind: "link-port"; service: string }
  /** `refused` says why the pylon left a port a service's preview owns, for a person to read. Null once the port is not linked. */
  | { kind: "unlink-port"; refused: string | null };

const port = z.int().min(1).max(65535).refine((p) => !reservedPorts.has(p), reservedPortMessage);
/** Refuses an open-session field that only the harnesses whose agent has `takes` accept, and names them. */
function onlyFor(takes: "promptReceipt" | "modelFlag") {
  const labels = sessionHarnessSchema.options.filter((h) => harnesses[h].agent?.[takes] !== undefined).map((h) => harnesses[h].label);
  return z.never({ error: `only a ${labels.join(" or ")} session takes it` }).exactOptional();
}
const openSession = (harness: SessionHarness) => {
  const { agent } = harnesses[harness];
  return z.looseObject({
    kind: z.literal("open-session"), title: nonEmpty, harness: z.literal(harness),
    resume: agent === null ? z.never({ error: `a ${harness} session has nothing to resume` }).exactOptional() : nonEmpty.exactOptional(),
    prompt: agent?.promptReceipt === undefined ? onlyFor("promptReceipt") : nonEmpty.max(16_384).exactOptional(),
    model: agent?.modelFlag === undefined ? onlyFor("modelFlag") : nonEmpty.max(200).exactOptional(),
  });
};
const claudeSession = z.string().regex(claudeSessionId, "expected a Claude Code session ID");
const pylonCommandSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("exec"), argv: z.array(z.string()).min(1), cwd: z.string().startsWith("/", "expected an absolute path"), timeoutMs: z.int().min(1).max(60_000) }),
  z.discriminatedUnion("harness", sessionHarnessSchema.options.map(openSession) as [ReturnType<typeof openSession>, ...ReturnType<typeof openSession>[]]),
  z.looseObject({
    kind: z.literal("close-session"), herdrPane: nonEmpty,
    session: z.looseObject({ harness: sessionHarnessSchema, harnessSessionId: nonEmpty.nullable(), title: nonEmpty.nullable() }).exactOptional(),
  }),
  z.looseObject({ kind: z.literal("drop-failed-session"), id: nonEmpty }),
  z.looseObject({
    kind: z.literal("send-claude"),
    session: claudeSession,
    text: nonEmpty.max(16_384).superRefine((t, ctx) => {
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

const sendSchema = z.looseObject({ outcome: z.enum(sendClaudeOutcomes), herdrPane: nonEmpty, resumed: z.boolean() });
const commandResultSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("exec"), exitCode: unchecked<number | null>(), output: unchecked<string>(), truncated: unchecked<boolean>() }),
  z.looseObject({ kind: z.literal("open-session"), herdrPane: nonEmpty, stalled: nonEmpty.exactOptional() }),
  z.looseObject({ kind: z.literal("close-session"), outcome: z.enum(closeSessionOutcomes).nullish() }),
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
  // A probe that reported every close as done sends no outcome.
  return result.kind === "close-session" ? { ...result, outcome: result.outcome ?? "closed" } : result;
}
