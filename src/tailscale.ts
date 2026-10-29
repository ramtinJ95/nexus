/**
 * Who is on the other end of a tailnet connection, from the local tailscaled. Both sides use it: the probe
 * checks its callers, and the control plane checks that it reached the probe it meant to.
 */
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { request } from "node:http";
import { isIPv6 } from "node:net";
import type { TailnetNodeId } from "./protocol.ts";

/** Resolves to null when tailscaled knows no tailnet node at that address. Rejects when tailscaled cannot answer. */
export type Whois = (address: string, port: number) => Promise<TailnetNodeId | null>;
/** Whois with the node's MagicDNS name, such as infra-testbench.example.ts.net, which tailscaled reports as Node.Name. */
export type WhoisNode = (address: string, port: number) => Promise<{ id: TailnetNodeId; host: string } | null>;

/** Tailscale's stable node ID. The bootstrap deployer checks it without protocol.ts, whose zod it does not have. */
export const tailnetNodeIdPattern = /^n[A-Za-z0-9]+$/;

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

function whois(socketPath: string, address: string, port: number): Promise<{ id: TailnetNodeId; host: string | null } | null> {
  return new Promise((resolve, reject) => {
    const addr = hostPort(address, port);
    const req = request({
      socketPath,
      method: "GET",
      path: `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`,
      // tailscaled refuses LocalAPI requests with any other Host, as a DNS rebinding defence.
      headers: { host: "local-tailscaled.sock" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`tailscaled whois ${addr}: HTTP ${res.statusCode}: ${body.trim()}`));
        let node: { StableID?: unknown; Name?: unknown } | undefined;
        try {
          node = (JSON.parse(body) as { Node?: { StableID?: unknown; Name?: unknown } }).Node;
        } catch (err) {
          return reject(new Error(`tailscaled whois ${addr}: ${(err as Error).message}`));
        }
        if (typeof node?.StableID !== "string" || node.StableID === "") return reject(new Error(`tailscaled whois ${addr}: response has no Node.StableID`));
        const host = typeof node.Name === "string" && node.Name !== "" ? node.Name.replace(/\.$/, "") : null;
        resolve({ id: node.StableID as TailnetNodeId, host });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function hostPort(address: string, port: number): string {
  // Dual-stack sockets report IPv4 peers as IPv4-mapped IPv6 addresses, which tailscaled does not match.
  const ip = address.startsWith("::ffff:") && !isIPv6(address.slice(7)) ? address.slice(7) : address;
  return isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
}


export interface Certificate { key: string; cert: string }

/** Cert-only LocalAPI permission comes from tailscaled's TS_PERMIT_CERT_UID, not operator access. */
export async function localApiCertificate(hostname: string, socketPath = linuxTailscaledSocket): Promise<Certificate> {
  const pem = await new Promise<string>((resolve, reject) => {
    const req = request({
      socketPath,
      path: `/localapi/v0/cert/${encodeURIComponent(hostname)}?type=pair&min_validity=168h`,
      headers: { host: "local-tailscaled.sock" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 128 * 1024) req.destroy(new Error("tailscaled certificate response too large"));
      });
      res.on("error", reject);
      res.on("end", () => res.statusCode === 200 ? resolve(body) : reject(new Error(`tailscaled certificate: HTTP ${res.statusCode}`)));
    });
    const deadline = setTimeout(() => req.destroy(new Error("tailscaled certificate request timed out")), 60_000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end();
  });
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
