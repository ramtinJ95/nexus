import type { PortRange, Preview, Thread } from "../thread-store.ts";
import { HttpError } from "../http-error.ts";
import { checkoutReader, contentType, maxFileBytes, type CheckoutReader } from "../../checkout-files.ts";
import { linkedName } from "../../services-file.ts";
import { readTranscriptImage } from "../claude-transcript.ts";
import { partHash } from "../conversation-view.ts";
import { ok, created, noContent, parse, on, type Reply, type RouteEntry, type ApiKit } from "./kit.ts";
import { focusScript, herdrPanePattern } from "../../guest-contract.ts";
import { checkoutDir } from "../../../images/pylon/nexus-contract.ts";
import { anyAllowed } from "./access.ts";
import { pylonRoutes as routes, type ImageSource, type OpenedSession } from "../../contract/pylon.ts";
import { changesBaseSchema, checkoutPath, diffPaths, imageSourceSchema, previewSchema, sessionSchema } from "../../contract/pylon-parse.ts";

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
  async function conversationImage(t: Thread, source: ImageSource): Promise<Extract<Reply, { file: Buffer }>> {
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

  async function checkoutFile(t: Thread, path: string): Promise<Extract<Reply, { file: Buffer }>> {
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
    on(routes.preview, { role: "person", action: "publish a preview" }, async ({ thread: id }, r) => {
      const body = await r.body();
      return ok(await linkPort(thread(id), body));
    }),
    on(routes.unpreview, { role: "person", action: "unpublish a preview" }, async ({ thread: id, port: given }) => {
      const { port } = parse(previewSchema, { port: /^\d+$/.test(given) ? Number(given) : given });
      await unlinkPort(thread(id), port);
      return noContent;
    }),
    on(routes.openSession, { role: "person", action: "open a session in a thread's pylon" }, async ({ thread: id }, r) => {
      const body = await r.body();
      return created(await openSession(thread(id), body));
    }),
    on(routes.closeSession, { role: "person", action: "close a session in a thread's pylon" }, async ({ thread: id, session }) => {
      await closeSession(thread(id), session);
      return noContent;
    }),
    on(routes.focusSession, { role: "person", action: "focus a session in a thread's pylon" }, async ({ thread: id, session }) => {
      await focusSession(thread(id), session);
      return noContent;
    }),
    on(routes.files, anyAllowed, async ({ thread: id }, r) => {
      const path = parse(checkoutPath, r.query.path);
      return ok(await inCheckout(thread(id), (c) => c.list(path)));
    }),
    on(routes.file, anyAllowed, async ({ thread: id }, r) => checkoutFile(thread(id), parse(checkoutPath.min(1), r.query.path))),
    on(routes.image, anyAllowed, async ({ thread: id }, r) => conversationImage(thread(id), parse(imageSourceSchema, r.query))),
    on(routes.changes, anyAllowed, async ({ thread: id }, r) => {
      const base = parse(changesBaseSchema, r.query.base);
      return ok(await inCheckout(thread(id), (c) => c.changes(base)));
    }),
    on(routes.diff, anyAllowed, async ({ thread: id }, r) => {
      const base = parse(changesBaseSchema, r.query.base);
      const paths = parse(diffPaths, r.query.paths);
      return ok(await inCheckout(thread(id), (c) => c.diff(base, paths)));
    }),
  ];
}
