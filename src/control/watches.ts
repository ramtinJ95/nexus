/**
 * Durable watches, which `nexus_wait` makes. A watch names the waiting thread, the watched thread and what it waits for.
 * Each pass reads every pending watch's thread and, once the condition holds, saves what happened, sends the waiting
 * thread one message saying so under the request ID `watch:<id>`, then saves the watch delivered. A condition may stop
 * holding before a retry, as a failure does once the person retries the pylon, so a retry sends what was saved. The inbox
 * never delivers a request ID twice, so a crash between the send and the save makes the next pass send a message the
 * harness already holds, which adds nothing.
 */
import type { Until } from "../harness/drive-tools.ts";
import { singleFlight } from "../single-flight.ts";
import type { Inbox } from "./inbox.ts";
import type { Registry, Thread, ThreadId } from "./registry.ts";
import { ended } from "./review.ts";

export interface Watch {
  /** The `nexus_wait` call's request ID, so a call a restart runs again finds the watch it made. */
  id: string;
  waiter: ThreadId;
  thread: ThreadId;
  until: Until;
  /** What the watched thread showed when the watch started: its last reply, and its review if that had already ended. */
  since: { lastReplyAt: number | null; endedReview: string | null };
  createdAt: number;
  /** What happened, saved once the condition held and before the message is sent. */
  fired: { at: number; what: string } | null;
  /** When the message was sent. A watch whose waiter was deleted is delivered with no message. */
  delivered: number | null;
}

export const watchPrefix = "[Nexus watch — automated, not a message from the person]";
/** Pending watches one thread may hold, so a model that loops on nexus_wait cannot fill the registry. */
export const maxWatches = 10;

/** What happened, for each condition that holds of the watched thread since the watch started, or null. */
const conditions: Readonly<Record<Until, (registry: Registry, t: Thread, since: Watch["since"]) => string | null>> = {
  "turn-ended": (_, t, since) => t.lastReplyAt !== null && t.lastReplyAt !== since.lastReplyAt ? "its turn ended" : null,
  "review-ended": (registry, t, since) => {
    const review = registry.review(t.id);
    return review !== null && ended.has(review.phase.kind) && review.id !== since.endedReview ? `its review of ${review.pr.url} ended ${review.phase.kind}` : null;
  },
  merged: (registry, t) => {
    const merged = registry.prWatch(t.id)?.links.find((l) => l.pr.state === "merged");
    return merged === undefined ? null : `its pull request ${merged.pr.url} merged`;
  },
  failed: (registry, t) => registry.attention(t.id) === "failed" ? `it failed: ${registry.pylon(t.pylonId)?.failed ?? registry.claudeWorker(t.id)?.message ?? "see nexus_read"}` : null,
};

export function sinceOf(registry: Registry, t: Thread): Watch["since"] {
  const review = registry.review(t.id);
  return { lastReplyAt: t.lastReplyAt, endedReview: review !== null && ended.has(review.phase.kind) ? review.id : null };
}

export function watchPass(options: { registry: Registry; inbox: Inbox; now?: () => number; log?: (message: string) => void }) {
  const { registry, inbox, now = Date.now, log = (message: string) => console.error(message) } = options;

  async function deliver(watch: Watch) {
    const waiter = registry.thread(watch.waiter)!;
    if (waiter.status === "deleted") return registry.saveWatch({ ...watch, delivered: now() });
    const t = registry.thread(watch.thread)!;
    let { fired } = watch;
    if (fired === null) {
      const what = t.status === "archived" || t.status === "deleted" ? `it was ${t.status}` : conditions[watch.until](registry, t, watch.since);
      if (what === null) return;
      fired = { at: now(), what };
      registry.saveWatch({ ...watch, fired });
    }
    // An archived thread's agent cannot act on it, and the watch keeps for an unarchive.
    if (waiter.status === "archived") return;
    const text = `${watchPrefix}\nThread ${t.id} "${t.title}", which you watched until ${watch.until}: ${fired.what}. nexus_read ${t.id} says more.`;
    if (await inbox(waiter, { id: `watch:${watch.id}`, text, sender: "watch" }) === "delivered") registry.saveWatch({ ...watch, fired, delivered: now() });
  }

  async function pass() {
    for (const watch of registry.pendingWatches()) {
      try {
        await deliver(watch);
      } catch (err) {
        log(`${watch.waiter}: watch ${watch.id} on ${watch.thread} could not be delivered and will be retried: ${(err as Error).message}`);
      }
    }
  }
  const passes = singleFlight(pass);
  return { poll: passes.rerun, close: passes.settled };
}
