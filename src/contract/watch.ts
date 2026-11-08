/**
 * The events of `nexus watch --json`, one JSON object per line, which integrations read and docs/cli.md#the-watch-stream
 * describes. It imports nothing at run time.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ClaudeEntry } from "../control/claude-transcript.ts";
import type { ActualState } from "../control/reconcile.ts";
import type { Thread } from "../control/thread-store.ts";
import type { ThreadDetail } from "../control/wire.ts";

/** What watch reports of a thread, as one event whenever any of it changes. */
export interface ThreadStateEvent {
  type: "state";
  thread: string;
  status: Thread["status"];
  /** Parked when a task hit the restart limit and holds the run until `nexus retry`. */
  run: "idle" | "working" | "parked";
  parkedTasks: number;
  /** Messages waiting for the current run to finish. */
  queued: number;
  pylon: ActualState;
  failed: string | null;
  /** ThreadDetail's ports. */
  ports: ThreadDetail["ports"];
}
/** What watch reports of the run in flight, as one event whenever any of it changes. */
export interface RunLiveEvent {
  type: "live";
  thread: string;
  /** The text of each message waiting for the current run to finish. */
  queued: string[];
  /** The output so far of each tool call still running, by the toolCall's id in the entries. */
  tools: { callId: string; output: string }[];
  /** The answer streaming now, its text parts joined. */
  partial: string | null;
  /** The error of a model request waiting to be retried. */
  retry: string | null;
}
/** An entry with the CLI's plain rendering of its messages. */
export interface RenderedEntry { entry: EntryRecord; text: string }
/** A Claude worker's transcript entry with the CLI's plain rendering of it. */
export interface RenderedClaudeEntry { entry: ClaudeEntry; text: string }
export type WatchEvent =
  | { type: "reset"; thread: string; entries: RenderedEntry[] }
  | { type: "entry"; thread: string } & RenderedEntry
  | { type: "claude-reset"; thread: string; session: string | null; dropped: number; entries: RenderedClaudeEntry[] }
  | { type: "claude-entry"; thread: string } & RenderedClaudeEntry
  | ThreadStateEvent
  | RunLiveEvent
  | { type: "error"; thread: string; kind: "unreachable" | "failed"; message: string };
