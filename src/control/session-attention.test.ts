import { test, type TestContext } from "node:test";
import { claudeWorkerAt } from "../test-support/registry-kit.ts";
import assert from "node:assert/strict";
import type { Thread } from "./thread-store.ts";
import type { ThreadRow } from "./wire.ts";
import type { ImageId, NodeName, TailnetNodeId } from "../ids.ts";
import { testImage } from "../test-support/kit.ts";
import { testApi } from "../test-support/api-kit.ts";

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const image = testImage();

/** A Claude worker thread whose launch opened session builder, and started it unless `failed` says why it failed. */
async function claudeThread(t: TestContext, failed?: string) {
  const s = await testApi(t, { allowed: new Set([laptop]), probes: new Map() });
  assert.equal((await s.call("POST", "/v1/projects", {
    id: "acme", repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  })).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const res = await s.call("POST", "/v1/threads", { project: "acme", title: "Fix checkout", claude: "Fix checkout" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const thread = res.body as Thread;
  claudeWorkerAt(s.registry, thread.id, failed === undefined ? "started" : "failed", { session: "builder", ...failed === undefined ? {} : { message: failed } });
  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended" | "session.ended", session: string) =>
    s.registry.threads.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session, at: Date.now() + sequence } });
  const row = async () => ((await s.call("GET", "/v1/threads")).body as ThreadRow[]).find((r) => r.id === thread.id)!;
  const attention = async () => (await row()).attention;
  return { report, attention, row, registry: s.registry, thread };
}

test("a side session that finishes never makes a thread with a working builder report a reply", async (t) => {
  const { report, attention } = await claudeThread(t);
  report("session.turn-started", "builder");
  report("session.turn-started", "pi-side");
  report("session.turn-ended", "pi-side");
  assert.equal(await attention(), "working", "the builder still works, and nothing waits on the person");
});

test("the builder session's turn ending is a reply", async (t) => {
  const { report, attention } = await claudeThread(t);
  report("session.turn-started", "builder");
  report("session.turn-ended", "builder");
  assert.equal(await attention(), "reply");
});

test("the builder's turn ending after a side session ended is a reply", async (t) => {
  const { report, attention } = await claudeThread(t);
  report("session.turn-started", "builder");
  report("session.turn-started", "pi-side");
  report("session.turn-ended", "pi-side");
  report("session.turn-ended", "builder");
  assert.equal(await attention(), "reply");
});

test("a new session in the worker's pane after /clear replies when its turn ends", async (t) => {
  const { report, attention, registry, thread } = await claudeThread(t);
  report("session.turn-started", "builder");
  report("session.turn-ended", "builder");
  registry.threads.markSeen(thread.id, false);
  assert.equal(await attention(), null, "the person saw the reply");
  report("session.ended", "builder");
  report("session.turn-started", "cleared");
  report("session.turn-ended", "cleared");
  assert.equal(await attention(), "reply");
});

test("a Claude run by hand after a failed launch replies when its turn ends", async (t) => {
  const { report, row, registry, thread } = await claudeThread(t, "claude exited");
  report("session.turn-started", "by-hand");
  report("session.turn-ended", "by-hand");
  assert.notEqual((await row()).lastReplyAt, null);
});
