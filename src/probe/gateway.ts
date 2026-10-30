/**
 * The preview gateway: one loopback HTTP server behind every `tailscale serve --https=<port>` entry the probe
 * owns. Serve keeps the public `Host`, so the port in it names the preview (S6). The gateway forwards to that
 * pylon's preview origin, streaming bodies and passing websocket upgrades through.
 */
import { once } from "node:events";
import { STATUS_CODES, createServer, request, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeader, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { pipeline } from "node:stream";
import type { PreviewOrigin } from "../backend.ts";
import type { ServiceName } from "../project.ts";
import type { PylonId } from "../protocol.ts";

export interface PreviewRoute { pylonId: PylonId; service: ServiceName }

/** Human activity on a preview. The control plane counts it toward the pylon's lastHumanActivityAt. */
export interface PreviewHit extends PreviewRoute { at: string; login: string | null }

export interface GatewayOptions {
  /** 0 picks a free port. A real probe keeps it fixed, because serve entries that proxy to it are the probe's (see serve.ts). */
  port: number;
  /** The table to route by, as loaded from the routes file. It becomes PreviewGateway.routes. */
  routes: Map<number, PreviewRoute>;
  /** A browser gets a waking page for `unavailable`. A throw is a fault, which is logged and answered with 502. */
  origin(route: PreviewRoute): PreviewOrigin | { unavailable: string };
  /** Called on the first request for a route, then at most once per hitIntervalMs. */
  onHit(hit: PreviewHit): void;
  /** Default console.error. */
  log?: (message: string) => void;
}

export interface PreviewGateway {
  readonly origin: `http://127.0.0.1:${number}`;
  /** https port to route. Only the TailscaleServe that publishes the ports writes it. An unmapped port gets 404. */
  readonly routes: Map<number, PreviewRoute>;
  close(): Promise<void>;
}

/**
 * A request carrying this header with the value `<pylonId>/<service>` is answered by the gateway itself: 204 when
 * its port routes there, 421 otherwise. The serve owner warms a new URL with it, which proves the TLS listener and
 * the routing without touching the guest or counting as a hit.
 */
export const warmHeader = "x-nexus-warm";

/** A page load is dozens of requests. The idle policy works in minutes, so one hit a minute loses nothing. */
const hitIntervalMs = 60_000;
const wakingRetrySeconds = 3;

const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

type Answer = { status: number; headers: OutgoingHttpHeaders; body: string };

export async function startGateway(options: GatewayOptions): Promise<PreviewGateway> {
  const { routes } = options;
  const log = options.log ?? console.error;
  const lastHit = new Map<string, number>();
  /** Upgraded sockets leave the HTTP server's bookkeeping, so closeAllConnections does not reach them. */
  const tunnels = new Set<Socket>();

  function reportHit(route: PreviewRoute, req: IncomingMessage) {
    const key = `${route.pylonId}/${route.service}`;
    const now = Date.now();
    if (now - (lastHit.get(key) ?? -Infinity) < hitIntervalMs) return;
    lastHit.set(key, now);
    const login = req.headers["tailscale-user-login"];
    options.onHit({ ...route, at: new Date(now).toISOString(), login: typeof login === "string" ? login : null });
  }

  /** Either the gateway's own answer, or where to forward the request. */
  function resolve(req: IncomingMessage): Answer | { origin: URL; port: number } {
    const port = hostPort(req.headers.host);
    const route = port === null ? undefined : routes.get(port);
    if (port === null || route === undefined) return plain(404, `no preview is published on ${req.headers.host ?? "a request without Host"}`);
    const warm = req.headers[warmHeader];
    if (warm !== undefined) {
      return warm === `${route.pylonId}/${route.service}` ? plain(204, "") : plain(421, `port ${port} routes to ${route.pylonId}/${route.service}`);
    }
    // Reported before the origin is asked, because a hit on a paused pylon is what wakes it.
    reportHit(route, req);
    try {
      const origin = options.origin(route);
      return typeof origin === "string" ? { origin: new URL(origin), port } : waking(req, route, origin.unavailable);
    } catch (err) {
      const message = `the preview origin of ${route.service} on ${route.pylonId} failed: ${(err as Error).message}`;
      log(message);
      return plain(502, message);
    }
  }

  function forward(req: IncomingMessage, res: ServerResponse) {
    const target = resolve(req);
    if ("status" in target) return res.writeHead(target.status, target.headers).end(target.body);
    const upstream = request(target.origin, { method: req.method, path: req.url, headers: forwardedHeaders(req, target.port, false) }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, toBrowser(up.headers, req.headers.host));
      pipeline(up, res, () => {});
    });
    upstream.on("error", (err) => {
      if (res.headersSent) return res.destroy(err);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(`the preview origin did not answer: ${err.message}`);
    });
    req.pipe(upstream);
    res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
  }

  function upgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    socket.on("error", () => socket.destroy());
    // The HTTP server allows half-open sockets, so a browser that leaves gives "end" and never "close" by itself.
    socket.on("end", () => socket.destroy());
    const target = resolve(req);
    if ("status" in target) return socket.end(rawResponse(target.status, { ...target.headers, connection: "close" }, target.body));
    const upstream = request(target.origin, { method: req.method, path: req.url, headers: forwardedHeaders(req, target.port, true) });
    socket.on("close", () => upstream.destroy());
    upstream.on("upgrade", (up, upSocket, upHead) => {
      if (socket.destroyed) return upSocket.destroy();
      socket.write(rawResponse(101, up.headers, "", up.statusMessage));
      if (upHead.length > 0) socket.write(upHead);
      if (head.length > 0) upSocket.write(head);
      upSocket.on("error", () => socket.destroy());
      socket.on("close", () => upSocket.destroy());
      upSocket.on("close", () => socket.destroy());
      socket.pipe(upSocket).pipe(socket);
    });
    // The origin refused the upgrade with an ordinary response. Relay it and close.
    upstream.on("response", (up) => {
      socket.write(rawResponse(up.statusCode ?? 502, { ...toBrowser(up.headers, req.headers.host), connection: "close" }, "", up.statusMessage));
      pipeline(up, socket, () => {});
    });
    upstream.on("error", (err) => socket.end(rawResponse(502, { "content-type": "text/plain; charset=utf-8", connection: "close" }, `the preview origin did not answer: ${err.message}`)));
    upstream.end();
  }

  const server = createServer(forward);
  server.on("upgrade", upgrade);
  server.listen(options.port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`unexpected gateway address ${address}`);

  return {
    origin: `http://127.0.0.1:${address.port}`,
    routes,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of tunnels) socket.destroy();
      await closed;
    },
  };
}

