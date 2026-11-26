// A real `git push` over smart HTTP, sent through Gondolin 0.13.0's real guest-HTTP bridge (QemuNetworkBackend with a
// fake TCP stack: bytes from a local TCP socket go in through handleTcpSend, as a guest's TCP payload would), to a
// local `git http-backend`. Measures whether a push with a large pack gets through the egress path design point 3
// relies on ("pushes go over HTTPS with the owner's token").
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const { QemuNetworkBackend } = await import(new URL("qemu/net.js", import.meta.resolve("@earendil-works/gondolin")).href);
const root = join(import.meta.dirname, "tmp-git");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git(root, "init", "-q", "--bare", "server.git");
git(join(root, "server.git"), "config", "http.receivepack", "true");

// git http-backend as CGI.
const cgi = (req, res) => {
  const url = new URL(req.url, "http://x");
  const child = spawn("/usr/lib/git-core/git-http-backend", [], { env: {
    GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "a", REMOTE_ADDR: "127.0.0.1",
    ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
  } });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0); let headerDone = false;
  child.stdout.on("data", (d) => {
    if (headerDone) return res.write(d);
    head = Buffer.concat([head, d]);
    const i = head.indexOf("\r\n\r\n");
    if (i < 0) return;
    headerDone = true;
    let status = 200; const headers = {};
    for (const line of head.subarray(0, i).toString().split("\r\n")) {
      const [k, ...v] = line.split(":"); const value = v.join(":").trim();
      if (k.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers[k] = value;
    }
    res.writeHead(status, headers); res.write(head.subarray(i + 4));
  });
  child.stdout.on("end", () => res.end());
};
const upstreams = [http.createServer(cgi), http.createServer(cgi)];
await new Promise((r) => upstreams[0].listen(0, "127.0.0.1", r));
const port = upstreams[0].address().port;
await new Promise((r) => upstreams[1].listen(port, "::1", r).on("error", () => r()));

// The "guest" side: git connects here, and every byte goes through Gondolin's bridge.
const backend = new QemuNetworkBackend({ socketPath: "/nonexistent", httpHooks: { isIpAllowed: () => true } });
backend.on("error", () => {});
const sockets = new Map();
backend.stack = {
  handleTcpData: ({ key, data }) => sockets.get(key)?.write(data),
  handleTcpEnd: ({ key }) => sockets.get(key)?.end(),
  handleTcpError: ({ key }) => sockets.get(key)?.destroy(),
  handleTcpPause() {}, handleTcpResume() {},
  reset() {},
};
let flow = 0;
const guest = net.createServer((sock) => {
  const key = `flow-${++flow}`;
  sockets.set(key, sock);
  backend.tcpSessions.set(key, { srcIP: "192.168.127.3", srcPort: 40000 + flow, dstIP: "10.0.0.1", dstPort: port, protocol: "http", pendingWrites: [], pendingWriteBytes: 0, flowControlPaused: false });
  sock.on("data", (data) => backend.handleTcpSend({ key, data }));
  sock.on("end", () => backend.handleTcpClose({ key }));
  sock.on("error", () => {});
});
await new Promise((r) => guest.listen(port, "127.0.0.2", r));

async function push(label, mib, viaGondolin = true) {
  const work = join(root, `work-${label}`);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "a@example.com"); git(work, "config", "user.name", "A");
  writeFileSync(join(work, "blob.bin"), randomBytes(mib * 1024 * 1024));
  git(work, "add", "."); git(work, "commit", "-q", "-m", label);
  const r = await new Promise((resolve) => {
    const child = spawn("git", [...(viaGondolin ? ["-c", `http.curloptResolve=localhost:${port}:127.0.0.2`] : []), "push", `http://localhost:${port}/server.git`, `main:${label}`], { cwd: work, env: { ...process.env, GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1" } });
    let err = ""; child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, err }));
  });
  const framing = [...new Set(r.err.split("\n").filter((l) => /=> Send header: (Transfer-Encoding|Content-Length)/i.test(l) && !/Content-Length: 0/.test(l)).map((l) => l.replace(/^.*Send header: /, "").replace(/\d+$/, "N")))];
  const replies = [...new Set(r.err.split("\n").filter((l) => /<= Recv header: HTTP\//.test(l)).map((l) => l.replace(/^.*Recv header: /, "").trim()))];
  const tail = r.err.split("\n").filter((l) => /^(error|fatal|To |   |send-pack)/.test(l)).slice(0, 4);
  console.log(`push ${label} ${viaGondolin ? "through Gondolin" : "direct, no Gondolin"} (${mib} MiB of new objects): git exit ${r.code}; request framing ${JSON.stringify(framing)}; replies ${JSON.stringify(replies)}`);
  for (const l of tail) console.log("   ", l);
}

await push("small", 4);
await push("large", 80);
await push("control", 80, false);
guest.close(); for (const u of upstreams) { u.closeAllConnections?.(); u.close(); }
await backend.close();
rmSync(root, { recursive: true, force: true });
