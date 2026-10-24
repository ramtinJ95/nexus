import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { maxStreams, startApi, type ThreadDetail, type ThreadRow } from "./api.ts";
import { readEvents } from "./event-reader.ts";
import { fakeHarness } from "./fake-harness.ts";
import { openRegistry, type Thread } from "./registry.ts";
import { liveHashOf } from "../project.ts";
import { processStream } from "../process-stream.ts";
import { checkoutDir } from "../sessions.ts";
import type { ByteStream, CommandResult, JobId, NodeName, PylonCommand, PylonId, ServiceFact, StreamRequest, TailnetNodeId } from "../protocol.ts";

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const project = {
  id: "acme", repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: ["registry.npmjs.org"],
  secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }], logins: ["chatgpt"], preSetup: null,
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
  },
};

const dotfiles = { repo: "git@github.com:ramtin/dotfiles.git", ref: "main" };

const dir = await mkdtemp(join(tmpdir(), "nexus-api-"));
after(() => rm(dir, { recursive: true }));

async function setup(t: import("node:test").TestContext, options: { dotfiles?: typeof dotfiles; streamStallMs?: number } = {}) {
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  let caller: TailnetNodeId | null = laptop;
  const woken: NodeName[] = [];
  const fake = fakeHarness();
  const { harness, calls } = fake;
  const commands: [PylonId, PylonCommand][] = [];
  /** What the node's probe answers a guest command with. Tests replace it. */
  let answer = async (command: PylonCommand): Promise<CommandResult> => {
    if (command.kind === "link-port") return { kind: "link-port", service: `port-${command.port}` };
    if (command.kind === "unlink-port") return { kind: "unlink-port", refused: null };
    if (command.kind === "open-session") return { kind: "open-session", herdrPane: "w1:p1" };
    if (command.kind === "close-session") return { kind: "close-session" };
    throw new Error(`unexpected ${command.kind} command`);
  };
  const streams: [PylonId, StreamRequest][] = [];
  /** What the node's probe opens a pipe to. Tests replace it. */
  let pipe = async (request: StreamRequest): Promise<ByteStream> => { throw new Error(`unexpected stream ${request.argv[0]}`); };
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0,
    // Every loopback caller is whoever the test says. Tests never ask tailscaled.
    whois: async () => caller,
    allowed: new Set([laptop]),
    hostnames: new Set(["127.0.0.1"]),
    dotfiles: options.dotfiles ?? dotfiles,
    harness,
    wake: (n) => { woken.push(n); },
    probes: new Map([[node, {
      command: (pylonId: PylonId, command: PylonCommand) => { commands.push([pylonId, command]); return answer(command); },
      stream: (pylonId: PylonId, request: StreamRequest) => { streams.push([pylonId, request]); return pipe(request); },
    }]]),
    previewPorts: { first: 10200, last: 10299 },
    ...options.streamStallMs === undefined ? {} : { streamStallMs: options.streamStallMs },
  });
  t.after(async () => {
    await api.close();
    registry.close();
  });
  /** Sends JSON as the dashboard and CLI do. `headers` overrides any header, so tests can pose as a browser page. */
  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port: api.port, method, path,
        // As fetch and the CLI do. Node frames a DELETE's body only with an explicit length.
        headers: { host: `127.0.0.1:${api.port}`, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }), ...headers },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: text === "" ? null : JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
  /** A GET whose body is kept as bytes, with the reply's headers. */
  function raw(path: string): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port: api.port, method: "GET", path, headers: { host: `127.0.0.1:${api.port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on("error", reject).end();
    });
  }
  return {
    registry, call, raw, woken, calls, commands, streams, fake,
    callAs(id: TailnetNodeId | null) { caller = id; },
    probeAnswers(next: typeof answer) { answer = next; },
    probePipes(next: typeof pipe) { pipe = next; },
    events: (path: string) => readEvents(api.port, path),
  };
}

async function withThread(t: import("node:test").TestContext, options: { project?: typeof project; dotfiles?: typeof dotfiles; streamStallMs?: number } = {}) {
  const s = await setup(t, options);
  assert.equal((await s.call("POST", "/v1/projects", options.project ?? project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  assert.equal((await s.call("PUT", "/v1/images/current", { image: image.id })).status, 204);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Fix checkout" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  return { ...s, thread: started.body as Thread };
}

test("callers off the allowlist, or unknown to tailscaled, are refused", async (t) => {
  const s = await setup(t);
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.call("GET", "/v1/projects")).status, 403);
  s.callAs(null);
  assert.equal((await s.call("GET", "/v1/projects")).status, 403);
  s.callAs(laptop);
  assert.deepEqual(await s.call("GET", "/v1/projects"), { status: 200, body: [] });
});

test("a web page on an allowed machine cannot change state", async (t) => {
  const s = await setup(t);
  // A cross-origin form or fetch without a preflight can only send a simple content type.
  const forged = await s.call("POST", "/v1/projects", JSON.stringify(project), { "content-type": "text/plain" });
  assert.equal(forged.status, 415);
  // A DNS rebinding page reaches the API under the page's own name.
  assert.equal((await s.call("GET", "/v1/projects", undefined, { host: "evil.example:80" })).status, 403);
  assert.equal((await s.call("POST", "/v1/projects", project, { host: "evil.example" })).status, 403);
  assert.deepEqual(s.registry.projects(), []);
});

test("projects are created, listed, and checked", async (t) => {
  const s = await setup(t);
  assert.deepEqual(await s.call("POST", "/v1/projects", project), { status: 201, body: project });
  assert.deepEqual(await s.call("GET", "/v1/projects"), { status: 200, body: [project] });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 409);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", defaultNode: "nowhere" })).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", resources: { cpus: 0, memoryGiB: 4, diskGiB: 10 } })).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", extra: true })).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", repoUrl: "https://" })).status, 400, "a pylon's allowlist needs the host of an HTTPS repo");
});

test("nodes are listed with their state and capacity, without the observation", async (t) => {
  const s = await setup(t);
  const offline = { name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT", state: "offline", capacity: null, observedAt: null };
  assert.deepEqual(await s.call("GET", "/v1/nodes"), { status: 200, body: [offline] });
  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  s.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [], previewRoutes: [] }, []);
  assert.deepEqual((await s.call("GET", "/v1/nodes")).body, [{ ...offline, state: "online", capacity, observedAt: "2027-01-01T00:01:00Z" }]);
});

test("a thread cannot start before an image is current", async (t) => {
  const s = await setup(t);
  await s.call("POST", "/v1/projects", project);
  const res = await s.call("POST", "/v1/threads", { project: "acme", title: "x" });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /no image is current/);
  assert.equal((await s.call("PUT", "/v1/images/current", { image: image.id })).status, 404);
  assert.equal((await s.call("POST", "/v1/threads", { project: "nope", title: "x" })).status, 404);
});

test("an image is recorded only with every pin, gh included, each in its pinned format", async (t) => {
  const s = await setup(t);
  const { gh: _, ...withoutGh } = image.pins;
  assert.equal((await s.call("POST", "/v1/images", { ...image, pins: withoutGh })).status, 400);
  assert.equal((await s.call("POST", "/v1/images", { ...image, pins: { ...image.pins, ghSha256: "not-a-digest" } })).status, 400);
  assert.equal((await s.call("POST", "/v1/images", { ...image, pins: { ...image.pins, extra: "1" } })).status, 400);
  assert.equal((await s.call("PUT", "/v1/images/current", { image: image.id })).status, 404, "a refused image is not recorded");
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
});

test("starting a thread creates its pylon, boots fresh from the current image, and wakes its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  assert.equal(thread.status, "active");
  assert.equal(thread.startedBy, laptop);
  assert.equal(thread.pylonId, `pylon-${thread.id}`);
  assert.ok(thread.pylonId.length <= 40);
  assert.deepEqual(s.calls, [["start", { threadId: thread.id, pylonId: thread.pylonId }]]);
  assert.equal(thread.conversationId, "1");
  assert.deepEqual(s.woken, [node]);
  const row = { ...thread, desired: "running", pylon: { node, actualState: "unknown", failed: null } };
  assert.deepEqual((await s.call("GET", "/v1/threads")).body, [row]);
  assert.deepEqual((await s.call("GET", "/v1/threads?project=acme")).body, [row]);
  assert.deepEqual((await s.call("GET", "/v1/threads?project=other")).body, []);

  const pylon = s.registry.pylon(thread.pylonId)!;
  assert.equal(pylon.node, node);
  assert.deepEqual(pylon.firstBoot, { kind: "fresh", preSetup: null });
  assert.deepEqual(pylon.boot, {
    pylonId: thread.pylonId, image: image.id, resources: project.resources,
    network: { allowedHosts: ["api.openai.com", "api.stripe.com", "auth.openai.com", "chatgpt.com", "registry.npmjs.org"], secrets: project.secrets },
    repo: { url: project.repoUrl, checkout: { branch: "main", commit: "origin/main" } },
    dotfiles,
  });
  assert.deepEqual(pylon.live.previews, [], "ports are allocated once the pylon reports services that want them");
  assert.deepEqual(pylon.live.overlay.map((f) => f.path), ["/etc/profile.d/nexus.sh", "/home/user/.nexus/pylon.json", "/home/user/.nexus/PYLON.md"]);
  assert.deepEqual(JSON.parse(pylon.live.overlay[1]!.content), {
    pylonId: thread.pylonId, threadId: thread.id, project: "acme", node, api: "http://nexus.pylon",
    allowedHosts: pylon.boot.network.allowedHosts, previews: [], logins: ["chatgpt"], dotfiles,
  });
  assert.equal(pylon.liveHash, liveHashOf(pylon.live));
  assert.equal(pylon.submitted, null);
});

test("a pylon's allowlist reaches its project's HTTPS repo host and the HTTPS dotfiles host", async (t) => {
  const s = await withThread(t, {
    project: { ...project, repoUrl: "https://github.com/octocat/Spoon-Knife.git", allowedHosts: [], secrets: [], logins: [] },
    dotfiles: { repo: "https://gitlab.example.com/ramtin/dotfiles.git", ref: "main" },
  });
  assert.deepEqual(s.registry.pylon(s.thread.pylonId)!.boot.network.allowedHosts, ["github.com", "gitlab.example.com"]);
});

test("thread detail derives the actual state from the node's last observation", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const detail = async () => (await s.call("GET", `/v1/threads/${thread.id}`)).body as ThreadDetail;

  assert.deepEqual(await detail(), {
    thread,
    desired: "running",
    pylon: { id: thread.pylonId, node, actualState: "unknown", failed: null, observedAt: null, retryRefused: null },
    sessions: [], previews: [], ports: [], outputs: [], attach: "herdr --session nexus", agent: { parkedTasks: 0 },
  });

  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const pylon = s.registry.pylon(thread.pylonId)!;
  const running = {
    pylonId: thread.pylonId, phase: "running" as const, liveHash: pylon.liveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  s.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [running], previewRoutes: [] }, []);
  const pause = { jobId: "job-1" as JobId, subject: thread.pylonId, kind: "pause" as const };
  s.registry.apply({ record: "job", status: { ...pause, state: "running", startedAt: "2027-01-01T00:00:59Z" } });
  s.registry.apply({ record: "session", pylonId: thread.pylonId, herdrPane: "p1", fact: { herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "idle", title: "plan" } });
  s.registry.apply({ record: "output", pylonId: thread.pylonId, kind: "branch", ref: "nexus/fix" });
  s.registry.allocatePreviews(thread.pylonId, ["web"], { first: 8443, last: 8443 });
  s.registry.apply({ record: "preview", pylonId: thread.pylonId, service: "web", httpsPort: 8443, ready: true });

  const d = await detail();
  assert.equal(d.pylon.actualState, "pausing");
  assert.equal(d.pylon.observedAt, "2027-01-01T00:01:00Z");
  assert.deepEqual(d.sessions, [{ pylon: thread.pylonId, herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "idle", title: "plan" }]);
  assert.deepEqual(d.outputs, [{ thread: thread.id, kind: "branch", ref: "nexus/fix" }]);
  assert.deepEqual(d.previews, [{ pylon: thread.pylonId, service: "web", httpsPort: 8443, ready: true, failed: null, url: "https://rj-firebat.tail.ts.net:8443/" }]);

  s.registry.apply({ record: "job", status: { ...pause, state: "succeeded", finishedAt: "2027-01-01T00:01:30Z" } });
  assert.equal((await detail()).pylon.actualState, "running");
  s.registry.markOffline(node);
  assert.equal((await detail()).pylon.actualState, "unknown");
});

/** Reports the node online with the thread's pylon running these services and listening on these ports. */
function observeRunning(s: Awaited<ReturnType<typeof withThread>>, facts: { services?: ServiceFact[]; listening?: { port: number }[] | null }) {
  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const running = {
    pylonId: s.thread.pylonId, phase: "running" as const, liveHash: s.registry.pylon(s.thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: facts.services ?? [], listening: facts.listening === undefined ? [] : facts.listening, previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [running], previewRoutes: [] }, []);
}

test("thread detail lists the pylon's listening ports with the service and preview of each", async (t) => {
  const s = await withThread(t);
  const ports = async () => ((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports;
  const web: ServiceFact = { name: "web", state: "ready", port: 5173, declared: true, wantsPreview: true };
  const api: ServiceFact = { name: "api", state: "ready", port: 8080, declared: true, wantsPreview: false };
  observeRunning(s, { services: [web, api], listening: [{ port: 3000 }, { port: 5173 }, { port: 8080 }] });
  s.registry.allocatePreviews(s.thread.pylonId, ["web"], { first: 10200, last: 10299 });
  assert.deepEqual(await ports(), [
    { port: 3000, service: null, preview: null },
    { port: 5173, service: "web", preview: { pylon: s.thread.pylonId, service: "web", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" } },
    { port: 8080, service: "api", preview: null },
  ]);
  observeRunning(s, { listening: null });
  assert.equal(await ports(), null, "ports the node could not read are unknown, not none");
  s.registry.ingested({ ...s.registry.node(node)!.observation!, pylons: [{ pylonId: s.thread.pylonId, phase: "stopped", checkpoint: null }] }, []);
  assert.deepEqual(await ports(), [], "nothing listens in a stopped pylon");
});

test("linking a port goes through the node's probe, gives it an https port at once, and counts as human activity", async (t) => {
  const s = await withThread(t);
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  const linked = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  const preview = { pylon: s.thread.pylonId, service: "port-3000", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" };
  assert.deepEqual(linked, { status: 200, body: preview });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "link-port", port: 3000 }]]);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node), "the loop publishes the new port at its next pass");
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 }), { status: 200, body: preview }, "linking again answers the same preview");
  observeRunning(s, { services: [], listening: [{ port: 3000 }] });
  assert.deepEqual(((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports, [{ port: 3000, service: "port-3000", preview }], "the port has its preview before the node lists its service");
  observeRunning(s, { services: [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], listening: [{ port: 3000 }] });
  assert.deepEqual(((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports, [{ port: 3000, service: "port-3000", preview }]);

  // A port a declared service owns is previewed under that service.
  s.probeAnswers(async () => ({ kind: "link-port", service: "web" }));
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 5173 })).body.service, "web");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 70000 })).status, 400);
  const commands = s.commands.length;
  const reserved = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 22 });
  assert.equal(reserved.status, 400);
  assert.match(reserved.body.error, /is Nexus's own/);
  assert.equal(s.commands.length, commands, "a reserved port never reaches the probe");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000, title: "App" })).status, 400, "a preview has no title");
});

test("linking a port of a pylon that is not running, or of an archived or deleted thread, is refused with 409", async (t) => {
  const s = await withThread(t);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  const paused = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: connect ECONNREFUSED"), { code: "unreachable" }); });
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).status, 503);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.commands.length = 0;
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).status, 409);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).status, 409);
  assert.deepEqual(s.commands, [], "an archived or deleted thread's probe is never asked");
  assert.deepEqual(s.registry.previews(s.thread.pylonId), []);
});

test("unpublishing a linked port goes through the node's probe, drops its preview at once, counts as human activity, and is safe to repeat", async (t) => {
  const s = await withThread(t);
  const detail = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail;
  const linked = (await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).body;
  // The node's last read still lists the port's service, as it does until its next read.
  observeRunning(s, { services: [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], listening: [{ port: 3000 }] });
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  s.commands.length = 0;
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {}), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "unlink-port", port: 3000 }]]);
  assert.deepEqual((await detail()).previews, []);
  assert.deepEqual((await detail()).ports, [{ port: 3000, service: "port-3000", preview: null }], "the port is listed again, without a preview");
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node), "the loop publishes the previews without it at its next pass");
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {}), { status: 204, body: null }, "unpublishing again succeeds");
  assert.equal(s.commands.length, 2, "and asks the pylon again, which knows whether the port is linked");
  assert.deepEqual((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).body, linked, "the port can be published again, on the port it freed");

  // The pylon refuses a port a service's preview owns, and its reason, which names the service, is the whole error.
  s.registry.allocatePreviews(s.thread.pylonId, ["web"], { first: 10200, last: 10299 });
  const reason = "Port 5173 is the preview of service web, not a linked port. Remove the preview from /home/user/workspace/repo/.nexus/services.yaml to unpublish it";
  s.probeAnswers(async () => ({ kind: "unlink-port", refused: reason }));
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/5173`, {}), { status: 422, body: { error: reason } });
  assert.deepEqual((await detail()).previews.map((p) => p.service), ["port-3000", "web"], "a refused unlink keeps every preview");

  s.commands.length = 0;
  for (const port of ["abc", "0", "70000", "22"]) assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/${port}`, {})).status, 400, port);
  assert.deepEqual(s.commands, [], "a bad or reserved port never reaches the probe");
});

test("unpublishing a port of a pylon that is not running, or of an archived or deleted thread, is refused with 409", async (t) => {
  const s = await withThread(t);
  await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.woken.length = 0;
  const paused = await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {});
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.woken.includes(node), "the request wakes the pylon");
  assert.deepEqual(s.registry.previews(s.thread.pylonId).map((p) => p.service), ["port-3000"], "the preview stays until the pylon unlinks the port");
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: connect ECONNREFUSED"), { code: "unreachable" }); });
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {})).status, 503);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.commands.length = 0;
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {})).status, 409);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {})).status, 409);
  assert.deepEqual(s.commands, [], "an archived or deleted thread's probe is never asked");
});

test("opening a session goes through the node's probe, defaults to Claude Code titled by its harness, and counts as human activity", async (t) => {
  const s = await withThread(t);
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, {}), { status: 201, body: { herdrPane: "w1:p1", harness: "claude-code", title: "claude-code" } });
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, { harness: "pi", title: " plan " }), { status: 201, body: { herdrPane: "w1:p1", harness: "pi", title: "plan" } });
  assert.deepEqual(s.commands, [
    [s.thread.pylonId, { kind: "open-session", harness: "claude-code", title: "claude-code" }],
    [s.thread.pylonId, { kind: "open-session", harness: "pi", title: "plan" }],
  ]);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node));

  s.commands.length = 0;
  for (const body of [{ harness: "codex" }, { title: "" }, { title: "x".repeat(81) }, { resume: "bd2c2d6b" }]) {
    assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(s.commands, [], "a bad request never reaches the probe");
});

const git = promisify(execFile);

/** A checkout on this machine whose first commit is refs/nexus/base, which the probe's pipes read in place of the pylon's. */
async function localCheckout(t: import("node:test").TestContext, s: { probePipes(next: (request: StreamRequest) => Promise<ByteStream>): void }) {
  const repo = await mkdtemp(join(tmpdir(), "nexus-api-checkout-"));
  t.after(() => rm(repo, { recursive: true }));
  const run = (...args: string[]) => git("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "app.ts"), "export const a = 1;\n");
  await run("init", "-q");
  await run("add", "-A");
  await run("commit", "-q", "-m", "first");
  await run("update-ref", "refs/nexus/base", "HEAD");
  const base = (await run("rev-parse", "HEAD")).stdout.trim();
  s.probePipes(async ({ argv }) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? repo : arg), () => {}));
  return { repo, run, base };
}

test("a thread's files and changes are read from its checkout through its node's probe, and reading counts as human activity", async (t) => {
  const s = await withThread(t);
  const { repo, base } = await localCheckout(t, s);
  await writeFile(join(repo, "src", "app.ts"), "export const a = 2;\n");
  await writeFile(join(repo, "shot.png"), Buffer.from([0x89, 0x50, 0, 255]));
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  const id = s.thread.id;

  const root = await s.call("GET", `/v1/threads/${id}/files`);
  assert.equal(root.status, 200);
  assert.deepEqual(root.body.entries.filter((e: { name: string }) => e.name !== ".git"), [{ name: "shot.png", kind: "file", size: 4 }, { name: "src", kind: "dir", size: null }]);
  assert.deepEqual((await s.call("GET", `/v1/threads/${id}/files?path=src`)).body, { path: "src", entries: [{ name: "app.ts", kind: "file", size: 20 }], truncated: false });

  const shot = await s.raw(`/v1/threads/${id}/files/content?path=shot.png`);
  assert.equal(shot.status, 200);
  assert.deepEqual(shot.body, Buffer.from([0x89, 0x50, 0, 255]));
  assert.equal(shot.headers["content-type"], "image/png");
  assert.equal(shot.headers["x-content-type-options"], "nosniff");
  assert.equal(shot.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal((await s.raw(`/v1/threads/${id}/files/content?path=src%2Fapp.ts`)).body.toString(), "export const a = 2;\n");

  assert.deepEqual(await s.call("GET", `/v1/threads/${id}/changes`), {
    status: 200,
    body: {
      base: { kind: "start", commit: base },
      files: [
        { path: "shot.png", oldPath: null, status: "added", additions: null, deletions: null },
        { path: "src/app.ts", oldPath: null, status: "modified", additions: 1, deletions: 1 },
      ],
      truncated: false,
    },
  });
  const diff = await s.call("GET", `/v1/threads/${id}/diff?base=head&path=src%2Fapp.ts`);
  assert.equal(diff.status, 200);
  assert.equal(diff.body.base.kind, "head");
  assert.match(diff.body.diff, /^diff --git a\/src\/app.ts b\/src\/app.ts\n[^]*-export const a = 1;\n\+export const a = 2;\n$/);

  assert.ok(s.streams.every(([pylon, request]) => pylon === s.thread.pylonId && request.pty === null));
  assert.ok(s.registry.thread(id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node));
});

test("a checkout read the pylon refuses answers its status, and a bad request never reaches the probe", async (t) => {
  const s = await withThread(t);
  const { run } = await localCheckout(t, s);
  const id = s.thread.id;
  const refusal = async (path: string, status: number, message: RegExp) => {
    const reply = await s.call("GET", path);
    assert.equal(reply.status, status, path);
    assert.match(reply.body.error, message, path);
  };
  await refusal(`/v1/threads/${id}/files?path=nope`, 404, /nope does not exist/);
  await refusal(`/v1/threads/${id}/files/content?path=src`, 400, /src is not a file/);
  await refusal(`/v1/threads/${id}/files?path=..%2F..`, 400, /outside the checkout/);
  await run("update-ref", "-d", "refs/nexus/base");
  await refusal(`/v1/threads/${id}/changes`, 422, /no refs\/nexus\/base/);
  assert.equal((await s.call("GET", `/v1/threads/${id}/changes?base=head`)).status, 200);

  s.streams.length = 0;
  for (const path of [`/v1/threads/${id}/changes?base=main`, `/v1/threads/${id}/diff?base=tip`, `/v1/threads/${id}/files/content`, `/v1/threads/${id}/files/content?path=`, `/v1/threads/${id}/files?path=a%00b`, `/v1/threads/${id}/diff?${Array(100).fill(`path=${"p".repeat(154)}`).join("&")}`, `/v1/threads/${id}/files?path=${"%C3%A9".repeat(2000)}`]) {
    assert.equal((await s.call("GET", path)).status, 400, path);
  }
  assert.deepEqual(s.streams, [], "a bad request never reaches the probe");
});

test("reading the checkout of a pylon that is not running wakes it and is refused with 409, and an archived thread's probe is never asked", async (t) => {
  const s = await withThread(t);
  s.probePipes(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.woken.length = 0;
  const paused = await s.call("GET", `/v1/threads/${s.thread.id}/changes`);
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.woken.includes(node));
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.streams.length = 0;
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}/files`)).status, 409);
  assert.deepEqual(s.streams, []);
});

