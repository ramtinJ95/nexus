/**
 * Team mode, point 2: any user may read any thread, only its owner may act on it. Opening a thread's page (and a
 * preview hit) records *human activity* on the thread through a route any allowed caller may call, and human activity
 * is what makes the planner want a paused pylon running for 20 minutes. So a reader's view boots the owner's pylon,
 * with the owner's secrets, and runs its resume hook and services, and the owner's thread shows the reader's
 * activity as its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { image, laptop, phone, project, testApi } from "../src/test-support/api-kit.ts";
import type { ImageId, ThreadId } from "../src/ids.ts";
import { desiredPhase } from "../src/control/reconcile.ts";

test("a reader's page open wakes the owner's paused pylon and is recorded as the owner's thread's human activity", async (t) => {
  let now = Date.now() - 3 * 60 * 60_000;
  const s = await testApi(t, { clock: () => now });
  s.callAs(laptop);
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "A's work" });
  const id = started.body.id as ThreadId;
  now = Date.now();
  const before = s.registry.threads.thread(id)!;
  console.log("owner:", before.startedBy, "desired before:", desiredPhase(before, now), "lastHumanActivityAt age (min):", Math.round((now - before.lastHumanActivityAt) / 60_000));
  s.woken.length = 0;

  s.callAs(phone); // another engineer, only reading
  const opened = await s.call("POST", `/v1/threads/${id}/activity`, { kind: "human" });
  const after = s.registry.threads.thread(id)!;
  console.log("reader POST /activity ->", opened.status, "| desired after:", desiredPhase(after, Date.now()), "| woken:", JSON.stringify(s.woken), "| lastHumanActivityAt age (min):", Math.round((Date.now() - after.lastHumanActivityAt) / 60_000));
});
