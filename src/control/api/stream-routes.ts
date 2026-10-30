/**
 * The event log and each thread's conversation, as server-sent event streams.
 */
import { HttpError } from "../http-error.ts";
import { eventCursor, eventKinds, type EventFilter } from "../../events.ts";
import { promptSenders } from "../inbox.ts";
import { ok, type RouteEntry, type ApiKit } from "./kit.ts";

export function streamRoutes(kit: ApiKit): readonly RouteEntry[] {
  const { thread, stream, followEvents, registry, agents, live, agentOf } = kit;

  return [
    ["GET", /^\/v1\/events$/, (_, r) => {
      // A follower that reads the state itself whenever it connects needs no history.
      const since = r.query.get("since") === "latest" ? registry.newestEvent() : r.query.get("since") ?? "0";
      try { eventCursor(since); } catch { throw new HttpError(400, "invalid event cursor"); }
      const kinds = r.query.getAll("kind");
      if (kinds.some((k) => !(eventKinds as readonly string[]).includes(k))) throw new HttpError(400, "unknown event kind");
      const filter: EventFilter = { kinds, ...(r.query.has("thread") ? { thread: r.query.get("thread")! } : {}), ...(r.query.has("project") ? { project: r.query.get("project")! } : {}) };
      const read = (from: string) => registry.eventBatch(from, filter);
      const first = read(since);
      if (r.query.get("follow") !== "true") return ok(first.events);
      return { stream: (res) => followEvents(res, first, read) };
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/events$/, ([, id]) => {
      const t = thread(id!, { status: "kept", agent: "harness" });
      return { stream: (res) => stream(res, t, () => agents.harness.watch(t), agents.harness.frames()) };
    }],
    ["GET", /^\/v1\/threads\/([^/]+)\/claude\/events$/, ([, id]) => {
      const t = thread(id!, { status: "kept", agent: "claude" });
      return { stream: (res) => stream(res, t, () => agents.claude.watch(t), agents.claude.frames()) };
    }],
    ["GET", /^\/threads\/([^/]+)\/stream$/, ([, id]) => {
      const t = thread(id!, { status: "kept" });
      const agent = agentOf(t);
      const reader = live(t, registry.claudeWorker(t.id)?.model ?? null, () => registry.questions(t.id), () => promptSenders(registry, t.id));
      return { stream: (res) => stream(res, t, () => agent.watch(t), reader.frames, reader.leave) };
    }],
  ];
}
