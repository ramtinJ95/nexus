import { test } from "node:test";
import { connect } from "node:net";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createServer, request } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProbe, type Probe, type ProbeOptions } from "./server.ts";
import { nodeSecrets, parseSecretsEnv } from "./config.ts";
import { connectProbe, fetchArtifact, jobDeadlineMs, type ByteStream, type DeclaredOutput, type GitFacts, type Job, type JobEnvelope, type JobId, type JobStatus, type LiveHash, type NodeName, type ProbeEvent, type CommandResult, type PylonCommand, type PylonId, type ServiceFact, type TailnetNodeId } from "../protocol.ts";
import { envelope, ingest } from "../reconcile.ts";
import { processStream } from "../process-stream.ts";
import { commandPolicies, JobFailure, type BackendPylon, type CommandPolicy, type Guest, type VmBackend } from "../backend.ts";
import { fakeTailscale, nodeHost, viaGateway } from "./fake-tailscale.ts";
import type { BootInputs, ProjectId } from "../project.ts";
import type { ArtifactId, ArtifactManifest, ImageId, ImageManifest, PortableArtifactId, TemplateId, TemplateManifest } from "../images.ts";
import { fakeGuest, herdrError, herdrOk, herdrPane, herdrSnapshot } from "../fake-guest.ts";
import { outputsDir } from "../outputs.ts";
import { sessionsFile } from "../sessions.ts";
import { gitPollMs } from "../git-facts.ts";
import { checkoutReader } from "../checkout-files.ts";
import type { HostBridge, HostBridgeAnswer } from "./pylon-api.ts";

const node = "test-node" as NodeName;
const controlPlane = "nCONTROL" as TailnetNodeId;
const peer = "nPEER" as TailnetNodeId;
const probeNodeId = "nPROBE" as TailnetNodeId;
const pylonId = "pylon-unit" as PylonId;
const image: ImageId = "img-000000000000";
const boot: BootInputs = {
  pylonId, image, source: { kind: "fresh", preSetup: null },
  resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 },
  network: { allowedHosts: [], secrets: [] },
  repo: { kind: "clone", url: "git@example.com:r.git", checkout: { branch: "main", commit: "c0ffee" } },
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
};
const spawnJob: Job = { kind: "spawn", pylonId, boot, live: { previews: [], overlay: [] }, liveHash: "hash-1" as LiveHash };
const template: TemplateId = "tpl-000000000000";
const templateManifest = (sha256: string): TemplateManifest => ({
  id: template, key: { project: "p" as ProjectId, image, setupHash: "h" }, commit: "c0ffee", builtAt: "2027-01-01T00:00:00.000Z", sha256,
});

/** An in-memory backend. `gate` holds every lifecycle call until it is released or the job's signal aborts. */
function fakeBackend(guest: Guest | null = null) {
  const pylons = new Map<PylonId, BackendPylon>();
  const calls: string[] = [];
  const offered = new Map<PortableArtifactId, { manifest: ArtifactManifest; body: string }>();
  const imported = new Map<PortableArtifactId, { manifest: ArtifactManifest; body: string }>();
  /** Each secret update the backend was asked for, and the pylons it then fails to reach. */
  const secretUpdates: [string, string][] = [];
  const unreachable: PylonId[] = [];
  const relaunches: boolean[] = [];
  let gate: PromiseWithResolvers<void> | null = null;
  const held = (signal: AbortSignal) => gate === null ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    gate!.promise.then(resolve);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const backend: VmBackend = {
    async ensureRunning(b, _live, signal, relaunch) {
      relaunches.push(relaunch ?? true);
      await held(signal);
      pylons.set(b.pylonId, { pylonId: b.pylonId, vm: "running", checkpoint: null, image: b.image, bootedAt: "2027-01-01T00:00:00Z" });
    },
    async ensurePaused(id, checkpoint, signal) {
      await held(signal);
      pylons.set(id, { pylonId: id, vm: "stopped", checkpoint, image, bootedAt: null, sessions: null });
    },
    async ensureDeleted(id, signal) {
      await held(signal);
      pylons.delete(id);
    },
    async list() { return [...pylons.values()]; },
    async buildTemplate(id) { calls.push(`build-template ${id}`); },
    async buildImage(id, _recipe, on) { calls.push(`build-image ${id} on ${on}`); },
    guest: () => { if (guest === null) throw new Error("this test has no guest"); return guest; },
    async updateSecret(name, value) {
      secretUpdates.push([name, value]);
      return unreachable.map((id) => ({ pylonId: id, reason: "its controller did not answer" }));
    },
    artifacts: {
      list: async (listed) => [image, ...offered.keys(), ...imported.keys(), ...listed.flatMap((p) => p.vm === "stopped" && p.checkpoint !== null ? [p.checkpoint] : [])],
      manifest: async (id) => imported.get(id)?.manifest ?? offered.get(id)?.manifest ?? null,
      async export(id) {
        const held = offered.get(id) ?? assert.fail(`export of ${id}, which the fake does not hold`);
        return { manifest: held.manifest, stream: Readable.from([Buffer.from(held.body)]) };
      },
      async import(manifest, stream) { imported.set(manifest.id, { manifest, body: Buffer.concat(await stream.toArray()).toString() }); },
      async drop(id) { calls.push(`drop ${id}`); },
    },
  };
  return {
    backend, pylons, calls, imported, secretUpdates, unreachable, relaunches,
    offer(manifest: ArtifactManifest, body: string) { offered.set(manifest.id, { manifest, body }); },
    hold() { gate = Promise.withResolvers(); }, release() { gate?.resolve(); gate = null; },
  };
}

async function setup(t: import("node:test").TestContext, overrides: Partial<ProbeOptions> = {}, guest: Guest | null = null) {
  const fake = fakeBackend(guest);
  let caller: TailnetNodeId | null = controlPlane;
  const probe: Probe = await startProbe({
    node, host: "127.0.0.1", port: 0,
    auth: { controlPlane, peers: [peer] },
    whois: async () => caller,
    backend: fake.backend,
    secrets: nodeSecrets({ value: () => undefined, names: () => [] }),
    ...overrides,
  });
  t.after(() => probe.close());
  const client = connectProbe(node, "127.0.0.1", probeNodeId, { port: probe.port, whois: async () => probeNodeId });
  const base = `http://127.0.0.1:${probe.port}`;
  return { fake, probe, client, base, callAs(id: TailnetNodeId | null) { caller = id; } };
}

async function finished(client: ReturnType<typeof connectProbe>, jobId: JobId): Promise<JobStatus> {
  for (;;) {
    const status = await client.job(jobId);
    assert.notEqual(status, "unknown");
    if (status !== "unknown" && status.state !== "running") return status;
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("callers that are not the configured node get 403", async (t) => {
  const { base, callAs } = await setup(t);
  callAs(null);
  assert.equal((await fetch(`${base}/v1/jobs/x`)).status, 403);
  callAs(peer);
  assert.equal((await fetch(`${base}/v1/jobs/x`)).status, 403);
  assert.equal((await fetch(`${base}/v1/observe`)).status, 403);
  assert.equal((await fetch(`${base}/v1/artifacts/img-1`)).status, 400, "a fetch names the sha256 it wants");
  assert.equal((await fetch(`${base}/v1/artifacts/img-1?sha256=${"0".repeat(64)}`)).status, 404, "a peer may reach the artifacts route, and this node holds no img-1");
  callAs(controlPlane);
  assert.equal((await fetch(`${base}/v1/artifacts/img-1`)).status, 403);
  assert.equal((await fetch(`${base}/v1/jobs/x`)).status, 404);
});

test("the client refuses a probe that whois does not name", async (t) => {
  const { probe } = await setup(t);
  const impostor = connectProbe(node, "127.0.0.1", probeNodeId, { port: probe.port, whois: async () => "nOTHER" as TailnetNodeId });
  await assert.rejects(impostor.job("x" as JobId), { code: "forbidden" });
});

test("the client sends nothing, not even the request line, to a peer that whois does not name", async (t) => {
  const received: Buffer[] = [];
  const closed = Promise.withResolvers<void>();
  const server = createServer();
  server.on("connection", (socket) => socket.on("data", (chunk: Buffer) => received.push(chunk)).on("close", () => closed.resolve()));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const impostor = connectProbe(node, "127.0.0.1", probeNodeId, { port, whois: async () => "nOTHER" as TailnetNodeId });
  await assert.rejects(impostor.putSecret("NEXUS_CHATGPT_TOKEN", "a-real-looking-token"), { code: "forbidden" });
  await closed.promise;
  assert.equal(Buffer.concat(received).length, 0, "the other node received no bytes");
});

test("a repeated jobId returns the job's current status", async (t) => {
  const { client, fake } = await setup(t);
  fake.hold();
  const env = envelope(spawnJob, node, Date.now());
  const first = await client.submit(env);
  assert.ok("accepted" in first && first.accepted.state === "running");
  assert.deepEqual(await client.submit(env), first);
  fake.release();
  const status = await finished(client, env.jobId);
  assert.equal(status.state, "succeeded");
  assert.deepEqual(await client.submit(env), { accepted: status });
  // An old envelope that the probe already accepted still answers with its status, not "expired".
  assert.deepEqual(await client.submit({ ...env, notAfter: new Date(Date.now() - 1).toISOString() }), { accepted: status });
});

test("one job per subject: a second gets busy", async (t) => {
  const { client, fake } = await setup(t);
  fake.hold();
  const pause = envelope({ kind: "pause", pylonId, checkpoint: "ckpt-unit-1" }, node, Date.now());
  await client.submit(pause);
  assert.deepEqual(await client.submit(envelope({ kind: "delete", pylonId }, node, Date.now())), { rejected: "busy", inFlight: pause.jobId });
  fake.release();
  assert.equal((await finished(client, pause.jobId)).state, "succeeded");
  const del = envelope({ kind: "delete", pylonId }, node, Date.now());
  assert.ok("accepted" in await client.submit(del));
});

test("an expired envelope is rejected and not recorded", async (t) => {
  const { client } = await setup(t);
  const env = envelope(spawnJob, node, Date.now() - 31_000);
  assert.deepEqual(await client.submit(env), { rejected: "expired" });
  assert.equal(await client.job(env.jobId), "unknown");
});

test("malformed envelopes and envelopes for another node are invalid", async (t) => {
  const { client, base } = await setup(t);
  const other = envelope(spawnJob, "elsewhere" as NodeName, Date.now());
  assert.deepEqual(await client.submit(other), { rejected: "invalid", message: `envelope is for elsewhere, this probe is ${node}` });
  const res = await fetch(`${base}/v1/jobs/abc`, { method: "PUT", body: JSON.stringify({ jobId: "abc" }) });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { rejected: string }).rejected, "invalid");
});

test("build and drop jobs reach the backend, and one that names a checkpoint or a path is refused at the door", async (t) => {
  const { client, fake } = await setup(t);
  const recipe = { files: [], pins: {} } as unknown as Extract<Job, { kind: "build-image" }>["recipe"];
  const inputs = { key: templateManifest("0".repeat(64)).key } as Extract<Job, { kind: "build-template" }>["inputs"];
  for (const job of [{ kind: "drop-artifact", artifact: image }, { kind: "build-template", template, inputs }, { kind: "build-image", image, recipe }] satisfies Job[]) {
    const env: JobEnvelope = envelope(job, node, Date.now());
    assert.ok("accepted" in await client.submit(env));
    assert.equal((await finished(client, env.jobId)).state, "succeeded", job.kind);
  }
  assert.deepEqual(fake.calls, [`drop ${image}`, `build-template ${template}`, `build-image ${image} on ${node}`]);
  const checkpoint = envelope({ kind: "drop-artifact", artifact: "ckpt-unit-1" } as unknown as Job, node, Date.now());
  assert.deepEqual(await client.submit(checkpoint), { rejected: "invalid", message: "envelope.job.artifact: expected an image or template ID, and no job drops a checkpoint" });
  const outside = [
    { kind: "drop-artifact", artifact: "tpl-x/../../pylons" },
    { kind: "fetch-artifact", artifact: "img-x/..", from: node, sha256: "0".repeat(64) },
    { kind: "build-template", template: "tpl-..", inputs },
    { kind: "build-image", image: "img-a/b", recipe },
    { ...spawnJob, boot: { ...spawnJob.boot, source: { kind: "template", template: "tpl-../../x" } } },
  ];
  for (const job of outside) {
    const reply = await client.submit(envelope(job as unknown as Job, node, Date.now()));
    assert.ok("rejected" in reply && reply.rejected === "invalid" && /^envelope\.job\.[a-z.]+: expected an? (image or template|template|image|artifact) ID/.test(reply.message ?? ""), JSON.stringify(reply));
  }
  assert.equal(fake.calls.length, 3, "nothing outside the store reached the backend");
});

