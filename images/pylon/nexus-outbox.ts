import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

export type OutboxEvent = { kind: string; at: number; session?: string; message?: string };
export type Outcome = "delivered" | "rejected" | "retry";

export const maxEntries = 1000;
export const maxAgeMs = 24 * 60 * 60_000;
export const defaultDir = join(homedir(), ".nexus", "outbox");

async function entries(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
  return names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
}

export async function enqueue(event: OutboxEvent, dir = defaultDir): Promise<void> {
  const name = `${String(event.at).padStart(16, "0")}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `.${name}`), JSON.stringify(event));
  await rename(join(dir, `.${name}`), join(dir, name));
  const names = await entries(dir);
  // Dropping the oldest keeps the newest state, such as the latest turn end.
  for (const old of names.slice(0, Math.max(0, names.length - maxEntries))) await rm(join(dir, old), { force: true });
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
  let names: string[] = [];
  for (;;) {
    if (names.length === 0) names = await entries(dir);
    const [name] = names;
    if (name === undefined) return;
    const path = join(dir, name);
    const event: Partial<OutboxEvent> | null = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
    if (typeof event?.kind === "string" && typeof event.at === "number" && Date.now() - event.at <= maxAgeMs) {
      if (await post(event as OutboxEvent) === "retry") {
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10_000);
        continue;
      }
      backoffMs = 500;
    }
    await rm(path, { force: true });
    names.shift();
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
  return new Promise((resolve) => {
    server.once("error", () => resolve(null));
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
