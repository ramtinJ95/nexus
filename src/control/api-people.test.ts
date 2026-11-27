import { test } from "node:test";
import assert from "node:assert/strict";
import { attachPathOf, attachTo, deployment, image, laptop, node, project, sharedProject, testApi } from "../test-support/api-kit.ts";
import { tailnet, type WhoisAnswer } from "../test-support/people.ts";
import { parseWhois, type TailnetCaller } from "../node-base/tailscaled.ts";
import { operator, peopleOf } from "./people.ts";
import type { ImageId, Person, TailnetNodeId, ThreadId } from "../ids.ts";

const alice = tailnet.alice.UserProfile!.LoginName as Person;
const bob = tailnet.bob.UserProfile!.LoginName as Person;
const people = peopleOf({ [alice]: "admin", [bob]: "engineer" });

const answer = (a: WhoisAnswer): TailnetCaller => ({ id: a.Node.StableID, ...parseWhois(a).identity });
/** The control plane's own node, rj-firebat, registered in the registry, as whois would name it were it owned by alice. */
const nodeAsAlice = answer({ ...tailnet.alice, Node: { ...tailnet.alice.Node, StableID: "nFIREBAT" as TailnetNodeId } });
const carol = answer({ ...tailnet.bob, Node: { ...tailnet.bob.Node, StableID: "nCAROL" as TailnetNodeId }, UserProfile: { ...tailnet.bob.UserProfile!, LoginName: "carol@example.com" } });

/** A shared install whose whois names whoever `as` was last given, with alice's project and image in place. */
async function shared(t: Parameters<typeof testApi>[0], options: Parameters<typeof testApi>[1] = {}) {
  let caller: TailnetCaller = answer(tailnet.alice);
  const s = await testApi(t, { people, allowed: new Set(), whois: async () => caller, ...options });
  await s.call("POST", "/v1/projects", sharedProject);
  await s.call("POST", "/v1/images", image);
  s.registry.images.setCurrentImage(image.id as ImageId);
  return { ...s, as(c: TailnetCaller) { caller = c; } };
}

test("on a shared install a person is admitted by tailnet login, an admin holds a deployer's role, and an engineer does not", async (t) => {
  const s = await shared(t);
  assert.deepEqual((await s.call("GET", "/v1/whoami")).body, { node: tailnet.alice.Node.StableID, allowed: true, person: true, deployer: true });
  s.as(answer(tailnet.bob));
  assert.deepEqual((await s.call("GET", "/v1/whoami")).body, { node: tailnet.bob.Node.StableID, allowed: true, person: true, deployer: false });
  s.as(carol);
  assert.deepEqual((await s.call("GET", "/v1/whoami")).body, { node: "nCAROL", allowed: false, person: false, deployer: false }, "a login people does not name is no one");
  assert.equal((await s.call("GET", "/v1/threads")).status, 403);
});

test("on a shared install a tagged device, or a node in the registry whatever user whois names, is refused on a person route", async (t) => {
  const s = await shared(t);
  for (const device of [answer(tailnet.node), nodeAsAlice]) {
    s.as(device);
    const r = await s.call("POST", "/v1/threads", { project: "acme", title: "x" });
    assert.equal(r.status, 403, `${device.id} on POST /v1/threads`);
    assert.equal((await s.call("GET", "/v1/whoami")).body.person, false, `${device.id} is no person`);
  }
  assert.deepEqual(s.registry.threads.storedThreads(), [], "no device started a thread");
});

test("on a shared install each thread is owned by the person who started it, and startedBy still names the device", async (t) => {
  const s = await shared(t);
  const first = await s.call("POST", "/v1/threads", { project: "acme", title: "alice's" });
  s.as(answer(tailnet.bob));
  const second = await s.call("POST", "/v1/threads", { project: "acme", title: "bob's" });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(s.registry.threads.storedThreads().map((th) => [th.title, th.owner, th.startedBy]), [
    ["alice's", alice, tailnet.alice.Node.StableID], ["bob's", bob, tailnet.bob.Node.StableID],
  ]);
  const shown = await s.call("GET", `/v1/threads/${first.body.id}`);
  assert.equal(shown.body.thread.owner, alice, "bob reads alice as the owner of her thread");
});

test("on a shared install a queued thread is its queuer's, who alone starts it now", async (t) => {
  const s = await shared(t, { queue: true });
  const ahead = await s.call("POST", "/v1/threads", { project: "acme", title: "ahead" });
  s.as(answer(tailnet.bob));
  const queued = await s.call("POST", "/v1/threads", { project: "acme", title: "after", after: [ahead.body.id] });
  assert.equal(queued.status, 201);
  assert.equal(s.registry.queue.queuedThread(queued.body.id)?.owner, bob);
  s.as(answer(tailnet.alice));
  const refused = await s.call("POST", `/v1/threads/${queued.body.id}/start`);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /is bob@example\.com's, so only bob@example\.com may start a queued thread/);
  s.as(answer(tailnet.bob));
  const started = await s.call("POST", `/v1/threads/${queued.body.id}/start`);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(s.registry.threads.thread(queued.body.id)?.owner, bob);
});

