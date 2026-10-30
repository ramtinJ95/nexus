/** Review and landing routes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewLoop } from "./review.ts";
import type { TailnetNodeId } from "../ids.ts";
import { laptop, phone, project, testApi, withThread, deployment } from "./api-test-kit.ts";

test("a review needs the GitHub token's loop, and landing, at its start or later, needs a deployer", async (t) => {
  const off = await withThread(t);
  const refused = await off.call("POST", `/v1/threads/${off.thread.id}/review`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /github.tokenFile/);
  const asked: unknown[] = [];
  const reviews = {
    async start(builder: string, request: unknown) { asked.push(["start", builder, request]); return { id: "rv-1" }; },
    land(builder: string, by: string, head?: string) { asked.push(["land", builder, by, head]); return { id: "rv-1" }; },
  } as never as ReviewLoop;
  const s = await withThread(t, { reviews, deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop, "nFIREBAT" as TailnetNodeId]), keys: {} } });
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, { rounds: 6 })).status, 400, "a review runs at most 5 rounds");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, { pr: 7, rounds: 5 })).status, 201);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, { land: true })).status, 201);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/land`)).status, 200);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/land`, { head: "a".repeat(40) })).status, 200, "the dashboard names the commit it confirmed");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/land`, { head: "main" })).status, 400);
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, { land: true })).status, 403, "the control node itself never lands, even listed as a deployer");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/land`)).status, 403);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, {})).status, 403, "the control node never starts a review either, since a thread never drives another");
  s.callAs(phone);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, {})).status, 201, "a review that stops at approval needs no deploy right");
  assert.deepEqual(asked, [
    ["start", s.thread.id, { pr: 7, rounds: 5, land: null }],
    ["start", s.thread.id, { pr: undefined, rounds: undefined, land: laptop }],
    ["land", s.thread.id, laptop, undefined],
    ["land", s.thread.id, laptop, "a".repeat(40)],
    ["start", s.thread.id, { pr: undefined, rounds: undefined, land: null }],
  ]);
});

test("only a project edit turns on reviews of its own, landing needs a deployer, and the project records who turned it on", async (t) => {
  const s = await testApi(t, { deployment });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", autoReview: { land: true, enabledBy: laptop } })).status, 400, "a new project cannot name who turned it on");
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual(await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: false } }), { status: 403, body: { error: "caller may not edit a project: only a person may, never the control plane, infrastructure nodes or pylons" } });
  s.callAs(phone);
  assert.deepEqual(await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: true } }), { status: 403, body: { error: "caller may not land a pull request: landing deploys, and only deployers may, never infrastructure nodes or pylons" } });
  const reviewing = await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: false } });
  assert.deepEqual(reviewing.body.autoReview, { land: false, enabledBy: phone }, "reviewing alone lands nothing, so it needs no deployer");
  s.callAs(laptop);
  assert.deepEqual((await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: true } })).body.autoReview, { land: true, enabledBy: laptop });
  assert.deepEqual((await s.call("PATCH", "/v1/projects/acme", { defaultBranch: "trunk" })).body.autoReview, { land: true, enabledBy: laptop }, "another edit keeps it");
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: true, enabledBy: "nPHONE" } })).status, 400);
  const off = await s.call("PATCH", "/v1/projects/acme", { autoReview: null });
  assert.equal(off.body.autoReview, undefined);
  assert.equal((await s.call("GET", "/v1/projects")).body.find((p: { id: string }) => p.id === "acme").autoReview, undefined);
});

test("a deployer's land names the holds it waives at the commit it confirmed, and the review loop decides whether they may be waived", async (t) => {
  const held = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  const head = "a".repeat(40);
  const landed: unknown[][] = [];
  const reviews = { land(...args: unknown[]) { landed.push(args); return { id: "rv-1" }; } } as never as ReviewLoop;
  const s = await withThread(t, { reviews, deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {} } });
  const land = (body: unknown) => s.call("POST", `/v1/threads/${s.thread.id}/land`, body);

  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await land({ head, waive: [held] })).status, 403, "only a deployer waives");
  assert.deepEqual(landed, [], "a refused waiver never reaches the review loop");
  s.callAs(laptop);
  assert.equal((await land({ waive: [held] })).status, 400, "a waiver names the commit it confirmed");
  assert.equal((await land({ head, waive: [] })).status, 400, "a waiver names at least one hold");
  assert.equal((await land({ head, waive: [held] })).status, 200);
  assert.equal((await land({ head })).status, 200);
  assert.deepEqual(landed, [[s.thread.id, laptop, head, [held]], [s.thread.id, laptop, head, undefined]]);
});
