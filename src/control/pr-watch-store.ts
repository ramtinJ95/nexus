/**
 * The PR watch store: each thread's PR watch. A save tells the event log what changed, in its transaction.
 */
import type { Db, Holding } from "./db.ts";
import type { EventKind } from "./events.ts";
import type { ThreadId } from "../ids.ts";
import type { Output } from "./thread-store.ts";
import type { PullRequest } from "./github.ts";

/** A PR as the PR watch last read it. `url` is empty until its first read. */
export interface WatchedPr extends PullRequest {
  /** The head commit at that read, which the review loop compares with the head it reviewed. */
  head?: string;
  /** The opening of the PR's description at that read, for the dashboard's card of a held review. */
  summary?: string;
}
/** Whether the watch read the linked PR at least once. A link it has not read yet has an empty `url`. */
export const wasRead = (pr: Pick<WatchedPr, "url">) => pr.url !== "";
interface PrLink {
  pr: WatchedPr;
  seen: string[];
  failed: boolean;
}
export interface PrWatchState {
  links: PrLink[];
  commentWakes: number;
  pending: { id: string; text: string } | null;
  error: string | null;
}

export const holding = { tables: { pr_watches: { record: "thread" } } } as const satisfies Holding;

export function prWatchStore(db: Db, appendEvent: (kind: EventKind, thread: ThreadId, payload: Record<string, unknown>) => unknown) {
  const { transaction } = db;
  const watches = db.hold(holding).records<PrWatchState>("pr_watches");
  return {
    participant: {
      outputs(thread: ThreadId): Output[] {
        const watch = watches.get(thread);
        return watch ? watch.links.filter((l) => wasRead(l.pr)).map((l): Output => ({ thread, kind: "pull-request", ref: l.pr.url })) : [];
      },
    },
    prWatch: (thread: ThreadId): PrWatchState | null => watches.get(thread),
    /**
     * Replaces the thread's PR watch, and tells the event log of new feedback, of each PR linked since the last save, and
     * of an error that starts or clears.
     */
    savePrWatch(thread: ThreadId, state: PrWatchState) {
      transaction(() => {
        const previous = watches.get(thread);
        if (state.pending !== null && previous?.pending?.id !== state.pending.id) appendEvent("pull-request.feedback", thread, { requestId: state.pending.id });
        // A placeholder link never fires.
        const linked = new Set(previous?.links.filter((l) => wasRead(l.pr)).map((l) => `${l.pr.repo}#${l.pr.number}`));
        for (const { pr } of state.links) {
          if (wasRead(pr) && !linked.has(`${pr.repo}#${pr.number}`)) appendEvent("pull-request.linked", thread, { repo: pr.repo, number: pr.number, url: pr.url, title: pr.title, state: pr.state });
        }
        if ((previous?.error ?? null) === null && state.error !== null) appendEvent("pull-request.error", thread, { error: state.error });
        if ((previous?.error ?? null) !== null && state.error === null) appendEvent("pull-request.error-cleared", thread, {});
        watches.save(thread, state);
      });
    },
  };
}