test("a peer probe fetches an artifact as its manifest in a header and its archive as the body, and other bytes are refused unsent", async (t) => {
  const logged: string[] = [];
  const { probe, fake, callAs } = await setup(t, { log: (line) => logged.push(line) });
  const manifest = templateManifest("a".repeat(64));
  fake.offer(manifest, "archive bytes");
  const fetchAs = (answering: TailnetNodeId, artifact: PortableArtifactId = template, sha256 = manifest.sha256) =>
    fetchArtifact({ host: "127.0.0.1", port: probe.port }, artifact, sha256, { whois: async () => answering, peers: [probeNodeId] }, AbortSignal.timeout(5_000));
  callAs(peer);
  const copy = await fetchAs(probeNodeId);
  assert.ok("manifest" in copy);
  assert.deepEqual(copy.manifest, manifest);
  assert.equal(Buffer.concat(await copy.stream.toArray()).toString(), "archive bytes");
  const refusal = `this node holds ${template} with sha256 ${"a".repeat(64)}, and the fetch asks for ${"f".repeat(64)}`;
  assert.deepEqual(await fetchAs(probeNodeId, template, "f".repeat(64)), { refused: refusal });
  assert.deepEqual(logged.filter((line) => line.startsWith("artifact ")), [`artifact ${template}: refused a copy: ${refusal}`], "a refusal is logged with its reason, and no copy broke off");
  await assert.rejects(fetchAs("nOTHER" as TailnetNodeId), { code: "forbidden" }, "the fetching probe checks who answered");
  await assert.rejects(fetchAs(probeNodeId, "tpl-ffffffffffff"), /HTTP 404: this node holds no image or template tpl-ffffffffffff/);
  callAs(controlPlane);
  await assert.rejects(fetchAs(probeNodeId), /HTTP 403/, "only a peer probe may copy artifacts");
});

test("the control plane reads the manifest of an artifact the node holds, and a peer may not", async (t) => {
  const { client, fake, base, callAs } = await setup(t);
  const built: ImageManifest = {
    id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00.000Z", sha256: "a".repeat(64),
    pins: { debianDigest: "d", node: "24.22.1", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s", gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "g", neovim: "0.12.6", neovimSha256: "v" },
  };
  fake.offer(built, "image bytes");
  fake.offer(templateManifest("b".repeat(64)), "template bytes");
  assert.deepEqual(await client.manifest(built.id), built);
  assert.deepEqual(await client.manifest(template), templateManifest("b".repeat(64)));
  assert.equal(await client.manifest("img-ffffffffffff"), null, "a node that holds no such artifact answers 404");
  assert.equal((await fetch(`${base}/v1/manifests/ckpt-unit-1`)).status, 400, "a checkpoint has no manifest to read");
  callAs(peer);
  assert.equal((await fetch(`${base}/v1/manifests/${built.id}`)).status, 403);
});

test("fetch-artifact imports from the peer probe, and refuses a copy whose sha256 differs from the job's", async (t) => {
  const source = fakeBackend();
  const peerNode = "peer-node" as NodeName;
  const holder = await startProbe({
    node: peerNode, host: "127.0.0.1", port: 0, auth: { controlPlane, peers: [probeNodeId] }, whois: async () => probeNodeId,
    backend: source.backend, secrets: nodeSecrets({ value: () => undefined, names: () => [] }), log: () => undefined,
  });
  t.after(() => holder.close());
  const manifest = templateManifest("b".repeat(64));
  source.offer(manifest, "template bytes");
  const { client, fake } = await setup(t, {
    peerAddress: (from) => { assert.equal(from, peerNode); return { host: "127.0.0.1", port: holder.port }; },
    // The holder answers as the configured peer, and every other caller is the control plane.
    whois: async (_address, port) => port === holder.port ? peer : controlPlane,
  });
  const fetchWith = async (sha256: string, artifact: ArtifactId = template) => {
    const env = envelope({ kind: "fetch-artifact", artifact, from: peerNode, sha256 }, node, Date.now());
    await client.submit(env);
    return finished(client, env.jobId);
  };
  const refused = await fetchWith("c".repeat(64));
  assert.ok(refused.state === "failed" && refused.code === "invalid" && /peer-node refuses the copy: this node holds tpl-000000000000 with sha256 b{64}, and the fetch asks for c{64}/.test(refused.message), JSON.stringify(refused));
  assert.equal(fake.imported.size, 0);
  assert.equal((await fetchWith(manifest.sha256)).state, "succeeded");
  assert.deepEqual(fake.imported.get(template), { manifest, body: "template bytes" });
  await holder.close();
  assert.equal((await fetchWith(manifest.sha256)).state, "succeeded", "a held artifact is not fetched again");
  const differs = await fetchWith("e".repeat(64));
  assert.ok(differs.state === "failed" && differs.code === "invalid" && /holds tpl-000000000000 with sha256 b{64}, and the job asks for e{64}/.test(differs.message), JSON.stringify(differs));
  const checkpoint = await fetchWith("d".repeat(64), "ckpt-unit-1");
  assert.ok(checkpoint.state === "failed" && checkpoint.code === "invalid", JSON.stringify(checkpoint));
});

test("a job past its deadline fails with deadline", async (t) => {
  const { client, fake } = await setup(t, { jobDeadlineMs: { ...jobDeadlineMs, spawn: 50 } });
  fake.hold();
  const env = envelope(spawnJob, node, Date.now());
  await client.submit(env);
  const status = await finished(client, env.jobId);
  assert.ok(status.state === "failed" && status.code === "deadline", JSON.stringify(status));
});

test("spawn checks secret grants before booting", async (t) => {
  const { client, fake } = await setup(t);
  const job: Job = { ...spawnJob, boot: { ...boot, network: { allowedHosts: [], secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }] } } } as Job;
  const env = envelope(job, node, Date.now());
  await client.submit(env);
  const status = await finished(client, env.jobId);
  assert.ok(status.state === "failed" && status.code === "secret-missing");
  assert.equal(fake.pylons.size, 0);
});

test("a spawn granted a held secret boots before the control plane hands it over, rather than failing for good", async (t) => {
  const { client, fake } = await setup(t);
  const job: Job = { ...spawnJob, boot: { ...boot, network: { allowedHosts: [], secrets: [{ name: "NEXUS_CHATGPT_TOKEN", hosts: ["api.openai.com"] }] } } } as Job;
  const env = envelope(job, node, Date.now());
  await client.submit(env);
  assert.equal((await finished(client, env.jobId)).state, "succeeded");
  assert.equal(fake.pylons.get(pylonId)?.vm, "running");
});

test("a snapshot lists the checkpoints of the stopped pylons it reports, also when a pylon stops while it is read", async (t) => {
  const { client, fake } = await setup(t);
  const down = "pylon-down" as PylonId;
  const up = "pylon-up" as PylonId;
  fake.pylons.set(down, { pylonId: down, vm: "stopped", checkpoint: "ckpt-down-1", image, bootedAt: null, sessions: null });
  fake.pylons.set(up, { pylonId: up, vm: "running", checkpoint: null, image, bootedAt: "2027-01-01T00:00:00Z" });
  fake.backend.list = async () => {
    const listed = [...fake.pylons.values()];
    fake.pylons.set(up, { pylonId: up, vm: "stopped", checkpoint: "ckpt-up-1", image, bootedAt: null, sessions: null });
    return listed;
  };
  const observed = async () => {
    for await (const e of client.observe(AbortSignal.timeout(5000))) return e.type === "snapshot" ? e.observation : assert.fail(e.type);
    return assert.fail("observe ended");
  };
  const first = await observed();
  assert.deepEqual(first.pylons.map((p) => [p.pylonId, p.phase]), [[down, "stopped"], [up, "running"]]);
  assert.deepEqual(first.artifacts, [image, "ckpt-down-1"], "the pause that finished after the list shows in the next snapshot, with its pylon");
  const next = await observed();
  assert.deepEqual(next.pylons.map((p) => [p.pylonId, p.phase]), [[down, "stopped"], [up, "stopped"]]);
  assert.deepEqual(next.artifacts, [image, "ckpt-down-1", "ckpt-up-1"]);
});

test("observe starts with a snapshot carrying the applied liveHash, and a new probe reports none", async (t) => {
  const { client, fake } = await setup(t);
  const env = envelope(spawnJob, node, Date.now());
  await client.submit(env);
  await finished(client, env.jobId);

  const abort = new AbortController();
  const events = client.observe(abort.signal)[Symbol.asyncIterator]();
  const first = await events.next();
  assert.equal(first.value?.type, "snapshot");
  const observation = first.value.type === "snapshot" ? first.value.observation : assert.fail();
  assert.equal(observation.node, node);
  assert.deepEqual(observation.artifacts, [image]);
  const pylon = observation.pylons[0];
  assert.ok(pylon?.phase === "running" && pylon.liveHash === "hash-1");

  // A job's events arrive on the open stream: its status, then a fresh snapshot.
  const del = envelope({ kind: "delete", pylonId }, node, Date.now());
  await client.submit(del);
  const seen: string[] = [];
  for (let e = await events.next(); !e.done; e = await events.next()) {
    seen.push(e.value.type === "job" ? `job:${e.value.status.state}` : e.value.type);
    if (e.value.type === "snapshot") {
      assert.deepEqual(e.value.observation.pylons, []);
      break;
    }
  }
  assert.deepEqual(seen.slice(-2), ["job:succeeded", "snapshot"]);
  abort.abort();

  const restarted = await setup(t, { backend: fake.backend });
  await fake.backend.ensureRunning(boot, spawnJob.kind === "spawn" ? spawnJob.live : assert.fail(), AbortSignal.timeout(1000));
  for await (const e of restarted.client.observe(AbortSignal.timeout(5000))) {
    assert.ok(e.type === "snapshot");
    assert.notEqual(e.observation.probeBootId, observation.probeBootId);
    const p = e.observation.pylons[0];
    assert.ok(p?.phase === "running" && p.liveHash === null);
    break;
  }
});

test("a spawn without its sessions reaches the backend as such, and its pylon reports no liveHash until a spawn that brings them back", async (t) => {
  const { client, fake } = await setup(t);
  const run = async (job: Job) => {
    const env = envelope(job, node, Date.now());
    await client.submit(env);
    assert.equal((await finished(client, env.jobId)).state, "succeeded");
  };
  const liveHash = async () => {
    for await (const e of client.observe(AbortSignal.timeout(5000))) {
      assert.ok(e.type === "snapshot" && e.observation.spawnsWithoutRelaunch === true);
      const p = e.observation.pylons[0];
      return p?.phase === "running" ? p.liveHash : assert.fail(`the pylon is ${p?.phase}`);
    }
  };
  await run(spawnJob);
  assert.equal(await liveHash(), "hash-1");
  await run({ kind: "pause", pylonId, checkpoint: "ckpt-unit-1" });
  await run({ ...spawnJob, relaunch: false } as Job);
  assert.equal(await liveHash(), null);
  await run(spawnJob);
  assert.equal(await liveHash(), "hash-1");
  assert.deepEqual(fake.relaunches, [true, false, true]);
});

test("capacity counts the CPUs and memory of VMs that are up and the disk of every pylon, paused ones included", async (t) => {
  const { client, fake } = await setup(t);
  const at = (id: string) => id as PylonId;
  fake.pylons.set(at("pylon-a"), { pylonId: at("pylon-a"), vm: "running", checkpoint: null, image, bootedAt: "2027-01-01T00:00:00Z", holds: { cpus: 4, memoryGiB: 8, diskGiB: 60 } });
  fake.pylons.set(at("pylon-b"), { pylonId: at("pylon-b"), vm: "booting", checkpoint: null, image, bootedAt: null, holds: { cpus: 2, memoryGiB: 8, diskGiB: 30 } });
  fake.pylons.set(at("pylon-c"), { pylonId: at("pylon-c"), vm: "stopped", checkpoint: "ckpt-c-1", image, bootedAt: null, sessions: null, holds: { cpus: 0, memoryGiB: 0, diskGiB: 60 } });
  fake.pylons.set(at("pylon-d"), { pylonId: at("pylon-d"), vm: "running", checkpoint: null, image, bootedAt: "2027-01-01T00:00:00Z" });
  for await (const e of client.observe(AbortSignal.timeout(5000))) {
    const capacity = (e.type === "snapshot" ? e.observation : assert.fail()).capacity ?? assert.fail();
    assert.deepEqual([capacity.committedCpus, capacity.committedMemoryGiB, capacity.committedDiskGiB], [6, 16, 150], "a pylon whose backend reserves nothing counts for nothing");
    assert.ok(capacity.cpus > 0 && capacity.memoryGiB > 0);
    break;
  }
});

