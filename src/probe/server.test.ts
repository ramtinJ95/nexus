import { test } from "node:test";
import assert from "node:assert/strict";
import { startProbe, type Probe, type ProbeOptions } from "./server.ts";
import { connectProbe, jobDeadlineMs, type Job, type JobEnvelope, type JobId, type JobStatus, type LiveHash, type NodeName, type PylonId, type TailnetNodeId } from "../protocol.ts";
import { envelope } from "../reconcile.ts";
import type { BackendPylon, Guest, VmBackend } from "../backend.ts";
import type { BootInputs } from "../project.ts";
import type { ImageId } from "../images.ts";
import { fakeGuest, herdrError, herdrOk, herdrPane, herdrSnapshot } from "../fake-guest.ts";

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
function fakeBackend(guest: Guest | null = null) {
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
    guest: () => { if (guest === null) throw new Error("this test has no guest"); return guest; },
    artifacts: {
      list: async () => [image],
      export: () => Promise.reject(new Error("unused")),
      import: () => Promise.reject(new Error("unused")),
      drop: () => Promise.reject(new Error("unused")),
    },
  };
  return { backend, pylons, hold() { gate = Promise.withResolvers(); }, release() { gate?.resolve(); gate = null; } };
}

async function setup(t: import("node:test").TestContext, overrides: Partial<ProbeOptions> = {}, guest: Guest | null = null) {
  const fake = fakeBackend(guest);
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
  assert.deepEqual(await client.command(pylonId, { kind: "close-session", herdrPane: "w1:p1" }), { kind: "close-session" });
});

test("a command for a pylon that is not running is refused as not-running", async (t) => {
  const guest = fakeGuest(() => { throw new Error("no exec expected"); });
  const { client, fake } = await setup(t, {}, guest);
  await assert.rejects(client.command(pylonId, { kind: "exec", argv: ["true"], cwd: "/", timeoutMs: 1000 }), { code: "not-running" });
  fake.pylons.set(pylonId, { pylonId, vm: "stopped", checkpoint: "ckpt-unit-1", image, bootedAt: null });
  await assert.rejects(client.command(pylonId, { kind: "close-session", herdrPane: "w1:p1" }), { code: "not-running" });
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
  assert.equal(await post({ kind: "reboot" }), 400);
  assert.deepEqual(guest.execs, []);
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
    assert.ok(herdr && argv[0] === "api" && argv[1] === "snapshot", "observing runs only herdr api snapshot");
    return readable
      ? herdrOk(herdrSnapshot([{ id: "w1", label: "review" }], [herdrPane("w1:p1", "w1", "claude", "working", { kind: "id", value: "bd2c2d6b" })]))
      : { exitCode: 1, output: "Error: exec failed" };
  });
  const { client } = await setup(t, {}, guest);
  await running(client);

  const sessionsSeen = async () => {
    for await (const e of client.observe(AbortSignal.timeout(5000))) {
      const p = e.type === "snapshot" ? e.observation.pylons[0] : assert.fail("the first event is a snapshot");
      return p?.phase === "running" ? p.sessions : assert.fail("the pylon runs");
    }
  };
  assert.deepEqual(await sessionsSeen(), [{ herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "bd2c2d6b", status: "working" }]);
  readable = false;
  assert.equal(await sessionsSeen(), null);
});
