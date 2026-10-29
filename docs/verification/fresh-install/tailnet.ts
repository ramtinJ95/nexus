/**
 * The tailnet the test makes up, served from the host: for each machine, the LocalAPI socket its tailscaled would
 * serve, which answers whois and certificates. Whois names the machine whose process holds the TCP peer's socket, found
 * through /proc, so it tells the machines apart although they share one network namespace. A certificate is
 * self-signed for the machine's MagicDNS name, and handed to any caller.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, readlink, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { testCertificate } from "../../../src/test-certificate.ts";
import type { Certificate } from "../../../src/tailscale.ts";

export interface Device {
  id: string;
  /** The short MagicDNS name, such as fresh-box. */
  name: string;
  ip: string;
  /** Where the machine's root is, on the host. */
  root: string;
}

export const suffix = "tailfake0.ts.net";
export const host = (d: Device) => `${d.name}.${suffix}`;

function peer(d: Device, online = true) {
  return { ID: d.id, HostName: d.name, DNSName: `${host(d)}.`, TailscaleIPs: [d.ip], Online: online, OS: "linux" };
}

/** `tailscale status --json` on `self`, in the fields the installer reads. */
export function status(self: Device, all: readonly Device[]): string {
  return JSON.stringify({
    BackendState: "Running",
    Self: peer(self),
    Peer: Object.fromEntries(all.filter((d) => d !== self).map((d) => [`nodekey:${d.id}`, peer(d)])),
    CurrentTailnet: { Name: "fresh-install-test", MagicDNSSuffix: suffix, MagicDNSEnabled: true },
    MagicDNSSuffix: suffix,
    CertDomains: [host(self)],
  }, null, 2);
}

/** /proc/net/tcp's local_address for ip:port: each 32-bit word in host order, as hex. */
function procAddress(ip: string, port: number): string[] {
  const word = ip.split(".").map(Number).reverse().map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const p = port.toString(16).padStart(4, "0").toUpperCase();
  return [`${word}:${p}`, `0000000000000000FFFF0000${word}:${p}`];
}

async function socketInode(ip: string, port: number): Promise<string | undefined> {
  const wanted = procAddress(ip, port);
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (await readFile(table, "utf8")).split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (wanted.includes(fields[1] ?? "") && fields[9] !== "0") return fields[9];
    }
  }
  return undefined;
}

/** The PID namespace of the process that holds the socket, which names its machine. */
async function holderNamespace(inode: string): Promise<string | undefined> {
  const link = `socket:[${inode}]`;
  for (const pid of (await readdir("/proc")).filter((p) => /^\d+$/.test(p))) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
    for (const fd of fds) {
      if (await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "") === link) return readlink(`/proc/${pid}/ns/pid`).catch(() => undefined);
    }
  }
  return undefined;
}

export interface Tailnet {
  /** Where each machine's tailscaled socket is, inside its root. */
  readonly socket: string;
  /** Each machine's dashboard certificate, which a client trusts as it would trust Let's Encrypt. */
  readonly certificates: ReadonlyMap<string, Certificate>;
  close(): Promise<void>;
}

/** `namespaces` maps each machine's PID namespace, as /proc/<pid>/ns/pid reads it, to the machine. */
export async function startTailnet(devices: readonly Device[], namespaces: () => ReadonlyMap<string, Device>, scratch: string): Promise<Tailnet> {
  const socket = "/run/tailscale/tailscaled.sock";
  const certificates = new Map<string, Certificate>();
  for (const d of devices) {
    const dir = join(scratch, `cert-${d.name}`);
    await mkdir(dir, { recursive: true });
    certificates.set(host(d), await testCertificate(dir, host(d)));
  }
  const servers: Server[] = [];
  for (const d of devices) {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://local-tailscaled.sock");
      if (url.pathname === "/localapi/v0/whois") {
        const [ip, port] = (url.searchParams.get("addr") ?? "").split(":");
        const inode = await socketInode(ip!, Number(port));
        const ns = inode === undefined ? undefined : await holderNamespace(inode);
        const found = ns === undefined ? undefined : namespaces().get(ns);
        if (found === undefined) return res.writeHead(404).end("no match for IP:port\n");
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          Node: { ID: 1, StableID: found.id, Name: `${host(found)}.`, Addresses: [`${found.ip}/32`] },
          UserProfile: { LoginName: "person@example.com" },
        }));
      }
      const cert = /^\/localapi\/v0\/cert\/(.+)$/.exec(url.pathname);
      if (cert !== null && url.searchParams.get("type") === "pair") {
        const pair = certificates.get(decodeURIComponent(cert[1]!));
        if (pair === undefined) return res.writeHead(500).end("invalid domain\n");
        return res.writeHead(200).end(`${pair.key}\n${pair.cert}\n`);
      }
      res.writeHead(404).end(`the stand-in tailscaled does not serve ${url.pathname}\n`);
    });
    const path = join(d.root, socket);
    await mkdir(dirname(path), { recursive: true });
    if (existsSync(path)) await rm(path);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    await chmod(path, 0o666);
    servers.push(server);
  }
  return {
    socket,
    certificates,
    close: () => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve).closeAllConnections()))).then(() => undefined),
  };
}
