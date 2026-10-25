import assert from "node:assert/strict";
import { test } from "node:test";
import { planDeploy, type DeployInput } from "./plan.ts";

const commit = "a".repeat(40);
const input: DeployInput = {
  desired: { commit, requestedBy: "nMac", requestedAt: 1 }, role: "control",
  current: { commit: "b".repeat(40), healthy: true }, control: { commit, healthy: true },
  attempt: null, turnRunning: false, drainStartedAt: null, drainTimeoutMs: 60_000, now: 100_000,
};

test("release planning is idle without a desired release, and converges on healthy observations", () => {
  assert.deepEqual(planDeploy({ ...input, desired: null }), { kind: "idle" });
  assert.deepEqual(planDeploy(input), { kind: "install", commit });
  assert.deepEqual(planDeploy({ ...input, current: { commit, healthy: true } }), { kind: "healthy" });
  assert.deepEqual(planDeploy({ ...input, current: { commit, healthy: false } }), { kind: "install", commit });
});

test("probes require the desired control release to be healthy", () => {
  for (const control of [{ commit, healthy: false }, { commit: null, healthy: true }]) {
    assert.deepEqual(planDeploy({ ...input, role: "probe", control }), { kind: "wait", reason: "control-first" });
  }
  assert.deepEqual(planDeploy({ ...input, role: "probe", turnRunning: true }), { kind: "install", commit });
});

test("control drain refuses a running turn at the deadline, but idle wins at the deadline", () => {
  assert.deepEqual(planDeploy({ ...input, turnRunning: true }), { kind: "wait", reason: "idle" });
  assert.deepEqual(planDeploy({ ...input, turnRunning: true, drainStartedAt: 40_001 }), { kind: "wait", reason: "idle" });
  assert.deepEqual(planDeploy({ ...input, turnRunning: true, drainStartedAt: 40_000 }), { kind: "stop", reason: "agent turn still running at drain timeout" });
  assert.deepEqual(planDeploy({ ...input, drainStartedAt: 40_000 }), { kind: "install", commit });
});

test("interrupted installs recover before any new desired release; failures do not loop", () => {
  assert.deepEqual(planDeploy({ ...input, desired: null, attempt: { commit, state: "installing", reason: null } }), { kind: "recover" });
  for (const state of ["failed", "rolled-back"] as const) {
    assert.deepEqual(planDeploy({ ...input, attempt: { commit, state, reason: "bad build" } }), { kind: "stop", reason: "bad build" });
    assert.deepEqual(planDeploy({ ...input, attempt: { commit: "c".repeat(40), state, reason: "bad build" } }), { kind: "install", commit });
  }
});
