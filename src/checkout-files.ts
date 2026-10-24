/**
 * The Files and Changes views of a pylon's checkout: directory listings, file contents, the files that changed since
 * the pylon booted or since HEAD, and their diff. checkout-files.py does the reading in the guest, over one raw pipe
 * per request, because every pylon image has Python 3 and a guest exec returns at most 64 KiB. The helper goes in on
 * stdin, because the probe takes a stream's argv in its request's URL, whose length is limited.
 *
 * The helper's output is the guest's, so every reply is parsed as untrusted input: one longer than the helper would
 * ever print, or with more entries, fails rather than being held in memory or checked entry by entry. A pipe cannot be
 * cut off from this end, so a read that passes its deadline fails at once and its pipe is drained in the background,
 * until the guest's process exits or the pylon pauses.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";
import type { ByteStream, StreamRequest } from "./protocol.ts";

const helper = readFileSync(new URL("./checkout-files.py", import.meta.url), "utf8");

/** Opens a raw pipe to a process in the pylon. */
export type OpenPipe = (request: StreamRequest) => Promise<ByteStream>;

/** `start` is what the pylon booted at, which its first boot records as refs/nexus/base. */
export type ChangesBase = "start" | "head";

export const maxFileBytes = 10 << 20;
/** The helper's caps are 2000 entries, 3000 files and 4 MiB of diff. A JSON reply within them stays far below this. */
const maxReplyBytes = 16 << 20;
/** Longer than the helper's 45 s for one git command, so a slow git is the helper's refusal. */
export const readDeadlineMs = 90_000;
/**
 * Pipes open at once across every pylon, counting those still draining after their read passed its deadline, so a
 * pylon that never finishes cannot pile them up.
 */
export const maxOpenPipes = 32;
let openPipes = 0;
/**
 * The probe takes a stream's argv in its request's URL, which Node caps with the request's headers at 16 KiB. This
 * leaves room for the rest of the request.
 */
const maxPathsBytes = 8192;
/** Whether the paths of one read, such as a diff's, fit in its request. The API checks with this too. */
export const pathsFit = (paths: readonly string[]): boolean => encodeURIComponent(JSON.stringify(paths)).length <= maxPathsBytes;

