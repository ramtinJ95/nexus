/**
 * The usage backfill: a run that wakes archived threads' pylons one at a time, without bringing their sessions back
 * (the desired phase `reading`), reads every transcript on each from its start as live counting records calls, and lets
 * the pylon pause again before it wakes the next. Each step reads the run from the registry and does what is left of
 * it, so a control plane that restarts or deploys mid-run goes on where it stopped.
 */
import type { NodeName, PylonObservation } from "../protocol.ts";
import { singleFlight } from "../single-flight.ts";
import { gib, roomLeft, uncounted } from "./placement.ts";
import type { Registry, StoredPylon, Thread, ThreadId } from "./registry.ts";
import type { UsageCounter } from "./usage-counter.ts";
import type { BackfillPlanRow, UsageBackfill } from "./usage.ts";

export interface UsageBackfillJob {
  status(): UsageBackfill;
  /** The dry run: each archived thread a start would read, with why a run before skipped it. */
  plan(): BackfillPlanRow[];
  /** Starts a run over the plan's threads, unless one runs, and answers its state. */
  start(): UsageBackfill;
  /** Stops a running run, whose pylon then pauses, and answers its state. */
  stop(): UsageBackfill;
  close(): Promise<void>;
}

const nothing = { calls: 0, tokens: 0 };
const minutes = (ms: number) => `${ms / 60_000} minutes`;

