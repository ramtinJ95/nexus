/**
 * Design point 2: "Any user may read any thread (conversation, diffs, files, previews). Only the thread's owner may
 * act on it." A thread's files and diffs are not stored on the control plane. Each read runs a helper in the pylon,
 * so the read route records human activity on the thread and wakes its pylon (src/control/api/pylon-access.ts,
 * inPylon). This asserts what the design needs of a read by somebody who is not the owner: it changes nothing about
 * the owner's thread. It fails on the current code.
 *
 *   node --test interrogate/read-wakes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { phone, withThread } from "../src/test-support/api-kit.ts";
import { desiredPhase, idlePolicy } from "../src/control/reconcile.ts";

for (const read of ["changes", "files", "diff", "files/content?path=README.md"]) {
  test(`GET /v1/threads/{thread}/${read} by an engineer who does not own the thread leaves the owner's paused pylon alone`, async (t) => {
    // alice started it an hour ago and nobody has touched it since: it is idle and its pylon is to be paused.
    const hourAgo = Date.now() - 60 * 60_000;
    const s = await withThread(t, { clock: () => hourAgo });
    const id = s.thread.id;
    const facts = () => s.registry.threads.thread(id)!;
    assert.equal(desiredPhase(facts() as never, Date.now()), "paused", "the pylon of an idle thread is to be paused");
    s.woken.length = 0;

    // bob's phone, another allowed person's device, reads it.
    s.callAs(phone);
    const reply = await s.call("GET", `/v1/threads/${id}/${read}`);
    console.log(`bob GET ${read} -> ${reply.status} ${JSON.stringify(reply.body).slice(0, 110)}`);
    console.log(`  node wakes asked for: ${JSON.stringify(s.woken)}; alice's thread lastHumanActivityAt moved by ${facts().lastHumanActivityAt - hourAgo} ms; `
      + `desired pylon phase is now ${desiredPhase(facts() as never, Date.now())} for the next ${idlePolicy.humanIdleMs / 60_000} minutes`);
    assert.deepEqual(s.woken, [], "a read by a non-owner asked the planner to wake the owner's pylon");
    assert.equal(facts().lastHumanActivityAt, hourAgo, "a read by a non-owner counted as human activity on the owner's thread");
  });
}
