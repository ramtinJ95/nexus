/**
 * What the root backup unit tells the control plane after each run, in a file the control plane's user may read, since
 * that user may not read /var/backups/nexus, which holds credentials. It holds times, a backup's name and whether it
 * verified, never a path's content or an error's text.
 */
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const backupStatusFile = "/var/lib/nexus-backup/status.json";

const statusSchema = z.strictObject({
  ranAt: z.iso.datetime(),
  /** Whether that run wrote a backup that verified. */
  succeeded: z.boolean(),
  /** The newest complete backup after the run, null when there is none. `createdAt` is known only from a manifest that verified. */
  newest: z.strictObject({ name: z.string().min(1), verified: z.boolean(), createdAt: z.iso.datetime().nullable() }).nullable(),
});
export type BackupStatus = z.infer<typeof statusSchema>;
/** What the control plane reads: the status, `missing` before the first run, or why the file did not parse. */
export type BackupStatusRead = BackupStatus | "missing" | { unreadable: string };

/** Written by root beside the file and renamed over it, in a directory only root writes, so no other user can swap it for a link. */
export async function writeBackupStatus(path: string, status: BackupStatus): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const facts = await lstat(dir);
  if (!facts.isDirectory() || facts.uid !== process.getuid!()) throw new Error(`${dir} is a link, not a directory, or not this user's, so the backup's status is not written to it`);
  await chmod(dir, 0o755);
  const partial = join(dir, `.${randomUUID()}.tmp`);
  await writeFile(partial, `${JSON.stringify(statusSchema.parse(status))}\n`, { flag: "wx", mode: 0o644 });
  // The backup unit's UMask is 0077.
  await chmod(partial, 0o644);
  await rename(partial, path);
}

export async function readBackupStatus(path: string): Promise<BackupStatusRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return { unreadable: (err as Error).message };
  }
  try {
    return statusSchema.parse(JSON.parse(text));
  } catch (err) {
    return { unreadable: `${path} does not parse: ${(err as Error).message}` };
  }
}
