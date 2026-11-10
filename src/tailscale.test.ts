import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { connect, createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTailscaleStatus, selfDnsName, tailscaleCli } from "./tailscale.ts";
import { localApiStatus, localApiWhois, localApiWhoisNode, PeerRefused, tailnetNodeIdPattern, verifyPeer } from "./node-base/tailscaled.ts";
import { tailnetDevices, tailnetMisses } from "./deploy/setup.ts";
import { tailnetNodeIdSchema } from "./protocol/fields.ts";
import type { Whois } from "./protocol/http.ts";
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
  const { localApiCertificate } = await import("./node-base/tailscaled.ts");
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

test("tailnetNodeIdPattern, which the bootstrap deployer checks with, accepts what protocol's tailnetNodeIdSchema accepts", () => {
  for (const id of ["nAbCdEf1CNTRL", "n1", "n", "AbCdEf1CNTRL", "nAb-Cd", " nAbCd", "nAbCd\n", ""]) {
    assert.equal(tailnetNodeIdPattern.test(id), tailnetNodeIdSchema.safeParse(id).success, JSON.stringify(id));
  }
});

test("tailscaleCli resolves with stdout as printed, and a failure names the command and its stderr, or else Node's reason", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "nexus-tailscale-bin-"));
  t.after(() => rm(bin, { recursive: true }));
  await writeFile(join(bin, "tailscale"), [
    "#!/bin/sh",
    'case "$1" in',
    "  ok) printf '  {\"TCP\":{}}\\n\\n' ;;",
    "  said) printf '\\n  no such serve config  \\n' >&2; exit 1 ;;",
    "  quiet) exit 2 ;;",
    "  slow) exec sleep 30 ;;",
    "esac",
  ].join("\n"), { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const cli = tailscaleCli();
  const signal = AbortSignal.timeout(5000);

  assert.equal(await cli(["ok", "--json"], signal), '  {"TCP":{}}\n\n');
  await assert.rejects(cli(["said", "--https=443", "off"], signal), { message: "tailscale said --https=443 off: no such serve config" });
  await assert.rejects(cli(["quiet", "status"], signal), (err: Error) => err.message.startsWith("tailscale quiet status: Command failed: tailscale quiet status"));
  const abort = new AbortController();
  const slow = cli(["slow"], abort.signal);
  abort.abort();
  await assert.rejects(slow, { message: /^tailscale slow: .*aborted/ });
});

