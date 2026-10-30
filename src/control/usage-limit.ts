/**
 * Types "continue" into a Claude worker that stopped on its usage limit, once the limit resets. Each stop gets one
 * message under a request ID of its session and stop, and claude_messages keeps every request ID, so a restart or a
 * stop the thread still shows never sends a second.
 */
import type { Inbox } from "./inbox.ts";
import type { Registry } from "./registry.ts";
import { singleFlight } from "../single-flight.ts";
import { usageLimitPrefix } from "../agent-protocol.ts";

type UsageLimitRegistry = Pick<Registry, "appendEvent" | "claudeMessage" | "claudeWorker" | "storedThreads" | "thread">;

const text = `${usageLimitPrefix} The usage limit reset. Continue where you stopped.`;
/** Claude Code continues a session it still runs about 90 s after the reset, so only a session that did not, such as one whose pylon paused, is typed into. */
const defaultGraceMs = 180_000;

export function usageLimitResumer(options: { registry: UsageLimitRegistry; inbox: Inbox; clock?: () => number; graceMs?: number }) {
  const { registry, inbox, clock = Date.now, graceMs = defaultGraceMs } = options;
  async function tick() {
    for (const { id: thread } of registry.storedThreads({ status: ["active", "idle"] })) {
      // Read again after the sends before it, which another thread's archive or continue may have outrun. From here to
      // the inbox fencing the request ID nothing awaits, so the stop and session it checks are the ones it sends for.
      const t = registry.thread(thread);
      if (t === undefined) continue;
      const limit = t.usageLimit;
      const session = registry.claudeWorker(t.id)?.session ?? null;
      // A reset no later than the stop would stop the worker again at once, every pass. An archived thread's pylon stays paused until the person unarchives it, so the message would wake it.
      if (limit === undefined || limit.resetsAt === null || limit.resetsAt <= limit.stoppedAt || clock() < limit.resetsAt + graceMs || (t.status !== "active" && t.status !== "idle") || session === null) continue;
      const id = `usage-limit:${session}:${limit.stoppedAt}`;
      if (registry.claudeMessage(t.id, id) !== undefined) continue;
      try {
        if (await inbox(t, { id, text, sender: "usage-limit" }) === "delivered") {
          registry.appendEvent("usage-limit.continued", t.id, { session, stoppedAt: limit.stoppedAt, resetsAt: limit.resetsAt, requestId: id });
        }
      } catch (err) {
        console.error(`${t.id}: continuing after the usage limit failed: ${(err as Error).message}`);
      }
    }
  }
  const ticks = singleFlight(tick);
  return { close: ticks.settled, poll: ticks.join };
}
