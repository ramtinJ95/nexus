import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The bytes the files under `path` take on disk, links not followed. */
export async function diskBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.blocks * 512;
  let total = info.blocks * 512;
  for (const entry of await readdir(path)) total += await diskBytes(join(path, entry));
  return total;
}