test("closing a session goes through the node's probe, which treats a pane already gone as closed", async (t) => {
  const s = await withThread(t);
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {}), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "close-session", herdrPane: "w1:p1" }]]);
});

test("a session of a pylon that is not running, or of an archived or deleted thread, is refused with 409", async (t) => {
  const s = await withThread(t);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.woken.length = 0;
  const paused = await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, { harness: "claude-code" });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.woken.includes(node), "the request wakes the pylon");
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/w1:p1`, {})).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.commands.length = 0;
  const archived = await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, {});
  assert.equal(archived.status, 409);
  assert.match(archived.body.error, /is archived, so its pylon stays paused/);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/w1:p1`, {})).status, 409);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, {})).status, 409);
  assert.deepEqual(s.commands, [], "an archived or deleted thread's probe is never asked");
});

test("a failed pylon shows failed with its reason until its thread is deleted, and then shows the delete", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const detail = async () => (await s.call("GET", `/v1/threads/${thread.id}`)).body as ThreadDetail;
  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const reason = "last job failed with setup-failed, which is not retryable: pylon-x: Setup exited 128\nfatal: unable to access";
  s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed: reason });
  assert.deepEqual((await detail()).pylon, { id: thread.pylonId, node, actualState: "failed", failed: reason, observedAt: null, retryRefused: null });
  const [row] = (await s.call("GET", "/v1/threads")).body as ThreadRow[];
  assert.deepEqual([row!.desired, row!.pylon], [(await detail()).desired, { node, actualState: "failed", failed: reason }], "the list reports the pylon as its detail does");

  await s.call("DELETE", `/v1/threads/${thread.id}`);
  const del = { jobId: "job-del" as JobId, subject: thread.pylonId, kind: "delete" as const };
  s.registry.apply({ record: "job", status: { ...del, state: "running", startedAt: "2027-01-01T00:00:00Z" } });
  assert.equal((await detail()).pylon.actualState, "deleting");
  s.registry.apply({ record: "job", status: { ...del, state: "succeeded", finishedAt: "2027-01-01T00:00:05Z" } });
  s.registry.ingested({ node, observedAt: "2027-01-01T00:00:06Z", probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [], previewRoutes: [] }, []);
  assert.deepEqual((await detail()).pylon, { id: thread.pylonId, node, actualState: "absent", failed: reason, observedAt: "2027-01-01T00:00:06Z", retryRefused: null });
});