export function usageBackfill(options: {
  registry: Registry;
  counter: Pick<UsageCounter, "readWhole">;
  /** Asks the node's loop for a pass, so the wake or pause of a pylon goes out at once. */
  wake(node: NodeName): void;
  log?: (message: string) => void;
  intervalMs?: number;
  /** How long a woken pylon may take to run, 10 minutes by default. */
  bootMs?: number;
  /** How long a read pylon may take to pause before the run goes on, 10 minutes by default. */
  pauseMs?: number;
}): UsageBackfillJob {
  const { registry, counter, wake, log = (message: string) => console.error(message), intervalMs = 2_000, bootMs = 600_000, pauseMs = 600_000 } = options;
  const shutdown = new AbortController();
  const steps = singleFlight(async () => {
    try {
      await step();
    } catch (err) {
      log(`usage backfill: ${(err as Error).message}`);
    }
  }, () => shutdown.signal.aborted);

  function seen(p: StoredPylon): PylonObservation | "absent" | null {
    const node = registry.node(p.node);
    if (node?.state !== "online" || node.observation === null) return null;
    return node.observation.pylons.find((o) => o.pylonId === p.pylonId) ?? "absent";
  }

  function unreadable(t: Thread): string | null {
    if (t.status === "deleted") return "it was deleted, and its pylon with it";
    if (t.status !== "archived") return "it is not archived any more, so live counting reads it";
    const p = registry.pylon(t.pylonId);
    if (p === undefined) return "its pylon has no record";
    if (p.failed !== null) return `its pylon failed: ${p.failed}`;
    if (seen(p) === "absent") return `${p.node} holds no disk for its pylon`;
    return null;
  }

  /**
   * Keeps room on the node for the largest project's pylon once this one is up, so a person's next start always fits.
   * Only a stopped or running pylon is woken, since the planner fails a broken one it is asked to run.
   */
  function blocked(p: StoredPylon): string | null {
    const node = registry.node(p.node);
    const o = node?.state === "online" ? node.observation : null;
    if (o == null) return `${p.node} is offline`;
    if (o.spawnsWithoutRelaunch !== true) return `${p.node} runs a probe too old to wake a pylon without its sessions`;
    if (o.jobs.some((j) => j.state === "running") || registry.pylonsOn(p.node).some((other) => other.submitted !== null)) return `${p.node} is busy with a job`;
    const observed = o.pylons.find((seen) => seen.pylonId === p.pylonId);
    if (observed !== undefined && observed.phase !== "stopped" && observed.phase !== "running") return `its pylon is ${observed.phase}`;
    const largest = Math.max(0, ...registry.projects().map((project) => project.resources.memoryGiB));
    const { left } = roomLeft(registry, p.node, o, uncounted(p, observed));
    if (left.memoryGiB < largest) return `${p.node} would have ${gib(left.memoryGiB)} GiB of memory left with it up, less than the ${largest} GiB of the largest project's pylon`;
    return null;
  }

  function next(now: number) {
    for (const row of registry.usageBackfillThreads()) {
      if (row.state !== "pending") continue;
      const t = registry.thread(row.thread)!;
      const why = unreadable(t);
      if (why !== null) {
        registry.finishUsageBackfillThread(t.id, "skipped", why, nothing, now);
        continue;
      }
      const p = registry.pylon(t.pylonId)!;
      const waiting = blocked(p);
      registry.waitUsageBackfill(waiting);
      if (waiting !== null) return;
      // A failure from before the thread was archived would hold the wake in backoff, which the run reads as its own.
      if (p.attempts.last !== null) registry.clearPylonAttempts(p.pylonId);
      registry.holdUsageBackfill(t.id, now);
      wake(p.node);
      return;
    }
    registry.finishUsageBackfill(now);
  }

  async function reading(id: ThreadId, since: number, now: number) {
    const t = registry.thread(id)!;
    const p = registry.pylon(t.pylonId);
    const finish = (state: "done" | "skipped", reason: string | null, recovered = nothing) => {
      registry.finishUsageBackfillThread(id, state, reason, recovered, Date.now());
      if (p !== undefined) wake(p.node);
    };
    if (t.status === "deleted") return finish("skipped", "it was deleted while it was read");
    if (t.status !== "archived") return finish("skipped", "it was unarchived while it was read, so live counting reads it");
    if (p === undefined) return finish("skipped", "its pylon has no record");
    if (p.failed !== null) return finish("skipped", `its pylon failed: ${p.failed}`);
    const last = p.attempts.last;
    if (last !== null) {
      registry.clearPylonAttempts(p.pylonId);
      return finish("skipped", `the pylon did not boot: ${last.code}: ${last.message}`);
    }
    const o = seen(p);
    if (o !== null && o !== "absent" && o.phase === "running") {
      let recovered: { calls: number; tokens: number };
      try {
        recovered = await counter.readWhole(id, shutdown.signal);
      } catch (err) {
        // A stop or a shutdown cut the read short, so the thread waits for the next run.
        const run = registry.usageBackfill();
        if (shutdown.signal.aborted || run.state !== "running" || run.current?.thread !== id) return;
        return finish("skipped", `reading it failed: ${(err as Error).message}`);
      }
      return finish("done", null, recovered);
    }
    if (now - since >= bootMs) finish("skipped", `its pylon did not boot within ${minutes(bootMs)}`);
  }

  function pausing(id: ThreadId, since: number, now: number) {
    const t = registry.thread(id)!;
    const p = registry.pylon(t.pylonId);
    const o = p === undefined ? "absent" : seen(p);
    const paused = o === "absent" || o?.phase === "stopped";
    if (!paused && t.status === "archived" && now - since < pauseMs) return;
    if (!paused && t.status === "archived") log(`usage backfill: ${t.pylonId} did not pause within ${minutes(pauseMs)}, so the run goes on without it`);
    registry.releaseUsageBackfill();
  }

  async function step() {
    const run = registry.usageBackfill();
    if (run.state !== "running") return;
    const now = Date.now();
    if (run.current === null) return next(now);
    if (run.current.phase === "reading") return reading(run.current.thread, run.current.since, now);
    pausing(run.current.thread, run.current.since, now);
  }

  function plan(): BackfillPlanRow[] {
    const rows = new Map(registry.usageBackfillThreads().map((r) => [r.thread, r]));
    return registry.threads().flatMap((t) => {
      const row = rows.get(t.id);
      const p = registry.pylon(t.pylonId);
      if (t.status !== "archived" || p === undefined || row?.state === "done") return [];
      return [{ thread: t.id, project: t.project, node: p.node, title: t.title, reason: row?.state === "skipped" ? row.reason : null }];
    });
  }

  const timer = setInterval(() => void steps.rerun(), intervalMs);
  timer.unref();
  void steps.rerun();

  return {
    status: () => registry.usageBackfill(),
    plan,
    start() {
      const state = registry.startUsageBackfill(plan().map((r) => r.thread), Date.now());
      void steps.rerun();
      return state;
    },
    stop() {
      const run = registry.usageBackfill();
      const state = registry.stopUsageBackfill(Date.now());
      const held = run.state === "running" && run.current !== null ? registry.pylon(registry.thread(run.current.thread)!.pylonId) : undefined;
      if (held !== undefined) wake(held.node);
      return state;
    },
    async close() {
      shutdown.abort();
      clearInterval(timer);
      await steps.settled();
    },
  };
}
