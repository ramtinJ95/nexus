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

/** Resolves once the report is in the outbox, so the turn end at the cap is delivered before the waiting that follows it. */
type HeldReport = (kind: "session.heartbeat" | "session.turn-ended" | "session.waiting", message?: string) => Promise<void>;

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
      await report("session.turn-ended", backgroundStillRunning);
      await report("session.waiting", backgroundStillRunning);
      return;
    }
    await sleep(60_000);
    if (await superseded()) return;
    if (now() - beat >= heartbeatIntervalMs) { beat = now(); await report("session.heartbeat"); }
  }
  await sleep(settleMs);
  if (!await superseded()) await report("session.turn-ended");
}

/**
 * Makes this hold the session's, unless a hold for a newer Stop already is: holds start in any order, and only the
 * newest Stop's reports are not stale. Answers whether it did.
 */
export async function claimHold(path: string, stamp: number, pid: number): Promise<boolean> {
  for (let tries = 0; tries < 200; tries++) {
    const claimed = await locked(path, async () => {
      const [owner] = (await readFile(path, "utf8").catch(() => "0")).split(" ");
      if (Number(owner) >= stamp) return false;
      await writeFile(path, `${stamp} ${pid}`);
      return true;
    });
    if (claimed !== undefined) return claimed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** Gives the session up at the end, unless a newer hold has claimed it. */
export async function releaseHold(path: string, stamp: number, pid: number): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    const released = await locked(path, async () => {
      if (!await holdSuperseded(path, stamp, pid)) await rm(path, { force: true });
      return true;
    });
    if (released) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Whether another hold has claimed the session since this one did. */
export async function holdSuperseded(path: string, stamp: number, pid: number): Promise<boolean> {
  return await readFile(path, "utf8").catch(() => "") !== `${stamp} ${pid}`;
}

type Proc = { pid: number; ppid: number; pgid: number; start: number };
/** A process group, with its leader's start time, so a later group that reuses the ID is not taken for it. */
export type Group = { pgid: number; start: number };

async function processes(proc: string): Promise<Proc[]> {
  const stats = await Promise.all((await readdir(proc)).filter((name) => /^\d+$/.test(name)).map((pid) => readFile(`${proc}/${pid}/stat`, "utf8").catch(() => "")));
  return stats.flatMap((stat) => {
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return stat === "" ? [] : [{ pid: Number(stat.slice(0, stat.indexOf(" "))), ppid: Number(fields[1]), pgid: Number(fields[2]), start: Number(fields[19]) }];
  });
}

/**
 * The process groups of a Claude's background commands. Claude Code starts each Bash command as a child that leads a
 * group of its own, which a command keeps through exec or closed output. Its stdio MCP servers stay in Claude's own
 * group. The calling hook's group is left out.
 */
export async function backgroundGroups(claudePid: number, proc = "/proc", self = process.pid): Promise<Group[]> {
  const all = await processes(proc);
  const own = (pid: number) => all.find((p) => p.pid === pid)?.pgid;
  return all.filter((p) => p.ppid === claudePid && p.pid === p.pgid && p.pgid !== own(claudePid) && p.pgid !== own(self)).map(({ pgid, start }) => ({ pgid, start }));
}

/**
 * Polls whether one of the groups still has a process, or, for a command that left its group, a process still writes
 * to one of the shells' output files, which Claude Code gives the command as stdout and stderr. `since` is when the
 * hold started, in the clock ticks of /proc's start times, and defaults to the calling process's own start.
 */
export function backgroundWatch(session: string, shells: readonly string[], groups: readonly Group[], { proc = "/proc", since }: { proc?: string; since?: number } = {}): () => Promise<boolean> {
  const outputs = shells.map((id) => `/${session}/tasks/${id}.output`);
  // The original members of each group seen so far, as pid@start.
  const known = new Map(groups.map((g) => [g.pgid, new Set([`${g.pgid}@${g.start}`])]));
  let started = since;
  return async () => {
    started ??= Number((await readFile(`${proc}/self/stat`, "utf8").catch(() => "")).split(") ").at(-1)?.split(" ")[19] ?? 0);
    const all = await processes(proc);
    // The kernel reuses no ID while its group has a process. So a leader that started at another time leads another
    // group, and without its leader the group is the original only while a member already known to be in it lives,
    // or one that started before the hold did, when the recorded group still existed.
    const lives = ({ pgid, start }: Group) => {
      const members = all.filter((p) => p.pgid === pgid);
      const leader = all.find((p) => p.pid === pgid);
      const seen = known.get(pgid)!;
      const original = leader !== undefined
        ? leader.pgid === pgid && leader.start === start
        : members.some((p) => seen.has(`${p.pid}@${p.start}`) || p.start <= started!);
      if (original) for (const p of members) seen.add(`${p.pid}@${p.start}`);
      return original;
    };
    if (groups.filter(lives).length > 0) return true;
    for (const { pid } of all) {
      for (const fd of ["1", "2"]) {
        const target = await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => "");
        if (outputs.some((output) => target.endsWith(output))) return true;
      }
    }
    return false;
  };
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
  return await locked(path, async () => {
    const previous = Number(await readFile(path, "utf8").catch(() => "0"));
    if (now - previous < heartbeatIntervalMs) return false;
    await writeFile(path, String(now));
    return true;
  }, now) ?? false;
}

/** Runs `critical` under the path's lock, or answers undefined while another process holds it. */
async function locked<T>(path: string, critical: () => Promise<T>, now = Date.now()): Promise<T | undefined> {
  const lock = `${path}.lock`;
  const held = await stat(lock).catch(() => null);
  // Claude kills a hook after two seconds; a minute-old lock belongs to an interrupted hook.
  if (held !== null && now - held.mtimeMs > 60_000) await rm(lock, { recursive: true, force: true });
  try { await mkdir(lock); } catch { return undefined; }
  try { return await critical(); } finally { await rm(lock, { recursive: true, force: true }); }
}
