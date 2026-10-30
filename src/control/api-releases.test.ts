/** Release, deployer and drain routes, and the usage backfill's. */
import { reportSchema } from "./releases.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turnGate } from "./drain.ts";
import type { Thread } from "./registry.ts";
import { usageBackfill } from "./usage-backfill.ts";
import type { ImageId } from "../images.ts";
import { releaseOutcome, reportStates, type ReleaseReport } from "../deploy/model.ts";
import type { TailnetNodeId } from "../ids.ts";
import { node, laptop, project, image, testApi, withThread, deployCommit, deployment, reporterHeaders } from "./api-test-kit.ts";

test("deploy defaults off, main resolves, and release records the authenticated caller", async (t) => {
  const off = await testApi(t);
  assert.equal((await off.call("PUT", "/v1/release", { commit: "main" })).status, 403);
  const on = await testApi(t, { deployment });
  const r = await on.call("PUT", "/v1/release", { commit: "main" });
  assert.equal(r.status, 200);
  assert.equal(r.body.desired.commit, deployCommit);
  assert.equal(r.body.desired.requestedBy, laptop);
  assert.equal(r.body.nodes.length, 2);
  assert.equal((await on.call("PUT", "/v1/release", { commit: "--evil" })).status, 400);
});

test("the release view shows a deployer report 90 s old as pending, so a wait on that release is pending", async (t) => {
  const s = await testApi(t, { deployment });
  assert.equal((await s.call("PUT", "/v1/release", { commit: "main" })).status, 200);
  s.callAs("nFIREBAT" as TailnetNodeId);
  for (const role of ["control", "probe"]) {
    const report = { role, commit: deployCommit, target: deployCommit, state: "healthy", reason: null };
    assert.equal((await s.call("POST", "/v1/deployer/report", report, reporterHeaders)).status, 200);
  }
  s.callAs(laptop);
  assert.equal(releaseOutcome((await s.call("GET", "/v1/release")).body, deployCommit), "healthy");
  for (const report of s.registry.releaseReports()) s.registry.reportRelease({ ...report, observedAt: Date.now() - 90_000 });
  const view = (await s.call("GET", "/v1/release")).body;
  assert.deepEqual(view.nodes.map((r: ReleaseReport) => [r.role, r.state, r.reason]), [["control", "pending", "deployer report is stale"], ["probe", "pending", "deployer report is stale"]]);
  assert.equal(releaseOutcome(view, deployCommit), "pending");
});

test("a deployer report may carry every report state", () => {
  for (const state of reportStates) assert.equal(reportSchema.parse({ role: "probe", commit: deployCommit, target: null, state, reason: null }).state, state);
});

test("anyone allowed reads the usage backfill and its dry run, only a deployer starts or stops it, and without one its routes answer 409", async (t) => {
  const off = await testApi(t, { deployment });
  for (const method of ["GET", "POST", "DELETE"]) assert.deepEqual(await off.call(method, "/v1/usage/backfill"), { status: 409, body: { error: "the usage backfill is not configured" } });
  const s = await testApi(t, {
    deployment,
    usageBackfill: (registry) => usageBackfill({ registry, counter: { readWhole: () => assert.fail("nothing is read") }, wake: () => {}, intervalMs: 3_600_000, log: () => {} }),
  });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const thread = (await s.call("POST", "/v1/threads", { project: "acme", title: "Old work" })).body as Thread;
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).status, 200);
  assert.deepEqual(await s.call("GET", "/v1/usage/backfill"), {
    status: 200, body: { backfill: { state: "never" }, plan: [{ thread: thread.id, project: "acme", node, title: "Old work", reason: null }] },
  });

  s.callAs("nFIREBAT" as TailnetNodeId);
  const refused = { status: 403, body: { error: "caller may not start or stop the usage backfill: only deployers may, never infrastructure nodes or pylons" } };
  assert.deepEqual(await s.call("POST", "/v1/usage/backfill"), refused);
  assert.deepEqual(await s.call("DELETE", "/v1/usage/backfill"), refused);
  assert.deepEqual((await s.call("GET", "/v1/usage/backfill")).body.backfill, { state: "never" });
  s.callAs(laptop);
  const started = await s.call("POST", "/v1/usage/backfill");
  assert.equal(started.status, 200);
  assert.deepEqual([started.body.state, started.body.read, started.body.of, started.body.current], ["running", 0, 1, null]);
  assert.equal((await s.call("GET", "/v1/usage?since=all")).body.backfill.state, "running", "the usage report carries the backfill");
  const stopped = await s.call("DELETE", "/v1/usage/backfill");
  assert.deepEqual([stopped.status, stopped.body.state], [200, "stopped"]);
});

