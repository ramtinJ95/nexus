/** Thread routes: starts, detail, the list, archive, delete, retry, messages, attention and starts under a request ID. */
import { attentionOf } from "./attention.ts";
import { checkoutReader } from "../checkout-files.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadDetail, ThreadRow } from "./wire.ts";
import type { Judgment } from "./judgment-store.ts";
import type { Thread } from "./thread-store.ts";
import { liveHashOf } from "../spawn.ts";
import { processStream } from "../process-stream.ts";
import { runningPylon, testCapacity, testObservation } from "../test-kit.ts";
import type { JobId, NodeName, TailnetNodeId } from "../ids.ts";
import { node, laptop, project, image, dotfiles, withThread, withImage, localCheckout } from "./api-test-kit.ts";

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
  const row = { ...thread, attention: null, desired: "running", pylon: { node, actualState: "unknown", failed: null } };
  assert.deepEqual((await s.call("GET", "/v1/threads")).body, [row]);
  assert.deepEqual((await s.call("GET", "/v1/threads?project=acme")).body, [row]);
  assert.deepEqual((await s.call("GET", "/v1/threads?project=other")).body, []);

  const pylon = s.registry.pylon(thread.pylonId)!;
  assert.equal(pylon.node, node);
  assert.deepEqual(pylon.firstBoot, { kind: "fresh", preSetup: null });
  assert.deepEqual(pylon.boot, {
    pylonId: thread.pylonId, image: image.id, resources: project.resources,
    network: { allowedHosts: ["api.openai.com", "api.stripe.com", "auth.openai.com", "chatgpt.com", "registry.npmjs.org"], secrets: [...project.secrets, { name: "NEXUS_CHATGPT_TOKEN", hosts: ["api.openai.com"] }] },
    repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "origin/main" } },
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

test("thread detail derives the actual state from the node's last observation", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const detail = async () => (await s.call("GET", `/v1/threads/${thread.id}`)).body as ThreadDetail;

  assert.deepEqual(await detail(), {
    thread,
    attention: null, seenAt: null, lastReplyAt: null,
    desired: "running",
    pylon: { grantsOutdated: false, id: thread.pylonId, node, actualState: "unknown", failed: null, observedAt: null, retryRefused: null, resources: project.resources },
    sessions: [], previews: [], ports: [], outputs: [], prWatch: { enabled: false, stopped: false, error: null }, pullRequests: [], review: null, questions: [], judgments: [], planning: false, attach: "herdr --session nexus", agent: { parkedTasks: 0 },
  });

  s.registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  const pylon = s.registry.pylon(thread.pylonId)!;
  const running = runningPylon(thread.pylonId, { liveHash: pylon.liveHash, bootedFrom: { image: image.id, checkpoint: null } });
  s.registry.ingested(testObservation(node, { observedAt: "2027-01-01T00:01:00Z", pylons: [running] }), []);
  const pause = { jobId: "job-1" as JobId, subject: thread.pylonId, kind: "pause" as const };
  s.registry.apply({ record: "job", status: { ...pause, state: "running", startedAt: "2027-01-01T00:00:59Z" } });
  s.registry.apply({ record: "sessions", pylonId: thread.pylonId, sessions: [{ id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "idle", title: "plan", message: null }] });
  s.registry.apply({ record: "output", pylonId: thread.pylonId, kind: "branch", ref: "nexus/fix" });
  s.registry.allocatePreviews(thread.pylonId, ["web"], { first: 8443, last: 8443 });
  s.registry.apply({ record: "preview", pylonId: thread.pylonId, service: "web", httpsPort: 8443, ready: true });

  const d = await detail();
  assert.equal(d.pylon.actualState, "pausing");
  assert.equal(d.pylon.observedAt, "2027-01-01T00:01:00Z");
  assert.deepEqual(d.sessions, [{ pylon: thread.pylonId, id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "idle", title: "plan", message: null }]);
  assert.deepEqual(d.outputs, [{ thread: thread.id, kind: "branch", ref: "nexus/fix" }]);
  assert.deepEqual(d.previews, [{ pylon: thread.pylonId, service: "web", httpsPort: 8443, ready: true, failed: null, url: "https://rj-firebat.tail.ts.net:8443/" }]);

  s.registry.apply({ record: "job", status: { ...pause, state: "succeeded", finishedAt: "2027-01-01T00:01:30Z" } });
  assert.equal((await detail()).pylon.actualState, "running");
  s.registry.markOffline(node);
  assert.equal((await detail()).pylon.actualState, "unknown");
});

