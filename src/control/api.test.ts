import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { startApi, type ThreadDetail, type ThreadRow } from "./api.ts";
import { fakeHarness } from "./fake-harness.ts";
import { openRegistry, type Thread } from "./registry.ts";
import { liveHashOf } from "../project.ts";
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

async function setup(t: import("node:test").TestContext, options: { dotfiles?: typeof dotfiles } = {}) {
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  let caller: TailnetNodeId | null = laptop;
  const woken: NodeName[] = [];
  const { harness, calls } = fakeHarness();
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0,
    // Every loopback caller is whoever the test says. Tests never ask tailscaled.
    whois: async () => caller,
    allowed: new Set([laptop]),
    hostnames: new Set(["127.0.0.1"]),
    dotfiles: options.dotfiles ?? dotfiles,
    harness,
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
  return { registry, call, woken, calls, callAs(id: TailnetNodeId | null) { caller = id; } };
}

async function withThread(t: import("node:test").TestContext, options: { project?: typeof project; dotfiles?: typeof dotfiles } = {}) {
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
    sessions: [], previews: [], outputs: [], attach: "herdr --session nexus", agent: { parkedTasks: 0 },
  });

  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const pylon = s.registry.pylon(thread.pylonId)!;
  const running = {
    pylonId: thread.pylonId, phase: "running" as const, liveHash: pylon.liveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  s.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [running], previewRoutes: [] }, []);
  const pause = { jobId: "job-1" as JobId, subject: thread.pylonId, kind: "pause" as const };
  s.registry.apply({ record: "job", status: { ...pause, state: "running", startedAt: "2027-01-01T00:00:59Z" } });
  s.registry.apply({ record: "session", pylonId: thread.pylonId, herdrPane: "p1", fact: { herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "idle" } });
  s.registry.apply({ record: "output", pylonId: thread.pylonId, kind: "branch", ref: "nexus/fix" });
  s.registry.allocatePreviews(thread.pylonId, ["web"], { first: 8443, last: 8443 });
  s.registry.apply({ record: "preview", pylonId: thread.pylonId, service: "web", httpsPort: 8443, ready: true });

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
