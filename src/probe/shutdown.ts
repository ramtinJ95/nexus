/**
 * What a node's clean shutdown or reboot leaves for its next boot. Only then does the probe pause every running pylon
 * before it exits (Probe.drain): any other stop, such as a deploy's `systemctl restart`, leaves them running.
 *
 * The record names each pylon the shutdown found running, and why its pause did not finish when it did not. The probe
 * of the next boot loads it and marks those pylons for a wake, so the control plane brings them back as they were.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { VmBackend } from "../backends/backend.ts";
import { shutdownCheckpointId, type JobId, type NodeName, type PylonId } from "../ids.ts";
import { readJson, saveJson } from "../json-file.ts";
import { nonEmpty, parse } from "../parse.ts";
import { pylonIdSchema } from "../protocol/fields.ts";
import type { PylonObservation } from "../protocol/observations.ts";
import { serialQueue } from "../single-flight.ts";
import type { createJobTable } from "./jobs.ts";

/** How long a shutdown gives its pauses. deploy/nexus-probe.service's TimeoutStopSec leaves 30 s more for the close. */
export const shutdownPauseMs = 150_000;

/** Resolves to the command's stdout. It rejects on a nonzero exit, with that stdout on the error, as execFile does. */
export type Systemctl = () => Promise<{ stdout: string }>;

const isSystemRunning: Systemctl = () => promisify(execFile)("systemctl", ["is-system-running"], { timeout: 5_000 });

/**
 * What systemd says the whole system is doing, as `systemctl is-system-running` prints it. It prints `stopping` during
 * any shutdown, reboot or halt, and exits nonzero for every state but `running`, so the state is read from the failure
 * too. A systemctl that cannot answer gives why instead, which is never `stopping`.
 */
export async function systemState(run: Systemctl = isSystemRunning): Promise<string> {
  try {
    return (await run()).stdout.trim();
  } catch (err) {
    const { stdout } = err as { stdout?: unknown };
    const state = typeof stdout === "string" ? stdout.trim() : "";
    return state === "" ? `unknown, as systemctl failed: ${(err as Error).message}` : state;
  }
}

/** What the shutdown's pause did with each pylon it found running. */
export type DrainOutcome = { pylonId: PylonId } & ({ pausedInMs: number } | { failed: string });

/**
 * The probe's stop on SIGTERM or SIGINT. Only `stopping` drains, so a restart of the unit alone, as every deploy makes,
 * leaves every pylon running. A drain that throws still closes the probe.
 */
export async function closeProbe(
  probe: { drain(withinMs: number): Promise<readonly DrainOutcome[]>; close(): Promise<void> },
  signal: string, log: (line: string) => void = console.log, state: () => Promise<string> = systemState,
): Promise<void> {
  const system = await state();
  if (system !== "stopping") {
    log(`${signal}: the system is ${system}, so closing the probe. Pylon VMs keep running`);
    return probe.close();
  }
  log(`${signal}: the system is stopping, so pausing every running pylon before closing the probe`);
  try {
    for (const outcome of await probe.drain(shutdownPauseMs)) {
      log("failed" in outcome ? `${outcome.pylonId}: not paused: ${outcome.failed}` : `${outcome.pylonId}: paused in ${outcome.pausedInMs} ms`);
    }
  } finally {
    await probe.close();
  }
}

/** How long a drain waits for its last events to leave for each observer. */
const observerFlushMs = 1_000;

export interface DrainDeps {
  node: NodeName;
  backend: Pick<VmBackend, "list">;
  jobs: Pick<ReturnType<typeof createJobTable>, "running" | "busy" | "start">;
  /** Settles once each observer's last write has left the probe, or failed to. */
  flushed(): Promise<void>;
}

/** The node's shutdowns as the probe sees them: the last one's record, which snapshots mark pylons by, and this boot's drain. */
export interface ProbeShutdown {
  /** Aborted once the drain starts, after which the probe starts no job but the drain's own pauses. */
  readonly draining: AbortSignal;
  /** The pylon no longer needs the wake the last shutdown marked it for. */
  forget(pylonId: PylonId): void;
  /** Forgets each pylon of the last shutdown that the backend no longer lists. */
  listed(present: ReadonlySet<PylonId>): void;
  /** The pylon as afterShutdown reports it. */
  marked(observed: PylonObservation): PylonObservation;
  /** Probe.drain. A second call gets the first one's outcomes. */
  drain(withinMs: number, deps: DrainDeps): Promise<readonly DrainOutcome[]>;
  /** Settles once every save asked for so far has finished. */
  saved(): Promise<void>;
}

