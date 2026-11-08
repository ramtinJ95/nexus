/**
 * The local tailscale, for every Nexus process and the bootstrap deployer, so it imports only Node's builtins and
 * modules that do too: what `tailscale status --json` says about this node and its tailnet, the CLI that prints it,
 * and who is on the other end of a tailnet connection. Both sides use whois: the probe checks its callers, and the
 * control plane checks that it reached the probe it meant to.
 */
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { request } from "node:http";
import { isIPv6, type Socket } from "node:net";
import { output } from "./exec.ts";
import { BodyTooLarge, readBody } from "./node-base/request-body.ts";
import type { TailnetNodeId } from "./ids.ts";
import type { Whois } from "./protocol/http.ts";

/** Whois with the node's MagicDNS name, such as infra-testbench.example.ts.net, which tailscaled reports as Node.Name. */
export type WhoisNode = (address: string, port: number) => Promise<{ id: TailnetNodeId; host: string } | null>;

/** Tailscale's stable node ID, for the bootstrap deployer, which has neither zod nor tailnetNodeIdSchema in protocol/fields.ts. */
export const tailnetNodeIdPattern = /^n[A-Za-z0-9]+$/;

/** Runs the tailscale CLI and resolves to its stdout. Rejects when it exits nonzero or runs past 30 s. */
export type TailscaleCli = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

/** The binary is looked up on PATH. On the nodes it is the home tailnet's `tailscale`. A large tailnet's status runs to megabytes. */
export function tailscaleCli(binary = "tailscale"): TailscaleCli {
  return (args, signal) => output(binary, args, { signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
}

/** A device as `tailscale status --json` lists it. Each field is null when the device reports none. */
export interface TailnetDevice {
  id: string | null;
  /** The MagicDNS name, without its root dot. A DNSName of "." gives "". */
  host: string | null;
  /** The first IPv4 address of its TailscaleIPs. */
  ipv4: string | null;
}

export interface TailscaleStatus {
  /** tailscaled is up and logged in. */
  running: boolean;
  magicDns: boolean;
  /** The tailnet has HTTPS certificates turned on, so CertDomains names this node's domain. */
  certificates: boolean;
  self: TailnetDevice | null;
  peers: readonly TailnetDevice[];
}

/** `tailscale status --json`. Throws only on text that is not JSON. */
export function parseTailscaleStatus(json: string): TailscaleStatus {
  const status = JSON.parse(json) as {
    BackendState?: unknown; CurrentTailnet?: { MagicDNSEnabled?: unknown } | null; CertDomains?: unknown; Self?: unknown; Peer?: Record<string, unknown> | null;
  } | null;
  return {
    running: status?.BackendState === "Running",
    magicDns: status?.CurrentTailnet?.MagicDNSEnabled === true,
    certificates: Array.isArray(status?.CertDomains) && status.CertDomains.length > 0,
    self: tailnetDevice(status?.Self),
    peers: Object.values(status?.Peer ?? {}).flatMap((p) => tailnetDevice(p) ?? []),
  };
}

function tailnetDevice(raw: unknown): TailnetDevice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { ID, DNSName, TailscaleIPs } = raw as { ID?: unknown; DNSName?: unknown; TailscaleIPs?: unknown };
  const nonEmpty = (value: unknown) => typeof value === "string" && value !== "" ? value : null;
  const ipv4 = Array.isArray(TailscaleIPs) ? TailscaleIPs.find((a): a is string => typeof a === "string" && !a.includes(":")) : undefined;
  return { id: nonEmpty(ID), host: nonEmpty(DNSName)?.replace(/\.$/, "") ?? null, ipv4: ipv4 ?? null };
}

export async function tailscaleStatus(cli: TailscaleCli): Promise<TailscaleStatus> {
  return parseTailscaleStatus(await cli(["status", "--json"]));
}

/** This node's MagicDNS name. Preview URLs name the node by it, because that is the name its tailscale serve certificate is for. */
export function selfDnsName(status: TailscaleStatus): string {
  if (status.self === null) throw new Error("tailscale status --json has no Self.DNSName: status.Self is missing");
  if (status.self.host === null || status.self.host === "") throw new Error("tailscale reports no MagicDNS name for this node, so previews have no host to be served under. Turn on MagicDNS for the tailnet");
  return status.self.host;
}

export const linuxTailscaledSocket = "/var/run/tailscale/tailscaled.sock";

/** LocalAPI `GET /localapi/v0/whois?addr=ip:port` over tailscaled's Unix socket. */
export function localApiWhois(socketPath: string = linuxTailscaledSocket): Whois {
  return async (address, port) => (await whois(socketPath, address, port))?.id ?? null;
}

export function localApiWhoisNode(socketPath: string = linuxTailscaledSocket): WhoisNode {
  return async (address, port) => {
    const node = await whois(socketPath, address, port);
    if (node?.host === null) throw new Error(`tailscaled whois ${hostPort(address, port)}: response has no Node.Name`);
    return node as { id: TailnetNodeId; host: string } | null;
  };
}

async function whois(socketPath: string, address: string, port: number): Promise<{ id: TailnetNodeId; host: string | null } | null> {
  const addr = hostPort(address, port);
  const res = await localApiGet(socketPath, `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`, `whois ${addr}`, 1 << 20);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`tailscaled whois ${addr}: HTTP ${res.status}: ${res.body.trim()}`);
  let node: { StableID?: unknown; Name?: unknown } | undefined;
  try {
    node = (JSON.parse(res.body) as { Node?: { StableID?: unknown; Name?: unknown } }).Node;
  } catch (err) {
    throw new Error(`tailscaled whois ${addr}: ${(err as Error).message}`);
  }
  if (typeof node?.StableID !== "string" || node.StableID === "") throw new Error(`tailscaled whois ${addr}: response has no Node.StableID`);
  const host = typeof node.Name === "string" && node.Name !== "" ? node.Name.replace(/\.$/, "") : null;
  return { id: node.StableID as TailnetNodeId, host };
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
