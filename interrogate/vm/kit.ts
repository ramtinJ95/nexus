/**
 * Drives Nexus's real pylon-vm client and per-VM controller (src/pylon-vm/client.ts -> daemon.ts -> runtime.ts ->
 * Gondolin 0.13.0 -> QEMU) from inside the worktree. The state root is relative ("st"), run from interrogate/vm, so
 * the controller's socket path stays under sun_path's limit. Gondolin's guest image cache is interrogate/vm/cache.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { run } from "../../src/pylon-vm/client.ts";

export const root = "/tmp/nx-a1f"; // a symlink to interrogate/vm/st, for sun_path
export const boot = (memoryGiB: number, cpus = 2, allowedHosts: string[] = ["example.com"]) => ({
  resources: { cpus, memoryGiB }, allowedHosts, secrets: {}, ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null,
});
export const config = (image?: string) => ({ diskGiB: 4, ...(image ? { image } : {}) });

export async function create(name: string, memoryGiB: number, image?: string) {
  const t0 = performance.now();
  const reply = await run(root, { action: "create", name, config: config(image), boot: boot(memoryGiB), labels: {} } as never, AbortSignal.timeout(600_000));
  return { ms: performance.now() - t0, reply };
}
export async function start(name: string, memoryGiB: number) {
  const t0 = performance.now();
  // A stop returns while its controller is still exiting, and start refuses until it is gone: retry that refusal only.
  for (let tries = 0; ; tries++) {
    try {
      const reply = await run(root, { action: "start", name, boot: boot(memoryGiB) } as never, AbortSignal.timeout(600_000));
      return { ms: performance.now() - t0, reply, retries: tries };
    } catch (e) {
      if (!/still starting or unavailable/.test(String(e)) || tries > 60) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
export const exec = (name: string, cmd: string, timeoutMs = 60_000) => run(root, { action: "exec", name, cmd, timeoutMs } as never, AbortSignal.timeout(timeoutMs + 30_000)) as Promise<any>;
export const execStatus = (name: string, pid: string, timeoutMs = 10_000) => run(root, { action: "exec-status", name, pid, timeoutMs } as never, AbortSignal.timeout(timeoutMs + 30_000)) as Promise<any>;
export const inspect = (name: string) => run(root, { action: "inspect", name } as never) as Promise<any>;
export const stop = (name: string) => run(root, { action: "stop", name } as never, AbortSignal.timeout(300_000)) as Promise<any>;
export const destroy = (name: string) => run(root, { action: "destroy", name, confirm: name } as never, AbortSignal.timeout(300_000)) as Promise<any>;

/** The controller's PID from its controller.pid, and the QEMU PID whose command line names the controller's session label. */
export function pids(name: string): { controller: number | null; qemu: number | null } {
  let controller: number | null = null;
  try {
    const raw = readFileSync(`${root}/instances/${name}/controller.pid`, "utf8");
    controller = Number(JSON.parse(raw).pid ?? raw.trim());
  } catch {}
  let qemu: number | null = null;
  if (controller !== null) {
    try {
      const kids = execFileSync("pgrep", ["-P", String(controller)], { encoding: "utf8" }).trim().split("\n").map(Number);
      for (const k of kids) {
        const comm = readFileSync(`/proc/${k}/comm`, "utf8").trim();
        if (comm.startsWith("qemu")) qemu = k;
      }
    } catch {}
  }
  return { controller, qemu };
}
export function rssMiB(pid: number | null): number | null {
  if (pid === null) return null;
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
}
/** utime+stime in seconds from /proc/<pid>/stat. */
export function cpuSeconds(pid: number | null): number | null {
  if (pid === null) return null;
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch { return null; }
}
export function availableMiB(): number {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  return Math.round(Number(m![1]) / 1024);
}
export const instances = () => { try { return readdirSync(`${root}/instances`).filter((n) => !n.startsWith(".")); } catch { return []; } };
/** Runs `cmd` to completion, following it with exec-status past the 60 s single-wait cap. */
export async function sh(name: string, cmd: string, totalMs = 600_000): Promise<{ exitCode: number | null; output: string; ms: number }> {
  const t0 = performance.now();
  let r = await exec(name, cmd, 60_000);
  let output = r.output ?? "";
  while (r.running && performance.now() - t0 < totalMs) {
    r = await execStatus(name, r.pid, 60_000);
    const next = r.output ?? "";
    output = next.startsWith(output) ? next : output + next;
  }
  return { exitCode: r.exitCode ?? null, output, ms: Math.round(performance.now() - t0) };
}
export function bootWith(name: string, memoryGiB: number, image: string | undefined, allowedHosts: string[]) {
  return run(root, { action: "create", name, config: config(image), boot: boot(memoryGiB, 2, allowedHosts), labels: {} } as never, AbortSignal.timeout(600_000)) as Promise<any>;
}
export const controllerLog = (name: string, chars = 2500) => { try { return readFileSync(`${root}/instances/${name}/controller.log`, "utf8").slice(-chars); } catch (e) { return String(e); } };
export const otherQemu = () => { try { return execFileSync("pgrep", ["-a", "qemu"], { encoding: "utf8" }).trim().split("\n").map((l) => l.slice(0, 120)); } catch { return []; } };
