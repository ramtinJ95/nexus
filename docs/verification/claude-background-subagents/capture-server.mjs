// Stands in for the pylon API at NEXUS_API: appends each request the in-pylon CLI sends, with its receipt time, to
// the file named by argv[3], and accepts it. Nothing is forwarded.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, out] = process.argv.slice(2);
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    appendFileSync(out, JSON.stringify({ time: Date.now(), request: JSON.parse(body) }) + "\n");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ accepted: true }));
  });
}).listen(Number(port), "127.0.0.1");
