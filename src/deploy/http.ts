import { request } from "node:http";
import type { Whois } from "../tailscale.ts";

export async function jsonRequest(url: URL, method: string, body: unknown, token: string | null, peer?: { id: string; whois: Whois }, timeoutMs = 10_000): Promise<any> {
  if (url.protocol !== "http:") throw new Error("deployment endpoint must be tailnet HTTP");
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(url, { method, agent: false, signal: AbortSignal.timeout(timeoutMs), headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
    } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error("deployment response too large")); });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`deployment API HTTP ${res.statusCode}: ${text.slice(0, 1000)}`));
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        void (async () => {
          if (peer !== undefined && await peer.whois(socket.remoteAddress!, socket.remotePort!) !== peer.id) throw new Error("deployment endpoint has the wrong tailnet identity");
          req.end(payload);
        })().catch((error: Error) => req.destroy(error));
      });
    });
  });
}
