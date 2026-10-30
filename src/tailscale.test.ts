import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { connect, createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localApiWhois, localApiWhoisNode, PeerRefused, verifyPeer, type Whois } from "./tailscale.ts";
import type { TailnetNodeId } from "./ids.ts";

// A stand-in for tailscaled's LocalAPI on a Unix socket. The real daemon is never contacted.
test("localApiWhois asks LocalAPI whois for ip:port and returns the stable node ID", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-whois-"));
  const socketPath = join(dir, "tailscaled.sock");
  const seen: { path: string | undefined; host: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url, host: req.headers.host });
    const addr = new URL(req.url!, "http://x").searchParams.get("addr");
    if (addr === "100.64.0.7:41641") return res.end(JSON.stringify({ Node: { ID: 7, StableID: "nStable7CNTRL", Name: "rj-firebat.example.ts.net." } }));
    if (addr === "[fd7a:115c:a1e0::7]:80") return res.end(JSON.stringify({ Node: { StableID: "nStable7v6" } }));
    if (addr === "100.64.0.9:1") return res.writeHead(500).end("boom");
    if (addr === "100.64.0.10:1") return res.end("not json");
    if (addr === "100.64.0.11:1") return res.end("x".repeat((1 << 20) + 1));
    res.writeHead(404).end("no match for IP:port");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true });
  });

  const whois = localApiWhois(socketPath);
  assert.equal(await whois("100.64.0.7", 41641), "nStable7CNTRL");
  assert.equal(await whois("::ffff:100.64.0.7", 41641), "nStable7CNTRL");
  assert.equal(await whois("fd7a:115c:a1e0::7", 80), "nStable7v6");
  assert.equal(await whois("100.64.0.8", 5), null);
  await assert.rejects(whois("100.64.0.9", 1), /HTTP 500: boom/);
  await assert.rejects(whois("100.64.0.10", 1), /tailscaled whois 100\.64\.0\.10:1: .*JSON/);
  await assert.rejects(whois("100.64.0.11", 1), { message: "tailscaled whois 100.64.0.11:1 response too large" });
  assert.deepEqual(seen[0], { path: "/localapi/v0/whois?addr=100.64.0.7%3A41641", host: "local-tailscaled.sock" });

  const whoisNode = localApiWhoisNode(socketPath);
  assert.deepEqual(await whoisNode("100.64.0.7", 41641), { id: "nStable7CNTRL", host: "rj-firebat.example.ts.net" }, "the MagicDNS name, without its root dot");
  assert.equal(await whoisNode("100.64.0.8", 5), null);
  await assert.rejects(whoisNode("fd7a:115c:a1e0::7", 80), /response has no Node\.Name/);
});

test("LocalAPI certificates use cert-only access, request renewal, and reject invalid replies", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-cert-"));
  t.after(() => rm(dir, { recursive: true }));
  const { testCertificate } = await import("./test-certificate.ts");
  const { localApiCertificate } = await import("./tailscale.ts");
  const certificate = await testCertificate(dir);
  let status = 200;
  let body = certificate.key + certificate.cert;
  let seen = "";
  const socketPath = join(dir, "tailscaled.sock");
  const server = createServer((req, res) => {
    assert.equal(req.headers.host, "local-tailscaled.sock");
    seen = req.url!;
    res.writeHead(status).end(body);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  assert.deepEqual(await localApiCertificate("dashboard.example.ts.net", socketPath), {
    key: certificate.key.trim(), cert: certificate.cert.trim(),
  });
  assert.equal(seen, "/localapi/v0/cert/dashboard.example.ts.net?type=pair&min_validity=168h");
  await assert.rejects(localApiCertificate("wrong.example.ts.net", socketPath), /hostname/);
  status = 403;
  body = "private error details";
  await assert.rejects(localApiCertificate("dashboard.example.ts.net", socketPath), { message: "tailscaled certificate: HTTP 403" });
  status = 200;
  await assert.rejects(localApiCertificate("dashboard.example.ts.net", socketPath), /pair/);
  body = "x".repeat(129 * 1024);
  await assert.rejects(localApiCertificate("dashboard.example.ts.net", socketPath), /too large/);
});

test("verifyPeer asks whois once a connecting socket connects, and refuses a socket that closed first or a node the caller does not accept", async (t) => {
  const server = createNetServer((socket) => socket.end()).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const asked: [string, number][] = [];
  const whois: Whois = async (address, remotePort) => { asked.push([address, remotePort]); return "nPeer" as TailnetNodeId; };

  const connecting = connect(port, "127.0.0.1");
  assert.equal(connecting.connecting, true);
  await verifyPeer(connecting, whois, (id) => id === "nPeer");
  assert.deepEqual(asked, [["127.0.0.1", port]], "whois got the address the socket connected to");
  connecting.destroy();

  const refused = await verifyPeer(connect(port, "127.0.0.1"), whois, () => false).then(() => assert.fail("accepted"), (err: unknown) => err);
  assert.ok(refused instanceof PeerRefused);
  assert.deepEqual(refused.peer, { address: "127.0.0.1", port, id: "nPeer" });
  assert.equal(refused.message, `127.0.0.1:${port} is tailnet node nPeer`);
  await assert.rejects(verifyPeer(connect(port, "127.0.0.1"), async () => null, () => true), { peer: { address: "127.0.0.1", port, id: null }, message: `127.0.0.1:${port} is tailnet node unknown` });
  await assert.rejects(verifyPeer(connect(port, "127.0.0.1"), async () => { throw new Error("tailscaled is down"); }, () => true), { message: "tailscaled is down" });

  const closed = new Promise<number>((resolve) => { const probe = createNetServer().listen(0, "127.0.0.1", () => { const free = (probe.address() as AddressInfo).port; probe.close(() => resolve(free)); }); });
  const unconnected = connect(await closed, "127.0.0.1").on("error", () => undefined);
  asked.length = 0;
  await assert.rejects(verifyPeer(unconnected, whois, () => true), { peer: null, message: "the connection closed before whois" });
  assert.deepEqual(asked, [], "whois is not asked about a socket with no peer");
});
