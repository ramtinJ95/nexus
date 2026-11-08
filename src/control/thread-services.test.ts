import { test } from "node:test";
import assert from "node:assert/strict";
import { threadServices } from "./thread-services.ts";
import { turnGate } from "./drain.ts";
import { fakeHarness } from "../test-support/fake-harness.ts";
import { testRegistry } from "../test-support/registry-kit.ts";

const options = { mirror: { setupInputs: () => Promise.reject(new Error("a scratch project has no remote")) }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, wake: () => {}, gate: turnGate(() => false) };

test("without a GitHub token or planning, the queue, pipeline and planning have nothing to poll", async (t) => {
  const services = threadServices({ registry: testRegistry(t), harness: fakeHarness().harness, ...options, queue: false, planning: null });
  t.after(() => services.close());
  assert.deepEqual(services.polls, [null, null, null]);
});

test("with them, each of the queue, pipeline and planning polls on its own", async (t) => {
  const services = threadServices({ registry: testRegistry(t), harness: fakeHarness().harness, ...options, queue: true, planning: { replies: async () => [] } });
  t.after(() => services.close());
  assert.deepEqual(services.polls, [services.api.queue, services.api.pipeline, services.api.planning]);
  assert.ok(services.polls.every((s) => s !== null));
});