test("retrying a failed pylon clears the planner's verdict and its attempts, marks the retry, counts as human activity and wakes its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const retry = (headers: Record<string, string> = {}) => s.call("POST", `/v1/threads/${thread.id}/pylon/retry`, undefined, headers);
  assert.equal((await retry()).status, 409, "a pylon that has not failed has nothing to retry");

  const failed = {
    ...s.registry.pylon(thread.pylonId)!,
    attempts: { count: 1, last: { at: 1, code: "setup-failed" as const, message: "fatal: could not read from remote repository" } },
    failed: "last job failed with setup-failed, which is not retryable: fatal: could not read from remote repository",
  };
  s.registry.savePylon(failed);
  assert.equal((await retry({ "content-type": "text/plain" })).status, 415);
  assert.equal((await retry({ host: "evil.example" })).status, 403);
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await retry()).status, 403);
  s.callAs(laptop);
  assert.deepEqual(s.registry.pylon(thread.pylonId), failed, "a refused retry leaves the pylon failed");

  s.woken.length = 0;
  const before = Date.now();
  assert.equal((await retry()).status, 204, "a human may retry a failure the planner would not");
  assert.deepEqual(s.registry.pylon(thread.pylonId), { ...failed, attempts: { count: 0, last: null }, failed: null, retrying: true });
  assert.ok(s.registry.thread(thread.id)!.lastHumanActivityAt >= before, "the pylon is wanted at once");
  assert.deepEqual(s.woken, [node]);
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.pylon.failed, null);
  assert.equal((await retry()).status, 409, "a second retry finds nothing to clear");
});

