/**
 * The logs of a pylon whose boot never finished, kept after its instance is removed, so a hung or failed boot can be
 * explained afterwards: the end of its controller log, which holds every boot hook's and setup's output, and of its serial
 * console. Each keep is one directory under the state root's kept-logs, named for the pylon and the time.
 */
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { existsError } from "../../pylon-vm/storage.ts";

/** At most this much of the end of each log, the newest this many keeps, and none older than this. */
export const keptLogBounds: { bytes: number; keeps: number; ageMs: number } = { bytes: 2 ** 20, keeps: 20, ageMs: 14 * 24 * 60 * 60_000 };

async function tail(file: string, bytes: number): Promise<Buffer | null> {
  const handle = await open(file, "r").catch((err: unknown) => existsError(err, "ENOENT") ? null : Promise.reject(err));
  if (handle === null) return null;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Keeps the end of each of `logs` that exists, with `why`, under `root`, then drops the keeps past the bounds. */
export async function keepLogs(root: string, pylonId: string, logs: readonly string[], why: string, now: number, bounds = keptLogBounds): Promise<string> {
  const dir = join(root, `${pylonId}-${new Date(now).toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "why.txt"), `${why}\n`, { mode: 0o600 });
  for (const log of logs) {
    const end = await tail(log, bounds.bytes);
    if (end !== null) await writeFile(join(dir, basename(log)), end, { mode: 0o600 });
  }
  await pruneKeptLogs(root, now, bounds);
  return dir;
}

/** Drops each keep older than the bounds' age, and the oldest past their count. */
export async function pruneKeptLogs(root: string, now: number, bounds = keptLogBounds): Promise<void> {
  const names = await readdir(root).catch((err: unknown) => existsError(err, "ENOENT") ? [] : Promise.reject(err));
  const keeps = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(root, name))).mtimeMs })));
  const newest = keeps.toSorted((a, b) => b.at - a.at);
  const dropped = newest.filter((k, i) => i >= bounds.keeps || now - k.at > bounds.ageMs);
  await Promise.all(dropped.map((k) => rm(join(root, k.name), { recursive: true, force: true })));
}
