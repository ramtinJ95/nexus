import type { IncomingMessage } from "node:http";

export class BodyTooLarge extends Error {
  constructor(limit: number) { super(`request body over ${limit} bytes`); }
}

/** Reads the request's body as text. Throws BodyTooLarge once it passes `limit` characters, leaving the rest unread. */
export async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req as AsyncIterable<string>) {
    body += chunk;
    if (body.length > limit) throw new BodyTooLarge(limit);
  }
  return body;
}