test("a failed pylon shows failed with its reason until its thread is deleted, and then shows the delete", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const detail = async () => (await s.call("GET", `/v1/threads/${thread.id}`)).body as ThreadDetail;
  s.registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  const reason = "last job failed with setup-failed, which is not retryable: pylon-x: Setup exited 128\nfatal: unable to access";
  s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed: reason });
  assert.deepEqual((await detail()).pylon, { grantsOutdated: false, id: thread.pylonId, node, actualState: "failed", failed: reason, observedAt: null, retryRefused: null, resources: project.resources });
  const [row] = (await s.call("GET", "/v1/threads")).body as ThreadRow[];
  assert.deepEqual([row!.desired, row!.pylon], [(await detail()).desired, { node, actualState: "failed", failed: reason }], "the list reports the pylon as its detail does");

  await s.call("DELETE", `/v1/threads/${thread.id}`);
  const del = { jobId: "job-del" as JobId, subject: thread.pylonId, kind: "delete" as const };
  s.registry.apply({ record: "job", status: { ...del, state: "running", startedAt: "2027-01-01T00:00:00Z" } });
  assert.equal((await detail()).pylon.actualState, "deleting");
  s.registry.apply({ record: "job", status: { ...del, state: "succeeded", finishedAt: "2027-01-01T00:00:05Z" } });
  s.registry.ingested(testObservation(node, { observedAt: "2027-01-01T00:00:06Z" }), []);
  assert.deepEqual((await detail()).pylon, { grantsOutdated: false, id: thread.pylonId, node, actualState: "absent", failed: reason, observedAt: "2027-01-01T00:00:06Z", retryRefused: null, resources: project.resources });
});

