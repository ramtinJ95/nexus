/**
 * Team-mode design, points 1, 2 and 3: `startedBy` becomes the principal, only a thread's owner acts on it, and a
 * thread spends its owner's credentials and opens its pull request as its owner.
 *
 * The design's owner rule lists what is done to a thread. A pipeline item is not a thread, and the thread it becomes
 * is started as whoever added the item (`addedBy` -> queue.add's caller -> the thread's `startedBy`,
 * src/control/pipeline.ts line 204), whoever approves it. So with `startedBy` as the principal, one engineer's
 * approval starts a thread that is another engineer's: it runs on her model subscription and pushes with her GitHub
 * token, at a moment she did not choose and with a brief she may have meant to edit or cancel.
 *
 * Real here: the API, the pipeline and the queue (api-kit). The two callers are two tailnet identities, as two
 * engineers are.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PipelineItem } from "../src/control/pipeline.ts";
import type { ImageId } from "../src/ids.ts";
import { deployment, image, laptop, phone, project, testApi } from "../src/test-support/api-kit.ts";

test("an item one engineer added becomes her thread when another engineer approves it", async (t) => {
  const s = await testApi(t, { pipeline: true, deployment });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { pipeline: { autoStart: false } })).status, 200);

  s.callAs(laptop); // Alice
  const added = await s.call("POST", "/v1/items", { project: "acme", title: "Rewrite billing", claude: "Rewrite the billing module and open a pull request." });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const item = added.body as PipelineItem;

  s.callAs(phone); // Bob
  const approved = await s.call("POST", `/v1/items/${item.id}/approve`, {});
  const after = approved.body as PipelineItem;
  const queued = after.thread === null || after.thread === undefined ? undefined : s.registry.queue.queuedThread(after.thread);
  console.log(`item ${item.id}: addedBy=${item.addedBy}`);
  console.log(`approve as ${phone}: HTTP ${approved.status}, approved.by=${after.approved?.by}, thread=${after.thread}`);
  console.log(`the thread it queued: startedBy=${queued?.startedBy}`);

  assert.ok(approved.status === 403 || queued?.startedBy === phone,
    `Bob's approval must be refused, or the thread must be Bob's: it was accepted (HTTP ${approved.status}) and queued a thread startedBy ${queued?.startedBy}, which is Alice`);
});
