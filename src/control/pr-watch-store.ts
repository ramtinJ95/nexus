/**
 * The PR watch store: each thread's PR watch, in `pr_watches`. A save tells the event log what changed, in its
 * transaction.
 */
import type { Db } from "./db.ts";
import type { EventKind } from "../events.ts";
import type { ThreadId } from "../ids.ts";
import type { Output } from "./thread-store.ts";
import type { PullRequest } from "./github.ts";

export interface PrLink {
  pr: PullRequest;
  seen: string[];
  failed: boolean;
}
export interface PrWatchState {
  links: PrLink[];
  commentWakes: number;
  pending: { id: string; text: string } | null;
  error: string | null;
}

export type PrWatchStore = ReturnType<typeof prWatchStore>;

export function prWatchStore(db: Db, appendEvent: (kind: EventKind, thread: ThreadId, payload: Record<string, unknown>) => unknown) {
  const { transaction, recordOf, saveRecord } = db;
  return {
    participant: {
      outputs(thread: ThreadId): Output[] {
        const watch = recordOf<PrWatchState>("pr_watches", "thread", thread);
        return watch ? watch.links.filter((l) => l.pr.url !== "").map((l): Output => ({ thread, kind: "pull-request", ref: l.pr.url })) : [];
      },
    },
    prWatch: (thread: ThreadId): PrWatchState | null => recordOf<PrWatchState>("pr_watches", "thread", thread),
    /**
     * Replaces the thread's PR watch, and tells the event log of new feedback, of each PR linked since the last save, and
     * of an error that starts or clears.
     */
    savePrWatch(thread: ThreadId, state: PrWatchState) {
      transaction(() => {
        const previous = recordOf<PrWatchState>("pr_watches", "thread", thread);
        if (state.pending !== null && previous?.pending?.id !== state.pending.id) appendEvent("pull-request.feedback", thread, { requestId: state.pending.id });
        // A link counts once the watch has read its PR, as outputs() counts it, so a placeholder never fires.
        const linked = new Set(previous?.links.filter((l) => l.pr.url !== "").map((l) => `${l.pr.repo}#${l.pr.number}`));
        for (const { pr } of state.links) {
          if (pr.url !== "" && !linked.has(`${pr.repo}#${pr.number}`)) appendEvent("pull-request.linked", thread, { repo: pr.repo, number: pr.number, url: pr.url, title: pr.title, state: pr.state });
        }
        if ((previous?.error ?? null) === null && state.error !== null) appendEvent("pull-request.error", thread, { error: state.error });
        if ((previous?.error ?? null) !== null && state.error === null) appendEvent("pull-request.error-cleared", thread, {});
        saveRecord("pr_watches", "thread", thread, state);
      });
    },
  };
}