test("a broken pylon's log tail and a failed job's log leave the node with the values it holds and secret-shaped text redacted", async (t) => {
  const secrets = nodeSecrets(parseSecretsEnv("STRIPE_KEY=rk_live_0123456789abcdef\n"));
  secrets.hold("NEXUS_CHATGPT_TOKEN", "held-token-value-0123");
  const { base, client, fake } = await setup(t, { secrets });
  assert.equal((await fetch(`${base}/v1/secrets/NEXUS_CHATGPT_TOKEN`, { method: "PUT", body: "held-token-value-0123" })).status, 204);
  const log = [
    "request to api.stripe.com with rk_live_0123456789abcdef failed",
    "pi: refresh with held-token-value-0123",
    "guest env GH_TOKEN=GONDOLIN_SECRET_0123456789abcdef0123456789abcdef0123456789abcdef",
    "curl sent 0123456789abcdef0123456789abcdef0123456789abcdef.stripe_key",
    "Error: Guest command got no answer within 13000 ms",
  ].join("\n");
  const redactedLog = [
    "request to api.stripe.com with [redacted] failed",
    "pi: refresh with [redacted]",
    "guest env GH_TOKEN=[redacted]",
    "curl sent [redacted].stripe_key",
    "Error: Guest command got no answer within 13000 ms",
  ].join("\n");
  const broken = "pylon-broken" as PylonId;
  fake.pylons.set(broken, { pylonId: broken, vm: "broken", checkpoint: null, image, bootedAt: null, detail: "the controller failed to boot the VM", cause: "controller", logTail: log });
  for await (const e of client.observe(AbortSignal.timeout(5000))) {
    const observed = (e.type === "snapshot" ? e.observation : assert.fail()).pylons.find((p) => p.pylonId === broken);
    assert.deepEqual(observed, { pylonId: broken, phase: "broken", detail: "the controller failed to boot the VM", cause: "controller", logTail: redactedLog });
    break;
  }
  fake.backend.ensureRunning = async () => { throw new JobFailure("setup-failed", "setup failed with rk_live_0123456789abcdef", log); };
  const env = envelope(spawnJob, node, Date.now());
  await client.submit(env);
  const status = await finished(client, env.jobId);
  assert.deepEqual(status.state === "failed" && [status.message, status.logTail], ["setup failed with [redacted]", redactedLog]);
});

test("node health is the control plane's to read, read-only, with the backend's storage and its pylons' processes", { skip: process.platform !== "linux" && "node health reads Linux's /proc" }, async (t) => {
  const storage = await mkdtemp(join(tmpdir(), "nexus-storage-"));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const backend: VmBackend = { ...fakeBackend().backend, storage, processes: async () => [{ pylonId, pid: process.pid }] };
  const { base, client, callAs } = await setup(t, { backend });
  const health = await client.health();
  assert.equal(health.node, node);
  assert.equal(health.disk.path, storage);
  assert.ok(health.load !== null && health.memory !== null && health.memory.availableGiB <= health.memory.totalGiB);
  assert.equal(health.pylons?.length, 1);
  assert.deepEqual([health.pylons![0]!.pylonId, health.pylons![0]!.processes >= 1, health.pylons![0]!.residentGiB > 0], [pylonId, true, true], "this test's own process stands in for a controller");
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(`${base}/v1/node-health`, { method })).status, 405, `${method} changes nothing`);
  callAs(peer);
  assert.equal((await fetch(`${base}/v1/node-health`)).status, 403, "a peer probe may not read it");
  delete backend.processes;
  callAs(controlPlane);
  assert.equal((await client.health()).pylons, null, "a backend that cannot name its pylons' processes");
});

test("a held secret from the control plane is held, applied to the running pylons, and then reported as one the node holds", async (t) => {
  const secrets = nodeSecrets({ value: () => undefined, names: () => [] });
  const logged: string[] = [];
  const { base, client, fake } = await setup(t, { secrets, log: (line) => logged.push(line) });
  const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl-_";
  fake.unreachable.push("pylon-stuck" as PylonId);
  const put = await fetch(`${base}/v1/secrets/NEXUS_CHATGPT_TOKEN`, { method: "PUT", body: token });
  assert.equal(put.status, 204);
  assert.deepEqual(fake.secretUpdates, [["NEXUS_CHATGPT_TOKEN", token]]);
  assert.equal(secrets.value("NEXUS_CHATGPT_TOKEN"), token, "the backend boots new pylons with it");
  assert.deepEqual(logged, ["pylon-stuck: NEXUS_CHATGPT_TOKEN was not updated: its controller did not answer"]);
  for await (const e of client.observe(AbortSignal.timeout(5000))) {
    const observation = e.type === "snapshot" ? e.observation : assert.fail();
    assert.deepEqual(observation.grants, { secrets: ["NEXUS_CHATGPT_TOKEN"], gitSsh: false });
    assert.ok(!JSON.stringify(observation).includes(token));
    break;
  }
  await client.putSecret("NEXUS_CHATGPT_TOKEN", `${token}2`);
  assert.equal(secrets.value("NEXUS_CHATGPT_TOKEN"), `${token}2`, "the client puts the value as the probe takes it");
});

test("a held secret is taken only from the control plane, only under a held name, and only as a token, and a refusal never echoes the value", async (t) => {
  const secrets = nodeSecrets({ value: () => undefined, names: () => [] });
  const { base, client, fake, callAs } = await setup(t, { secrets });
  const put = (name: string, body: string) => fetch(`${base}/v1/secrets/${name}`, { method: "PUT", body });
  callAs(peer);
  assert.equal((await put("NEXUS_CHATGPT_TOKEN", "peer-token")).status, 403);
  callAs(controlPlane);
  assert.equal((await put("GH_TOKEN", "ghp_token")).status, 404, "a file secret is the node's own");
  await assert.rejects(client.putSecret("STRIPE_KEY", "sk_live_x"), /HTTP 404/);
  for (const [value, what] of [["", "empty"], ["hunter2".repeat(2341), "over 16 KiB"], ["bad hunter2", "a space"], ["hunter2\nX-Injected: 1", "a newline"], ["héllo-hunter2", "a non-ASCII letter"]] as const) {
    const response = await put("NEXUS_CHATGPT_TOKEN", value);
    assert.equal(response.status, 400, what);
    assert.doesNotMatch(await response.text(), /hunter2/, `${what}: the refusal echoes the value`);
  }
  assert.equal((await fetch(`${base}/v1/secrets/NEXUS_CHATGPT_TOKEN`)).status, 405);
  assert.deepEqual(fake.secretUpdates, [], "nothing refused reached a pylon");
  assert.deepEqual(secrets.names(), []);
});

test("an observer learns at once that the probe got a held secret it did not have", async (t) => {
  const { base, client } = await setup(t, { secrets: nodeSecrets({ value: () => undefined, names: () => [] }) });
  const events = client.observe(AbortSignal.timeout(5000))[Symbol.asyncIterator]();
  const first = (await events.next()).value;
  assert.deepEqual(first?.type === "snapshot" && first.observation.grants?.secrets, []);
  assert.equal((await fetch(`${base}/v1/secrets/NEXUS_CHATGPT_TOKEN`, { method: "PUT", body: "eyJhbGciOiJSUzI1NiJ9.e30.c2ln" })).status, 204);
  const next = (await events.next()).value;
  assert.deepEqual(next?.type === "snapshot" && next.observation.grants?.secrets, ["NEXUS_CHATGPT_TOKEN"], "the snapshot comes before the 60 s one");
  await events.return?.();
});

test("observations name the secrets the node holds, never their values, and whether it has a git SSH key", async (t) => {
  const { client } = await setup(t, { secrets: nodeSecrets({ value: () => "s3cr3t", names: () => ["GH_TOKEN"] }), backend: { ...fakeBackend().backend, gitSsh: true } });
  for await (const e of client.observe(AbortSignal.timeout(5000))) {
    const observation = e.type === "snapshot" ? e.observation : assert.fail();
    assert.deepEqual(observation.grants, { secrets: ["GH_TOKEN"], gitSsh: true });
    assert.deepEqual(observation.heldSecrets, ["NEXUS_CHATGPT_TOKEN"], "it takes the held secrets from the control plane, handed over or not");
    assert.ok(!JSON.stringify(observation).includes("s3cr3t"));
    break;
  }
});

async function running(client: ReturnType<typeof connectProbe>) {
  const env = envelope(spawnJob, node, Date.now());
  await client.submit(env);
  assert.equal((await finished(client, env.jobId)).state, "succeeded");
}

test("commands run in a running pylon's guest and return its result", async (t) => {
  const guest = fakeGuest((argv, herdr) => {
    if (!herdr) return { exitCode: 0, output: `ran ${argv.join(" ")}` };
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "workspace create") return herdrOk({ type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } });
    if (sub === "agent start") return herdrOk({ type: "agent_started", agent: {}, argv: [] });
    if (sub === "pane close") return herdrError("pane_not_found");
    throw new Error(`unscripted ${sub}`);
  });
  const { client } = await setup(t, {}, guest);
  await running(client);

  assert.deepEqual(await client.command(pylonId, { kind: "exec", argv: ["git", "status"], cwd: "/home/user/workspace/repo", timeoutMs: 5000 }),
    { kind: "exec", exitCode: 0, output: "ran git status", truncated: false });
  assert.deepEqual(await client.command(pylonId, { kind: "open-session", harness: "claude-code", title: "review" }), { kind: "open-session", herdrPane: "w1:p1" });
  const create = guest.execs.find((a) => a[4] === "create")!;
  assert.deepEqual(create.slice(5, 9), ["--cwd", "/home/user/workspace/repo", "--label", "review"], "sessions open in the checkout");
  assert.deepEqual(await client.command(pylonId, { kind: "close-session", herdrPane: "w1:p1" }), { kind: "close-session", outcome: "not-open" }, "a pane that is not open is not reported closed");
});

test("a command for a pylon that is not running is refused as not-running", async (t) => {
  const guest = fakeGuest(() => { throw new Error("no exec expected"); });
  const { client, fake } = await setup(t, {}, guest);
  await assert.rejects(client.command(pylonId, { kind: "exec", argv: ["true"], cwd: "/", timeoutMs: 1000 }), { code: "not-running" });
  fake.pylons.set(pylonId, { pylonId, vm: "stopped", checkpoint: "ckpt-unit-1", image, bootedAt: null, sessions: null });
  await assert.rejects(client.command(pylonId, { kind: "close-session", herdrPane: "w1:p1" }), { code: "not-running" });
  assert.deepEqual(guest.execs, []);
});

test("a command or job body over a mebibyte is refused and reaches no guest", async (t) => {
  const guest = fakeGuest(() => { throw new Error("no exec expected"); });
  const { client, base } = await setup(t, {}, guest);
  await running(client);
  const big = "x".repeat((1 << 20) + 1);
  const command = await fetch(`${base}/v1/pylons/${pylonId}/commands`, { method: "POST", body: big });
  assert.deepEqual([command.status, await command.text()], [400, "request body over 1048576 bytes"]);
  const job = await fetch(`${base}/v1/jobs/job-big`, { method: "PUT", body: big });
  assert.deepEqual([job.status, await job.text()], [500, "request body over 1048576 bytes"]);
  assert.deepEqual(guest.execs, []);
});

test("malformed commands get 400 and reach no guest", async (t) => {
  const guest = fakeGuest(() => { throw new Error("no exec expected"); });
  const { client, base } = await setup(t, {}, guest);
  await running(client);
  const post = (body: unknown) => fetch(`${base}/v1/pylons/${pylonId}/commands`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.status);
  assert.equal(await post({ kind: "exec", argv: ["sleep", "90"], cwd: "/", timeoutMs: 90_000 }), 400);
  assert.equal(await post({ kind: "exec", argv: [], cwd: "/", timeoutMs: 1000 }), 400);
  assert.equal(await post({ kind: "open-session", harness: "codex", title: "x" }), 400);
  assert.equal(await post({ kind: "open-session", harness: "shell", title: "x", resume: "abc" }), 400);
  assert.equal(await post({ kind: "drop-failed-session" }), 400);
  assert.equal(await post({ kind: "close-session", herdrPane: "w1:p1", session: { harness: "codex", harnessSessionId: null, title: null } }), 400);
  assert.equal(await post({ kind: "close-session", herdrPane: "w1:p1", session: { harness: "pi", title: null } }), 400);
  assert.equal(await post({ kind: "reboot" }), 400);
  const send = { kind: "send-claude", session: "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90", text: "hi" };
  for (const bad of [{ session: undefined }, { session: "../etc" }, { session: "a".repeat(201) }, { text: "" }, { text: "x".repeat(16_385) }, { text: "a\tb" }, { text: "a\rb" }, { model: "" }, { model: "m".repeat(201) }, { requestId: "" }, { requestId: 1 }]) {
    assert.equal(await post({ ...send, ...bad }), 400, JSON.stringify(bad));
  }
  assert.equal(await post({ kind: "send-claude-outcome" }), 400);
  assert.deepEqual(guest.execs, []);
});