/** `file` omitted: the record lives in memory only. A save that fails is logged, and the drain goes on. */
export async function probeShutdown(file: string | undefined, log: (message: string) => void): Promise<ProbeShutdown> {
  /**
   * Each pylon the last shutdown found running that no spawn or delete has dealt with since. A drain writes a record
   * of its own, which only the next boot's probe loads.
   */
  const last: ShutdownRecord = file === undefined ? new Map() : await readShutdownRecord(file);
  const draining = new AbortController();
  /** Saves run in the order they were asked for, so the drain's record, asked for last, is the one the file keeps. */
  const saves = serialQueue();
  function save(record: ShutdownRecord): Promise<void> {
    const copy = new Map(record);
    return saves.run(async () => { if (file !== undefined) await saveShutdownRecord(file, copy); })
      .catch((err: Error) => log(`shutdown record: ${err.message}`));
  }
  function forget(pylonId: PylonId) {
    if (last.delete(pylonId) && !draining.signal.aborted) void save(last);
  }

  async function drain(withinMs: number, { node, backend, jobs, flushed }: DrainDeps): Promise<readonly DrainOutcome[]> {
    const startedAt = Date.now();
    const left = () => Math.max(0, startedAt + withinMs - Date.now());
    const outOfTime = `it did not pause within the shutdown's ${withinMs / 1000} s`;
    draining.abort(new Error("the node is shutting down"));
    // A pause the control plane sent finishes as it would have, and its pylon is then no longer running.
    const onPylons = [...jobs.running].filter(([, job]) => "pylonId" in job).map(([run]) => run);
    await Promise.race([Promise.allSettled(onPylons), delay(left(), undefined, { ref: false })]);
    const listed = await backend.list();
    const present = new Set(listed.map((p) => p.pylonId));
    // A broken disk is left as it is, as the planner leaves it (see retryRefusal in reconcile.ts).
    const targets = listed.filter((p) => p.vm === "running" || p.vm === "booting" || p.vm === "stopping").map((p) => p.pylonId);
    const record: ShutdownRecord = new Map([...last].filter(([id]) => present.has(id)));
    for (const pylonId of targets) record.set(pylonId, {});
    await save(record);
    const outcomes = await Promise.all(targets.map(async (pylonId): Promise<DrainOutcome> => {
      const pausing = Date.now();
      const budget = left();
      // Busy only with a job the wait above gave up on, as it ran past the shutdown's time. The race bounds a backend
      // that does not stop at the abort, as pylon-vm's stop does not.
      const status = jobs.busy(pylonId) ? null : await Promise.race([jobs.start({
        jobId: randomUUID() as JobId, node, issuedAt: new Date(pausing).toISOString(), notAfter: new Date(pausing).toISOString(),
        job: { kind: "pause", pylonId, checkpoint: shutdownCheckpointId(pylonId, startedAt) },
      }, pylonId, budget).ended, delay(budget, null, { ref: false })]);
      if (status?.state === "succeeded") return { pylonId, pausedInMs: Date.now() - pausing };
      const failed = status?.state === "failed" && status.code !== "deadline" ? status.message : outOfTime;
      record.set(pylonId, { failed });
      await save(record);
      return { pylonId, failed };
    }));
    // close() destroys the observe streams at once, which would drop the snapshot that shows the pylons paused.
    await Promise.race([flushed(), delay(observerFlushMs, undefined, { ref: false })]);
    return outcomes;
  }

  let drained: Promise<readonly DrainOutcome[]> | undefined;
  return {
    draining: draining.signal,
    forget,
    listed(present) { for (const id of last.keys()) if (!present.has(id)) forget(id); },
    marked: (observed) => afterShutdown(observed, last.get(observed.pylonId)),
    drain: (withinMs, deps) => drained ??= drain(withinMs, deps),
    saved: () => saves.run(async () => {}),
  };
}

/** `failed`: why the shutdown's pause of the pylon did not finish. */
export interface ShutdownEntry { failed?: string }
export type ShutdownRecord = Map<PylonId, ShutdownEntry>;

const recordSchema = z.strictObject({
  pylons: z.record(pylonIdSchema.pipe(z.custom<PylonId>()), z.strictObject({ failed: nonEmpty.optional() })),
});

/** The record at `path`, empty when there is none. A file that is not one is refused, naming what is wrong. */
export async function readShutdownRecord(path: string): Promise<ShutdownRecord> {
  try {
    const { pylons } = parse(recordSchema, await readJson(path, { pylons: {} }), "record");
    return new Map(Object.entries(pylons) as [PylonId, ShutdownEntry][]);
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

export function saveShutdownRecord(path: string, record: ShutdownRecord): Promise<void> {
  return saveJson(path, { pylons: Object.fromEntries(record) }, { mkdir: true });
}

/**
 * The pylon as a probe started on the record reports it. One the shutdown found running that is stopped or broken now
 * is marked for a wake, and a broken one's detail says first that the shutdown did not finish pausing it.
 */
function afterShutdown(observed: PylonObservation, entry: ShutdownEntry | undefined): PylonObservation {
  if (entry === undefined) return observed;
  switch (observed.phase) {
    case "stopped": return { ...observed, wakeAfterBoot: true };
    case "broken": {
      const why = entry.failed === undefined ? "" : `: ${entry.failed}`;
      return { ...observed, wakeAfterBoot: true, detail: `The node's last shutdown did not finish pausing it${why}. ${observed.detail}` };
    }
    default: return observed;
  }
}
