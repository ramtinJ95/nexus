/**
 * The launch of a Claude worker thread's session, moved along before each tick of its pylon. A worker is pending
 * until its pylon runs, starting from when the launch is first sent until the probe answers, and then started,
 * stalled when the launch did not reach a turn, or failed.
 *
 * A launch is fenced under its session before it is sent, so a launch sent again, after a lost probe or a control
 * plane restart, names the same session and the probe finishes that one instead of submitting the task twice.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandResult, NodeObservation, ProbeClient, ProbeError, PylonCommand, PylonId } from "../protocol.ts";
import { defaultClaudeModel } from "../claude-state.ts";
import { listsRunning } from "./observed.ts";
import type { ClaudeWorker, Registry, Thread } from "./registry.ts";

/** What the launch reads of the node's observe link, live: loop.ts's `Link` satisfies it. */
export interface LaunchLink {
  readonly probe: Pick<ProbeClient, "command">;
  readonly up: boolean;
  readonly snapshots: number;
}

export function claudeLaunch(options: { registry: Registry; log: (message: string) => void; retryMs: number; shutdown: AbortSignal }): {
  /**
   * Moves the thread's Claude launch along before its pylon's tick. "skip" means this pass does not tick the pylon.
   * It answers at once unless it sends a launch, so a pass that sends none reaches the probe without yielding first.
   */
  step(thread: Thread, pylonId: PylonId, observation: NodeObservation | null, link: LaunchLink): "tick" | Promise<"tick" | "skip">;
} {
  const { registry, log, retryMs: claudeLaunchRetryMs, shutdown } = options;

  function step(thread: Thread, pylonId: PylonId, nodeObservation: NodeObservation | null, link: LaunchLink): "tick" | Promise<"tick" | "skip"> {
    const worker = registry.claudeWorker(thread.id);
    const running = listsRunning(nodeObservation, pylonId);
    // A launch this process did not finish, as one a control plane restart cut off, goes again under the session it
    // recorded. It fails without one, and for a deleted thread, whose pylon does not run again.
    if (worker?.state === "starting" && nodeObservation !== null && (worker.session === null || thread.status === "deleted")) {
      const message = "Claude launch was interrupted; attach to check before starting another session";
      registry.setClaudeWorker(thread.id, worker.prompt, "failed", message);
      registry.appendEvent("thread.failed", thread.id, { message });
    } else if ((worker?.state === "pending" || worker?.state === "starting") && thread.status === "active" && running) {
      const session = worker.state === "starting" ? worker.session! : randomUUID();
      registry.setClaudeWorker(thread.id, worker.prompt, "starting", undefined, session);
      return send(thread, worker, session, pylonId, link);
    }
    return "tick";
  }

  async function send(thread: Thread, worker: ClaudeWorker, session: string, pylonId: PylonId, link: LaunchLink): Promise<"tick" | "skip"> {
    // Neither a worker its session's turn started meanwhile nor a launch a shutdown cut off has failed.
    const unfinished = (state: "stalled" | "failed", why: string) => {
      if (registry.claudeWorker(thread.id)?.state === "started" || shutdown.aborted) return false;
      const message = `Claude launch did not complete; attach to check before starting another session: ${why}`;
      registry.setClaudeWorker(thread.id, worker.prompt, state, message);
      registry.appendEvent("thread.failed", thread.id, { message });
      return true;
    };
    try {
      const { stalled } = await launchClaude(link, pylonId, { kind: "open-session", harness: "claude-code", title: thread.title.slice(0, 80), resume: session, prompt: worker.prompt, model: worker.model ?? defaultClaudeModel });
      if (stalled === undefined) registry.setClaudeWorker(thread.id, worker.prompt, "started");
      else unfinished("stalled", stalled);
    } catch (err) {
      if (!unfinished("failed", (err as Error).message)) return "skip";
      throw err;
    }
    return "tick";
  }

  /**
   * Sends a prompted Claude launch, and sends it again, under the same session ID, each time the probe connection is
   * lost before it answers, as when a deploy restarts the probe. It waits for a snapshot from after the loss, so the
   * probe that answers it is one that came back. Sending it again is safe, because the probe reads from the pylon how
   * far the launch got (sessions.ts openSession).
   */
  async function launchClaude(link: LaunchLink, pylonId: PylonId, command: Extract<PylonCommand, { kind: "open-session" }>): Promise<Extract<CommandResult, { kind: "open-session" }>> {
    const until = Date.now() + claudeLaunchRetryMs;
    for (;;) {
      try {
        return await link.probe.command(pylonId, command) as Extract<CommandResult, { kind: "open-session" }>;
      } catch (err) {
        if ((err as Partial<ProbeError>).code !== "unreachable") throw err;
        const seen = link.snapshots;
        while (!link.up || link.snapshots === seen) {
          if (Date.now() >= until) throw new Error(`${(err as Error).message}, and the probe did not come back within ${claudeLaunchRetryMs / 1000} seconds`);
          await delay(250, undefined, { signal: shutdown });
        }
        log(`${pylonId}: the Claude launch lost its probe (${(err as Error).message}). Sending it again`);
      }
    }
  }

  return { step };
}
