import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { command, ReleaseInstaller } from "./install.ts";
import { parseWorkerConfig } from "./worker.ts";
import { releaseOutcome } from "./model.ts";

const commit = "a".repeat(40);

test("worker config bounds drain and health and rejects credential-bearing endpoints", () => {
  const config = { controlUrl: "http://control:7470/", controlNodeId: "nControl", token: "a".repeat(64), drainTimeoutMs: 300000, healthTimeoutMs: 60000 };
  assert.deepEqual(parseWorkerConfig(config), config);
  for (const patch of [{ controlUrl: "http://user:pass@control/" }, { healthTimeoutMs: 0 }, { drainTimeoutMs: -1 }, { token: "" }]) assert.throws(() => parseWorkerConfig({ ...config, ...patch }));
});

test("wait outcome requires fresh health from every role and detects rollback and supersession", () => {
  const desired = { commit, requestedBy: "nMac", requestedAt: 0 };
  const report = { node: "node", role: "control" as const, commit, target: commit, state: "healthy" as const, reason: null, observedAt: 100 };
  assert.equal(releaseOutcome({ desired, nodes: [report] }, commit, 101), "healthy");
  assert.equal(releaseOutcome({ desired, nodes: [report] }, commit, 100_000), "pending");
  assert.equal(releaseOutcome({ desired, nodes: [{ ...report, state: "rolled-back" }] }, commit, 101), "failed");
  assert.equal(releaseOutcome({ desired: null, nodes: [report] }, commit, 101), "superseded");
});

test("fixed supervisor falls back after a worker crashes or hangs, and accepts a later worker", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workerDir = (name: string) => join(dir, name, "src/deploy");
  for (const name of ["deployer/bootstrap", "releases/broken", "releases/fixed"]) await mkdir(workerDir(name), { recursive: true });
  const marker = join(dir, "ran");
  await writeFile(join(workerDir("deployer/bootstrap"), "worker.ts"), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'fallback\\n');`);
  await writeFile(join(workerDir("releases/fixed"), "worker.ts"), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'fixed\\n');`);
  const script = (await readFile(new URL("../../deploy/supervise-deployer.sh", import.meta.url), "utf8")).replace("prefix=/opt/nexus", `prefix=${JSON.stringify(dir)}`).replaceAll("900s", "1s");
  await writeFile(join(dir, "supervise.sh"), script);
  for (const broken of ["process.exit(1)", "setInterval(() => {}, 1000)"]) {
    await writeFile(join(workerDir("releases/broken"), "worker.ts"), broken);
    await symlink("releases/broken", join(dir, "deployer-current"));
    await command("bash", [join(dir, "supervise.sh")], dir);
    assert.equal((await readFile(join(dir, "deployer/rejected"), "utf8")).trim(), "releases/broken");
  }
  await symlink("releases/fixed", join(dir, "deployer-current"));
  await command("bash", [join(dir, "supervise.sh")], dir);
  assert.equal(await readFile(marker, "utf8"), "fallback\nfallback\nfixed\n");
});

test("activation failure rolls back through fake service executables in a temporary prefix", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink("old", join(dir, "control-current"));
  const service = join(dir, "service.sh");
  await writeFile(service, 'set -eu\nprintf "%s\\n" "$1" >> calls\n[ "$1" != healthy ] || [ "$(readlink control-current)" = old ]\n');
  const installer = new ReleaseInstaller(dir, "control", {
    prepare: async () => "new",
    restart: async () => { await command("bash", [service, "restart"], dir); },
    healthy: async () => { try { await command("bash", [service, "healthy"], dir); return true; } catch { return false; } },
    journal: async () => "fake journal",
  });
  assert.equal((await installer.install(commit)).state, "rolled-back");
  assert.equal(await readlink(join(dir, "control-current")), "old");
  assert.equal(await readFile(join(dir, "calls"), "utf8"), "restart\nhealthy\nrestart\nhealthy\n");
});
