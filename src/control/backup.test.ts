import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { NodeName, ProjectId } from "../ids.ts";
import { tempDir } from "../test-support/kit.ts";
import { backup, check, failedRun, heldElsewhere, nameOf, restore, runBackup, verify } from "./backup.ts";
import { backedUpAt, readBackupStatus } from "./backup-status.ts";
import { parseConfig } from "./main.ts";
import { openRegistry } from "./registry.ts";

const project = (id: string) => ({
  id: id as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: "node-a" as NodeName,
  resources: { cpus: 1, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});

/** A throwaway control plane's state: a registry and harness storage left open, its credentials and an /etc/nexus. */
async function controlPlane(t: TestContext) {
  const dir = await tempDir("nexus-backup-", t);
  const state = join(dir, "var-lib-nexus-control");
  const etc = join(dir, "etc-nexus");
  const root = join(dir, "backups");
  await mkdir(state);
  await mkdir(join(etc, "keys"), { recursive: true });
  const paths = { db: join(state, "registry.db"), storage: join(state, "harness.sqlite"), credentials: join(state, "harness-credentials.json") };
  const config = parseConfig(JSON.stringify({
    db: paths.db,
    listen: { host: "127.0.0.1", port: 0, hostnames: ["localhost"] },
    self: { tailnetNodeId: "nSelf" },
    nodes: [{ name: "node-a", tailnetHost: "node-a.example.ts.net", tailnetNodeId: "nSelf" }],
    callers: [],
    dotfiles: { repo: "https://github.com/acme/dotfiles.git", ref: "main" },
    harness: { storage: paths.storage, credentials: paths.credentials, model: { provider: "openai", modelId: "gpt-6-astra" } },
  }));
  await writeFile(paths.credentials, '{"deviceId":"d","credentials":{"openai":{}}}\n', { mode: 0o600 });
  await writeFile(join(etc, "control.json"), "{}\n", { mode: 0o644 });
  await writeFile(join(etc, "secrets.env"), "GH_TOKEN=b\n", { mode: 0o640 });
  await writeFile(join(etc, "keys", "git_ed25519"), "a key\n");
  await chmod(join(etc, "keys", "git_ed25519"), 0o400);
  const registry = openRegistry(paths.db);
  registry.projects.createProject(project("before"));
  const storage = await openNodeSqliteStorage(paths.storage);
  let running = true;
  const stop = async () => {
    if (!running) return;
    running = false;
    registry.close();
    await storage.close(context);
  };
  t.after(stop);
  const day = (n: number) => new Date(Date.UTC(2026, 9, n, 3, 0, 0));
  const run = (now: Date) => backup({ config, root, etc, now, keep: 7 });
  return { dir, root, etc, paths, config, registry, day, run, stop };
}

const tables = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name); } finally { db.close(); }
};
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const stopped = async () => "inactive";

test("a backup copies the live databases consistently and every file, private to root, with a manifest of each", async (t) => {
  const m = await controlPlane(t);
  const dir = await m.run(m.day(1));
  assert.equal(await mode(m.root), 0o700);
  assert.equal(await mode(dir), 0o700);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.entries.map((e: { name: string }) => e.name).sort(), [
    "etc/control.json", "etc/keys/git_ed25519", "etc/secrets.env", "harness-credentials.json", "harness.sqlite", "registry.db",
  ]);
  for (const entry of manifest.entries) {
    assert.equal(await mode(join(dir, entry.name)), 0o600, entry.name);
    assert.equal(entry.size, (await stat(join(dir, entry.name))).size);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(manifest.entries.find((e: { name: string }) => e.name === "etc/secrets.env").mode, 0o640);
  // The registry is still open, and its project lives in the WAL, not yet in the database file.
  const copy = openRegistry(join(dir, "registry.db"));
  assert.ok(copy.projects.project("before" as ProjectId));
  copy.close();
  assert.deepEqual(tables(join(dir, "harness.sqlite")), tables(m.paths.storage));
  assert.equal(await readFile(join(dir, "etc/keys/git_ed25519"), "utf8"), "a key\n");
});

