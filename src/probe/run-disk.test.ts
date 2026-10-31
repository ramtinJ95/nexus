/** A start, a wake and a template build on a node whose pylons' filesystem is about to run out. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendPylon, VmBackend } from "../backend.ts";
import type { ImageId, LiveHash, NodeName, ProjectId, PylonId, TemplateId } from "../ids.ts";
import type { Job } from "../protocol/jobs.ts";
import type { BootInputs } from "../spawn.ts";
import { runJob, type ProbeDeps } from "./run.ts";

const image = "img-000000000000" as ImageId;
const pylonId = "pylon-disk" as PylonId;
/** Larger than any filesystem a test runs on, so the refusal never depends on this machine's free space. */
const huge = 2 ** 40;
const boot = (diskGiB: number): BootInputs => ({
  pylonId, image, source: { kind: "fresh", preSetup: null }, resources: { cpus: 1, memoryGiB: 4, diskGiB },
  network: { allowedHosts: [], secrets: [] },
  repo: { kind: "clone", url: "https://example.com/r.git", checkout: { branch: "main", commit: "c0ffee" } },
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
});
const spawn = (diskGiB: number): Job => ({ kind: "spawn", pylonId, boot: boot(diskGiB), live: { previews: [], overlay: [] }, liveHash: "h" as LiveHash });
const build = (diskGiB: number): Job => ({
  kind: "build-template", template: "tpl-000000000000" as TemplateId,
  inputs: { key: { project: "p" as ProjectId, image, setupHash: "h" }, repo: { url: "https://example.com/r.git", branch: "main", commit: "c0ffee" }, preSetup: null, allowedHosts: [], resources: { cpus: 1, memoryGiB: 4, diskGiB } },
});

async function deps(t: import("node:test").TestContext, vm: BackendPylon["vm"] | "absent", storage: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-run-disk-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const backend = {
    ...storage ? { storage: dir } : {},
    state: async () => vm,
    async ensureRunning() { calls.push("ensureRunning"); },
    async buildTemplate() { calls.push("buildTemplate"); },
  } as Partial<VmBackend> as VmBackend;
  const d: ProbeDeps = {
    node: "n" as NodeName, backend, secrets: { value: () => undefined, names: () => [] },
    serve: { converge: async () => undefined, withdraw: async () => undefined },
    ports: { link: () => assert.fail("unused"), unlink: () => assert.fail("unused") },
    fetchPeer: () => assert.fail("unused"),
  };
  return { d, calls, dir };
}

test("a start, a wake and a template build fail as capacity when the disk would leave the pylons' filesystem short, naming it and its free space", async (t) => {
  for (const [vm, job] of [["absent", spawn(huge)], ["stopped", spawn(huge)], ["absent", build(huge)]] as const) {
    const { d, calls, dir } = await deps(t, vm, true);
    await assert.rejects(runJob(job, d, AbortSignal.timeout(5000)), (err: Error & { code?: string }) => {
      assert.equal(err.code, "capacity", "retryable, so the planner tries again");
      assert.match(err.message, new RegExp(`^this node has [\\d.]+ of [\\d.]+ GiB free on the filesystem of ${dir}, and a ${huge} GiB pylon disk would leave less than the [\\d.]+ GiB it keeps free$`));
      return true;
    }, `${job.kind} of a pylon that is ${vm}`);
    assert.deepEqual(calls, [], "nothing booted or built");
  }
});

test("a spawn that only reapplies a running pylon's live spec, and a backend that names no storage, are never refused for disk", async (t) => {
  const running = await deps(t, "running", true);
  await runJob(spawn(huge), running.d, AbortSignal.timeout(5000));
  assert.deepEqual(running.calls, ["ensureRunning"]);
  const docker = await deps(t, "absent", false);
  await runJob(spawn(huge), docker.d, AbortSignal.timeout(5000));
  await runJob(build(huge), docker.d, AbortSignal.timeout(5000));
  assert.deepEqual(docker.calls, ["ensureRunning", "buildTemplate"]);
});
