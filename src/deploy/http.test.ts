import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { DeployHttpError, jsonRequest } from "./http.ts";
import { joinControlPlane } from "./setup.ts";
import type { TailnetNodeId } from "../protocol.ts";

test("node requests verify the control identity before sending the root credential", async (t) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "none");
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  await assert.rejects(jsonRequest(url, "GET", undefined, "secret", { id: "nControl", whois: async () => "nWrong" as TailnetNodeId }), /wrong tailnet identity/);
  assert.deepEqual(seen, []);
  assert.deepEqual(await jsonRequest(url, "GET", undefined, "secret", { id: "nControl", whois: async () => "nControl" as TailnetNodeId }), { ok: true });
  assert.deepEqual(seen, ["Bearer secret"]);
});

test("health requests bound the whole response, not just connecting", async (t) => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('{"ok":'); }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  await assert.rejects(jsonRequest(url, "GET", undefined, null, undefined, 30));
});

test("a refused request carries its status and whole body, and a long join refusal reaches the person as the control plane's words", async (t) => {
  const refusal = `this join token was used at ${"x".repeat(1500)}`;
  const server = createServer((_req, res) => { res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: refusal })); }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  const error = await jsonRequest(url, "POST", {}, null).then(() => assert.fail("refused"), (err: unknown) => err);
  assert.ok(error instanceof DeployHttpError);
  assert.deepEqual([error.status, error.body], [409, JSON.stringify({ error: refusal })]);
  assert.equal(error.message, `deployment API HTTP 409: ${error.body.slice(0, 1000)}`, "logs keep the message they had");
  const deployer = { controlUrl: url.href, controlNodeId: "nControl", token: "a".repeat(64) };
  await assert.rejects(joinControlPlane(deployer, "join-token", async () => "nControl" as TailnetNodeId), { message: `the control plane at ${url.href} did not take the join: ${refusal}` });
});

test("a node request to the wrong tailnet identity sends no byte, not even the request line", async (t) => {
  const received: Buffer[] = [];
  const closed = Promise.withResolvers<void>();
  const server = createNetServer((socket) => socket.on("data", (chunk: Buffer) => received.push(chunk)).on("close", () => closed.resolve())).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/deployer`);
  await assert.rejects(jsonRequest(url, "POST", { join: "token" }, "secret", { id: "nControl", whois: async () => "nWrong" as TailnetNodeId }), { message: "deployment endpoint has the wrong tailnet identity" });
  await closed.promise;
  assert.equal(Buffer.concat(received).length, 0, "the other node received no bytes");
});
