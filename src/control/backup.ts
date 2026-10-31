/**
 * The control plane's daily backup, which nexus-backup.timer runs as root on the control plane's machine, and the
 * restore and check beside it. Each backup is one directory under /var/backups/nexus, named for its UTC time, and is
 * complete only once its manifest exists, which is written last.
 *
 *   sudo node src/control/backup.ts backup [config.json]
 *   sudo node src/control/backup.ts check
 *   sudo node src/control/backup.ts restore <backup>
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { z } from "zod";
import { readConfig, type ControlPlaneConfig } from "./main.ts";

const exec = promisify(execFile);

export const backupRoot = "/var/backups/nexus";
export const etcDir = "/etc/nexus";
export const kept = 7;
const manifestFile = "manifest.json";
const backupName = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
/** Restore refuses while any of these runs. The deployer can restart the control plane, and a backup can prune the one restored. */
const stoppedUnits = ["nexus-control.service", "nexus-deployer.service", "nexus-deployer.timer", "nexus-backup.service", "nexus-backup.timer"] as const;

type Kind = "sqlite" | "file";
/** One thing a backup copies: `name` is its path inside the backup, `path` where it lives. */
export interface Source { name: string; path: string; kind: Kind }

const entrySchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(["sqlite", "file"]),
  size: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.int().min(0),
  uid: z.int().min(0),
  gid: z.int().min(0),
});
const manifestSchema = z.strictObject({ createdAt: z.iso.datetime(), entries: z.array(entrySchema).min(1) });
export type Manifest = z.infer<typeof manifestSchema>;

export type Verdict = { ok: true; manifest: Manifest } | { ok: false; reason: string };
export type BackupCheck =
  | { verified: true; name: string; createdAt: string; ageMs: number }
  | { verified: false; name?: string; createdAt?: string; ageMs?: number; reason: string };