test("a message that resumes its Claude session publishes the session's new pane at once", async (t) => {
  const session = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
  let panes: ReturnType<typeof herdrPane>[] = [];
  const guest = fakeGuest((argv, herdr) => {
    if (!herdr) return argv[3] === "claude-type" || argv[0] === "node" || argv[0] === "sh" ? { exitCode: argv.at(-1) === sessionsFile ? 3 : 0, output: "" } : assert.fail(`unexpected exec ${argv.join(" ")}`);
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "Claude Code" }], panes));
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "workspace create") return herdrOk({ type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } });
    if (sub === "pane process-info") return herdrOk({ type: "pane_process_info", process_info: { pane_id: "w1:p1", shell_pid: 100, foreground_processes: [{ pid: 101, name: "claude", argv: ["claude", "--session-id", session] }] } });
    if (sub === "agent start") {
      panes = [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: session })];
      return herdrOk({ type: "agent_started", agent: {}, argv: [] });
    }
    throw new Error(`unscripted ${sub}`);
  });
  const { client } = await setup(t, {}, guest);
  await running(client);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = client.observe(abort.signal)[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "snapshot");
  assert.deepEqual(await client.command(pylonId, { kind: "send-claude", session, text: "carry on" }), { kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed: true });
  const e = (await events.next()).value;
  const p = e?.type === "snapshot" ? e.observation.pylons[0] : assert.fail(`a snapshot, not ${e?.type}`);
  assert.deepEqual(p?.phase === "running" ? p.sessions?.map((f: { harnessSessionId: string | null }) => f.harnessSessionId) : assert.fail("the pylon runs"), [session], "the control plane sees the resumed session without waiting a minute");
});

test("a message for a Claude session is typed into its pane, and the result says how Claude took it", async (t) => {
  const session = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
  const guest = fakeGuest((argv, herdr) => {
    if (!herdr) return argv[3] === "claude-type" ? { exitCode: 0, output: "" } : assert.fail(`unexpected exec ${argv.join(" ")}`);
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "Claude Code" }], [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: session })]));
    if (sub === "pane process-info") return herdrOk({ type: "pane_process_info", process_info: { pane_id: "w1:p1", shell_pid: 100, foreground_processes: [{ pid: 101, name: "claude", argv: ["claude", "--resume", session] }] } });
    throw new Error(`unscripted ${sub}`);
  });
  const { client } = await setup(t, {}, guest);
  await running(client);
  const text = "line one\n\"quoted\" `ticks` $HOME";
  assert.deepEqual(await client.command(pylonId, { kind: "send-claude", session, text }), { kind: "send-claude", outcome: "queued", herdrPane: "w1:p1", resumed: false });
  assert.deepEqual(guest.execs.find((a) => a[3] === "claude-type")!.slice(4), ["w1:p1", text]);
  await assert.rejects(client.command(pylonId, { kind: "send-claude", session, text: "a\tb" }), /HTTP 400: .*Replace tabs with spaces/);
});

test("two messages for one Claude session run one after the other, so the session opens once and their typing never overlaps", async (t) => {
  const session = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
  let panes: ReturnType<typeof herdrPane>[] = [];
  const base = fakeGuest((argv, herdr) => {
    if (!herdr) return argv[3] === "claude-type" || argv[0] === "node" || argv[0] === "sh" ? { exitCode: argv.at(-1) === sessionsFile ? 3 : 0, output: "" } : assert.fail(`unexpected exec ${argv.join(" ")}`);
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "Claude Code" }], panes));
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "workspace create") return herdrOk({ type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } });
    if (sub === "pane process-info") return herdrOk({ type: "pane_process_info", process_info: { pane_id: "w1:p1", shell_pid: 100, foreground_processes: [{ pid: 101, name: "claude", argv: ["claude", "--session-id", session] }] } });
    if (sub === "agent start") {
      panes = [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: session })];
      return herdrOk({ type: "agent_started", agent: {}, argv: [] });
    }
    throw new Error(`unscripted ${sub}`);
  });
  let typing = 0;
  const typed: string[] = [];
  const guest: Guest = {
    ...base,
    async exec(argv, options) {
      if (argv[3] !== "claude-type") return base.exec(argv, options);
      assert.equal(typing++, 0, "no message is typed while another is");
      await new Promise((resolve) => setTimeout(resolve, 50));
      typed.push(argv[5]!);
      typing--;
      return base.exec(argv, options);
    },
  };
  const { client } = await setup(t, {}, guest);
  await running(client);
  const sends = await Promise.all(["first", "second"].map((text) => client.command(pylonId, { kind: "send-claude", session, text })));
  assert.deepEqual(sends.map((r) => r.kind === "send-claude" && r.resumed), [true, false], "the second message finds the session the first resumed");
  assert.equal(base.herdrCalls().filter((c) => c === "workspace create").length, 1);
  assert.deepEqual(typed, ["first", "second"]);
});

test("the outcome of a Claude send waits for one queued behind a slow send, types nothing, and says when a send failed or is unknown", async (t) => {
  const session = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
  const base = fakeGuest((argv, herdr) => {
    if (!herdr) return argv[3] === "claude-type" ? { exitCode: 0, output: "" } : assert.fail(`unexpected exec ${argv.join(" ")}`);
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "Claude Code" }], [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: session })]));
    if (sub === "pane process-info") return herdrOk({ type: "pane_process_info", process_info: { pane_id: "w1:p1", shell_pid: 100, foreground_processes: [{ pid: 101, name: "claude", argv: ["claude", "--resume", session] }] } });
    throw new Error(`unscripted ${sub}`);
  });
  const slow = Promise.withResolvers<void>();
  const typed: string[] = [];
  const guest: Guest = {
    ...base,
    async exec(argv, options) {
      if (argv[3] !== "claude-type") return base.exec(argv, options);
      if (argv[5] === "slow") await slow.promise;
      typed.push(argv[5]!);
      return argv[5] === "breaks" ? { exitCode: 1, output: "herdr: pane w1:p1 went away", truncated: false } : base.exec(argv, options);
    },
  };
  const { client } = await setup(t, {}, guest);
  await running(client);
  const sending = ["slow", "queued"].map((text) => client.command(pylonId, { kind: "send-claude", session, text, requestId: `msg:${text}` }));
  let settled = false;
  const outcome = client.command(pylonId, { kind: "send-claude-outcome", requestId: "msg:queued" }).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, "the outcome waits while the send waits behind the slow one");
  slow.resolve();
  const queued = { outcome: "queued", herdrPane: "w1:p1", resumed: false };
  assert.deepEqual(await outcome, { kind: "send-claude-outcome", send: queued });
  assert.deepEqual(await Promise.all(sending), [{ kind: "send-claude", ...queued }, { kind: "send-claude", ...queued }]);
  assert.deepEqual(await client.command(pylonId, { kind: "send-claude-outcome", requestId: "msg:queued" }), { kind: "send-claude-outcome", send: queued }, "a settled send is still known");

  await assert.rejects(client.command(pylonId, { kind: "send-claude", session, text: "breaks", requestId: "msg:breaks" }), /part of the message may sit unsent/);
  assert.deepEqual(await client.command(pylonId, { kind: "send-claude-outcome", requestId: "msg:breaks" }), { kind: "send-claude-outcome", send: "failed" });
  assert.deepEqual(await client.command(pylonId, { kind: "send-claude-outcome", requestId: "msg:never" }), { kind: "send-claude-outcome", send: "unknown" });
  assert.deepEqual(typed, ["slow", "queued", "breaks"], "asking for an outcome types nothing");
});

test("a prompted Claude launch sent again while the first still runs waits for it", async (t) => {
  const execs: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const base = fakeGuest((argv, herdr) => herdr ? herdrError("server_not_running") : { exitCode: 1, output: "no Herdr in this guest" });
  const guest: Guest = {
    ...base,
    async exec(argv, options) {
      execs.push(argv.join(" "));
      if (execs.length === 1) await held;
      return base.exec(argv, options);
    },
  };
  const { client } = await setup(t, {}, guest);
  await running(client);
  const launch = { kind: "open-session" as const, harness: "claude-code" as const, title: "worker", resume: "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30", prompt: "hello" };
  execs.length = 0;
  const first = client.command(pylonId, launch);
  while (execs.length === 0) await new Promise((r) => setTimeout(r, 5));
  const again = client.command(pylonId, launch);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(execs.length, 1, "the second launch ran nothing while the first held the guest");
  release();
  await Promise.all([assert.rejects(first, /starting the Herdr server failed/), assert.rejects(again, /starting the Herdr server failed/)]);
  assert.equal(execs.length, 4);
  assert.deepEqual(execs.slice(0, 2).map((e) => e.split(" ")[0]), ["herdr", "sh"], "the first launch ran to its end before the second began");
});

test("each command kind waits for the reads or its Claude session or nothing, publishes a snapshot or not, and a send is remembered by its request ID", async (t) => {
  const session = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
  const working = [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: session })];
  let panes: ReturnType<typeof herdrPane>[] = working;
  const base = fakeGuest((argv, herdr) => {
    if (!herdr) {
      if (argv.at(-1) === sessionsFile) return { exitCode: 3, output: "" };
      // A prompted launch fails at once on reading its record, so it never polls for a submission here.
      if (argv[0] === "sh" && argv[2]?.includes("/opened")) return { exitCode: 1, output: "no launch records in this guest" };
      return { exitCode: 0, output: "" };
    }
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "Claude Code" }], panes));
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "workspace create") return herdrOk({ type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } });
    if (sub === "pane process-info") return herdrOk({ type: "pane_process_info", process_info: { pane_id: "w1:p1", shell_pid: 100, foreground_processes: [{ pid: 101, name: "claude", argv: ["claude", "--resume", session] }] } });
    if (sub === "agent start") {
      panes = [herdrPane("w1:p1", "w1", "claude", "idle", { kind: "id", value: session })];
      return herdrOk({ type: "agent_started", agent: {}, argv: [] });
    }
    if (sub === "pane close") return herdrError("pane_not_found");
    throw new Error(`unscripted ${sub}`);
  });
  let typing: PromiseWithResolvers<void> | null = null;
  const typingHeld = Promise.withResolvers<void>();
  const guest: Guest = {
    ...base,
    async exec(argv, options) {
      if (argv[3] === "claude-type" && argv[5] === "hold") {
        typingHeld.resolve();
        await typing?.promise;
      }
      return base.exec(argv, options);
    },
    services: async () => ({ services: [] }),
    async linkPort(port) {
      if (port === sentinelPort) sentinelReads.push(listed);
      return `port-${port}`;
    },
    unlinkPort: async () => null,
  };
  const sentinelPort = 4000;
  /** The pylon reads made so far, as each sentinel link found them, which is after every read queued before it ran. */
  const sentinelReads: number[] = [];
  let listed = 0;
  const { client, fake } = await setup(t, { listeningPollMs: 600_000 }, guest);
  await running(client);
  const commands: Record<string, PylonCommand> = {
    "exec": { kind: "exec", argv: ["true"], cwd: "/", timeoutMs: 1000 },
    "open-session": { kind: "open-session", harness: "shell", title: "shell" },
    "open-session with resume": { kind: "open-session", harness: "claude-code", title: "Claude Code", resume: session },
    "open-session with prompt and resume": { kind: "open-session", harness: "claude-code", title: "Claude Code", resume: session, prompt: "go" },
    "close-session": { kind: "close-session", herdrPane: "w1:p9" },
    "drop-failed-session": { kind: "drop-failed-session", id: "s1" },
    "send-claude": { kind: "send-claude", session, text: "hi" },
    "send-claude-outcome": { kind: "send-claude-outcome", requestId: "msg:never" },
    "service": { kind: "service", op: "ensure" },
    "link-port": { kind: "link-port", port: 3000 },
    "unlink-port": { kind: "unlink-port", port: 3000 },
  };
  /** Which commands answer nothing while `hold` holds the probe, sent all at once. The rest answer, done or failed. */
  async function waiting(hold: () => Promise<() => void>): Promise<string[]> {
    const release = await hold();
    const sent = Object.entries(commands).map(([name, command]) => {
      const answered = client.command(pylonId, command).then(() => true, () => true);
      return { name, answered, waits: Promise.race([answered.then(() => false), new Promise<boolean>((resolve) => setTimeout(resolve, 1_000, true))]) };
    });
    const waits = await Promise.all(sent.map((s) => s.waits));
    release();
    await Promise.all(sent.map((s) => s.answered));
    return sent.filter((_, i) => waits[i]).map((s) => s.name);
  }

  const artifacts = fake.backend.artifacts.list;
  const reads = new AbortController();
  t.after(() => reads.abort());
  const readsWait = await waiting(async () => {
    const held = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    fake.backend.artifacts.list = async (listed) => {
      reached.resolve();
      await held.promise;
      return artifacts(listed);
    };
    void client.observe(reads.signal)[Symbol.asyncIterator]().next().catch(() => undefined);
    await reached.promise;
    return () => {
      fake.backend.artifacts.list = artifacts;
      held.resolve();
    };
  });
  reads.abort();
  assert.deepEqual(readsWait, ["link-port", "unlink-port"], "a link or unlink waits for a read in flight, and nothing else does");

  panes = working;
  const sessionWaits = await waiting(async () => {
    typing = Promise.withResolvers<void>();
    void client.command(pylonId, { kind: "send-claude", session, text: "hold" }).catch(() => undefined);
    await typingHeld.promise;
    return () => typing!.resolve();
  });
  assert.deepEqual(sessionWaits, ["open-session with prompt and resume", "send-claude"], "only a send and a prompted launch wait for another command to the same Claude session");

  const list = fake.backend.list;
  fake.backend.list = () => { listed++; return list(); };
  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = client.observe(abort.signal)[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "snapshot");
  /**
   * Whether answering the command queued a snapshot read for the observers. A link runs in the read queue, so the reads
   * between two sentinel links are the first one's own publish and pylon read, the command's pylon read, any read it
   * queued, and the second link's pylon read.
   */
  const sentinel = () => client.command(pylonId, { kind: "link-port", port: sentinelPort });
  async function publishes(command: PylonCommand): Promise<boolean> {
    await sentinel();
    const before = sentinelReads.at(-1)!;
    await client.command(pylonId, command);
    await sentinel();
    return sentinelReads.at(-1)! - before - 3 > 0;
  }
  const published: Record<string, boolean> = {};
  for (const name of ["exec", "open-session", "close-session", "drop-failed-session", "send-claude-outcome", "service", "link-port", "unlink-port"]) published[name] = await publishes(commands[name]!);
  panes = working;
  published["send-claude to a running session"] = await publishes(commands["send-claude"]!);
  panes = [];
  published["send-claude that resumes its session"] = await publishes(commands["send-claude"]!);
  assert.deepEqual(published, {
    "exec": false, "open-session": true, "close-session": true, "drop-failed-session": false, "send-claude-outcome": false, "service": false, "link-port": true, "unlink-port": true,
    "send-claude to a running session": false, "send-claude that resumes its session": true,
  });

  panes = working;
  await client.command(pylonId, { kind: "send-claude", session, text: "kept", requestId: "msg:kept" });
  assert.deepEqual(await client.command(pylonId, { kind: "send-claude-outcome", requestId: "msg:kept" }), { kind: "send-claude-outcome", send: { outcome: "queued", herdrPane: "w1:p1", resumed: false } }, "a send-claude is remembered under its request ID");
  await client.command(pylonId, { kind: "exec", argv: ["true"], cwd: "/", timeoutMs: 1000 });
  assert.deepEqual(await client.command(pylonId, { kind: "send-claude-outcome", requestId: "msg:never" }), { kind: "send-claude-outcome", send: "unknown" });
});

