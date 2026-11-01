/** The free space of the filesystems Nexus writes to on a node, and the two limits on it. */
import { stat, statfs } from "node:fs/promises";
import { JobFailure } from "./protocol/jobs.ts";
import type { DiskFact } from "./protocol/observations.ts";

const gib = 2 ** 30;
const tenth = (n: number) => n.toFixed(1);

/**
 * Each filesystem that holds `first` or one of `watched`, once, with the paths on it, `first`'s first. A watched path
 * that is absent or unreadable, such as /var/lib/nexus-control on a node without the control plane, is left out.
 */
export async function readDisks(first: string, watched: readonly string[]): Promise<[DiskFact, ...DiskFact[]]> {
  const devices = await Promise.all([...new Set([first, ...watched])].map(async (path, i) => {
    try {
      return { path, dev: (await stat(path)).dev };
    } catch (err) {
      if (i > 0 && ["ENOENT", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) return null;
      throw err;
    }
  }));
  const byDevice = new Map<number, string[]>();
  for (const found of devices) {
    if (found === null) continue;
    const paths = byDevice.get(found.dev);
    if (paths === undefined) byDevice.set(found.dev, [found.path]);
    else paths.push(found.path);
  }
  const disks = await Promise.all([...byDevice.values()].map(async (paths): Promise<DiskFact> => {
    const fs = await statfs(paths[0]!);
    return { paths, totalGiB: (fs.blocks * fs.bsize) / gib, freeGiB: (fs.bavail * fs.bsize) / gib };
  }));
  return disks as [DiskFact, ...DiskFact[]];
}

export const lowDisk = (d: DiskFact) => d.freeGiB < Math.max(0.1 * d.totalGiB, 20);

export const keptFreeGiB = (totalGiB: number) => Math.max(10, 0.05 * totalGiB);

/** Why a pylon with a `diskGiB` disk may not boot on the pylons' filesystem `d` with `freeGiB` left for it, or null. */
export function diskRefusal(d: DiskFact, freeGiB: number, diskGiB: number): string | null {
  const keep = keptFreeGiB(d.totalGiB);
  if (freeGiB - diskGiB >= keep) return null;
  return `has ${tenth(freeGiB)} of ${tenth(d.totalGiB)} GiB free on the filesystem of ${d.paths.join(", ")}, and a ${diskGiB} GiB pylon disk would leave less than the ${tenth(keep)} GiB it keeps free`;
}

export const diskText = (d: DiskFact) => `${tenth(d.freeGiB)} of ${tenth(d.totalGiB)} GiB free at ${d.paths.join(", ")}${lowDisk(d) ? ", low" : ""}`;

/**
 * A boot or a template build fails as capacity, which the planner retries, when its disk would leave the filesystem of
 * `storage`, where the backend keeps its disks, short, since its overlay there can grow to the disk's size.
 */
export async function refuseShortDisk(storage: string, diskGiB: number): Promise<void> {
  const [pylons] = await readDisks(storage, []);
  const short = diskRefusal(pylons, pylons.freeGiB, diskGiB);
  if (short !== null) throw new JobFailure("capacity", `this node ${short}`);
}
