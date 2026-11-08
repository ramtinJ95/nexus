/**
 * The local tailscale CLI, for every Nexus process and the installers, so it imports only Node's builtins and modules
 * that do too: what `tailscale status --json` says about this node and its tailnet, and the CLI that prints it.
 */
import { output } from "./exec.ts";

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
