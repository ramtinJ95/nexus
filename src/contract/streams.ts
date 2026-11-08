/**
 * The event log and each thread's conversation, as routes of server-sent events. The server registers its handlers
 * against them, and the CLI and dashboard follow them. It imports nothing at run time, so a browser can bundle it.
 */
import type { NexusEvent } from "../control/events.ts";
import type { ClaudeFrame, ViewFrame } from "../control/conversation-view.ts";
import { queryOf, route, type EventStream, type QueryCodec } from "./route.ts";

/** `since` is an event's ID, or "latest" for a follower that reads the state itself whenever it connects. */
export interface EventsQuery { since?: string | undefined; thread?: string | undefined; project?: string | undefined; kinds?: readonly string[]; follow?: true }
const eventsQuery: QueryCodec<EventsQuery, { since: string | undefined; thread: string | undefined; project: string | undefined; kinds: string[]; follow: boolean }> = {
  encode: ({ since, thread, project, kinds = [], follow }) => queryOf([
    ["since", since], ["thread", thread], ["project", project], ...kinds.map((kind) => ["kind", kind] as const), ["follow", follow ? "true" : undefined],
  ]),
  decode: (params) => ({
    since: params.get("since") ?? undefined, thread: params.get("thread") ?? undefined, project: params.get("project") ?? undefined,
    kinds: params.getAll("kind"), follow: params.get("follow") === "true",
  }),
};

export const streamRoutes = {
  /** The events once, or followed as a stream with `follow`. */
  events: route<NexusEvent[] | EventStream<NexusEvent>>()("GET", "/v1/events", eventsQuery),
  threadEvents: route<EventStream<ViewFrame>>()("GET", "/v1/threads/{thread}/events"),
  claudeEvents: route<EventStream<ClaudeFrame>>()("GET", "/v1/threads/{thread}/claude/events"),
} as const;