test("a pylon whose disk holds a failed setup cannot be retried, and its detail says why", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const broken = (cause: "setup" | "saved-setup" | "services") => s.registry.ingested({
    node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", capacity, artifacts: [], jobs: [],
    pylons: [{ pylonId: thread.pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs", cause }], previewRoutes: [],
  }, []);
  broken("saved-setup");
  s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed: "pylon is broken: Setup exited 128. Read controller logs" });
  const refusal = "Its disk holds the failed setup, and every boot of that disk fails the same way, so a retry cannot help. Start again from the project";
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.pylon.retryRefused, refusal);
  const res = await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`);
  assert.deepEqual(res, { status: 409, body: { error: `pylon ${thread.pylonId} cannot be retried. ${refusal}` } });
  assert.notEqual(s.registry.pylon(thread.pylonId)!.failed, null, "a refused retry leaves the verdict");

  broken("services");
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.pylon.retryRefused, null);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`)).status, 204, "a service that failed may start on the next boot");

  broken("setup");
  s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed: "pylon is broken: Setup exited 128. Read controller logs" });
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.pylon.retryRefused, null);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`)).status, 204, "the pause removes a VM whose setup failed on this boot, so setup runs again");
});

test("an archived thread's failed pylon can be retried and stays archived, and a deleted thread's cannot", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const fail = () => s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed: "gave up after 5 failed attempts" });
  await s.call("POST", `/v1/threads/${thread.id}/archive`);
  fail();
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`)).status, 204);
  assert.equal(s.registry.pylon(thread.pylonId)!.failed, null);
  assert.equal(s.registry.thread(thread.id)!.status, "archived", "a retry settles the pylon rather than unarchiving it");

  fail();
  await s.call("DELETE", `/v1/threads/${thread.id}`);
  const res = await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /is deleted/);
  assert.equal((await s.call("POST", "/v1/threads/th-missing/pylon/retry")).status, 404);
});

