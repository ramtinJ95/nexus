/** The releases a node holds, as its deployer reads and deletes them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../test-kit.ts";
import { deleteReleases, readReleases, releaseKeeps } from "./release-cleanup.ts";
import { cleanReleases } from "./worker.ts";

const names = ["1", "2", "3", "4"].map((n) => n.repeat(40));
const [r1, r2, r3, r4] = names as [string, string, string, string];

async function node(t: import("node:test").TestContext) {
  const prefix = await tempDir("nexus-releases-", t);
  const proc = join(prefix, "proc");
  await mkdir(proc);
  for (const [i, name] of names.entries()) {
    await mkdir(join(prefix, "releases", name, "src"), { recursive: true });
    await writeFile(join(prefix, "releases", name, "release-commit"), `${name}\n`);
    await writeFile(join(prefix, "releases", name, "src", "main.ts"), "x".repeat(10_000));
    await utimes(join(prefix, "releases", name), i + 1, i + 1);
  }
  await mkdir(join(prefix, "releases", ".staging.abc"));
  await symlink(`releases/${r4}`, join(prefix, "current"));
  await symlink(`releases/${r4}`, join(prefix, "control-current"));
  await writeFile(join(prefix, "probe-deploy.json"), JSON.stringify({ commit: r4, previous: `releases/${r2}`, target: `releases/${r4}`, state: "healthy", reason: null }));
  /** A process whose arguments name a file in the release, as a pylon's controller started from it does. */
  const runs = async (pid: number, name: string) => {
    await mkdir(join(proc, String(pid)));
    await writeFile(join(proc, String(pid), "cmdline"), ["/usr/bin/node", join(prefix, "releases", name, "src/pylon-vm/daemon.ts"), "/var/lib/nexus/pylons/x"].join("\0"));
  };
  return { prefix, proc, runs };
}

test("the deployer reads each release with its size, the links, what the last install replaced and the releases processes run from", async (t) => {
  const { prefix, proc, runs } = await node(t);
  await runs(31, r1);
  const inventory = await readReleases(prefix, proc);
  assert.deepEqual(inventory.releases.map((r) => [r.name, r.commit]), names.map((n) => [n, n]), "a staging directory is no release");
  assert.ok(inventory.releases.every((r) => r.bytes >= 10_000), "each counts the bytes its files take");
  assert.deepEqual(inventory.links, { current: r4, "control-current": r4, "deployer-current": null });
  assert.deepEqual(inventory.replaced, { probe: r2, control: null });
  assert.deepEqual(inventory.running, { [r1]: 31 });
  assert.deepEqual([...releaseKeeps(inventory)], [
    [r4, "the probe runs it, through /opt/nexus/current"],
    [r1, "process 31 runs from it, as a pylon's controller does from the release it started from"],
    [r2, "a rollback of the probe needs it, as the release before the one it runs"],
    [r3, "a rollback of the control plane needs it, as the release before the one it runs"],
  ], "the control plane has no journal, so the release installed just before its own stays");
});

test("a delete checks each release again: one a process took up is skipped, and the same delete run twice changes nothing more", async (t) => {
  const { prefix, proc, runs } = await node(t);
  await writeFile(join(prefix, "probe-deploy.json"), JSON.stringify({ commit: r4, previous: `releases/${r3}`, target: `releases/${r4}`, state: "healthy", reason: null }));
  await runs(77, r2);
  const first = await deleteReleases(prefix, [r1, r2, "../etc"], proc);
  const deleted = first[r1];
  assert.ok(deleted?.state === "deleted" && deleted.bytes >= 10_000, "it frees the bytes its files took");
  assert.deepEqual(first[r2], { state: "skipped", reason: "process 77 runs from it, as a pylon's controller does from the release it started from" });
  assert.deepEqual(first["../etc"], { state: "skipped", reason: "\"../etc\" names no release" });
  const left = await readdir(join(prefix, "releases"));
  assert.deepEqual(left.filter((n) => !n.startsWith(".")).sort(), [r2, r3, r4]);
  assert.deepEqual(await deleteReleases(prefix, [r1], proc), { [r1]: { state: "gone" } });
  assert.deepEqual((await readReleases(prefix, proc)).releases.map((r) => r.name), [r2, r3, r4]);
});

test("each poll the deployer reports its releases, deletes those the control plane names and reports what each delete did", async (t) => {
  const { prefix, proc } = await node(t);
  const calls: { path: string; body: any }[] = [];
  const answers = [{ delete: [r1] }, { delete: [] }];
  await cleanReleases(prefix, async (path, body) => { calls.push({ path, body }); return answers[calls.length - 1]; }, proc);
  assert.deepEqual(calls.map((c) => c.path), ["releases", "releases"]);
  assert.equal(calls[0]!.body.outcomes, undefined);
  assert.equal(calls[1]!.body.outcomes[r1].state, "deleted");
  assert.deepEqual(calls[1]!.body.inventory.releases.map((r: { name: string }) => r.name), [r2, r3, r4]);
  calls.length = 0;
  await mkdir(join(prefix, "releases", `.deleting.${r2}`, "src"), { recursive: true });
  await cleanReleases(prefix, async (path, body) => { calls.push({ path, body }); return { delete: [] }; }, proc);
  assert.equal(calls.length, 1, "nothing to delete, so one report");
  assert.deepEqual((await readdir(join(prefix, "releases"))).filter((n) => n.startsWith(".deleting.")), [], "what a delete a crash cut short set aside goes on the next poll");
});
