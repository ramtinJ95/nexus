import { setTimeout as delay } from "node:timers/promises";
import { JobFailure } from "./protocol/jobs.ts";

export const killGraceMs = 10_000;

/** False once no process is left in the group. */
export function signalGroup(pid: number, name: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, name);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

/** Waits out the SIGTERM grace, `graceMs`, then SIGKILLs what is left of the group and waits up to 10 s for that too. */
export async function reapGroup(pid: number, command: string, signal: (name: NodeJS.Signals | 0) => Promise<boolean> = async (name) => signalGroup(pid, name), graceMs = killGraceMs): Promise<void> {
  const gone = async (waitMs: number) => {
    for (const end = Date.now() + waitMs; Date.now() < end; await delay(100)) {
      if (!(await signal(0))) return true;
    }
    return false;
  };
  if (await gone(graceMs)) return;
  await signal("SIGKILL");
  if (!(await gone(killGraceMs))) throw new JobFailure("backend", `processes that ${command} started outlived SIGKILL`);
}
