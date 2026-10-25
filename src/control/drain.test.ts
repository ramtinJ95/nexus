import assert from "node:assert/strict";
import { test } from "node:test";
import { DeployDraining, turnGate } from "./drain.ts";

test("drain counts submissions already entering, and refuses all new callers including background work", async () => {
  let draining = false;
  const gate = turnGate(() => draining);
  const held = Promise.withResolvers<void>();
  const entering = gate.run(() => held.promise);
  assert.equal(gate.busy(), true);
  draining = true;
  await assert.rejects(gate.run(async () => assert.fail("background submission entered")), DeployDraining);
  held.resolve();
  await entering;
  assert.equal(gate.busy(), false);
  await assert.rejects(gate.run(async () => assert.fail("new turn entered")), DeployDraining);
  draining = false;
  assert.equal(await gate.run(async () => "entered"), "entered");
  await assert.rejects(gate.run(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(gate.busy(), false);
});