test("archive, delete, and activity update the thread and wake its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  s.woken.length = 0;
  const before = Date.now();

  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/activity`, { kind: "human" })).status, 204);
  assert.ok(s.registry.thread(thread.id)!.lastHumanActivityAt >= before);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/activity`, { kind: "agent", turnRunning: true })).status, 400, "agent activity comes from the harness");

  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).body.status, "archived");
  assert.equal(s.registry.thread(thread.id)!.status, "archived");
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).body.status, "deleted");
  assert.equal(s.registry.thread(thread.id)!.status, "deleted");
  assert.deepEqual(s.calls.at(-1), ["delete", { threadId: thread.id, pylonId: thread.pylonId }]);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).status, 409);
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.agent, null);
  assert.deepEqual(s.woken, [node, node, node]);
});

test("a message goes to the thread's conversation and counts as human activity", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  s.woken.length = 0;
  s.calls.length = 0;
  const before = Date.now();

  const sent = await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "run the tests", requestId: "msg:1" });
  assert.deepEqual(sent, { status: 202, body: { submission: 7 } });
  assert.ok(s.registry.thread(thread.id)!.lastHumanActivityAt >= before);
  assert.deepEqual(s.woken, [node]);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "now", requestId: "msg:2", mode: "steer" })).status, 202);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "", requestId: "msg:3" })).status, 400);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "x" })).status, 400);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/abort`)).status, 204);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/retry`)).status, 204);
  const view = await s.call("GET", `/v1/threads/${thread.id}/conversation`);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.entries.map((e: any) => e.model[0].content), ["run the tests", "now"]);
  assert.deepEqual(s.calls, [
    ["send", thread.id, "run the tests", "msg:1", "followUp"],
    ["send", thread.id, "now", "msg:2", "steer"],
    ["abort", thread.id],
    ["retry", thread.id],
    ["watch", thread.id],
    ["unwatch", thread.id],
  ]);
});

