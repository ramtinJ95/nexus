/**
 * The work model: what a thread is to the work, where its pull request is, and what of it waits on the person. The
 * queue, the pipeline, the PR watch, the nudger, the resumer, the review loop, the inbox and the dashboard read it here.
 */
import type { ThreadId } from "../ids.ts";
import { roleOf, type Role } from "./agent-protocol.ts";
import type { Attention, Need } from "./attention.ts";
import { prLocation, watchedPrs, type PrLocation } from "./pr-watch-model.ts";
import { archivedDiskMs, isOpenStatus, settleStuck } from "./reconcile.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";

/** `isReviewer` also names a reviewer that a later review of the same builder replaced. */
export function threadRole(registry: Pick<Registry, "reviews" | "planning">, t: Pick<Thread, "id" | "startedBy">): Role {
  const role = roleOf(t.startedBy);
  if (role === "reviewer" || role === "check" || role === "verify") return role;
  if (registry.reviews.isReviewer(t.id)) return "reviewer";
  return registry.planning.planning(t.id) === null ? "builder" : "planning";
}

/** A reviewer, check or verify thread serves a builder's review, and merges no pull request of its own. */
export const servesReview = (role: Role) => role === "reviewer" || role === "check" || role === "verify";

export const prLocationOf = (registry: Pick<Registry, "reviews" | "prWatches">, id: ThreadId): PrLocation => prLocation(registry.reviews.review(id), watchedPrs(registry.prWatches.prWatch(id)));

/**
 * A thing of a thread's that waits on the person: one of an open thread's own needs, the open thread itself stopped
 * where only the person moves it, or an archive whose disk is kept for usage that will not be read without them.
 */
export type PersonNeed = Need | { kind: "disk"; since: number } | { kind: "thread"; attention: Exclude<Attention, "reply" | "working" | "decision" | null>; since: number };

/**
 * A new reply does not wait on the person, so it has no need, but it outranks a dialog in the terminal, which the
 * session's own state says waits.
 */
export function personNeeds(registry: Pick<Registry, "threads">, t: Thread, now: number): PersonNeed[] {
  if (t.status === "archived") return settleStuck(t, now) ? [{ kind: "disk", since: t.archivedAt! + archivedDiskMs }] : [];
  if (!isOpenStatus(t.status)) return [];
  const attention = registry.threads.attention(t.id);
  const stuck = attention === "failed" || attention === "parked" || attention === "limited" ? attention : attention !== "decision" && t.sessionWaiting === true ? "waiting" : null;
  const own: PersonNeed[] = [...registry.threads.needs(t.id)];
  if (stuck !== null) own.push({ kind: "thread", attention: stuck, since: t.usageLimit?.stoppedAt ?? Math.max(t.createdAt, t.lastAgentActivityAt) });
  return own;
}
