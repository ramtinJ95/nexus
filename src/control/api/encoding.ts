/**
 * How the API writes a reply body: compressed with the best coding the client accepts, for a text type over
 * `minBytes`, and a page with an ETag its next read can send back for a 304. Event streams and WebSockets never pass
 * here.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

export type Coding = "br" | "gzip";
/** A body's compressed form in a coding. */
export type Encode = (coding: Coding) => Promise<Buffer>;

/** Below this a compressed body saves less than its round trip costs. */
export const minBytes = 1024;
const compressibleType = /^(text\/(html|css|javascript)|application\/json|image\/svg\+xml)(;|$)/;
/** Brotli's fifth level is about gzip's speed with a smaller result, so a body made per request uses it. */
const perRequest = { br: { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }, gzip: {} };
/**
 * A body made once and kept, as an asset is, gets more. Brotli's top level takes 2.5 s for the largest grammar chunk,
 * which the first page to load it would wait on, for 8% less than the ninth's 117 ms.
 */
const kept = { br: { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }, gzip: { level: 9 } };
const compressors: Record<Coding, (body: Buffer, options: object) => Promise<Buffer>> = { br: promisify(brotliCompress), gzip: promisify(gzip) };

/** The coding `accept-encoding` takes, preferring brotli, or null for the body as it is. */
export function negotiate(header: string | undefined): Coding | null {
  if (header === undefined) return null;
  const q = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const weight = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const value = weight === undefined ? 1 : Number(weight.slice(2));
    if (name) q.set(name, Number.isFinite(value) ? value : 0);
  }
  const weight = (coding: Coding) => q.get(coding) ?? q.get("*") ?? 0;
  const best = (["br", "gzip"] as const).filter((c) => weight(c) > 0).sort((a, b) => weight(b) - weight(a))[0];
  return best ?? null;
}

/** Each coding of `body`, compressed once on first use, for a body that never changes. */
export function keptEncodings(body: Buffer): Encode {
  const made: Partial<Record<Coding, Promise<Buffer>>> = {};
  return (coding) => made[coding] ??= compressors[coding](body, kept[coding]);
}

/**
 * Writes `body` as `status` with `headers`. A text type over `minBytes` is compressed for a client that accepts it,
 * by `encode` when given, and a 200 page carries a weak ETag that a matching `if-none-match` answers with 304.
 */
export async function writeBody(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string | number>, content: Buffer | string, encode?: Encode) {
  const body = typeof content === "string" ? Buffer.from(content) : content;
  const type = String(headers["content-type"] ?? "");
  const out: Record<string, string | number> = { ...headers };
  const varies = compressibleType.test(type) && headers["content-encoding"] === undefined;
  if (varies) out.vary = "accept-encoding";
  if (status === 200 && type.startsWith("text/html")) {
    out.etag = `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
    if (matches(req.headers["if-none-match"], out.etag)) {
      delete out["content-type"];
      return void res.writeHead(304, out).end();
    }
  }
  const coding = varies && body.length > minBytes ? negotiate(req.headers["accept-encoding"]) : null;
  const sent = coding === null ? body : await (encode?.(coding) ?? compressors[coding](body, perRequest[coding]));
  if (coding !== null) out["content-encoding"] = coding;
  out["content-length"] = sent.length;
  res.writeHead(status, out).end(sent);
}

/** Whether `if-none-match` names `etag`, compared weakly as RFC 9110 has a GET compare it. */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.trim() === "*" || header.split(",").some((tag) => opaque(tag) === opaque(etag));
}
