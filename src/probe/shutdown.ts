/**
 * What a node's clean shutdown or reboot leaves for its next boot. Only then does the probe pause every running pylon
 * before it exits (Probe.drain): any other stop, such as a deploy's `systemctl restart`, leaves them running.
 *
 * The record names each pylon the shutdown found running, and why its pause did not finish when it did not. The probe
 * of the next boot loads it and marks those pylons for a wake, so the control plane brings them back as they were.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { PylonId } from "../ids.ts";
import { readJson, saveJson } from "../json-file.ts";
import { nonEmpty, parse } from "../parse.ts";
import { pylonIdSchema } from "../protocol/fields.ts";
import type { PylonObservation } from "../protocol/observations.ts";

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
  return saveJson(path, { pylons: Object.fromEntries(record) });
}

/**
 * The pylon as a probe started on the record reports it. One the shutdown found running that is stopped or broken now
 * is marked for a wake, and a broken one's detail says first that the shutdown did not finish pausing it.
 */
export function afterShutdown(observed: PylonObservation, entry: ShutdownEntry | undefined): PylonObservation {
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
