/**
 * The TCP ports a pylon's apps listen on, from /proc/net/tcp and /proc/net/tcp6, because the image has no `ss`.
 * Only a socket a preview reaches counts: one bound to 127.0.0.1, to 0.0.0.0, to `::` (dual-stack, as Linux binds it
 * by default), to the IPv4-mapped form of 127.0.0.1 or 0.0.0.0, or to `::1`. The preview ingress (Gondolin's
 * IngressGateway) dials only the guest's 127.0.0.1, so the pylon's loopback relay (src/pylon-vm/relay.ts) carries each
 * preview on to 127.0.0.1 or `::1`. One bound to another loopback address such as 127.0.0.2, or to any other address,
 * is left out, and so are Nexus's own listeners, the relay's among them.
 */
import type { Guest } from "./backend.ts";
import { reservedPorts } from "./project.ts";
import type { ListeningFact } from "./protocol/observations.ts";

/** The kernel's TCP_LISTEN state, as /proc/net/tcp prints it. */
const listenState = "0A";

/**
 * The kernel prints each 32-bit word of an address in host byte order, little-endian on x86, so 127.0.0.1 is
 * 0100007F, `::ffff:127.0.0.1` is 0000000000000000FFFF00000100007F and `::1` is 00000000000000000000000001000000.
 */
const reachable: ReadonlySet<string> = new Set([
  "00000000", "0100007F",
  "00000000000000000000000000000000", "0000000000000000FFFF000000000000", "0000000000000000FFFF00000100007F",
  "00000000000000000000000001000000",
]);

/** Each reachable listening port once, in order, from the text of /proc/net/tcp and /proc/net/tcp6 one after the other. */
export function parseListening(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    const m = /^\s*\d+:\s+([0-9A-F]+):([0-9A-F]{4})\s+[0-9A-F]+:[0-9A-F]{4}\s+([0-9A-F]{2})\s/.exec(line);
    if (m === null || m[3] !== listenState || !reachable.has(m[1]!)) continue;
    const port = parseInt(m[2]!, 16);
    if (!reservedPorts.has(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** One exec. A guest without IPv6 has no tcp6 file, which reads as no IPv6 listeners. Any other failure rejects. */
export async function listeningFacts(guest: Guest, timeoutMs: number): Promise<readonly ListeningFact[]> {
  const read = await guest.exec(["sh", "-c", "cat /proc/net/tcp && { cat /proc/net/tcp6 2>/dev/null || true; }"], { cwd: "/", timeoutMs });
  if (read.exitCode !== 0) throw new Error(`reading /proc/net/tcp exited ${read.exitCode}: ${read.output.trim()}`);
  return parseListening(read.output).map((port) => ({ port }));
}
