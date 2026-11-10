import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { startImageRollout, type ImageRollout } from "./image-rollout.ts";
import type { ImageOperation } from "./image-store.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { weighNodes } from "./placement.ts";
import { backoffMs } from "./reconcile.ts";
import { imageIdOf, type ImageManifest, type ImageRecipe } from "../protocol/images.ts";
import type { ImageId, JobId, NodeName, TailnetNodeId } from "../ids.ts";
import type { JobEnvelope, JobErrorCode, JobStatus } from "../protocol/jobs.ts";
import type { BootInputs } from "../protocol/spawn.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { tempDir, testCapacity, testImage, testObservation, watch } from "../test-support/kit.ts";

const firebat = "rj-firebat" as NodeName;
const testbench = "infra-testbench" as NodeName;
const nuc = "rj-nuc" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const release = "c".repeat(40);
const { pins } = testImage();
const recipe: ImageRecipe = { files: [{ path: "Dockerfile", mode: 0o644, content: "FROM debian\n" }], pins };
const old = "img-000000000001" as ImageId;
const next = "img-000000000002" as ImageId;
const manifestOf = (id: ImageId, builtOn: NodeName): ImageManifest => ({
  id, gondolinBuildId: `gondolin-${id}`, builtOn, builtAt: "2027-01-01T00:00:00.000Z", sha256: createHash("sha256").update(`${id} on ${builtOn}`).digest("hex"), pins,
});

const dir = await tempDir("nexus-image-rollout-");

/**
 * Nodes as their probes present them, and as the reconcile loop records them. A job runs until the test finishes it.
 * One that succeeds puts the image in the node's store, which the node's next observation lists.
 */
function fakeNodes(registry: Registry, names: readonly NodeName[]) {
  const stores = new Map(names.map((name) => [name, new Map<ImageId, ImageManifest>()]));
  const jobs = new Map<JobId, { env: JobEnvelope; status: JobStatus }>();
  const submitted: JobEnvelope[] = [];
  for (const name of names) registry.nodes.upsertNode({ name, tailnetHost: `${name}.tail.ts.net`, tailnetNodeId: `n${name.toUpperCase()}` as TailnetNodeId });

  function observe(node: NodeName) {
    const capacity = testCapacity({ diskFreeGiB: 200 });
    registry.threads.apply({ record: "node", node, state: "online", capacity });
    registry.threads.ingested(testObservation(node, { capacity, artifacts: [...stores.get(node)!.keys()] }), []);
  }

  const probe = (node: NodeName): Pick<ProbeClient, "submit" | "job" | "manifest"> => ({
    async submit(env) {
      assert.equal(env.node, node);
      const known = jobs.get(env.jobId);
      if (known !== undefined) return { accepted: known.status };
      const subject = env.job.kind === "build-image" ? env.job.image : env.job.kind === "fetch-artifact" ? env.job.artifact : assert.fail(`unexpected ${env.job.kind}`);
      const busy = [...jobs.values()].find((j) => j.env.node === node && j.status.subject === subject && j.status.state === "running");
      if (busy !== undefined) return { rejected: "busy", inFlight: busy.env.jobId };
      const status: JobStatus = { jobId: env.jobId, subject, kind: env.job.kind, state: "running", startedAt: new Date().toISOString() };
      jobs.set(env.jobId, { env, status });
      submitted.push(env);
      return { accepted: status };
    },
    async job(jobId) {
      const known = jobs.get(jobId);
      return known?.env.node === node ? known.status : "unknown";
    },
    async manifest(artifact) { return stores.get(node)!.get(artifact as ImageId) ?? null; },
  });

  return {
    probes: new Map(names.map((name) => [name, probe(name)])),
    submitted,
    observe,
    /** The node holds the image from the start. */
    hold(node: NodeName, image: ImageId, builtOn: NodeName) {
      stores.get(node)!.set(image, manifestOf(image, builtOn));
      observe(node);
    },
    /** Ends the node's running job, and the next observation shows what it did. */
    finish(node: NodeName, failure?: { code: JobErrorCode; message: string; logTail: string }) {
      const entry = [...jobs.values()].find((j) => j.env.node === node && j.status.state === "running") ?? assert.fail(`${node} runs no job`);
      const { jobId, subject, kind } = entry.status;
      const ended = { jobId, subject, kind, finishedAt: new Date().toISOString() };
      entry.status = failure === undefined ? { ...ended, state: "succeeded" } : { ...ended, state: "failed", ...failure };
      const { job } = entry.env;
      if (failure === undefined && job.kind === "build-image") stores.get(node)!.set(job.image, manifestOf(job.image, node));
      if (failure === undefined && job.kind === "fetch-artifact") stores.get(node)!.set(job.artifact as ImageId, stores.get(job.from)!.get(job.artifact as ImageId)!);
      observe(node);
    },
  };
}

