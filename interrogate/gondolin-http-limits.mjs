// Drives Gondolin 0.13.0's real guest-HTTP bridge (QemuNetworkBackend, as src/pylon-vm/network.test.ts does) with a
// fake TCP stack and a local upstream, to measure what a guest upload or download meets. No VM: the userspace TCP/IP
// stack and QEMU are left out, so throughput here is an upper bound on the bridge alone.
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const { QemuNetworkBackend } = await import(new URL("qemu/net.js", import.meta.resolve("@earendil-works/gondolin")).href);
const MiB = 1024 * 1024;

let received = 0;
const upstream = http.createServer((req, res) => {
  if (req.method === "GET") {
    const total = Number(new URL(req.url, "http://x").searchParams.get("bytes"));
    res.writeHead(200, { "content-length": String(total) });
    const chunk = Buffer.alloc(MiB, 0x61);
    let sent = 0;
    const pump = () => { while (sent < total) { sent += MiB; if (!res.write(chunk)) return res.once("drain", pump); } res.end(); };
    return pump();
  }
  let n = 0;
  req.on("data", (d) => { n += d.length; });
  req.on("end", () => { received = n; res.writeHead(200); res.end(`got ${n}`); });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const port = upstream.address().port;

function backendWith() {
  const backend = new QemuNetworkBackend({ socketPath: "/nonexistent", httpHooks: { isIpAllowed: () => true } });
  backend.on("error", () => {});
  const replies = new Map();
  backend.stack = {
    handleTcpData: ({ key, data }) => { const r = replies.get(key); r.bytes += data.length; if (r.head.length < 200) r.head += data.toString("latin1", 0, Math.min(data.length, 200)); },
    handleTcpEnd: ({ key }) => replies.get(key)?.end(),
    handleTcpError: ({ key }) => replies.get(key)?.end(),
    reset() {},
  };
  let flow = 0;
  return {
    backend,
    async exchange(chunks) {
      const key = `flow-${++flow}`;
      const ended = new Promise((end) => replies.set(key, { head: "", bytes: 0, end }));
      backend.tcpSessions.set(key, { srcIP: "192.168.127.3", srcPort: 40000 + flow, dstIP: "10.0.0.1", dstPort: port, protocol: "http", pendingWrites: [], pendingWriteBytes: 0, flowControlPaused: false });
      for (const data of chunks) { backend.handleTcpSend({ key, data }); await sleep(0); }
      await ended;
      const r = replies.get(key);
      return { status: r.head.slice(9, 12), line: r.head.split("\r\n")[0], bytes: r.bytes };
    },
  };
}

function* body(size, chunked) {
  const piece = Buffer.alloc(MiB, 0x62);
  for (let sent = 0; sent < size; sent += MiB) {
    const n = Math.min(MiB, size - sent);
    yield chunked ? Buffer.concat([Buffer.from(`${n.toString(16)}\r\n`), piece.subarray(0, n), Buffer.from("\r\n")]) : piece.subarray(0, n);
  }
  if (chunked) yield Buffer.from("0\r\n\r\n");
}

const b = backendWith();
for (const [label, size, chunked] of [["Content-Length 60 MiB", 60 * MiB, false], ["Content-Length 80 MiB", 80 * MiB, false], ["chunked 60 MiB", 60 * MiB, true], ["chunked 80 MiB", 80 * MiB, true]]) {
  received = 0;
  const rssBefore = process.memoryUsage().rss;
  const head = `PUT /v2/blobs/upload HTTP/1.1\r\nHost: localhost:${port}\r\n${chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${size}`}\r\n\r\n`;
  const r = await b.exchange([Buffer.from(head), ...body(size, chunked)]);
  console.log(`upload ${label}: guest sees "${r.line}", upstream received ${(received / MiB).toFixed(0)} MiB, rss +${((process.memoryUsage().rss - rssBefore) / MiB).toFixed(0)} MiB`);
}
await b.backend.close();

const d = backendWith();
for (const gib of [1]) {
  const cpu0 = process.cpuUsage(); const t0 = performance.now();
  const r = await d.exchange([Buffer.from(`GET /blob?bytes=${gib * 1024 * MiB} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`)]);
  const ms = performance.now() - t0; const cpu = process.cpuUsage(cpu0);
  console.log(`download ${gib} GiB: guest sees "${r.line}", ${(r.bytes / MiB).toFixed(0)} MiB in ${(ms / 1000).toFixed(2)} s = ${(r.bytes / MiB / (ms / 1000)).toFixed(0)} MiB/s, CPU ${((cpu.user + cpu.system) / 1e6).toFixed(2)} s (bridge only, one event loop)`);
}
await d.backend.close();
upstream.closeAllConnections();
upstream.close();