/** What a backup copies, from the config: the registry, the harness's storage and credentials, and every file under etc. */
export async function sources(config: ControlPlaneConfig, etc: string): Promise<Source[]> {
  const files = (await readdir(etc, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const tokenFile = config.github?.tokenFile;
  return [
    // As nexus-control.service resolves a relative path, from its WorkingDirectory.
    { name: "registry.db", path: resolve("/var/lib/nexus-control", config.db), kind: "sqlite" },
    { name: "harness.sqlite", path: config.harness.storage, kind: "sqlite" },
    { name: "harness-credentials.json", path: config.harness.credentials, kind: "file" },
    ...tokenFile !== undefined && relative(etc, tokenFile).startsWith("..") ? [{ name: "github-token", path: tokenFile, kind: "file" as const }] : [],
    ...files.map((path) => ({ name: join("etc", relative(etc, path)), path, kind: "file" as const })),
  ];
}

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const quoted = (path: string) => `'${path.replaceAll("'", "''")}'`;

function integrity(path: string): string | undefined {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    return rows.length === 1 && rows[0]!.integrity_check === "ok" ? undefined : rows.map((r) => r.integrity_check).join("; ");
  } finally {
    db.close();
  }
}

/** Names the time as a backup directory, such as 2026-10-31T03-00-00Z. */
export const nameOf = (time: Date) => time.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");

/** Writes one backup under `root` and returns its directory. Only once it verifies are all but the newest `keep` removed. */
export async function backup(options: { config: ControlPlaneConfig; root: string; etc: string; now: Date; keep: number }): Promise<string> {
  const { root, keep } = options;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await ownRoot(root);
  await chmod(root, 0o700);
  const dir = join(root, nameOf(options.now));
  await mkdir(dir, { mode: 0o700 });
  try {
    const entries: Manifest["entries"] = [];
    for (const source of await sources(options.config, options.etc)) {
      const facts = await lstat(source.path).catch(() => { throw new Error(`${source.path} is missing`); });
      if (!facts.isFile()) throw new Error(`${source.path} is not a regular file`);
      const copy = join(dir, source.name);
      await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
      if (source.kind === "sqlite") {
        // A read-only connection reads one snapshot through the live WAL, which a copy of the file would miss. On a stopped
        // database it leaves a -wal and -shm behind, which SQLite, run as root, gives the database's owner.
        const db = new DatabaseSync(source.path, { readOnly: true });
        try { db.exec(`VACUUM INTO ${quoted(copy)}`); } finally { db.close(); }
        const broken = integrity(copy);
        if (broken !== undefined) throw new Error(`the copy of ${source.path} fails integrity_check: ${broken}`);
      } else {
        await writeFile(copy, await readFile(source.path), { flag: "wx", mode: 0o600 });
      }
      await chmod(copy, 0o600);
      entries.push({ ...source, size: (await stat(copy)).size, sha256: await sha256(copy), mode: facts.mode & 0o7777, uid: facts.uid, gid: facts.gid });
    }
    const manifest: Manifest = { createdAt: options.now.toISOString(), entries };
    const partial = join(dir, `.${manifestFile}.${randomUUID()}`);
    await writeFile(partial, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(partial, join(dir, manifestFile));
    const verdict = await verify(dir);
    if (!verdict.ok) throw new Error(`the new backup does not verify: ${verdict.reason}`);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const complete = await completeBackups(root);
  const keeping = new Set(complete.slice(0, keep));
  for (const name of await backupNames(root)) {
    if (!keeping.has(name)) await rm(join(root, name), { recursive: true, force: true });
  }
  return dir;
}

/** Refuses a root that is a link or another user's, who could swap a backup's directory while credentials are written to it. */
async function ownRoot(root: string) {
  const facts = await lstat(root);
  if (!facts.isDirectory() || facts.uid !== process.getuid!()) throw new Error(`${root} is a link, not a directory, or not this user's, so nothing is written to or read from it`);
}

/** Every directory under `root` named as a backup, newest first. */
async function backupNames(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  return entries.filter((e) => e.isDirectory() && backupName.test(e.name)).map((e) => e.name).sort().reverse();
}

async function completeBackups(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const name of await backupNames(root)) {
    if (await lstat(join(root, name, manifestFile)).then((s) => s.isFile(), () => false)) names.push(name);
  }
  return names;
}

/** Whether the backup in `dir` is whole: its manifest, every file's size and SHA-256, and each database's integrity. */
export async function verify(dir: string): Promise<Verdict> {
  let manifest: Manifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(await readFile(join(dir, manifestFile), "utf8")));
  } catch (err) {
    return { ok: false, reason: `${join(dir, manifestFile)}: ${(err as Error).message}` };
  }
  const named = new Set(manifest.entries.map((e) => e.name));
  const present = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => !e.isDirectory())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
  const unnamed = present.filter((name) => name !== manifestFile && !named.has(name));
  if (unnamed.length > 0) return { ok: false, reason: `the manifest does not name ${unnamed.join(", ")}` };
  for (const entry of manifest.entries) {
    const copy = join(dir, entry.name);
    const facts = await lstat(copy).catch(() => undefined);
    if (facts === undefined || !facts.isFile()) return { ok: false, reason: `${entry.name} is missing` };
    if (facts.size !== entry.size) return { ok: false, reason: `${entry.name} is ${facts.size} bytes, not the ${entry.size} the manifest says` };
    if (await sha256(copy) !== entry.sha256) return { ok: false, reason: `${entry.name} does not match its SHA-256` };
    if (entry.kind === "sqlite") {
      const broken = integrity(copy);
      if (broken !== undefined) return { ok: false, reason: `${entry.name} fails integrity_check: ${broken}` };
    }
  }
  return { ok: true, manifest };
}

/** The newest complete backup under `root`, its age at `now`, and whether it verifies. What `nexus doctor` is to call. */
export async function check(options: { root: string; now: Date }): Promise<BackupCheck> {
  const [name] = await completeBackups(options.root);
  if (name === undefined) return { verified: false, reason: `no complete backup in ${options.root}` };
  const verdict = await verify(join(options.root, name));
  if (!verdict.ok) return { verified: false, name, reason: verdict.reason };
  const { createdAt } = verdict.manifest;
  return { verified: true, name, createdAt, ageMs: options.now.getTime() - Date.parse(createdAt) };
}

