/** Image routes: recording an image, and a deployer's builds and rollouts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startImageRollout } from "./image-rollout.ts";
import { imageIdOf, type ImageRecipe } from "../images.ts";
import { parseProbeConfig } from "../probe/config.ts";
import { testCapacity, testObservation } from "../test-kit.ts";
import type { ImageId, TailnetNodeId } from "../ids.ts";
import { node, laptop, project, image, testApi, deployment } from "./api-test-kit.ts";

test("a thread cannot start before an image is current", async (t) => {
  const s = await testApi(t);
  await s.call("POST", "/v1/projects", project);
  const res = await s.call("POST", "/v1/threads", { project: "acme", title: "x" });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /no image is current/);
  assert.deepEqual((await s.call("GET", "/v1/images/current")).body, { current: null, previous: null });
  assert.equal((await s.call("POST", "/v1/threads", { project: "nope", title: "x" })).status, 404);
});

test("an image is recorded only with every pin, gh included, each in its pinned format", async (t) => {
  const s = await testApi(t);
  const { gh: _, ...withoutGh } = image.pins;
  assert.equal((await s.call("POST", "/v1/images", { ...image, pins: withoutGh })).status, 400);
  assert.equal((await s.call("POST", "/v1/images", { ...image, pins: { ...image.pins, ghSha256: "not-a-digest" } })).status, 400);
  assert.equal((await s.call("POST", "/v1/images", { ...image, pins: { ...image.pins, extra: "1" } })).status, 400);
  assert.deepEqual((await s.call("GET", "/v1/images")).body.images, [], "a refused image is not recorded");
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  assert.deepEqual((await s.call("GET", "/v1/images")).body.images, [{ ...image, release: null, nodes: [] }], "an image recorded by hand comes from no known release");
});

test("an image is recorded exactly when a probe's Docker backend can name it", async (t) => {
  const s = await testApi(t);
  const probe = JSON.parse(await readFile(new URL("../../deploy/probe.example.json", import.meta.url), "utf8"));
  const parses = (parse: () => unknown) => { try { parse(); return true; } catch { return false; } };
  for (const id of ["img-0123456789ab", "img-custom", "img-Custom", "img-", "img-a.b", `img-${"0".repeat(41)}`]) {
    const named = parses(() => parseProbeConfig(JSON.stringify({ ...probe, backend: { kind: "docker", images: { [id]: "nexus-pylon:test" } } })));
    const recorded = (await s.call("POST", "/v1/images", { ...image, id })).status === 201;
    assert.equal(recorded, named, id);
  }
  assert.deepEqual((await s.call("GET", "/v1/images")).body.images.map((i: { id: string }) => i.id).sort(), ["img-0123456789ab", "img-custom"]);
});

test("only a deployer may build, roll out or roll back an image, never the control node itself", async (t) => {
  const routes = [["/v1/images/build", {}], ["/v1/images/rollout", { image: image.id }], ["/v1/images/rollback", {}]] as const;
  const off = await testApi(t);
  for (const [path, body] of routes) assert.deepEqual(await off.call("POST", path, body), { status: 403, body: { error: "caller may not build, roll out or roll back an image: only deployers may, never infrastructure nodes or pylons" } });
  const on = await testApi(t, { deployment });
  on.callAs("nFIREBAT" as TailnetNodeId);
  for (const [path, body] of routes) assert.equal((await on.call("POST", path, body)).status, 403, `the control node may not POST ${path}`);
  on.callAs(laptop);
  for (const [path, body] of routes) assert.deepEqual(await on.call("POST", path, body), { status: 409, body: { error: "image builds are not configured" } });
});

test("a deployer's image operations answer 200 once done and 202 while running, and the image routes show each image, its nodes and the operation", async (t) => {
  const recipe: ImageRecipe = { files: [{ path: "Dockerfile", mode: 0o644, content: "FROM debian\n" }], pins: image.pins };
  const built = { ...image, id: imageIdOf(recipe), builtAt: "2027-02-01T00:00:00Z" };
  const noJobs = () => assert.fail("no job is needed");
  const s = await testApi(t, {
    deployment,
    images: (registry) => startImageRollout({ registry, probes: new Map([[node, { submit: noJobs, job: noJobs, manifest: async (id) => registry.image(id as ImageId) ?? null }]]), buildNode: node, recipe: async () => recipe, release: null, intervalMs: 600_000, log: () => {} }),
  });
  for (const manifest of [image, built]) assert.equal((await s.call("POST", "/v1/images", manifest)).status, 201);
  s.registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  s.registry.ingested(testObservation(node, { observedAt: "2027-01-01T00:01:00Z", artifacts: [image.id as ImageId] }), []);
  const entries = [{ ...built, release: null, nodes: [] }, { ...image, release: null, nodes: [node] }];
  assert.deepEqual((await s.call("GET", "/v1/images")).body, { current: null, previous: null, images: entries, operation: null }, "newest build first");

  const build = await s.call("POST", "/v1/images/build", {});
  assert.equal(build.status, 200, "the recipe's image is recorded already");
  assert.deepEqual([build.body.kind, build.body.image, build.body.state, build.body.requestedBy], ["build", built.id, "done", laptop]);
  const rollout = await s.call("POST", "/v1/images/rollout", { image: image.id });
  assert.equal(rollout.status, 202);
  assert.deepEqual([rollout.body.kind, rollout.body.image, rollout.body.state], ["rollout", image.id, "running"]);
  await s.images!.wake();
  assert.deepEqual((await s.call("GET", "/v1/images/current")).body, { current: entries[1], previous: null });
  const view = (await s.call("GET", "/v1/images")).body;
  assert.deepEqual([view.current, view.operation.kind, view.operation.state], [image.id, "rollout", "done"]);

  assert.equal((await s.call("POST", "/v1/images/rollout", { image: "img-ffffffffffff" })).status, 404);
  assert.equal((await s.call("POST", "/v1/images/rollout", { image: "../etc" })).status, 400);
  assert.equal((await s.call("POST", "/v1/images/rollback", {})).status, 409, "no image was current before this one");
  assert.equal((await s.call("PUT", "/v1/images/current", { image: built.id })).status, 405, "no route makes an image current without a rollout");
});
