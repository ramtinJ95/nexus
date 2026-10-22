import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localApiWhois } from "./tailscale.ts";

// A stand-in for tailscaled's LocalAPI on a Unix socket. The real daemon is never contacted.
test("localApiWhois asks LocalAPI whois for ip:port and returns the stable node ID", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-whois-"));
  const socketPath = join(dir, "tailscaled.sock");
  const seen: { path: string | undefined; host: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url, host: req.headers.host });
    const addr = new URL(req.url!, "http://x").searchParams.get("addr");
    if (addr === "100.64.0.7:41641") return res.end(JSON.stringify({ Node: { ID: 7, StableID: "nStable7CNTRL" } }));
    if (addr === "[fd7a:115c:a1e0::7]:80") return res.end(JSON.stringify({ Node: { StableID: "nStable7v6" } }));
    if (addr === "100.64.0.9:1") return res.writeHead(500).end("boom");
    if (addr === "100.64.0.10:1") return res.end("not json");
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
  assert.deepEqual(seen[0], { path: "/localapi/v0/whois?addr=100.64.0.7%3A41641", host: "local-tailscaled.sock" });
});
