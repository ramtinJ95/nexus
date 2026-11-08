import { test } from "node:test";
import assert from "node:assert/strict";
import { processStream } from "../process-stream.ts";
import { probeError } from "../protocol/http.ts";
import { BodyTooLarge } from "../node-base/request-body.ts";
import { withThread } from "../test-support/api-kit.ts";
import { errorReply } from "./api/server.ts";
import { DeployDraining } from "./drain.ts";
import { HttpError, type RefusalStatus } from "./http-error.ts";
import { Refusal, type RefusalKind } from "./refusal.ts";

/** Each kind of refusal with the status the API answered it with before refusals had kinds. */
const statuses: Readonly<Record<RefusalKind, RefusalStatus>> = {
  invalid: 400, forbidden: 403, missing: 404, method: 405, conflict: 409, "too-large": 413, unsupported: 415,
  unprocessable: 422, upstream: 502, unavailable: 503, timeout: 504,
};

test("every refusal kind, and each error the API answered before kinds, keeps the status it had", () => {
  for (const [kind, status] of Object.entries(statuses) as [RefusalKind, RefusalStatus][]) {
    assert.deepEqual(errorReply(new Refusal(kind, "no")), { status, body: { error: "no", code: null, retryable: false } }, kind);
    assert.deepEqual(errorReply(new HttpError(status, "no")), { status, body: { error: "no", code: null, retryable: false } }, `HttpError ${status}`);
  }
  const cases: [string, unknown, number, string | null, boolean][] = [
    ["a drain", new DeployDraining(), 409, "draining", true],
    ["a body over the limit", new BodyTooLarge(10), 413, null, false],
    ["an unreachable probe", probeError("unreachable", "down"), 503, "probe-unreachable", false],
    ["a stopped pylon", probeError("not-running", "stopped"), 409, "not-running", true],
    ["a probe refusing the control plane", probeError("forbidden", "refused"), 502, "probe-forbidden", false],
    ["a coded refusal", new HttpError(409, "Claude is not ready", "not-ready"), 409, "not-ready", true],
    ["a refusal waiting for a person", new HttpError(409, "Claude waits at a prompt", "blocked"), 409, "blocked", false],
    ["any other error", new Error("disk full"), 500, null, false],
    ["an error whose code is no probe's", Object.assign(new Error("gone"), { code: "ENOENT" }), 500, null, false],
  ];
  for (const [what, err, status, code, retryable] of cases) {
    assert.deepEqual(errorReply(err), { status, body: { error: (err as Error).message, code, retryable } }, what);
  }
});

test("each refusal of a checkout read keeps the status it had", async (t) => {
  const s = await withThread(t);
  const old = { missing: 404, outside: 400, kind: 400, large: 413, "no-base": 422, slow: 504, busy: 503, long: 400 };
  for (const [refused, status] of Object.entries(old)) {
    const reply = JSON.stringify({ refused, message: `refused ${refused}` });
    s.probePipes(async () => processStream("sh", ["-c", `printf '%s' '${reply}'; exit 3`], () => {}));
    const read = await s.call("GET", `/v1/threads/${s.thread.id}/files?path=src`);
    assert.deepEqual([read.status, read.body], [status, { error: `refused ${refused}`, code: null, retryable: false }], refused);
  }
});
