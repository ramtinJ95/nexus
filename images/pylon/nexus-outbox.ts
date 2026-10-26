import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

export type OutboxEvent = { kind: string; at: number; session?: string; message?: string; id: string };
export type Outcome = "delivered" | "rejected" | "retry";

export const maxEntries = 1000;
export const maxAgeMs = 24 * 60 * 60_000;
/** install.ts gives each hook two seconds, so a hook stamped earlier than an event has written it or died by then. */
export const settleMs = 2000;
export const defaultDir = join(homedir(), ".nexus", "outbox");

async function entries(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
  return names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
}

export async function enqueue(event: Omit<OutboxEvent, "id">, dir = defaultDir): Promise<void> {
  const id = `${String(event.at).padStart(16, "0")}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const temp = join(dir, `.${id}.json`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(temp, JSON.stringify({ ...event, id }));
    await rename(temp, join(dir, `${id}.json`));
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  const names = await entries(dir);
  // Dropping the oldest keeps the newest state, such as the latest turn end.
  for (const old of names.slice(0, Math.max(0, names.length - maxEntries))) await rm(join(dir, old), { force: true });
  // A hook killed between its write and its rename leaves its temporary file behind.
  for (const name of (await readdir(dir)).filter((n) => n.startsWith("."))) {
    const written = await stat(join(dir, name)).catch(() => null);
    if (written !== null && Date.now() - written.mtimeMs > 60_000) await rm(join(dir, name), { force: true });
  }
}

export async function deliver(event: OutboxEvent): Promise<Outcome> {
  try {
    const res = await fetch(`${process.env.NEXUS_API || "http://nexus.pylon"}/v1/request`, {
      method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "event", ...event }),
    });
    await res.body?.cancel();
    if (res.status === 200) return "delivered";
    // A request the probe refuses would never succeed, and must not hold up the events behind it.
    return res.status >= 400 && res.status < 500 ? "rejected" : "retry";
  } catch {
    return "retry";
  }
}

export async function drain(dir = defaultDir, post = deliver, sleep: (ms: number) => Promise<unknown> = wait): Promise<void> {
  let backoffMs = 500;
  for (;;) {
    // Listed again each time, because a hook stamped earlier than the last event may have written since.
    const [name] = await entries(dir);
    if (name === undefined) return;
    const path = join(dir, name);
    const event: Partial<OutboxEvent> | null = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
    if (typeof event?.kind === "string" && typeof event.at === "number" && typeof event.id === "string" && Date.now() - event.at <= maxAgeMs) {
      const unsettled = event.at + settleMs - Date.now();
      // A stamp further ahead than that is a clock that moved back, and waiting for it would stall the outbox.
      if (unsettled > 0 && unsettled <= settleMs) {
        await sleep(unsettled);
        continue;
      }
      if (await post(event as OutboxEvent) === "retry") {
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10_000);
        continue;
      }
      backoffMs = 500;
    }
    await rm(path, { force: true });
  }
}

export function startSender(): void {
  const child = spawn(process.execPath, [import.meta.filename], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/** Listens on an abstract socket, which the kernel frees when the process dies, so no stale lock survives a crash. */
function lock(dir: string): Promise<Server | null> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => err.code === "EADDRINUSE" ? resolve(null) : reject(err));
    server.listen(`\0nexus-outbox-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`, () => resolve(server));
  });
}

if (import.meta.main) {
  for (;;) {
    const server = await lock(defaultDir);
    if (server === null) break;
    await drain();
    await new Promise((resolve) => server.close(resolve));
    // A hook that wrote after the drain saw the spool empty may have lost the lock to this sender.
    if ((await entries(defaultDir)).length === 0) break;
  }
}
