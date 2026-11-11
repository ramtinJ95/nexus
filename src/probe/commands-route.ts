/** The probe's pylon commands: each kind's policy around runCommand, and the record of Claude sends that a send-claude-outcome reads. */
import type { PylonId } from "../ids.ts";
import type { CommandResult, PylonCommand } from "../protocol/commands.ts";
import { claudeSessionLock } from "./guest/session-wake.ts";
import { commandPolicies, runCommand, type ClaudeSends, type CommandPolicy, type ProbeDeps } from "./run.ts";

const claudeSendMemoryMs = 60 * 60_000;

/** The caller has checked that the pylon runs. */
export function createCommands(deps: ProbeDeps, publishSnapshot: () => void): (pylonId: PylonId, command: PylonCommand) => Promise<CommandResult> {
  /**
   * Each send to a Claude session by its request ID, until an hour after it settles, so a control plane whose wait for
   * one ran out, as behind a slow send to the same session, learns what became of it instead of typing it again. They
   * are held in memory, so a restarted probe knows none.
   */
  const sendsById = new Map<string, Promise<CommandResult>>();
  function remember(pylonId: PylonId, requestId: string, sending: Promise<CommandResult>) {
    const key = `${pylonId} ${requestId}`;
    sendsById.set(key, sending);
    void sending.catch(() => undefined).then(() => setTimeout(() => { if (sendsById.get(key) === sending) sendsById.delete(key); }, claudeSendMemoryMs).unref());
  }
  const sends: ClaudeSends = {
    async outcome(pylonId, requestId) {
      const sending = sendsById.get(`${pylonId} ${requestId}`);
      if (sending === undefined) return { kind: "send-claude-outcome", send: "unknown" };
      try {
        const { outcome, terminal, resumed } = await sending as Extract<CommandResult, { kind: "send-claude" }>;
        return { kind: "send-claude-outcome", send: { outcome, terminal, resumed } };
      } catch {
        return { kind: "send-claude-outcome", send: "failed" };
      }
    },
  };

  return async (pylonId, command) => {
    // Each kind's policy takes its own kind of command and result, which command.kind picks.
    const policy = commandPolicies[command.kind] as CommandPolicy<PylonCommand["kind"]>;
    const run = () => runCommand(pylonId, command, deps, sends);
    const session = typeof policy.lock === "function" ? policy.lock(command) : undefined;
    const running = session !== undefined ? claudeSessionLock(pylonId)([session], run) : run();
    if (policy.remembered && "requestId" in command && command.requestId !== undefined) remember(pylonId, command.requestId, running);
    const result = await running;
    if (typeof policy.publishes === "function" ? policy.publishes(result) : policy.publishes) publishSnapshot();
    return result;
  };
}
