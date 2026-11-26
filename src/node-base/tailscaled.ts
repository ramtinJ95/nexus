/**
 * tailscaled's LocalAPI over its Unix socket, for every Nexus process and the bootstrap deployer, so it imports only
 * Node's builtins and modules that do too: who is on the other end of a tailnet connection, this node's HTTPS
 * certificate, and its status. Both sides use whois: the probe checks its callers, and the control plane checks that it reached the
 * probe it meant to.
 */
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { request } from "node:http";
import { isIPv6, type Socket } from "node:net";
import { BodyTooLarge, readBody } from "./request-body.ts";
import type { TailnetNodeId } from "../ids.ts";
import type { Whois } from "../protocol/http.ts";

/**
 * Who owns a tailnet device: a person's device carries its owner's login, UserProfile.LoginName, and a tagged device
 * its tags and no user, because tailscaled names every tagged device's owner "tagged-devices".
 */
export type TailnetIdentity = { user: string; tags: readonly [] } | { user: null; tags: readonly string[] };

/** A caller as whois names it: the stable node ID and who owns the device. */
export type TailnetCaller = { id: TailnetNodeId } & TailnetIdentity;

/** Whois with who owns the device. */
export type WhoisCaller = (address: string, port: number) => Promise<TailnetCaller | null>;

/** Whois with the node's MagicDNS name, such as infra-testbench.example.ts.net, which tailscaled reports as Node.Name. */
export type WhoisNode = (address: string, port: number) => Promise<TailnetCaller & { host: string } | null>;

/** Tailscale's stable node ID, for the bootstrap deployer, which has neither zod nor tailnetNodeIdSchema in protocol/fields.ts. */
export const tailnetNodeIdPattern = /^n[A-Za-z0-9]+$/;

export const linuxTailscaledSocket = "/var/run/tailscale/tailscaled.sock";

/** LocalAPI `GET /localapi/v0/whois?addr=ip:port` over tailscaled's Unix socket. */
export function localApiWhois(socketPath: string = linuxTailscaledSocket): Whois {
  return async (address, port) => (await whois(socketPath, address, port))?.id ?? null;
}

export function localApiWhoisCaller(socketPath: string = linuxTailscaledSocket): WhoisCaller {
  return async (address, port) => {
    const answer = await whois(socketPath, address, port);
    return answer === null ? null : { id: answer.id, ...answer.identity };
  };
}

export function localApiWhoisNode(socketPath: string = linuxTailscaledSocket): WhoisNode {
  return async (address, port) => {
    const answer = await whois(socketPath, address, port);
    if (answer === null) return null;
    if (answer.host === null) throw new Error(`tailscaled whois ${hostPort(address, port)}: response has no Node.Name`);
    return { id: answer.id, host: answer.host, ...answer.identity };
  };
}

async function whois(socketPath: string, address: string, port: number): Promise<KeptWhois | null> {
  const addr = hostPort(address, port);
  const res = await localApiGet(socketPath, `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`, `whois ${addr}`, 1 << 20);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`tailscaled whois ${addr}: HTTP ${res.status}: ${res.body.trim()}`);
  try {
    return parseWhois(JSON.parse(res.body));
  } catch (err) {
    throw new Error(`tailscaled whois ${addr}: ${(err as Error).message}`);
  }
}

/** What Nexus keeps of a LocalAPI whois answer. */
export interface KeptWhois { id: TailnetNodeId; host: string | null; identity: TailnetIdentity }

/**
 * Node.StableID, Node.Name without its trailing dot, and who owns the device. A device with Node.Tags is tagged, and
 * its UserProfile is tailscaled's placeholder. Any other device's user is UserProfile.LoginName, or none when the
 * answer has none.
 */
export function parseWhois(answer: unknown): KeptWhois {
  const { Node: node, UserProfile: profile } = (answer ?? {}) as { Node?: { StableID?: unknown; Name?: unknown; Tags?: unknown }; UserProfile?: { LoginName?: unknown } };
  if (typeof node?.StableID !== "string" || node.StableID === "") throw new Error("response has no Node.StableID");
  const host = typeof node.Name === "string" && node.Name !== "" ? node.Name.replace(/\.$/, "") : null;
  const tags = Array.isArray(node.Tags) ? node.Tags.filter((tag): tag is string => typeof tag === "string") : [];
  const login = profile?.LoginName;
  const identity: TailnetIdentity = tags.length > 0 || typeof login !== "string" || login === "" ? { user: null, tags } : { user: login, tags: [] };
  return { id: node.StableID as TailnetNodeId, host, identity };
}