function setup(t: TestContext, names: readonly NodeName[]) {
  const clock = { now: Date.now(), advance(ms: number) { this.now += ms; } };
  const registry = openRegistry(join(dir, `${randomUUID()}.db`), () => clock.now);
  const nodes = fakeNodes(registry, names);
  const workers: ImageRollout[] = [];
  const logged: string[] = [];
  t.after(async () => {
    for (const worker of workers) await worker.close();
    registry.close();
  });
  /** A worker, as a control plane starts one. Its interval never fires within a test, so each pass is one the test asks for. */
  function start(runs = release, probes = nodes.probes): ImageRollout {
    const worker = startImageRollout({ registry, probes, buildNode: testbench, recipe: async () => recipe, release: runs, intervalMs: 600_000, log: (line) => logged.push(line) });
    workers.push(worker);
    return worker;
  }
  return { registry, nodes, start, logged, clock };
}

/** A registry where `old` is current on every node, and `next` is recorded and held only by the node that built it. */
function withTwoImages(t: TestContext, names: readonly NodeName[]) {
  const s = setup(t, names);
  s.registry.images.saveImage(manifestOf(old, testbench), null);
  s.registry.images.saveImage(manifestOf(next, testbench), release);
  s.registry.images.setCurrentImage(old);
  for (const node of names) s.nodes.hold(node, old, testbench);
  s.nodes.hold(testbench, next, testbench);
  return s;
}

const fetchOf = (image: ImageId) => ({ kind: "fetch-artifact", artifact: image, from: testbench, sha256: manifestOf(image, testbench).sha256 });
const stepsOf = (operation: ImageOperation | null) => operation?.steps.map((s) => [s.node, s.state, s.reason]);
const fetchesOf = (registry: Registry) => registry.images.imageFetches().map((f) => [f.node, f.image, f.state, f.failures, f.reason]);
const sentTo = (s: ReturnType<typeof setup>, node: NodeName) => s.nodes.submitted.filter((env) => env.node === node).map((env) => env.job);

/** What `auto` placement says of the node for a pylon of `image`: the room left there, or why it refuses it. */
function weighed(registry: Registry, node: NodeName, image: ImageId) {
  const need = {
    image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
    repo: { kind: "empty", branch: "main" }, dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" },
  } as unknown as Pick<BootInputs, "image" | "resources" | "network" | "repo" | "dotfiles">;
  const w = weighNodes(registry, need).weighed.find((n) => n.node === node);
  return w === undefined ? "unweighed" : "refused" in w ? w.refused : "fits";
}

/** A registry where `next` is current and held by `holders`, and every other node is registered but not yet observed. */
function withCurrent(t: TestContext, names: readonly NodeName[], holders: readonly NodeName[]) {
  const s = setup(t, names);
  s.registry.images.saveImage(manifestOf(next, testbench), release);
  s.registry.images.setCurrentImage(next);
  for (const node of holders) s.nodes.hold(node, next, testbench);
  return s;
}

test("a build sends build-image with the recipe to the build node and records the manifest it reads back with the release, and an unchanged recipe returns the recorded image at once", async (t) => {
  const s = setup(t, [firebat, testbench]);
  for (const node of [firebat, testbench]) s.nodes.observe(node);
  const worker = s.start();
  const image = imageIdOf(recipe);
  const started = await worker.build(laptop);
  assert.deepEqual([started.kind, started.image, started.state, started.requestedBy], ["build", image, "running", laptop]);
  await worker.wake();
  assert.deepEqual(s.nodes.submitted.map((env) => [env.node, env.job]), [[testbench, { kind: "build-image", image, recipe }]]);
  assert.deepEqual(stepsOf(s.registry.images.imageOperation()), [[testbench, "running", null]]);
  assert.equal(s.registry.images.image(image), undefined, "nothing is recorded while the build runs");

  s.nodes.finish(testbench);
  await worker.wake();
  assert.equal(s.registry.images.imageOperation()?.state, "done");
  assert.deepEqual(s.registry.images.image(image), { ...manifestOf(image, testbench), release });
  assert.equal(s.registry.images.currentImage(), null, "a build makes nothing current");

  const again = await worker.build(laptop);
  assert.deepEqual([again.state, stepsOf(again)], ["done", [[testbench, "done", "recorded already"]]]);
  await worker.wake();
  assert.equal(s.nodes.submitted.length, 1, "an unchanged recipe sends no job");
});

