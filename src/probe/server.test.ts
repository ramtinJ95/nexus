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
import { connectProbe, fetchArtifact, jobDeadlineMs, type ByteStream, type DeclaredOutput, type Job, type JobEnvelope, type JobId, type JobStatus, type LiveHash, type NodeName, type ProbeEvent, type PylonId, type ServiceFact, type StreamRequest, type TailnetNodeId } from "../protocol.ts";
import { envelope } from "../reconcile.ts";
import { processStream } from "../process-stream.ts";
import type { BackendPylon, Guest, VmBackend } from "../backend.ts";
import { fakeTailscale, nodeHost, viaGateway } from "./fake-tailscale.ts";
import type { BootInputs, ProjectId } from "../project.ts";
import type { ArtifactId, ArtifactManifest, ImageId, PortableArtifactId, TemplateId, TemplateManifest } from "../images.ts";
import { fakeGuest, herdrError, herdrOk, herdrPane, herdrSnapshot } from "../fake-guest.ts";
import { outputsDir } from "../outputs.ts";
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
    async buildTemplate(id) { calls.push(`build-template ${id}`); },
    async buildImage(id, _recipe, on) { calls.push(`build-image ${id} on ${on}`); },
    guest: () => { if (guest === null) throw new Error("this test has no guest"); return guest; },
    artifacts: {
      list: async () => [image, ...offered.keys(), ...imported.keys()],
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
    backend, pylons, calls, imported,
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
  assert.deepEqual(await client.submit(checkpoint), { rejected: "invalid", message: "job.artifact is not an image or template ID, and no job drops a checkpoint" });
  const outside = [
    { kind: "drop-artifact", artifact: "tpl-x/../../pylons" },
    { kind: "fetch-artifact", artifact: "img-x/..", from: node, sha256: "0".repeat(64) },
    { kind: "build-template", template: "tpl-..", inputs },
    { kind: "build-image", image: "img-a/b", recipe },
    { ...spawnJob, boot: { ...spawnJob.boot, source: { kind: "template", template: "tpl-../../x" } } },
  ];
  for (const job of outside) {
    const reply = await client.submit(envelope(job as unknown as Job, node, Date.now()));
    assert.ok("rejected" in reply && reply.rejected === "invalid" && / is not an? (image or template|template|image|artifact) ID/.test(reply.message ?? ""), JSON.stringify(reply));
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

test("fetch-artifact imports from the peer probe, and refuses a copy whose sha256 differs from the job's", async (t) => {
  const source = fakeBackend();
  const peerNode = "peer-node" as NodeName;
  const holder = await startProbe({
    node: peerNode, host: "127.0.0.1", port: 0, auth: { controlPlane, peers: [probeNodeId] }, whois: async () => probeNodeId,
    backend: source.backend, secrets: { value: () => undefined }, log: () => undefined,
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
    if (!herdr && argv[2]?.includes(outputsDir)) return { exitCode: 0, output: "" };
    if (!herdr && argv[0] === "pgrep") return { exitCode: 1, output: "0\n" };
    assert.ok(herdr && argv[0] === "api" && argv[1] === "snapshot", "observing runs only herdr api snapshot, the outputs listing and the count of attached terminals");
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
  assert.deepEqual(await sessionsSeen(), [{ herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "bd2c2d6b", status: "working", title: "review" }]);
  readable = false;
  assert.equal(await sessionsSeen(), null);
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
  const { client, probe } = await setup(t, { backend: { ...fake.backend, guest: () => guest }, previews, hostBridge });
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
  const stream = await client.stream(pylonId, { pty: null, argv: ["cat"] });
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
  await assert.rejects(client.command(pylonId, { kind: "link-port", port: 0 }), /HTTP 400: command.port is not an integer from 1 to 65535/);
  await assert.rejects(client.command(pylonId, { kind: "link-port", port: 22 }), /HTTP 400: command.port 22 is Nexus's own/);
  assert.deepEqual(linked, [3000], "a refused port reaches no guest");
});

test("opening or closing a session publishes a snapshot that lists the change", async (t) => {
  let panes: ReturnType<typeof herdrPane>[] = [];
  const guest = fakeGuest((argv, herdr) => {
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
  const guest: Guest = {
    ...listeningGuest(() => ports),
    async services() {
      reads++;
      await gate?.promise;
      return { services: linked.map((port): ServiceFact => ({ name: `port-${port}`, state: "ready", port, declared: false, wantsPreview: true })) };
    },
    async unlinkPort(port) {
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
  const until = async (what: string, predicate: () => boolean) => {
    for (const deadline = Date.now() + 3_000; !predicate();) {
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
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(linked, [3000], "the unlink waits for the read in flight");
  gate.resolve();
  gate = null;
  assert.deepEqual(await reply, { kind: "unlink-port", refused: null });
  assert.deepEqual(linked, []);
  await until("the next read is published", () => seen.at(-1) === "read none");
  assert.deepEqual(seen, ["read port-3000", "read port-3000", "reply", "read none"]);
  await assert.rejects(client.command(pylonId, { kind: "unlink-port", port: 22 }), /HTTP 400: command.port 22 is Nexus's own/);
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