test("the thread list leaves deleted threads out when asked, as the dashboard asks and `threads --all` does not", async (t) => {
  // The list orders by creation time, then ID, so the second thread starts a millisecond later.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await withThread(t);
  t.mock.timers.tick(1);
  const gone = (await s.call("POST", "/v1/threads", { project: "acme", title: "Old spike" })).body as Thread;
  assert.equal((await s.call("DELETE", `/v1/threads/${gone.id}`)).status, 200);
  const ids = async (path: string) => ((await s.call("GET", path)).body as ThreadRow[]).map((r) => r.id);
  assert.deepEqual(await ids("/v1/threads"), [s.thread.id, gone.id]);
  assert.deepEqual(await ids("/v1/threads?deleted=false"), [s.thread.id]);
  assert.deepEqual(await ids("/v1/threads?project=acme&deleted=false"), [s.thread.id]);
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
  s.registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  const broken = (cause: "setup" | "saved-setup" | "services") => s.registry.ingested(testObservation(node, {
    observedAt: "2027-01-01T00:01:00Z", pylons: [{ pylonId: thread.pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs", cause, logTail: "" }],
  }), []);
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

test("attention ranks failure, unwatched parked tasks, unread reply, then work; seen never wakes", async (t) => {
  const s = await withThread(t);
  const id = s.thread.id;
  const base = `/v1/threads/${id}`;
  const attention = async () => {
    const row = ((await s.call("GET", "/v1/threads")).body as ThreadRow[])[0]!;
    const detail = (await s.call("GET", base)).body as ThreadDetail;
    assert.equal(row.attention, detail.attention);
    assert.equal(row.lastReplyAt, detail.lastReplyAt);
    assert.equal(row.seenAt, detail.seenAt);
    return row.attention;
  };
  assert.equal(await attention(), null);
  s.registry.recordActivity(id, { agentTurnRunning: true });
  assert.equal(await attention(), "working");
  s.registry.recordReply(id, 1000);
  assert.equal(await attention(), "reply");
  s.fake.park(id, 2);
  assert.equal(await attention(), "parked");
  assert.ok(!s.calls.some(([kind]) => kind === "watch"), "parked is known without a client watch");
  const pylon = s.registry.pylon(s.thread.pylonId)!;
  s.registry.savePylon({ ...pylon, failed: "gave up" });
  assert.equal(await attention(), "failed");
  s.registry.savePylon(pylon);
  s.fake.park(id, 0);
  s.registry.recordActivity(id, { agentTurnRunning: false });
  s.woken.length = 0;
  const human = s.registry.thread(id)!.lastHumanActivityAt;
  for (const status of ["active", "archived"] as const) {
    s.registry.setThreadStatus(id, status);
    assert.equal((await s.call("POST", `${base}/seen`)).status, 204);
    assert.equal(await attention(), null);
    assert.equal((await s.call("POST", `${base}/unseen`)).status, 204);
    assert.equal(s.registry.thread(id)!.seenAt, 999);
    assert.equal(await attention(), "reply");
    assert.equal(s.registry.thread(id)!.lastHumanActivityAt, human);
    assert.deepEqual(s.registry.pylon(s.thread.pylonId), pylon);
    assert.deepEqual(s.woken, []);
  }
});


test("the API reports the attention the event stream last reported, and a deleted thread's run is not parked", async (t) => {
  const s = await withThread(t);
  const id = s.thread.id;
  const reported = () => s.registry.events("0", { kinds: ["attention.changed"], thread: id }).at(-1)?.payload.attention ?? null;
  const shown = async () => ((await s.call("GET", `/v1/threads/${id}`)).body as ThreadDetail).attention;
  s.fake.park(id, 1);
  assert.deepEqual([await shown(), reported()], ["parked", "parked"]);
  assert.equal((await s.call("DELETE", `/v1/threads/${id}`)).status, 200);
  assert.deepEqual([await shown(), reported()], [null, null]);
});

test("attention takes the first matching state in every combination", () => {
  for (const failed of [false, true]) for (const parked of [false, true]) for (const decision of [false, true]) for (const limited of [false, true]) {
    for (const reply of [null, 10]) for (const seen of [null, 9, 10, 11]) for (const working of [false, true]) {
      const expected = failed ? "failed" : decision ? "decision" : parked ? "parked" : limited ? "limited" : reply !== null && (seen === null || reply > seen) ? "reply" : working ? "working" : null;
      assert.equal(attentionOf(failed, parked, reply, seen, working, false, decision, limited), expected);
    }
  }
});

test("seen is bounded by the rendered reply, not a newer reply discovered by attention polling", async (t) => {
  const s = await withThread(t);
  const id = s.thread.id;
  const base = `/v1/threads/${id}`;
  s.registry.recordReply(id, 1000);
  const renderedReplyAt = s.registry.thread(id)!.lastReplyAt;
  s.registry.recordReply(id, 2000);
  const human = s.registry.thread(id)!.lastHumanActivityAt;
  s.woken.length = 0;
  assert.equal((await s.call("POST", `${base}/seen`, { lastReplyAt: renderedReplyAt })).status, 204);
  let detail = (await s.call("GET", base)).body as ThreadDetail;
  assert.equal(detail.seenAt, 1000);
  assert.equal(detail.lastReplyAt, 2000);
  assert.equal(detail.attention, "reply");
  assert.equal((await s.call("POST", `${base}/seen`, { lastReplyAt: null })).status, 204);
  assert.equal(s.registry.thread(id)!.seenAt, 1000);
  await s.call("POST", `${base}/seen`, { lastReplyAt: 2000 });
  detail = (await s.call("GET", base)).body as ThreadDetail;
  assert.equal(detail.seenAt, 2000);
  assert.equal(detail.attention, null);
  await s.call("POST", `${base}/seen`, { lastReplyAt: 1000 });
  assert.equal(s.registry.thread(id)!.seenAt, 2000, "a stale page does not undo another client's seen mark");
  for (const lastReplyAt of [-1, 1.5, "2000"]) {
    assert.equal((await s.call("POST", `${base}/seen`, { lastReplyAt })).status, 400);
  }
  assert.equal(s.registry.thread(id)!.lastHumanActivityAt, human);
  assert.deepEqual(s.woken, []);
});

test("latest-turn API reads include commits and uncommitted work, and refuse missing or stale snapshots", async (t) => {
  const s = await withThread(t);
  const { repo, run } = await localCheckout(t, s);
  s.fake.harness.latestTurn = async () => "42";
  const route = `/v1/threads/${s.thread.id}`;
  assert.equal((await s.call("GET", `${route}/changes?base=turn`)).status, 422);
  await checkoutReader(async (argv) => processStream(argv[0]!, argv.slice(1), () => {}), repo).snapshot("42");
  await writeFile(join(repo, "src/app.ts"), "committed\n");
  await run("commit", "-qam", "work");
  await writeFile(join(repo, "new.txt"), "untracked\n");
  const changes = await s.call("GET", `${route}/changes?base=turn`);
  assert.equal(changes.status, 200);
  assert.equal(changes.body.base.kind, "turn");
  assert.deepEqual(changes.body.files.map((f: { path: string }) => f.path), ["new.txt", "src/app.ts"]);
  const diff = await s.call("GET", `${route}/diff?base=turn&path=new.txt`);
  assert.deepEqual(diff.body.base, changes.body.base);
  assert.match(diff.body.diff, /\+untracked/);
  s.fake.harness.latestTurn = async () => "43";
  assert.equal((await s.call("GET", `${route}/diff?base=turn`)).status, 422);
});

test("a start repeated under its request ID answers the same thread and delivers its first message once", async (t) => {
  const s = await withImage(t);
  const body = { project: "acme", title: "Brief", message: "Fix the checkout bug.", requestId: "start:1" };
  const first = await s.call("POST", "/v1/threads", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const id = (first.body as Thread).id;
  const again = await s.call("POST", "/v1/threads", body);
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal((again.body as Thread).id, id);
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: ThreadRow) => r.id), [id], "one thread");
  const brief = ["send", id, "Fix the checkout bug.", `brief:${id}`, "followUp"];
  assert.deepEqual(s.calls, [["start", { threadId: id, pylonId: `pylon-${id}` }], brief, brief], "the repeat sends the brief again under the same request ID");
  assert.deepEqual(s.fake.transcript(id).messages.map((m) => m.content), ["Fix the checkout bug."], "one first message");

  const other = await s.call("POST", "/v1/threads", { ...body, title: "Another" });
  assert.equal(other.status, 409);
  assert.match(other.body.error, new RegExp(`request ID start:1 started thread ${id} with another body`));
  assert.equal((await s.call("POST", "/v1/threads", { ...body, message: "Something else." })).status, 409, "the first message is part of the body");
  assert.equal((await s.call("GET", "/v1/threads")).body.length, 1);

  assert.equal((await s.call("POST", `/v1/threads/${id}/archive`)).status, 200);
  const archived = await s.call("POST", "/v1/threads", body);
  assert.equal((archived.body as Thread).status, "archived", "a repeat answers the thread as it is now");
  assert.equal(s.calls.filter((c) => c[0] === "send").length, 2, "an archived thread is not sent its brief again");
});

test("starts repeated at once under one request ID start one thread, and one with another body is refused", async (t) => {
  const s = await withImage(t);
  const body = { project: "acme", title: "Twice", requestId: "start:same" };
  const reading = Promise.withResolvers<void>();
  const read = Promise.withResolvers<never>();
  s.remoteReads(() => { reading.resolve(); return read.promise; });
  const first = s.call("POST", "/v1/threads", body);
  await reading.promise;
  const second = s.call("POST", "/v1/threads", body);
  const other = await s.call("POST", "/v1/threads", { ...body, title: "Other" });
  read.reject(new Error("no remote"));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal((b.body as Thread).id, (a.body as Thread).id);
  assert.equal(other.status, 409);
  assert.match(other.body.error, /request ID start:same is starting a thread with another body/);
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: ThreadRow) => r.id), [(a.body as Thread).id]);
  assert.equal(s.calls.filter((c) => c[0] === "start").length, 1);
});

