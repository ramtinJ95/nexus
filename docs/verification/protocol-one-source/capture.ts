// Drives the checkout's real probe client, fetchArtifact, the deployer's jsonRequest and its LocalAPI whois and
// certificate reads against loopback stand-ins for a probe, a peer and tailscaled. Writes each answer, or each
// rejection's class, message, code and status, and how many bytes reached a peer that whois did not name. Then loads
// the deployer bootstrap's files from a directory with no node_modules, as install-deployer.sh installs them.
// Run from the root of a checkout: node docs/verification/protocol-one-source/capture.ts <out-file>
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { connectProbe, fetchArtifact } = await import("../../../src/protocol.ts");
const { jsonRequest } = await import("../../../src/deploy/http.ts");
const { localApiCertificate, localApiWhois } = await import("../../../src/tailscale.ts");
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;
type NodeName = import("../../../src/protocol.ts").NodeName;

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => { lines.push(line.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")); console.log(line); };
const probeId = "nPROBE" as TailnetNodeId;
const listen = async (server: { listen(port: number, host: string): unknown; once(event: "listening", f: () => void): unknown; address(): unknown }) => {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((ready) => server.once("listening", ready));
  return (server.address() as AddressInfo).port;
};
async function outcome(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const value = await run();
    log(`${name}: resolved ${JSON.stringify(value)}`);
  } catch (err) {
    const e = err as Error & { code?: unknown; status?: unknown };
    log(`${name}: ${e.constructor.name} ${JSON.stringify({ message: e.message, ...("code" in e ? { code: e.code } : {}), ...("status" in e ? { status: e.status } : {}) })}`);
  }
}

let answer = { status: 200, body: "" };
const probe = createServer((req: IncomingMessage, res: ServerResponse) => { req.resume().on("end", () => res.writeHead(answer.status).end(answer.body)); });
probe.on("upgrade", (_req, socket) => socket.end(answer.status === 101
  ? "HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: nexus-stream\r\n\r\n"
  : `HTTP/1.1 ${answer.status} Refused\r\ncontent-length: ${Buffer.byteLength(answer.body)}\r\nconnection: close\r\n\r\n${answer.body}`));
const port = await listen(probe);
const client = connectProbe("probe-node" as NodeName, "127.0.0.1", probeId, { port, whois: async () => probeId });
const pylon = "pylon-th-1" as never;
const exec = { kind: "exec", argv: ["true"], cwd: "/", timeoutMs: 1000 } as never;
const cases: [string, number, string, () => Promise<unknown>][] = [
  ["job 404", 404, "", () => client.job("job-1" as never)],
  ["job 500", 500, "boom", () => client.job("job-1" as never)],
  ["observe 502", 502, "bad gateway", async () => { for await (const _ of client.observe(AbortSignal.timeout(5000))) break; }],
  ["observe 403", 403, "not you", async () => { for await (const _ of client.observe(AbortSignal.timeout(5000))) break; }],
  ["command 409", 409, "pylon-th-1 is not running", () => client.command(pylon, exec)],
  ["command 400", 400, "command.argv: Too small", () => client.command(pylon, exec)],
  ["command 403", 403, "not you", () => client.command(pylon, exec)],
  ["health 500", 500, "boom", () => client.health()],
  ["putSecret 400", 400, "unknown secret", () => client.putSecret("NEXUS_CHATGPT_TOKEN", "token")],
  ["putPeers 404", 404, "no such route", () => client.putPeers([])],
  ["putPeers 409", 409, "conflict", () => client.putPeers([])],
  ["putPeers 403", 403, "not you", () => client.putPeers([])],
  ["manifest 404", 404, "", () => client.manifest("img-abc" as never)],
  ["manifest 500", 500, "boom", () => client.manifest("img-abc" as never)],
  ["stream 409", 409, "pylon-th-1 is not running", () => client.stream(pylon, ["cat"])],
  ["stream 403", 403, "not you", () => client.stream(pylon, ["cat"])],
  ["stream 500", 500, "boom", () => client.stream(pylon, ["cat"])],
];
for (const [name, status, body, run] of cases) {
  answer = { status, body };
  await outcome(name, run);
}

answer = { status: 101, body: "" };
const impostor = connectProbe("probe-node" as NodeName, "127.0.0.1", probeId, { port, whois: async () => "nOTHER" as TailnetNodeId });
await outcome("stream from another node", () => impostor.stream(pylon, ["cat"]));
const broken = connectProbe("probe-node" as NodeName, "127.0.0.1", probeId, { port, whois: async () => { throw new Error("tailscaled is down"); } });
await outcome("putPeers with whois failing", () => broken.putPeers([]));
await outcome("stream with whois failing", () => broken.stream(pylon, ["cat"]));

const received: Buffer[] = [];
const silent = createNetServer((socket) => socket.on("data", (chunk: Buffer) => received.push(chunk)));
const silentPort = await listen(silent);
await outcome("putSecret to another node", () => connectProbe("probe-node" as NodeName, "127.0.0.1", probeId, { port: silentPort, whois: async () => "nOTHER" as TailnetNodeId }).putSecret("NEXUS_CHATGPT_TOKEN", "a-real-looking-token"));
await outcome("deployer request to another node", () => jsonRequest(new URL(`http://127.0.0.1:${silentPort}/v1/deployer/report`), "POST", { state: "healthy" }, "secret", { id: "nCONTROL", whois: async () => "nOTHER" as TailnetNodeId }));
await new Promise((settled) => setTimeout(settled, 200));
log(`bytes another node received: ${Buffer.concat(received).length}`);

const peer = { host: "127.0.0.1", port };
const sha = "0".repeat(64);
for (const [name, status, body, peers] of [["fetchArtifact 409", 409, "holds other bytes", [probeId]], ["fetchArtifact 500", 500, "boom", [probeId]], ["fetchArtifact from a node not a peer", 200, "", ["nOTHER" as TailnetNodeId]]] as const) {
  answer = { status, body };
  await outcome(name, () => fetchArtifact(peer, "img-abc" as never, sha, { whois: async () => probeId, peers }, AbortSignal.timeout(5000)));
}

const dir = await mkdtemp(join(tmpdir(), "protocol-one-source-"));
const socketPath = join(dir, "tailscaled.sock");
let local = { status: 200, body: "" };
const tailscaled = createServer((req: IncomingMessage, res: ServerResponse) => { req.resume(); res.writeHead(local.status).end(local.body); });
await new Promise<void>((ready) => tailscaled.listen(socketPath, ready));
const whois = localApiWhois(socketPath);
for (const [name, status, body] of [
  ["whois 200", 200, JSON.stringify({ Node: { StableID: "nPEER" } })], ["whois 404", 404, "no match"], ["whois 500", 500, "boom"],
  ["whois with a 2 MiB answer", 200, "x".repeat(2 << 20)],
] as const) {
  local = { status, body };
  await outcome(name, () => whois("100.64.0.7", 41641));
}
for (const [name, status, body] of [["certificate 403", 403, "private details"], ["certificate with a 129 KiB answer", 200, "x".repeat(129 * 1024)], ["certificate with no pair", 200, "nothing"]] as const) {
  local = { status, body };
  await outcome(name, () => localApiCertificate("dashboard.example.ts.net", socketPath));
}

const bootstrap = join(dir, "bootstrap");
for (const file of ["src/deploy", "src/tailscale.ts", "src/json-file.ts", "src/request-body.ts"]) await cp(file, join(bootstrap, file), { recursive: true });
await writeFile(join(bootstrap, "package.json"), '{"type":"module"}\n');
const loaded = execFileSync(process.execPath, ["--input-type=module", "-e", "await import('./src/tailscale.ts'); await import('./src/deploy/http.ts'); console.log('loaded')"], { cwd: bootstrap, encoding: "utf8" }).trim();
log(`the deployer bootstrap, with no node_modules, loads tailscale.ts and deploy/http.ts: ${loaded}`);

for (const server of [probe, tailscaled]) { server.closeAllConnections(); server.close(); }
silent.close();
await rm(dir, { recursive: true });
await writeFile(out, `${lines.join("\n")}\n`);
process.exit(0);