function hostPort(address: string, port: number): string {
  // Dual-stack sockets report IPv4 peers as IPv4-mapped IPv6 addresses, which tailscaled does not match.
  const ip = address.startsWith("::ffff:") && !isIPv6(address.slice(7)) ? address.slice(7) : address;
  return isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
}

/** A GET over tailscaled's Unix socket. `what` names the request in its errors: an answer over `limit` characters, or none within `timeoutMs`. */
function localApiGet(socketPath: string, path: string, what: string, limit: number, timeoutMs?: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // tailscaled refuses LocalAPI requests with any other Host, as a DNS rebinding defence.
    const req = request({ socketPath, method: "GET", path, headers: { host: "local-tailscaled.sock" } }, (res) => {
      readBody(res, limit).then((body) => resolve({ status: res.statusCode ?? 0, body }), (err: Error) => {
        const error = err instanceof BodyTooLarge ? new Error(`tailscaled ${what} response too large`) : err;
        req.destroy(error);
        reject(error);
      });
    });
    if (timeoutMs !== undefined) {
      const deadline = setTimeout(() => req.destroy(new Error(`tailscaled ${what} request timed out`)), timeoutMs);
      req.on("close", () => clearTimeout(deadline));
    }
    req.on("error", reject);
    req.end();
  });
}

/**
 * Why verifyPeer refused a connection. `peer` is null when it closed before whois could ask, and otherwise the
 * address it came from and the node whois named there, null for none.
 */
export class PeerRefused extends Error {
  readonly peer: { address: string; port: number; id: TailnetNodeId | null } | null;
  constructor(peer: PeerRefused["peer"]) {
    super(peer === null ? "the connection closed before whois" : `${peer.address}:${peer.port} is tailnet node ${peer.id ?? "unknown"}`);
    this.peer = peer;
  }
}

/**
 * Resolves once whois names the socket's peer as a node `accepts`, waiting first for a socket still connecting.
 * Rejects with PeerRefused, or with whois's own error when tailscaled cannot answer. The bootstrap deployer checks the
 * control plane with it. The probe transports use protocol/http.ts's, which the bootstrap does not have.
 */
export async function verifyPeer(socket: Socket, whois: Whois, accepts: (id: TailnetNodeId) => boolean): Promise<void> {
  if (socket.connecting) await new Promise((settled) => socket.once("connect", settled).once("close", settled));
  const { remoteAddress: address, remotePort: port } = socket;
  if (address === undefined || port === undefined) throw new PeerRefused(null);
  const id = await whois(address, port);
  if (id === null || !accepts(id)) throw new PeerRefused({ address, port, id });
}

/**
 * LocalAPI `GET /localapi/v0/status`: the JSON `tailscale status --json` prints, for src/tailscale.ts's
 * parseTailscaleStatus, which the bootstrap does not have. Any local user may read it. A large tailnet's runs to megabytes.
 */
export async function localApiStatus(socketPath = linuxTailscaledSocket): Promise<string> {
  const res = await localApiGet(socketPath, "/localapi/v0/status", "status", 16 * 1024 * 1024, 30_000);
  if (res.status !== 200) throw new Error(`tailscaled status: HTTP ${res.status}`);
  return res.body;
}

export interface Certificate { key: string; cert: string }

/** Cert-only LocalAPI permission comes from tailscaled's TS_PERMIT_CERT_UID, not operator access. */
export async function localApiCertificate(hostname: string, socketPath = linuxTailscaledSocket): Promise<Certificate> {
  const res = await localApiGet(socketPath, `/localapi/v0/cert/${encodeURIComponent(hostname)}?type=pair&min_validity=168h`, "certificate", 128 * 1024, 60_000);
  if (res.status !== 200) throw new Error(`tailscaled certificate: HTTP ${res.status}`);
  const pem = res.body;
  const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)?.join("\n");
  const key = pem.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/)?.[0];
  if (!cert || !key) throw new Error("tailscaled certificate response has no certificate/key pair");
  const leaf = new X509Certificate(cert);
  if (!leaf.checkHost(hostname) || Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) {
    throw new Error("tailscaled certificate is not currently valid for the dashboard hostname");
  }
  createSecureContext({ cert, key });
  return { cert, key };
}
