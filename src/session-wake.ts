/**
 * The session half of a pause and a wake, for every backend. Neither step fails its job: a pylon that
 * cannot pause stays up and holds its memory, and a wake whose sessions do not come back is still a
 * running pylon with its disk. Each outcome is one `sessions:` line in the pylon's own log instead, and the
 * sessions file keeps every session the relaunch did not bring back (`failed` in sessions.ts), so the next
 * pause records it again and the next wake retries it.
 */
import type { Guest } from "./backend.ts";
import type { PausedSession, PylonId } from "./protocol.ts";
import { harnesses, recordSessions, relaunchSessions, type RelaunchOutcome } from "./sessions.ts";

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
 * Where a backend keeps whether a disk's sessions are still to be relaunched, and what its last pause recorded. Each
 * backend sets the mark itself, when its storage needs it: before a boot from an existing disk at the latest.
 */
export interface RelaunchMark {
  pending(): Promise<boolean>;
  clear(): Promise<void>;
  lastRecorded(): Promise<readonly PausedSession[] | null>;
}

/**
 * What a pause of a running guest keeps for its wake. A guest whose relaunch is still pending keeps the last record,
 * because its sessions never came back and Herdr would record none. So does a guest whose sessions cannot be recorded.
 */
export async function pauseSessions(guest: Guest, log: PylonLog, mark: RelaunchMark): Promise<readonly PausedSession[] | null> {
  if (await mark.pending()) return mark.lastRecorded();
  return await recordBeforePause(guest, log) ?? mark.lastRecorded();
}

/** After a spawn brings the guest up. `relaunch` false leaves a pending relaunch for a later spawn. */
export async function finishRelaunch(pylonId: PylonId, guest: Guest, log: PylonLog, mark: RelaunchMark, relaunch: boolean): Promise<void> {
  if (!relaunch || !await mark.pending()) return;
  await relaunchAfterWake(pylonId, guest, log);
  await mark.clear();
}

/**
 * Calls that start a Claude session or type into it run one at a time per pylon and session: a launch, a send, and a
 * wake's relaunch, which holds every Claude session it brings back. Each finds the pane the call before it left the
 * session in, so none starts the session in a second pane. Two sends never interleave their chunks in its prompt, and
 * a launch sent again while the first still runs, as when the control plane lost its answer, waits for it and then
 * reads how far it got.
 */
export function onePerClaudeSession<T>(pylonId: PylonId, sessions: readonly string[], work: () => Promise<T>): Promise<T> {
  const keys = [...new Set(sessions)].map((session) => `${pylonId}:${session}`);
  const next = Promise.all(keys.map((key) => claudeCalls.get(key))).then(work);
  const settled = next.catch(() => undefined);
  for (const key of keys) claudeCalls.set(key, settled);
  void settled.then(() => { for (const key of keys) if (claudeCalls.get(key) === settled) claudeCalls.delete(key); });
  return next;
}
const claudeCalls = new Map<string, Promise<unknown>>();

/**
 * After a boot from an existing disk. Returns the outcomes, also logged. A sessions file that cannot be read or
 * written is an empty list, and the file stays as it was.
 */
export async function relaunchAfterWake(pylonId: PylonId, guest: Guest, log: PylonLog): Promise<readonly RelaunchOutcome[]> {
  let outcomes: readonly RelaunchOutcome[];
  try {
    outcomes = await relaunchSessions(guest, (sessions, work) => onePerClaudeSession(pylonId, sessions, work));
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
    case "dropped": return `sessions: dropped ${session}, a second record of ${harnesses[o.record.harness].label} session ${o.record.harnessSessionId}${o.herdrPane === null ? "" : `, and closed its pane ${o.herdrPane}`}`;
  }
}
