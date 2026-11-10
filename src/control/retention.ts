/**
 * How long a closed thread stays, as pure functions over what the registry says of it. An archived thread with no
 * activity for a week is deleted, as `nexus delete` deletes it, whether or not its token usage was read off its disk.
 * A deleted thread is purged from the registry a week after its delete, once a backup that began after the delete
 * verified, so a backup still holds it. A feature that still reads the thread keeps it, and says why
 * (`ThreadParticipant.keeps`). The pass (retention-pass.ts) applies this a few threads at a time.
 */
import type { ThreadId } from "../ids.ts";

const dayMs = 24 * 60 * 60_000;
export const archivedRetentionMs = 7 * dayMs;
export const deletedRetentionMs = 7 * dayMs;
/** The most threads one pass deletes and purges, so the first passes over a registry of old threads go gradually. */
export const deletesPerPass = 20;
export const purgesPerPass = 50;
/**
 * Retention counts in weeks, and a pass reads every closed thread and every review, which takes a tenth of a second on
 * a registry of a few thousand threads, so it runs every 10 minutes, not on the control plane's 15-second passes.
 */
export const retentionPassMs = 10 * 60_000;

/** What retention does to a closed thread: deletes an archived one, or purges a deleted one from the registry. */
export type Removal = "delete" | "purge";
export const removalOf = { archived: "delete", deleted: "purge" } as const satisfies Record<RetainedThread["status"], Removal>;

/**
 * What retention reads of an archived or deleted thread. `kept` is why a feature or the thread store keeps it from its
 * removal, or null. `archivedAt` and `deletedAt` are null where the registry holds no time for them.
 */
export type RetainedThread = { id: ThreadId; kept: string | null } & (
  | { status: "archived"; archivedAt: number | null; lastHumanActivityAt: number; lastAgentActivityAt: number; lastReplyAt: number | null }
  | { status: "deleted"; deletedAt: number | null });

/** When retention began, as the migration that added it recorded, and when the newest verified backup began. */
export interface RetentionClock { now: number; since: number | null; backedUpAt: number | null }

/** `until` is when a thread kept only for its time becomes due. */
export type RetentionStep = { kind: "keep"; why: string; until?: number } | { kind: "delete" } | { kind: "purge" };

/**
 * When the thread's week counts from: an archived thread's latest archive, activity or reply, and a deleted thread's
 * delete, but never before retention began.
 */
export function retainedFrom(t: RetainedThread, since: number): number {
  return t.status === "archived"
    ? Math.max(since, t.archivedAt ?? 0, t.lastHumanActivityAt, t.lastAgentActivityAt, t.lastReplyAt ?? 0)
    : Math.max(since, t.deletedAt ?? 0);
}

export function retentionStep(t: RetainedThread, { now, since, backedUpAt }: RetentionClock): RetentionStep {
  if (since === null) return { kind: "keep", why: "the registry records no time retention began" };
  const from = retainedFrom(t, since);
  const until = from + (t.status === "archived" ? archivedRetentionMs : deletedRetentionMs);
  if (now < until) return { kind: "keep", why: `its week runs until ${new Date(until).toISOString()}`, until };
  if (t.status === "deleted" && (backedUpAt === null || backedUpAt <= from)) return { kind: "keep", why: "it waits for a verified backup that began after its delete" };
  if (t.kept !== null) return { kind: "keep", why: t.kept };
  return { kind: removalOf[t.status] };
}
