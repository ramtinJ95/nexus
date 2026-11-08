/**
 * What a thread's conversation looks like on the wire, and the frames each client of its streams is sent. Nothing
 * here holds state beyond one client's frames.
 */
import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, InboxState, JsonObject, LiveState } from "@earendil-works/pi-durable";
import type { ClaudeConversation, ClaudeEntry } from "./claude-transcript.ts";

/** A thread's conversation, tagged with the kind of agent it is from. */
export type AgentView = { kind: "harness"; view: ConversationView } | { kind: "claude"; view: ClaudeConversation };

/** Tags a view as served, so the dashboard and the CLI tell the two apart without asking the thread again. */
export function agentView(view: ConversationView | ClaudeConversation): AgentView {
  return "kind" in view ? { kind: "claude", view } : { kind: "harness", view };
}

/**
 * A harness image part's hash, which the dashboard's image links carry and `GET /v1/threads/<id>/image` checks. Kept
 * once per part, since a page renders the same committed parts again and again.
 */
const partHashes = new WeakMap<ImageContent, string>();
export const partHash = (part: ImageContent) => partHashes.get(part) ?? partHashes.set(part, createHash("sha256").update(part.data).digest("hex")).get(part)!;

/** What a stream follows: a harness conversation's watch, or a Claude worker's. */
export interface Watch<V> {
  readonly value: V;
  start(listener: (view: V) => void | Promise<void>): void;
  stop(): Promise<unknown>;
  readonly closed: Promise<unknown>;
}

/** Whether a harness conversation's run is working, and how many messages wait for it to finish. */
export interface Busy { working: boolean; queued: number }

/** The run as the docs pi-durable keeps of it say: its live run, and the messages its inbox holds. */
export function busyOf(view: Pick<ConversationView, "docs">): Busy {
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  return { working: (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined, queued: Array.isArray(inbox?.items) ? inbox.items.length : 0 };
}

/**
 * One event of `GET /v1/threads/:id/events`. The first carries the whole view. Each later one carries what changed
 * since the one before, each part whole: the active context when any entry changed, each document that changed,
 * or null for one that is gone, and the run's `busy` when it changed. A control plane older than 0.71.0 sends no `busy`.
 */
export interface ViewFrame {
  entries?: readonly EntryRecord[];
  docs?: Record<string, JsonObject | null>;
  busy?: Busy;
}

/** Maps each view to what one client has not seen yet, or null when nothing it shows changed. */
export type Frames<V = ConversationView> = (view: V) => unknown;

/** The frames of one client of a thread's event stream. pi-durable's views share every part a commit left alone. */
export function viewFrames(): Frames {
  let sent: ConversationView | null = null;
  let sentBusy: Busy | null = null;
  return (view) => {
    const kinds = new Set([...Object.keys(view.docs), ...Object.keys(sent?.docs ?? {})]);
    const docs = Object.fromEntries([...kinds].flatMap((kind) => view.docs[kind] === sent?.docs[kind] ? [] : [[kind, view.docs[kind] ?? null]]));
    const busy = busyOf(view);
    const frame: ViewFrame = {
      ...view.entries === sent?.entries ? {} : { entries: view.entries },
      ...Object.keys(docs).length === 0 ? {} : { docs },
      ...sentBusy?.working === busy.working && sentBusy.queued === busy.queued ? {} : { busy },
    };
    sent = view;
    sentBusy = busy;
    return Object.keys(frame).length === 0 ? null : frame;
  };
}

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
    // Where the entries not sent yet start. The registry keeps no generation, so a replaced transcript shows as a
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