test("a build that a control plane of another release finishes records the release that sent it", async (t) => {
  const s = setup(t, [firebat, testbench]);
  for (const node of [firebat, testbench]) s.nodes.observe(node);
  const before = s.start();
  await before.build(laptop);
  await before.wake();
  await before.close();

  const deployed = "d".repeat(40);
  const after = s.start(deployed);
  s.nodes.finish(testbench);
  await after.wake();
  assert.equal(s.registry.images.imageOperation()?.state, "done");
  assert.equal(s.registry.images.image(imageIdOf(recipe))?.release, release, `not ${deployed}, the release that only finished it`);
  assert.equal(s.nodes.submitted.length, 1);
});

test("a rollout sends fetch-artifact with the recorded sha256 from a holder to each online node lacking the image, and makes it current only once the last one holds it", async (t) => {
  const s = withTwoImages(t, [firebat, testbench, nuc]);
  const worker = s.start();
  assert.equal(worker.rollout(next, laptop).state, "running");
  await worker.wake();
  assert.deepEqual(s.nodes.submitted.map((env) => [env.node, env.job]), [[firebat, fetchOf(next)], [nuc, fetchOf(next)]]);
  assert.deepEqual(stepsOf(s.registry.images.imageOperation()), [[testbench, "done", null], [firebat, "running", null], [nuc, "running", null]]);

  s.nodes.finish(firebat);
  await worker.wake();
  assert.equal(s.registry.images.currentImage(), old, "one node still lacks the image");
  assert.equal(s.registry.images.imageOperation()?.state, "running");

  s.nodes.finish(nuc);
  await worker.wake();
  assert.deepEqual([s.registry.images.currentImage(), s.registry.images.previousImage()], [next, old]);
  assert.equal(s.registry.images.imageOperation()?.state, "done");
  assert.deepEqual(stepsOf(s.registry.images.imageOperation()), [[testbench, "done", null], [firebat, "done", null], [nuc, "done", null]]);
  assert.equal(s.nodes.submitted.length, 2);
});

test("a failed fetch on one node fails the rollout with that node and the probe's reason, and leaves the current image", async (t) => {
  const s = withTwoImages(t, [firebat, testbench, nuc]);
  const worker = s.start();
  worker.rollout(next, laptop);
  await worker.wake();
  s.nodes.finish(firebat, { code: "backend", message: "the copy hashes to 0000, so it was thrown away", logTail: "tar: short read" });
  s.nodes.finish(nuc);
  await worker.wake();
  const failed = s.registry.images.imageOperation();
  assert.ok(failed?.state === "failed");
  assert.equal(failed.reason, `rj-firebat could not fetch ${next}: backend: the copy hashes to 0000, so it was thrown away\ntar: short read`);
  assert.deepEqual(stepsOf(failed)?.[1], [firebat, "failed", "backend: the copy hashes to 0000, so it was thrown away\ntar: short read"]);
  assert.deepEqual([s.registry.images.currentImage(), s.registry.images.previousImage()], [old, null]);
  assert.match(s.logged.join("\n"), /image rollout of img-000000000002 failed: rj-firebat could not fetch/);
});

test("a node that already holds the image under another sha256 fails the rollout, and the current image stays", async (t) => {
  const s = withTwoImages(t, [firebat, testbench]);
  s.nodes.hold(firebat, next, firebat);
  const worker = s.start();
  worker.rollout(next, laptop);
  await worker.wake();
  const failed = s.registry.images.imageOperation();
  assert.ok(failed?.state === "failed");
  assert.equal(failed.reason, `rj-firebat could not fetch ${next}: it holds ${next} with sha256 ${manifestOf(next, firebat).sha256}, not the recorded ${manifestOf(next, testbench).sha256}`);
  assert.equal(s.nodes.submitted.length, 0);
  assert.equal(s.registry.images.currentImage(), old);
});

