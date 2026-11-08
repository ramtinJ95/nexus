/**
 * The server's side of a thread's conversation streams: the frames each client of a harness conversation is sent,
 * and the hash of an image part. Nothing here holds state beyond
 * one client's frames.
 */
import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ConversationView, InboxState, LiveState } from "@earendil-works/pi-durable";
import type { Busy, ViewFrame } from "../contract/streams.ts";

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

/** The run as the docs pi-durable keeps of it say: its live run, and the messages its inbox holds. */
export function busyOf(view: Pick<ConversationView, "docs">): Busy {
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  return { working: (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined, queued: Array.isArray(inbox?.items) ? inbox.items.length : 0 };
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

