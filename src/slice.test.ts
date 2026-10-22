/**
 * The first vertical slice, end to end: the control plane's planner drives a real probe over HTTP, and the
 * probe runs spawn, pause and delete with a real backend. One test body runs against one backend fixture:
 *
 * - Docker (the default), against the local Docker. Everything it creates carries the label
 *   nexus.test=<run>, and cleanup removes only that.
 * - pylon-vm, when NEXUS_SLICE_BACKEND=pylon-vm, with NEXUS_PYLON_VM_IMAGE=<Gondolin assets dir> and
 *   NEXUS_PYLON_VM_STATE=<state root>, and optionally NEXUS_PYLON_VM_MEMORY_GIB (default 4). It boots a
 *   Gondolin VM, clones a small public repo over HTTPS, and destroys the instance at the end.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDockerBackend } from "./docker-backend.ts";
import { createPylonVmBackend } from "./pylon-vm-backend.ts";
import { run as pylonVm } from "./pylon-vm/client.ts";
import { startProbe, type Probe } from "./probe/server.ts";
import { connectProbe, type LiveHash, type NodeName, type ProbeClient, type PylonId, type TailnetNodeId } from "./protocol.ts";
import { envelope, type PlanStep } from "./reconcile.ts";
import { newPylonRecord, nextCheckpoint, tick, type PylonRecord } from "./tick.ts";
import type { BackendPylon, Guest, VmBackend } from "./backend.ts";
import type { BootInputs } from "./project.ts";
import type { CheckpointId, ImageId } from "./images.ts";

const execFileAsync = promisify(execFile);

const run = randomUUID().slice(0, 8);
const image: ImageId = "img-slicetest0000";
const node = "slice-node" as NodeName;
const controlPlaneId = "nSLICECONTROL" as TailnetNodeId;
const probeId = "nSLICEPROBE" as TailnetNodeId;
const thread = `slice-${run}`;
const pylonId = `pylon-${thread}` as PylonId;

interface SliceFixture {
  backend: VmBackend;
  boot: Omit<BootInputs, "source" | "pylonId" | "image">;
  /** Generous for the slowest step, a fresh boot. */
  convergeMs: number;
  /** Where Guest.exec writes the marker, and the cwd it runs in. */
  marker: string;
  cwd: string;
  setUp(): Promise<void>;
  /** Backend-specific checks of a fresh boot. */
  checkFreshBoot(guest: Guest): Promise<void>;
  /** The state a probe killed partway through ensurePaused leaves behind. */
  partialPause(checkpoint: CheckpointId): Promise<void>;
  /** Whether the planner still sees a pause to finish after partialPause, or the backend already reports it paused. */
  partialPauseResubmits: boolean;
  /** No VM runs, and the disk the checkpoint names is stored. */
  assertStored(checkpoint: CheckpointId): Promise<void>;
  /** No VM, disk, checkpoint or controller of the pylon remains. */
  assertNothingRemains(): Promise<void>;
  cleanUp(): Promise<void>;
}