test("a start that failed under a request ID made nothing, so the ID starts a corrected body", async (t) => {
  const s = await withImage(t);
  assert.equal((await s.call("POST", "/v1/threads", { project: "nope", title: "x", requestId: "start:typo" })).status, 404);
  const fixed = await s.call("POST", "/v1/threads", { project: "acme", title: "x", requestId: "start:typo" });
  assert.equal(fixed.status, 201, JSON.stringify(fixed.body));
  const claude = await s.call("POST", "/v1/threads", { project: "acme", title: "x", claude: "Fix it", message: "hi", requestId: "start:claude" });
  assert.equal(claude.status, 400);
  assert.match(claude.body.error, /message is for a Nexus agent thread/);
  assert.equal(s.registry.startRequest("start:claude"), undefined);
  const plain = await s.call("POST", "/v1/threads", { project: "acme", title: "No ID", message: "Look around." });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual(s.calls.at(-1), ["send", (plain.body as Thread).id, "Look around.", `brief:${(plain.body as Thread).id}`, "followUp"], "a start without a request ID sends its first message too");
});

test("a start whose first message failed keeps its request ID, and a repeat sends the brief to the same thread once", async (t) => {
  const s = await withImage(t);
  const send = s.fake.harness.send;
  t.after(() => { s.fake.harness.send = send; });
  const cases = [
    { requestId: "start:refused", fail: () => Promise.reject(new Error("the harness is unreachable")) },
    { requestId: "start:unacknowledged", fail: async (...args: Parameters<typeof send>) => { await send(...args); throw new Error("the acknowledgement was lost"); } },
  ];
  for (const { requestId, fail } of cases) {
    const body = { project: "acme", title: requestId, message: `Brief for ${requestId}`, requestId };
    s.fake.harness.send = fail;
    const failed = await s.call("POST", "/v1/threads", body);
    s.fake.harness.send = send;
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    const id = s.registry.startRequest(requestId)?.thread;
    assert.ok(id !== undefined, `${requestId}: the thread committed, so its request ID is kept`);
    assert.equal(failed.body.error, `started ${id}, but its first message was not sent: ${requestId === "start:refused" ? "the harness is unreachable" : "the acknowledgement was lost"}. Start it again under request ID ${requestId} to send it`);
    assert.equal((await s.call("POST", "/v1/threads", { ...body, message: "Another brief" })).status, 409, `${requestId}: another body is refused`);
    const retried = await s.call("POST", "/v1/threads", body);
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    assert.equal((retried.body as Thread).id, id);
    assert.deepEqual(s.fake.transcript(id).messages.map((m) => m.content), [`Brief for ${requestId}`], `${requestId}: the brief arrived once`);
  }
  assert.equal((await s.call("GET", "/v1/threads")).body.length, 2, "one thread per request ID");
});