test("the node's tailnet name comes from tailscale status without its trailing dot", () => {
  assert.equal(selfDnsName(parseTailscaleStatus(JSON.stringify({ Version: "1.90.0", Self: { ID: "n1", DNSName: "infra-testbench.example.ts.net." } }))), "infra-testbench.example.ts.net");
  assert.throws(() => selfDnsName(parseTailscaleStatus(JSON.stringify({ Self: { DNSName: "" } }))), /no MagicDNS name/);
  assert.throws(() => selfDnsName(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped" }))), /no Self\.DNSName/);
  assert.throws(() => selfDnsName(parseTailscaleStatus(JSON.stringify({ Self: { DNSName: "." } }))), /no MagicDNS name/);
});

// What install.sh's greps, setup.ts's parseTailnet, probe/config.ts's parseSelfDnsName and on-node-kit.ts's Self.ID
// schema each read from these fixtures on main at dfc39f4, before one parser replaced the four. Null is a throw.
const recorded = new Map<string, { misses: string[]; devices: string[] | null; dnsName: string | null; id: string | null }>([
  ["certificates-off", { misses: ["certificates-off"], devices: ["nFirebat1CNTRL rj-firebat rj-firebat.tail1234.ts.net 100.64.0.2", "nBench1CNTRL infra-testbench infra-testbench.tail1234.ts.net 100.64.0.3"], dnsName: "rj-firebat.tail1234.ts.net", id: "nFirebat1CNTRL" }],
  ["ipv6-only", { misses: [], devices: null, dnsName: "rj-firebat.tail1234.ts.net", id: "nFirebat1CNTRL" }],
  ["magicdns-off", { misses: ["magicdns-off", "certificates-off"], devices: ["nFirebat1CNTRL rj-firebat rj-firebat.tail1234.ts.net 100.64.0.2"], dnsName: "rj-firebat.tail1234.ts.net", id: "nFirebat1CNTRL" }],
  ["needs-login", { misses: ["not-running"], devices: null, dnsName: null, id: null }],
  ["running", { misses: [], devices: ["nFirebat1CNTRL rj-firebat rj-firebat.tail1234.ts.net 100.64.0.2", "nBench1CNTRL infra-testbench infra-testbench.tail1234.ts.net 100.64.0.3", "nMac1CNTRL ramtins-macbook-pro ramtins-macbook-pro.tail1234.ts.net 100.64.0.4"], dnsName: "rj-firebat.tail1234.ts.net", id: "nFirebat1CNTRL" }],
  ["stopped", { misses: ["not-running"], devices: ["nFirebat1CNTRL rj-firebat rj-firebat.tail1234.ts.net 100.64.0.2"], dnsName: "rj-firebat.tail1234.ts.net", id: "nFirebat1CNTRL" }],

]);

test("every reader of tailscale status reads the recorded fixtures as its own parser did", async () => {
  for (const [name, want] of recorded) {
    const json = await readFile(new URL(`fixtures/tailscale-status/${name}.json`, import.meta.url), "utf8");
    const status = parseTailscaleStatus(json);
    assert.deepEqual(tailnetMisses(json), want.misses, `${name}: install.sh's misses`);
    if (want.devices === null) assert.throws(() => tailnetDevices(status), /gives this machine no ID, MagicDNS name and IPv4 address/, name);
    else {
      const { self, peers } = tailnetDevices(status);
      assert.deepEqual([self, ...peers].map((d) => `${d.id} ${d.name} ${d.host} ${d.ip}`), want.devices, `${name}: setup's devices`);
    }
    if (want.dnsName === null) assert.throws(() => selfDnsName(status), /no MagicDNS name/, name);
    else assert.equal(selfDnsName(status), want.dnsName, `${name}: the probe's preview host`);
    if (want.id === null) assert.throws(() => tailnetNodeIdSchema.parse(status.self?.id ?? ""), /must be a Tailscale stable node ID/, name);
    else assert.equal(tailnetNodeIdSchema.parse(status.self?.id ?? ""), want.id, `${name}: the node check's self`);
  }
});

test("install.sh's check reads text that is not JSON as a tailscale that is not running", () => {
  assert.deepEqual(tailnetMisses(""), ["not-running"]);
  assert.deepEqual(tailnetMisses("null"), ["not-running"]);
});

test("each device's key expiry is read from tailscaled's status over LocalAPI, and is null where key expiry is off", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-status-"));
  const socketPath = join(dir, "tailscaled.sock");
  let status = 200;
  const server = createServer((req, res) => {
    assert.deepEqual([req.url, req.headers.host], ["/localapi/v0/status", "local-tailscaled.sock"]);
    res.writeHead(status).end(JSON.stringify({
      BackendState: "Running",
      Self: { ID: "nCONTROL", DNSName: "rj-firebat.example.ts.net.", TailscaleIPs: ["100.64.0.1"], KeyExpiry: "2027-05-01T12:00:00Z" },
      Peer: { "nodekey:a": { ID: "nPEER", DNSName: "infra-testbench.example.ts.net.", TailscaleIPs: ["100.64.0.2"] } },
    }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true });
  });
  const parsed = parseTailscaleStatus(await localApiStatus(socketPath));
  assert.equal(parsed.self?.keyExpiry, "2027-05-01T12:00:00.000Z");
  assert.deepEqual(parsed.peers.map((p) => [p.id, p.keyExpiry]), [["nPEER", null]]);
  status = 403;
  await assert.rejects(localApiStatus(socketPath), { message: "tailscaled status: HTTP 403" });
});
