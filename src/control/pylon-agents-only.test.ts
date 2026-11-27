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
import { judgmentsOnly, openHarnessHost, type HarnessHost } from "./harness/host.ts";
import { harnessModels } from "./harness/credentials.ts";
import { peopleOf, type People } from "./people.ts";
import { image, project, testApi } from "../test-support/api-kit.ts";
import { tailnet, type WhoisAnswer } from "../test-support/people.ts";
import { parseWhois, type TailnetCaller } from "../node-base/tailscaled.ts";
import { tempDir } from "../test-support/kit.ts";
import type { ImageId, Person, PylonId } from "../ids.ts";

const alice = tailnet.alice.UserProfile!.LoginName as Person;
const bob = tailnet.bob.UserProfile!.LoginName as Person;
const shared = peopleOf({ [alice]: "admin", [bob]: "engineer" });
const answer = (a: WhoisAnswer): TailnetCaller => ({ id: a.Node.StableID, ...parseWhois(a).identity });

/** The real harness on one login, and every model request it sent, by the marker each one's text carried. */
async function recordedHarness(t: Parameters<typeof testApi>[0] & { after(fn: () => unknown): void }) {
  const scratch = await tempDir("pylon-agents-only-", t);
  const arrived: string[] = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      arrived.push(/(\w+)-says-hello/.exec(body)?.[1] ?? "?");
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "recorded by the test", type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => upstream.close());
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
  const host = await openHarnessHost({
    storagePath: join(scratch, "harness.sqlite"), models, model: { provider: "openai", modelId: (await models.getAvailable("openai"))[0]!.id }, tailscaled: join(scratch, "none.sock"),
    locator: { awaitRunning: () => Promise.reject(new Error("no pylon in this test")) },
    threads: [], deleted: [], onActivity: () => {}, log: () => {},
  });
  t.after(() => host.close());
  return { host, arrived };
}

/** The API as main.ts wires it for `people`, over `host`, with project acme and a current image. */
async function install(t: Parameters<typeof testApi>[0], host: HarnessHost, people: People) {
  let caller = answer(tailnet.alice);
  const s = await testApi(t, { ...people.shared ? { people, allowed: new Set(), whois: async () => caller } : {}, harness: people.shared ? judgmentsOnly(host) : host, queue: true, pipeline: true });
  await s.call("POST", "/v1/projects", project);
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
