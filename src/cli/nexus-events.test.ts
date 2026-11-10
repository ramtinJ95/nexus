/**
 * nexus events and the SSE reader under it, against the control plane's real API with a fake harness behind it.
 * src/test-support/cli-kit.ts says when a test runs the CLI in its own process and when as a child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { follow } from "./transport.ts";
import { cli, withHealth, setup } from "../test-support/cli-kit.ts";

test("events prints one JSON object per line and resumes after a cursor", async (t) => {
  const s = await setup(t);
  const first = s.registry.threads.appendEvent("release.changed", null, { state: "pending" });
  const second = s.registry.threads.appendEvent("release.changed", null, { state: "healthy" });
  const reply = await s.nexus(["events", "--since", first.id, "--kind", "release.changed", "--json"]);
  assert.equal(reply.code, 0, reply.stderr);
  assert.deepEqual(reply.stdout.trim().split("\n").map((line) => JSON.parse(line)), [second]);
});

test("the SSE reader waits for its consumer before delivering more data or a cursor", async (t) => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('id: 1\ndata: {"n":1}\n\nid: 2\ndata: {"n":2}\n\nid: 10\n: ping\n\n');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: unknown[] = [];
  const cursors: string[] = [];
  const reading = follow({ url: new URL(`http://127.0.0.1:${port}`), socks: null }, "/events", async (data) => {
    seen.push(data);
    entered.resolve();
    await release.promise;
  }, new AbortController().signal, (id) => cursors.push(id));
  await entered.promise;
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, [{ n: 1 }]);
  assert.deepEqual(cursors, [], "a cursor never acknowledges an unconsumed event");
  release.resolve();
  await reading;
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(cursors, ["1", "2", "10"]);
});

test("events resumes from an id-only heartbeat without printing it", { timeout: 60_000 }, async (t) => {
  const paths: string[] = [];
  const reconnected = Promise.withResolvers<void>();
  const server = createHttpServer(withHealth((req, res) => {
    paths.push(req.url!);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (paths.length === 1) res.end("id: 12000\n: ping\n\n");
    else { res.write(": connected\n\n"); reconnected.resolve(); }
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [cli, "events", "--follow", "--kind", "session.turn-ended", "--json", "--url", `http://127.0.0.1:${port}`, "--socks", "none"]);
  t.after(() => { child.kill(); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  await reconnected.promise;
  assert.equal(new URL(paths[1]!, "http://nexus").searchParams.get("since"), "12000");
  assert.equal(output, "");
  child.kill();
  await once(child, "exit");
});

test("events bounds stdout buffering when its pipe is not read", { timeout: 60_000 }, async (t) => {
  const event = JSON.stringify({ id: "1", time: 0, thread: null, project: null, kind: "release.changed", payload: { message: "x".repeat(2048) } });
  const server = createHttpServer(withHealth((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(Array.from({ length: 10_000 }, () => `data: ${event}\n\n`).join(""));
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const script = `
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => {
      const ready = write(...args);
      if (!ready) process.send({ buffered: process.stdout.writableLength });
      return ready;
    };
    process.argv = [process.execPath, ${JSON.stringify(cli)}, "events", "--follow", "--json", "--url", "http://127.0.0.1:${port}", "--socks", "none"];
    await import(${JSON.stringify(cli)});
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { child.kill(); });
  const blocked = Promise.withResolvers<void>();
  let maxBuffered = 0;
  child.on("message", (message: { buffered: number }) => { maxBuffered = Math.max(maxBuffered, message.buffered); blocked.resolve(); });
  await blocked.promise;
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(maxBuffered <= 128 * 1024, `stdout buffered ${maxBuffered} bytes into an unread pipe`);
  child.kill();
  assert.deepEqual(await once(child, "exit"), [0, null], "a blocked follower still responds to termination");
});

test("a dropped SSE connection cannot reconnect around a blocked consumer", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"n":1}\n\n');
    void entered.promise.then(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { release.resolve(); server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  let settled = false;
  const reading = follow({ url: new URL(`http://127.0.0.1:${port}`), socks: null }, "/events", async () => {
    entered.resolve();
    await release.promise;
  }, new AbortController().signal).then(() => { settled = true; }, () => { settled = true; });
  await entered.promise;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false);
  release.resolve();
  await reading;
  assert.equal(settled, true);
});
