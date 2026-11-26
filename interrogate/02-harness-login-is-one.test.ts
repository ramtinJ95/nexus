/**
 * Team-mode design, point 3: each user's model subscription is "substituted at the pylon's egress proxy only for that
 * user's pylons", so each engineer spends only their own.
 *
 * A Nexus agent's loop is not in a pylon. It runs in the pi-durable harness on the control plane, which is opened with
 * one `Models` over one credential store keyed by provider (src/control/harness/host.ts, credentials.ts), and
 * `HarnessHost.startThread` takes a thread and a pylon, never who started it. So its model requests never cross a
 * pylon's egress proxy, and every thread's carry the installation's one login.
 *
 * Real here: openHarnessHost, pi-durable, pi-ai's openai provider and request path, and the harness's own
 * harnessModels over a credential store. Only the provider's base URL is moved from api.openai.com to a local server
 * that records what arrives. No pylon exists: the locator refuses every lookup and counts them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openHarnessHost } from "../src/control/harness/host.ts";
import { harnessModels } from "../src/control/harness/credentials.ts";
import type { PylonId } from "../src/ids.ts";
import { tempDir } from "../src/test-support/kit.ts";

test("two engineers' Nexus agent threads send their model requests from the control plane with the one harness login", async (t) => {
  const scratch = await tempDir("interrogate-harness-", t);

  // Stands in for api.openai.com: records each request's credential and which thread's message it carried.
  const arrived: { path: string; authorization: string | undefined; thread: string }[] = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      arrived.push({ path: req.url ?? "", authorization: req.headers.authorization, thread: /alice-says-hello/.test(body) ? "alice" : /bob-says-hello/.test(body) ? "bob" : "?" });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "recorded by the test", type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => upstream.close());
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

  // The harness's login, as /var/lib/nexus/harness-credentials.json holds it: one credential for provider `openai`.
  const stored = new Map<string, Credential>([["openai", { type: "api_key", key: "sk-THE-INSTALLATIONS-ONE-LOGIN" }]]);
  const reads: string[] = [];
  const store: CredentialStore = {
    read: async (provider) => { reads.push(provider); return stored.get(provider); },
    list: async () => [...stored].map(([providerId, c]) => ({ providerId, type: c.type })),
    modify: async (provider, fn) => { const next = await fn(stored.get(provider)); if (next !== undefined) stored.set(provider, next); return stored.get(provider); },
    delete: async (provider) => { stored.delete(provider); },
  };
  const models = harnessModels({ store, deviceId: "00000000-0000-4000-8000-000000000000" });
  const real = openaiProvider();
  const moved = (list: readonly unknown[]) => list.map((m) => ({ ...(m as object), baseUrl }));
  models.setProvider({ ...real, baseUrl, getModels: () => moved(real.getModels()) as never, ...(real.getAllModels ? { getAllModels: () => moved(real.getAllModels!()) as never } : {}) });
  const modelId = (await models.getAvailable("openai"))[0]!.id;

  let pylonLookups = 0;
  const logged: string[] = [];
  const host = await openHarnessHost({
    storagePath: join(scratch, "harness.sqlite"), models, model: { provider: "openai", modelId }, tailscaled: join(scratch, "none.sock"),
    locator: { awaitRunning: () => { pylonLookups++; return Promise.reject(new Error("no pylon in this test")); } },
    threads: [], deleted: [], onActivity: () => {}, log: (m) => logged.push(m),
  });
  t.after(() => host.close());

  // Alice's thread and Bob's thread. startThread has no parameter that says whose each is.
  await host.startThread({ threadId: "th-alice", pylonId: "pylon-th-alice" as PylonId });
  await host.startThread({ threadId: "th-bob", pylonId: "pylon-th-bob" as PylonId });
  await host.send("th-alice", "alice-says-hello", "m-alice", "followUp");
  await host.send("th-bob", "bob-says-hello", "m-bob", "followUp");
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !(arrived.some((a) => a.thread === "alice") && arrived.some((a) => a.thread === "bob"));) await new Promise((r) => setTimeout(r, 20));

  const of = (thread: string) => arrived.find((a) => a.thread === thread);
  console.log(`alice's thread -> POST ${of("alice")?.path} Authorization: ${of("alice")?.authorization}`);
  console.log(`bob's thread   -> POST ${of("bob")?.path} Authorization: ${of("bob")?.authorization}`);
  console.log(`credential store reads, by key: ${JSON.stringify([...new Set(reads)])}; pylon lookups: ${pylonLookups}, each refused because no pylon exists, and the requests left all the same`);
  assert.ok(of("alice") !== undefined && of("bob") !== undefined, `both threads' model requests arrived: ${JSON.stringify(arrived)} ${logged.join("; ")}`);
  assert.notEqual(of("alice")!.authorization, of("bob")!.authorization, "each engineer's thread must spend that engineer's own model credential");
});
