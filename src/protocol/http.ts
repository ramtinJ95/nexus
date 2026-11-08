import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { TailnetNodeId } from "../ids.ts";

export const probeErrorCodes = ["unreachable", "not-running", "forbidden"] as const;
export type ProbeError = { code: typeof probeErrorCodes[number]; message: string };

/**
 * A probe answered with a status its method gives no meaning, other than in a reply the method parses. `code` is set
 * only for a status that means a ProbeError: 403 is `forbidden`, and 409 to a command or stream `not-running`.
 */
export class ProbeHttpError extends Error {
  readonly status: number;
  declare readonly code?: Extract<ProbeError["code"], "forbidden" | "not-running">;
  constructor(message: string, status: number, code?: ProbeHttpError["code"]) {
    super(message);
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export function probeError(code: ProbeError["code"], message: string): Error & ProbeError {
  return Object.assign(new Error(message), { code });
}
export function isProbeError(err: unknown): err is Error & ProbeError {
  return err instanceof Error && "code" in err && (probeErrorCodes as readonly unknown[]).includes(err.code);
}

/** Resolves to null when tailscaled knows no tailnet node at that address. Rejects when tailscaled cannot answer. */
export type Whois = (address: string, port: number) => Promise<TailnetNodeId | null>;

/**
 * Resolves once whois names the socket's peer as a node `accepts`, waiting first for a socket still connecting. Rejects
 * with `unreachable` and `closed` when it closed before whois could ask, with `forbidden` and `refused(id, address:port)`
 * when whois names no node there or one `accepts` refuses, and with whois's own error when tailscaled cannot answer.
 */
export async function verifyPeer(socket: Socket, whois: Whois, accepts: (id: TailnetNodeId) => boolean, closed: string, refused: (id: TailnetNodeId | null, at: string) => string): Promise<void> {
  if (socket.connecting) await new Promise((settled) => socket.once("connect", settled).once("close", settled));
  const { remoteAddress: address, remotePort: port } = socket;
  if (address === undefined || port === undefined) throw probeError("unreachable", closed);
  const id = await whois(address, port);
  if (id === null || !accepts(id)) throw probeError("forbidden", refused(id, `${address}:${port}`));
}

export async function text(res: IncomingMessage): Promise<string> {
  res.setEncoding("utf8");
  let body = "";
  for await (const chunk of res as AsyncIterable<string>) body += chunk;
  return body;
}
