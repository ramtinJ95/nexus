import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { liveHashOf, startApi, type ThreadDetail } from "./api.ts";
import { openRegistry, type Thread } from "./registry.ts";
import type { JobId, NodeName, TailnetNodeId } from "../protocol.ts";

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
    debianDigest: "d", node: "24.22.1", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s",
    gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f",
  },
};

const dotfiles = { repo: "git@github.com:ramtin/dotfiles.git", ref: "main" };

const dir = await mkdtemp(join(tmpdir(), "nexus-api-"));
after(() => rm(dir, { recursive: true }));

async function setup(t: import("node:test").TestContext) {
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  let caller: TailnetNodeId | null = laptop;
  const woken: NodeName[] = [];
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0,
    // Every loopback caller is whoever the test says. Tests never ask tailscaled.
    whois: async () => caller,
    allowed: new Set([laptop]),
    hostnames: new Set(["127.0.0.1"]),
    dotfiles,
    wake: (n) => { woken.push(n); },
  });
  t.after(async () => {
    await api.close();
    registry.close();
  });
  /** Sends JSON as the dashboard and CLI do. `headers` overrides any header, so tests can pose as a browser page. */
  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port: api.port, method, path,
        headers: { host: `127.0.0.1:${api.port}`, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...headers },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: text === "" ? null : JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
    });
  }
  return { registry, call, woken, callAs(id: TailnetNodeId | null) { caller = id; } };
}

async function withThread(t: import("node:test").TestContext) {
  const s = await setup(t);
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
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

test("starting a thread creates its pylon, boots fresh from the current image, and wakes its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  assert.equal(thread.status, "active");
  assert.equal(thread.startedBy, laptop);
  assert.equal(thread.pylonId, `pylon-${thread.id}`);
  assert.ok(thread.pylonId.length <= 40);
  assert.deepEqual(s.woken, [node]);
  assert.deepEqual((await s.call("GET", "/v1/threads")).body, [thread]);
  assert.deepEqual((await s.call("GET", "/v1/threads?project=acme")).body, [thread]);
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
  assert.equal(pylon.liveHash, liveHashOf({ previews: [], overlay: [] }));
  assert.equal(pylon.submitted, null);
});

test("thread detail derives the actual state from the node's last observation", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const detail = async () => (await s.call("GET", `/v1/threads/${thread.id}`)).body as ThreadDetail;

  assert.deepEqual(await detail(), {
    thread,
    pylon: { id: thread.pylonId, node, actualState: "unknown", failed: null, observedAt: null },
    sessions: [], previews: [], outputs: [],
  });

  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const pylon = s.registry.pylon(thread.pylonId)!;
  const running = {
    pylonId: thread.pylonId, phase: "running" as const, liveHash: pylon.liveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  s.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [running] }, []);
  const pause = { jobId: "job-1" as JobId, subject: thread.pylonId, kind: "pause" as const };
  s.registry.apply({ record: "job", status: { ...pause, state: "running", startedAt: "2027-01-01T00:00:59Z" } });
  s.registry.apply({ record: "session", pylonId: thread.pylonId, herdrPane: "p1", fact: { herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "idle" } });
  s.registry.apply({ record: "output", pylonId: thread.pylonId, kind: "branch", ref: "nexus/fix" });
  s.registry.savePreview({ pylon: thread.pylonId, service: "web", httpsPort: 8443, ready: true });

  const d = await detail();
  assert.equal(d.pylon.actualState, "pausing");
  assert.equal(d.pylon.observedAt, "2027-01-01T00:01:00Z");
  assert.deepEqual(d.sessions, [{ pylon: thread.pylonId, herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "idle" }]);
  assert.deepEqual(d.outputs, [{ thread: thread.id, kind: "branch", ref: "nexus/fix" }]);
  assert.deepEqual(d.previews, [{ pylon: thread.pylonId, service: "web", httpsPort: 8443, ready: true }]);

  s.registry.apply({ record: "job", status: { ...pause, state: "succeeded", finishedAt: "2027-01-01T00:01:30Z" } });
  assert.equal((await detail()).pylon.actualState, "running");
  s.registry.markOffline(node);
  assert.equal((await detail()).pylon.actualState, "unknown");
});

test("archive, delete, and activity update the thread and wake its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  s.woken.length = 0;
  const before = Date.now();

  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/activity`, { kind: "human" })).status, 204);
  assert.ok(s.registry.thread(thread.id)!.lastHumanActivityAt >= before);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/activity`, { kind: "agent", turnRunning: true })).status, 204);
  const facts = s.registry.thread(thread.id)!;
  assert.equal(facts.agentTurnRunning, true);
  assert.ok(facts.lastAgentActivityAt >= before);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/activity`, { kind: "agent" })).status, 400);

  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).body.status, "archived");
  assert.equal(s.registry.thread(thread.id)!.status, "archived");
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).body.status, "deleted");
  assert.equal(s.registry.thread(thread.id)!.status, "deleted");
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).status, 409);
  assert.deepEqual(s.woken, [node, node, node, node]);
});

test("unknown threads, routes and methods get 404 and 405", async (t) => {
  const s = await setup(t);
  assert.equal((await s.call("GET", "/v1/threads/th-missing")).status, 404);
  assert.equal((await s.call("GET", "/v1/nothing")).status, 404);
  assert.equal((await s.call("PATCH", "/v1/projects")).status, 405);
  assert.equal((await s.call("POST", "/v1/projects", undefined)).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", "{not json")).status, 400);
});