test("the command policy table gives each kind its lock, its memory by request ID, its snapshot publishing and whether it may be sent again", () => {
  const session = "0b5e3a52-5d0f-4c1e-9a43-1f2a6c7d8e90";
  const sent = (resumed: boolean): CommandResult => ({ kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed });
  const samples: [string, PylonCommand, CommandResult?][] = [
    ["exec", { kind: "exec", argv: ["true"], cwd: "/", timeoutMs: 1000 }],
    ["open-session", { kind: "open-session", harness: "shell", title: "shell" }],
    ["open-session with resume", { kind: "open-session", harness: "claude-code", title: "Claude Code", resume: session }],
    ["open-session with prompt and resume", { kind: "open-session", harness: "claude-code", title: "Claude Code", resume: session, prompt: "go" }],
    ["close-session", { kind: "close-session", herdrPane: "w1:p1" }],
    ["drop-failed-session", { kind: "drop-failed-session", id: "s1" }],
    ["send-claude that resumes its session", { kind: "send-claude", session, text: "hi" }, sent(true)],
    ["send-claude to a running session", { kind: "send-claude", session, text: "hi" }, sent(false)],
    ["send-claude-outcome", { kind: "send-claude-outcome", requestId: "msg:1" }],
    ["service", { kind: "service", op: "ensure" }],
    ["link-port", { kind: "link-port", port: 3000 }],
    ["unlink-port", { kind: "unlink-port", port: 3000 }],
  ];
  const listed = samples.map(([name, command, result]) => {
    const { lock, remembered, publishes, retrySafe } = commandPolicies[command.kind] as CommandPolicy<PylonCommand["kind"]>;
    const waits = typeof lock === "function" ? lock(command) : lock;
    return `${name}: waits for ${waits === session ? "its Claude session" : waits ?? "nothing"}, ${remembered ? "remembered" : "not remembered"}, ${(typeof publishes === "function" ? publishes(result!) : publishes) ? "publishes" : "does not publish"}, retry safe: ${typeof retrySafe === "function" ? retrySafe(command) : retrySafe}`;
  });
  assert.deepEqual(listed, [
    "exec: waits for nothing, not remembered, does not publish, retry safe: false",
    "open-session: waits for nothing, not remembered, publishes, retry safe: false",
    "open-session with resume: waits for nothing, not remembered, publishes, retry safe: false",
    "open-session with prompt and resume: waits for its Claude session, not remembered, publishes, retry safe: true",
    "close-session: waits for nothing, not remembered, publishes, retry safe: false",
    "drop-failed-session: waits for nothing, not remembered, does not publish, retry safe: false",
    "send-claude that resumes its session: waits for its Claude session, remembered, publishes, retry safe: false",
    "send-claude to a running session: waits for its Claude session, remembered, does not publish, retry safe: false",
    "send-claude-outcome: waits for nothing, not remembered, does not publish, retry safe: true",
    "service: waits for nothing, not remembered, does not publish, retry safe: false",
    "link-port: waits for reads, not remembered, publishes, retry safe: true",
    "unlink-port: waits for reads, not remembered, publishes, retry safe: true",
  ]);
  assert.deepEqual(Object.keys(commandPolicies).sort(), [...new Set(samples.map(([, c]) => c.kind))].sort(), "every kind is listed");
});

test("a failing command rejects with the guest's error", async (t) => {
  const guest = fakeGuest((_argv, herdr) => herdr ? herdrError("invalid_params", "pane w9:p9 is malformed") : { exitCode: 0, output: "" });
  const { client } = await setup(t, {}, guest);
  await running(client);
  await assert.rejects(client.command(pylonId, { kind: "close-session", herdrPane: "w9:p9" }), /HTTP 500: herdr pane close: pane w9:p9 is malformed/);
});

test("observations carry session facts from Herdr, and null when Herdr cannot be read", async (t) => {
  let readable = true;
  const guest = fakeGuest((argv, herdr) => {
    if (!herdr && argv[2]?.includes(outputsDir)) return { exitCode: 0, output: "" };
    if (!herdr && argv[0] === "pgrep") return { exitCode: 1, output: "0\n" };
    if (!herdr && argv.at(-1) === sessionsFile) return { exitCode: 3, output: "" }; // never paused, so no failed sessions
    assert.ok(herdr && argv[0] === "api" && argv[1] === "snapshot", "observing runs only herdr api snapshot, the sessions file read, the outputs listing and the count of attached terminals");
    return readable
      ? herdrOk(herdrSnapshot([{ id: "w1", label: "review" }], [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: "bd2c2d6b" })]))
      : { exitCode: 1, output: "Error: exec failed" };
  });
  const logged: string[] = [];
  const { client } = await setup(t, { log: (line) => logged.push(line) }, guest);
  await running(client);

  const sessionsSeen = async () => {
    for await (const e of client.observe(AbortSignal.timeout(5000))) {
      const p = e.type === "snapshot" ? e.observation.pylons[0] : assert.fail("the first event is a snapshot");
      return p?.phase === "running" ? p.sessions : assert.fail("the pylon runs");
    }
  };
  assert.deepEqual(await sessionsSeen(), [{ id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "bd2c2d6b", status: "working", title: "review" }]);
  readable = false;
  assert.equal(await sessionsSeen(), null);
  assert.equal(await sessionsSeen(), null);
  assert.deepEqual(logged.filter((l) => l.includes("sessions")), [`${pylonId} sessions: herdr api snapshot exited 1 without a JSON reply: Error: exec failed. The control plane keeps the last list read until a read succeeds`], "logged once");
});

