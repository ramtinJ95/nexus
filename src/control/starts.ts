/**
 * Thread starts that a retry cannot repeat, for the API's `POST /v1/threads` and the drive tools' `nexus_start`. A
 * start with a request ID is stored with the thread or queued record it made, so a repeat of the ID answers that thread
 * as it is now and sends an immediate start's first message again, which the harness delivers once. A repeat with
 * another body is refused. A start that failed made nothing, so its ID is free.
 */
import { createHash } from "node:crypto";
import type { Sender } from "../harness/host.ts";
import { HttpError } from "./http-error.ts";
import { queuedView, type QueuedThread, type ThreadQueue } from "./queue.ts";
import type { Registry, StartKey, Thread, ThreadId } from "./registry.ts";
import type { StartRequest } from "./threads.ts";

/** A start as its caller asks for it: `after` queues it, and `message` is a Nexus agent thread's first message. */
export type StartFields = StartRequest & { after?: string[] | undefined; message?: string | undefined };

export function threadStarts(options: {
  registry: Registry;
  startThread(request: StartRequest, caller: string, queuedId?: ThreadId, key?: StartKey): Promise<Thread>;
  send(threadId: string, text: string, requestId: string, sender?: Sender): Promise<unknown>;
  /** Throws when queued threads are not configured. */
  queue(): ThreadQueue;
}) {
  const { registry, startThread, send, queue: queueOrRefuse } = options;
  /** Starts in flight by request ID, so a repeat that arrives before the first answers shares it. */
  const starting = new Map<string, { body: string; answer: Promise<Thread | QueuedThread> }>();

  async function startOnce({ after, message, ...request }: StartFields, caller: string, key?: StartKey, made?: ThreadId): Promise<Thread | QueuedThread> {
    if (request.model !== undefined && request.claude === undefined) throw new HttpError(400, "model requires claude");
    if (after === undefined) {
      if (message !== undefined && request.claude !== undefined) throw new HttpError(400, "message is for a Nexus agent thread. A Claude worker's first prompt is its claude");
      const t = made === undefined ? await startThread(request, caller, undefined, key) : registry.thread(made)!;
      if (message !== undefined && t.status !== "archived" && t.status !== "deleted") {
        // A tool's brief is its parent thread's message, never the person's.
        await send(t.id, message, `brief:${t.id}`, request.parent === undefined ? undefined : "thread").catch((err: Error) => {
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

  return function start({ requestId, ...fields }: StartFields & { requestId?: string | undefined }, caller: string): Promise<Thread | QueuedThread> {
    if (requestId === undefined) return startOnce(fields, caller);
    const key: StartKey = { requestId, body: createHash("sha256").update(JSON.stringify(fields)).digest("hex") };
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
  };
}
