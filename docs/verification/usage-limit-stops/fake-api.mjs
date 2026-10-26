// A stand-in for the Messages API that Claude Code reaches through ANTHROPIC_BASE_URL. In `limit` mode every request
// gets the 429 a subscription at its usage limit gets, with the unified rate-limit headers; `plain` is a 429 without
// them, `overloaded` a 529, and `ok` a short streamed reply. POST /mode/<mode>[?reset=<unix s>] switches it.
//
//   node docs/verification/usage-limit-stops/fake-api.mjs <port> [mode] [reset] [claim]
import http from "node:http";

const port = Number(process.argv[2] ?? 18765);
let mode = process.argv[3] ?? "limit";
let reset = process.argv[4] ?? String(Math.floor(Date.now() / 1000) + 3600);
const claim = process.argv[5] ?? "five_hour";

function reply(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_fake_ok" });
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Continuing where I stopped." } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
}

http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    const switched = /^\/mode\/(limit|plain|overloaded|ok)$/.exec(url.pathname);
    if (req.method === "POST" && switched !== null) {
      mode = switched[1];
      reset = url.searchParams.get("reset") ?? reset;
      console.log(`mode ${mode}, reset ${reset}`);
      return void res.writeHead(204).end();
    }
    if (!url.pathname.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      return void res.end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
    }
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} answered ${mode}`);
    if (mode === "ok") return reply(res);
    const headers = { "content-type": "application/json", "request-id": "req_fake", "x-should-retry": "false" };
    if (mode === "limit") Object.assign(headers, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": reset, "anthropic-ratelimit-unified-representative-claim": claim });
    res.writeHead(mode === "overloaded" ? 529 : 429, headers);
    res.end(JSON.stringify({ type: "error", error: mode === "overloaded" ? { type: "overloaded_error", message: "Overloaded" } : { type: "rate_limit_error", message: "Rate limit exceeded" } }));
  });
}).listen(port, "127.0.0.1", () => console.log(`fake API on 127.0.0.1:${port}, mode ${mode}`));
