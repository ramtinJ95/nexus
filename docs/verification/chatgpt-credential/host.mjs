// The pylon's host side, standing in for its Gondolin controller: an HTTPS proxy that terminates TLS with a scratch
// CA, applies Gondolin's own createHttpHooks to each request, as the controller does, and sends it on to the real
// host. Only this process holds the secret's value. It prints the placeholder for the guest side and logs, for
// each request, what pi sent and what left after the swap, never more than a token's first characters.
import { createRequire } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import tls from "node:tls";

const [repo, keyFile, certFile, log] = process.argv.slice(2);
const { createHttpHooks } = createRequire(`${repo}/package.json`)("@earendil-works/gondolin");
const value = process.env.VERIFY_VALUE;
const { httpHooks, env, secretManager } = createHttpHooks({
  allowedHosts: ["api.openai.com", "auth.openai.com", "chatgpt.com"],
  secrets: { NEXUS_CHATGPT_TOKEN: { hosts: ["api.openai.com"], value } },
});
delete process.env.VERIFY_VALUE;
const placeholder = env.NEXUS_CHATGPT_TOKEN;
let updated;
const write = (line) => appendFileSync(log, `${line}\n`);
const shown = (header) => {
  if (header === null) return "no Authorization";
  const token = header.replace(/^Bearer /, "");
  const kind = token === placeholder ? "the placeholder" : token === value ? "the first value" : token === updated ? "the updated value" : "something else";
  return `Bearer ${token.slice(0, 10)}… (${kind}, ${token.length} chars)`;
};
const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "content-length"]);

const inner = http.createServer(async (req, res) => {
  const url = `https://${req.headers.host}${req.url}`;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, v] of Object.entries(req.headers)) if (!hopByHop.has(name)) headers.set(name, Array.isArray(v) ? v.join(", ") : v);
  const request = new Request(url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  const before = shown(request.headers.get("authorization"));
  let sent;
  try {
    sent = await httpHooks.onRequest(request);
  } catch (error) {
    write(`${req.method} ${url}\n  pi sent: ${before}\n  Gondolin blocked it: ${error.message}`);
    res.writeHead(403).end(error.message);
    return;
  }
  write(`${req.method} ${url}\n  pi sent: ${before}\n  left the host: ${shown(sent.headers.get("authorization"))}`);
  const upstream = await fetch(sent);
  write(`  ${new URL(url).hostname} answered ${upstream.status}`);
  if (process.env.VERIFY_HOLD_MS) {
    console.log("holding");
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.VERIFY_HOLD_MS)));
  }
  const out = {};
  upstream.headers.forEach((v, name) => { if (!hopByHop.has(name) && name !== "content-encoding") out[name] = v; });
  res.writeHead(upstream.status, out);
  for await (const chunk of upstream.body ?? []) res.write(chunk);
  res.end();
});

const key = readFileSync(keyFile);
const cert = readFileSync(certFile);
const proxy = http.createServer((_req, res) => res.writeHead(405).end());
proxy.on("connect", (req, socket) => {
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  inner.emit("connection", new tls.TLSSocket(socket, { isServer: true, key, cert }));
});
proxy.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: proxy.address().port, placeholder })));
process.stdin.on("data", (line) => {
  updated = line.toString().trim();
  secretManager.updateSecret("NEXUS_CHATGPT_TOKEN", { value: updated });
  write(`the host updated the secret's value (updateSecret), as a probe's handoff does`);
  console.log("updated");
});
