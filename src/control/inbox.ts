/**
 * Messages Nexus itself sends to a thread's agent, such as the PR watch's feedback and the review loop's findings.
 * A harness thread gets them as attributed input entries. A Claude worker gets them typed into its session, as a
 * person's message is, but they count only as agent activity, so they wake a paused pylon without holding it awake
 * for the twenty minutes a human visit does.
 */
import type { HarnessHost, Sender } from "../harness/host.ts";
import type { CommandResult, NodeName, ProbeClient, ProbeError, PylonCommand } from "../protocol.ts";
import { runningProbe } from "./observed.ts";
import type { ClaudeSent, Registry, Thread, ThreadId } from "./registry.ts";

/** `id` is the request ID: a resend under it is the same message, never a second one. */
export interface AutomatedMessage { id: string; text: string; sender: Sender }
/** `later` typed nothing, such as while the pylon wakes. Send the same message again on a later pass. */
export type Inbox = (t: Thread, message: AutomatedMessage) => Promise<"delivered" | "later">;

export type ClaudeTyped =
  | { kind: "sent"; sent: ClaudeSent }
  /** Nothing was typed and the request ID is forgotten, so a resend types it. */
  | { kind: "nothing"; outcome: "blocked" | "starting" | "moved"; herdrPane: string }
  /**
   * An earlier send under this ID failed partway, or its probe no longer knows what became of it, so Claude may have
   * some or all of it. It is never typed again.
   */
  | { kind: "uncertain" };

/**
 * Types `text` into the worker's session under `requestId`. The ID is fenced as sending before the probe is asked and
 * recorded as sent with the answer. A failed command may have typed part of the message, so its ID stays fenced, and
 * only a pylon found not running, which typed nothing, forgets it. A fenced ID is asked after, never typed: its first
 * answer may only have been lost, as when the wait for it ran out while the probe still had it queued.
 */
export function typeIntoClaude(registry: Registry, thread: ThreadId, session: string, model: string | null, requestId: string, text: string, ask: (command: PylonCommand) => Promise<CommandResult>): Promise<ClaudeTyped> {
  const held = attempts.get(registry) ?? new Map<string, Promise<unknown>>();
  attempts.set(registry, held);
  const key = `${thread} ${requestId}`;
  const next = (held.get(key) ?? Promise.resolve()).then(() => typeOnce(registry, thread, session, model, requestId, text, ask));
  const settled = next.catch(() => undefined);
  held.set(key, settled);
  void settled.then(() => { if (held.get(key) === settled) held.delete(key); });
  return next;
}

/**
 * One send per thread and request ID at a time. A resend asked while its first send waits on the probe would get the
 * same answer, and if that typed nothing, whichever came later would clear the fence a newer send had set meanwhile.
 */
const attempts = new WeakMap<Registry, Map<string, Promise<unknown>>>();

async function typeOnce(registry: Registry, thread: ThreadId, session: string, model: string | null, requestId: string, text: string, ask: (command: PylonCommand) => Promise<CommandResult>): Promise<ClaudeTyped> {
  const stored = registry.claudeMessage(thread, requestId);
  if (stored?.state === "sent") return { kind: "sent", sent: stored.result };
  let result: Omit<Extract<CommandResult, { kind: "send-claude" }>, "kind">;
  if (stored?.state === "sending") {
    let earlier: Extract<CommandResult, { kind: "send-claude-outcome" }>;
    try {
      earlier = await ask({ kind: "send-claude-outcome", requestId }) as Extract<CommandResult, { kind: "send-claude-outcome" }>;
    } catch (err) {
      // A probe older than the command refuses it, and so cannot say either.
      if ((err as Partial<ProbeError>).code !== undefined) throw err;
      return { kind: "uncertain" };
    }
    if (earlier.send === "failed" || earlier.send === "unknown") return { kind: "uncertain" };
    result = earlier.send;
  } else {
    registry.setClaudeMessage(thread, requestId, { state: "sending" });
    try {
      result = await ask({ kind: "send-claude", session, text, requestId, ...(model === null ? {} : { model }) }) as Extract<CommandResult, { kind: "send-claude" }>;
    } catch (err) {
      if ((err as Partial<ProbeError>).code === "not-running") registry.setClaudeMessage(thread, requestId, null);
      throw err;
    }
  }
  if (result.outcome === "blocked" || result.outcome === "starting" || result.outcome === "moved") {
    registry.setClaudeMessage(thread, requestId, null);
    return { kind: "nothing", outcome: result.outcome, herdrPane: result.herdrPane };
  }
  const sent: ClaudeSent = { session, outcome: result.outcome, resumed: result.resumed };
  registry.setClaudeMessage(thread, requestId, { state: "sent", result: sent });
  return { kind: "sent", sent };
}

/** GitHub text often ends lines with CRLF and indents with tabs, which Claude's prompt cannot take as typed. */
export function typeable(text: string): string {
  return text.toWellFormed().replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
}

export function agentInbox(options: { registry: Registry; harness: Pick<HarnessHost, "send">; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "command">>; wake(t: Thread): void }): Inbox {
  const { registry, harness, probes, wake } = options;
  return async (t, message) => {
    const agent = registry.agent(t);
    if (agent.kind === "none") throw new Error(`thread ${t.id} has no agent to take a message`);
    if (agent.kind === "harness") await harness.send(t.id, message.text, message.id, "followUp", message.sender);
    registry.recordActivity(t.id, { agent: Date.now() });
    wake(t);
    if (agent.kind === "harness") return "delivered";
    const { worker } = agent;
    const probe = runningProbe(registry, probes, t);
    if (worker.session === null || probe === null) return "later";
    let typed: ClaudeTyped;
    try {
      typed = await typeIntoClaude(registry, t.id, worker.session, worker.model, message.id, typeable(message.text), (command) => probe.command(t.pylonId, command));
    } catch (err) {
      if ((err as Partial<ProbeError>).code === "not-running") return "later";
      throw err;
    }
    if (typed.kind === "nothing") return "later";
    if (typed.kind === "uncertain") console.error(`${t.id}: an earlier send of ${message.id} failed partway, so it is not typed again`);
    return "delivered";
  };
}
