/**
 * What the PR watch's record and cadence say: how often it reads, when its comment cap stops it, which branches a
 * thread pushed, and where a thread's pull request is. For features that read them without running the watch.
 */
import type { ThreadId } from "../ids.ts";
import type { Registry } from "./registry.ts";
import type { PrWatchState, WatchedPr } from "./pr-watch-store.ts";
import type { Review } from "./review-model.ts";

/** How often the watch reads GitHub. */
export const prWatchMs = 120_000;
/** How many comment-only wakes in a row stop a thread's watch, until a failed check or a conflict resets the count. */
export const commentCap = 10;
/** Whether the comment cap stopped the watch, so it reads the thread's PRs no more. */
export const watchStopped = (state: Pick<PrWatchState, "commentWakes"> | null | undefined) => (state?.commentWakes ?? 0) >= commentCap;
/** Whether the watch read the linked PR at least once. A link it has not read yet has an empty `url`. */
export const wasRead = (pr: Pick<WatchedPr, "url">) => pr.url !== "";
/**
 * The branches thread `id` pushed to origin. pushedAs is a remote-tracking name, not a URL, and only origin belongs to
 * the project's repository.
 */
export const pushedBranches = (registry: Pick<Registry, "outputs">, id: ThreadId): string[] =>
  registry.outputs(id).flatMap((o) => o.kind === "branch" && o.ref.startsWith("origin/") ? [o.ref.slice(7)] : []);
export const watchedPrs = (state: Pick<PrWatchState, "links"> | null | undefined): WatchedPr[] => state?.links.map((l) => l.pr) ?? [];

/**
 * Where a thread's pull request is. `merged` when its review merged it or saw it merged outside it, or when a PR
 * merged and none is open; `open` while one is; `closed` when every one closed; `unlinked` when only its review names
 * one, which the watch has not linked.
 */
export type PrLocation = { kind: "merged" | "open" | "closed"; number: number } | { kind: "unlinked" | "none" };

export function prLocation(review: Pick<Review, "merged" | "phase" | "pr"> | null, prs: readonly WatchedPr[]): PrLocation {
  if (review !== null && (review.merged !== null || review.phase.kind === "merged")) return { kind: "merged", number: review.pr.number };
  const open = prs.find((pr) => pr.state === "open");
  if (open !== undefined) return { kind: "open", number: open.number };
  const merged = prs.find((pr) => pr.state === "merged");
  if (merged !== undefined) return { kind: "merged", number: merged.number };
  if (prs.length > 0) return { kind: "closed", number: prs.at(-1)!.number };
  return { kind: review === null ? "none" : "unlinked" };
}
