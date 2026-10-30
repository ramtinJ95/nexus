/**
 * What a person does in a thread's pylon: previews, sessions, and reads of its checkout and conversation images.
 */
import { z } from "zod";
import type { OpenedSession } from "../wire.ts";
import type { PortRange, Preview, Thread } from "../thread-store.ts";
import { HttpError } from "../http-error.ts";
import { focusScript } from "../../sessions.ts";
import { checkoutDir, sessionHarnessSchema } from "../../session-harness.ts";
import { checkoutReader, contentType, maxFileBytes, pathsFit, type CheckoutReader } from "../../checkout-files.ts";
import { herdrPanePattern } from "../../attach-wire.ts";
import { linkedName, reservedPorts } from "../../services-file.ts";
import { maxRecordBytes, readTranscriptImage } from "../../claude-transcript.ts";
import { partHash } from "../dashboard/items.ts";
import { ok, created, noContent, parse, type Reply, type RouteEntry, type ApiKit } from "./kit.ts";

const previewSchema = z.strictObject({ port: z.int().min(1).max(65535).refine((port) => !reservedPorts.has(port), "is Nexus's own") });
const sessionSchema = z.strictObject({
  harness: sessionHarnessSchema.default("claude-code"),
  /** The Herdr workspace's label. The harness's name by default. */
  title: z.string().trim().min(1).max(80).optional(),
});

/** A path in the checkout, relative to it. Empty is the checkout itself. */
const checkoutPath = z.string().refine((path) => !path.includes("\0"), "has a NUL byte").refine((path) => pathsFit([path]), "is too long");
/** A diff's paths, which the probe's request must carry together. */
const diffPaths = z.array(checkoutPath.min(1)).max(100).refine(pathsFit, "are too long together");
const changesBaseSchema = z.enum(["start", "head", "turn"]).default("start");

const queryCount = z.string().regex(/^\d{1,15}$/, "must be a whole number").transform(Number);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
/** Where an image of a thread's conversation is, as the dashboard's image links name it. */
const imageSourceSchema = z.discriminatedUnion("source", [
  /** A block of the Claude worker's current transcript, as a prompt or result entry's `images` names it. */
  z.strictObject({ source: z.literal("transcript"), offset: queryCount, bytes: queryCount.refine((n) => n > 0 && n <= maxRecordBytes, "is not a record's length"), sha256: sha256Schema, index: queryCount }),
  /** An image part of a harness conversation: the entry's ID, its message, the part, and the SHA-256 of the part's base64 data. */
  z.strictObject({ source: z.literal("harness"), entry: queryCount, message: queryCount, part: queryCount, sha256: sha256Schema }),
  /** A file in the checkout, or the file at a base of the Changes view. */
  z.strictObject({ source: z.literal("file"), path: checkoutPath.min(1), base: z.enum(["start", "head", "turn"]).optional() }),
]);
type ImageSource = z.infer<typeof imageSourceSchema>;
/** A transcript or harness image is named by its hash, so its link never serves other bytes. A file may change. */
const imageCaching: Readonly<Record<ImageSource["source"], string>> = { transcript: "private, max-age=31536000, immutable", harness: "private, max-age=31536000, immutable", file: "no-cache" };