test("rollback makes the previous image current again, and a second rollback goes forward", async (t) => {
  const s = withTwoImages(t, [firebat, testbench]);
  const worker = s.start();
  assert.throws(() => worker.rollback(laptop), { kind: "conflict", message: /no image was current before this one/ });
  s.nodes.hold(firebat, next, testbench);
  s.registry.images.setCurrentImage(next);

  assert.equal(worker.rollback(laptop).image, old);
  await worker.wake();
  assert.deepEqual([s.registry.images.currentImage(), s.registry.images.previousImage()], [old, next]);
  assert.equal(s.registry.images.imageOperation()?.state, "done");

  worker.rollback(laptop);
  await worker.wake();
  assert.deepEqual([s.registry.images.currentImage(), s.registry.images.previousImage()], [next, old]);
  assert.equal(s.nodes.submitted.length, 0, "every node held both images");
});

test("an offline node is skipped, and a worker that starts mid-rollout resumes from the saved job without sending a second", async (t) => {
  const s = withTwoImages(t, [firebat, testbench]);
  s.registry.nodes.upsertNode({ name: nuc, tailnetHost: "rj-nuc.tail.ts.net", tailnetNodeId: "nRJ-NUC" as TailnetNodeId });
  const first = s.start();
  const started = first.rollout(next, laptop);
  assert.deepEqual(stepsOf(started), [[testbench, "pending", null], [firebat, "pending", null], [nuc, "skipped", "offline when the rollout began; the control plane sends it the image once it is back online"]]);
  await first.wake();
  assert.equal(s.nodes.submitted.length, 1);
  await first.close();

  const second = s.start();
  await second.wake();
  assert.equal(s.nodes.submitted.length, 1, "the restarted worker asked the probe about the saved job");
  s.nodes.finish(firebat);
  await second.wake();
  assert.equal(s.registry.images.currentImage(), next, "a skipped node does not hold the rollout up");
  assert.deepEqual(stepsOf(s.registry.images.imageOperation()), [[testbench, "done", null], [firebat, "done", null], [nuc, "skipped", "offline when the rollout began; the control plane sends it the image once it is back online"]]);
});

test("a job the probe does not know is sent again only once its envelope has expired, and a node that goes offline fails the rollout", async (t) => {
  const s = withTwoImages(t, [firebat, testbench]);
  const sent = (job: { id: JobId; notAfter: string }) => s.registry.images.saveImageOperation({
    kind: "rollout", image: next, requestedBy: laptop, requestedAt: Date.now(), state: "running",
    steps: [{ node: testbench, state: "done", job: null, reason: null }, { node: firebat, state: "pending", job, reason: null }],
  });
  const worker = s.start();
  sent({ id: "on-its-way" as JobId, notAfter: new Date(Date.now() + 30_000).toISOString() });
  await worker.wake();
  await worker.wake();
  assert.equal(s.nodes.submitted.length, 0, "a send that may still reach the probe is waited for");

  const lost = { id: "lost" as JobId, notAfter: new Date(Date.now() - 1).toISOString() };
  sent(lost);
  await worker.wake();
  await worker.wake();
  assert.deepEqual(s.nodes.submitted.map((env) => [env.node, env.job]), [[firebat, fetchOf(next)]]);
  assert.notEqual(s.registry.images.imageOperation()?.steps[1]?.job?.id, lost.id);

  s.registry.nodes.markOffline(firebat);
  await worker.wake();
  const failed = s.registry.images.imageOperation();
  assert.ok(failed?.state === "failed");
  assert.equal(failed.reason, `rj-firebat went offline before it held ${next}`);
  assert.equal(s.registry.images.currentImage(), old);
});

test("one operation runs at a time, and one that no node could carry out is refused", async (t) => {
  const s = withTwoImages(t, [firebat, testbench]);
  const worker = s.start();
  s.registry.nodes.markOffline(testbench);
  assert.throws(() => worker.rollout(next, laptop), { kind: "conflict", message: `no online node holds ${next}, so no node could fetch it` });
  await assert.rejects(worker.build(laptop), { kind: "conflict", message: "the image build node infra-testbench is offline" });
  assert.throws(() => worker.rollout("img-ffffffffffff", laptop), { kind: "missing", message: "no image img-ffffffffffff is recorded" });

  s.nodes.observe(testbench);
  worker.rollout(next, laptop);
  assert.equal(worker.rollout(next, "nPHONE" as TailnetNodeId).requestedBy, laptop, "asking again returns the running rollout");
  assert.throws(() => worker.rollout(old, laptop), { kind: "conflict", message: `a rollout of ${next} is running. Wait for it to finish` });
  await assert.rejects(worker.build(laptop), { kind: "conflict", message: `a rollout of ${next} is running. Wait for it to finish` });
});