test("check reports the newest complete backup's age and whether it verifies, and passes over an incomplete one", async (t) => {
  const m = await controlPlane(t);
  assert.deepEqual(await check({ root: m.root, now: m.day(1) }), { verified: false, reason: `no complete backup in ${m.root}` });
  await m.run(m.day(1));
  const second = await m.run(m.day(2));
  await mkdir(join(m.root, nameOf(m.day(3))));
  const now = new Date(m.day(2).getTime() + 90 * 60_000);
  assert.deepEqual(await check({ root: m.root, now }), { verified: true, name: nameOf(m.day(2)), createdAt: m.day(2).toISOString(), ageMs: 90 * 60_000 });
  await writeFile(join(second, "harness-credentials.json"), '{"deviceId":"e","credentials":{"openai":{}}}\n');
  const tampered = await check({ root: m.root, now });
  assert.equal(tampered.verified, false);
  assert.match(tampered.reason!, /harness-credentials\.json/);
});

test("a failed run's status names the newest backup that remains and whether it verifies, and no path, content or error text", async (t) => {
  const m = await controlPlane(t);
  assert.deepEqual(await failedRun(m.root, m.day(1)), { ranAt: m.day(1).toISOString(), succeeded: false, newest: null });
  const kept = await m.run(m.day(1));
  assert.deepEqual(await failedRun(m.root, m.day(2)), { ranAt: m.day(2).toISOString(), succeeded: false, newest: { name: nameOf(m.day(1)), verified: true, createdAt: m.day(1).toISOString() } });
  await writeFile(join(kept, "harness-credentials.json"), '{"deviceId":"e","credentials":{"openai":{}}}\n');
  assert.deepEqual(await failedRun(m.root, m.day(2)), { ranAt: m.day(2).toISOString(), succeeded: false, newest: { name: nameOf(m.day(1)), verified: false, createdAt: null } });
});

test("a backup run's own result decides the unit's: a status not written is logged after a good backup, and a config that does not read is recorded as a failed run", async (t) => {
  const m = await controlPlane(t);
  const configPath = join(m.dir, "control.json");
  await writeFile(configPath, JSON.stringify(m.config));
  await mkdir(join(m.dir, "elsewhere"));
  await symlink(join(m.dir, "elsewhere"), join(m.dir, "linked"));
  const logged: string[] = [];
  const run = (over: { configPath?: string; statusFile?: string; now: Date }) => runBackup({ configPath, root: m.root, etc: m.etc, statusFile: join(m.dir, "status", "status.json"), keep: 7, log: (line) => logged.push(line), ...over });
  const dir = await run({ statusFile: join(m.dir, "linked", "status.json"), now: m.day(1) });
  assert.equal(dir, join(m.root, nameOf(m.day(1))), "the backup succeeded though its status could not be written");
  assert.match(logged.join("\n"), /the status for nexus doctor was not written to .*linked\/status\.json: .*is a link/);
  const statusFile = join(m.dir, "status", "status.json");
  await run({ now: m.day(2) });
  assert.deepEqual(await readBackupStatus(statusFile), { ranAt: m.day(2).toISOString(), succeeded: true, newest: { name: nameOf(m.day(2)), verified: true, createdAt: m.day(2).toISOString() } });
  await assert.rejects(run({ configPath: join(m.dir, "missing.json"), now: m.day(3) }), /missing\.json/);
  assert.deepEqual(await readBackupStatus(statusFile), { ranAt: m.day(3).toISOString(), succeeded: false, newest: { name: nameOf(m.day(2)), verified: true, createdAt: m.day(2).toISOString() } });
});

