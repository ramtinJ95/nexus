import assert from "node:assert/strict";
import { test } from "node:test";
import { planDeploy, schemaStep, type DeployInput } from "./plan.ts";

const commit = "a".repeat(40);
const input: DeployInput = {
  desired: { commit, requestedBy: "nMac", requestedAt: 1 }, role: "control",
  current: { commit: "b".repeat(40), healthy: true }, control: { commit, healthy: true },
  attempts: [], turnRunning: false,
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

test("control drain waits while a turn runs, and installs only once idle", () => {
  assert.deepEqual(planDeploy({ ...input, turnRunning: true }), { kind: "wait", reason: "idle" });
  assert.deepEqual(planDeploy({ ...input, turnRunning: false }), { kind: "install", commit });
});

test("a failure recorded at the desired commit stops it before health or drain, and the report's reason comes first", () => {
  const healthy = { ...input, current: { commit, healthy: true } };
  for (const state of ["failed", "rolled-back"] as const) {
    const journal = { commit, state, reason: "candidate API failed" };
    const report = { commit, state, reason: "build failed" };
    assert.deepEqual(planDeploy({ ...healthy, attempts: [journal] }), { kind: "stop", reason: "candidate API failed" });
    assert.deepEqual(planDeploy({ ...input, turnRunning: true, attempts: [report] }), { kind: "stop", reason: report.reason });
    assert.deepEqual(planDeploy({ ...input, attempts: [report, journal] }), { kind: "stop", reason: report.reason });
    assert.deepEqual(planDeploy({ ...input, attempts: [{ commit, state, reason: null }] }), { kind: "stop", reason: state });
    assert.deepEqual(planDeploy({ ...input, attempts: [{ ...journal, commit: "c".repeat(40) }, { ...report, commit: null }] }), { kind: "install", commit });
    assert.deepEqual(planDeploy({ ...input, desired: null, attempts: [journal] }), { kind: "idle" });
  }
  for (const state of ["healthy", "installing", "waiting-for-idle"] as const) {
    assert.deepEqual(planDeploy({ ...input, attempts: [{ commit, state, reason: null }] }), { kind: "install", commit });
  }
});

test("legacy busy-turn quarantine permits the same commit and newer main, but never hides an install failure", () => {
  for (const reason of ["agent turn still running at drain timeout", "Error: agent turn still running at drain timeout"]) {
    const busy = { commit, state: "failed" as const, reason };
    assert.deepEqual(planDeploy({ ...input, attempts: [busy] }), { kind: "install", commit });
    assert.deepEqual(planDeploy({ ...input, attempts: [busy], desired: { ...input.desired!, commit: "c".repeat(40) } }), { kind: "install", commit: "c".repeat(40) });
    assert.deepEqual(planDeploy({ ...input, attempts: [busy, { ...busy, reason: "install failed" }] }), { kind: "stop", reason: "install failed" });
  }
});

test("a release migrates a registry behind its code, refuses one ahead of it or that it cannot name, and starts on one it matches or none", () => {
  assert.equal(schemaStep({ registry: 3, release: 4 }), "migrates");
  assert.equal(schemaStep({ registry: 4, release: 3 }), "refuses");
  assert.equal(schemaStep({ registry: 4, release: 4 }), "starts");
  assert.equal(schemaStep({ registry: null, release: 4 }), "starts", "the control plane has not made a registry yet");
  assert.equal(schemaStep({ registry: 4, release: null }), "refuses", "a release from before schema.ts");
});
