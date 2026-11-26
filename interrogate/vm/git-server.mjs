// A git smart-HTTP remote for the push measurement: git's own `git http-backend` behind HTTPS on :8444, as a hosting
// service's remote is. It logs, for each request, how its body arrived and how many bytes of it did.
import https from "node:https";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [root, key, cert] = process.argv.slice(2);
https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const url = new URL(req.url, "http://x");
  const env = {
    ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: req.method, PATH_INFO: url.pathname,
    QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "bench", REMOTE_ADDR: "127.0.0.1",
    ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
    ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
  };
  const cgi = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "inherit"] });
  let received = 0;
  req.on("data", (c) => { received += c.length; });
  req.pipe(cgi.stdin);
  cgi.stdin.on("error", () => {});
  let head = Buffer.alloc(0);
  let sent = false;
  cgi.stdout.on("data", (d) => {
    if (sent) return void res.write(d);
    head = Buffer.concat([head, d]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    let status = 200;
    const headers = {};
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const at = line.indexOf(": ");
      if (line.slice(0, at).toLowerCase() === "status") status = parseInt(line.slice(at + 2), 10);
      else headers[line.slice(0, at)] = line.slice(at + 2);
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
    sent = true;
  });
  cgi.stdout.on("end", () => {
    if (!sent) res.writeHead(500);
    res.end();
    if (req.method === "POST") console.log(`remote got POST ${url.pathname}: ${req.headers["transfer-encoding"] ? `Transfer-Encoding ${req.headers["transfer-encoding"]}` : `Content-Length ${req.headers["content-length"]}`}, ${(received / (1 << 20)).toFixed(1)} MiB of body, expect=${req.headers.expect ?? "none"}`);
  });
}).listen(8444, "0.0.0.0", () => console.log("git remote up"));
