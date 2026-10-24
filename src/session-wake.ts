/**
 * The session half of a pause and a wake, for every backend. Neither step fails its job: a pylon that
 * cannot pause stays up and holds its memory, and a wake whose sessions do not come back is still a
 * running pylon with its disk. Each outcome is one `sessions:` line in the pylon's own log instead, and the
 * sessions file keeps every session the relaunch did not bring back (`failed` in sessions.ts), so the next
 * pause records it again and the next wake retries it.
 */
import type { Guest } from "./backend.ts";
import type { PausedSession } from "./protocol.ts";
import { recordSessions, relaunchSessions, type RelaunchOutcome } from "./sessions.ts";

/** Appends one line to the pylon's log: the controller log of a pylon VM, the container log under Docker. */
export type PylonLog = (line: string) => Promise<void>;

/**
 * Before the checkpoint, while the guest still runs. Returns what the wake brings back, for the backend to keep beside
 * the checkpoint, or null when nothing was recorded and only the checkpoint knows.
 */
export async function recordBeforePause(guest: Guest, log: PylonLog): Promise<readonly PausedSession[] | null> {
  let recorded: Awaited<ReturnType<typeof recordSessions>>;
  try {
    recorded = await recordSessions(guest);
  } catch (err) {
    await log(`sessions: recording failed, so the wake relaunches what the last record holds: ${(err as Error).message}`);
    return null;
  }
  await log(recorded === null ? "sessions: no Herdr server runs, so the last record stands" : `sessions: recorded ${recorded.length} for the wake`);
  return recorded?.map(({ id, herdrPane, harness, harnessSessionId, title }) => ({ id, herdrPane, harness, harnessSessionId, title })) ?? null;
}

/**
 * After a boot from an existing disk. Returns the outcomes, also logged. A sessions file that cannot be read or
 * written is an empty list, and the file stays as it was.
 */
export async function relaunchAfterWake(guest: Guest, log: PylonLog): Promise<readonly RelaunchOutcome[]> {
  let outcomes: readonly RelaunchOutcome[];
  try {
    outcomes = await relaunchSessions(guest);
  } catch (err) {
    await log(`sessions: the relaunch failed, and the sessions file keeps every session for the next wake: ${(err as Error).message}`);
    return [];
  }
  for (const o of outcomes) await log(outcomeLine(o));
  return outcomes;
}

function outcomeLine(o: RelaunchOutcome): string {
  const session = `${JSON.stringify(o.record.title)} (${o.record.harness})`;
  switch (o.result) {
    case "present": return `sessions: ${session} was already running in ${o.herdrPane}`;
    case "relaunched": return `sessions: relaunched ${session} in ${o.herdrPane}`;
    case "failed": return `sessions: ${session} did not come back${o.herdrPane === null ? "" : `, and its pane ${o.herdrPane} stays open`}: ${o.message}`;
  }
}
