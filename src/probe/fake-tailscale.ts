/**
 * Test doubles for the tailscale CLI and the HTTPS warm-up. The serve config is held in the shape that
 * `tailscale serve status --json` printed in S6. No real tailscaled is contacted.
 */
import { request } from "node:http";
import type { HttpsGet, TailscaleCli } from "./serve.ts";

export const nodeHost = "infra-testbench.example.ts.net";

interface ServeConfig {
  TCP?: Record<string, { HTTPS: true }>;
  Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
}

export function fakeTailscale(initial = "{}") {
  let config = JSON.parse(initial) as ServeConfig;
  const changes: string[] = [];
  const failing = new Set<string>();
  const cli: TailscaleCli = async (args, signal) => {
    signal.throwIfAborted();
    const line = args.join(" ");
    if (failing.delete(line)) throw new Error(`tailscale ${line}: error: injected failure`);
    if (line === "serve status --json") return JSON.stringify(config, null, 2);
    const add = /^serve --bg --https=(\d+) ((?:http:\/\/|unix:)\S+)$/.exec(line);
    const off = /^serve --https=(\d+) off$/.exec(line);
    if (add) {
      const [, port, target] = add as unknown as [string, string, string];
      config = { TCP: { ...config.TCP, [port]: { HTTPS: true } }, Web: { ...config.Web, [`${nodeHost}:${port}`]: { Handlers: { "/": { Proxy: target } } } } };
    } else if (off) {
      const port = off[1]!;
      if (config.TCP?.[port] === undefined) throw new Error(`tailscale ${line}: error: no serve config for port ${port}`);
      const { [port]: _tcp, ...tcp } = config.TCP;
      const { [`${nodeHost}:${port}`]: _web, ...web } = config.Web ?? {};
      config = Object.keys(tcp).length === 0 ? {} : { TCP: tcp, Web: web };
    } else {
      throw new Error(`the fake tailscale does not know: tailscale ${line}`);
    }
    changes.push(line);
    return "";
  };
  return {
    cli,
    changes,
    /** The next run of exactly this command fails, as if tailscaled refused it. */
    failOnce(line: string) { failing.add(line); },
    /** Port to proxy target, as the status JSON reports it. */
    entries(): Record<string, string> {
      return Object.fromEntries(Object.entries(config.Web ?? {}).map(([key, web]) => [key.slice(key.lastIndexOf(":") + 1), web.Handlers["/"]!.Proxy]));
    },
  };
}

/** Sends each warm-up to the gateway over plain HTTP with the public Host, as serve would after TLS. */
export function viaGateway(origin: () => string) {
  const urls: string[] = [];
  let failures = 0;
  const held = new Map<string, PromiseWithResolvers<void>>();
  const get: HttpsGet = async (url, headers, signal) => {
    urls.push(url);
    if (failures > 0) {
      failures--;
      throw new Error("TLS handshake timed out");
    }
    await held.get(url)?.promise;
    return new Promise((resolve, reject) => {
      const req = request(origin(), { headers: { ...headers, host: new URL(url).host }, signal }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
  };
  return {
    get,
    urls,
    failNext(n: number) { failures = n; },
    /** Warm-ups of this URL wait until the returned function is called. */
    hold(url: string) {
      const gate = Promise.withResolvers<void>();
      held.set(url, gate);
      return () => gate.resolve();
    },
  };
}
