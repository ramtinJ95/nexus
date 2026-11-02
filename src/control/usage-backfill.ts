/**
 * The usage backfill: a run that wakes archived threads' pylons one at a time, without bringing their sessions back
 * (the desired phase `reading`), reads every transcript on each from its start as live counting records calls, and lets
 * the pylon pause again before it wakes the next. Each step reads the run from the registry and does what is left of
 * it, so a control plane that restarts or deploys mid-run goes on where it stopped.
 *
 * Its steps also settle each archive, with no run: once an archived thread's pylon has paused, it is woken and read
 * the same way, and the read records the archive settled, which its disk's delete waits on. The pause ends every turn
 * on the pylon and a wake for reading starts none, so only a read after it proves nothing came after the read. One
 * pylon is up at a time across the run and the settles, and a settle goes first.
 */
import type { NodeName, PylonId, ThreadId } from "../ids.ts";
import { desiredPhase } from "../reconcile.ts";
import type { PylonObservation } from "../protocol/observations.ts";
import { singleFlight } from "../single-flight.ts";
import { observedPylon } from "./observed.ts";
import { gib, roomLeft, uncounted } from "./placement.ts";
import type { Registry } from "./registry.ts";
import type { StoredPylon, Thread, UsageHold } from "./thread-store.ts";
import type { UsageCounter } from "./usage-counter.ts";
import type { BackfillPlanRow, UsageBackfill } from "./usage.ts";

type UsageBackfillRegistry = Pick<Registry, "clearPylonAttempts" | "finishSettle" | "finishUsageBackfill" | "finishUsageBackfillThread" | "holdSettle" | "holdUsageBackfill" | "keptArchives" | "markUnread" | "node" | "nodes" | "projects" | "pylon" | "pylonsOn" | "pylonsWithStatusOn" | "pylonsWithThreadsOn" | "releaseSettle" | "releaseUsageBackfill" | "reserved" | "settleHold" | "startUsageBackfill" | "stopUsageBackfill" | "storedThreads" | "thread" | "threads" | "usageBackfill" | "usageBackfillThreads" | "waitSettle" | "waitUsageBackfill">;

/**
 * What holds a pylon to read it whole: the run, whose hold the registry keeps, or a settle, whose hold it keeps in
 * memory. `finish` records the thread read, with a null reason, or given up on, and the hold then waits for the pause.
 * `seal` seals the pylon's transcripts before the read, as only a settle needs, since a reading wake still runs the
 * project's resume hook and services, which can start agents.
 */
interface Holder {
  seal: boolean;
  finish(thread: ThreadId, reason: string | null): void;
  holds(thread: ThreadId): boolean;
  release(): void;
}

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

const minutes = (ms: number) => `${ms / 60_000} minutes`;

