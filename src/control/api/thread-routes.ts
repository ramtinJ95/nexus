import { operator, type Starter } from "../people.ts";
import type { z } from "zod";
import { isPipelineRequestId, requestIds, type Person, type ProjectId, type ThreadId } from "../../ids.ts";
import type { StartKey } from "../start-request.ts";
import type { Thread } from "../thread-store.ts";
import { HttpError } from "../http-error.ts";
import { Refusal } from "../refusal.ts";
import { observedPylon } from "../observed.ts";
import { queuedView } from "../queue.ts";
import { feature, type Features } from "../features.ts";
import { isOpenStatus, openStatuses, retryRefusal, type ThreadStatus } from "../reconcile.ts";
import { startKey } from "../threads.ts";
import { ok, created, noContent, parse, on, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, type Caller } from "./access.ts";
import { threadRoutes as routes, type QueuedThread } from "../../contract/threads.ts";
import { activitySchema, messageSchema, seenSchema, startSchema } from "../../contract/threads-parse.ts";

/** What `deleted=false` lists. The record fails to typecheck when a status is added, so none is left out unseen. */
const keptStatuses = Object.keys({ active: true, idle: true, archived: true } satisfies Record<Exclude<ThreadStatus, "deleted">, true>) as ThreadStatus[];

export function threadRoutes(kit: ApiKit, features: Features): readonly RouteEntry[] {
  const { lookup, thread, guard, wakeThread, rows, shown, open, registry, harness, startThread, agents, agentOf, deleteThread, starter, personAs } = kit;

  /**
   * The threads as the caller has seen them: with their own mark where they do not own the thread. A caller who is no
   * person, such as the control node a shared install still allows, has no mark and reads the owners'.
   */
  function seenBy(caller: Caller, threads: readonly Thread[]): Thread[] {
    const person = personAs(caller);
    if (person === null || threads.every((t) => t.owner === person)) return [...threads];
    const marks = registry.threads.seenMarks(person);
    return threads.map((t) => t.owner === person ? t : { ...t, seenAt: marks.get(t.id) ?? null });
  }

  const queueOrRefuse = () => feature(features, "queue");

  const queuedStatus = (id: string, status: "archived" | "queued" | "deleted") => queuedView(registry, queueOrRefuse().setStatus(id as ThreadId, status));

  function archive(t: Thread): Thread {
    guard(t, { status: "kept" });
    registry.threads.setThreadStatus(t.id, "archived");
    wakeThread(t);
    return { ...t, status: "archived" };
  }

  /** Activity never unarchives a thread, because opening its page is activity too. */
  function unarchive(t: Thread): Thread {
    if (t.status !== "archived") throw new HttpError(409, `thread ${t.id} is ${t.status}, not archived`);
    registry.threads.setThreadStatus(t.id, "active");
    registry.threads.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
    return registry.threads.thread(t.id)!;
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
    const refused = retryRefusal(observedPylon(registry, registry.threads.pylon(t.pylonId)!) ?? "absent");
    if (refused !== null) throw new HttpError(409, `pylon ${t.pylonId} cannot be retried. ${refused}`);
    if (!registry.threads.retryPylon(t.pylonId)) throw new HttpError(409, `pylon ${t.pylonId} has not failed`);
    registry.threads.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
  }

  function recordActivity(t: Thread, body: unknown) {
    parse(activitySchema, body);
    registry.threads.recordActivity(t.id, { human: Date.now() });
    wakeThread(t);
  }

  /** Starts in flight by request ID, so a repeat that arrives before the first answers shares it. */
  const starting = new Map<string, { body: string; owner: Person; answer: Promise<Thread | QueuedThread> }>();

  /** Whose thread a start request made, or undefined once retention purged it. */
  const ownerOf = (id: ThreadId): Person | undefined => {
    const queued = registry.queue.queuedThread(id);
    return registry.threads.thread(id)?.owner ?? (queued === undefined ? undefined : queued.owner ?? operator);
  };

  /**
   * A start with a request ID is stored with the thread or queued record it made, so a repeat of the ID answers that
   * thread as it is now and sends an immediate start's first message again, which the harness delivers once. A repeat
   * with another body is refused, and so is a repeat by anyone but the owner of the thread it made, since it would send
   * that thread's first message again. A start that failed made nothing, so its ID is free.
   */
  function start(body: unknown, by: Starter): Promise<Thread | QueuedThread> {
    const { requestId, ...fields } = parse(startSchema, body);
    if (requestId !== undefined && isPipelineRequestId(requestId)) throw new HttpError(400, "request IDs that start with pipeline: are the pipeline's own, which names each item's thread by one");
    if (requestId === undefined) return startOnce(fields, by);
    const key = startKey(requestId, fields);
    const pending = starting.get(requestId);
    const made = registry.threads.startRequest(requestId);
    const owner = pending?.owner ?? (made === undefined ? undefined : ownerOf(made.thread));
    if (owner !== undefined && owner !== by.owner) {
      throw new Refusal("forbidden", `request ID ${requestId} ${made === undefined ? "is starting a thread" : `started thread ${made.thread}`} of ${owner}'s, so only ${owner} may repeat it. Start a new thread under a new request ID`);
    }
    const earlier = pending ?? made;
    if (earlier !== undefined && earlier.body !== key.body) {
      throw new HttpError(409, `request ID ${requestId} ${made === undefined ? "is starting a thread" : `started thread ${made.thread}`} with another body. Start a new thread under a new request ID`);
    }
    if (pending !== undefined) return pending.answer;
    if (made !== undefined) refuseEnded(requestId, made.thread);
    const answer = startOnce(fields, by, key, made?.thread).finally(() => starting.delete(requestId));
    starting.set(requestId, { body: key.body, owner: by.owner, answer });
    return answer;
  }

  /**
   * A repeat that answered an archived, deleted or cancelled thread would read as a start that went through. A thread
   * retention purged from the registry has no row left to answer.
   */
  function refuseEnded(requestId: string, id: ThreadId) {
    const queued = registry.queue.queuedThread(id);
    const status = queued !== undefined && queued.status !== "started" ? (queued.status === "archived" ? "cancelled" : queued.status) : registry.threads.threadStatus(id) ?? "purged from the registry";
    if (status === "archived" || status === "deleted" || status === "cancelled" || status === "purged from the registry") {
      throw new HttpError(409, `request ID ${requestId} started thread ${id}, which is ${status}, so it starts nothing. Start a new thread under a new request ID`);
    }
  }

  async function startOnce({ after, message, planning, ...request }: Omit<z.infer<typeof startSchema>, "requestId">, by: Starter, key?: StartKey, made?: ThreadId): Promise<Thread | QueuedThread> {
    const plans = planning ? feature(features, "planning") : null;
    if (after === undefined) {
      const t = made === undefined ? await startThread({ request, ...by, role: planning ? "planning" : "builder", key }) : registry.threads.thread(made)!;
      plans?.begin(t);
      if (message !== undefined && isOpenStatus(t.status)) {
        const requestId = requestIds.brief(t.id);
        await registry.threads.sendWithStandingRules(t.id, requestId, message, (brief) => harness.send(t.id, plans?.compose(t, requestId, brief) ?? brief, requestId, "followUp")).then(() => plans?.sent(t, requestId), (err: Error) => {
          const why = `started ${t.id}, but its first message was not sent: ${err.message}. ${key === undefined ? `Send it with POST /v1/threads/${t.id}/messages` : `Start it again under request ID ${key.requestId} to send it`}`;
          throw err instanceof Refusal ? new Refusal(err.kind, why) : new Error(why);
        });
        const revision = registry.threads.thread(t.id)?.standingRulesRevision;
        return revision === undefined ? t : { ...t, standingRulesRevision: revision };
      }
      return t;
    }
    const queue = queueOrRefuse();
    const record = made === undefined ? queue.add(request, message ?? null, after, by, key) : registry.queue.queuedThread(made)!;
    void queue.poll();
    return record.status === "started" ? registry.threads.thread(record.id)! : queuedView(registry, record);
  }

  const seen = (unseen: boolean) => async ({ thread: id }: { thread: string }, r: Caller & { body(empty?: unknown): Promise<unknown> }) => {
    const t = thread(id);
    const body = parse(seenSchema, await r.body({}));
    const person = personAs(r);
    if (person === null) throw new Refusal("forbidden", "only a person in control.json's people has a seen mark");
    registry.threads.markSeenBy(t.id, person, unseen, registry.now(), body.lastReplyAt);
    return noContent;
  };

  return [
    on(routes.list, anyAllowed, (_, r) => {
      const { project, deleted, status } = r.query;
      if (status !== undefined && status !== "open") throw new HttpError(400, `status must be "open", not ${JSON.stringify(status)}`);
      const statuses = status === "open" ? openStatuses : deleted === false ? keptStatuses : undefined;
      return ok(rows(seenBy(r, registry.threads.threads({ project: project as ProjectId | undefined, status: statuses }))));
    }),
    on(routes.start, { role: "person", action: "start a thread", startsTurn: true }, async (_, r) => {
      return created(await start(await r.body(), starter(r)));
    }),
    on(routes.queued, anyAllowed, (_, r) => {
      const { project, status } = r.query;
      return ok(registry.queue.queuedThreads().filter((q) => q.status !== "started" && (project === undefined || q.project === project) && (status === undefined || q.status === status)).map((q) => queuedView(registry, q)));
    }),
    on(routes.queuedThread, anyAllowed, ({ thread: id }) => {
      const queued = registry.queue.queuedThread(id as ThreadId);
      if (queued === undefined || queued.status === "started") throw new HttpError(404, `no queued thread ${id}`);
      return ok(queuedView(registry, queued));
    }),
    on(routes.startQueued, { role: "owner", action: "start a queued thread", startsTurn: true }, async ({ thread: id }, r) => {
      return created(await queueOrRefuse().startNow(id as ThreadId, r.caller));
    }),
    on(routes.show, anyAllowed, ({ thread: id }, r) => ok(shown(seenBy(r, [thread(id)])[0]!))),
    on(routes.delete, { role: "owner", action: "delete a thread", admin: true }, async ({ thread: id }) => {
      const found = lookup(id);
      return ok("queued" in found ? queuedStatus(id, "deleted") : await deleteThread(found.thread));
    }),
    on(routes.seen, { role: "allowed", why: "each person's own mark of what they have read changes no thread or pylon" }, seen(false)),
    on(routes.unseen, { role: "allowed", why: "each person's own mark of what they have read changes no thread or pylon" }, seen(true)),
    on(routes.archive, { role: "owner", action: "archive a thread", admin: true }, async ({ thread: id }) => {
      const found = lookup(id);
      return ok("queued" in found ? queuedStatus(id, "archived") : archive(found.thread));
    }),
    on(routes.unarchive, { role: "owner", action: "unarchive a thread" }, ({ thread: id }) => {
      const found = lookup(id);
      const project = "queued" in found ? found.queued.project : found.thread.project;
      if (registry.projects.project(project)?.removed !== undefined) throw new HttpError(409, `project ${project} is removed; its history is read-only`);
      return ok("queued" in found ? queuedStatus(id, "queued") : unarchive(found.thread));
    }),
    on(routes.activity, { role: "allowed", why: "a page open on the thread only keeps its pylon awake" }, async ({ thread: id }, r) => { recordActivity(thread(id), await r.body()); return noContent; }),
    // The body first, so the thread's status is read after the last await before the message is submitted.
    on(routes.message, { role: "owner", action: "message a thread", startsTurn: true }, async ({ thread: id }, r) => {
      const body = await r.body();
      const t = thread(id, { status: "open" });
      return { status: 202, body: await agentOf(t).send(t, parse(messageSchema, body)) };
    }),
    on(routes.abort, { role: "owner", action: "abort a thread's turn", admin: true }, async ({ thread: id }) => {
      const t = thread(id, { status: "kept" });
      await agents[registry.threads.agent(t).kind].abort(t);
      return noContent;
    }),
    on(routes.retry, { role: "owner", action: "retry a thread's turn", startsTurn: true }, async ({ thread: id }) => {
      await harness.retry(thread(id, { status: "open", agent: "harness" }).id);
      return noContent;
    }),
    on(routes.retryPylon, { role: "owner", action: "retry a thread's pylon" }, ({ thread: id }) => {
      retryPylon(thread(id));
      return noContent;
    }),
    on(routes.conversation, anyAllowed, async ({ thread: id }) => {
      const t = thread(id, { status: "kept" });
      return ok(await agents[registry.threads.agent(t).kind].read(t));
    }),
  ];
}
