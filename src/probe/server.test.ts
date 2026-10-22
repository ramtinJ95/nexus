import { test } from "node:test";
import { connect } from "node:net";
import assert from "node:assert/strict";
import { startProbe, type Probe, type ProbeOptions } from "./server.ts";
import { connectProbe, jobDeadlineMs, type ByteStream, type Job, type JobEnvelope, type JobId, type JobStatus, type LiveHash, type NodeName, type PylonId, type StreamRequest, type TailnetNodeId } from "../protocol.ts";
import { envelope } from "../reconcile.ts";
import { processStream } from "../process-stream.ts";
import type { BackendPylon, Guest, VmBackend } from "../backend.ts";
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

/** A running pylon whose guest runs each stream's argv as a local process, as docker exec or ssh would. */
async function streaming(t: import("node:test").TestContext) {
  const fake = fakeBackend();
  const logged: string[] = [];
  const guestStreams: ByteStream[] = [];
  const guest = {
    async stream(req: StreamRequest, log: (text: string) => void) {
      const stream = processStream(req.argv[0]!, req.argv.slice(1), log);
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
  const stream = await client.stream(pylonId, { pty: null, argv: ["sh", "-c", "printf out-bytes; printf err-bytes >&2; exit 3"] });
  assert.equal(await readAll(stream), "out-bytes");
  assert.deepEqual(await stream.done, { kind: "exited", code: 3 });
  assert.ok(logged.some((line) => line.includes(pylonId) && line.includes("err-bytes")), JSON.stringify(logged));
});

test("stdin reaches the guest process, and close ends it", async (t) => {
  const { client } = await streaming(t);
  const stream = await client.stream(pylonId, { pty: null, argv: ["cat"] });
  await stream.write(new TextEncoder().encode("hello through the probe"));
  await stream.close();
  assert.equal(await readAll(stream), "hello through the probe");
  assert.deepEqual(await stream.done, { kind: "exited", code: 0 });
});

test("a process that closes its stdin still delivers its output and exit code", async (t) => {
  const { client } = await streaming(t);
  const stream = await client.stream(pylonId, { pty: null, argv: ["sh", "-c", "exec 0<&-; sleep 1; printf done; exit 7"] });
  await new Promise((r) => setTimeout(r, 300));
  await stream.write(new TextEncoder().encode("nobody reads this"));
  assert.equal(await readAll(stream), "done");
  assert.deepEqual(await stream.done, { kind: "exited", code: 7 });
});

test("a caller that resets its stream connection during whois does not take the probe down", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { client, probe } = await setup(t, {
    whois: async () => { entered.resolve(); await release.promise; return controlPlane; },
    log: () => undefined,
  });
  const socket = connect(probe.port, "127.0.0.1");
  socket.write(`GET /v1/pylons/${pylonId}/stream?request=${encodeURIComponent(JSON.stringify({ pty: null, argv: ["true"] }))} HTTP/1.1\r\nhost: probe\r\nconnection: upgrade\r\nupgrade: nexus-stream\r\n\r\n`);
  await entered.promise;
  socket.resetAndDestroy();
  await new Promise((r) => setTimeout(r, 50));
  release.resolve();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await client.job("after-reset" as JobId), "unknown", "the probe still answers");
});

test("a stream to a pylon that is not running is refused as not-running", async (t) => {
  const { client } = await setup(t);
  await assert.rejects(client.stream(pylonId, { pty: null, argv: ["true"] }), { code: "not-running" });
});

test("only streams with a pty count as attached clients", async (t) => {
  const { client } = await streaming(t);
  const raw = await client.stream(pylonId, { pty: null, argv: ["cat"] });
  const pty = await client.stream(pylonId, { pty: { cols: 80, rows: 24 }, argv: ["cat"] });
  for await (const e of client.observe(AbortSignal.timeout(5000))) {
    const p = e.type === "snapshot" ? e.observation.pylons[0] : assert.fail(e.type);
    assert.ok(p?.phase === "running" && p.attachedClients === 1, JSON.stringify(p));
    break;
  }
  await raw.close();
  await pty.close();
  assert.deepEqual([await raw.done, await pty.done], [{ kind: "exited", code: 0 }, { kind: "exited", code: 0 }]);
});

test("a dropped connection is a lost stream, and the guest process's stdin ends", async (t) => {
  const { client, probe, guestStreams } = await streaming(t);
  const stream = await client.stream(pylonId, { pty: null, argv: ["cat"] });
  await probe.close();
  assert.deepEqual(await stream.done, { kind: "lost" });
  assert.deepEqual(await guestStreams[0]!.done, { kind: "exited", code: 0 });
});