function plain(status: number, body: string, headers: OutgoingHttpHeaders = {}): Answer {
  return { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers }, body };
}

/** A browser gets a page that reloads until the pylon answers. Anything else gets the reason as text. */
function waking(req: IncomingMessage, route: PreviewRoute, reason: string): Answer {
  const headers = { "retry-after": String(wakingRetrySeconds), "cache-control": "no-store" };
  if (!(req.headers.accept ?? "").includes("text/html")) return plain(503, `${route.pylonId} cannot serve ${route.service} yet: ${reason}`, headers);
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="${wakingRetrySeconds}"><title>Waking ${route.service}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 32rem">
<h1>Waking this pylon</h1><p>${route.service} on ${route.pylonId} will load here once the pylon is running. This page retries every ${wakingRetrySeconds} s.</p>
</body></html>
`;
  return { status: 503, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body };
}

/** The port the client dialled. Serve's Host is the public `<node>.<tailnet>.ts.net:<port>`, and a bare name means 443. */
function hostPort(host: string | undefined): number | null {
  if (host === undefined) return null;
  try {
    const { port } = new URL(`https://${host}`);
    return port === "" ? 443 : Number(port);
  } catch {
    return null;
  }
}

/**
 * Host stays the public one, which is what PUBLIC_URL names and what dev servers check. The guest only ever sees
 * plain HTTP from the gateway, so x-forwarded-* carry the scheme and address the browser used. The tailscale-user-*
 * identity headers pass through. Serve sets them and drops any a client sent.
 */
function forwardedHeaders(req: IncomingMessage, port: number, upgrading: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = endToEnd(req.headers);
  if (upgrading) {
    headers.connection = "upgrade";
    if (req.headers.upgrade !== undefined) headers.upgrade = req.headers.upgrade;
  }
  const forwardedFor = req.headers["x-forwarded-for"];
  const peer = req.socket.remoteAddress;
  headers["x-forwarded-for"] = [forwardedFor, peer].filter((v) => v !== undefined).join(", ");
  headers["x-forwarded-proto"] = "https";
  if (req.headers.host !== undefined) headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-port"] = String(port);
  return headers;
}

/** Drops hop-by-hop headers, including any the Connection header names. */
function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set((headers.connection ?? "").split(",").map((h) => h.trim().toLowerCase()));
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !hopByHop.has(name) && !named.has(name)) out[name] = value;
  }
  return out;
}

/**
 * An app that builds absolute URLs from its own scheme redirects to `http://<host>`, which serve does not listen on,
 * so that Location becomes https. Its pages link http:// subresources too, so every response also carries
 * upgrade-insecure-requests as a CSP of its own, which leaves the guest's own policy as it was. The browser also
 * upgrades navigations to http:// on this hostname at any port, so a link from a preview to a plain-HTTP port on the
 * node, such as the dashboard's, fails. Mixed content in previews matters more than such links.
 */
function toBrowser(headers: IncomingHttpHeaders, host: string | undefined): OutgoingHttpHeaders {
  const out = endToEnd(headers);
  const location = headers.location;
  if (location !== undefined && host !== undefined && /^http:\/\//i.test(location) && sameHost(location, host)) out.location = `https://${location.slice("http://".length)}`;
  // Node's types allow one string here, but writeHead sends an array as one header line per value.
  (out as Record<string, OutgoingHttpHeader>)["content-security-policy"] = [headers["content-security-policy"] ?? [], "upgrade-insecure-requests"].flat();
  return out;
}

function sameHost(url: string, host: string): boolean {
  try {
    return new URL(url).host === new URL(`http://${host}`).host;
  } catch {
    return false;
  }
}

export function rawResponse(status: number, headers: IncomingHttpHeaders | OutgoingHttpHeaders, body: string, statusMessage = STATUS_CODES[status] ?? ""): string {
  const lines = [`HTTP/1.1 ${status} ${statusMessage}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  if (body !== "") lines.push(`content-length: ${Buffer.byteLength(body)}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}
