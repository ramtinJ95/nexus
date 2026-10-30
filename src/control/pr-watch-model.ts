/**
 * What the PR watch's record and cadence say: how often it reads, when its comment cap stops it, and which branches a
 * thread pushed. For features that read them without running the watch.
 */
import type { ThreadId } from "../ids.ts";
import type { Registry } from "./registry.ts";
import type { PrWatchState } from "./pr-watch-store.ts";

/** How often the watch reads GitHub. */
export const prWatchMs = 120_000;
/** How many comment-only wakes in a row stop a thread's watch, until a failed check or a conflict resets the count. */
export const commentCap = 10;
/** Whether the comment cap stopped the watch, so it reads the thread's PRs no more. */
export const watchStopped = (state: Pick<PrWatchState, "commentWakes"> | null | undefined) => (state?.commentWakes ?? 0) >= commentCap;
/**
 * The branches thread `id` pushed to origin. pushedAs is a remote-tracking name, not a URL, and only origin belongs to
 * the project's repository.
 */
export const pushedBranches = (registry: Pick<Registry, "outputs">, id: ThreadId): string[] =>
  registry.outputs(id).flatMap((o) => o.kind === "branch" && o.ref.startsWith("origin/") ? [o.ref.slice(7)] : []);