/**
 * Puts every file of the backup `name` back where it was copied from, with its mode and owner, on a stopped control
 * plane. `unitState` answers as `systemctl is-active` prints.
 */
export async function restore(options: { root: string; name: string; unitState: (unit: string) => Promise<string> }): Promise<Manifest> {
  for (const unit of stoppedUnits) {
    const state = await options.unitState(unit);
    if (state !== "inactive" && state !== "failed") throw new Error(`${unit} is ${state}. Stop ${stoppedUnits.join(", ")} before a restore`);
  }
  if (!backupName.test(options.name)) throw new Error(`${options.name} is not a backup's name, such as 2026-10-31T03-00-00Z`);
  await ownRoot(options.root);
  const dir = join(options.root, options.name);
  const verdict = await verify(dir);
  if (!verdict.ok) throw new Error(`${dir} does not verify, so it is not restored: ${verdict.reason}`);
  for (const entry of verdict.manifest.entries) {
    const parent = await stat(dirname(entry.path)).catch(() => undefined);
    if (!parent?.isDirectory()) throw new Error(`${dirname(entry.path)} is missing. Install the control role first`);
    if ((await lstat(entry.path).catch(() => undefined))?.isDirectory()) throw new Error(`${entry.path} is a directory, so it is not replaced`);
  }
  // Every file is staged before any target changes, so a failure here leaves the control plane's state as it was.
  const staged: { entry: Manifest["entries"][number]; partial: string }[] = [];
  try {
    for (const entry of verdict.manifest.entries) {
      // Opened with wx beside the target and renamed over it, so a link left at the target is replaced, never followed.
      const partial = join(dirname(entry.path), `.${basename(entry.path)}.restore-${randomUUID()}`);
      const file = await open(partial, "wx", 0o600);
      staged.push({ entry, partial });
      try {
        await file.writeFile(await readFile(join(dir, entry.name)));
        await file.chown(entry.uid, entry.gid);
        await file.chmod(entry.mode);
        await file.sync();
      } finally {
        await file.close();
      }
    }
  } catch (err) {
    for (const { partial } of staged) await rm(partial, { force: true });
    throw err;
  }
  for (const { entry, partial } of staged) {
    // SQLite would replay a stale WAL over the restored database.
    if (entry.kind === "sqlite") for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${entry.path}${suffix}`, { force: true });
    await rename(partial, entry.path);
  }
  return verdict.manifest;
}

async function systemctlState(unit: string): Promise<string> {
  // is-active exits nonzero for every state but active, and prints the state either way.
  const result = await exec("systemctl", ["is-active", unit]).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }));
  return result.stdout.trim() || "unknown";
}

async function host(args: string[]) {
  const [command, argument, ...extra] = args;
  const fits = command === "backup" || (command === "check" && argument === undefined) || (command === "restore" && argument !== undefined);
  if (!fits || extra.length > 0) {
    console.error("usage: sudo node src/control/backup.ts backup [config.json] | check | restore <backup>");
    process.exit(64);
  }
  if (process.getuid?.() !== 0) {
    console.error("backup: run this as root on the control plane's machine. A backup holds the control plane's credentials");
    process.exit(77);
  }
  try {
    if (command === "backup") {
      console.log(`backed up the control plane to ${await backup({ config: await readConfig(argument ?? join(etcDir, "control.json")), root: backupRoot, etc: etcDir, now: new Date(), keep: kept })}`);
    } else if (command === "check") {
      const result = await check({ root: backupRoot, now: new Date() });
      const { ageMs, ...facts } = result;
      console.log(JSON.stringify({ ...facts, ...ageMs === undefined ? {} : { ageSeconds: Math.round(ageMs / 1000) } }));
      process.exitCode = result.verified ? 0 : 1;
    } else {
      const manifest = await restore({ root: backupRoot, name: argument!, unitState: systemctlState });
      for (const entry of manifest.entries) console.log(`restored ${entry.path}`);
      console.log("Start the control plane with sudo systemctl start nexus-control.service, then sudo systemctl start nexus-deployer.timer nexus-backup.timer");
    }
  } catch (err) {
    console.error(`backup: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) await host(process.argv.slice(2));