test("the backup a kept disk waits on is the newest that verified, from when its run began: a failed run keeps the one before, and a status with none gives none", async (t) => {
  const m = await controlPlane(t);
  const configPath = join(m.dir, "control.json");
  await writeFile(configPath, JSON.stringify(m.config));
  const statusFile = join(m.dir, "status", "status.json");
  const run = (now: Date, path = configPath) => runBackup({ configPath: path, root: m.root, etc: m.etc, statusFile, keep: 7, log: () => {}, now });
  assert.equal(backedUpAt(await readBackupStatus(statusFile)), null, "no run yet");
  await run(m.day(1));
  assert.equal(backedUpAt(await readBackupStatus(statusFile)), m.day(1).getTime());
  await assert.rejects(run(m.day(2), join(m.dir, "missing.json")));
  assert.equal(backedUpAt(await readBackupStatus(statusFile)), m.day(1).getTime(), "a failed run leaves the backup before it");
  assert.equal(backedUpAt({ ranAt: m.day(3).toISOString(), succeeded: false, newest: { name: nameOf(m.day(1)), verified: false, createdAt: null } }), null, "one that no longer verifies counts for nothing");
  assert.equal(backedUpAt({ ranAt: m.day(3).toISOString(), succeeded: false, newest: null }), null);
  assert.equal(backedUpAt({ unreadable: "EACCES" }), null);
});

test("a new backup that verifies leaves the newest 7 and no leftover, and a failed one leaves the earlier ones and nothing of its own", async (t) => {
  const m = await controlPlane(t);
  for (let n = 1; n <= 7; n++) await m.run(m.day(n));
  await mkdir(join(m.root, nameOf(m.day(8))));
  await m.run(m.day(9));
  const names = (n: number[]) => n.map((d) => nameOf(m.day(d)));
  assert.deepEqual((await readdir(m.root)).sort(), names([2, 3, 4, 5, 6, 7, 9]));

  await rm(m.paths.credentials);
  await assert.rejects(m.run(m.day(10)), /harness-credentials\.json is missing/);
  await writeFile(m.paths.credentials, "{}\n");
  await symlink(m.paths.credentials, join(m.etc, "linked"));
  await assert.rejects(m.run(m.day(11)), /linked is not a regular file/);
  assert.deepEqual((await readdir(m.root)).sort(), names([2, 3, 4, 5, 6, 7, 9]));
});