const refusalKinds = ["missing", "outside", "kind", "large", "no-base", "slow", "busy", "long"] as const;
export type RefusalKind = (typeof refusalKinds)[number];
/** A refusal the person asking can act on, such as a path that does not exist, rather than a failed pylon. */
export class CheckoutRefused extends Error {
  readonly kind: RefusalKind;
  constructor(kind: RefusalKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const refusalSchema = z.strictObject({ refused: z.enum(refusalKinds), message: z.string() });
const entrySchema = z.strictObject({ name: z.string().min(1), kind: z.enum(["file", "dir", "symlink", "other"]), size: z.number().int().nonnegative().nullable() });
const listingSchema = z.strictObject({ path: z.string(), entries: z.array(entrySchema).max(2000), truncated: z.boolean() });
const baseSchema = z.strictObject({
  kind: z.enum(["start", "head"]),
  /** Null where the base is the empty tree: HEAD before the first commit, and the start of a pylon that booted an empty repository. */
  commit: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
});
const changedSchema = z.strictObject({
  path: z.string().min(1),
  oldPath: z.string().min(1).nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "typechange"]),
  /** Null for a binary file. */
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
const changesSchema = z.strictObject({ base: baseSchema, files: z.array(changedSchema).max(3000), truncated: z.boolean() });
const diffSchema = z.strictObject({ base: baseSchema, diff: z.string(), truncated: z.boolean() });

/** A directory's entries, sorted by name. `path` is relative to the checkout, and empty for the checkout itself. */
export type Listing = z.infer<typeof listingSchema>;
export type Changes = z.infer<typeof changesSchema>;
export type ChangedFile = z.infer<typeof changedSchema>;
export type Diff = z.infer<typeof diffSchema>;

export interface CheckoutReader {
  list(path: string): Promise<Listing>;
  /** At most maxFileBytes. A larger file is refused as `large`. */
  read(path: string): Promise<Buffer>;
  changes(base: ChangesBase): Promise<Changes>;
  /** The whole diff, or only `paths`. Give a renamed file's old path too, or it shows as added. */
  diff(base: ChangesBase, paths: readonly string[]): Promise<Diff>;
}

export function checkoutReader(open: OpenPipe, checkout: string, deadlineMs = readDeadlineMs): CheckoutReader {
  async function run(paths: readonly string[], args: readonly string[]): Promise<Buffer> {
    if (!pathsFit(paths)) throw new CheckoutRefused("long", "the paths are too long together for one read");
    if (openPipes >= maxOpenPipes) throw new CheckoutRefused("busy", `${maxOpenPipes} checkout reads are still open, some from pylons that did not finish theirs. Try again later`);
    openPipes++;
    let stream: ByteStream;
    try {
      stream = await open({ pty: null, argv: ["python3", "-", checkout, ...args] });
    } catch (err) {
      openPipes--;
      throw err;
    }
    let abandoned = false;
    let chunks: Uint8Array[] = [];
    const reply = (async () => {
      try {
        await stream.write(Buffer.from(helper));
        await stream.close();
        let bytes = 0;
        // Past the cap, or once the read is abandoned, the rest is still read, so the stream ends, but not kept.
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes <= maxReplyBytes && !abandoned) chunks.push(chunk);
          else chunks = [];
        }
        return { end: await stream.done, bytes, out: Buffer.concat(chunks) };
      } finally {
        openPipes--;
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        chunks = [];
        reject(new CheckoutRefused("slow", `the pylon did not finish reading its checkout within ${deadlineMs / 1000} s`));
      }, deadlineMs);
    });
    // A reply that loses the race fails or finishes unwatched.
    reply.catch(() => undefined);
    const { end, bytes, out } = await Promise.race([reply, late]).finally(() => clearTimeout(timer));
    if (end.kind === "lost") throw new Error("the pipe to the pylon was lost before the checkout reader finished");
    if (bytes > maxReplyBytes) throw new Error(`the checkout reader printed over ${maxReplyBytes} bytes`);
    if (end.code === 3) {
      const refusal = parsed(refusalSchema, out);
      throw new CheckoutRefused(refusal.refused, refusal.message);
    }
    if (end.code !== 0) throw new Error(`the checkout reader exited ${end.code}. Its stderr is in the node's probe log`);
    return out;
  }
  const json = async <T>(schema: z.ZodType<T>, paths: readonly string[], args: readonly string[]): Promise<T> => parsed(schema, await run(paths, args));
  return {
    list: (path) => json(listingSchema, [path], ["list", path]),
    read: (path) => run([path], ["read", path, String(maxFileBytes)]),
    changes: (base) => json(changesSchema, [], ["changes", base]),
    diff: (base, paths) => json(diffSchema, paths, ["diff", base, ...paths]),
  };
}

/** The guest's reply, or a short error naming its first problem, which the API passes on. */
function parsed<T>(schema: z.ZodType<T>, out: Buffer): T {
  let value: unknown;
  try {
    value = JSON.parse(out.toString("utf8"));
  } catch {
    throw new Error("the checkout reader's reply is not JSON");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new Error(`the checkout reader's reply is malformed at ${issue!.path.join(".") || "its top"}: ${issue!.message.slice(0, 200)}`);
  }
  return result.data;
}

const imageTypes: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/**
 * The content type to serve a checkout's file as. A repository's HTML or SVG would run as a page of the API's own
 * origin, which the dashboard shares, so only raster images keep their type. Anything else is text when it decodes
 * as UTF-8 without a NUL byte, and bytes otherwise.
 */
export function contentType(path: string, content: Buffer): string {
  const image = imageTypes[extname(path).toLowerCase()];
  if (image !== undefined) return image;
  if (content.includes(0)) return "application/octet-stream";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return "text/plain; charset=utf-8";
  } catch {
    return "application/octet-stream";
  }
}
