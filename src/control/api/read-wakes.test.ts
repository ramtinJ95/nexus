import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deployment, image, localCheckout, observeRunning, sharedProject, testApi, withThread } from "../../test-support/api-kit.ts";
import { probeError } from "../../protocol/http.ts";
import { tailnet, type WhoisAnswer } from "../../test-support/people.ts";
import { parseWhois, type TailnetCaller } from "../../node-base/tailscaled.ts";
import { desiredPhase } from "../reconcile.ts";
import { peopleOf } from "../people.ts";
import type { ImageId, Person, ThreadId } from "../../ids.ts";
import type { Thread } from "../thread-store.ts";

const alice = tailnet.alice.UserProfile!.LoginName as Person;
const people = peopleOf({ [alice]: "admin", [tailnet.bob.UserProfile!.LoginName]: "engineer" });
const as = (a: WhoisAnswer): TailnetCaller => ({ id: a.Node.StableID, ...parseWhois(a).identity });

/** A shared install where alice started a thread an hour ago that nobody has touched since, so its pylon is to be paused. */
async function idleThreadOfAlice(t: Parameters<typeof testApi>[0]) {
  const hourAgo = Date.now() - 60 * 60_000;
  let caller = as(tailnet.alice);
  const s = await testApi(t, { people, allowed: new Set(), whois: async () => caller, clock: () => hourAgo });
  await s.call("POST", "/v1/projects", sharedProject);
  await s.call("POST", "/v1/images", image);
  s.registry.images.setCurrentImage(image.id as ImageId);
  const thread = (await s.call("POST", "/v1/threads", { project: "acme", title: "alice's" })).body as Thread;
  const facts = () => s.registry.threads.thread(thread.id as ThreadId)!;
  assert.equal(desiredPhase(facts(), Date.now()), "paused", "the pylon of an idle thread is to be paused");
  s.woken.length = 0;
  return { ...s, thread, hourAgo, facts, as(who: WhoisAnswer) { caller = as(who); } };
}

const reads = ["changes", "files", "diff", "files/content?path=README.md"];

for (const read of reads) {
  test(`on a shared install bob's GET /v1/threads/{thread}/${read} of alice's paused pylon is refused and leaves it paused, and alice's wakes it`, async (t) => {
    const s = await idleThreadOfAlice(t);
    s.as(tailnet.bob);
    const refused = await s.call("GET", `/v1/threads/${s.thread.id}/${read}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, new RegExp(`is not running, and only ${alice}'s requests wake it`));
    assert.equal(refused.body.retryable, false, "asking again wakes nothing, so a client does not wait on it");
    assert.deepEqual(s.woken, [], "bob's read asked the planner to wake alice's pylon");
    assert.equal(s.facts().lastHumanActivityAt, s.hourAgo, "bob's read counted as human activity on alice's thread");
    assert.equal(desiredPhase(s.facts(), Date.now()), "paused");

    s.as(tailnet.alice);
    await s.call("GET", `/v1/threads/${s.thread.id}/${read}`);
    assert.deepEqual(s.woken, ["rj-firebat"], "alice's own read wakes her pylon");
    assert.equal(desiredPhase(s.facts(), Date.now()), "running");
  });
}

test("on a shared install bob reads alice's running pylon's checkout without counting as activity on her thread", async (t) => {
  const s = await idleThreadOfAlice(t);
  const { repo } = await localCheckout(t, s);
  await writeFile(join(repo, "src", "app.ts"), "export const a = 2;\n");
  observeRunning(s, {});
  s.as(tailnet.bob);
  const changes = await s.call("GET", `/v1/threads/${s.thread.id}/changes`);
  assert.equal(changes.status, 200, JSON.stringify(changes.body));
  assert.deepEqual(changes.body.files.map((f: { path: string }) => f.path), ["src/app.ts"]);
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}/diff?path=src%2Fapp.ts`)).status, 200);
  assert.equal((await s.raw(`/v1/threads/${s.thread.id}/files/content?path=src%2Fapp.ts`)).body.toString(), "export const a = 2;\n");
  assert.deepEqual(s.woken, []);
  assert.equal(s.facts().lastHumanActivityAt, s.hourAgo);
});

test("on a shared install bob's visit to alice's thread is refused as activity and leaves her paused pylon paused, and alice's visit wakes it", async (t) => {
  const s = await idleThreadOfAlice(t);
  s.as(tailnet.bob);
  const page = (await s.raw(`/threads/${s.thread.id}`)).body.toString();
  assert.doesNotMatch(page, /data-activity=/, "bob's page counts no visit");
  assert.match(page, /data-wakes="false"/, "bob's page offers no wake");
  const opened = await s.call("POST", `/v1/threads/${s.thread.id}/activity`, { kind: "human" });
  assert.equal(opened.status, 403);
  assert.match(opened.body.error, new RegExp(`is ${alice}'s, so only ${alice} may record activity on a thread`));
  assert.deepEqual(s.woken, []);
  assert.equal(s.facts().lastHumanActivityAt, s.hourAgo);
  assert.equal(desiredPhase(s.facts(), Date.now()), "paused", "bob's visit leaves alice's pylon paused");

  s.as(tailnet.alice);
  const own = (await s.raw(`/threads/${s.thread.id}`)).body.toString();
  assert.match(own, new RegExp(`<main[^>]* data-activity="${s.thread.id}"`));
  assert.match(own, /data-wakes="true"/);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/activity`, { kind: "human" })).status, 204);
  assert.deepEqual(s.woken, ["rj-firebat"]);
  assert.equal(desiredPhase(s.facts(), Date.now()), "running");
});

test("on a shared install bob's read of a pylon that pauses while he reads is refused without a wake, and no client waits on it", async (t) => {
  const s = await idleThreadOfAlice(t);
  observeRunning(s, {});
  s.probePipes(async () => { throw probeError("not-running", "the pylon paused"); });
  s.as(tailnet.bob);
  const refused = await s.call("GET", `/v1/threads/${s.thread.id}/changes`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, new RegExp(`only ${alice}'s requests wake it`));
  assert.equal(refused.body.retryable, false);
  assert.deepEqual(s.woken, []);
  assert.equal(s.facts().lastHumanActivityAt, s.hourAgo);
});

test("on a solo install the control node's visit, which is no person's, still keeps the pylon awake", async (t) => {
  const s = await withThread(t, { clock: () => Date.now() - 60 * 60_000 });
  s.woken.length = 0;
  s.callAs(deployment.self);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/activity`, { kind: "human" })).status, 204);
  assert.deepEqual(s.woken, ["rj-firebat"]);
  assert.equal(desiredPhase(s.registry.threads.thread(s.thread.id as ThreadId)!, Date.now()), "running");
});
