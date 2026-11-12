/**
 * The session half of a pause and a wake, for every backend. Neither step fails its job: a pylon that
 * cannot pause stays up and holds its memory, and a wake whose sessions do not come back is still a
 * running pylon with its disk. Each outcome is one `sessions:` line in the pylon's own log instead, and the
 * sessions file keeps every session the relaunch did not bring back (`failed` in sessions.ts), so the next
 * pause records it again and the next wake retries it.
 */
import type { Guest } from "../../backends/backend.ts";
import type { PylonId } from "../../ids.ts";
import type { PausedSession } from "../../protocol/observations.ts";
import { recordSessions, relaunchSessions, toPaused, type ClaudeSessionLock, type RelaunchOutcome } from "./sessions.ts";
import { agentKinds } from "../../protocol/agent-kinds.ts";

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
  await log(recorded === null ? "sessions: no Herdr Core runs, so the last record stands" : `sessions: recorded ${recorded.length} for the wake`);
  return recorded?.map(toPaused) ?? null;
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
 * because its sessions never came back and the core would record none. So does a guest whose sessions cannot be recorded.
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
 * wake's relaunch, which holds every Claude session it brings back. Each finds the terminal the call before it left the
 * session in, so none starts the session in a second terminal. Two sends never interleave in its prompt, and
 * a launch sent again while the first still runs, as when the control plane lost its answer, waits for it and then
 * finds the terminal it started.
 */
export const claudeSessionLock = claudeSessionLocks();

/** One owner of every pylon's Claude calls, because the command route and both backends' wakes reach the same lock. */
function claudeSessionLocks(): (pylonId: PylonId) => ClaudeSessionLock {
  const calls = new Map<string, Promise<unknown>>();
  return (pylonId) => (sessions, work) => {
    const keys = [...new Set(sessions)].map((session) => `${pylonId}:${session}`);
    const next = Promise.all(keys.map((key) => calls.get(key))).then(work);
    const settled = next.catch(() => undefined);
    for (const key of keys) calls.set(key, settled);
    void settled.then(() => { for (const key of keys) if (calls.get(key) === settled) calls.delete(key); });
    return next;
  };
}

/**
 * After a boot from an existing disk. Returns the outcomes, also logged. A sessions file that cannot be read or
 * written is an empty list, and the file stays as it was.
 */
export async function relaunchAfterWake(pylonId: PylonId, guest: Guest, log: PylonLog): Promise<readonly RelaunchOutcome[]> {
  let outcomes: readonly RelaunchOutcome[];
  try {
    outcomes = await relaunchSessions(guest, claudeSessionLock(pylonId));
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
    case "present": return `sessions: ${session} was already running in ${o.terminal}`;
    case "resumed-in-place": return `sessions: resumed ${session} in place in ${o.terminal}`;
    case "relaunched": return `sessions: relaunched ${session} in ${o.terminal}${o.notInPlace === null ? "" : `, not in place at ${o.record.terminal}, because ${o.notInPlace}`}`;
    case "failed": return `sessions: ${session} did not come back${o.terminal === null ? "" : `, and its terminal ${o.terminal} stays open`}: ${o.message}`;
    case "dropped": return `sessions: dropped ${session}, a second record of ${agentKinds[o.record.harness].label} session ${o.record.harnessSessionId}${o.terminal === null ? "" : `, and closed its terminal ${o.terminal}`}`;
  }
}
