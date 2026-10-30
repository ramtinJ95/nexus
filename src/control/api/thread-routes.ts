/**
 * Starting, listing, messaging, archiving and deleting threads, and the turns and pylons a person retries.
 */
import { z } from "zod";
import type { Planning } from "../planning.ts";
import type { ProjectId, ThreadId } from "../../ids.ts";
import type { StartKey } from "../start-request.ts";
import type { Thread } from "../thread-store.ts";
import { HttpError } from "../http-error.ts";
import { observedPylon } from "../observed.ts";
import { queuedView, type QueuedThread, type ThreadQueue } from "../queue.ts";
import { retryRefusal } from "../../reconcile.ts";
import { startKey } from "../threads.ts";
import { ok, created, noContent, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { projectSchema } from "./project-routes.ts";

export const startSchema = z.strictObject({
  model: z.string().trim().min(1).max(200).optional(),
  claude: z.string().trim().min(1).max(16_384).refine((prompt) => !prompt.includes("\0"), "a Claude prompt cannot hold a NUL character, which no command-line argument can").optional(),
  project: z.string().min(1),
  title: z.string().min(1),
  node: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  /**
   * Until the control plane mirrors repos, the caller may pin a commit. The default is the branch tip at clone time.
   * A scratch project has none to pin.
   */
  commit: z.string().min(1).optional(),
  /** The thread's size where it differs from its project's. Its pylon boots this size on every wake. */
  resources: projectSchema.shape.resources.partial().optional(),
  /** Queue the thread to start once each of these threads' pull requests has merged. */
  after: z.array(z.string().min(1)).min(1).max(32).optional(),
  /** A Nexus agent thread's first message, sent as the person's once it starts. */
  message: z.string().min(1).optional(),
  /** Minted by the client per start, such as start:<uuid>. A retry with the same ID and body is the same start. */
  requestId: z.string().min(1).max(200).optional(),
  /** A Nexus agent thread that plans: its proposals become questions for the person. */
  planning: z.literal(true).optional(),
});

// Agent activity comes from the harness.
const seenSchema = z.strictObject({ lastReplyAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional() });
const activitySchema = z.strictObject({ kind: z.literal("human") });
const messageSchema = z.strictObject({
  text: z.string().min(1),
  /** Minted by the client per message, such as msg:<uuid>. A retry with the same ID is the same message. */
  requestId: z.string().min(1),
  /** followUp waits for the current run. steer joins it after its current tool round. */
  mode: z.enum(["followUp", "steer"]).default("followUp"),
});

export function threadRoutes(kit: ApiKit, options: { queue?: ThreadQueue | null | undefined; planning?: Planning | null | undefined }): readonly RouteEntry[] {
  const { lookup, thread, guard, wakeThread, row, detail, open, registry, harness, startThread, agents, agentOf } = kit;

  function queueOrRefuse(): ThreadQueue {
    if (!options.queue) throw new HttpError(409, "queued threads need the control plane's GitHub token (github.tokenFile), which is not configured");
    return options.queue;
  }

  const queuedStatus = (id: string, status: "archived" | "queued" | "deleted") => queuedView(registry, queueOrRefuse().setStatus(id as ThreadId, status));

  async function setStatus(t: Thread, status: "archived" | "deleted"): Promise<Thread> {
    guard(t, { status: "kept" });
    registry.setThreadStatus(t.id, status);
    wakeThread(t);
    if (status === "deleted") {
      for (const s of open) if (s.thread === t.id) s.end();
      // After the status, which each agent's delete relies on.
      await agents[registry.agent(t).kind].delete(t);
    }
    return { ...t, status };
  }

  /** Activity never unarchives a thread, because opening its page is activity too. */
  function unarchive(t: Thread): Thread {
    if (t.status !== "archived") throw new HttpError(409, `thread ${t.id} is ${t.status}, not archived`);
    registry.setThreadStatus(t.id, "active");
    registry.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
    return registry.thread(t.id)!;
  }

  /**
   * Clears the planner's verdict and the attempt count, so the next pass plans the pylon afresh. A human retries
   * on purpose, so a failure the planner may not retry is cleared too, such as setup that failed on git access
   * the user has since fixed. A fresh pylon whose setup failed has no instance left, so it boots fresh and runs
   * setup again. A broken one is paused onto its newest disk and resumed (planner rule 7a), unless that disk
   * records a failed setup, which every resume repeats. The retry is human activity, so the pylon is wanted at once.
   * An archived thread's pylon stays paused, so its retry only settles the pylon. A deleted thread's pylon is
   * deleted all the same.
   */
  function retryPylon(t: Thread) {
    guard(t, { status: "kept" });
    const refused = retryRefusal(observedPylon(registry, registry.pylon(t.pylonId)!) ?? "absent");
    if (refused !== null) throw new HttpError(409, `pylon ${t.pylonId} cannot be retried. ${refused}`);
    if (!registry.retryPylon(t.pylonId)) throw new HttpError(409, `pylon ${t.pylonId} has not failed`);
    registry.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
  }

  function recordActivity(t: Thread, body: unknown) {
    parse(activitySchema, body);
    registry.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
  }

  /** Starts in flight by request ID, so a repeat that arrives before the first answers shares it. */
  const starting = new Map<string, { body: string; answer: Promise<Thread | QueuedThread> }>();

  /**
   * A start with a request ID is stored with the thread or queued record it made, so a repeat of the ID answers that
   * thread as it is now and sends an immediate start's first message again, which the harness delivers once. A repeat
   * with another body is refused. A start that failed made nothing, so its ID is free.
   */
  function start(body: unknown, caller: string): Promise<Thread | QueuedThread> {
    const { requestId, ...fields } = parse(startSchema, body);
    if (requestId?.startsWith("pipeline:")) throw new HttpError(400, "request IDs that start with pipeline: are the pipeline's own, which names each item's thread by one");
    if (requestId === undefined) return startOnce(fields, caller);
    const key = startKey(requestId, fields);
    const pending = starting.get(requestId);
    const made = registry.startRequest(requestId);
    const earlier = pending ?? made;
    if (earlier !== undefined && earlier.body !== key.body) {
      throw new HttpError(409, `request ID ${requestId} ${made === undefined ? "is starting a thread" : `started thread ${made.thread}`} with another body. Start a new thread under a new request ID`);
    }
    if (pending !== undefined) return pending.answer;
    const answer = startOnce(fields, caller, key, made?.thread).finally(() => starting.delete(requestId));
    starting.set(requestId, { body: key.body, answer });
    return answer;
  }

  async function startOnce({ after, message, planning, ...request }: Omit<z.infer<typeof startSchema>, "requestId">, caller: string, key?: StartKey, made?: ThreadId): Promise<Thread | QueuedThread> {
    if (request.model !== undefined && request.claude === undefined) throw new HttpError(400, "model requires claude");
    if (planning && (request.claude !== undefined || after !== undefined)) throw new HttpError(400, "a planning thread is a Nexus agent thread that starts now, so it takes neither claude nor after");
    if (planning && !options.planning) throw new HttpError(409, "this control plane has no planning pass");
    if (after === undefined) {
      if (message !== undefined && request.claude !== undefined) throw new HttpError(400, "message is for a Nexus agent thread. A Claude worker's first prompt is its claude");
      const t = made === undefined ? await startThread(request, caller, undefined, key) : registry.thread(made)!;
      if (planning) options.planning!.begin(t);
      if (message !== undefined && t.status !== "archived" && t.status !== "deleted") {
        const requestId = `brief:${t.id}`;
        await harness.send(t.id, options.planning?.compose(t, requestId, message) ?? message, requestId, "followUp").then(() => options.planning?.sent(t, requestId), (err: Error) => {
          const why = `started ${t.id}, but its first message was not sent: ${err.message}. ${key === undefined ? `Send it with POST /v1/threads/${t.id}/messages` : `Start it again under request ID ${key.requestId} to send it`}`;
          throw err instanceof HttpError ? new HttpError(err.status, why) : new Error(why);
        });
      }
      return t;
    }
    const queue = queueOrRefuse();
    const record = made === undefined ? queue.add(request, message ?? null, after, caller, key) : registry.queuedThread(made)!;
    void queue.poll();
    return record.status === "started" ? registry.thread(record.id)! : queuedView(registry, record);
  }

  return [
    ["GET", /^\/v1\/threads$/, (_, r) => {
      const threads = registry.threads((r.query.get("project") ?? undefined) as ProjectId | undefined);
      return ok((r.query.get("deleted") === "false" ? threads.filter((t) => t.status !== "deleted") : threads).map(row));
    }],
    ["POST", /^\/v1\/threads$/, { person: "start a thread", startsTurn: true }, async (_, r) => {
      return created(await start(await r.body(), r.caller));
    }],
    ["GET", /^\/v1\/queued$/, (_, r) => {
      const project = r.query.get("project");
      return ok(registry.queuedThreads().filter((q) => q.status !== "started" && (project === null || q.project === project)).map((q) => queuedView(registry, q)));
    }],
    ["GET", /^\/v1\/queued\/([^/]+)$/, (m) => {
      const queued = registry.queuedThread(m[1]! as ThreadId);
      if (queued === undefined || queued.status === "started") throw new HttpError(404, `no queued thread ${m[1]!}`);
      return ok(queuedView(registry, queued));
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/start$/, { person: "start a queued thread", startsTurn: true }, async (m, r) => {
      return created(await queueOrRefuse().startNow(m[1]! as ThreadId, r.caller));
    }],
    ["GET", /^\/v1\/threads\/([^/]+)$/, (m) => ok(detail(thread(m[1]!)))],
    ["DELETE", /^\/v1\/threads\/([^/]+)$/, { person: "delete a thread" }, async (m) => {
      const found = lookup(m[1]!);
      return ok("queued" in found ? queuedStatus(m[1]!, "deleted") : await setStatus(found.thread, "deleted"));
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/(seen|unseen)$/, { open: "what the person has read changes no thread or pylon" }, async (m, r) => {
      const t = thread(m[1]!);
      const body = parse(seenSchema, await r.body({}));
      registry.markSeen(t.id, m[2] === "unseen", Date.now(), body.lastReplyAt);
      return noContent;
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/archive$/, { person: "archive a thread" }, async (m) => {
      const found = lookup(m[1]!);
      return ok("queued" in found ? queuedStatus(m[1]!, "archived") : await setStatus(found.thread, "archived"));
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/unarchive$/, { person: "unarchive a thread" }, (m) => {
      const found = lookup(m[1]!);
      return ok("queued" in found ? queuedStatus(m[1]!, "queued") : unarchive(found.thread));
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/activity$/, { open: "a page open on the thread only keeps its pylon awake" }, async (m, r) => { recordActivity(thread(m[1]!), await r.body()); return noContent; }],
    // The body first, so the thread's status is read after the last await before the message is submitted.
    ["POST", /^\/v1\/threads\/([^/]+)\/messages$/, { person: "message a thread", startsTurn: true }, async (m, r) => {
      const body = await r.body();
      const t = thread(m[1]!, { status: "open" });
      return { status: 202, body: await agentOf(t).send(t, parse(messageSchema, body)) };
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/abort$/, { person: "abort a thread's turn" }, async (m) => {
      const t = thread(m[1]!, { status: "kept" });
      await agents[registry.agent(t).kind].abort(t);
      return noContent;
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/retry$/, { person: "retry a thread's turn", startsTurn: true }, async (m) => {
      await harness.retry(thread(m[1]!, { status: "open", agent: "harness" }).id);
      return noContent;
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/pylon\/retry$/, { person: "retry a thread's pylon" }, (m) => {
      retryPylon(thread(m[1]!));
      return noContent;
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/conversation$/, async (m) => {
      const t = thread(m[1]!, { status: "kept" });
      return ok(await agents[registry.agent(t).kind].read(t));
    }],
  ];
}
