/**
 * JSON files that a process keeps between runs. A leaf module, so the deploy worker loads no more than Node to use it.
 */
import { readFile, rename, writeFile } from "node:fs/promises";

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

/** Readable by its owner only. The rename makes the write atomic, and the temp name is the process's own. */
export async function saveJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
