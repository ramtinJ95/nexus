import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { PylonId } from "../ids.ts";
import { startGateway, warmHeader, type GatewayOptions, type PreviewHit, type PreviewRoute } from "./gateway.ts";

const pylonId = "pylon-gw" as PylonId;
const publicHost = "infra-testbench.example.ts.net:10001";

async function listen(t: import("node:test").TestContext, server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (server.address() as { port: number }).port;
}

/** A guest service: echoes what it received, streams /stream in two parts, and upper-cases bytes after an upgrade. */
async function guestOrigin(t: import("node:test").TestContext) {
  const second = Promise.withResolvers<void>();
  const server = createServer(async (req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first ");
      await second.promise;
      return res.end("second");
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    res.writeHead(201, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: ${req.headers.upgrade}\r\n\r\n`);
    socket.on("data", (data: Buffer) => socket.write(data.toString().toUpperCase()));
  });
  const port = await listen(t, server);
  return { origin: `http://127.0.0.1:${port}` as const, releaseSecond: () => second.resolve() };
}

async function setup(t: import("node:test").TestContext, origin: GatewayOptions["origin"]) {
  const hits: PreviewHit[] = [];
  const logged: string[] = [];
  const gateway = await startGateway({ port: 0, routes: new Map(), origin, onHit: (hit) => hits.push(hit), log: (message) => logged.push(message) });
  t.after(() => gateway.close());
  gateway.routes.set(10001, { pylonId, service: "web" });
  const gatewayPort = Number(new URL(gateway.origin).port);
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: IncomingMessage["headers"]; rawHeaders: string[]; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: gatewayPort, path, method: init.method ?? "GET", headers: { host: publicHost, ...init.headers } }, async (res) => {
        let body = "";
        for await (const chunk of res) body += chunk;
        resolve({ status: res.statusCode!, headers: res.headers, rawHeaders: res.rawHeaders, body });
      });
      req.on("error", reject);
      req.end(init.body);
    });
  return { gateway, gatewayPort, hits, logged, call };
}

