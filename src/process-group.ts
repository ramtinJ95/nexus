import { setTimeout as delay } from "node:timers/promises";
import { JobFailure } from "./protocol/jobs.ts";

const killGraceMs = 10_000;

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

/** Waits out the SIGTERM grace, then SIGKILLs what is left of the group and waits for that too. */
export async function reapGroup(pid: number, command: string, signal: (name: NodeJS.Signals | 0) => Promise<boolean> = async (name) => signalGroup(pid, name)): Promise<void> {
  const gone = async () => {
    for (const end = Date.now() + killGraceMs; Date.now() < end; await delay(100)) {
      if (!(await signal(0))) return true;
    }
    return false;
  };
  if (await gone()) return;
  await signal("SIGKILL");
  if (!(await gone())) throw new JobFailure("backend", `processes that ${command} started outlived SIGKILL`);
}
