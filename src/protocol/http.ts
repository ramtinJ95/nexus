/** Probe contract, the errors a call to a probe fails with, and reading a reply's body. */
import type { IncomingMessage } from "node:http";

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

export async function text(res: IncomingMessage): Promise<string> {
  res.setEncoding("utf8");
  let body = "";
  for await (const chunk of res as AsyncIterable<string>) body += chunk;
  return body;
}
