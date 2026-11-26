// Can an onRequest hook in Gondolin 0.13.0's real bridge see method, path and body of a guest request, for both
// framings, and refuse it? (design point 5's mechanism). Same harness as gondolin-http-limits.mjs.
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createHttpHooks } from "@earendil-works/gondolin";

const { QemuNetworkBackend } = await import(new URL("qemu/net.js", import.meta.resolve("@earendil-works/gondolin")).href);
let upstreamHits = 0;
const upstream = http.createServer((req, res) => { upstreamHits++; req.resume(); req.on("end", () => { res.writeHead(200); res.end("{}"); }); });
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const port = upstream.address().port;

const guard = async (request) => {
  const text = await request.clone().text();
  let query = "";
  try { query = JSON.parse(text).query ?? ""; } catch {}
  const refused = request.method === "POST" && new URL(request.url).pathname === "/graphql" && /\b(mergePullRequest|enablePullRequestAutoMerge)\b|event\s*:\s*APPROVE/.test(query);
  console.log(`  hook saw ${request.method} ${new URL(request.url).pathname} body ${text.length} bytes -> ${refused ? "refuse" : "pass"}`);
  return refused ? new Response("refused by egress guard", { status: 403 }) : undefined;
};
const { httpHooks } = createHttpHooks({ onRequest: guard });
const backend = new QemuNetworkBackend({ socketPath: "/nonexistent", httpHooks: { ...httpHooks, isIpAllowed: () => true } });
backend.on("error", () => {});
const replies = new Map();
backend.stack = { handleTcpData: ({ key, data }) => { replies.get(key).text += data.toString("latin1"); }, handleTcpEnd: ({ key }) => replies.get(key)?.end(), handleTcpError: ({ key }) => replies.get(key)?.end(), reset() {} };
let flow = 0;
async function send(label, body, chunked) {
  const key = `f${++flow}`;
  const ended = new Promise((end) => replies.set(key, { text: "", end }));
  backend.tcpSessions.set(key, { srcIP: "192.168.127.3", srcPort: 41000 + flow, dstIP: "10.0.0.1", dstPort: port, protocol: "http", pendingWrites: [], pendingWriteBytes: 0, flowControlPaused: false });
  const b = Buffer.from(body);
  const head = `POST /graphql HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\n${chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${b.length}`}\r\n\r\n`;
  const half = Math.floor(b.length / 2);
  const parts = chunked
    ? [Buffer.from(head), Buffer.from(`${half.toString(16)}\r\n`), b.subarray(0, half), Buffer.from(`\r\n${(b.length - half).toString(16)}\r\n`), b.subarray(half), Buffer.from("\r\n0\r\n\r\n")]
    : [Buffer.from(head), b.subarray(0, half), b.subarray(half)];
  const before = upstreamHits;
  for (const p of parts) { backend.handleTcpSend({ key, data: p }); await sleep(5); }
  await ended;
  console.log(`${label}: guest got "${replies.get(key).text.split("\r\n")[0]}", reached upstream: ${upstreamHits > before}`);
}
const merge = JSON.stringify({ query: "mutation { mergePullRequest(input:{pullRequestId:\"X\"}) { clientMutationId } }" });
const escaped = merge.replace("mergePullRequest", "\\u006dergePullRequest");
const read = JSON.stringify({ query: "{ viewer { login } }" });
await send("merge mutation, Content-Length", merge, false);
await send("merge mutation, chunked", merge, true);
await send("merge mutation, JSON-escaped name", escaped, false);
await send("read query", read, false);
await backend.close();
upstream.close();
