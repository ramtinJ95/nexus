import { mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";

export const heartbeatIntervalMs = 5 * 60_000;
/** Long enough for a slow build or test suite, while a dev server's turn still ends within the hour. */
export const backgroundShellCapMs = 60 * 60_000;
/** Claude submits a finished command's notification within a second; its turn start then makes the held end stale. */
const settleMs = 30_000;

/**
 * The kind a hook reports, and the background shells a turn end waits for. Claude's Stop hook also runs when the main
 * turn ends with background tasks still running, and Claude starts a new turn as each one finishes, so such a turn
 * end only proves activity. A shell may be a dev server that never finishes, so while only shells run, holdTurnEnd
 * keeps the turn working until they exit or the cap passes.
 */
export function reportedKind(kind: string, input: { background_tasks?: unknown }): { kind: string; shells?: string[] } {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks as { id?: unknown; type?: unknown; status?: unknown }[] : [];
  const running = (type: string) => tasks.filter((t) => t?.type === type && t.status === "running");
  if (kind !== "session.turn-ended") return { kind };
  if (running("subagent").length > 0) return { kind: "session.heartbeat" };
  const shells = running("shell").flatMap((t) => typeof t.id === "string" && /^\w+$/.test(t.id) ? [t.id] : []);
  return shells.length > 0 ? { kind: "session.heartbeat", shells } : { kind };
}

/**
 * Run detached after a Stop. Every report carries the Stop's stamp, so heartbeats renew the lease by their receipt
 * time, and any newer report for the session, such as the turn a command's finish starts, makes the rest stale.
 */
export async function holdTurnEnd(
  running: () => Promise<boolean>, report: (kind: "session.heartbeat" | "session.turn-ended") => void,
  { now = Date.now, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = {},
): Promise<void> {
  const start = now();
  for (let beat = start; await running() && now() - start < backgroundShellCapMs;) {
    await sleep(60_000);
    if (now() - beat >= heartbeatIntervalMs) { beat = now(); report("session.heartbeat"); }
  }
  await sleep(settleMs);
  report("session.turn-ended");
}

/** Whether a process still writes to one of these background shells' output files, the command's stdout and stderr. */
export async function shellsRunning(session: string, shells: readonly string[], proc = "/proc"): Promise<boolean> {
  const outputs = shells.map((id) => `/${session}/tasks/${id}.output`);
  for (const pid of (await readdir(proc)).filter((name) => /^\d+$/.test(name))) {
    for (const fd of ["1", "2"]) {
      const target = await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => "");
      if (outputs.some((output) => target.endsWith(output))) return true;
    }
  }
  return false;
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
