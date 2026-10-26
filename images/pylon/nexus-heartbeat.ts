import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";

export const heartbeatIntervalMs = 5 * 60_000;
/** As long as Claude Code lets a foreground command run. */
export const backgroundShellGraceMs = 10 * 60_000;

/**
 * The kind a hook reports, and how long a turn end waits for background shells. Claude's Stop hook also runs when the
 * main turn ends with background tasks still running, and Claude starts a new turn as each one finishes, so such a
 * turn end only proves activity. A shell may be a dev server that never finishes, so while only shells run the turn
 * end is reported after the grace, stamped with the Stop's time: a turn Claude starts sooner makes it stale.
 */
export function reportedKind(kind: string, input: { background_tasks?: unknown }): { kind: string; endAfterMs?: number } {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks as { type?: unknown; status?: unknown }[] : [];
  const running = (type: string) => tasks.some((t) => t?.type === type && t.status === "running");
  if (kind !== "session.turn-ended") return { kind };
  if (running("subagent")) return { kind: "session.heartbeat" };
  return running("shell") ? { kind: "session.heartbeat", endAfterMs: backgroundShellGraceMs } : { kind };
}

/**
 * Whether the Claude running this hook is one Nexus started, under the pylon user's own HOME. Claude Code puts
 * CLAUDE_CODE_SESSION_ID in the environment of everything it runs, so a Claude started with it runs inside another
 * session, such as one a worker starts to verify its work. CLAUDE_PID names the Claude running the hook.
 */
export async function reportsIntoThread(env: NodeJS.ProcessEnv = process.env, home = userInfo().homedir): Promise<boolean> {
  if (env.HOME !== home) return false;
  const environ = await readFile(`/proc/${env.CLAUDE_PID}/environ`, "utf8").catch(() => "");
  return !environ.split("\0").some((variable) => variable.startsWith("CLAUDE_CODE_SESSION_ID="));
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
