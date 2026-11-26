// Upstream test servers for the Gondolin measurements, run as their own process so their CPU is not the controller's.
//   :8080 HTTP    /blob?mb=N streams N MiB; POST /echo answers the request's method, path, headers and body length
//   :8443 HTTPS   the same, offering h2 and http/1.1 by ALPN; answers `x-proto` with what the client negotiated
//   :5432 TCP     echo, standing in for any non-HTTP TCP service
//   :9999 UDP     echo, standing in for QUIC or any other UDP service
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";

const chunk = Buffer.alloc(1 << 20, 0x61);

function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const proto = req.httpVersion;
  if (url.pathname === "/blob") {
    let left = Number(url.searchParams.get("mb") ?? "1");
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(left * chunk.length), "x-proto": proto });
    const pump = () => {
      while (left > 0) {
        left--;
        if (!res.write(chunk)) return void res.once("drain", pump);
      }
      res.end();
    };
    return pump();
  }
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: url.searchParams.get("to") });
    return res.end();
  }
  let bytes = 0;
  req.on("data", (c) => { bytes += c.length; });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json", "x-proto": proto });
    res.end(JSON.stringify({ method: req.method, path: req.url, proto, bytes, authorization: req.headers.authorization ?? null }) + "\n");
  });
}

http.createServer(handle).listen(8080, "0.0.0.0");
http2.createSecureServer({ key: readFileSync(process.argv[2]), cert: readFileSync(process.argv[3]), allowHTTP1: true }, handle).listen(8443, "0.0.0.0");
net.createServer((s) => { s.on("error", () => {}); s.pipe(s); }).listen(5432, "0.0.0.0");
const udp = dgram.createSocket("udp4");
udp.on("message", (msg, r) => udp.send(msg, r.port, r.address));
udp.bind(9999, "0.0.0.0");
console.log("servers up");