test("restore refuses while the control plane or the deployer runs, and refuses a backup that does not verify", async (t) => {
  const m = await controlPlane(t);
  const dir = await m.run(m.day(1));
  for (const unit of ["nexus-control.service", "nexus-deployer.service", "nexus-deployer.timer", "nexus-backup.service", "nexus-backup.timer"]) {
    const unitState = async (u: string) => u === unit ? "active" : "inactive";
    await assert.rejects(restore({ root: m.root, name: nameOf(m.day(1)), unitState }), new RegExp(`${unit} is active`));
  }
  await assert.rejects(restore({ root: m.root, name: "../backups", unitState: stopped }), /not a backup's name/);
  await rm(join(dir, "manifest.json"));
  await assert.rejects(restore({ root: m.root, name: nameOf(m.day(1)), unitState: stopped }), /does not verify/);
  assert.ok(m.registry.projects.project("before" as ProjectId), "nothing was restored");
});

test("restore refuses while the path unit that starts the deployer on a wake is active", async (t) => {
  const m = await controlPlane(t);
  await m.run(m.day(1));
  const unitState = async (u: string) => u === "nexus-deployer.path" ? "active" : "inactive";
  await assert.rejects(restore({ root: m.root, name: nameOf(m.day(1)), unitState }), /nexus-deployer\.path is active/);
});

test("a restore that cannot put back every file changes none of them", async (t) => {
  const m = await controlPlane(t);
  await m.run(m.day(1));
  await m.stop();
  await writeFile(m.paths.credentials, "later\n");
  await rm(join(m.etc, "secrets.env"));
  await mkdir(join(m.etc, "secrets.env"));
  await assert.rejects(restore({ root: m.root, name: nameOf(m.day(1)), unitState: stopped }), /secrets\.env is a directory/);
  assert.equal(await readFile(m.paths.credentials, "utf8"), "later\n");
  await rm(join(m.etc, "secrets.env"), { recursive: true });
  await chmod(join(m.etc, "keys"), 0o500);
  await assert.rejects(restore({ root: m.root, name: nameOf(m.day(1)), unitState: stopped }), /EACCES/);
  await chmod(join(m.etc, "keys"), 0o700);
  assert.equal(await readFile(m.paths.credentials, "utf8"), "later\n");
  assert.deepEqual((await readdir(join(m.dir, "var-lib-nexus-control"))).filter((f) => f.includes(".restore-")), []);
});

test("a backup root that is a link is neither written to nor restored from", async (t) => {
  const m = await controlPlane(t);
  const elsewhere = join(m.dir, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, m.root);
  await assert.rejects(m.run(m.day(1)), /is a link/);
  assert.deepEqual(await readdir(elsewhere), []);
  await assert.rejects(restore({ root: m.root, name: nameOf(m.day(1)), unitState: stopped }), /is a link/);
});

test("a source that is a link or a FIFO is refused, as a database or as a file, and the run leaves nothing of its own", async (t) => {
  const m = await controlPlane(t);
  const rootOnly = join(m.dir, "root-only");
  await writeFile(rootOnly, "a secret of root's\n", { mode: 0o600 });
  await rm(m.paths.credentials);
  await symlink(rootOnly, m.paths.credentials);
  await assert.rejects(m.run(m.day(1)), /harness-credentials\.json is not a regular file/);
  await rm(m.paths.credentials);
  execFileSync("mkfifo", [m.paths.credentials]);
  await assert.rejects(m.run(m.day(2)), /harness-credentials\.json is not a regular file/);
  await rm(m.paths.credentials);
  await writeFile(m.paths.credentials, "{}\n", { mode: 0o600 });
  await m.stop();
  await rename(m.paths.db, join(m.dir, "another.db"));
  await symlink(join(m.dir, "another.db"), m.paths.db);
  await assert.rejects(m.run(m.day(3)), /registry\.db is not a regular file/);
  assert.deepEqual(await readdir(m.root), []);
});

test("a database is copied only when SQLite opened the file the backup opened without following a link", async (t) => {
  const dir = await tempDir("nexus-backup-held-", t);
  const path = join(dir, "registry.db");
  const rootOnly = join(dir, "root-only.db");
  for (const file of [path, rootOnly]) new DatabaseSync(file).close();
  const held = async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      try { return await heldElsewhere(file.fd, await file.stat()); } finally { db.close(); }
    } finally {
      await file.close();
    }
  };
  assert.equal(await held(), true, "SQLite holds the file that was opened");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await rename(path, join(dir, "moved.db"));
    await symlink(rootOnly, path);
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(await heldElsewhere(file.fd, await file.stat()), false, "a link swapped in after the open is not the opened file"); } finally { db.close(); }
  } finally {
    await file.close();
  }
});

test("a file past the 2 GiB readFile refuses is backed up with its SHA-256, verifies, and is restored", async (t) => {
  const m = await controlPlane(t);
  const large = join(m.etc, "large");
  const size = 2 ** 31 + 8;
  const write = async (tail: string) => {
    const file = await open(large, "w", 0o600);
    try { await file.truncate(size - tail.length); await file.write(tail, size - tail.length); } finally { await file.close(); }
  };
  await write("backedup");
  await assert.rejects(readFile(large), { code: "ERR_FS_FILE_TOO_LARGE" });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(large)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const dir = await m.run(m.day(1));
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as { entries: { name: string; size: number; sha256: string }[] };
  const entry = manifest.entries.find((e) => e.name === join("etc", "large"));
  assert.deepEqual({ size: entry?.size, sha256: entry?.sha256 }, { size, sha256 }, "the run verified it, so its copy has this SHA-256 too");
  await m.stop();
  await write("changed!");
  await restore({ root: m.root, name: nameOf(m.day(1)), unitState: stopped });
  assert.equal((await stat(large)).size, size);
  const file = await open(large, "r");
  try { assert.equal((await file.read(Buffer.alloc(8), 0, 8, size - 8)).buffer.toString(), "backedup"); } finally { await file.close(); }
});

