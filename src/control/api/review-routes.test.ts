import { test } from "node:test";
import assert from "node:assert/strict";
import { image, project, testApi } from "../../test-support/api-kit.ts";
import { tailnet, type WhoisAnswer } from "../../test-support/people.ts";
import { parseWhois, type TailnetCaller } from "../../node-base/tailscaled.ts";
import type { ImageId, ThreadId } from "../../ids.ts";
import type { Question } from "../questions.ts";
import type { ReviewLoop } from "../review.ts";
import { peopleOf } from "../people.ts";
import { Refusal } from "../refusal.ts";

const people = peopleOf({ [tailnet.alice.UserProfile!.LoginName]: "admin", [tailnet.bob.UserProfile!.LoginName]: "engineer" });
const as = (a: WhoisAnswer): TailnetCaller => ({ id: a.Node.StableID, ...parseWhois(a).identity });
const landingOff = { status: 403, body: { error: "Nexus never merges on a shared install, so it lands no pull request. An engineer merges it on GitHub", code: "landing-off", retryable: false } };

/** A shared install whose review loop records what reaches it, with a thread for alice, the admin, and one for bob, the engineer. */
async function shared(t: Parameters<typeof testApi>[0]) {
  const reached: string[] = [];
  const reviews = {
    start: async (_: ThreadId, request: { land: string | null }) => { reached.push(`start land=${request.land}`); throw new Refusal("conflict", "the review loop took it"); },
    land: () => { reached.push("land"); return {}; },
    answerHolds: (question: Question, option: string, by: string) => { reached.push(`answer ${option}`); return { ...question, answer: { option, by, at: 1 } }; },
  } as never as ReviewLoop;
  let caller = as(tailnet.alice);
  const s = await testApi(t, { people, allowed: new Set(), whois: async () => caller, reviews });
  await s.call("POST", "/v1/projects", project);
  await s.call("POST", "/v1/images", image);
  s.registry.images.setCurrentImage(image.id as ImageId);
  const alice = (await s.call("POST", "/v1/threads", { project: "acme", title: "alice's" })).body.id as ThreadId;
  caller = as(tailnet.bob);
  const bob = (await s.call("POST", "/v1/threads", { project: "acme", title: "bob's" })).body.id as ThreadId;
  const callAs = (who: "alice" | "bob") => { caller = as(who === "alice" ? tailnet.alice : tailnet.bob); };
  return { s, reached, threads: { alice, bob }, callAs };
}

test("on a shared install a review start that asks to land is refused with landing-off for the admin and the engineer, and one that does not starts", async (t) => {
  const { s, reached, threads, callAs } = await shared(t);
  for (const who of ["alice", "bob"] as const) {
    callAs(who);
    assert.deepEqual(await s.call("POST", `/v1/threads/${threads[who]}/review`, { land: true }), landingOff, `${who}'s review --land`);
  }
  assert.deepEqual((await s.call("POST", `/v1/threads/${threads.bob}/review`, {})).body.error, "the review loop took it");
  assert.deepEqual(reached, ["start land=null"]);
});

test("on a shared install nexus land is refused with landing-off for the admin and the engineer, and never tells the engineer to run install.sh --admit", async (t) => {
  const { s, reached, threads, callAs } = await shared(t);
  for (const who of ["alice", "bob"] as const) {
    callAs(who);
    const refused = await s.call("POST", `/v1/threads/${threads[who]}/land`, {});
    assert.deepEqual(refused, landingOff, `${who}'s land`);
    assert.doesNotMatch(refused.body.error, /--admit/);
  }
  assert.deepEqual(reached, [], "no landing reached the review loop");
});

test("on a shared install the Land answer to a holds question is refused with landing-off, and Leave it is still the admin's to give", async (t) => {
  const { s, reached, threads, callAs } = await shared(t);
  s.registry.questions.askQuestion({
    kind: "holds", id: "holds-rv-1-a", thread: threads.bob, text: "Land pull request #7?", options: ["Land", "Leave it"], reserved: "auth", answerer: "deployer", askedAt: 1,
    holds: { review: "rv-1", head: "a".repeat(40), base: "main", holds: [{ code: "reserved-path:auth", text: "Always needs the person: changes to login or auth." }] },
  });
  for (const who of ["alice", "bob"] as const) {
    callAs(who);
    assert.deepEqual(await s.call("POST", "/v1/questions/holds-rv-1-a/answer", { option: "Land" }), landingOff, `${who}'s Land`);
  }
  callAs("alice");
  assert.equal((await s.call("POST", "/v1/questions/holds-rv-1-a/answer", { option: "Leave it" })).status, 200);
  assert.deepEqual(reached, ["answer Leave it"]);
});

test("on a shared install the admin's switch of a project to land or yolo is refused with landing-off, and review is taken", async (t) => {
  const { s, callAs } = await shared(t);
  callAs("alice");
  for (const mode of ["land", "yolo"] as const) {
    assert.deepEqual(await s.call("PATCH", "/v1/projects/acme", { autoReview: { mode } }), landingOff, mode);
    assert.deepEqual(await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: true } }), landingOff, "an older CLI's land");
  }
  assert.equal(s.registry.projects.project(project.id as never)!.autoReview ?? null, null);
  const review = await s.call("PATCH", "/v1/projects/acme", { autoReview: { mode: "review" } });
  assert.deepEqual([review.status, review.body.autoReview.mode], [200, "review"]);
});