test("a request is forwarded by its Host port, with its body, the public Host and x-forwarded-* for https", async (t) => {
  const guest = await guestOrigin(t);
  const asked: PreviewRoute[] = [];
  const { call } = await setup(t, (route) => { asked.push(route); return guest.origin; });
  const res = await call("/api/items?x=1", {
    method: "POST", body: "hello",
    headers: { "x-forwarded-for": "100.64.0.12", "tailscale-user-login": "someone@example.com", connection: "keep-alive, x-drop-me", "x-drop-me": "1" },
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.headers["set-cookie"], ["a=1", "b=2"]);
  const seen = JSON.parse(res.body) as { method: string; url: string; headers: Record<string, string>; body: string };
  assert.deepEqual(asked, [{ pylonId, service: "web" }]);
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/api/items?x=1");
  assert.equal(seen.body, "hello");
  assert.equal(seen.headers.host, publicHost);
  assert.equal(seen.headers["x-forwarded-proto"], "https");
  assert.equal(seen.headers["x-forwarded-host"], publicHost);
  assert.equal(seen.headers["x-forwarded-port"], "10001");
  assert.equal(seen.headers["x-forwarded-for"], "100.64.0.12, 127.0.0.1");
  assert.equal(seen.headers["tailscale-user-login"], "someone@example.com");
  assert.equal(seen.headers["x-drop-me"], undefined, "headers the Connection header names are hop-by-hop");
});

async function headerOrigin(t: import("node:test").TestContext) {
  const server = createServer((req, res) => {
    const headers = new URL(req.url!, "http://guest").searchParams;
    res.writeHead(headers.has("location") ? 302 : 200, [...headers].flat()).end();
  });
  return `http://127.0.0.1:${await listen(t, server)}` as const;
}

function cspValues(rawHeaders: string[]): string[] {
  return rawHeaders.filter((_, i) => i % 2 === 1 && rawHeaders[i - 1]!.toLowerCase() === "content-security-policy");
}

test("a guest's plain-http redirect to its own public URL reaches the browser as https, and other redirects arrive unchanged", async (t) => {
  const origin = await headerOrigin(t);
  const { call } = await setup(t, () => origin);
  const redirect = async (location: string) => (await call(`/?location=${encodeURIComponent(location)}`)).headers.location;
  assert.equal(await redirect(`http://${publicHost}/x?y#z`), `https://${publicHost}/x?y#z`);
  assert.equal(await redirect("http://elsewhere.example.com:10001/x"), "http://elsewhere.example.com:10001/x");
  assert.equal(await redirect("http://infra-testbench.example.ts.net:10002/x"), "http://infra-testbench.example.ts.net:10002/x");
  assert.equal(await redirect("/login?next=%2F"), "/login?next=%2F");
});

test("every forwarded response asks the browser to upgrade insecure requests, beside the guest's own CSP", async (t) => {
  const origin = await headerOrigin(t);
  const { call } = await setup(t, () => origin);
  assert.deepEqual(cspValues((await call("/")).rawHeaders), ["upgrade-insecure-requests"]);
  const csp = "default-src 'self'";
  assert.deepEqual(cspValues((await call(`/?content-security-policy=${encodeURIComponent(csp)}`)).rawHeaders), [csp, "upgrade-insecure-requests"]);
});

test("a response streams through before the origin has finished it", async (t) => {
  const guest = await guestOrigin(t);
  const { gatewayPort } = await setup(t, () => guest.origin);
  const req = request({ host: "127.0.0.1", port: gatewayPort, path: "/stream", headers: { host: publicHost } });
  req.end();
  const [res] = await once(req, "response") as [IncomingMessage];
  res.setEncoding("utf8");
  const [first] = await once(res, "data") as [string];
  assert.equal(first, "first ");
  guest.releaseSecond();
  let rest = "";
  for await (const chunk of res) rest += chunk;
  assert.equal(rest, "second");
});

test("a websocket upgrade passes through and bytes flow both ways", async (t) => {
  const guest = await guestOrigin(t);
  const { gatewayPort, hits } = await setup(t, () => guest.origin);
  const req = request({ host: "127.0.0.1", port: gatewayPort, path: "/ws", headers: { host: publicHost, connection: "upgrade", upgrade: "websocket" } });
  req.end();
  const [res, socket] = await once(req, "upgrade") as [IncomingMessage, Socket];
  t.after(() => socket.destroy());
  assert.equal(res.statusCode, 101);
  assert.equal(res.headers.upgrade, "websocket");
  socket.write("ping");
  const [echo] = await once(socket, "data") as [Buffer];
  assert.equal(echo.toString(), "PING");
  assert.equal(hits.length, 1);
});

test("an unmapped port gets 404, and neither reaches a guest nor counts as a hit", async (t) => {
  const { call, hits } = await setup(t, () => { throw new Error("must not be asked"); });
  const res = await call("/", { headers: { host: "infra-testbench.example.ts.net:10009" } });
  assert.equal(res.status, 404);
  assert.equal(hits.length, 0);
});

test("hits are reported once a minute per route, with the tailnet login", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2027-01-01T00:00:00Z") });
  const guest = await guestOrigin(t);
  const { gateway, call, hits } = await setup(t, () => guest.origin);
  gateway.routes.set(10002, { pylonId, service: "docs" });
  await call("/", { headers: { "tailscale-user-login": "someone@example.com" } });
  await call("/app.js");
  await call("/", { headers: { host: "infra-testbench.example.ts.net:10002" } });
  t.mock.timers.tick(59_999);
  await call("/later");
  t.mock.timers.tick(1);
  await call("/a-minute-later");
  assert.deepEqual(hits.map(({ service, login, at }) => ({ service, login, at })), [
    { service: "web", login: "someone@example.com", at: "2027-01-01T00:00:00.000Z" },
    { service: "docs", login: null, at: "2027-01-01T00:00:00.000Z" },
    { service: "web", login: null, at: "2027-01-01T00:01:00.000Z" },
  ]);
});