test("restore on a stopped control plane puts back the backed-up state with its modes, over later changes and a stale WAL", async (t) => {
  const m = await controlPlane(t);
  await m.run(m.day(1));
  m.registry.projects.createProject(project("after"));
  await m.stop();
  // A crashed control plane leaves its WAL, which must not replay over the restored registry.
  const live = new DatabaseSync(m.paths.db);
  live.exec("PRAGMA wal_autocheckpoint = 0");
  live.prepare("DELETE FROM projects WHERE id = 'before'").run();
  const stale = await readFile(`${m.paths.db}-wal`);
  live.close();
  await writeFile(`${m.paths.db}-wal`, stale);
  await writeFile(m.paths.credentials, '{"deviceId":"later","credentials":{}}\n');
  await chmod(join(m.etc, "secrets.env"), 0o644);
  await writeFile(join(m.etc, "secrets.env"), "GH_TOKEN=later\n");
  await writeFile(join(m.etc, "added-later"), "kept\n");

  await restore({ root: m.root, name: nameOf(m.day(1)), unitState: stopped });

  const registry = openRegistry(m.paths.db);
  assert.ok(registry.projects.project("before" as ProjectId));
  assert.equal(registry.projects.project("after" as ProjectId), undefined);
  registry.close();
  assert.equal(await readFile(m.paths.credentials, "utf8"), '{"deviceId":"d","credentials":{"openai":{}}}\n');
  assert.equal(await mode(m.paths.credentials), 0o600);
  assert.equal(await readFile(join(m.etc, "secrets.env"), "utf8"), "GH_TOKEN=b\n");
  assert.equal(await mode(join(m.etc, "secrets.env")), 0o640);
  assert.equal(await mode(join(m.etc, "keys", "git_ed25519")), 0o400);
  assert.equal(await readFile(join(m.etc, "added-later"), "utf8"), "kept\n");
  assert.ok(tables(m.paths.storage).length > 0);
  assert.deepEqual((await readdir(join(m.dir, "var-lib-nexus-control"))).filter((f) => f.includes(".restore-")), []);
  assert.equal((await verify(join(m.root, nameOf(m.day(1))))).ok, true);
});

const sudo = (() => { try { execFileSync("sudo", ["-n", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("a backup as root of a stopped control plane leaves its databases openable and writable by their owner", { skip: !sudo && "needs passwordless sudo" }, async (t) => {
  const m = await controlPlane(t);
  await m.stop();
  assert.deepEqual((await readdir(join(m.dir, "var-lib-nexus-control"))).filter((f) => /-(wal|shm)$/.test(f)), [], "closed, so no sidecars");
  const script = `import { backup } from ${JSON.stringify(resolve(import.meta.dirname, "backup.ts"))};
await backup({ config: ${JSON.stringify(m.config)}, root: ${JSON.stringify(m.root)}, etc: ${JSON.stringify(m.etc)}, now: new Date(${m.day(1).getTime()}), keep: 7 });`;
  try {
    execFileSync("sudo", ["-n", "sh", "-c", 'umask 0077 && exec node --input-type=module -e "$1"', "sh", script], { stdio: "inherit" });
  } finally {
    execFileSync("sudo", ["-n", "rm", "-rf", m.root]);
  }
  const owner = process.getuid!();
  const left = await readdir(join(m.dir, "var-lib-nexus-control"));
  assert.ok(left.includes("registry.db-wal") && left.includes("harness.sqlite-shm"), `SQLite left the sidecars a root owner would lock out: ${left.join(", ")}`);
  for (const file of left) {
    assert.equal((await stat(join(m.dir, "var-lib-nexus-control", file))).uid, owner, file);
  }
  const registry = openRegistry(m.paths.db);
  registry.projects.createProject(project("after"));
  assert.ok(registry.projects.project("after" as ProjectId));
  registry.close();
  const storage = await openNodeSqliteStorage(m.paths.storage);
  await storage.close(context);
});
