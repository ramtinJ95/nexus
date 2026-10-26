import { mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";

export const heartbeatIntervalMs = 5 * 60_000;
/**
 * Nothing tells a dev server from finite work, so a command still running after this ends its turn anyway, and the
 * session waits with backgroundStillRunning, so the person sees it rather than a normal reply.
 */
export const backgroundShellCapMs = 2 * 60 * 60_000;
export const backgroundStillRunning = "A background command was still running after 2 hours";
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

type HeldReport = (kind: "session.heartbeat" | "session.turn-ended" | "session.waiting", message?: string) => void;

/**
 * Run detached after a Stop, and given up for a newer Stop's hold of the same session. Every report carries the
 * Stop's stamp, so heartbeats renew the lease by their receipt time, and any newer report for the session, such as the
 * turn a command's finish starts, makes the rest stale.
 */
export async function holdTurnEnd(
  { running, superseded, report }: { running: () => Promise<boolean>; superseded: () => Promise<boolean>; report: HeldReport },
  { now = Date.now, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = {},
): Promise<void> {
  const start = now();
  let beat = start;
  while (await running()) {
    if (now() - start >= backgroundShellCapMs) {
      report("session.turn-ended", backgroundStillRunning);
      report("session.waiting", backgroundStillRunning);
      return;
    }
    await sleep(60_000);
    if (await superseded()) return;
    if (now() - beat >= heartbeatIntervalMs) { beat = now(); report("session.heartbeat"); }
  }
  await sleep(settleMs);
  if (!await superseded()) report("session.turn-ended");
}

type Proc = { pid: number; ppid: number; pgid: number };

async function processes(proc: string): Promise<Proc[]> {
  const stats = await Promise.all((await readdir(proc)).filter((name) => /^\d+$/.test(name)).map((pid) => readFile(`${proc}/${pid}/stat`, "utf8").catch(() => "")));
  return stats.flatMap((stat) => {
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return stat === "" ? [] : [{ pid: Number(stat.slice(0, stat.indexOf(" "))), ppid: Number(fields[1]), pgid: Number(fields[2]) }];
  });
}

/**
 * The process groups of a Claude's background commands. Claude Code starts each Bash command as a child that leads a
 * group of its own, which a command keeps through exec or closed output. Its stdio MCP servers stay in Claude's own
 * group. The calling hook's group is left out.
 */
export async function backgroundGroups(claudePid: number, proc = "/proc", self = process.pid): Promise<number[]> {
  const all = await processes(proc);
  const own = (pid: number) => all.find((p) => p.pid === pid)?.pgid;
  return all.filter((p) => p.ppid === claudePid && p.pid === p.pgid && p.pgid !== own(claudePid) && p.pgid !== own(self)).map((p) => p.pgid);
}

/**
 * Whether one of the groups still has a process, or, for a command that left its group, a process still writes to one
 * of the shells' output files, which Claude Code gives the command as stdout and stderr.
 */
export async function backgroundRunning(session: string, shells: readonly string[], groups: readonly number[], proc = "/proc"): Promise<boolean> {
  const all = await processes(proc);
  if (all.some((p) => groups.includes(p.pgid))) return true;
  const outputs = shells.map((id) => `/${session}/tasks/${id}.output`);
  for (const { pid } of all) {
    for (const fd of ["1", "2"]) {
      const target = await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => "");
      if (outputs.some((output) => target.endsWith(output))) return true;
    }
  }
  return false;
}

/**
 * Whether a Claude reports into the thread: one Nexus started, under the pylon user's own HOME. Claude Code puts
 * CLAUDE_CODE_SESSION_ID in the environment of everything it runs, so a Claude whose process started with it runs
 * inside another session, such as one a worker starts to verify its work.
 */
export function reportsIntoThread(env: NodeJS.ProcessEnv, claudeEnviron: string, home: string): boolean {
  return env.HOME === home && !claudeEnviron.split("\0").some((variable) => variable.startsWith("CLAUDE_CODE_SESSION_ID="));
}

/** The environment the Claude running a hook started with, which CLAUDE_PID names, or nothing when it is not known. */
export async function claudeEnviron(pid: string | undefined, proc = "/proc"): Promise<string> {
  return pid === undefined ? "" : await readFile(`${proc}/${pid}/environ`, "utf8").catch(() => "");
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