/** Every route that acts on a thread, with a body it takes, in an order whose last ones end the thread. */
const acting = (id: ThreadId): readonly [string, string, unknown?][] => [
  ["POST", `/v1/threads/${id}/messages`, { text: "hi" }], ["POST", `/v1/threads/${id}/retry`, {}], ["POST", `/v1/threads/${id}/pylon/retry`, {}],
  ["POST", `/v1/threads/${id}/previews`, { port: 3000 }], ["DELETE", `/v1/threads/${id}/previews/3000`, {}],
  ["POST", `/v1/threads/${id}/sessions`, {}], ["DELETE", `/v1/threads/${id}/sessions/s1`, {}],
  ["POST", `/v1/threads/${id}/review`, {}], ["POST", `/v1/threads/${id}/review/cancel`, {}],
  ["GET", attachPathOf(id)], ["POST", `/v1/threads/${id}/abort`, {}],
  ["POST", `/v1/threads/${id}/archive`, {}], ["POST", `/v1/threads/${id}/unarchive`, {}], ["DELETE", `/v1/threads/${id}`, {}],
];

test("on a shared install a teammate is refused every route that acts on a thread, by a 403 that names its owner, and the owner is admitted", async (t) => {
  const s = await shared(t);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "alice's" });
  const id = started.body.id as ThreadId;
  s.as(answer(tailnet.bob));
  for (const [method, path, body] of acting(id)) {
    const r = await s.call(method, path, body);
    assert.equal(r.status, 403, `bob ${method} ${path}`);
    assert.match(r.body.error, new RegExp(`thread ${id} is alice@example\\.com's, so only alice@example\\.com`), `bob ${method} ${path}`);
  }
  for (const path of [attachPathOf(id), `/v1/threads/${id}/exec?line=true`]) {
    const upgrade = await attachTo(s.port, path);
    assert.ok("status" in upgrade, `bob's ${path} upgraded`);
    assert.equal(upgrade.status, 403, path);
    assert.match(upgrade.body.error, /is alice@example\.com's/, path);
  }
  assert.deepEqual(s.calls.filter((c) => c[0] === "send"), [], "no message of bob's reached the thread");
  assert.equal(s.registry.threads.threadStatus(id), "active");
  assert.equal((await s.call("GET", `/v1/threads/${id}`)).status, 200, "bob still reads the thread");
  s.as(answer(tailnet.alice));
  for (const [method, path, body] of acting(id)) {
    const r = await s.call(method, path, body);
    assert.notEqual(r.status, 403, `alice ${method} ${path}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(s.registry.threads.threadStatus(id), "deleted");
});

test("on a shared install an admin may abort, archive and delete an engineer's thread, and nothing else of it", async (t) => {
  const s = await shared(t);
  s.as(answer(tailnet.bob));
  const id = (await s.call("POST", "/v1/threads", { project: "acme", title: "bob's" })).body.id as ThreadId;
  s.as(answer(tailnet.alice));
  const message = await s.call("POST", `/v1/threads/${id}/messages`, { text: "hi" });
  assert.equal(message.status, 403);
  assert.match(message.body.error, /is bob@example\.com's, so only bob@example\.com may message a thread/);
  assert.equal((await s.call("POST", `/v1/threads/${id}/abort`, {})).status, 204);
  assert.equal((await s.call("POST", `/v1/threads/${id}/archive`, {})).status, 200);
  const unarchive = await s.call("POST", `/v1/threads/${id}/unarchive`, {});
  assert.equal(unarchive.status, 403, "an admin does not open an engineer's thread again");
  assert.equal((await s.call("DELETE", `/v1/threads/${id}`, {})).status, 200);
  assert.equal(s.registry.threads.threadStatus(id), "deleted");
});

test("on a shared install a question about a thread is its owner's to answer", async (t) => {
  const s = await shared(t);
  const id = (await s.call("POST", "/v1/threads", { project: "acme", title: "alice's" })).body.id as ThreadId;
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-go", thread: id, text: "Go?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: 1, failure: 0 });
  s.as(answer(tailnet.bob));
  const refused = await s.call("POST", "/v1/questions/qn-go/answer", { option: "Yes" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /its thread is alice@example\.com's, so only alice@example\.com may/);
  s.as(answer(tailnet.alice));
  const answered = await s.call("POST", "/v1/questions/qn-go/answer", { option: "Yes" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
});

test("on a shared install each person has their own seen mark, and a teammate's leaves the owner's reply unread", async (t) => {
  const s = await shared(t);
  const id = (await s.call("POST", "/v1/threads", { project: "acme", title: "alice's" })).body.id as ThreadId;
  s.registry.threads.recordReply(id, 5_000);
  const seenAt = async () => (await s.call("GET", `/v1/threads/${id}`)).body.seenAt as number | null;
  const listed = async () => ((await s.call("GET", "/v1/threads")).body as { id: string; seenAt: number | null }[]).find((r) => r.id === id)!.seenAt;
  s.as(answer(tailnet.bob));
  assert.equal((await s.call("POST", `/v1/threads/${id}/seen`, { lastReplyAt: 5_000 })).status, 204);
  assert.equal(await seenAt(), 5_000, "bob has seen the reply");
  assert.equal(await listed(), 5_000, "and the list says so to him");
  s.as(answer(tailnet.alice));
  assert.equal(await seenAt(), null, "alice has not");
  assert.equal(s.registry.threads.attention(id), "reply", "the reply still waits on alice");
  assert.equal((await s.call("POST", `/v1/threads/${id}/seen`, { lastReplyAt: 5_000 })).status, 204);
  assert.equal(s.registry.threads.attention(id), null, "alice's own mark settles it");
  s.as(answer(tailnet.bob));
  assert.equal((await s.call("POST", `/v1/threads/${id}/unseen`, {})).status, 204);
  assert.equal(await seenAt(), 4_999, "bob marked it unread for himself");
  s.registry.threads.recordReply(id, 6_000);
  assert.equal(await listed(), 4_999);
  s.as(answer(tailnet.alice));
  assert.ok((await seenAt())! >= 5_000, "bob's unread mark leaves alice's");
});

test("on a shared install an item becomes the thread of the person who approves it", async (t) => {
  const s = await shared(t, { pipeline: true, deployment });
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { pipeline: { autoStart: false } })).status, 200);
  const added = await s.call("POST", "/v1/items", { project: "acme", title: "Rewrite billing", claude: "Rewrite the billing module and open a pull request." });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  s.as(answer(tailnet.bob));
  const approved = await s.call("POST", `/v1/items/${added.body.id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const queued = s.registry.queue.queuedThread(approved.body.thread);
  assert.equal(queued?.owner, bob, "bob approved it, so it runs as his");
  assert.equal(queued?.startedBy, tailnet.bob.Node.StableID);
  assert.deepEqual(Object.keys(approved.body.approved), ["by", "at"], "the item's view keeps the approval's shape");
});

test("without people the operator owns every thread and a device on the allowlist starts it as before", async (t) => {
  const s = await testApi(t);
  await s.call("POST", "/v1/projects", project);
  await s.call("POST", "/v1/images", image);
  s.registry.images.setCurrentImage(image.id as ImageId);
  const r = await s.call("POST", "/v1/threads", { project: "acme", title: "x" });
  assert.equal(r.status, 201);
  assert.equal(r.body.owner, operator);
  assert.equal(r.body.startedBy, laptop);
  assert.equal(s.registry.threads.pylon(r.body.pylonId)?.node, node);
});

test("on a shared install a repeat of another person's start request is refused, so it never sends a message into their thread", async (t) => {
  const s = await shared(t);
  const body = { project: "acme", title: "alice's", message: "Go.", requestId: "alice:1" };
  const first = await s.call("POST", "/v1/threads", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const sends = () => s.calls.filter((c) => c[0] === "send").length;
  const before = sends();
  s.as(answer(tailnet.bob));
  const repeat = await s.call("POST", "/v1/threads", body);
  assert.equal(repeat.status, 403);
  assert.match(repeat.body.error, new RegExp(`started thread ${first.body.id} of alice@example\\.com's, so only alice@example\\.com may repeat it`));
  assert.equal(sends(), before, "bob's repeat sent nothing");
  s.as(answer(tailnet.alice));
  assert.equal((await s.call("POST", "/v1/threads", body)).status, 201, "alice's own repeat answers her thread");
});

test("on a shared install a caller the allowlist still admits but who is no person reads threads with their owners' marks, and has no mark of its own", async (t) => {
  const s = await shared(t, { allowed: new Set(["nFIREBAT" as TailnetNodeId]) });
  const id = (await s.call("POST", "/v1/threads", { project: "acme", title: "alice's" })).body.id as ThreadId;
  s.registry.threads.recordReply(id, 5_000);
  assert.equal((await s.call("POST", `/v1/threads/${id}/seen`, { lastReplyAt: 5_000 })).status, 204);
  s.as(nodeAsAlice);
  assert.equal((await s.call("GET", `/v1/threads/${id}`)).body.seenAt, 5_000, "the control node reads alice's mark");
  assert.equal((await s.call("GET", "/v1/threads")).status, 200);
  const marked = await s.call("POST", `/v1/threads/${id}/unseen`, {});
  assert.equal(marked.status, 403, "whatever user whois names for it, the control node marks nothing");
  assert.equal(s.registry.threads.attention(id), null, "alice's reply stays seen");
});
