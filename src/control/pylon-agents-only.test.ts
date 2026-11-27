/**
 * On a shared install the control plane's own agent, the harness, runs no person's work: its one model login is the
 * install's, kept for failure judgments. The harness here is the real one, over pi-ai's openai provider and a credential
 * store of one login, with the provider's base URL moved to a local server that records what arrives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { judgmentsOnly, openHarnessHost, type HarnessHost, type HarnessHostOptions } from "./harness/host.ts";
import { harnessModels } from "./harness/credentials.ts";
import { peopleOf, type People } from "./people.ts";
import { image, project, sharedProject, testApi } from "../test-support/api-kit.ts";
import { tailnet, type WhoisAnswer } from "../test-support/people.ts";
import { parseWhois, type TailnetCaller } from "../node-base/tailscaled.ts";
import { tempDir } from "../test-support/kit.ts";
import { addThread, seedRegistry, testPr } from "../test-support/registry-kit.ts";
import { openRegistry } from "./registry.ts";
import { DatabaseSync } from "node:sqlite";
import { chatgptTokenGrant, ownerGrants } from "../protocol/secret-grants.ts";
import { heldSecrets } from "../protocol/observations.ts";
import type { ImageId, Person, PylonId, ThreadId } from "../ids.ts";
import { reviewLoop } from "./review.ts";
import { reviewerCaller } from "./agent-protocol.ts";
import { heard } from "./agent-conversation.ts";
import type { CheckRuns } from "./gate.ts";
import type { ChangedFile, PrSnapshot } from "./github.ts";

const alice = tailnet.alice.UserProfile!.LoginName as Person;
const bob = tailnet.bob.UserProfile!.LoginName as Person;
const shared = peopleOf({ [alice]: "admin", [bob]: "engineer" });
const answer = (a: WhoisAnswer): TailnetCaller => ({ id: a.Node.StableID, ...parseWhois(a).identity });

/**
 * The real harness on one login, and every model request it sent, by the marker each one's text carried. `open` opens
 * another host on the same storage. While `hold` is set, the upstream answers nothing, so a turn stays unfinished.
 */
async function recordedHarness(t: Parameters<typeof testApi>[0] & { after(fn: () => unknown): void }) {
  const scratch = await tempDir("pylon-agents-only-", t);
  const arrived: string[] = [];
  const control = { hold: false };
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      arrived.push(/(\w+)-says-hello/.exec(body)?.[1] ?? "?");
      if (control.hold) return;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "recorded by the test", type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  const stored = new Map<string, Credential>([["openai", { type: "api_key", key: "sk-THE-INSTALLATIONS-ONE-LOGIN" }]]);
  const store: CredentialStore = {
    read: async (provider) => stored.get(provider),
    list: async () => [...stored].map(([providerId, c]) => ({ providerId, type: c.type })),
    modify: async (provider, fn) => { const next = await fn(stored.get(provider)); if (next !== undefined) stored.set(provider, next); return stored.get(provider); },
    delete: async (provider) => { stored.delete(provider); },
  };
  const models = harnessModels({ store, deviceId: "00000000-0000-4000-8000-000000000000" });
  const real = openaiProvider();
  const moved = (list: readonly unknown[]) => list.map((m) => ({ ...(m as object), baseUrl }));
  models.setProvider({ ...real, baseUrl, getModels: () => moved(real.getModels()) as never, ...(real.getAllModels ? { getAllModels: () => moved(real.getAllModels!()) as never } : {}) });
  const modelId = (await models.getAvailable("openai"))[0]!.id;
  const open = async (more: Partial<Pick<HarnessHostOptions, "threads" | "judgmentsOnly">> = {}) => {
    const opened = await openHarnessHost({
      storagePath: join(scratch, "harness.sqlite"), models, model: { provider: "openai", modelId }, tailscaled: join(scratch, "none.sock"),
      locator: { awaitRunning: () => Promise.reject(new Error("no pylon in this test")) },
      threads: [], deleted: [], onActivity: () => {}, log: () => {}, ...more,
    });
    t.after(() => opened.close().catch(() => {}));
    return opened;
  };
  return { host: await open(), open, arrived, control };
}

/** The API as main.ts wires it for `people`, over `host`, with project acme and a current image. */
async function install(t: Parameters<typeof testApi>[0], host: HarnessHost, people: People) {
  let caller = answer(tailnet.alice);
  const s = await testApi(t, { ...people.shared ? { people, allowed: new Set(), whois: async () => caller } : {}, harness: people.shared ? judgmentsOnly(host) : host, queue: true, pipeline: true });
  await s.call("POST", "/v1/projects", people.shared ? sharedProject : project);
  await s.call("POST", "/v1/images", image);
  s.registry.images.setCurrentImage(image.id as ImageId);
  return { ...s, as(c: TailnetCaller) { caller = c; } };
}

const until = async (done: () => boolean) => { for (const deadline = Date.now() + 30_000; Date.now() < deadline && !done();) await new Promise((r) => setTimeout(r, 20)); };