test("a stopped pylon's observation carries the sessions its backend kept from the pause", async (t) => {
  const { client, fake } = await setup(t, {}, fakeGuest(() => { throw new Error("a stopped pylon has no guest"); }));
  const recorded = [{ id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code" as const, harnessSessionId: "bd2c2d6b", title: "review" }];
  const seen = async () => {
    for await (const e of client.observe(AbortSignal.timeout(5000))) return e.type === "snapshot" ? e.observation.pylons[0] : assert.fail("the first event is a snapshot");
  };
  fake.pylons.set(pylonId, { pylonId, vm: "stopped", checkpoint: "ckpt-unit-1", image, bootedAt: null, sessions: recorded });
  assert.deepEqual(await seen(), { pylonId, phase: "stopped", checkpoint: "ckpt-unit-1", sessions: recorded });
  fake.pylons.set(pylonId, { pylonId, vm: "stopped", checkpoint: "ckpt-unit-1", image, bootedAt: null, sessions: null });
  assert.deepEqual(await seen(), { pylonId, phase: "stopped", checkpoint: "ckpt-unit-1", sessions: null });
});

test("NEXUS_API calls reach the API as the pylon the bridge named, get the URL once a spawn publishes the preview, and end with the probe", async (t) => {
  const bridge: { answer?: HostBridgeAnswer; closed: boolean } = { closed: false };
  const hostBridge: HostBridge = async (answer) => {
    bridge.answer = answer;
    return { async close() { bridge.closed = true; } };
  };
  const dir = await mkdtemp(join(tmpdir(), "nexus-probe-"));
  t.after(() => rm(dir, { recursive: true }));
  const free = createServer().listen(0, "127.0.0.1");
  await once(free, "listening");
  const gatewayPort = (free.address() as { port: number }).port;
  await new Promise((resolve) => free.close(resolve));
  const fake = fakeBackend();
  const guest = { ...fakeGuest(() => ({ exitCode: 1, output: "unused" })), linkPort: async () => "web", previewOrigin: () => "http://127.0.0.1:9" as const };
  const previews = { gatewayPort, routesFile: join(dir, "routes.json"), tailscale: fakeTailscale().cli, get: viaGateway(() => `http://127.0.0.1:${gatewayPort}`).get };
  const { client, probe } = await setup(t, { backend: { ...fake.backend, guest: () => guest, hostBridge }, previews });
  assert.ok(bridge.answer, "the probe started its bridge");
  const preview = bridge.answer(pylonId, JSON.stringify({ op: "preview", port: 3000 }));
  const env = envelope({ ...spawnJob, live: { previews: [{ service: "web", httpsPort: 10101 }], overlay: [] } }, node, Date.now());
  await client.submit(env);
  assert.equal((await finished(client, env.jobId)).state, "succeeded");
  assert.deepEqual(await preview, { status: 200, body: JSON.stringify({ service: "web", port: 3000, url: `https://${nodeHost}:10101/` }) });
  await probe.close();
  assert.ok(bridge.closed, "closing the probe closed its bridge");
});

test("observations carry the pylon's declared outputs", async (t) => {
  const output: DeclaredOutput = { id: "out-1-00000000", kind: "diff", base: "c".repeat(40), sha256: "0".repeat(64), title: null };
  const guest = fakeGuest((argv, herdr) => {
    if (herdr) return herdrOk(herdrSnapshot([], []));
    assert.ok(argv[2]?.includes(outputsDir));
    return { exitCode: 0, output: `${output.id}.json\t${JSON.stringify(output)}\n` };
  });
  const { client } = await setup(t, {}, guest);
  await running(client);
  for await (const e of client.observe(AbortSignal.timeout(5000))) {
    const p = e.type === "snapshot" ? e.observation.pylons[0] : assert.fail("the first event is a snapshot");
    assert.deepEqual(p?.phase === "running" ? p.declaredOutputs : assert.fail("the pylon runs"), [output]);
    break;
  }
});

/** A running pylon whose guest runs each stream's argv as a local process, as docker exec or ssh would. */
async function streaming(t: import("node:test").TestContext) {
  const fake = fakeBackend();
  const logged: string[] = [];
  const guestStreams: ByteStream[] = [];
  const guest = {
    async stream(argv: readonly string[], log: (text: string) => void) {
      const stream = processStream(argv[0]!, argv.slice(1), log);
      guestStreams.push(stream);
      return stream;
    },
  } as Partial<Guest> as Guest;
  const ctx = await setup(t, { backend: { ...fake.backend, guest: () => guest }, log: (line) => logged.push(line) });
  await fake.backend.ensureRunning(boot, { previews: [], overlay: [] }, AbortSignal.timeout(1000));
  return { ...ctx, logged, guestStreams };
}

async function readAll(stream: ByteStream): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("a raw pipe carries stdout only, and its stderr goes to the probe's log", async (t) => {
  const { client, logged } = await streaming(t);
  const stream = await client.stream(pylonId, ["sh", "-c", "printf out-bytes; printf err-bytes >&2; exit 3"]);
  assert.equal(await readAll(stream), "out-bytes");
  assert.deepEqual(await stream.done, { kind: "exited", code: 3 });
  assert.ok(logged.some((line) => line.includes(pylonId) && line.includes("err-bytes")), JSON.stringify(logged));
});

test("stdin reaches the guest process, and close ends it", async (t) => {
  const { client } = await streaming(t);
  const stream = await client.stream(pylonId, ["cat"]);
  await stream.write(new TextEncoder().encode("hello through the probe"));
  await stream.close();
  assert.equal(await readAll(stream), "hello through the probe");
  assert.deepEqual(await stream.done, { kind: "exited", code: 0 });
});

test("a checkout read fits the probe's stream request and comes back through it", async (t) => {
  const { client } = await streaming(t);
  const repo = await mkdtemp(join(tmpdir(), "nexus-probe-checkout-"));
  t.after(() => rm(repo, { recursive: true }));
  await writeFile(join(repo, "app.txt"), "one\n");
  await promisify(execFile)("git", ["-C", repo, "init", "-q"]);
  const reader = checkoutReader((request) => client.stream(pylonId, request), repo);
  assert.deepEqual(await reader.list(""), { path: "", entries: [{ name: ".git", kind: "dir", size: null }, { name: "app.txt", kind: "file", size: 4 }], truncated: false });
  assert.equal((await reader.read("app.txt")).toString(), "one\n");
});

test("a process that closes its stdin still delivers its output and exit code", async (t) => {
  const { client } = await streaming(t);
  const dir = await mkdtemp(join(tmpdir(), "nexus-probe-stdin-"));
  t.after(() => rm(dir, { recursive: true }));
  const written = join(dir, "written");
  const stream = await client.stream(pylonId, ["sh", "-c", 'exec 0<&-; printf closed; until [ -e "$0" ]; do sleep 0.01; done; printf done; exit 7', written]);
  const output = stream[Symbol.asyncIterator]();
  assert.equal(Buffer.from((await output.next()).value!).toString(), "closed");
  await stream.write(new TextEncoder().encode("nobody reads this"));
  await writeFile(written, "");
  const rest: Uint8Array[] = [];
  for (let chunk = await output.next(); !chunk.done; chunk = await output.next()) rest.push(chunk.value);
  assert.equal(Buffer.concat(rest).toString(), "done");
  assert.deepEqual(await stream.done, { kind: "exited", code: 7 });
});

test("a caller that resets its stream connection during whois does not take the probe down", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reset = Promise.withResolvers<void>();
  const { client, probe } = await setup(t, {
    whois: async () => { entered.resolve(); await release.promise; return controlPlane; },
    log: () => reset.resolve(),
  });
  const socket = connect(probe.port, "127.0.0.1");
  socket.write(`GET /v1/pylons/${pylonId}/stream?request=${encodeURIComponent(JSON.stringify({ argv: ["true"] }))} HTTP/1.1\r\nhost: probe\r\nconnection: upgrade\r\nupgrade: nexus-stream\r\n\r\n`);
  await entered.promise;
  socket.resetAndDestroy();
  await reset.promise;
  release.resolve();
  assert.equal(await client.job("after-reset" as JobId), "unknown", "the probe still answers");
});

test("a stream to a pylon that is not running is refused as not-running", async (t) => {
  const { client } = await setup(t);
  await assert.rejects(client.stream(pylonId, ["true"]), { code: "not-running" });
});

test("a stream request with a pty is refused with 400, and one without the pty key is served", async (t) => {
  const { probe, guestStreams } = await streaming(t);
  const ask = async (request: unknown) => {
    const socket = connect(probe.port, "127.0.0.1");
    socket.write(`GET /v1/pylons/${pylonId}/stream?request=${encodeURIComponent(JSON.stringify(request))} HTTP/1.1\r\nhost: probe\r\nconnection: upgrade\r\nupgrade: nexus-stream\r\n\r\n`);
    const [head] = await once(socket, "data") as [Buffer];
    socket.destroy();
    return head.toString();
  };
  const refused = await ask({ pty: { cols: 80, rows: 24 }, argv: ["cat"] });
  assert.match(refused, /^HTTP\/1\.1 400 /);
  assert.match(refused, /a stream request has no pty\. A terminal's pty is made in the guest, as guest-terminal\.ts does$/);
  assert.equal(guestStreams.length, 0, "nothing started in the guest");
  assert.match(await ask({ argv: ["true"] }), /^HTTP\/1\.1 101 /);
});

test("terminals attached to Herdr in the guest, such as nexus attach, count as attached clients", async (t) => {
  const guest = fakeGuest((argv, herdr) => herdr ? herdrError("server_not_running")
    : argv[0] === "pgrep" ? { exitCode: 0, output: "2\n" } : { exitCode: 0, output: "" });
  const { client } = await setup(t, {}, guest);
  await running(client);
  for await (const e of client.observe(AbortSignal.timeout(5000))) {
    const p = e.type === "snapshot" ? e.observation.pylons[0] : assert.fail(e.type);
    assert.ok(p?.phase === "running" && p.attachedClients === 2, JSON.stringify(p));
    break;
  }
});

test("a count of attached terminals that fails reads as none, is logged once, and fails nothing else of the observation", async (t) => {
  const logged: string[] = [];
  let counted = false;
  const guest = fakeGuest((argv, herdr) => herdr ? herdrError("server_not_running")
    : argv[0] === "pgrep" ? (counted ? { exitCode: 0, output: "1\n" } : { exitCode: 127, output: "sh: pgrep: not found" }) : { exitCode: 0, output: "" });
  const { client } = await setup(t, { log: (line) => logged.push(line) }, guest);
  await running(client);
  const attachedClients = async () => {
    for await (const e of client.observe(AbortSignal.timeout(5000))) {
      const p = e.type === "snapshot" ? e.observation.pylons[0] : assert.fail(e.type);
      return p?.phase === "running" ? p.attachedClients : assert.fail(JSON.stringify(p));
    }
  };
  assert.equal(await attachedClients(), 0);
  assert.equal(await attachedClients(), 0);
  assert.equal(logged.filter((line) => line.includes("attached terminals")).length, 1, logged.join("\n"));
  assert.match(logged.find((line) => line.includes("attached terminals"))!, /pgrep exited 127: sh: pgrep: not found. They count as none until a count succeeds/);
  counted = true;
  assert.equal(await attachedClients(), 1, "a count that succeeds again is reported");
});

test("a dropped connection is a lost stream, and the guest process's stdin ends", async (t) => {
  const { client, probe, guestStreams } = await streaming(t);
  const stream = await client.stream(pylonId, ["cat"]);
  await probe.close();
  assert.deepEqual(await stream.done, { kind: "lost" });
  assert.deepEqual(await guestStreams[0]!.done, { kind: "exited", code: 0 });
});

/** A fixed gateway port, as a real probe has, so a second probe in the same test recognizes the first one's entries. */
async function previewSetup(t: import("node:test").TestContext, services: Guest["services"] = () => Promise.reject(new Error("unused"))) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-probe-"));
  t.after(() => rm(dir, { recursive: true }));
  const free = createServer().listen(0, "127.0.0.1");
  await once(free, "listening");
  const gatewayPort = (free.address() as { port: number }).port;
  await new Promise((resolve) => free.close(resolve));
  const tailscale = fakeTailscale();
  const fake = fakeBackend();
  const backend: VmBackend = {
    ...fake.backend,
    guest: (id) => {
      if (fake.pylons.get(id)?.vm !== "running") throw new Error(`${id} is not running`);
      return { previewOrigin: () => "http://127.0.0.1:9", services, linkPort: async (port: number) => `port-${port}`, unlinkPort: async () => null } as unknown as Guest; // nothing listens there
    },
  };
  const logged: string[] = [];
  const previews = { gatewayPort, routesFile: join(dir, "routes.json"), tailscale: tailscale.cli, get: viaGateway(() => `http://127.0.0.1:${gatewayPort}`).get };
  const open = () => setup(t, { backend, previews, log: (line) => logged.push(line) });
  const run = async (client: ReturnType<typeof connectProbe>, job: Job, state: JobStatus["state"] = "succeeded") => {
    const env = envelope(job, node, Date.now());
    await client.submit(env);
    assert.equal((await finished(client, env.jobId)).state, state);
  };
  const visit = (httpsPort: number, headers: Record<string, string> = {}) => new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
    request({ host: "127.0.0.1", port: gatewayPort, headers: { host: `${nodeHost}:${httpsPort}`, ...headers } }, async (res) => {
      let body = "";
      for await (const chunk of res) body += chunk;
      resolve({ status: res.statusCode!, type: res.headers["content-type"], body });
    }).on("error", reject).end();
  });
  return { tailscale, open, run, visit, gatewayPort, logged, fake };
}

const withPreview = (id: PylonId, httpsPort: number): Job =>
  ({ ...spawnJob, pylonId: id, boot: { ...boot, pylonId: id }, live: { previews: [{ service: "web", httpsPort }], overlay: [] } }) as Job;

test("spawn publishes its previews, a hit arrives on observe, pause keeps them and delete unpublishes them", async (t) => {
  const { tailscale, open, run, visit } = await previewSetup(t);
  const { client } = await open();
  await run(client, withPreview(pylonId, 10000));
  assert.deepEqual(Object.keys(tailscale.entries()), ["10000"]);

  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = client.observe(abort.signal)[Symbol.asyncIterator]();
  const snapshot: ProbeEvent | undefined = (await events.next()).value;
  assert.ok(snapshot?.type === "snapshot");
  const observed = snapshot.observation.pylons.find((p) => p.pylonId === pylonId);
  assert.ok(observed?.phase === "running");
  assert.deepEqual(observed.previews, [{ service: "web", httpsPort: 10000, ready: true }], "observations report the published previews");
  assert.deepEqual(snapshot.observation.previewRoutes, [{ httpsPort: 10000, pylonId, service: "web" }], "and the node's routes");
  assert.equal((await visit(10000, { "tailscale-user-login": "someone@example.com" })).status, 502, "the fake guest origin is not listening");
  const hit = (await events.next()).value;
  assert.ok(hit?.type === "preview-hit");
  assert.deepEqual({ pylonId: hit.pylonId, service: hit.service, login: hit.login }, { pylonId, service: "web", login: "someone@example.com" });

  const routesAfter = async (kind: Job["kind"]) => {
    for (;;) {
      const event: ProbeEvent | undefined = (await events.next()).value;
      if (event?.type === "snapshot" && event.observation.jobs.some((j) => j.kind === kind && j.state === "succeeded")) return event.observation.previewRoutes;
    }
  };
  await run(client, { kind: "pause", pylonId, checkpoint: "ckpt-unit-1" });
  assert.deepEqual(Object.keys(tailscale.entries()), ["10000"]);
  assert.deepEqual(await routesAfter("pause"), [{ httpsPort: 10000, pylonId, service: "web" }], "a paused pylon keeps its route");
  await run(client, { kind: "delete", pylonId });
  assert.deepEqual(tailscale.entries(), {});
  assert.deepEqual(await routesAfter("delete"), []);
});

test("observations carry the supervisor's services, and null when it cannot be read", async (t) => {
  let web: ServiceFact | Error = { name: "web", state: "ready", port: 3000, declared: true, wantsPreview: true };
  const ops: string[] = [];
  const { open, run, logged } = await previewSetup(t, async (op) => {
    ops.push(op);
    if (web instanceof Error) throw web;
    return { services: [web] };
  });
  const { client } = await open();
  await run(client, withPreview(pylonId, 10000));
  const seen = async () => {
    for await (const e of client.observe(AbortSignal.timeout(5000))) {
      const p = e.type === "snapshot" ? e.observation.pylons[0] : assert.fail("the first event is a snapshot");
      return p?.phase === "running" ? p.services : assert.fail("the pylon runs");
    }
  };
  assert.deepEqual(await seen(), [web]);
  web = new Error("the controller is gone");
  assert.equal(await seen(), null);
  assert.ok(logged.includes(`${pylonId} services: the controller is gone`));
  assert.deepEqual(new Set(ops), new Set(["list"]), "observing starts and stops nothing");
});