/** Polls until `done` holds, for up to 5 s. */
async function until(done: () => boolean, what: string) {
  for (let i = 0; !done(); i++) {
    assert.ok(i < 100, what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a thread's event stream sends the whole view, then each part a commit changed, and stops its watch when the client leaves", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  const transcript = fake.transcript(thread.id);
  transcript.docs["pi.inbox"] = { items: [] };
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  const res = await stream.response;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.deepEqual(await stream.next(), { entries: [], docs: { "pi.inbox": { items: [] } } }, "the first event is the whole view");

  transcript.docs["pi.live"] = { run: { taskId: 1, inputs: [] }, generation: { message: { role: "assistant", content: [{ type: "text", text: "Hal" }] } } };
  fake.commit(thread.id);
  assert.deepEqual(await stream.next(), { docs: { "pi.live": transcript.docs["pi.live"] } }, "a commit to the live document sends only it, whole");
  transcript.docs["pi.live"] = { run: { taskId: 1, inputs: [] }, generation: { message: { role: "assistant", content: [{ type: "text", text: "Half" }] } } };
  fake.commit(thread.id);
  assert.equal((await stream.next()).docs["pi.live"].generation.message.content[0].text, "Half", "the partial is a snapshot, not a delta");

  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "and then?", requestId: "msg:1" })).status, 202);
  const appended = await stream.next();
  assert.deepEqual(Object.keys(appended), ["entries"]);
  assert.deepEqual(appended.entries.map((e: any) => e.model[0].content), ["and then?"]);
  delete transcript.docs["pi.live"];
  fake.commit(thread.id);
  assert.deepEqual(await stream.next(), { docs: { "pi.live": null } }, "a document that is gone is null");

  assert.equal(fake.watching(thread.id), 1);
  stream.close();
  await until(() => fake.watching(thread.id) === 0, "the stream's watch stopped when its client left");
  assert.deepEqual(s.calls.filter(([call]) => call === "watch" || call === "unwatch"), [["watch", thread.id], ["unwatch", thread.id]]);
});

