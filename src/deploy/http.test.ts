import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { jsonRequest } from "./http.ts";
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
