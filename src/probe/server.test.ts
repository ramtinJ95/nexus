import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProbe, type Probe, type ProbeOptions } from "./server.ts";
import { connectProbe, jobDeadlineMs, type Job, type JobEnvelope, type JobId, type JobStatus, type LiveHash, type NodeName, type PylonId, type TailnetNodeId } from "../protocol.ts";
import { envelope } from "../reconcile.ts";
import type { BackendPylon, Guest, VmBackend } from "../backend.ts";
import { fakeTailscale, nodeHost, viaGateway } from "./fake-tailscale.ts";
import type { BootInputs } from "../project.ts";
import type { ImageId } from "../images.ts";

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
  repo: { url: "git@example.com:r.git", checkout: { branch: "main", commit: "c0ffee" } },
};
const spawnJob: Job = { kind: "spawn", pylonId, boot, live: { previews: [], overlay: [] }, liveHash: "hash-1" as LiveHash };

/** An in-memory backend. `gate` holds every lifecycle call until it is released or the job's signal aborts. */
function fakeBackend() {
  const pylons = new Map<PylonId, BackendPylon>();
  let gate: PromiseWithResolvers<void> | null = null;
  const held = (signal: AbortSignal) => gate === null ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    gate!.promise.then(resolve);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const backend: VmBackend = {
    async ensureRunning(b, _live, signal) {
      await held(signal);
      pylons.set(b.pylonId, { pylonId: b.pylonId, vm: "running", checkpoint: null, image: b.image, bootedAt: "2027-01-01T00:00:00Z" });
    },
    async ensurePaused(id, checkpoint, signal) {
      await held(signal);
      pylons.set(id, { pylonId: id, vm: "stopped", checkpoint, image, bootedAt: null });
    },
    async ensureDeleted(id, signal) {
      await held(signal);
      pylons.delete(id);
    },
    async list() { return [...pylons.values()]; },
    buildTemplate: () => Promise.reject(new Error("unused")),
    guest: () => { throw new Error("unused"); },
    artifacts: {
      list: async () => [image],
      export: () => Promise.reject(new Error("unused")),
      import: () => Promise.reject(new Error("unused")),
      drop: () => Promise.reject(new Error("unused")),
    },
  };
  return { backend, pylons, hold() { gate = Promise.withResolvers(); }, release() { gate?.resolve(); gate = null; } };
}

async function setup(t: import("node:test").TestContext, overrides: Partial<ProbeOptions> = {}) {
  const fake = fakeBackend();
  let caller: TailnetNodeId | null = controlPlane;
  const probe: Probe = await startProbe({
    node, host: "127.0.0.1", port: 0,
    auth: { controlPlane, peers: [peer] },
    whois: async () => caller,
    backend: fake.backend,
    secrets: { value: () => undefined },
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
  assert.equal((await fetch(`${base}/v1/artifacts/img-1`)).status, 501, "a peer may reach the artifacts route, which this slice does not implement");
  callAs(controlPlane);
  assert.equal((await fetch(`${base}/v1/artifacts/img-1`)).status, 403);
  assert.equal((await fetch(`${base}/v1/jobs/x`)).status, 404);
});

test("the client refuses a probe that whois does not name", async (t) => {
  const { probe } = await setup(t);
  const impostor = connectProbe(node, "127.0.0.1", probeNodeId, { port: probe.port, whois: async () => "nOTHER" as TailnetNodeId });
  await assert.rejects(impostor.job("x" as JobId), { code: "forbidden" });
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

test("jobs this slice does not run fail with invalid", async (t) => {
  const { client } = await setup(t);
  const env: JobEnvelope = envelope({ kind: "drop-artifact", artifact: image }, node, Date.now());
  assert.ok("accepted" in await client.submit(env));
  const status = await finished(client, env.jobId);
  assert.equal(status.state, "failed");
  assert.ok(status.state === "failed" && status.code === "invalid");
  assert.match(status.state === "failed" ? status.message : "", /not implemented in this slice/);
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

/** A fixed gateway port, as a real probe has, so a second probe in the same test recognizes the first one's entries. */
async function previewSetup(t: import("node:test").TestContext) {
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
      return { previewOrigin: () => "http://127.0.0.1:9" } as unknown as Guest; // nothing listens there
    },
  };
  const previews = { gatewayPort, routesFile: join(dir, "routes.json"), tailscale: tailscale.cli, get: viaGateway(() => `http://127.0.0.1:${gatewayPort}`).get };
  const open = () => setup(t, { backend, previews });
  const run = async (client: ReturnType<typeof connectProbe>, job: Job) => {
    const env = envelope(job, node, Date.now());
    await client.submit(env);
    assert.equal((await finished(client, env.jobId)).state, "succeeded");
  };
  const visit = (httpsPort: number, headers: Record<string, string> = {}) => new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
    request({ host: "127.0.0.1", port: gatewayPort, headers: { host: `${nodeHost}:${httpsPort}`, ...headers } }, async (res) => {
      let body = "";
      for await (const chunk of res) body += chunk;
      resolve({ status: res.statusCode!, type: res.headers["content-type"], body });
    }).on("error", reject).end();
  });
  return { tailscale, open, run, visit };
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
  assert.equal((await events.next()).value?.type, "snapshot");
  assert.equal((await visit(10000, { "tailscale-user-login": "someone@example.com" })).status, 502, "the fake guest origin is not listening");
  const hit = (await events.next()).value;
  assert.ok(hit?.type === "preview-hit");
  assert.deepEqual({ pylonId: hit.pylonId, service: hit.service, login: hit.login }, { pylonId, service: "web", login: "someone@example.com" });

  await run(client, { kind: "pause", pylonId, checkpoint: "ckpt-unit-1" });
  assert.deepEqual(Object.keys(tailscale.entries()), ["10000"]);
  await run(client, { kind: "delete", pylonId });
  assert.deepEqual(tailscale.entries(), {});
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