test("a client that reads slowly gets the latest view in fewer events, and never holds the harness up", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  const transcript = fake.transcript(thread.id);
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await stream.next();
  stream.pause();
  const commits = 40;
  // Each commit a megabyte, so the paused client's socket fills after a few.
  for (let i = 1; i <= commits; i++) {
    transcript.docs["pi.live"] = { seq: i, output: "x".repeat(1 << 20) };
    fake.commit(thread.id);
    await new Promise((resolve) => setImmediate(resolve));
  }
  stream.resume();
  const seen: number[] = [];
  while (seen.at(-1) !== commits) seen.push((await stream.next()).docs["pi.live"].seq);
  assert.ok(seen.length < commits, `the backed-up events were merged: ${seen.length} events for ${commits} commits`);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "events stay in commit order");
  stream.close();
});

test("a thread's streams end when it is deleted, and a deleted thread, a stranger or one stream too many is refused", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.events(`/v1/threads/${thread.id}/events`).response).statusCode, 403);
  s.callAs(laptop);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/events`)).status, 405);

  const open = Array.from({ length: maxStreams }, () => s.events(`/v1/threads/${thread.id}/events`));
  for (const stream of open) await stream.next();
  const extra = await s.events(`/v1/threads/${thread.id}/events`).response;
  assert.equal(extra.statusCode, 503, "past the most streams the control plane serves");
  open.pop()!.close();
  await until(() => fake.watching(thread.id) === maxStreams - 1, "a closed stream frees its place");
  const page = s.events(`/threads/${thread.id}/stream`);
  assert.ok((await page.next()).convo !== undefined, "the dashboard's stream counts against the same limit");
  open.push(page);

  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  await Promise.all(open.map((stream) => stream.ended));
  await until(() => fake.watching(thread.id) === 0, "every stream of the deleted thread stopped its watch");
  assert.equal((await s.events(`/v1/threads/${thread.id}/events`).response).statusCode, 409);
  assert.equal((await s.events("/v1/threads/th-missing/events").response).statusCode, 404);
});

/** Backs up a paused client's socket with ten commits of a megabyte each. */
async function backUp(s: Awaited<ReturnType<typeof withThread>>) {
  const transcript = s.fake.transcript(s.thread.id);
  for (let i = 0; i < 10; i++) {
    transcript.docs["pi.live"] = { seq: i, output: "x".repeat(1 << 20) };
    s.fake.commit(s.thread.id);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a client that stops reading is dropped after the stall limit, with its watch and its place", async (t) => {
  const s = await withThread(t, { streamStallMs: 300 });
  const { thread, fake } = s;
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await stream.next();
  stream.pause();
  await backUp(s);
  assert.equal(fake.watching(thread.id), 1, "a slow client is not dropped at once");
  await until(() => fake.watching(thread.id) === 0, "the dropped stream stopped its watch");
  stream.resume();
  assert.equal(await stream.ended, "dropped");
  const again = s.events(`/v1/threads/${thread.id}/events`);
  assert.ok((await again.next()).entries !== undefined, "a client that still listens connects again and gets the whole view");
  again.close();
});

test("deleting a thread whose client stopped reading frees the stream at once, writes nothing after the end, and drops the client", async (t) => {
  const s = await withThread(t, { streamStallMs: 300 });
  const { thread, fake } = s;
  const transcript = fake.transcript(thread.id);
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await stream.next();
  stream.pause();
  await backUp(s);
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  transcript.docs["pi.live"] = { seq: 10 };
  fake.commit(thread.id);
  assert.equal(fake.watching(thread.id), 0, "the delete stopped the watch at once, though the client has not read the end yet");
  await new Promise((resolve) => setTimeout(resolve, 600));
  stream.resume();
  assert.equal(await stream.ended, "dropped", "a client that never read up to the end was dropped after the stall limit");
  assert.equal((await s.call("GET", "/v1/projects")).status, 200, "the control plane is still up");
});

test("a stream whose thread is deleted while its watch opens stops that watch", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  const release = fake.holdWatches();
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await until(() => s.calls.some(([call]) => call === "watch"), "the stream asked for its watch");
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  release();
  await stream.ended;
  await until(() => fake.watching(thread.id) === 0, "the watch that opened after the delete was stopped");
  assert.deepEqual(s.calls.filter(([call]) => call === "watch" || call === "unwatch"), [["watch", thread.id], ["unwatch", thread.id]]);
});

test("unarchiving makes an archived thread active, counts as human activity and wakes its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/unarchive`)).status, 409, "an active thread is not archived");
  await s.call("POST", `/v1/threads/${thread.id}/archive`);
  s.woken.length = 0;
  const before = Date.now();
  const res = await s.call("POST", `/v1/threads/${thread.id}/unarchive`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "active");
  assert.ok(res.body.lastHumanActivityAt >= before);
  assert.deepEqual(s.woken, [node]);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "x", requestId: "msg:1" })).status, 202);
});

test("an archived thread takes no messages, and a deleted one has no conversation", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  await s.call("POST", `/v1/threads/${thread.id}/archive`);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "x", requestId: "msg:1" })).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/retry`)).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/abort`)).status, 204);
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}/conversation`)).status, 200);
  await s.call("DELETE", `/v1/threads/${thread.id}`);
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}/conversation`)).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/abort`)).status, 409);
});

test("unknown threads, routes and methods get 404 and 405", async (t) => {
  const s = await setup(t);
  assert.equal((await s.call("GET", "/v1/threads/th-missing")).status, 404);
  assert.equal((await s.call("GET", "/v1/nothing")).status, 404);
  assert.equal((await s.call("PATCH", "/v1/projects")).status, 405);
  assert.equal((await s.call("POST", "/v1/projects", undefined)).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", "{not json")).status, 400);
});