test("thread detail lists the judgments of the thread's failed pylon, oldest failure first, with what each decided and did", async (t) => {
  const s = await withThread(t);
  const judgment = (failure: number, phase: Judgment["phase"]): Judgment => ({
    failure, thread: s.thread.id, node, failed: "pylon is broken: the controller exited", startedAt: 5, request: failure === 900 ? null : { brief: "Is it the node?", token: "t" },
    conversation: null, reply: failure === 900 ? null : "No block.", phase,
  });
  s.registry.saveJudgment(judgment(900, { kind: "acting", verdict: { answer: "person", why: "Nexus already retried this thread's pylon 2 times on its own", by: "control plane" } }), null);
  s.registry.saveJudgment(judgment(812, { kind: "done", verdict: { answer: "retry-elsewhere", why: "The node is out of disk.", by: "judgment" }, outcome: { kind: "moved", from: node, to: "rj-other" as NodeName, on: "verdict" } }), null);
  const { judgments } = (await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail;
  assert.deepEqual(judgments, [
    { failure: 812, node, failed: "pylon is broken: the controller exited", startedAt: 5, phase: "done", verdict: { answer: "retry-elsewhere", why: "The node is out of disk.", by: "judgment" },
      outcome: `moved the pylon from ${node} to rj-other and retried it`, question: null, brief: "Is it the node?", reply: "No block." },
    { failure: 900, node, failed: "pylon is broken: the controller exited", startedAt: 5, phase: "acting", verdict: { answer: "person", why: "Nexus already retried this thread's pylon 2 times on its own", by: "control plane" },
      outcome: null, question: null, brief: null, reply: null },
  ]);
});

test("a harness, a Claude worker and a bare thread each answer every agent route as their kind does", async (t) => {
  const s = await withThread(t);
  const claude = (await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix it" })).body as Thread;
  const bare = await s.startThread({ project: "acme", title: "Check", bare: true }, laptop);
  const threads = { harness: s.thread, claude, bare };
  /** Each route's status, with its error or what its body is. A stream that opens is closed at once. */
  const answer = async (method: string, path: string, body?: unknown) => {
    if (path.endsWith("events") || path.endsWith("/stream")) {
      const stream = s.events(path);
      const { statusCode } = await stream.response;
      stream.close();
      if (statusCode === 200) return "200 stream";
    }
    const res = await s.call(method, path, body);
    return `${res.status} ${res.body === null ? "" : res.body.error ?? (res.body.kind === "claude" ? "claude view" : Array.isArray(res.body.entries) ? "harness view" : JSON.stringify(res.body))}`;
  };
  const routes = async (t: Thread, requestId: string) => ({
    detail: await (async () => {
      const d = (await s.call("GET", `/v1/threads/${t.id}`)).body as ThreadDetail;
      return { claudeWorker: d.claudeWorker ?? null, agent: d.agent };
    })(),
    conversation: await answer("GET", `/v1/threads/${t.id}/conversation`),
    events: await answer("GET", `/v1/threads/${t.id}/events`),
    claudeEvents: await answer("GET", `/v1/threads/${t.id}/claude/events`),
    page: await answer("GET", `/threads/${t.id}/stream`),
    message: await answer("POST", `/v1/threads/${t.id}/messages`, { text: "hi", requestId }),
    abort: await answer("POST", `/v1/threads/${t.id}/abort`),
    retry: await answer("POST", `/v1/threads/${t.id}/retry`),
  });
  const noConversation = (t: Thread) => `409 thread ${t.id} has no conversation`;
  const noWorker = (t: Thread) => `409 thread ${t.id} has no Claude worker`;
  const deleted = (t: Thread) => `409 thread ${t.id} is deleted`;
  const archived = (t: Thread) => `409 thread ${t.id} is archived`;
  assert.deepEqual(await routes(threads.harness, "msg:h"), {
    detail: { claudeWorker: null, agent: { parkedTasks: 0 } }, conversation: "200 harness view", events: "200 stream", claudeEvents: noWorker(threads.harness),
    page: "200 stream", message: '202 {"submission":7}', abort: "204 ", retry: "204 ",
  });
  assert.deepEqual(await routes(threads.claude, "msg:c"), {
    detail: { claudeWorker: { model: "claude-opus-5-5", state: "pending" }, agent: null }, conversation: "200 claude view", events: noConversation(threads.claude), claudeEvents: "200 stream",
    page: "200 stream", message: `409 the Claude worker of ${threads.claude.id} has not started a session yet, so it takes no messages. Send it once it has started`,
    abort: `409 the Claude worker of ${threads.claude.id} has not started a session yet, so it has no turn to interrupt`, retry: noConversation(threads.claude),
  });
  assert.deepEqual(await routes(threads.bare, "msg:b"), {
    detail: { claudeWorker: null, agent: null }, conversation: noConversation(threads.bare), events: noConversation(threads.bare), claudeEvents: noWorker(threads.bare),
    page: noConversation(threads.bare), message: noConversation(threads.bare), abort: noConversation(threads.bare), retry: noConversation(threads.bare),
  });

  for (const t of Object.values(threads)) assert.equal((await s.call("POST", `/v1/threads/${t.id}/archive`)).status, 200);
  assert.deepEqual(await Promise.all(Object.values(threads).map((t) => answer("POST", `/v1/threads/${t.id}/messages`, { text: "hi", requestId: "msg:archived" }))), Object.values(threads).map(archived));
  assert.deepEqual(await Promise.all(Object.values(threads).map((t) => answer("POST", `/v1/threads/${t.id}/retry`))), Object.values(threads).map(archived));
  for (const t of Object.values(threads)) assert.equal((await s.call("POST", `/v1/threads/${t.id}/unarchive`)).status, 200);

  s.calls.length = 0;
  for (const t of Object.values(threads)) assert.equal((await s.call("DELETE", `/v1/threads/${t.id}`)).status, 200);
  assert.deepEqual(s.calls, [["delete", { threadId: threads.harness.id, pylonId: threads.harness.pylonId }]], "only the harness thread's conversation is deleted");
  for (const t of Object.values(threads)) {
    assert.deepEqual(await routes(t, "msg:deleted"), {
      detail: { claudeWorker: t === claude ? { model: "claude-opus-5-5", state: "pending" } : null, agent: null }, conversation: deleted(t), events: deleted(t), claudeEvents: deleted(t),
      page: deleted(t), message: deleted(t), abort: deleted(t), retry: deleted(t),
    }, t.title);
  }
});