function dockerFixture(): SliceFixture {
  const docker = async (...args: string[]) => (await execFileAsync("docker", args)).stdout.trim();
  const baseImage = "debian:bookworm-slim";
  const testLabel = `nexus.test=slice-${run}`;
  const containers = async () => (await docker("ps", "-a", "-q", "--filter", `label=nexus.pylon=${pylonId}`, "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
  const checkpointImage = async (checkpoint: string) => docker("images", "-q", "--filter", `label=nexus.pylon=${pylonId}`, "--filter", `label=nexus.checkpoint=${checkpoint}`, "--filter", `label=${testLabel}`);
  return {
    backend: createDockerBackend({ images: { [image]: baseImage }, labels: { "nexus.test": `slice-${run}` } }),
    boot: {
      resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 },
      network: { allowedHosts: [], secrets: [] },
      repo: { url: "git@example.com:slice.git", checkout: { branch: "main", commit: "0000000" } },
    },
    convergeMs: 90_000,
    marker: "/root/marker",
    cwd: "/",
    async setUp() {
      if (await docker("images", "-q", "--filter", `reference=${baseImage}`) === "") await docker("pull", baseImage);
    },
    async checkFreshBoot() {},
    // The pause dies after `docker stop` and before `docker commit`.
    async partialPause() {
      await docker("stop", pylonId);
      assert.equal(await docker("inspect", "-f", "{{.State.Status}}", pylonId), "exited");
    },
    partialPauseResubmits: true,
    async assertStored(checkpoint) {
      assert.deepEqual(await containers(), []);
      assert.notEqual(await checkpointImage(checkpoint), "");
    },
    async assertNothingRemains() {
      assert.deepEqual(await containers(), []);
      assert.equal(await docker("images", "-q", "--filter", `label=nexus.pylon=${pylonId}`), "");
    },
    async cleanUp() {
      const ids = (await docker("ps", "-a", "-q", "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
      if (ids.length > 0) await docker("rm", "--force", ...ids);
      for (;;) {
        const images = (await docker("images", "-q", "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
        if (images.length === 0) break;
        await docker("rmi", "--force", images[0]!);
      }
    },
  };
}

function pylonVmFixture(): SliceFixture {
  const assets = process.env["NEXUS_PYLON_VM_IMAGE"];
  const stateRoot = process.env["NEXUS_PYLON_VM_STATE"];
  if (!assets || !stateRoot) throw new Error("NEXUS_SLICE_BACKEND=pylon-vm needs NEXUS_PYLON_VM_IMAGE and NEXUS_PYLON_VM_STATE");
  const memoryGiB = Number(process.env["NEXUS_PYLON_VM_MEMORY_GIB"] ?? 4);
  if (!Number.isInteger(memoryGiB)) throw new Error(`NEXUS_PYLON_VM_MEMORY_GIB must be a whole number of GiB, got ${process.env["NEXUS_PYLON_VM_MEMORY_GIB"]}`);
  const instances = join(stateRoot, "instances");
  const instanceDir = join(instances, pylonId);
  const repo = { url: "https://github.com/octocat/Hello-World.git", checkout: { branch: "master", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" } };
  const controllers = async () => {
    try {
      return (await execFileAsync("pgrep", ["-f", instanceDir])).stdout.trim();
    } catch (err) {
      if ((err as { code?: unknown }).code === 1) return ""; // pgrep found nothing
      throw err;
    }
  };
  return {
    backend: createPylonVmBackend({ stateRoot, images: { [image]: assets } }),
    boot: {
      resources: { cpus: 2, memoryGiB, diskGiB: 8 },
      network: { allowedHosts: ["github.com"], secrets: [] },
      repo,
    },
    convergeMs: 300_000,
    marker: "/home/user/workspace/marker",
    cwd: "/home/user/workspace",
    async setUp() {
      assert.ok(existsSync(join(assets, "manifest.json")), `${assets} is not a Gondolin assets directory`);
    },
    async checkFreshBoot(guest) {
      const opts = { cwd: "/home/user/workspace/repo", timeoutMs: 30_000 };
      assert.deepEqual(await guest.exec(["id", "-un"], opts), { exitCode: 0, output: "user\n", truncated: false });
      assert.deepEqual(await guest.exec(["git", "rev-parse", "HEAD"], opts), { exitCode: 0, output: `${repo.checkout.commit}\n`, truncated: false });
      assert.deepEqual(await guest.exec(["git", "symbolic-ref", "--short", "HEAD"], opts), { exitCode: 0, output: `${repo.checkout.branch}\n`, truncated: false });
      // The kernel keeps some memory for itself, so MemTotal is a little under the size the VM was given.
      const meminfo = await guest.exec(["grep", "MemTotal", "/proc/meminfo"], opts);
      const memTotalGiB = Number(/MemTotal:\s+(\d+) kB/.exec(meminfo.output)?.[1]) / 2 ** 20;
      assert.ok(memTotalGiB > memoryGiB * 0.9 && memTotalGiB <= memoryGiB, `asked for ${memoryGiB} GiB, the guest sees ${memTotalGiB.toFixed(2)} GiB`);
    },
    // The pause dies after the VM stopped and before the checkpoint ID moved from `pausing` to `checkpoint`.
    async partialPause(checkpoint) {
      const sidecar = join(instanceDir, "nexus-checkpoint.json");
      const previous = JSON.parse(await readFile(sidecar, "utf8")) as { checkpoint: string | null };
      await writeFile(sidecar, JSON.stringify({ checkpoint: previous.checkpoint, pausing: checkpoint }));
      await pylonVm(stateRoot, { action: "stop", name: pylonId });
    },
    partialPauseResubmits: false,
    async assertStored() {
      assert.ok(existsSync(join(instanceDir, "disk.qcow2")), "the instance has no disk.qcow2");
      assert.equal(await controllers(), "", "a controller of the stopped instance still runs");
    },
    async assertNothingRemains() {
      assert.deepEqual((await readdir(instances)).filter((name) => name.includes(pylonId)), []);
      assert.equal(await controllers(), "");
    },
    async cleanUp() {
      if (!existsSync(instanceDir)) return;
      // The test failed before delete. The controller log goes with the instance, so print it first.
      console.error((await pylonVm(stateRoot, { action: "logs", name: pylonId, lines: 200 }) as { output: string }).output);
      await pylonVm(stateRoot, { action: "destroy", kind: "instances", name: pylonId, confirm: pylonId });
    },
  };
}

const fixture = process.env["NEXUS_SLICE_BACKEND"] === "pylon-vm" ? pylonVmFixture() : dockerFixture();
const backend = fixture.backend;

const pylon: PylonRecord = newPylonRecord({
  thread, pylonId, node,
  desired: "running",
  boot: { pylonId, image, ...fixture.boot },
  firstBoot: { kind: "fresh", preSetup: null },
  live: { previews: [], overlay: [] },
  liveHash: "live-slice-1" as LiveHash,
});

let probe: Probe;
let port = 0;
let client: ProbeClient;

async function startTestProbe(b: VmBackend = backend) {
  probe = await startProbe({
    node, host: "127.0.0.1", port,
    auth: { controlPlane: controlPlaneId, peers: [] },
    // Every caller on loopback is the control plane. Tests never ask tailscaled.
    whois: async () => controlPlaneId,
    backend: b,
    secrets: { value: () => undefined },
  });
  port = probe.port;
  client ??= connectProbe(node, "127.0.0.1", probeId, { port, whois: async () => probeId });
}

/** Ticks until the planner says done. Returns every step, so tests can see what was sent. */
async function converge(timeoutMs = fixture.convergeMs): Promise<PlanStep[]> {
  const steps: PlanStep[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const step = await tick(pylon, client);
    steps.push(step);
    if (step.kind === "done") return steps;
    if (step.kind === "fail") throw new Error(`planner gave up: ${step.reason}`);
    if (Date.now() > deadline) throw new Error(`no convergence in ${timeoutMs} ms: ${JSON.stringify(steps.slice(-5))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const submitted = (steps: PlanStep[]) => steps.flatMap((s) => s.kind === "submit" ? [s.job.kind] : []);
const listed = async (): Promise<BackendPylon | undefined> => (await backend.list()).find((p) => p.pylonId === pylonId);
const inGuest = (script: string) => backend.guest(pylonId).exec(["sh", "-c", script], { cwd: fixture.cwd, timeoutMs: 30_000 });

async function assertPaused(checkpoint: CheckpointId) {
  const p = await listed();
  assert.equal(p?.vm, "stopped");
  assert.equal(p.checkpoint, checkpoint);
  await fixture.assertStored(checkpoint);
}

before(async () => {
  await fixture.setUp();
  await startTestProbe();
});

after(async () => {
  await probe?.close();
  await fixture.cleanUp();
});

test("running: the planner spawns a fresh pylon from the image", async () => {
  const steps = await converge();
  assert.deepEqual(submitted(steps), ["spawn"]);
  const p = await listed();
  assert.equal(p?.vm, "running");
  assert.equal(p.checkpoint, null);
  await fixture.checkFreshBoot(backend.guest(pylonId));
  assert.deepEqual(await inGuest(`echo ${run} > ${fixture.marker}`), { exitCode: 0, output: "", truncated: false });
});

test("the same envelope twice gives the same status back", async () => {
  const env = envelope({ kind: "spawn", pylonId, boot: { ...pylon.boot, source: pylon.firstBoot }, live: pylon.live, liveHash: pylon.liveHash }, node, Date.now());
  const first = await client.submit(env);
  const second = await client.submit(env);
  assert.ok("accepted" in first && "accepted" in second);
  assert.equal(second.accepted.jobId, first.accepted.jobId);
  let status = await client.job(env.jobId);
  while (status !== "unknown" && status.state === "running") status = await client.job(env.jobId);
  assert.ok(status !== "unknown" && status.state === "succeeded", JSON.stringify(status));
  assert.deepEqual(await client.submit(env), { accepted: status });
  assert.deepEqual(await client.submit(env), { accepted: status });
});

test("an expired envelope is rejected", async () => {
  const env = envelope({ kind: "pause", pylonId, checkpoint: nextCheckpoint(pylon) }, node, Date.now() - 31_000);
  assert.deepEqual(await client.submit(env), { rejected: "expired" });
  assert.equal(await client.job(env.jobId), "unknown");
  assert.equal((await listed())?.vm, "running");
});

test("paused: the VM is gone and its checkpoint is stored", async () => {
  pylon.desired = "paused";
  const checkpoint = nextCheckpoint(pylon);
  assert.deepEqual(submitted(await converge()), ["pause"]);
  await assertPaused(checkpoint);
});

test("running again: resumes from the checkpoint with the marker intact", async () => {
  pylon.desired = "running";
  assert.deepEqual(submitted(await converge()), ["spawn"]);
  const p = await listed();
  assert.equal(p?.vm, "running");
  assert.equal(p.checkpoint, `ckpt-${thread}-1`);
  assert.deepEqual(await inGuest(`cat ${fixture.marker}`), { exitCode: 0, output: `${run}\n`, truncated: false });
});

test("a probe restart makes the planner re-send spawn, which leaves the running VM alone", async () => {
  const before = (await listed())?.bootedAt;
  assert.ok(before);
  await probe.close();
  await startTestProbe();
  const steps = await converge();
  assert.equal(steps[0]?.kind, "submit");
  assert.deepEqual(submitted(steps), ["spawn"]);
  assert.equal((await listed())?.bootedAt, before);
  assert.deepEqual(await inGuest(`cat ${fixture.marker}`), { exitCode: 0, output: `${run}\n`, truncated: false });
});

test("a probe killed during a pause: the next ticks finish the pause", async () => {
  await probe.close();
  const stopped = Promise.withResolvers<void>();
  await startTestProbe({
    ...backend,
    async ensurePaused(_id, checkpoint, signal) {
      await fixture.partialPause(checkpoint);
      stopped.resolve();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  pylon.desired = "paused";
  const checkpoint = nextCheckpoint(pylon);
  const first = await tick(pylon, client);
  assert.ok(first.kind === "submit" && first.job.kind === "pause");
  await stopped.promise;
  await probe.close();

  await startTestProbe();
  const steps = await converge();
  assert.deepEqual(submitted(steps), fixture.partialPauseResubmits ? ["pause"] : []);
  await assertPaused(checkpoint);
});

test("deleted: nothing of the pylon remains", async () => {
  pylon.desired = "deleted";
  assert.deepEqual(submitted(await converge()), ["delete"]);
  assert.equal(await listed(), undefined);
  await fixture.assertNothingRemains();
});
