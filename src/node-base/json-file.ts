/**
 * JSON files that a process keeps between runs. A leaf module, so the deploy worker loads no more than Node to use it.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The parsed file, or `missing` when there is no file. */
export async function readJson(path: string, missing?: unknown): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return missing;
    throw err;
  }
  return JSON.parse(text);
}

let saves = 0;

/**
 * Exactly `mode`, whatever the umask. The rename makes the write atomic. The temp name is this call's own, so two saves
 * of one path never share one, and `wx` creates it afresh rather than writing through a leftover file or symlink.
 */
export async function saveJson(path: string, value: unknown, { mode = 0o600, mkdir: parent = false }: { mode?: number; mkdir?: boolean } = {}): Promise<void> {
  if (parent) await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${++saves}.tmp`;
  await rm(temporary, { force: true });
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}