/**
 * A rollout whose fetch on rj-firebat runs, so each pass asks the probe about that job once. Once `hold` is called,
 * each lookup waits for the test to release it.
 */
async function heldRollout(t: TestContext) {
  const s = withTwoImages(t, [firebat, testbench]);
  const lookups: { began: PromiseWithResolvers<void>; released: PromiseWithResolvers<void> }[] = [];
  const nth = (i: number) => lookups[i] ??= { began: Promise.withResolvers(), released: Promise.withResolvers() };
  let count = 0;
  let holding = false;
  const probes = new Map([...s.nodes.probes].map(([node, probe]) => [node, {
    ...probe,
    async job(id: JobId) {
      const lookup = nth(count++);
      lookup.began.resolve();
      if (holding) await lookup.released.promise;
      return probe.job(id);
    },
  }]));
  const worker = s.start(release, probes);
  worker.rollout(next, laptop);
  await worker.wake();
  assert.deepEqual(stepsOf(s.registry.images.imageOperation()), [[testbench, "done", null], [firebat, "running", null]]);
  count = 0;
  lookups.length = 0;
  return {
    worker,
    get passes() { return count; },
    hold() { holding = true; },
    began: (i: number) => nth(i).began.promise,
    release: (i: number) => nth(i).released.resolve(),
    free() { holding = false; for (const lookup of lookups) lookup.released.resolve(); },
  };
}

test("wakes during a pass give exactly one more pass after it, and resolve once that pass has finished", async (t) => {
  const h = await heldRollout(t);
  h.hold();
  const first = h.worker.wake();
  await h.began(0);
  const second = watch(h.worker.wake());
  void h.worker.wake();
  void h.worker.wake();
  h.release(0);
  await Promise.race([h.began(1), first]);
  assert.equal(h.passes, 2, "another pass began after the one the wakes came during");
  assert.equal(await second(), false, "a wake waits for the pass that began after it");
  h.free();
  await first;
  assert.equal(await second(), true);
  assert.equal(h.passes, 2, "three wakes during one pass gave one more pass");
});

test("a wake after close resolves at once and runs no pass", async (t) => {
  const h = await heldRollout(t);
  await h.worker.close();
  await h.worker.wake();
  assert.equal(h.passes, 0);
});

test("close waits for the pass in flight, and a wake asked for during that pass runs no other", async (t) => {
  const h = await heldRollout(t);
  h.hold();
  const first = h.worker.wake();
  await h.began(0);
  void h.worker.wake();
  const closed = watch(h.worker.close());
  assert.equal(await closed(), false);
  h.free();
  await first;
  assert.equal(await closed(), true);
  assert.equal(h.passes, 1);
});

test("a pass that throws rejects its wakes, and the next wake runs a new pass", async (t) => {
  const s = setup(t, [testbench]);
  const worker = s.start();
  const imageOperation = s.registry.images.imageOperation;
  let reads = 0;
  s.registry.images.imageOperation = () => { reads++; throw new Error("database is locked"); };
  await Promise.all([
    assert.rejects(worker.wake(), /database is locked/),
    assert.rejects(worker.wake(), /database is locked/),
  ]);
  assert.equal(reads, 1, "the wake during the pass that threw ran no other");
  s.registry.images.imageOperation = () => { reads++; return imageOperation.call(s.registry); };
  await worker.wake();
  assert.equal(reads, 2);
});

