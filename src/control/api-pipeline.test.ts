/** The pipeline's items, queued starts and planning threads. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadDetail, ThreadRow } from "./wire.ts";
import type { Question } from "./questions.ts";
import type { PipelineItem } from "./pipeline.ts";
import { planningPrefix } from "../agent-protocol.ts";
import type { QueuedThread } from "./queue.ts";
import type { Thread } from "./registry.ts";
import type { ImageId } from "../images.ts";
import type { PylonId, TailnetNodeId } from "../ids.ts";
import { node, laptop, phone, project, image, testApi, withImage, deployment, withQueue } from "./api-test-kit.ts";

test("an item is added to a project the pipeline runs for, becomes a queued thread behind the items it is after, and only a person adds, approves or cancels one", async (t) => {
  const s = await testApi(t, { pipeline: true, deployment });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", pipeline: { autoStart: true } })).status, 400, "only an edit turns the pipeline on");
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const off = await s.call("POST", "/v1/items", { project: "acme", title: "A", message: "Build A." });
  assert.deepEqual(off, { status: 409, body: { error: "the pipeline does not run for project acme. nexus project edit acme --pipeline start turns it on" } });

  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { pipeline: { autoStart: true } })).status, 403, "the control plane cannot turn approvals off");
  s.callAs(laptop);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "X", requestId: "pipeline:it-000000000000" })).status, 400, "an item's request ID is the pipeline's own");
  const approving = await s.call("PATCH", "/v1/projects/acme", { pipeline: { autoStart: false } });
  assert.deepEqual(approving.body.pipeline, { autoStart: false });
  const a = await s.call("POST", "/v1/items", { project: "acme", title: "A", message: "Build A." });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const item = a.body as PipelineItem;
  assert.deepEqual(item, {
    id: item.id, project: "acme", title: "A", addedBy: laptop, addedAt: item.addedAt, after: [], worker: "harness", model: null, brief: "Build A.", thread: null,
    phase: { kind: "held", why: `project acme waits for the person to approve each item: nexus item approve ${item.id}` }, approved: null,
  });
  assert.match(item.id, /^it-[0-9a-f]{12}$/);
  const b = (await s.call("POST", "/v1/items", { project: "acme", title: "B", claude: "Build B", after: [item.id] })).body as PipelineItem;
  assert.deepEqual(b.phase, { kind: "planned", why: "waits for A to be queued" });
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "C", message: "Go.", after: ["it-000000000000"] })).status, 404);
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "C", message: "Go.", after: [] })).status, 201, "an empty after is nothing ahead");
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "C", message: "Go.", requestId: "x" })).status, 400, "an item takes no request ID");

  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual(await s.call("POST", `/v1/items/${item.id}/approve`, {}), { status: 403, body: { error: "caller may not approve an item: only a person may, never the control plane, infrastructure nodes or pylons" } });
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "D", message: "Go." })).status, 403, "the control plane, and so a harness thread, adds no item");
  assert.equal((await s.call("POST", `/v1/items/${b.id}/cancel`, {})).status, 403);
  s.callAs(laptop);
  const approved = await s.call("POST", `/v1/items/${item.id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual((approved.body as PipelineItem).approved?.by, laptop);
  const thread = (approved.body as PipelineItem).thread!;
  assert.match(thread, /^th-/, "the approval queues it at once");
  assert.equal(s.registry.queuedThread(thread)?.startedBy, laptop);
  assert.equal((await s.call("POST", `/v1/items/${item.id}/cancel`, {})).status, 409, "a queued item is cancelled by archiving its thread");
  assert.equal((await s.call("POST", `/v1/items/${b.id}/approve`, {})).status, 200);
  const shown = (await s.call("GET", `/v1/items/${b.id}`)).body as PipelineItem;
  assert.notEqual(shown.thread, null);
  assert.deepEqual(s.registry.queuedThread(shown.thread!)?.after, [thread], "the second item's thread waits for the first's");
  assert.equal((await s.call("GET", "/v1/items")).body.length, 3);
  assert.deepEqual((await s.call("GET", "/v1/items?project=other")).body, []);
  assert.equal((await s.call("GET", "/v1/items/it-000000000000")).status, 404);

  const offAgain = await s.call("PATCH", "/v1/projects/acme", { pipeline: null });
  assert.equal(offAgain.body.pipeline, null, "an off pipeline is kept as null, so the migration never turns it on again");
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { defaultBranch: "trunk" })).body.pipeline, null, "another edit keeps it");
});

test("a start after other threads is queued with no row or pylon, until start-queued starts it as any start", async (t) => {
  const s = await withQueue(t);
  const answer = await s.call("POST", "/v1/threads", { project: "acme", title: "Then", after: [s.first.id], message: "Fix the next bug." });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const queued = answer.body as QueuedThread;
  assert.deepEqual(queued, {
    id: queued.id, title: "Then", project: "acme", startedBy: laptop, createdAt: queued.createdAt, status: "queued", after: [s.first.id],
    waits: [{ thread: s.first.id, state: "waiting", why: "has no pull request yet" }], blocked: false, node, worker: "harness", model: null,
    prompt: "Fix the next bug.", branch: null, commit: null, resources: project.resources, startNow: null, lastError: null,
  });
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: ThreadRow) => r.id), [s.first.id], "the thread list leaves queued threads out");
  assert.deepEqual(await s.call("GET", "/v1/queued"), { status: 200, body: [queued] });
  assert.deepEqual((await s.call("GET", "/v1/queued?project=other")).body, []);
  assert.deepEqual(await s.call("GET", `/v1/queued/${queued.id}`), { status: 200, body: queued });
  assert.equal((await s.call("GET", `/v1/queued/${s.first.id}`)).status, 404, "a started thread is not queued");
  const refused = await s.call("GET", `/v1/threads/${queued.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /is queued, so it has no pylon or conversation yet/);
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/messages`, { text: "hi", requestId: "msg:1" })).status, 409);
  assert.equal(s.registry.pylon(`pylon-${queued.id}` as PylonId), undefined);
  assert.equal(s.calls.length, 1, "only the first thread has a conversation");

  const archived = await s.call("POST", `/v1/threads/${queued.id}/archive`);
  assert.deepEqual(archived, { status: 200, body: { ...queued, status: "archived" } });
  assert.match((await s.call("GET", `/v1/threads/${queued.id}`)).body.error, /was cancelled while queued/);
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/archive`)).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/start`)).status, 409, "a cancelled thread starts only once unarchived");
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/unarchive`)).body.status, "queued");

  const started = await s.call("POST", `/v1/threads/${queued.id}/start`);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal((started.body as Thread).id, queued.id);
  assert.equal((started.body as Thread).startedBy, laptop);
  assert.deepEqual(s.calls.slice(1), [
    ["start", { threadId: queued.id, pylonId: `pylon-${queued.id}` }],
    ["send", queued.id, "Fix the next bug.", `queued:${queued.id}`, "followUp"],
  ]);
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: ThreadRow) => r.id), [s.first.id, queued.id]);
  assert.deepEqual((await s.call("GET", "/v1/queued")).body, []);
  assert.equal((await s.call("GET", `/v1/queued/${queued.id}`)).status, 404);
  assert.equal((await s.call("GET", `/v1/threads/${queued.id}`)).status, 200);
  assert.match((await s.call("POST", `/v1/threads/${queued.id}/start`)).body.error, /has started/);
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/archive`)).body.status, "archived", "a started thread archives as a thread");

  const other = (await s.call("POST", "/v1/threads", { project: "acme", title: "Later", after: [queued.id], claude: "Fix it" })).body as QueuedThread;
  assert.equal(other.worker, "claude");
  assert.deepEqual(other.waits, [{ thread: queued.id, state: "blocked", why: "is archived and its pull request did not merge" }]);
  assert.equal(other.blocked, true);
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${other.id}`), { status: 200, body: { ...other, status: "deleted" } });
  assert.equal((await s.call("DELETE", `/v1/threads/${other.id}`)).status, 409);
  assert.equal((await s.call("POST", "/v1/threads/th-000000000000/start")).status, 404);
});

test("a queued start is checked as a start is before it is recorded, and needs the GitHub token", async (t) => {
  const s = await withQueue(t);
  const refused = async (body: unknown, status: number, error: RegExp) => {
    const answer = await s.call("POST", "/v1/threads", body);
    assert.equal(answer.status, status, JSON.stringify(answer.body));
    assert.match(answer.body.error, error);
  };
  await refused({ project: "acme", title: "x", after: [] }, 400, /after/);
  await refused({ project: "acme", title: "x", after: Array.from({ length: 33 }, (_, i) => `th-${i}`) }, 400, /after/);
  await refused({ project: "acme", title: "x", after: ["th-nope"] }, 404, /no thread th-nope/);
  await refused({ project: "nope", title: "x", after: [s.first.id] }, 404, /no project nope/);
  await refused({ project: "acme", title: "x", node: "nowhere", after: [s.first.id] }, 400, /no node nowhere/);
  await refused({ project: "acme", title: "x", claude: "Fix it", message: "hi", after: [s.first.id] }, 400, /message is for a Nexus agent thread/);
  assert.deepEqual((await s.call("GET", "/v1/queued")).body, []);

  const plain = await withImage(t);
  const answer = await plain.call("POST", "/v1/threads", { project: "acme", title: "x", after: ["th-any"] });
  assert.equal(answer.status, 409);
  assert.match(answer.body.error, /queued threads need the control plane's GitHub token \(github.tokenFile\)/);
  assert.deepEqual((await plain.call("GET", "/v1/queued")).body, []);
});

test("a queued start repeated under its request ID answers the same queued thread, then the thread it became", async (t) => {
  const s = await withQueue(t);
  const body = { project: "acme", title: "Then", after: [s.first.id], message: "Fix the next bug.", requestId: "start:queued" };
  const first = await s.call("POST", "/v1/threads", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const queued = first.body as QueuedThread;
  assert.deepEqual(await s.call("POST", "/v1/threads", body), { status: 201, body: queued });
  assert.deepEqual((await s.call("GET", "/v1/queued")).body, [queued], "one queued thread");
  assert.equal((await s.call("POST", "/v1/threads", { ...body, after: undefined })).status, 409, "an immediate start under the queued start's ID is another body");

  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/start`)).status, 201);
  const started = await s.call("POST", "/v1/threads", body);
  assert.equal(started.status, 201);
  assert.equal((started.body as Thread).id, queued.id);
  assert.equal((started.body as Thread).pylonId, `pylon-${queued.id}`, "a repeat after the start answers the thread");
  assert.deepEqual(s.fake.transcript(queued.id).messages.map((m) => m.content), ["Fix the next bug."]);
});

test("a planning thread's proposals become cards only a person answers, an accepted one becomes the person's item and queued thread, and the next message tells the thread", async (t) => {
  const s = await testApi(t, { pipeline: true, deployment });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { pipeline: { autoStart: true } })).status, 200);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Plan", planning: true, claude: "Plan it" })).status, 400, "a Claude worker cannot plan");
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Plan", planning: true, after: ["th-000000000000"] })).status, 400, "a planning thread starts now");
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "Plan", message: "Go.", planning: true })).status, 400, "an item is no planning thread");
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Plan the wave", planning: true, message: "Plan the orchestration wave." });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = (started.body as Thread).id;
  assert.equal(((await s.call("GET", `/v1/threads/${id}`)).body as ThreadDetail).planning, true);
  const first = s.fake.transcript(id).messages[0]!.content as string;
  assert.ok(first.startsWith(planningPrefix) && first.endsWith("Plan the orchestration wave."), "the guide goes before the person's first message");
  const token = /"token": "([^"]+)"/.exec(first)![1]!;

  s.fake.transcript(id).messages.push({ role: "assistant", content: [{ type: "text", text: `Two items.\n\`\`\`nexus-plan\n${JSON.stringify({ token, items: [
    { key: "a", title: "A: archive what landed", brief: "Archive the builder once its review lands." },
    { key: "b", title: "B: nudge a stalled builder", brief: "Nudge a builder that stopped short.", after: ["a"] },
  ] })}\n\`\`\`` }] } as never);
  s.fake.commit(id);
  s.registry.recordReply(id, Date.now());
  await s.plans!.poll();
  const detail = async () => (await s.call("GET", `/v1/threads/${id}`)).body as ThreadDetail;
  const [a, b] = (await detail()).questions;
  assert.deepEqual([a!.proposal?.title, b!.proposal?.title], ["A: archive what landed", "B: nudge a stalled builder"]);
  assert.ok(a!.text.includes("Archive the builder once its review lands."), "the card shows the brief in full");
  assert.equal((await detail()).attention, "decision");
  assert.deepEqual([s.registry.items().length, s.registry.queuedThreads().length], [0, 0], "nothing the thread wrote adds or starts work, though the project's items start on their own");

  const answer = (q: Question, option: string) => s.call("POST", `/v1/questions/${q.id}/answer`, { option });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual(await answer(a!, "accept"), { status: 403, body: { error: "caller may not answer this question: only a person's device may, never infrastructure nodes or pylons" } });
  s.callAs(phone);
  assert.deepEqual(await answer(b!, "accept"), { status: 409, body: { error: `"B: nudge a stalled builder" waits on "A: archive what landed", which is not answered yet. Accept that one first` } });
  assert.equal(s.registry.question(b!.id)!.answer, null, "a refused accept leaves the card open");
  assert.equal((await answer(a!, "accept")).status, 200);
  assert.equal((await answer(b!, "reject")).status, 200);
  const items = (await s.call("GET", "/v1/items")).body as PipelineItem[];
  assert.deepEqual(items.map((i) => [i.title, i.addedBy, i.brief]), [["A: archive what landed", phone, "Archive the builder once its review lands."]], "only the accepted proposal is an item, the person's");
  assert.equal(s.registry.queuedThread(items[0]!.thread!)?.startedBy, phone, "and is queued as the person's at once");
  assert.notEqual((await detail()).attention, "decision");

  s.callAs(laptop);
  assert.equal((await s.call("POST", `/v1/threads/${id}/messages`, { text: "B is too early.", requestId: "msg:1" })).status, 202);
  assert.equal((await s.call("POST", `/v1/threads/${id}/messages`, { text: "B is too early.", requestId: "msg:1" })).status, 202);
  assert.equal((await s.call("POST", `/v1/threads/${id}/messages`, { text: "Go on.", requestId: "msg:2" })).status, 202);
  assert.deepEqual(s.fake.transcript(id).messages.slice(2).map((m) => m.content), [
    `${planningPrefix}\nThe person answered your proposals:\n- accepted "A: archive what landed" (key a), now pipeline item ${items[0]!.id}\n- rejected "B: nudge a stalled builder" (key b)\nThe person's message follows.\n\nB is too early.`,
    "Go on.",
  ], "the next message tells what the person answered, once");
});
