/** It imports only route.ts at run time, so a browser can bundle it. */
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import type { NexusEvent } from "../control/events.ts";
import type { ClaudeEntry } from "../control/claude-transcript.ts";
import { queryOf, route, type EventStream, type QueryCodec } from "./route.ts";

export type { NexusEvent } from "../control/events.ts";

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

/** Whether a harness conversation's run is working, and how many messages wait for it to finish. */
export interface Busy { working: boolean; queued: number }

/**
 * One event of `GET /v1/threads/:id/events`. The first carries the whole view. Each later one carries what changed
 * since the one before, each part whole: the active context when any entry changed, each document that changed,
 * or null for one that is gone, and the run's `busy` when it changed.
 */
export interface ViewFrame {
  entries?: readonly EntryRecord[];
  docs?: Record<string, JsonObject | null>;
  busy?: Busy;
}

/** The most entries a Claude worker's transcript keeps: the newest, which its stream sends and watch keeps too. */
export const maxEntries = 3000;

/**
 * The messages Claude Code queued and has not taken, oldest first. A removal names the message it takes by its text,
 * or names none and takes the oldest.
 */
export function queuedOf(entries: readonly ClaudeEntry[]): Extract<ClaudeEntry, { kind: "queue" }>[] {
  const queued: Extract<ClaudeEntry, { kind: "queue" }>[] = [];
  for (const entry of entries) {
    if (entry.kind !== "queue") continue;
    if (entry.op === "enqueue") queued.push(entry);
    else {
      const taken = entry.text === null ? 0 : queued.findIndex((q) => q.text === entry.text);
      if (taken !== -1) queued.splice(taken, 1);
    }
  }
  return queued;
}

/**
 * One event of `GET /v1/threads/:id/claude/events`. The first, and any after the transcript was replaced, has
 * `reset` and every entry kept. Each later one has the entries appended since the one before.
 */
export interface ClaudeFrame { reset: boolean; session: string | null; entries: readonly ClaudeEntry[]; dropped: number; working: boolean }

/**
 * The frames of one client of a Claude worker's transcript stream, or null when no entry came and `working` held.
 * The CLI's watch passes the frames it gets through one too, so the whole transcript that each reconnect sends
 * prints only what it has not printed.
 */
export function claudeFrames(): (view: Omit<ClaudeFrame, "reset">) => ClaudeFrame | null {
  let sent: { session: string | null; total: number; last: string | undefined; working: boolean } | null = null;
  return (view) => {
    const total = view.dropped + view.entries.length;
    // The registry keeps no generation, so a replaced transcript shows as a
    // different entry where the last one sent stood.
    const start = sent === null ? -1 : sent.total - view.dropped;
    const appended = sent !== null && sent.session === view.session && start >= 0 && start <= view.entries.length
      && (sent.total === 0 || (start > 0 && JSON.stringify(view.entries[start - 1]) === sent.last));
    const entries = appended ? view.entries.slice(start) : view.entries;
    if (appended && entries.length === 0 && view.working === sent!.working) return null;
    sent = { session: view.session, total, last: JSON.stringify(view.entries.at(-1)), working: view.working };
    return { reset: !appended, session: view.session, entries, dropped: view.dropped, working: view.working };
  };
}
