/**
 * The first vertical slice, end to end against the local Docker: the control plane's planner drives a
 * real probe over HTTP, and the probe runs spawn, pause and delete with the Docker backend.
 *
 * Everything this test creates carries the label nexus.test=<run>, and cleanup removes only that.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createDockerBackend } from "./docker-backend.ts";
import { startProbe, type Probe } from "./probe/server.ts";
import { connectProbe, type LiveHash, type NodeName, type ProbeClient, type PylonId, type TailnetNodeId } from "./protocol.ts";
import { envelope, type PlanStep } from "./reconcile.ts";
import { newPylonRecord, nextCheckpoint, tick, type PylonRecord } from "./tick.ts";
import type { VmBackend } from "./backend.ts";
import type { ImageId } from "./images.ts";

const execFileAsync = promisify(execFile);
const docker = async (...args: string[]) => (await execFileAsync("docker", args)).stdout.trim();

const run = randomUUID().slice(0, 8);
const testLabel = `nexus.test=slice-${run}`;
const baseImage = "debian:bookworm-slim";
const image: ImageId = "img-slicetest0000";
const node = "slice-node" as NodeName;
const controlPlaneId = "nSLICECONTROL" as TailnetNodeId;
const probeId = "nSLICEPROBE" as TailnetNodeId;
const thread = `slice-${run}`;
const pylonId = `pylon-${thread}` as PylonId;

const backend = createDockerBackend({ images: { [image]: baseImage }, labels: { "nexus.test": `slice-${run}` } });

const pylon: PylonRecord = newPylonRecord({
  thread, pylonId, node,
  desired: "running",
  boot: {
    pylonId, image,
    resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 },
    network: { allowedHosts: [], secrets: [] },
    repo: { url: "git@example.com:slice.git", checkout: { branch: "main", commit: "0000000" } },
  },
  firstBoot: { kind: "fresh" },
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
async function converge(timeoutMs = 90_000): Promise<PlanStep[]> {
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
const containers = async () => (await docker("ps", "-a", "-q", "--filter", `label=nexus.pylon=${pylonId}`, "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
const checkpointImage = async (checkpoint: string) => docker("images", "-q", "--filter", `label=nexus.pylon=${pylonId}`, "--filter", `label=nexus.checkpoint=${checkpoint}`, "--filter", `label=${testLabel}`);
const inContainer = (...argv: string[]) => docker("exec", pylonId, ...argv);

before(async () => {
  if (await docker("images", "-q", "--filter", `reference=${baseImage}`) === "") await docker("pull", baseImage);
  await startTestProbe();
});

after(async () => {
  await probe?.close();
  const ids = (await docker("ps", "-a", "-q", "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
  if (ids.length > 0) await docker("rm", "--force", ...ids);
  for (;;) {
    const images = (await docker("images", "-q", "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
    if (images.length === 0) break;
    await docker("rmi", "--force", images[0]!);
  }
});

test("running: the planner spawns a container from the base image", async () => {
  const steps = await converge();
  assert.deepEqual(submitted(steps), ["spawn"]);
  assert.equal(await docker("inspect", "-f", "{{.State.Running}}", pylonId), "true");
  await inContainer("sh", "-c", `echo ${run} > /root/marker`);
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
  assert.equal(await docker("inspect", "-f", "{{.State.Running}}", pylonId), "true");
});

test("paused: the container is gone and its checkpoint image exists", async () => {
  pylon.desired = "paused";
  const checkpoint = nextCheckpoint(pylon);
  assert.deepEqual(submitted(await converge()), ["pause"]);
  assert.deepEqual(await containers(), []);
  assert.notEqual(await checkpointImage(checkpoint), "");
});

test("running again: resumes from the checkpoint with the marker intact", async () => {
  pylon.desired = "running";
  assert.deepEqual(submitted(await converge()), ["spawn"]);
  assert.equal(await inContainer("cat", "/root/marker"), run);
  assert.equal(await docker("inspect", "-f", '{{index .Config.Labels "nexus.booted-from"}}', pylonId), `ckpt-${thread}-1`);
});

test("a probe restart makes the planner re-send spawn, which leaves the running container alone", async () => {
  const before = await docker("inspect", "-f", "{{.Id}} {{.State.StartedAt}}", pylonId);
  await probe.close();
  await startTestProbe();
  const steps = await converge();
  assert.equal(steps[0]?.kind, "submit");
  assert.deepEqual(submitted(steps), ["spawn"]);
  assert.equal(await docker("inspect", "-f", "{{.Id}} {{.State.StartedAt}}", pylonId), before);
  assert.equal(await inContainer("cat", "/root/marker"), run);
});

test("a probe killed during a pause: the next ticks finish the pause", async () => {
  await probe.close();
  // The pause dies after `docker stop` and before `docker commit`, as if the probe crashed there.
  const stopped = Promise.withResolvers<void>();
  await startTestProbe({
    ...backend,
    async ensurePaused(id, _checkpoint, signal) {
      await docker("stop", id);
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
  assert.equal(await docker("inspect", "-f", "{{.State.Status}}", pylonId), "exited");
  assert.equal(await checkpointImage(checkpoint), "");

  await startTestProbe();
  const steps = await converge();
  assert.deepEqual(submitted(steps), ["pause"]);
  assert.deepEqual(await containers(), []);
  assert.notEqual(await checkpointImage(checkpoint), "");
});

test("deleted: no container and no checkpoint image remain", async () => {
  pylon.desired = "deleted";
  assert.deepEqual(submitted(await converge()), ["delete"]);
  assert.deepEqual(await containers(), []);
  assert.equal(await docker("images", "-q", "--filter", `label=nexus.pylon=${pylonId}`), "");
});