test("a node that joins gets fetch-artifact of the current image from a holder, and auto placement passes over it only until it holds the image", async (t) => {
  const s = withCurrent(t, [firebat, testbench, nuc], [testbench, firebat]);
  const worker = s.start();
  await worker.wake();
  assert.deepEqual([s.nodes.submitted, fetchesOf(s.registry)], [[], []], "a node registered but never observed is not online");

  s.nodes.observe(nuc);
  assert.equal(weighed(s.registry, nuc, next), `does not hold image ${next}`);
  await worker.wake();
  assert.deepEqual(sentTo(s, nuc), [fetchOf(next)]);
  assert.deepEqual(fetchesOf(s.registry), [[nuc, next, "running", 0, null]]);
  await worker.wake();
  assert.equal(s.nodes.submitted.length, 1, "a running fetch is asked about, not sent again");

  s.nodes.finish(nuc);
  await worker.wake();
  assert.deepEqual(fetchesOf(s.registry), []);
  assert.equal(weighed(s.registry, nuc, next), "fits");
  assert.equal(s.nodes.submitted.length, 1);
});

test("a worker that starts mid-fetch asks the probe about the saved job, keeps the failures counted before it, and sends a job the probe lost only once its envelope expired", async (t) => {
  const s = withCurrent(t, [firebat, testbench, nuc], [testbench, firebat]);
  s.nodes.observe(nuc);
  const first = s.start();
  await first.wake();
  await first.close();

  const second = s.start();
  await second.wake();
  assert.equal(sentTo(s, nuc).length, 1, "the restarted worker asked the probe about the saved job");
  s.nodes.finish(nuc, { code: "backend", message: "the copy hashes to 0000", logTail: "" });
  await second.wake();
  await second.close();

  const third = s.start();
  await third.wake();
  assert.deepEqual([sentTo(s, nuc).length, fetchesOf(s.registry)[0]?.[3]], [1, 1], "the backoff and the count survive a restart");
  s.clock.advance(backoffMs(1));
  await third.wake();
  assert.equal(sentTo(s, nuc).length, 2);

  const [running] = s.registry.images.imageFetches();
  s.nodes.finish(nuc, { code: "backend", message: "ended so the probe runs no fetch of it", logTail: "" });
  s.registry.images.saveImageFetches([{ ...running!, job: { id: "on-its-way" as JobId, notAfter: new Date(Date.now() + 30_000).toISOString() } }]);
  await third.wake();
  assert.equal(sentTo(s, nuc).length, 2, "a send that may still reach the probe is waited for");
  s.registry.images.saveImageFetches([{ ...running!, job: { id: "lost" as JobId, notAfter: new Date(Date.now() - 1).toISOString() } }]);
  await third.wake();
  await third.wake();
  assert.deepEqual([sentTo(s, nuc).length, fetchesOf(s.registry)], [3, [[nuc, next, "running", 1, "backend: the copy hashes to 0000"]]]);
});

test("a node offline when a rollout began gets the image the rollout made current once it is back online, and then takes auto placements", async (t) => {
  const s = withTwoImages(t, [firebat, testbench, nuc]);
  s.registry.nodes.markOffline(nuc);
  const worker = s.start();
  worker.rollout(next, laptop);
  await worker.wake();
  s.nodes.finish(firebat);
  await worker.wake();
  assert.equal(s.registry.images.currentImage(), next);
  assert.deepEqual(stepsOf(s.registry.images.imageOperation())?.[2], [nuc, "skipped", "offline when the rollout began; the control plane sends it the image once it is back online"]);
  assert.deepEqual([sentTo(s, nuc), fetchesOf(s.registry)], [[], []], "nothing is sent to an offline node");

  s.nodes.observe(nuc);
  assert.equal(weighed(s.registry, nuc, next), `does not hold image ${next}`);
  await worker.wake();
  assert.deepEqual(sentTo(s, nuc), [fetchOf(next)]);
  s.nodes.finish(nuc);
  await worker.wake();
  assert.deepEqual(fetchesOf(s.registry), []);
  assert.equal(weighed(s.registry, nuc, next), "fits");
});

