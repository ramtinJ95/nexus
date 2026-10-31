import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { NodeName, ProjectId } from "../ids.ts";
import { tempDir } from "../test-kit.ts";
import { backup, check, nameOf, restore, verify } from "./backup.ts";
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
  registry.createProject(project("before"));
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
  assert.ok(copy.project("before" as ProjectId));
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
  assert.ok(m.registry.project("before" as ProjectId), "nothing was restored");
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

test("restore on a stopped control plane puts back the backed-up state with its modes, over later changes and a stale WAL", async (t) => {
  const m = await controlPlane(t);
  await m.run(m.day(1));
  m.registry.createProject(project("after"));
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
  assert.ok(registry.project("before" as ProjectId));
  assert.equal(registry.project("after" as ProjectId), undefined);
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