test("a solo install's Nexus agent thread sends its model request from the control plane, which the recorder sees", async (t) => {
  const { host, arrived } = await recordedHarness(t);
  const s = await install(t, host, peopleOf(undefined));
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", message: "solo-says-hello" })).status, 201);
  await until(() => arrived.includes("solo"));
  assert.ok(arrived.includes("solo"), `the harness's request arrived: ${JSON.stringify(arrived)}`);
});

test("on a shared install two people's thread starts make no model request from the control plane", async (t) => {
  const { host, arrived } = await recordedHarness(t);
  const s = await install(t, host, shared);
  const refusals: { who: string; what: string; status: number; code: string | undefined; message: string }[] = [];
  for (const [who, as] of [["alice", tailnet.alice], ["bob", tailnet.bob]] as const) {
    s.as(answer(as));
    for (const [what, path, body] of [
      ["no agent named", "/v1/threads", { project: "acme", title: `${who}'s` }],
      ["a message brief", "/v1/threads", { project: "acme", message: `${who}-says-hello` }],
      ["a planning thread", "/v1/threads", { project: "acme", message: `${who}-says-hello`, planning: true }],
      ["a queued message brief", "/v1/threads", { project: "acme", message: `${who}-says-hello`, after: ["th-000000000000"] }],
      ["a pipeline item with a message brief", "/v1/items", { project: "acme", message: `${who}-says-hello` }],
    ] as const) {
      const r = await s.call("POST", path, body);
      refusals.push({ who, what, status: r.status, code: r.body.code, message: r.body.error });
    }
    const worker = await s.call("POST", "/v1/threads", { project: "acme", claude: `${who}-says-hello` });
    assert.equal(worker.status, 201, `${who}'s start with Claude Code: ${JSON.stringify(worker.body)}`);
    assert.equal(worker.body.conversationId, null, `${who}'s Claude worker has no harness conversation`);
  }
  for (const r of refusals) {
    assert.equal(r.status, 403, `${r.who}'s ${r.what}: ${r.message}`);
    assert.equal(r.code, "pylon-agents-only", `${r.who}'s ${r.what} names its reason`);
  }
  assert.match(refusals.find((r) => r.what === "no agent named")!.message, /The one agent a thread can run there is Claude Code, in its pylon on its owner's own login: name it with claude, as nexus start --claude does/);
  assert.match(refusals.find((r) => r.what === "a planning thread")!.message, /^A planning thread runs on the Nexus agent, so it cannot start\./);
  assert.deepEqual(s.registry.threads.storedThreads().map((th) => [th.owner, th.conversationId]), [[alice, null], [bob, null]], "only the two Claude workers started");
  assert.deepEqual(s.registry.queue.queuedThreads(), [], "no Nexus agent thread was queued");
  assert.deepEqual(s.registry.pipeline.items(), [], "no Nexus agent item was added");
  // The harness's own requests leave within milliseconds of a send, as the solo test shows.
  await new Promise((r) => setTimeout(r, 1_000));
  assert.deepEqual(arrived, [], "no model request left the control plane");
});

test("a shared install's harness refuses each turn of a thread's conversation and still runs a failure judgment", async (t) => {
  const { host, arrived } = await recordedHarness(t);
  const harness = judgmentsOnly(host);
  for (const [what, turn] of [
    ["startThread", () => harness.startThread({ threadId: "th-alice", pylonId: "pylon-th-alice" as PylonId })],
    ["send", () => harness.send("th-alice", "alice-says-hello", "m-alice", "followUp")],
    ["retry", () => harness.retry("th-alice")],
  ] as const) await assert.rejects(turn(), { code: "pylon-agents-only" }, what);
  const judgment = await harness.startJudgment();
  await harness.sendJudgment(judgment, "judge-says-hello", "judgment:1");
  await until(() => arrived.includes("judge"));
  assert.deepEqual([...new Set(arrived)], ["judge"], "only the judgment's request arrived");
});

test("a shared install's harness does not open while a thread's turn from before is unfinished, so nothing resumes it", async (t) => {
  const { host, open, arrived, control } = await recordedHarness(t);
  const conversationId = await host.startThread({ threadId: "th-alice", pylonId: "pylon-th-alice" as PylonId });
  control.hold = true;
  await host.send("th-alice", "alice-says-hello", "m-alice", "followUp");
  await until(() => arrived.includes("alice"));
  await host.close();
  control.hold = false;
  const threads = [{ threadId: "th-alice", conversationId, agentTurnRunning: true }];
  await assert.rejects(open({ threads, judgmentsOnly: true }), { message: /^the harness holds unfinished work of th-alice, which a shared install would resume on its one model login\. Start the control plane once without people/ });
  await new Promise((r) => setTimeout(r, 1_000));
  assert.deepEqual(arrived, ["alice"], "the shared open resumed nothing");
  await open({ threads });
  await until(() => arrived.length > 1);
  assert.deepEqual(arrived, ["alice", "alice"], "a solo open resumes the same turn, which the shared one held back");
});

test("a shared install's harness opens over an unfinished failure judgment and resumes it", async (t) => {
  const { host, open, arrived, control } = await recordedHarness(t);
  const judgment = await host.startJudgment();
  control.hold = true;
  await host.sendJudgment(judgment, "judge-says-hello", "judgment:1");
  await until(() => arrived.includes("judge"));
  await host.close();
  control.hold = false;
  await open({ judgmentsOnly: true });
  await until(() => arrived.length > 1);
  assert.deepEqual(arrived, ["judge", "judge"], "the judgment's turn resumed");
});

test("a shared pylon booted before mp-16 with the harness's ChatGPT grant loses it, so its wake waits on no secret its probe is never handed", async (t) => {
  const path = join(await tempDir("pylon-agents-only-registry-", t), "registry.db");
  const before = openRegistry(path);
  seedRegistry(before);
  const secrets = [...Object.values(ownerGrants), chatgptTokenGrant];
  const shared = addThread(before, { boot: { network: { allowedHosts: ["api.openai.com"], secrets } }, claudePrompt: "fix it" });
  const solo = addThread(before, { boot: { network: { allowedHosts: ["api.openai.com"], secrets: [chatgptTokenGrant] } } });
  before.close();
  // The registry as a control plane before this slice left it: the arc's last migration not yet applied.
  const db = new DatabaseSync(path);
  db.prepare("UPDATE arc_schema SET version = version - 1").run();
  db.close();
  const after = openRegistry(path);
  t.after(() => after.close());
  const held = (id: PylonId) => after.threads.pylon(id)!.boot.network.secrets.filter((s) => heldSecrets.includes(s.name)).map((s) => s.name);
  assert.deepEqual(held(shared.pylonId), [], "the shared pylon's boot asks for no held secret, so a probe after a restart wakes it");
  assert.deepEqual(after.threads.pylon(shared.pylonId)!.boot.network.secrets, Object.values(ownerGrants), "its owner's own logins stay");
  assert.deepEqual(held(solo.pylonId), [chatgptTokenGrant.name], "a solo install's pylon keeps the grant its probe is still handed");
});

test("a review alice starts on a shared install runs one reviewer thread she owns, on her Claude login, and makes no model request from the control plane", async (t) => {
  const { host, arrived } = await recordedHarness(t);
  const s = await install(t, host, shared);
  s.as(answer(tailnet.alice));
  const started = await s.call("POST", "/v1/threads", { project: "acme", claude: "alice-says-hello" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const builder = started.body.id as ThreadId;
  const pr = testPr({ repo: "acme/repo", number: 7, title: "Add the cache" });
  s.registry.prWatches.savePrWatch(builder, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const snapshot: PrSnapshot = { pr, detail: { head: "1".repeat(40), branch: "feature", base: "main", body: "Adds a cache.", mergeCommit: null }, failures: [], comments: [] };
  const files: ChangedFile[] = [{ path: "src/cache.ts", previous: null, patch: "@@ -0,0 +1 @@\n+export {};" }];
  const delivered: ThreadId[] = [];
  const noRun: CheckRuns = { start: async () => ({ refused: "no check in this test", room: false }), step: () => ({ kind: "void" }), result: () => null, discard: () => {} };
  const loop = reviewLoop({
    registry: s.registry, harnessModel: "gpt-6-astra", people: shared, lands: null, startThread: s.startThread,
    github: { find: async () => [7], poll: async () => structuredClone(snapshot), files: async () => files, change: async () => files, behind: async () => false, has: async () => false, label: async () => ({ kind: "labelled" }) },
    inbox: async (target) => { delivered.push(target.id); return "delivered"; },
    agentState: async (target, since) => ({ ...heard(target, s.registry.threads.claudeEntries(target.id), since), replies: [], failure: null }),
    personWrote: async () => false, brief: async () => null, runs: () => ({ checks: noRun, live: noRun }),
    release: { self: undefined, repo: "ramtinJ95/nexus", branch: "main" }, wake: () => {}, log: () => {},
  });
  t.after(() => loop.close());
  await loop.start(builder, { land: null });
  await loop.poll();
  const review = s.registry.reviews.review(builder)!;
  const reviewer = s.registry.threads.thread(review.reviewer);
  assert.deepEqual([reviewer?.owner, reviewer?.startedBy, reviewer?.conversationId, s.registry.threads.agent(reviewer!).kind], [alice, reviewerCaller, null, "claude"], "the reviewer is a Claude worker alice owns");
  assert.equal(review.second, undefined, "no second reviewer");
  assert.deepEqual(s.pylonSecrets.filter(([pylon, name]) => pylon === reviewer!.pylonId && name === ownerGrants.claude.name).map(([, , value]) => value), [`sk-ant-oat01-${alice}-made-up`], "its pylon was handed alice's Claude login");
  assert.deepEqual(delivered, [], "its first request is its first prompt");
  await new Promise((r) => setTimeout(r, 1_000));
  assert.deepEqual(arrived, [], "no model request left the control plane");
});
