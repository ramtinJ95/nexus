import { request } from "node:http";
import { BodyTooLarge, readBody } from "../request-body.ts";
import type { Whois } from "../tailscale.ts";

/** A deployment API answer other than 200. `body` is the whole response, and the message only its start. */
export class DeployHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`deployment API HTTP ${status}: ${body.slice(0, 1000)}`);
    this.status = status;
    this.body = body;
  }
}

/** A host as a URL names it, with an IPv6 address in brackets. */
export const urlHost = (host: string): string => host.includes(":") ? `[${host}]` : host;

export async function jsonRequest(url: URL, method: string, body: unknown, token: string | null, peer?: { id: string; whois: Whois }, timeoutMs = 10_000): Promise<any> {
  if (url.protocol !== "http:") throw new Error("deployment endpoint must be tailnet HTTP");
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(url, { method, agent: false, signal: AbortSignal.timeout(timeoutMs), headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
    } }, (res) => {
      readBody(res).then((text) => {
        if (res.statusCode !== 200) throw new DeployHttpError(res.statusCode!, text);
        return JSON.parse(text);
      }).then(resolve, (error: Error) => {
        if (error instanceof BodyTooLarge) req.destroy(error);
        reject(error);
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
