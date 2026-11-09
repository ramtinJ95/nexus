import { HttpError } from "../http-error.ts";
import { eventCursor, eventKinds, type EventFilter } from "../events.ts";
import { ok, on, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed } from "./access.ts";
import { streamRoutes as routes } from "../../contract/streams.ts";

export function streamRoutes(kit: ApiKit): readonly RouteEntry[] {
  const { thread, stream, followEvents, registry, agents } = kit;

  return [
    on(routes.events, anyAllowed, (_, { query }) => {
      const since = query.since === "latest" ? registry.threads.newestEvent() : query.since ?? "0";
      try { eventCursor(since); } catch { throw new HttpError(400, "invalid event cursor"); }
      if (query.kinds.some((k) => !(eventKinds as readonly string[]).includes(k))) throw new HttpError(400, "unknown event kind");
      const filter: EventFilter = { kinds: query.kinds, ...(query.thread === undefined ? {} : { thread: query.thread }), ...(query.project === undefined ? {} : { project: query.project }) };
      const read = (from: string) => registry.threads.eventBatch(from, filter);
      const first = read(since);
      if (!query.follow) return ok(first.events);
      return { stream: (res) => followEvents(res, first, read) };
    }),
    on(routes.threadEvents, anyAllowed, ({ thread: id }) => {
      const t = thread(id, { status: "kept", agent: "harness" });
      return { stream: (res) => stream(res, t, () => agents.harness.watch(t), agents.harness.frames()) };
    }),
    on(routes.claudeEvents, anyAllowed, ({ thread: id }) => {
      const t = thread(id, { status: "kept", agent: "claude" });
      return { stream: (res) => stream(res, t, () => agents.claude.watch(t), agents.claude.frames()) };
    }),
  ];
}