/** /proc/net/tcp with these ports listening on 0.0.0.0. */
const procTcp = (...ports: number[]) => [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  ...ports.map((port, i) => `   ${i}: 00000000:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${2000 + i} 1 0000000000000000 100 0 0 10 0`),
].join("\n");

/** A guest whose only answers are /proc/net/tcp with `ports()`, Herdr with no server, and `linkPort`. */
function listeningGuest(ports: () => number[], linked: number[] = []): Guest {
  return {
    ...fakeGuest((argv, herdr) => herdr ? herdrError("server_not_running")
      : argv[0] === "sh" && argv[2]!.includes("/proc/net/tcp") ? { exitCode: 0, output: procTcp(...ports()) }
      : { exitCode: 1, output: `unexpected ${argv.join(" ")}` }),
    services: async () => ({ services: [] }),
    async linkPort(port) {
      linked.push(port);
      return `port-${port}`;
    },
  };
}

const runningPylon = (e: ProbeEvent) => {
  const p = e.type === "snapshot" ? e.observation.pylons.find((o) => o.pylonId === pylonId) : undefined;
  return p?.phase === "running" ? p : undefined;
};

test("observations carry the ports the guest listens on, and one that starts listening between snapshots publishes a snapshot", async (t) => {
  let ports = [5173];
  const { client } = await setup(t, { listeningPollMs: 20 }, listeningGuest(() => ports));
  const env = envelope(spawnJob, node, Date.now());
  await client.submit(env);
  await finished(client, env.jobId);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = client.observe(abort.signal)[Symbol.asyncIterator]();
  assert.deepEqual(runningPylon((await events.next()).value)?.listening, [{ port: 5173 }]);
  ports = [3000, 5173];
  for (;;) {
    const listening = runningPylon((await events.next()).value)?.listening;
    if (listening === undefined) continue;
    assert.deepEqual(listening, [{ port: 3000 }, { port: 5173 }]);
    break;
  }
});

test("a link-port command links the port in the guest, answers its service, and publishes a snapshot", async (t) => {
  const linked: number[] = [];
  const { client } = await setup(t, { listeningPollMs: 60_000 }, listeningGuest(() => [3000], linked));
  const env = envelope(spawnJob, node, Date.now());
  await client.submit(env);
  await finished(client, env.jobId);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = client.observe(abort.signal)[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "snapshot");
  assert.deepEqual(await client.command(pylonId, { kind: "link-port", port: 3000 }), { kind: "link-port", service: "port-3000" });
  assert.deepEqual(linked, [3000]);
  assert.equal((await events.next()).value?.type, "snapshot", "the control plane sees the new service without waiting a minute");
  await assert.rejects(client.command(pylonId, { kind: "link-port", port: 0 }), /HTTP 400: command.port: Too small: expected number to be >=1$/);
  await assert.rejects(client.command(pylonId, { kind: "link-port", port: 22 }), /HTTP 400: command.port: is Nexus's own: sshd's 22/);
  assert.deepEqual(linked, [3000], "a refused port reaches no guest");
});

test("opening or closing a session publishes a snapshot that lists the change", async (t) => {
  let panes: ReturnType<typeof herdrPane>[] = [];
  const guest = fakeGuest((argv, herdr) => {
    if (!herdr && argv.at(-1) === sessionsFile) return { exitCode: 3, output: "" };
    if (!herdr) return { exitCode: 0, output: "" };
    const sub = argv.slice(0, 2).join(" ");
    if (sub === "api snapshot") return herdrOk(herdrSnapshot([{ id: "w1", label: "review" }], panes));
    if (sub === "workspace list") return herdrOk({ type: "workspace_list", workspaces: [] });
    if (sub === "workspace create") {
      panes = [herdrPane("w1:p1", "w1", "claude", "blocked")];
      return herdrOk({ type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } });
    }
    if (sub === "agent start") return herdrError("agent_not_ready", "waiting at login");
    if (sub === "pane close") {
      panes = [];
      return herdrOk({ type: "ok" });
    }
    throw new Error(`unscripted ${sub}`);
  });
  const { client } = await setup(t, {}, guest);
  await running(client);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = client.observe(abort.signal)[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "snapshot");
  const sessions = async () => {
    const e = (await events.next()).value;
    const p = e?.type === "snapshot" ? e.observation.pylons[0] : assert.fail(`a snapshot, not ${e?.type}`);
    return p?.phase === "running" ? p.sessions?.map((f: { title?: string }) => f.title) : assert.fail("the pylon runs");
  };
  await client.command(pylonId, { kind: "open-session", harness: "claude-code", title: "review" });
  assert.deepEqual(await sessions(), ["review"], "the control plane sees the new session without waiting a minute");
  await client.command(pylonId, { kind: "close-session", herdrPane: "w1:p1" });
  assert.deepEqual(await sessions(), []);
});

test("an unlink-port command waits for a read in flight, which is published before it answers, and the next read leaves the port out", async (t) => {
  let ports = [3000];
  let linked = [3000];
  let gate: PromiseWithResolvers<void> | null = null;
  let reads = 0;
  let unlinkedDuringRead = false;
  const guest: Guest = {
    ...listeningGuest(() => ports),
    async services() {
      reads++;
      await gate?.promise;
      return { services: linked.map((port): ServiceFact => ({ name: `port-${port}`, state: "ready", port, declared: false, wantsPreview: true })) };
    },
    async unlinkPort(port) {
      unlinkedDuringRead ||= gate !== null;
      // A pylon's unlink is a controller round trip, long after the read published before it reached the control plane.
      await until("the read in flight reaches the observer", () => seen.length === 2);
      linked = linked.filter((p) => p !== port);
      return null;
    },
  };
  const { client } = await setup(t, { listeningPollMs: 20 }, guest);
  const env = envelope(spawnJob, node, Date.now());
  await client.submit(env);
  await finished(client, env.jobId);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const seen: string[] = [];
  void (async () => {
    for await (const event of client.observe(abort.signal)) {
      const services = runningPylon(event)?.services;
      if (services) seen.push(`read ${services.map((s) => s.name).join(" ") || "none"}`);
    }
  })().catch(() => undefined);
  /** Waits for the predicate. The deadline only ends a hang: a loaded suite can take seconds over what takes milliseconds alone. */
  const until = async (what: string, predicate: () => boolean) => {
    for (const deadline = Date.now() + 60_000; !predicate();) {
      if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await until("the first snapshot arrives", () => seen.length === 1);

  gate = Promise.withResolvers();
  const before = reads;
  ports = [3000, 5173];
  await until("a read is in flight", () => reads > before);
  const reply = client.command(pylonId, { kind: "unlink-port", port: 3000 }).then((result) => { seen.push("reply"); return result; });
  // Nothing shows the command has reached the probe's queue, so it gets a moment to overtake the read.
  await new Promise((r) => setTimeout(r, 50));
  gate.resolve();
  gate = null;
  assert.deepEqual(await reply, { kind: "unlink-port", refused: null });
  assert.equal(unlinkedDuringRead, false, "the unlink waits for the read in flight");
  assert.deepEqual(linked, []);
  await until("the next read is published", () => seen.at(-1) === "read none");
  assert.deepEqual(seen, ["read port-3000", "read port-3000", "reply", "read none"]);
  await assert.rejects(client.command(pylonId, { kind: "unlink-port", port: 22 }), /HTTP 400: command.port: is Nexus's own: sshd's 22/);
});

test("observations report the previews of the pylon's last successful spawn, not of a spawn that failed", async (t) => {
  const { tailscale, open, run, gatewayPort } = await previewSetup(t);
  const { client } = await open();
  const observedPreviews = async () => {
    const abort = new AbortController();
    const snapshot: ProbeEvent | undefined = (await client.observe(abort.signal)[Symbol.asyncIterator]().next()).value;
    abort.abort();
    assert.ok(snapshot?.type === "snapshot");
    const observed = snapshot.observation.pylons.find((p) => p.pylonId === pylonId);
    assert.ok(observed?.phase === "running");
    return observed.previews;
  };
  await run(client, withPreview(pylonId, 10000));
  tailscale.failOnce(`serve --bg --https=10001 http://127.0.0.1:${gatewayPort}`);
  const both: Job = { ...spawnJob, live: { previews: [{ service: "web", httpsPort: 10000 }, { service: "api", httpsPort: 10001 }], overlay: [] }, liveHash: "hash-2" as LiveHash };
  await run(client, both, "failed");
  assert.deepEqual(await observedPreviews(), [{ service: "web", httpsPort: 10000, ready: true }]);
  await run(client, both);
  assert.deepEqual(await observedPreviews(), [{ service: "web", httpsPort: 10000, ready: true }, { service: "api", httpsPort: 10001, ready: true }]);
});

test("an unlinked port's route is withdrawn at once, and the pylon counts as unapplied until a spawn that started after it", async (t) => {
  const { open, run, visit, fake } = await previewSetup(t);
  const { client } = await open();
  const linked: Job = { ...spawnJob, live: { previews: [{ service: "web", httpsPort: 10000 }, { service: "port-3000", httpsPort: 10001 }], overlay: [] } };
  const observed = async () => {
    const abort = new AbortController();
    const snapshot: ProbeEvent | undefined = (await client.observe(abort.signal)[Symbol.asyncIterator]().next()).value;
    abort.abort();
    assert.ok(snapshot?.type === "snapshot");
    const pylon = snapshot.observation.pylons.find((p) => p.pylonId === pylonId);
    assert.ok(pylon?.phase === "running");
    return { liveHash: pylon.liveHash, previews: pylon.previews.map((p) => p.service) };
  };
  await run(client, linked);
  assert.equal((await visit(10001)).status, 502, "routed to the guest, where nothing listens");

  // A spawn of the same live spec in flight, as when the port is linked again before a snapshot reads the gap.
  fake.hold();
  const inFlight = envelope(linked, node, Date.now());
  await client.submit(inFlight);
  assert.deepEqual(await client.command(pylonId, { kind: "unlink-port", port: 3000 }), { kind: "unlink-port", refused: null });
  assert.equal((await visit(10001)).status, 404);
  assert.deepEqual(await observed(), { liveHash: null, previews: ["web"] }, "the planner sees the pylon unapplied, so it spawns again");
  fake.release();
  assert.equal((await finished(client, inFlight.jobId)).state, "succeeded");
  assert.deepEqual(await observed(), { liveHash: null, previews: ["web"] }, "a spawn that started before the withdraw does not count as applied");
});

test("a spawn planned before an unlink that reaches the probe after it leaves the port unrouted, until the port is linked again", async (t) => {
  const { open, run, visit } = await previewSetup(t);
  const { client } = await open();
  const linked: Job = { ...spawnJob, live: { previews: [{ service: "web", httpsPort: 10000 }, { service: "port-3000", httpsPort: 10001 }], overlay: [] } };
  const observed = async () => {
    const abort = new AbortController();
    const snapshot: ProbeEvent | undefined = (await client.observe(abort.signal)[Symbol.asyncIterator]().next()).value;
    abort.abort();
    assert.ok(snapshot?.type === "snapshot");
    const pylon = snapshot.observation.pylons.find((p) => p.pylonId === pylonId);
    assert.ok(pylon?.phase === "running");
    return { liveHash: pylon.liveHash, previews: pylon.previews.map((p) => p.service), routes: snapshot.observation.previewRoutes?.map((r) => r.service) };
  };
  await run(client, linked);
  assert.deepEqual(await client.command(pylonId, { kind: "unlink-port", port: 3000 }), { kind: "unlink-port", refused: null });

  await run(client, linked);
  assert.equal((await visit(10001)).status, 404);
  assert.deepEqual(await observed(), { liveHash: null, previews: ["web"], routes: ["web"] }, "it does not count as applied, so the planner spawns again");

  assert.deepEqual(await client.command(pylonId, { kind: "link-port", port: 3000 }), { kind: "link-port", service: "port-3000" });
  await run(client, linked);
  assert.equal((await visit(10001)).status, 502, "linking it again is what lets a spawn route it");
  assert.deepEqual(await observed(), { liveHash: "hash-1", previews: ["web", "port-3000"], routes: ["web", "port-3000"] });
});

test("a spawn that started before an unlink leaves the unlinked port unrouted, so a pause right after keeps no route to it", async (t) => {
  const { tailscale, open, run, visit, fake } = await previewSetup(t);
  const { client } = await open();
  const linked: Job = { ...spawnJob, live: { previews: [{ service: "web", httpsPort: 10000 }, { service: "port-3000", httpsPort: 10001 }], overlay: [] } };
  await run(client, linked);
  fake.hold();
  const stale = envelope(linked, node, Date.now());
  await client.submit(stale);
  assert.deepEqual(await client.command(pylonId, { kind: "unlink-port", port: 3000 }), { kind: "unlink-port", refused: null });
  fake.release();
  assert.equal((await finished(client, stale.jobId)).state, "succeeded");
  assert.equal((await visit(10001)).status, 404, "the stale spawn's converge left the withdrawn port out");
  assert.deepEqual(Object.keys(tailscale.entries()), ["10000"]);

  await run(client, { kind: "pause", pylonId, checkpoint: "ckpt-unit-1" });
  const abort = new AbortController();
  const snapshot: ProbeEvent | undefined = (await client.observe(abort.signal)[Symbol.asyncIterator]().next()).value;
  abort.abort();
  assert.ok(snapshot?.type === "snapshot");
  assert.deepEqual(snapshot.observation.previewRoutes, [{ httpsPort: 10000, pylonId, service: "web" }], "the paused pylon keeps only web's route");
});

test("a service declared under an unlinked port's name with a preview is routed again once a read shows it", async (t) => {
  let facts: ServiceFact[] = [];
  const { open, run, visit } = await previewSetup(t, async () => ({ services: facts }));
  const { client } = await open();
  const linked: Job = { ...spawnJob, live: { previews: [{ service: "web", httpsPort: 10000 }, { service: "port-3000", httpsPort: 10001 }], overlay: [] } };
  const observedHash = async () => {
    const abort = new AbortController();
    const snapshot: ProbeEvent | undefined = (await client.observe(abort.signal)[Symbol.asyncIterator]().next()).value;
    abort.abort();
    assert.ok(snapshot?.type === "snapshot");
    const pylon = snapshot.observation.pylons.find((p) => p.pylonId === pylonId);
    assert.ok(pylon?.phase === "running");
    return pylon.liveHash;
  };
  await run(client, linked);
  assert.deepEqual(await client.command(pylonId, { kind: "unlink-port", port: 3000 }), { kind: "unlink-port", refused: null });
  facts = [{ name: "port-3000", state: "ready", port: 4000, declared: true, wantsPreview: true }];
  assert.equal(await observedHash(), null);

  await run(client, linked);
  assert.equal((await visit(10001)).status, 502, "routed to the declared service");
  assert.equal(await observedHash(), "hash-1");
});

test("after a probe restart a paused pylon keeps its preview, and a hit gets the waking page and is reported", async (t) => {
  const { tailscale, open, run, visit } = await previewSetup(t);
  const first = await open();
  await run(first.client, withPreview(pylonId, 10000));
  await run(first.client, { kind: "pause", pylonId, checkpoint: "ckpt-unit-1" });
  await first.probe.close();

  const { client } = await open();
  // Another pylon's spawn sweeps entries the table does not map. The paused pylon's is on file, so it stays.
  await run(client, withPreview("pylon-other" as PylonId, 10001));
  assert.deepEqual(Object.keys(tailscale.entries()).sort(), ["10000", "10001"]);

  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = client.observe(abort.signal)[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "snapshot");
  const page = await visit(10000, { accept: "text/html,application/xhtml+xml" });
  assert.equal(page.status, 503);
  assert.match(page.type ?? "", /^text\/html/);
  assert.match(page.body, /http-equiv="refresh"/);
  const hit = (await events.next()).value;
  assert.ok(hit?.type === "preview-hit" && hit.pylonId === pylonId && hit.service === "web");
});

test("probe git observations derive pushed-branch outputs and bound reads across snapshots and failures", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let reads = 0;
  let readable = true;
  const facts: GitFacts = { head: "a".repeat(40), branch: "agent-deploys", dirty: true, branches: [{ name: "agent-deploys", head: "a".repeat(40), pushedAs: "origin/agent-deploys" }] };
  const guest = fakeGuest((argv, herdr) => {
    if (argv[0] === "python3" && argv[2]?.includes("for-each-ref")) {
      reads++;
      return readable ? { exitCode: 0, output: JSON.stringify(facts) } : { exitCode: null, output: "" };
    }
    if (herdr) return herdrOk(herdrSnapshot([], []));
    if (argv.at(-1) === sessionsFile) return { exitCode: 3, output: "" };
    if (argv[2]?.includes(outputsDir)) return { exitCode: 0, output: "" };
    return { exitCode: 1, output: "" };
  });
  const logged: string[] = [];
  const { client, fake } = await setup(t, { log: (line) => logged.push(line) }, guest);
  fake.pylons.set(pylonId, { pylonId, vm: "running", checkpoint: null, image, bootedAt: "2027-01-01T00:00:00Z" });
  const snapshot = async () => {
    for await (const event of client.observe(AbortSignal.timeout(5000))) {
      assert.equal(event.type, "snapshot");
      if (event.type === "snapshot") return event;
    }
    return assert.fail("missing snapshot");
  };
  const first = await snapshot();
  const p = first.observation.pylons[0]!;
  assert.ok(p.phase === "running");
  assert.deepEqual(p.git, facts);
  assert.equal(reads, 1);
  const outputs = ingest(first, node, new Map([[pylonId, "absent"]]), now).filter((w) => w.record === "output");
  assert.deepEqual(outputs, [
    { record: "output", pylonId, kind: "branch", ref: "origin/agent-deploys" },
    { record: "output", pylonId, kind: "diff", ref: facts.head },
  ]);
  await snapshot();
  assert.equal(reads, 1, "reconnecting observers reuse the same bounded read");
  readable = false;
  now += 60_000;
  const failed = (await snapshot()).observation.pylons[0]!;
  assert.ok(failed.phase === "running");
  assert.equal(failed.git, null);
  assert.deepEqual(failed.sessions, []);
  await snapshot();
  assert.equal(reads, 2, "failures are cached too");
  now += 60_000;
  await snapshot();
  assert.equal(reads, 3);
  assert.equal(logged.filter((line) => line.includes(" git:")).length, 1, "persistent failures log only once");
  fake.pylons.set(pylonId, { pylonId, vm: "stopped", checkpoint: null, image, bootedAt: null, sessions: null });
  await snapshot();
  assert.equal(reads, 3, "paused pylons are not read or woken");
  readable = true;
  fake.pylons.set(pylonId, { pylonId, vm: "running", checkpoint: null, image, bootedAt: "2027-01-01T00:01:00Z" });
  const resumed = (await snapshot()).observation.pylons[0]!;
  assert.ok(resumed.phase === "running");
  assert.deepEqual(resumed.git, facts);
  assert.equal(reads, 4, "a wake invalidates the cache");
  now += 60_000;
  readable = false;
  await snapshot();
  assert.equal(logged.filter((line) => line.includes(" git:")).length, 2, "a recovered read allows a later failure to be logged");
});

test("a branch pushed just after a git read reaches the snapshots only once that read is gitPollMs old", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const before: GitFacts = { head: "a".repeat(40), branch: "feat/x", dirty: false, branches: [{ name: "feat/x", head: "a".repeat(40), pushedAs: null }] };
  let facts = before;
  const guest = fakeGuest((argv, herdr) => {
    if (argv[0] === "python3" && argv[2]?.includes("for-each-ref")) return { exitCode: 0, output: JSON.stringify(facts) };
    if (herdr) return herdrOk(herdrSnapshot([], []));
    if (argv.at(-1) === sessionsFile) return { exitCode: 3, output: "" };
    if (argv[2]?.includes(outputsDir)) return { exitCode: 0, output: "" };
    return { exitCode: 1, output: "" };
  });
  const { client, fake } = await setup(t, {}, guest);
  fake.pylons.set(pylonId, { pylonId, vm: "running", checkpoint: null, image, bootedAt: "2027-01-01T00:00:00Z" });
  const branches = async () => {
    for await (const event of client.observe(AbortSignal.timeout(5000))) {
      if (event.type !== "snapshot") continue;
      return ingest(event, node, new Map([[pylonId, "absent"]]), now).flatMap((w) => w.record === "output" && w.kind === "branch" ? [w.ref] : []);
    }
    return assert.fail("missing snapshot");
  };
  assert.deepEqual(await branches(), []);
  facts = { ...before, branches: [{ ...before.branches[0]!, pushedAs: "origin/feat/x" }] };
  now += gitPollMs - 1;
  assert.deepEqual(await branches(), [], "a snapshot reuses the read from before the push");
  now += 1;
  assert.deepEqual(await branches(), ["origin/feat/x"]);
});

