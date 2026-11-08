import { test } from "node:test";
import assert from "node:assert/strict";
import { logOnce } from "./log-once.ts";

test("a failure is logged once while its key keeps failing the same way, and again once it fails another way or after it succeeded", () => {
  const logged: string[] = [];
  const failures = logOnce((message) => { logged.push(message); });
  failures.failed("a", "a: down");
  failures.failed("a", "a: down");
  failures.failed("b", "b: down");
  assert.deepEqual(logged, ["a: down", "b: down"], "each key logs its own");
  failures.failed("a", "a: refused");
  assert.deepEqual(logged.slice(2), ["a: refused"]);
  failures.ok("a");
  failures.failed("a", "a: refused");
  assert.deepEqual(logged.slice(3), ["a: refused"]);
});
