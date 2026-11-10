/**
 * The retention pass: each poll applies retention.ts to every archived and deleted thread, oldest first. It deletes at
 * most deletesPerPass archived threads, through the API's delete, so each one's streams end and its agent is deleted as
 * `nexus delete` does, and the planner then deletes its pylon. It purges at most purgesPerPass deleted threads from the
 * registry. Each delete and purge is logged with why, and each thread a feature keeps once it is due, once per reason.
 */
import { singleFlight } from "../single-flight.ts";
import { logOnce, type Log } from "./log-once.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import { deletesPerPass, purgesPerPass, retainedFrom, retentionStep, type RetainedThread } from "./retention.ts";

export function retentionPass({ registry, deleteThread, log }: { registry: Pick<Registry, "threads" | "now">; deleteThread(t: Thread): Promise<unknown>; log: Log }) {
  const kept = logOnce(log);

  async function pass() {
    const { threads, ...clock } = registry.threads.retained();
    const at = { ...clock, now: registry.now() };
    const due: Record<"delete" | "purge", RetainedThread[]> = { delete: [], purge: [] };
    for (const t of threads) {
      const step = retentionStep(t, at);
      if (step.kind !== "keep") due[step.kind].push(t);
      else if (step.until === undefined) kept.failed(t.id, `retention: keeps ${t.id}, as ${step.why}`);
      else kept.ok(t.id);
    }
    const from = (t: RetainedThread) => retainedFrom(t, at.since ?? 0);
    const oldest = (list: RetainedThread[], most: number) => list.sort((a, b) => from(a) - from(b)).slice(0, most);
    for (const t of oldest(due.purge, purgesPerPass)) {
      try {
        registry.threads.purgeThread(t.id);
      } catch (err) {
        kept.failed(t.id, `retention: purging ${t.id} failed: ${(err as Error).message}`);
        continue;
      }
      kept.ok(t.id);
      log(`retention: purged ${t.id} from the registry, deleted for a week from ${new Date(from(t)).toISOString()} and backed up since`);
    }
    // Each delete sets its thread's status before its first await, in the turn that read the steps.
    await Promise.all(oldest(due.delete, deletesPerPass).map(async (t) => {
      const deleting = deleteThread(registry.threads.thread(t.id)!);
      kept.ok(t.id);
      log(`retention: deleted ${t.id}, archived and idle for a week from ${new Date(from(t)).toISOString()}`);
      try {
        await deleting;
      } catch (err) {
        log(`retention: deleting ${t.id} failed: ${(err as Error).message}`);
      }
    }));
  }

  const passes = singleFlight(pass);
  return { poll: passes.rerun, close: passes.settled };
}
