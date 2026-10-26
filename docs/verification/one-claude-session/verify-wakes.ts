/**
 * Starts a Claude worker with the real openSession, then pauses and wakes its Herdr server three times. A pause
 * records the sessions and SIGKILLs every process in this mount namespace but the driver, as a pylon pause stops its
 * VM, once Herdr has saved its layout, so the wake restores it. A wake runs the real relaunchSessions, and a message sent with the real sendToClaude as soon as Herdr answers,
 * as the inbox does once the probe reports the pylon running. After each wake it counts the `claude` processes that
 * run the worker's session. Run it through sandbox.sh, never in a pylon's own home.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Guest } from "./src/backend.ts";
import type { PylonId } from "./src/protocol.ts";
import * as wakes from "./src/session-wake.ts";
import { checkoutDir, herdrSession, openSession, recordSessions, relaunchSessions, sendToClaude, sessionFacts } from "./src/sessions.ts";

/**
 * As the probe runs them: a send under its per-session lock and the wake's relaunch. Before the fix, main's relaunch took
 * no lock and its sends' lock lived in the probe, so the two ran side by side, as they do here without `onePerClaudeSession`.
 */
const pylonId = "pylon-verify" as PylonId;
const lock = (wakes as Partial<{ onePerClaudeSession: <T>(p: PylonId, s: readonly string[], w: () => Promise<T>) => Promise<T> }>).onePerClaudeSession;
const relaunchWake = (): ReturnType<typeof relaunchSessions> => lock ? (wakes.relaunchAfterWake as unknown as (p: PylonId, g: Guest, l: (line: string) => Promise<void>) => ReturnType<typeof relaunchSessions>)(pylonId, guest, async (line) => log(line)) : relaunchSessions(guest);
const sendLocked = <T>(work: () => Promise<T>) => lock ? lock(pylonId, [session], work) : work();

const guest: Guest = {
  exec: (argv, opts) => new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { cwd: opts.cwd, timeout: opts.timeoutMs }, (err, stdout, stderr) => {
      const killed = err !== null && "killed" in err && err.killed;
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 127;
      resolve({ exitCode: killed ? null : code, output: stdout + stderr, truncated: false });
    });
  }),
  async writeFiles(files) {
    for (const f of files) {
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.content, { mode: f.mode });
    }
  },
  stream: () => Promise.reject(new Error("unused")),
  services: () => Promise.reject(new Error("unused")),
  startService: () => Promise.reject(new Error("unused")),
  linkPort: () => Promise.reject(new Error("unused")),
  unlinkPort: () => Promise.reject(new Error("unused")),
  previewOrigin: () => { throw new Error("unused"); },
};

const label = process.argv[2] ?? "run";
const session = randomUUID();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const at = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`${at()} ${line}`);
const herdr = (...args: string[]) => guest.exec(["herdr", "--session", herdrSession, ...args], { cwd: "/home/user", timeoutMs: 10_000 });

function processes(): { pid: number; ppid: number; argv: string[]; mnt: string | null }[] {
  return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).flatMap((d) => {
    try {
      const argv = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").slice(0, -1);
      const ppid = Number(readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1]!.split(" ")[1]);
      let mnt: string | null = null;
      try { mnt = readlinkSync(`/proc/${d}/ns/mnt`); } catch {}
      return [{ pid: Number(d), ppid, argv, mnt }];
    } catch { return []; }
  });
}

/** Every `claude` process whose command line names the worker's session. */
const claudes = () => processes().filter((p) => p.argv[0]?.split("/").at(-1) === "claude" && p.argv.includes(session));

async function workspaces(): Promise<string[]> {
  const { output } = await herdr("workspace", "list");
  const reply = JSON.parse(output.trim().split("\n").findLast((l) => l.startsWith("{"))!);
  return reply.result.workspaces.map((w: { workspace_id: string; label: string }) => `${w.workspace_id}=${JSON.stringify(w.label)}`);
}

async function count(when: string): Promise<number> {
  const found = claudes();
  log(`${when}: ${found.length} claude process(es) run session ${session.slice(0, 8)}: ${found.map((p) => p.pid).join(", ")}`);
  log(`${when}: workspaces ${(await workspaces()).join(" ")}`);
  return found.length;
}

/** What a pylon pause does to its guest: every process stops, and only the disk stays. */
function pause(): void {
  const mine = readlinkSync("/proc/self/ns/mnt");
  const all = processes();
  const keep = new Set<number>();
  for (let pid = process.pid; pid > 1; pid = all.find((p) => p.pid === pid)?.ppid ?? 1) keep.add(pid);
  const killed = all.filter((p) => p.mnt === mine && !keep.has(p.pid));
  for (const p of killed) try { process.kill(p.pid, "SIGKILL"); } catch {}
  log(`pause: SIGKILLed ${killed.length} process(es), Herdr server and claude included`);
}

async function serverUp(): Promise<void> {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(50)) if ((await herdr("workspace", "list")).exitCode === 0) return;
  throw new Error("Herdr did not come up");
}

async function settle(): Promise<void> {
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(1000)) {
    const facts = await sessionFacts(guest);
    if (facts.every((f) => f.status === "idle" || f.status === "done")) return;
  }
  log("settle: some pane was still not idle after 90 s");
}

log(`${label}: worker session ${session}`);
const pane = await openSession(guest, { harness: "claude-code", title: "Fix the login page", cwd: checkoutDir, resume: session, prompt: "Reply with the single word ready, and do nothing else." });
log(`launch: the worker runs in ${pane}`);
await settle();
const counts = [await count("after launch")];

for (let wake = 1; wake <= 3; wake++) {
  // Herdr saves its layout a few seconds after a change, and a pylon runs for minutes before it pauses.
  await sleep(15_000);
  const recorded = await recordSessions(guest);
  log(`wake ${wake}: recorded ${JSON.stringify(recorded?.map((r) => [r.herdrPane, r.title, r.harnessSessionId?.slice(0, 8)]))}`);
  pause();
  await sleep(1000);
  const relaunch = relaunchWake();
  const send = serverUp().then(async () => {
    log(`wake ${wake}: Herdr answers; the message goes now. Panes: ${JSON.stringify((await sessionFacts(guest)).map((f) => [f.herdrPane, f.title, f.harness, f.harnessSessionId?.slice(0, 8) ?? null, f.status]))}`);
    return sendLocked(() => sendToClaude(guest, { session, text: `This is wake ${wake}. Reply with the single word ok, and do nothing else.` }));
  });
  const [relaunched, sent] = await Promise.allSettled([relaunch, send]);
  log(`wake ${wake}: relaunch ${relaunched.status === "fulfilled" ? JSON.stringify(relaunched.value.map((o) => [o.record.title, o.result, o.herdrPane])) : relaunched.reason}`);
  log(`wake ${wake}: send ${sent.status === "fulfilled" ? JSON.stringify(sent.value) : sent.reason}`);
  await settle();
  counts.push(await count(`after wake ${wake}`));
}

log(`${label}: claude processes for the worker's session after launch and each wake: ${counts.join(" ")}`);
pause();
process.exit(counts.every((c) => c === 1) ? 0 : 1);
