/**
 * Templates and artifact copies end to end: two real probes on loopback, A and B, stand in for two nodes, each
 * with its own artifact store, and the test submits jobs to them as the control plane would. One body runs
 * against one backend fixture:
 *
 * - Docker (the default), against the local Docker. Everything it creates carries nexus.test=<run>, and cleanup
 *   removes only that. A template is a committed image, and its artifact that image's `docker save` archive.
 * - pylon-vm, when NEXUS_SLICE_BACKEND=pylon-vm, with NEXUS_PYLON_VM_IMAGE=<an image's directory in A's artifact
 *   store> and NEXUS_PYLON_VM_STATE=<A's state root, at most 37 bytes>. B's store and state root are fresh
 *   directories beside them, so B first fetches the image itself, and B's template boot runs on B's copy of it.
 *
 * A builds a template whose setup leaves a marker, and a template whose setup fails. A boots a pylon from the
 * template, pauses it and wakes it. B fetches the template, A drops its copy, and B boots a pylon from what it
 * fetched.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { artifactArchive } from "./artifacts.ts";
import { createDockerBackend } from "./docker-backend.ts";
import { createPylonVmBackend } from "./pylon-vm-backend.ts";
import { run as pylonVm } from "./pylon-vm/client.ts";
import { nodeSecrets } from "./probe/config.ts";
import { startProbe, type Probe } from "./probe/server.ts";
import { connectProbe, type Job, type JobStatus, type LiveHash, type NodeName, type ProbeClient, type PylonId, type TailnetNodeId } from "./protocol.ts";
import { envelope } from "./reconcile.ts";
import { templateIdOf, type CheckpointId, type ImageId, type TemplateBuildInputs, type TemplateId, type TemplateManifest } from "./images.ts";
import type { BootInputs, Checkout, ProjectId } from "./project.ts";
import type { Guest, VmBackend } from "./backend.ts";

const execFileAsync = promisify(execFile);

const run = randomUUID().slice(0, 8);
type Side = "a" | "b";
const nodes: Record<Side, NodeName> = { a: "tslice-a" as NodeName, b: "tslice-b" as NodeName };
const pylons: Record<Side, PylonId> = { a: `pylon-tslice-${run}-a` as PylonId, b: `pylon-tslice-${run}-b` as PylonId };
/** Every caller on loopback is both the control plane and the peer probe. Tests never ask tailscaled. */
const tailnetId = "nTSLICE" as TailnetNodeId;

interface TemplateFixture {
  image: ImageId;
  backends: Record<Side, VmBackend>;
  stores: Record<Side, string>;
  repo: TemplateBuildInputs["repo"];
  /** The pylon booted from the template checks out this, not the template's commit. */
  checkout: Checkout;
  resources: BootInputs["resources"];
  allowedHosts: readonly string[];
  /** Leaves `run` in marker, where a guest exec as the pylon's user reads it. */
  preSetup: string;
  marker: string;
  cwd: string;
  /** B starts with an empty store, so it fetches the image first. */
  imageOnlyOnA: boolean;
  /** Why A refuses to drop its image while its pylon runs. Docker's images are configured, so it refuses every image drop. */
  imageDropRefusal: RegExp;
  /** A template boot fetches and checks out the pylon's commit. The Docker double clones nothing. */
  checksOut: boolean;
  checkTemplateBoot(guest: Guest, side: Side): Promise<void>;
  /** Leaves work in the pylon that a wake must keep, and that a rerun setup would undo. */
  leaveWork(guest: Guest): Promise<void>;
  checkWork(guest: Guest): Promise<void>;
  checkImageCopy(): Promise<void>;
  setUp(): Promise<void>;
  cleanUp(): Promise<void>;
}

