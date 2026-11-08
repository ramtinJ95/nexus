/**
 * The launch of a Claude worker thread's session, moved along before each tick of its pylon through the worker's
 * states (claude-worker.ts).
 *
 * A launch is fenced under its session before it is sent, so a launch sent again, after a lost probe or a control
 * plane restart, names the same session and the probe finishes that one instead of submitting the task twice.
 */
import { randomUUID } from "node:crypto";
import type { PylonId } from "../ids.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import type { CommandResult, PylonCommand } from "../protocol/commands.ts";
import type { ProbeError } from "../protocol/http.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { defaultClaudeModel } from "../protocol/models.ts";
import { listsRunning } from "./locator.ts";
import type { Registry } from "./registry.ts";
import type { ClaudeWorker } from "./claude-worker.ts";
import type { Thread } from "./thread-store.ts";

type ClaudeLaunchRegistry = Pick<Registry, "claudeWorker" | "moveClaudeWorker" | "sealedBoot">;

/** The node's probe and its observe link. */
export interface LaunchLink {
  readonly probe: Pick<ProbeClient, "command">;
  /** Settles true at the link's next snapshot, and false after `waitMs` without one or at shutdown. */
  snapshot(waitMs: number): Promise<boolean>;
}

export function claudeLaunch(options: { registry: ClaudeLaunchRegistry; log: (message: string) => void; retryMs: number; shutdown: AbortSignal }): {
  /**
   * Moves the thread's Claude launch along before its pylon's tick. "skip" means this pass does not tick the pylon.
   * It answers at once unless it sends a launch, so a pass that sends none reaches the probe without yielding first.
   */
  step(thread: Thread, pylonId: PylonId, observation: NodeObservation | null, link: LaunchLink): "tick" | Promise<"tick" | "skip">;
} {
  const { registry, log, retryMs: claudeLaunchRetryMs, shutdown } = options;

  function step(thread: Thread, pylonId: PylonId, nodeObservation: NodeObservation | null, link: LaunchLink): "tick" | Promise<"tick" | "skip"> {
    const worker = registry.claudeWorker(thread.id);
    const running = listsRunning(registry, nodeObservation, pylonId, "work");
    // A launch this process did not finish, as one a control plane restart cut off, goes again under the session it
    // recorded. It fails without one, and for a deleted thread, whose pylon does not run again.
    if (worker?.state === "starting" && nodeObservation !== null && (worker.session === null || thread.status === "deleted")) {
      registry.moveClaudeWorker(thread.id, { to: "failed", message: "Claude launch was interrupted; attach to check before starting another session" });
    } else if ((worker?.state === "pending" || worker?.state === "starting") && thread.status === "active" && running) {
      const session = worker.state === "starting" ? worker.session! : randomUUID();
      registry.moveClaudeWorker(thread.id, { to: "starting", session });
      return send(thread, worker, session, pylonId, link);
    }
    return "tick";
  }

  async function send(thread: Thread, worker: ClaudeWorker, session: string, pylonId: PylonId, link: LaunchLink): Promise<"tick" | "skip"> {
    // A launch a shutdown cut off has not failed.
    const unfinished = (to: "stalled" | "failed", why: string) =>
      !shutdown.aborted && registry.moveClaudeWorker(thread.id, { to, message: `Claude launch did not complete; attach to check before starting another session: ${why}` });
    try {
      const { stalled } = await launchClaude(link, pylonId, { kind: "open-session", harness: "claude-code", title: thread.title.slice(0, 80), resume: session, prompt: worker.prompt, model: worker.model ?? defaultClaudeModel });
      if (stalled === undefined) registry.moveClaudeWorker(thread.id, { to: "started" });
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
        if (!await link.snapshot(until - Date.now())) throw new Error(`${(err as Error).message}, and the probe did not come back within ${claudeLaunchRetryMs / 1000} seconds`);
        log(`${pylonId}: the Claude launch lost its probe (${(err as Error).message}). Sending it again`);
      }
    }
  }

  return { step };
}
