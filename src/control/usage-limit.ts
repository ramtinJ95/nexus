/**
 * Types "continue" into a Claude worker that stopped on its usage limit, once the limit resets. Each stop gets one
 * message under a request ID of its session and stop, and claude_messages keeps every request ID, so a restart or a
 * stop the thread still shows never sends a second.
 */
import type { Inbox } from "./inbox.ts";
import type { Registry } from "./registry.ts";

export const usageLimitPrefix = "[Nexus usage limit — automated, not a message from the person]";
const text = `${usageLimitPrefix} The usage limit reset. Continue where you stopped.`;
/** The API's reset is by its own clock, so wait a little past it. */
const defaultGraceMs = 60_000;

export function usageLimitResumer(options: { registry: Registry; inbox: Inbox; clock?: () => number; graceMs?: number }) {
  const { registry, inbox, clock = Date.now, graceMs = defaultGraceMs } = options;
  let running: Promise<void> | null = null;
  async function tick() {
    for (const t of registry.threads()) {
      const limit = t.usageLimit;
      const session = registry.claudeWorker(t.id)?.session ?? null;
      // An archived thread's pylon stays paused until the person unarchives it, so the message would wake it.
      if (limit === undefined || limit.resetsAt === null || clock() < limit.resetsAt + graceMs || (t.status !== "active" && t.status !== "idle") || session === null) continue;
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
  return {
    async close() { await running; },
    poll(): Promise<void> {
      if (running === null) running = tick().finally(() => { running = null; });
      return running;
    },
  };
}