export function usageBackfill(options: {
  registry: UsageBackfillRegistry;
  counter: Pick<UsageCounter, "readWhole" | "unseal">;
  /** Asks the node's loop for a pass, so the wake or pause of a pylon goes out at once. */
  wake(node: NodeName): void;
  log?: (message: string) => void;
  intervalMs?: number;
  /** How long a woken pylon may take to run, 10 minutes by default. */
  bootMs?: number;
  /** How long a read pylon may take to pause before the run goes on, 10 minutes by default. */
  pauseMs?: number;
  /** How long after an archive's failed settle the next is tried, an hour by default. */
  settleRetryMs?: number;
}): UsageBackfillJob {
  const { registry, counter, wake, log = (message: string) => console.error(message), intervalMs = 2_000, bootMs = 600_000, pauseMs = 600_000, settleRetryMs = 3_600_000 } = options;
  const shutdown = new AbortController();
  const steps = singleFlight(async () => {
    try {
      await step();
    } catch (err) {
      log(`usage backfill: ${(err as Error).message}`);
    }
  }, () => shutdown.signal.aborted);

  const seen = (p: StoredPylon): PylonObservation | "absent" | null => registry.node(p.node)?.state === "online" ? observedPylon(registry, p) : null;
  const imageHeld = (p: StoredPylon) => registry.nodes().some((n) => n.state === "online" && n.observation?.artifacts.includes(p.boot.image) === true);

  const runHolder: Holder = {
    seal: false,
    finish: (thread, reason) => registry.finishUsageBackfillThread(thread, reason === null ? "done" : "skipped", reason, Date.now()),
    holds(thread) {
      const r = registry.usageBackfill();
      return r.state === "running" && r.current?.thread === thread;
    },
    release: () => registry.releaseUsageBackfill(),
  };
  // A failure keeps its first line, as a pylon's failure ends with its log.
  const settleHolder: Holder = {
    seal: true,
    finish: (thread, reason) => registry.finishSettle(thread, reason === null ? null : reason.split("\n")[0]!, Date.now()),
    holds: (thread) => registry.settleHold()?.thread === thread,
    release: () => registry.releaseSettle(),
  };

  function unreadable(t: Thread): string | null {
    if (t.status === "deleted") return "it was deleted, and its pylon with it";
    if (t.status !== "archived") return "it is not archived any more, so live counting reads it";
    if (desiredPhase(t, Date.now()) === "deleted") return "its disk was deleted 24 hours after it was archived, once its usage was read and backed up";
    const p = registry.pylon(t.pylonId);
    if (p === undefined) return "its pylon has no record";
    if (p.failed !== null) return `its pylon failed: ${p.failed}`;
    const o = seen(p);
    if (o === "absent") return `${p.node} holds no disk for its pylon`;
    if (o !== null && o.phase === "stopped" && !imageHeld(p)) return `no online node holds its image ${p.boot.image}`;
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
    if (o.spawnsWithoutRelaunch !== true || o.capacity === null) return `${p.node} runs a probe too old to wake a pylon without its sessions`;
    if (o.jobs.some((j) => j.state === "running") || registry.pylonsOn(p.node).some((other) => other.submitted !== null)) return `${p.node} is busy with a job`;
    const observed = o.pylons.find((seen) => seen.pylonId === p.pylonId);
    if (observed !== undefined && observed.phase !== "stopped" && observed.phase !== "running") return `its pylon is ${observed.phase}`;
    const largest = Math.max(0, ...registry.projects().map((project) => project.resources.memoryGiB));
    const { left } = roomLeft(registry, p.node, o, o.capacity, uncounted(p, observed));
    if (left.memoryGiB < largest) return `${p.node} would have ${gib(left.memoryGiB)} GiB of memory left with it up, less than the ${largest} GiB of the largest project's pylon`;
    return null;
  }

  function next(now: number) {
    for (const row of registry.usageBackfillThreads()) {
      if (row.state !== "pending") continue;
      const t = registry.thread(row.thread)!;
      const why = unreadable(t);
      if (why !== null) {
        registry.finishUsageBackfillThread(t.id, "skipped", why, now);
        continue;
      }
      const p = registry.pylon(t.pylonId)!;
      const waiting = blocked(p);
      registry.waitUsageBackfill(waiting);
      if (waiting !== null) return;
      // A failure from before the thread was archived would hold the wake in backoff, which the run reads as its own.
      if (p.attempts.last !== null || p.attempts.readFailure !== undefined) registry.clearPylonAttempts(p.pylonId);
      registry.holdUsageBackfill(t.id, now);
      wake(p.node);
      return;
    }
    registry.finishUsageBackfill(now);
  }

  /** When each archived pylon was first seen up while nothing held it, so one stuck up stops holding every settle back. */
  const upSince = new Map<PylonId, number>();

  /**
   * An archived pylon up while nothing holds it, as one a restart's lost hold or a released hold left booting, running
   * for reading (no liveHash) or stopping, for up to `pauseMs` from when it was first seen so. Past that it is logged and
   * waited for no more.
   */
  function upPylon(now: number): StoredPylon | null {
    const up = registry.storedThreads({ status: ["archived"] }).flatMap((t) => {
      const p = registry.pylon(t.pylonId);
      const o = p === undefined || p.failed !== null ? null : seen(p);
      return o !== null && o !== "absent" && (o.phase === "booting" || o.phase === "stopping" || (o.phase === "running" && o.liveHash === null)) ? [p!] : [];
    });
    for (const id of upSince.keys()) if (!up.some((p) => p.pylonId === id)) upSince.delete(id);
    for (const p of up) {
      const since = upSince.get(p.pylonId) ?? now;
      upSince.set(p.pylonId, since);
      if (now - since < pauseMs) return p;
      if (now - since < pauseMs + intervalMs) log(`usage settle: ${p.pylonId} has been up for reading ${minutes(pauseMs)} with nothing holding it, so the settles go on without it`);
    }
    return null;
  }

  /**
   * Holds the oldest archive not settled whose pylon can be woken now, and wakes it, or says why nothing is woken: a
   * pylon is already up, so no settle and no run wakes another. A pylon that runs has not paused since its archive yet,
   * so it waits. One its online node does not have has no disk to lose, so it is settled as it is. One that failed or
   * whose image no online node holds cannot be read, which is recorded, and its disk goes at its 24 hours with its usage
   * unread, as the person decided on 2026-11-02, until it can be read again. A settle that failed is tried again
   * `settleRetryMs` after. Each archive that waits records why, which its thread shows.
   */
  function nextSettle(now: number): "held" | "up" | "none" {
    const archives = registry.keptArchives().filter((t) => t.usageSettledAt === undefined);
    const up = upPylon(now);
    if (up !== null) {
      for (const t of archives) if (t.pylonId !== up.pylonId) registry.waitSettle(t.id, `${up.pylonId} on ${up.node} is up for reading, and one pylon is woken at a time`);
      return "up";
    }
    for (const t of archives) {
      const p = registry.pylon(t.pylonId);
      if (p === undefined) continue;
      // A failure ends with its log, so only its first line is kept.
      if (p.failed !== null) {
        registry.markUnread(t.id, `its pylon failed: ${p.failed.split("\n")[0]!}`);
        continue;
      }
      const o = seen(p);
      if (o === null) {
        registry.waitSettle(t.id, `${p.node} is offline`);
        continue;
      }
      if (o === "absent") {
        // A disk that went with its usage unread keeps that on record.
        if (p.submitted === null && t.usageUnread === undefined) settleHolder.finish(t.id, null);
        continue;
      }
      if (o.phase === "stopped" && !imageHeld(p)) {
        registry.markUnread(t.id, `no online node holds its image ${p.boot.image}`);
        continue;
      }
      if (t.usageUnread !== undefined) registry.markUnread(t.id, null);
      if (t.settleFailure !== undefined && now - t.settleFailure.at < settleRetryMs) continue;
      if (o.phase !== "stopped") {
        registry.waitSettle(t.id, o.phase === "running" ? "its pylon has not paused since its archive yet" : `its pylon is ${o.phase}`);
        continue;
      }
      const waiting = blocked(p);
      registry.waitSettle(t.id, waiting);
      if (waiting !== null) continue;
      if (p.attempts.last !== null || p.attempts.readFailure !== undefined) registry.clearPylonAttempts(p.pylonId);
      registry.holdSettle(t.id, now);
      wake(p.node);
      return "held";
    }
    return "none";
  }

  async function reading(holder: Holder, id: ThreadId, since: number, now: number) {
    const t = registry.thread(id)!;
    const p = registry.pylon(t.pylonId);
    const finish = (reason: string | null) => {
      holder.finish(id, reason);
      if (p !== undefined) wake(p.node);
    };
    if (t.status === "deleted") return finish("it was deleted while it was read");
    if (t.status !== "archived") return finish("it was unarchived while it was read, so live counting reads it");
    if (p === undefined) return finish("its pylon has no record");
    if (p.failed !== null) return finish(`its pylon failed: ${p.failed}`);
    const last = p.attempts.readFailure ?? p.attempts.last;
    if (last !== null) {
      registry.clearPylonAttempts(p.pylonId);
      return finish(`the pylon did not boot: ${last.code}: ${last.message}`);
    }
    const o = seen(p);
    if (o !== null && o !== "absent" && o.phase === "running") {
      try {
        await counter.readWhole(id, shutdown.signal, holder.seal);
      } catch (err) {
        // A stop or a shutdown cut the read short, so the thread waits for the next run or settle.
        if (shutdown.signal.aborted || !holder.holds(id)) return;
        return finish(`reading it failed: ${(err as Error).message}`);
      }
      return finish(null);
    }
    if (now - since >= bootMs) finish(`its pylon did not boot within ${minutes(bootMs)}`);
  }

  function pausing(holder: Holder, id: ThreadId, since: number, now: number) {
    const t = registry.thread(id)!;
    const p = registry.pylon(t.pylonId);
    const o = p === undefined ? "absent" : seen(p);
    const paused = o === "absent" || o?.phase === "stopped";
    if (!paused && t.status === "archived" && now - since < pauseMs) return;
    if (!paused && t.status === "archived") log(`usage backfill: ${t.pylonId} did not pause within ${minutes(pauseMs)}, so the next pylon is woken without it`);
    if (!paused && holder.seal && t.status !== "archived") void unseal(id);
    holder.release();
  }

  /** A thread unarchived after its settle sealed its pylon runs on, so its agents need their transcripts back. */
  const unseal = (id: ThreadId) => counter.unseal(id).catch((err: unknown) => log(`usage settle: ${id}'s transcripts stay sealed until its pylon pauses: ${(err as Error).message}`));

  const advance = (holder: Holder, hold: UsageHold, now: number) =>
    hold.phase === "reading" ? reading(holder, hold.thread, hold.since, now) : pausing(holder, hold.thread, hold.since, now);

  async function step() {
    const now = Date.now();
    const settling = registry.settleHold();
    if (settling !== null) return advance(settleHolder, settling, now);
    const backfill = registry.usageBackfill();
    if (backfill.state === "running" && backfill.current !== null) return advance(runHolder, backfill.current, now);
    if (nextSettle(now) !== "none" || backfill.state !== "running") return;
    next(now);
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