test("a failed fetch is sent again only after the backoff, 3 failures in a row stop it, and a node that comes back online or a new rollout gets a fresh run, while a busy reply counts for nothing", async (t) => {
  const s = withCurrent(t, [testbench, nuc], [testbench]);
  let busy = true;
  const probes = new Map([...s.nodes.probes].map(([node, probe]) => [node, node !== nuc ? probe : {
    ...probe,
    async submit(env: JobEnvelope) { return busy ? { rejected: "busy" as const, inFlight: "a-pylons-fetch" as JobId } : probe.submit(env); },
  }]));
  const worker = s.start(release, probes);
  const failure = { code: "backend" as const, message: "the copy hashes to 0000, so it was thrown away", logTail: "" };
  const reason = "backend: the copy hashes to 0000, so it was thrown away";
  s.nodes.observe(nuc);
  await worker.wake();
  assert.deepEqual([sentTo(s, nuc), fetchesOf(s.registry)], [[], [[nuc, next, "waiting", 0, null]]]);
  busy = false;
  await worker.wake();
  assert.equal(sentTo(s, nuc).length, 1, "a busy reply starts no backoff");

  s.nodes.finish(nuc, failure);
  await worker.wake();
  assert.deepEqual(fetchesOf(s.registry), [[nuc, next, "waiting", 1, reason]]);
  s.clock.advance(backoffMs(1) - 1);
  await worker.wake();
  assert.equal(sentTo(s, nuc).length, 1, "none is sent within the backoff");
  s.clock.advance(1);
  await worker.wake();
  assert.equal(sentTo(s, nuc).length, 2);
  assert.deepEqual(fetchesOf(s.registry), [[nuc, next, "running", 1, reason]]);

  s.nodes.finish(nuc, failure);
  await worker.wake();
  s.clock.advance(backoffMs(2));
  await worker.wake();
  assert.equal(sentTo(s, nuc).length, 3);
  s.nodes.finish(nuc, failure);
  await worker.wake();
  assert.deepEqual(fetchesOf(s.registry), [[nuc, next, "failed", 3, reason]]);
  assert.match(s.logged.join("\n"), new RegExp(`image fetch of ${next} to rj-nuc failed 3 times in a row`));
  s.clock.advance(60 * 60_000);
  await worker.wake();
  await worker.wake();
  assert.equal(sentTo(s, nuc).length, 3, "a node whose fetches failed 3 times gets no other");

  s.registry.nodes.markOffline(nuc);
  await worker.wake();
  assert.deepEqual(fetchesOf(s.registry), []);
  s.nodes.observe(nuc);
  await worker.wake();
  assert.equal(sentTo(s, nuc).length, 4, "a node back online gets a fresh run at once");
  s.nodes.finish(nuc, failure);
  await worker.wake();
  assert.deepEqual(fetchesOf(s.registry), [[nuc, next, "waiting", 1, reason]]);

  worker.rollout(next, laptop);
  assert.deepEqual(fetchesOf(s.registry), [], "a rollout begins with no fetch counted");
  await worker.wake();
  assert.deepEqual(stepsOf(s.registry.images.imageOperation())?.[1], [nuc, "running", null]);
  assert.equal(sentTo(s, nuc).length, 5);
});

test("no fetch of the current image goes out while a rollout runs, and once it is done the node gets the image the rollout made current", async (t) => {
  const s = setup(t, [firebat, testbench, nuc]);
  s.registry.images.saveImage(manifestOf(old, testbench), null);
  s.registry.images.saveImage(manifestOf(next, testbench), release);
  s.registry.images.setCurrentImage(old);
  for (const node of [firebat, testbench]) s.nodes.hold(node, old, testbench);
  s.nodes.hold(testbench, next, testbench);
  const worker = s.start();
  worker.rollout(next, laptop);
  s.nodes.observe(nuc);
  await worker.wake();
  await worker.wake();
  assert.deepEqual(s.nodes.submitted.map((env) => [env.node, env.job]), [[firebat, fetchOf(next)]], `rj-nuc lacks the current ${old}, and the rollout runs`);
  assert.deepEqual(fetchesOf(s.registry), []);

  s.nodes.finish(firebat);
  await worker.wake();
  assert.equal(s.registry.images.currentImage(), next);
  assert.deepEqual(sentTo(s, nuc), [fetchOf(next)]);
  assert.deepEqual(fetchesOf(s.registry), [[nuc, next, "running", 0, null]]);
});

test("a rollout that begins while a fetch is on its way to the probe keeps the records it cleared", async (t) => {
  const s = withCurrent(t, [testbench, nuc], [testbench]);
  const sending = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  const probes = new Map([...s.nodes.probes].map(([node, probe]) => [node, node !== nuc ? probe : {
    ...probe,
    async submit(env: JobEnvelope) {
      sending.resolve();
      await sent.promise;
      return probe.submit(env);
    },
  }]));
  const worker = s.start(release, probes);
  s.nodes.observe(nuc);
  const pass = worker.wake();
  await sending.promise;
  worker.rollout(next, laptop);
  sent.resolve();
  await pass;
  assert.deepEqual(fetchesOf(s.registry), []);
});