test("a root-authenticated drain blocks every turn-entry route and can be released", async (t) => {
  const s = await testApi(t, { deployment });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  const drain = await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders);
  assert.equal(drain.status, 200);
  assert.equal(drain.body.idle, true);
  s.callAs(laptop);
  for (const path of ["/v1/threads", "/v1/threads/anything/messages", "/v1/threads/anything/retry", "/v1/threads/anything/start"]) {
    const refused = await s.call("POST", path, {});
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { error: "control plane is draining for deployment; retry after the release completes" });
  }
  assert.equal((await s.call("PUT", "/v1/release", { commit: "b".repeat(40) })).status, 409);
  s.callAs("nFIREBAT" as TailnetNodeId);
  const released = await s.call("POST", "/v1/deployer/drain", { commit: deployCommit, release: true }, reporterHeaders);
  assert.deepEqual(released.body, { idle: false, expiresAt: null });
  assert.equal(s.registry.drain(), null);
});

test("drain reads committed live and queued work rather than a lagging activity flag", async (t) => {
  const s = await withThread(t, { deployment });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  for (const docs of [{ "pi.live": { run: {} } }, { "pi.inbox": { items: [{ id: 1 }] } }]) {
    s.fake.transcript(s.thread.id).docs = docs as never;
    s.fake.commit(s.thread.id);
    const result = await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders);
    assert.equal(result.body.idle, false);
  }
  s.fake.transcript(s.thread.id).docs = {};
  s.fake.commit(s.thread.id);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
});

test("drain reads only harness conversations, so Claude worker and bare threads never reach the harness", async (t) => {
  const s = await withThread(t, { deployment });
  await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix it" });
  await s.startThread({ project: "acme", title: "Check", bare: true }, laptop);
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  s.calls.length = 0;
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
  assert.deepEqual(s.calls, [["watch", s.thread.id], ["unwatch", s.thread.id]]);
});

test("drain waits for a turn entering through the gate it was given, which the API shares with the harness", async (t) => {
  const gate = turnGate(() => false);
  const s = await testApi(t, { deployment, gate });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  let end = () => {};
  const held = gate.run(() => new Promise<void>((resolve) => { end = resolve; }));
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, false);
  end();
  await held;
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
});

test("expired drain leases no longer block callers", async (t) => {
  const s = await withThread(t, { deployment });
  s.registry.setDrain({ commit: deployCommit, expiresAt: Date.now() - 1 });
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "hello", requestId: "after-drain" })).status, 202);
});

test("drain cannot declare idle while a previously admitted message is still entering the harness", async (t) => {
  const s = await withThread(t, { deployment });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  const entering = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const send = s.fake.harness.send;
  s.fake.harness.send = async (...args) => { entering.resolve(); await finish.promise; return send(...args); };
  const sending = s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "hello", requestId: "entering-drain" });
  await entering.promise;
  s.callAs("nFIREBAT" as TailnetNodeId);
  try {
    assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, false);
  } finally { finish.resolve(); }
  assert.equal((await sending).status, 202);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
});

test("the final idle fence holds across lease expiry until rollback or success releases it", async (t) => {
  const s = await testApi(t, { deployment });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit, hold: true }, reporterHeaders)).body.idle, true);
  assert.equal(s.registry.drain()!.locked, true);
  s.registry.setDrain({ ...s.registry.drain()!, expiresAt: 0 });
  s.callAs(laptop);
  assert.equal((await s.call("POST", "/v1/threads", {})).status, 409);
  s.callAs("nFIREBAT" as TailnetNodeId);
  await s.call("POST", "/v1/deployer/drain", { commit: deployCommit, release: true }, reporterHeaders);
  assert.equal(s.registry.drain(), null);
});
