import type { EventKind, NexusEvent } from "../events.ts";
import type { Registry } from "./registry.ts";

/**
 * Hands `onEvents` each batch of the events of `kinds` that the registry appends after now, polled every `everyMs`.
 * A batch that cannot be read, such as one whose cursor retention passed, goes to `onReset` with the error, and
 * following goes on from the newest event. Returns the function that stops it.
 */
export function followEvents(
  registry: Pick<Registry, "eventBatch" | "newestEvent">, kinds: readonly EventKind[], everyMs: number,
  onEvents: (events: readonly NexusEvent[]) => void, onReset: (err: Error) => void,
): () => void {
  let cursor = registry.newestEvent();
  const timer = setInterval(() => {
    let batch: ReturnType<Registry["eventBatch"]>;
    try {
      batch = registry.eventBatch(cursor, { kinds });
    } catch (err) {
      cursor = registry.newestEvent();
      onReset(err as Error);
      return;
    }
    cursor = batch.watermark;
    if (batch.events.length > 0) onEvents(batch.events);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