async function dockerFixture(): Promise<TemplateFixture> {
  const docker = async (...args: string[]) => (await execFileAsync("docker", args)).stdout.trim();
  const baseImage = "debian:bookworm-slim";
  const image: ImageId = "img-tslicetest000";
  const testLabel = `nexus.test=tslice-${run}`;
  const scratch = await mkdtemp(join(tmpdir(), "nexus-tslice-"));
  const stores = { a: join(scratch, "a"), b: join(scratch, "b") };
  const backend = (side: Side) => createDockerBackend({ images: { [image]: baseImage }, labels: { "nexus.test": `tslice-${run}`, "nexus.side": side }, artifacts: stores[side] });
  return {
    image,
    backends: { a: backend("a"), b: backend("b") },
    stores,
    repo: { url: "git@example.com:tslice.git", branch: "main", commit: "0000000" },
    checkout: { branch: "main", commit: "0000000" },
    resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 },
    allowedHosts: [],
    preSetup: `echo ${run} > /root/template-marker`,
    marker: "/root/template-marker",
    cwd: "/",
    imageOnlyOnA: false,
    imageDropRefusal: /neither copied nor dropped/,
    checksOut: false,
    async checkTemplateBoot() {},
    async leaveWork(guest) {
      assert.equal((await guest.exec(["sh", "-c", `echo ${run} > /root/work`], { cwd: "/", timeoutMs: 30_000 })).exitCode, 0);
    },
    async checkWork(guest) {
      assert.deepEqual(await guest.exec(["cat", "/root/work"], { cwd: "/", timeoutMs: 30_000 }), { exitCode: 0, output: `${run}\n`, truncated: false });
    },
    async checkImageCopy() {},
    async setUp() {
      if (await docker("images", "-q", "--filter", `reference=${baseImage}`) === "") await docker("pull", baseImage);
    },
    async cleanUp() {
      const ids = (await docker("ps", "-a", "-q", "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
      if (ids.length > 0) await docker("rm", "--force", ...ids);
      for (;;) {
        const images = (await docker("images", "-q", "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
        if (images.length === 0) break;
        await docker("rmi", "--force", images[0]!);
      }
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

async function pylonVmFixture(): Promise<TemplateFixture> {
  const assets = process.env["NEXUS_PYLON_VM_IMAGE"];
  const stateRoot = process.env["NEXUS_PYLON_VM_STATE"];
  if (!assets || !stateRoot) throw new Error("NEXUS_SLICE_BACKEND=pylon-vm needs NEXUS_PYLON_VM_IMAGE and NEXUS_PYLON_VM_STATE");
  const image = basename(assets) as ImageId;
  const stores = { a: dirname(assets), b: `${dirname(assets)}-tslice-${run}` };
  const states = { a: stateRoot, b: `${stateRoot}-b` };
  const secrets = { value: () => undefined, names: () => [] };
  const backend = (side: Side) => createPylonVmBackend({ stateRoot: states[side], artifacts: stores[side], secrets });
  const home = "/home/user";
  const repoDir = `${home}/workspace/repo`;
  const sh = (guest: Guest, script: string, cwd = repoDir) => guest.exec(["sh", "-c", script], { cwd, timeoutMs: 30_000 });
  return {
    image,
    backends: { a: backend("a"), b: backend("b") },
    stores,
    // The template is built at master's first parent, and its pylons check out master itself.
    repo: { url: "https://github.com/octocat/Hello-World.git", branch: "master", commit: "553c2077f0edc3d5dc5d17262f6aa498e69d6f8e" },
    checkout: { branch: "nexus-tslice", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" },
    resources: { cpus: 2, memoryGiB: Number(process.env["NEXUS_PYLON_VM_MEMORY_GIB"] ?? 4), diskGiB: 8 },
    allowedHosts: ["github.com"],
    preSetup: `echo ${run} > ${home}/template-marker && mkdir -p .nexus && printf '#!/bin/sh\\necho resumed >> ${home}/resume.log\\n' > .nexus/resume && chmod +x .nexus/resume`,
    marker: `${home}/template-marker`,
    cwd: home,
    imageOnlyOnA: true,
    imageDropRefusal: /still needed by pylon /,
    checksOut: true,
    async checkTemplateBoot(guest, side) {
      assert.deepEqual(await sh(guest, "git rev-parse HEAD && git symbolic-ref --short HEAD"), { exitCode: 0, output: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d\nnexus-tslice\n", truncated: false }, "the pylon checked out its own commit");
      assert.deepEqual(await sh(guest, "cat resume.log", home), { exitCode: 0, output: "resumed\n", truncated: false }, "the template's first boot ran .nexus/resume once");
      const disk = join(states[side], "instances", pylons[side], "disk.qcow2");
      const info = JSON.parse((await execFileAsync("qemu-img", ["info", "--output=json", "-U", disk])).stdout) as { "full-backing-filename"?: string };
      assert.equal(info["full-backing-filename"], join(stores[side], image, "rootfs.ext4"), "the pylon's disk is backed by its own node's copy of the image");
    },
    async leaveWork(guest) {
      const commit = "git -c user.name=tslice -c user.email=tslice@example.com commit --allow-empty --quiet -m 'work since the boot'";
      assert.equal((await sh(guest, `${commit} && git rev-parse HEAD > ${home}/work-head`)).exitCode, 0);
    },
    async checkWork(guest) {
      const head = (await sh(guest, `cat ${home}/work-head`)).output;
      assert.notEqual(head, "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d\n");
      assert.deepEqual(await sh(guest, "git rev-parse HEAD && git symbolic-ref --short HEAD"), { exitCode: 0, output: `${head}nexus-tslice\n`, truncated: false }, "the wake kept the commit made after the checkout, so setup did not run again");
      assert.deepEqual(await sh(guest, "cat resume.log", home), { exitCode: 0, output: "resumed\nresumed\n", truncated: false }, "the wake ran .nexus/resume");
      const marker = await sh(guest, "cat /var/lib/pi-sandbox/setup.json", home);
      assert.ok(marker.exitCode === 0 && JSON.parse(marker.output).instance === pylons.a && JSON.parse(marker.output).setupError === undefined, JSON.stringify(marker));
    },
    async checkImageCopy() {
      const manifest = JSON.parse(await readFile(join(stores.b, image, "image.json"), "utf8")) as { sha256: string };
      const hash = createHash("sha256");
      for await (const chunk of artifactArchive(join(stores.b, image), "image.json")) hash.update(chunk as Buffer);
      assert.equal(hash.digest("hex"), manifest.sha256, "B's copy of the image archives to the same bytes, so B can serve it on");
    },
    async setUp() {
      assert.ok(existsSync(join(assets, "manifest.json")) && existsSync(join(assets, "image.json")), `${assets} is not a published image`);
      await mkdir(states.b, { recursive: true, mode: 0o700 });
    },
    async cleanUp() {
      for (const side of ["a", "b"] as const) {
        const dir = join(states[side], "instances", pylons[side]);
        if (!existsSync(dir)) continue;
        console.error((await pylonVm(states[side], { action: "logs", name: pylons[side], lines: 200 }) as { output: string }).output);
        await pylonVm(states[side], { action: "destroy", kind: "instances", name: pylons[side], confirm: pylons[side] });
      }
      for (const template of [built, broken]) {
        await pylonVm(states.a, { action: "destroy", kind: "templates", name: template, confirm: template });
        await rm(join(stores.a, template), { recursive: true, force: true });
      }
      await rm(stores.b, { recursive: true, force: true });
      await rm(states.b, { recursive: true, force: true });
    },
  };
}

const fixture = process.env["NEXUS_SLICE_BACKEND"] === "pylon-vm" ? await pylonVmFixture() : await dockerFixture();
const project = `tslice-${run}` as ProjectId;
const key = { project, image: fixture.image, setupHash: createHash("sha256").update(run).digest("hex") };
const built: TemplateId = templateIdOf(key, nodes.a, Date.now());
const broken: TemplateId = templateIdOf({ ...key, setupHash: createHash("sha256").update(`${run} broken`).digest("hex") }, nodes.a, Date.now());
const inputs = (preSetup: string): TemplateBuildInputs => ({ key, repo: fixture.repo, preSetup, allowedHosts: fixture.allowedHosts, resources: fixture.resources });

const probes = {} as Record<Side, Probe>;
const clients = {} as Record<Side, ProbeClient>;

before(async () => {
  await fixture.setUp();
  for (const side of ["a", "b"] as const) {
    probes[side] = await startProbe({
      node: nodes[side], host: "127.0.0.1", port: 0,
      auth: { controlPlane: tailnetId, peers: [tailnetId] },
      whois: async () => tailnetId,
      backend: fixture.backends[side],
      secrets: nodeSecrets({ value: () => undefined, names: () => [] }),
      peerAddress: (peer) => {
        assert.equal(peer, nodes.a, "only A holds what B fetches");
        return { host: "127.0.0.1", port: probes.a.port };
      },
    });
    clients[side] = connectProbe(nodes[side], "127.0.0.1", tailnetId, { port: probes[side].port, whois: async () => tailnetId });
  }
});

after(async () => {
  await Promise.all([probes.a?.close(), probes.b?.close()]);
  await fixture.cleanUp();
});

async function runJob(side: Side, job: Job): Promise<JobStatus> {
  const env = envelope(job, nodes[side], Date.now());
  const reply = await clients[side].submit(env);
  assert.ok("accepted" in reply, JSON.stringify(reply));
  for (;;) {
    const status = await clients[side].job(env.jobId);
    if (status !== "unknown" && status.state !== "running") return status;
    await delay(250);
  }
}

const succeeded = async (side: Side, job: Job) => {
  const status = await runJob(side, job);
  assert.equal(status.state, "succeeded", JSON.stringify(status));
};
const held = async (side: Side) => fixture.backends[side].artifacts.list();
const manifestOn = async (side: Side, id: TemplateId | ImageId) =>
  JSON.parse(await readFile(join(fixture.stores[side], id, id.startsWith("tpl-") ? "template.json" : "image.json"), "utf8")) as { sha256: string };

/** A first boot from `template`. A wake boots from the pylon's checkpoint, as the control plane asks once it is stopped. */
function spawn(side: Side, template: TemplateId, source: BootInputs["source"] = { kind: "template", template }): Job {
  const boot: BootInputs = {
    pylonId: pylons[side], image: fixture.image, source, resources: fixture.resources,
    network: { allowedHosts: fixture.allowedHosts, secrets: [] },
    repo: { kind: "clone", url: fixture.repo.url, checkout: fixture.checkout },
    dotfiles: { repo: "https://dotfiles.invalid/common.git", ref: "main" },
  };
  return { kind: "spawn", pylonId: pylons[side], boot, live: { previews: [], overlay: [] }, liveHash: `tslice-${side}` as LiveHash };
}

const marker = (side: Side) => fixture.backends[side].guest(pylons[side]).exec(["cat", fixture.marker], { cwd: fixture.cwd, timeoutMs: 30_000 });

test("build-template runs setup once and publishes the template, and a second build of its ID is a no-op", async () => {
  await succeeded("a", { kind: "build-template", template: built, inputs: inputs(fixture.preSetup) });
  assert.ok((await held("a")).includes(built));
  const manifest = await manifestOn("a", built) as TemplateManifest;
  assert.deepEqual([manifest.id, manifest.key, manifest.commit], [built, key, fixture.repo.commit]);
  await succeeded("a", { kind: "build-template", template: built, inputs: inputs(fixture.preSetup) });
  assert.deepEqual(await manifestOn("a", built), manifest);
});

test("a setup that fails publishes nothing and reports setup-failed with its output", async () => {
  const status = await runJob("a", { kind: "build-template", template: broken, inputs: inputs("echo nexus-broken-setup; exit 3") });
  assert.ok(status.state === "failed" && status.code === "setup-failed", JSON.stringify(status));
  assert.match(status.logTail, /nexus-broken-setup/);
  assert.ok(!(await held("a")).includes(broken));
});

test("a template boot whose checkout cannot fetch is retryable and leaves no instance", { skip: !fixture.checksOut && "this backend checks nothing out" }, async () => {
  const job = spawn("a", built) as Extract<Job, { kind: "spawn" }>;
  const offline: Job = { ...job, boot: { ...job.boot, network: { allowedHosts: [], secrets: [] } } };
  const status = await runJob("a", offline);
  assert.ok(status.state === "failed" && status.code === "backend" && /could not check out its commit/.test(status.message), JSON.stringify(status));
  assert.ok(!(await fixture.backends.a.list()).some((p) => p.pylonId === pylons.a), "the failed instance was removed, so the next spawn boots from the template again");
});

test("a pylon boots from the template with what its setup left", async () => {
  await succeeded("a", spawn("a", built));
  assert.deepEqual(await marker("a"), { exitCode: 0, output: `${run}\n`, truncated: false });
  await fixture.checkTemplateBoot(fixture.backends.a.guest(pylons.a), "a");
});

test("a pause and a wake keep the pylon's work, and its setup does not run again", async () => {
  await fixture.leaveWork(fixture.backends.a.guest(pylons.a));
  const checkpoint = `ckpt-tslice-${run}-1` as CheckpointId;
  await succeeded("a", { kind: "pause", pylonId: pylons.a, checkpoint });
  assert.equal((await fixture.backends.a.list()).find((p) => p.pylonId === pylons.a)?.vm, "stopped");
  await succeeded("a", spawn("a", built, { kind: "resume", checkpoint }));
  await fixture.checkWork(fixture.backends.a.guest(pylons.a));
});

test("a peer refuses a copy whose sha256 differs from the job's, and keeps nothing of it", async () => {
  const status = await runJob("b", { kind: "fetch-artifact", artifact: built, from: nodes.a, sha256: "0".repeat(64) });
  assert.ok(status.state === "failed" && status.code === "invalid", JSON.stringify(status));
  assert.ok(!(await held("b")).includes(built));
});

test("fetch-artifact copies the image and the template to a peer, which verifies each", async () => {
  if (fixture.imageOnlyOnA) {
    await succeeded("b", { kind: "fetch-artifact", artifact: fixture.image, from: nodes.a, sha256: (await manifestOn("a", fixture.image)).sha256 });
    assert.deepEqual(await manifestOn("b", fixture.image), await manifestOn("a", fixture.image));
    await fixture.checkImageCopy();
  }
  await succeeded("b", { kind: "fetch-artifact", artifact: built, from: nodes.a, sha256: (await manifestOn("a", built)).sha256 });
  assert.ok((await held("b")).includes(built));
  assert.deepEqual(await manifestOn("b", built), await manifestOn("a", built));
});

test("drop-artifact removes A's template, and refuses the image A's pylon still needs", async () => {
  await succeeded("a", { kind: "drop-artifact", artifact: built });
  assert.ok(!(await held("a")).includes(built));
  const image = await runJob("a", { kind: "drop-artifact", artifact: fixture.image });
  assert.ok(image.state === "failed" && image.code === "invalid" && fixture.imageDropRefusal.test(image.message), JSON.stringify(image));
  assert.ok((await held("a")).includes(fixture.image));
});

test("the peer boots a pylon from its own copy of the template", async () => {
  await succeeded("b", spawn("b", built));
  assert.deepEqual(await marker("b"), { exitCode: 0, output: `${run}\n`, truncated: false });
  await fixture.checkTemplateBoot(fixture.backends.b.guest(pylons.b), "b");
});

test("deleting both pylons leaves the stores as they were", async () => {
  await succeeded("a", { kind: "delete", pylonId: pylons.a });
  await succeeded("b", { kind: "delete", pylonId: pylons.b });
  assert.deepEqual((await fixture.backends.a.list()).filter((p) => p.pylonId === pylons.a), []);
  assert.deepEqual((await fixture.backends.b.list()).filter((p) => p.pylonId === pylons.b), []);
  assert.ok((await held("b")).includes(built), "a template outlives the pylons booted from it");
});
