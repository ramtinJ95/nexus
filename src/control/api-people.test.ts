import { test } from "node:test";
import assert from "node:assert/strict";
import { image, laptop, node, project, testApi } from "../test-support/api-kit.ts";
import { tailnet, type WhoisAnswer } from "../test-support/people.ts";
import { parseWhois, type TailnetCaller } from "../node-base/tailscaled.ts";
import { operator, peopleOf } from "./people.ts";
import type { ImageId, Person, TailnetNodeId } from "../ids.ts";

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
  await s.call("POST", "/v1/projects", project);
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

test("on a shared install a queued thread keeps the owner who queued it once it starts", async (t) => {
  const s = await shared(t, { queue: true });
  const ahead = await s.call("POST", "/v1/threads", { project: "acme", title: "ahead" });
  s.as(answer(tailnet.bob));
  const queued = await s.call("POST", "/v1/threads", { project: "acme", title: "after", after: [ahead.body.id] });
  assert.equal(queued.status, 201);
  assert.equal(s.registry.queue.queuedThread(queued.body.id)?.owner, bob);
  s.as(answer(tailnet.alice));
  const started = await s.call("POST", `/v1/threads/${queued.body.id}/start`);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(s.registry.threads.thread(queued.body.id)?.owner, bob, "whoever starts it now, it stays bob's");
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
