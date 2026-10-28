import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Certificate } from "./tailscale.ts";

export async function testCertificate(dir: string, hostname = "dashboard.example.ts.net"): Promise<Certificate> {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  // Distinct subjects let OpenSSL and LibreSSL select either self-signed trust anchor during rotation.
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${hostname}/OU=${randomUUID()}`, "-addext", `subjectAltName=${isIP(hostname) === 0 ? "DNS" : "IP"}:${hostname}`, "-keyout", key, "-out", cert]);
  return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
}