/** The image type the bytes start as, of those a browser shows and none that can run, such as SVG. */
function imageType(bytes: Buffer): string | null {
  const starts = (...magic: number[]) => magic.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export function pylonRoutes(kit: ApiKit, { previewPorts }: { previewPorts: PortRange }): readonly RouteEntry[] {
  const { thread, guard, wakeThread, inPylon, whileRunning, pylonCommand, execInPylon, registry, agents } = kit;

  /** What each source of a conversation's image reads it with. Null is an image that is gone. */
  const imageReaders: { [K in ImageSource["source"]]: (t: Thread, source: Extract<ImageSource, { source: K }>) => Promise<Buffer | null> } = {
    async transcript(t, { source: _, ...image }) {
      const session = registry.claudeWorker(guard(t, { status: "kept", agent: "claude" }).id)?.session ?? null;
      if (session === null) return null;
      return whileRunning(t, (probe, pylonId) => readTranscriptImage((argv) => probe.stream(pylonId, argv), session, image));
    },
    async harness(t, { entry, message, part, sha256 }) {
      const view = await agents.harness.view(guard(t, { status: "kept", agent: "harness" }));
      const content = view.entries.find((e) => e.id === entry)?.model?.[message]?.content;
      const found = Array.isArray(content) ? content[part] : undefined;
      if (found?.type !== "image" || partHash(found) !== sha256) return null;
      return Buffer.from(found.data, "base64");
    },
    file: (t, { path, base }) => inCheckout(t, (c) => base === undefined ? c.read(path) : c.blob(base, path), whileRunning),
  };

  /** An image of the thread's conversation, as one of the raster types a browser shows, and never anything that runs. */
  async function conversationImage(t: Thread, source: ImageSource): Promise<Reply> {
    const read = imageReaders[source.source] as (t: Thread, source: ImageSource) => Promise<Buffer | null>;
    const bytes = await read(t, source);
    if (bytes === null) throw new HttpError(404, "the image is gone: the conversation or file no longer holds it");
    if (bytes.length > maxFileBytes) throw new HttpError(413, `the image is over the ${maxFileBytes}-byte limit`);
    const type = imageType(bytes);
    if (type === null) throw new HttpError(415, "it is not a PNG, JPEG, GIF or WebP image");
    return { status: 200, file: bytes, type, cache: imageCaching[source.source] };
  }

  /** Reads the pylon's checkout for the Files and Changes views, over one raw pipe per read. */
  async function inCheckout<T>(t: Thread, read: (checkout: CheckoutReader) => Promise<T>, via: typeof inPylon = inPylon): Promise<T> {
    const turn = await agents[registry.agent(t).kind].latestTurn(t);
    return via(t, (probe, pylonId) => read(checkoutReader((argv) => probe.stream(pylonId, argv), checkoutDir, undefined, turn)));
  }

  async function checkoutFile(t: Thread, path: string): Promise<Reply> {
    const content = await inCheckout(t, (c) => c.read(path));
    return { status: 200, file: content, type: contentType(path, content) };
  }

  /**
   * Links the port in the pylon, then gives its service an https port at once, as the loop would at the next
   * observation, so the reply names the URL. The URL serves once the loop's next spawn publishes it, which `ready`
   * reports. Linking a port again answers its preview again.
   */
  async function linkPort(t: Thread, body: unknown): Promise<Preview> {
    const { port } = parse(previewSchema, body);
    const { service } = await pylonCommand(t, { kind: "link-port", port });
    registry.allocatePreviews(t.pylonId, [service], previewPorts);
    wakeThread(t);
    return registry.previews(t.pylonId).find((p) => p.service === service)!;
  }

  /**
   * Unlinks the port in the pylon, which stops forwarding it at once, then drops its preview, as the loop would at
   * the next observation. Tailscale stops serving the URL once the loop's next spawn publishes the previews without
   * it. A port that is not linked succeeds. A port a service's preview owns is refused with a 422, not a 409, because
   * waiting cannot change it, and the CLI and dashboard try a 409 again.
   */
  async function unlinkPort(t: Thread, port: number): Promise<void> {
    const { refused } = await pylonCommand(t, { kind: "unlink-port", port });
    if (refused !== null) throw new HttpError(422, refused);
    registry.releasePreview(t.pylonId, linkedName(port));
    wakeThread(t);
  }

  /**
   * Opens a Herdr session in the pylon's checkout, with the harness's agent in it, and answers once the agent is
   * ready or waits for its human, such as at Claude Code's login. The node publishes its sessions again at once,
   * so ThreadDetail lists it within moments.
   */
  async function openSession(t: Thread, body: unknown): Promise<OpenedSession> {
    const { harness, title = harness } = parse(sessionSchema, body);
    const { herdrPane } = await pylonCommand(t, { kind: "open-session", harness, title });
    return { herdrPane, harness, title };
  }

  /**
   * Closes a session by its ID. A paused one is refused without waking its pylon, since the wake brings it back and
   * it closes once it runs. A failed one in no pane is forgotten, so no wake tries it again. Any other ID is a pane,
   * perhaps one opened a moment ago that no observation lists yet. A pane that is not open, or that runs another
   * session than the one listed there, is a 404, never a success: a caller may hold a pane from before a wake that
   * brought its session back in another one, and gave this one to another session.
   */
  async function closeSession(t: Thread, id: string): Promise<void> {
    const session = registry.session(t.pylonId, id);
    if (session?.state === "paused" && t.status !== "deleted") {
      const resumes = t.status === "archived" ? `when \`nexus unarchive ${t.id}\` wakes its pylon` : "when its pylon wakes";
      throw new HttpError(409, `session ${id} is paused with its pylon and resumes ${resumes}. Close it once it runs`);
    }
    if (session?.state === "failed" && session.herdrPane === null) {
      const { dropped } = await pylonCommand(t, { kind: "drop-failed-session", id });
      if (!dropped) throw new HttpError(404, `pylon ${t.pylonId} holds no failed session ${id}`);
      return;
    }
    const listed = session === undefined ? {} : { session: { harness: session.harness, harnessSessionId: session.harnessSessionId, title: session.title } };
    const { outcome } = await pylonCommand(t, { kind: "close-session", herdrPane: id, ...listed });
    if (outcome === "not-open") throw new HttpError(404, `no session is open in pane ${id} of pylon ${t.pylonId}. A wake may have moved it to another pane, which the thread's sessions list`);
    if (outcome === "moved") throw new HttpError(404, `pane ${id} of pylon ${t.pylonId} runs another session now, so it was left open. A wake moved session ${id} to another pane, which the thread's sessions list`);
  }

  /**
   * Focuses a session's pane in the pylon's Herdr, which moves every terminal attached to it there, as the dashboard's
   * Show in terminal does for one already attached.
   */
  async function focusSession(t: Thread, pane: string): Promise<void> {
    if (!herdrPanePattern.test(pane)) throw new HttpError(400, `pane must be a Herdr pane ID such as w1:p1, got ${JSON.stringify(pane.slice(0, 80))}`);
    const { exitCode, output } = await execInPylon(t, ["sh", "-c", focusScript, "focus", pane]);
    if (exitCode === 1) throw new HttpError(404, `no pane ${pane} is open in pylon ${t.pylonId}`);
    if (exitCode !== 0) throw new Error(`focusing pane ${pane} exited ${exitCode}: ${output.trim().slice(-200)}`);
  }

  return [
    ["POST", /^\/v1\/threads\/([^/]+)\/previews$/, { person: "publish a preview" }, async (m, r) => {
      const body = await r.body();
      return ok(await linkPort(thread(m[1]!), body));
    }],
    ["DELETE", /^\/v1\/threads\/([^/]+)\/previews\/([^/]+)$/, { person: "unpublish a preview" }, async (m) => {
      const { port } = parse(previewSchema, { port: /^\d+$/.test(m[2]!) ? Number(m[2]) : m[2] });
      await unlinkPort(thread(m[1]!), port);
      return noContent;
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/sessions$/, { person: "open a session in a thread's pylon" }, async (m, r) => {
      const body = await r.body();
      return created(await openSession(thread(m[1]!), body));
    }],
    ["DELETE", /^\/v1\/threads\/([^/]+)\/sessions\/([^/]+)$/, { person: "close a session in a thread's pylon" }, async (m) => {
      await closeSession(thread(m[1]!), m[2]!);
      return noContent;
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/sessions\/([^/]+)\/focus$/, { person: "focus a session in a thread's pylon" }, async (m) => {
      await focusSession(thread(m[1]!), m[2]!);
      return noContent;
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/files$/, async (m, r) => {
      const path = parse(checkoutPath, r.query.get("path") ?? "");
      return ok(await inCheckout(thread(m[1]!), (c) => c.list(path)));
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/files\/content$/, async (m, r) => checkoutFile(thread(m[1]!), parse(checkoutPath.min(1), r.query.get("path") ?? ""))],
    ["GET", /^\/v1\/threads\/([^/]+)\/image$/, async (m, r) => conversationImage(thread(m[1]!), parse(imageSourceSchema, Object.fromEntries(r.query)))],
    ["GET", /^\/v1\/threads\/([^/]+)\/changes$/, async (m, r) => {
      const base = parse(changesBaseSchema, r.query.get("base") ?? undefined);
      return ok(await inCheckout(thread(m[1]!), (c) => c.changes(base)));
    }],
    // Each `path` is a pathspec, so a renamed file needs its old path too.
    ["GET", /^\/v1\/threads\/([^/]+)\/diff$/, async (m, r) => {
      const base = parse(changesBaseSchema, r.query.get("base") ?? undefined);
      const paths = parse(diffPaths, r.query.getAll("path"));
      return ok(await inCheckout(thread(m[1]!), (c) => c.diff(base, paths)));
    }],
  ];
}
