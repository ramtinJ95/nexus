import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkoutMerged, command, ReleaseInstaller, type InstallBoundary } from "./install.ts";

const commit = "a".repeat(40);
async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-deploy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t: TestContext) {
  const prefix = await directory(t);
  await mkdir(join(prefix, "releases", "old"), { recursive: true });
  await mkdir(join(prefix, "releases", commit));
  await symlink("releases/old", join(prefix, "control-current"));
  await symlink("releases/old", join(prefix, "current"));
  const calls: string[] = [];
  const boundary: InstallBoundary = {
    async prepare(hash) { calls.push(`prepare:${hash}`); return `releases/${hash}`; },
    async restart(role) { calls.push(`restart:${role}`); },
    async healthy(role) { calls.push(`healthy:${role}`); return true; },
    async journal(role) { calls.push(`journal:${role}`); return "service failed to bind"; },
  };
  return { prefix, calls, boundary, installer: new ReleaseInstaller(prefix, "control", boundary) };
}

test("a healthy install switches only its role's link and records the full commit", async (t) => {
  const { prefix, calls, installer } = await fixture(t);
  const result = await installer.install(commit);
  assert.equal(result.state, "healthy");
  assert.equal(result.commit, commit);
  assert.equal(await readlink(join(prefix, "control-current")), `releases/${commit}`);
  assert.equal(await readlink(join(prefix, "current")), "releases/old");
  assert.deepEqual(calls, [`prepare:${commit}`, "restart:control", "healthy:control"]);
  assert.deepEqual(await installer.observed(), result);
});

test("failed health rolls back, keeps journal tail, and does not retry the bad release", async (t) => {
  const { prefix, boundary, installer } = await fixture(t);
  boundary.healthy = async () => await readlink(join(prefix, "control-current")) === "releases/old";
  const result = await installer.install(commit);
  assert.equal(result.state, "rolled-back");
  assert.match(result.reason!, /health check failed\nservice failed to bind/);
  assert.equal(await readlink(join(prefix, "control-current")), "releases/old");
  boundary.prepare = async () => { throw new Error("must not retry"); };
  assert.deepEqual(await installer.install(commit), result);
});

test("restart failure also restores the previous release", async (t) => {
  const { prefix, boundary, installer } = await fixture(t);
  boundary.restart = async () => {
    if (await readlink(join(prefix, "control-current")) !== "releases/old") throw new Error("restart failed");
  };
  assert.equal((await installer.install(commit)).state, "rolled-back");
});

test("a failed rollback is not reported as a successful rollback", async (t) => {
  const { boundary, installer } = await fixture(t);
  boundary.healthy = async () => false;
  boundary.journal = async () => { throw new Error("no journal"); };
  const result = await installer.install(commit);
  assert.equal(result.state, "failed");
  assert.match(result.reason!, /journal unavailable\nrollback failed: Error: previous release is not healthy/);
});

test("a process interrupted around the link swap recovers from its persistent transaction", async (t) => {
  const { prefix, boundary } = await fixture(t);
  for (const switched of [false, true]) {
    await writeFile(join(prefix, "control-deploy.json"), JSON.stringify({
      commit, previous: "releases/old", target: `releases/${commit}`, state: "installing", reason: null,
    }));
    if (switched) {
      await rm(join(prefix, "control-current"));
      await symlink(`releases/${commit}`, join(prefix, "control-current"));
    }
    const restarted = new ReleaseInstaller(prefix, "control", boundary);
    assert.equal((await restarted.recover()).state, "rolled-back");
    assert.equal(await readlink(join(prefix, "control-current")), "releases/old");
  }
});

test("a preparation failure never touches the running release", async (t) => {
  const { prefix, boundary, installer } = await fixture(t);
  boundary.prepare = async () => { throw new Error("build failed"); };
  await assert.rejects(installer.install(commit), /build failed/);
  assert.equal(await readlink(join(prefix, "control-current")), "releases/old");
  assert.equal(await installer.observed(), null);
});

test("git accepts merged commits, refuses a fetched non-main commit, and rejects revisions before running git", async (t) => {
  const dir = await directory(t);
  const remote = join(dir, "remote");
  const clone = join(dir, "clone");
  await mkdir(remote);
  const git = (args: string[]) => command("git", args, remote);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["commit", "--allow-empty", "-m", "initial"]);
  const merged = await git(["rev-parse", "HEAD"]);
  await checkoutMerged(clone, merged, command, remote);
  assert.equal(await command("git", ["rev-parse", "HEAD"], clone), merged);
  await git(["checkout", "-b", "unmerged"]);
  await git(["commit", "--allow-empty", "-m", "unmerged"]);
  const unmerged = await git(["rev-parse", "HEAD"]);
  await command("git", ["fetch", remote, "unmerged"], clone);
  await assert.rejects(checkoutMerged(clone, unmerged, command, remote), /not an ancestor of origin\/main/);
  assert.equal(await command("git", ["rev-parse", "HEAD"], clone), merged);
  for (const revision of ["main", "--upload-pack=evil", "../elsewhere", "a".repeat(39)]) {
    await assert.rejects(checkoutMerged(clone, revision, async () => { assert.fail("git must not run"); }), /full lower-case commit hash/);
  }
});
