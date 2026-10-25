import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

export const heartbeatIntervalMs = 5 * 60_000;

/**
 * The kind a hook reports. Claude's Stop hook also runs when the main turn ends with background subagents still
 * running, and Claude starts a new turn as each one finishes, so such a turn end only proves activity. Background
 * shells do not count: a dev server would keep the session working until its lease ran out.
 */
export function reportedKind(kind: string, input: { background_tasks?: unknown }): string {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks as { type?: unknown; status?: unknown }[] : [];
  return kind === "session.turn-ended" && tasks.some((t) => t?.type === "subagent" && t.status === "running") ? "session.heartbeat" : kind;
}

/** A lock covers the timestamp check too, so parallel tool hooks cannot all report at once. */
export async function heartbeatDue(path: string, now = Date.now()): Promise<boolean> {
  const lock = `${path}.lock`;
  const held = await stat(lock).catch(() => null);
  // Claude kills a hook after two seconds; a minute-old lock belongs to an interrupted hook.
  if (held !== null && now - held.mtimeMs > 60_000) await rm(lock, { recursive: true, force: true });
  try { await mkdir(lock); } catch { return false; }
  try {
    const previous = Number(await readFile(path, "utf8").catch(() => "0"));
    if (now - previous < heartbeatIntervalMs) return false;
    await writeFile(path, String(now));
    return true;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