test("stalled controller RPCs cannot hold healthy pylon facts or pile up behind later snapshots", { timeout: 60_000 }, async (t) => {
  const stalled = "pylon-stalled" as PylonId;
  const gitStalled = "pylon-git-stalled" as PylonId;
  const facts: GitFacts = { head: "a".repeat(40), branch: "main", dirty: false, branches: [] };
  const healthy = fakeGuest((argv, herdr) => {
    if (argv[0] === "python3") return { exitCode: 0, output: JSON.stringify(facts) };
    if (herdr) return herdrOk(herdrSnapshot([], []));
    if (argv.at(-1) === sessionsFile) return { exitCode: 3, output: "" };
    if (argv[0] === "pgrep") return { exitCode: 1, output: "0\n" };
    return { exitCode: 0, output: "" };
  });
  healthy.services = async () => ({ services: [] });
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  let blockedCalls = 0;
  let gitCalls = 0;
  const allStuck = Promise.withResolvers<void>();
  const stuck = () => {
    if (blockedCalls === 7 && gitCalls === 1) allStuck.resolve();
    return gate.promise;
  };
  const lateGit = Promise.withResolvers<void>();
  let recovering = false;
  const blocked: Guest = {
    ...healthy,
    async exec(argv, opts) { blockedCalls++; await stuck(); return healthy.exec(argv, opts); },
    async services() { blockedCalls++; await stuck(); return { services: [] }; },
  };
  const gitBlocked: Guest = {
    ...healthy,
    async exec(argv, opts) {
      if (argv[0] !== "python3") return healthy.exec(argv, opts);
      gitCalls++;
      await stuck();
      const reply = await healthy.exec(argv, opts);
      lateGit.resolve();
      return reply;
    },
  };
  const fake = fakeBackend();
  for (const id of [pylonId, stalled, gitStalled]) fake.pylons.set(id, { pylonId: id, vm: "running", checkpoint: null, image, bootedAt: "2027-01-01T00:00:00Z" });
  const { client } = await setup(t, {
    backend: { ...fake.backend, guest: (id) => recovering ? healthy : id === stalled ? blocked : id === gitStalled ? gitBlocked : healthy },
    listeningPollMs: 60_000, log: () => {},
  });
  const snapshot = async () => {
    for await (const event of client.observe(AbortSignal.timeout(60_000))) {
      assert.ok(event.type === "snapshot");
      return event.observation.pylons;
    }
    return assert.fail("missing snapshot");
  };
  // Timers fire only on a tick, so a snapshot that waits on a deadline the ticks do not reach never comes.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reading = snapshot();
  await allStuck.promise; // all fact deadlines run in parallel, not sequentially
  await new Promise((resolve) => setImmediate(resolve)); // the healthy pylon's reads answer within these microtasks
  t.mock.timers.tick(5_000); // the longest fact deadline, not 180 seconds
  const first = await reading;
  const good = first.find((p) => p.pylonId === pylonId)!;
  assert.ok(good.phase === "running");
  assert.deepEqual(good.git, facts);
  const bad = first.find((p) => p.pylonId === stalled)!;
  assert.ok(bad.phase === "running");
  assert.equal(bad.git, null);
  assert.equal(bad.services, null);
  assert.equal(bad.sessions, null);
  const partial = first.find((p) => p.pylonId === gitStalled)!;
  assert.ok(partial.phase === "running");
  assert.equal(partial.git, null);
  assert.deepEqual(partial.sessions, []);
  assert.deepEqual(partial.services, []);
  assert.equal(blockedCalls, 7);
  assert.equal(gitCalls, 1);
  // Expire the Git cache and change the healthy facts while the underlying RPCs are still stuck.
  t.mock.method(Date, "now", () => Date.parse("2099-01-01T00:00:00Z"));
  facts.dirty = true;
  // No tick, so a later snapshot queued behind the timed-out controller calls would never come.
  const second = await snapshot();
  const next = second.find((p) => p.pylonId === pylonId)!;
  assert.ok(next.phase === "running");
  assert.equal(next.git?.dirty, true);
  assert.equal(blockedCalls, 7);
  assert.equal(gitCalls, 1, "even an expired Git cache cannot start another outstanding controller RPC");
  gate.resolve();
  await lateGit.promise;
  const late = (await snapshot()).find((p) => p.pylonId === gitStalled)!;
  assert.ok(late.phase === "running");
  assert.equal(late.git, null, "late replies do not overwrite the timed-out snapshot or its cache");
  recovering = true;
  fake.pylons.set(stalled, { ...fake.pylons.get(stalled)!, bootedAt: "2027-01-01T00:01:00Z" });
  const recovered = (await snapshot()).find((p) => p.pylonId === stalled)!;
  assert.ok(recovered.phase === "running");
  assert.deepEqual(recovered.git, facts);
});