test("a pylon that cannot serve gets a waking page in a browser, plain text otherwise, and the hit still counts", async (t) => {
  const { call, hits, logged } = await setup(t, () => ({ unavailable: "pylon-gw is not running" }));
  const page = await call("/", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  assert.equal(page.status, 503);
  assert.equal(page.headers["retry-after"], "3");
  assert.match(page.headers["content-type"] ?? "", /^text\/html/);
  assert.match(page.body, /<meta http-equiv="refresh" content="3">/);
  const api = await call("/api/items", { headers: { accept: "application/json" } });
  assert.equal(api.status, 503);
  assert.equal(api.headers["retry-after"], "3");
  assert.match(api.headers["content-type"] ?? "", /^text\/plain/);
  assert.match(api.body, /not running/);
  assert.equal(hits.length, 1, "the second request falls inside the hit interval");
  assert.deepEqual(logged, []);
});

test("an origin lookup that throws is a fault: 502 with its message to a request and an upgrade alike, and logged", async (t) => {
  const { call, gatewayPort, logged } = await setup(t, () => { throw new Error("status.json is not JSON"); });
  const page = await call("/", { headers: { accept: "text/html" } });
  assert.equal(page.status, 502);
  assert.match(page.body, /status\.json is not JSON/);
  const req = request({ host: "127.0.0.1", port: gatewayPort, path: "/ws", headers: { host: publicHost, connection: "upgrade", upgrade: "websocket" } });
  req.end();
  const [res] = await once(req, "response") as [IncomingMessage];
  let body = "";
  for await (const chunk of res) body += chunk;
  assert.equal(res.statusCode, 502);
  assert.match(body, /status\.json is not JSON/);
  assert.equal(logged.length, 2);
  assert.match(logged[0]!, /web on pylon-gw.*status\.json is not JSON/);
});

test("an origin that is no URL is a fault too, and the gateway keeps serving", async (t) => {
  const { call, logged } = await setup(t, () => "http://127.0.0.1:99999");
  assert.equal((await call("/")).status, 502);
  assert.equal((await call("/")).status, 502);
  assert.match(logged[0]!, /Invalid URL/);
});

test("a service that is not listening gets 502", async (t) => {
  const closed = createServer();
  const port = await listen(t, closed);
  closed.close();
  const { call } = await setup(t, () => `http://127.0.0.1:${port}`);
  assert.equal((await call("/")).status, 502);
});

test("a warm-up is answered by the gateway itself: 204 for the routed pylon, 421 for another, no hit", async (t) => {
  const { call, hits } = await setup(t, () => { throw new Error("must not be asked"); });
  assert.equal((await call("/", { headers: { [warmHeader]: `${pylonId}/web` } })).status, 204);
  assert.equal((await call("/", { headers: { [warmHeader]: "pylon-other/web" } })).status, 421);
  assert.equal(hits.length, 0);
});

test("a browser that leaves during a stalled websocket handshake closes the origin connection too", { timeout: 5000 }, async (t) => {
  const origin = createServer();
  const originClosed = Promise.withResolvers<void>();
  origin.on("upgrade", (_req: IncomingMessage, socket: Socket) => socket.on("end", () => originClosed.resolve()));
  const port = await listen(t, origin);
  const { gatewayPort } = await setup(t, () => `http://127.0.0.1:${port}`);
  const req = request({ host: "127.0.0.1", port: gatewayPort, path: "/ws", headers: { host: publicHost, connection: "upgrade", upgrade: "websocket" } });
  req.on("error", () => {});
  req.end();
  await once(origin, "upgrade");
  req.destroy();
  await originClosed.promise;
});

test("a refused upgrade whose body the origin cuts short closes the browser's connection", { timeout: 5000 }, async (t) => {
  const origin = createServer();
  origin.on("upgrade", (_req: IncomingMessage, socket: Socket) => {
    socket.write("HTTP/1.1 403 Forbidden\r\ncontent-length: 100\r\n\r\npartial");
    setImmediate(() => socket.destroy());
  });
  const port = await listen(t, origin);
  const { gatewayPort } = await setup(t, () => `http://127.0.0.1:${port}`);
  const req = request({ host: "127.0.0.1", port: gatewayPort, path: "/ws", headers: { host: publicHost, connection: "upgrade", upgrade: "websocket" } });
  req.on("error", () => {});
  req.end();
  const [res] = await once(req, "response") as [IncomingMessage];
  assert.equal(res.statusCode, 403);
  assert.deepEqual(cspValues(res.rawHeaders), ["upgrade-insecure-requests"]);
  res.on("error", () => {}); // the cut-short body arrives as "aborted"
  res.resume();
  await new Promise((resolve) => res.on("close", resolve));
});

test("a gateway whose port is taken fails to start with the bind error", async (t) => {
  const taken = createServer().listen(0, "127.0.0.1");
  await once(taken, "listening");
  t.after(() => taken.close());
  const port = (taken.address() as { port: number }).port;
  await assert.rejects(startGateway({ port, routes: new Map(), origin: () => "http://127.0.0.1:1", onHit: () => {} }), { code: "EADDRINUSE" });
});
