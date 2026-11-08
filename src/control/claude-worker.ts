/**
 * The Claude worker of a Claude worker thread: its launch's state, the latest turn of its sessions and that turn's
 * death, Nexus resuming a turn that died, its transcript as read so far, what stopped its latest turn, and the
 * messages typed into it. The thread store makes it, and hands it the thread's reconcile, attention and turn.
 */
import { claudeTurn } from "../../images/pylon/nexus-contract.ts";
import type { ThreadId } from "../ids.ts";
import type { Sender } from "./agent-protocol.ts";
import { errorStop, transcriptStart, type ClaudeEntry, type TranscriptCursor } from "./claude-transcript.ts";
import { maxEntries } from "../contract/streams.ts";
import { json, jsonOrNull, type Db, type Holding } from "./db.ts";
import type { EventKind } from "./events.ts";

export type ClaudeWorkerState = "pending" | "starting" | "started" | "stalled" | "failed";

/**
 * The states each state moves to. A worker is pending until its pylon runs, starting from when the launch is first
 * sent until the probe answers, as it stays while the launch is sent again, and then started, stalled when the launch
 * did not reach a turn, or failed. A turn of the launch's session starts a worker that is not pending. A started worker
 * neither stalls nor fails, since a launch that answers after its session's turn started has not failed.
 */
export const claudeMoves = {
  pending: ["starting"],
  starting: ["starting", "started", "stalled", "failed"],
  started: ["started"],
  stalled: ["started"],
  failed: ["started"],
} as const satisfies Record<ClaudeWorkerState, readonly ClaudeWorkerState[]>;

const canMove = (from: ClaudeWorkerState, to: ClaudeWorkerState) => (claudeMoves[from] as readonly ClaudeWorkerState[]).includes(to);
const startable = (Object.keys(claudeMoves) as ClaudeWorkerState[]).filter((s) => canMove(s, "started"));

/** A move of the worker. Starting names the session its launch opens. A stall or failure says why, which its thread.failed event says too. */
export type ClaudeMove = { to: "starting"; session: string } | { to: "started" } | { to: "stalled" | "failed"; message: string };

/** A Claude worker thread's worker. `session` is the Claude Code session its launch opened, null until the launch names one. */
export type ClaudeWorker = { prompt: string; model: string | null; session: string | null } & (
  | { state: "pending" | "starting" | "started"; message?: undefined }
  | { state: "stalled" | "failed"; message: string });

/** What stopped the worker's latest turn, when no turn of a session runs since. */
export interface ClaudeStop {
  /** Its session stopped on its usage limit. `resetsAt` is null when Claude Code did not say when the limit resets. */
  usageLimit?: { stoppedAt: number; resetsAt: number | null };
  /**
   * Its session ended during it, or it ended on a model error that was not its usage limit. `at` is when, by the
   * pylon's clock, and `reason` says which, with the error's text for a model error.
   */
  turnDied?: { at: number; cause: "session-ended" | "model-error"; reason: string };
}

/**
 * Nexus resuming a Claude worker whose turn died (resume.ts). `turn` is the `turnDied.at` of the turn it answers, and
 * `count` the resumes in a row that turn makes. A resume `waiting` goes at `due`, one `sending` is saved before it is
 * first sent at `since`, and one `resumed` went at `at`. After the last resume in a row a turn that died too waits on
 * the person, which makes the attention a decision, and `why` says why in a line. So does a resume that started no
 * turn, or one the session took no message for. The person writing to the thread makes it theirs, which is kept, as
 * the transcript may drop the message.
 */
export type ClaudeResume =
  | { state: "waiting"; turn: number; count: number; due: number }
  | { state: "sending"; turn: number; count: number; since: number }
  | { state: "resumed"; turn: number; count: number; at: number }
  | { state: "person"; turn: number; count: number; why: string }
  | { state: "left-alone" };

/** Where the reader of a Claude worker's transcript is in its session's file, how many entries it dropped to keep maxEntries, and when it last read. */
interface ClaudeTranscript { session: string; cursor: TranscriptCursor; dropped: number; readAt: number }
/** What one read of a Claude worker's transcript found, from `from` to `cursor`. `reset` says the file was replaced, so `entries` start it over. */
interface ClaudeRead { session: string; from: TranscriptCursor; entries: readonly ClaudeEntry[]; cursor: TranscriptCursor; reset: boolean; readAt: number }
/**
 * A message typed into a Claude worker, by its request ID. It is `sending` from before the probe is asked until the
 * probe answers, so a send whose answer was lost, which may have typed some of it, is not typed again. A thread keeps
 * every request ID until it is deleted, since a forgotten ID would be typed again on a resend however late it comes.
 */
type ClaudeMessage = { state: "sending" } | { state: "sent"; result: ClaudeSent };
/** Who typed a message into a Claude worker: the person, a Nexus sender, or `unknown` for a send recorded before senders were. */
type ClaudeMessageSender = Sender | "person" | "unknown";
/** What a send to a Claude worker answers, and answers again for a resend of its request ID. */
export interface ClaudeSent { session: string; outcome: "sent" | "queued"; resumed: boolean }

const deleted = { deletedWithThread: true } as const;
export const holding = {
  tables: { claude_workers: {}, claude_transcripts: deleted, claude_entries: deleted, claude_messages: deleted, claude_senders: deleted },
} as const satisfies Holding;

export interface ClaudeWorkerThread {
  reconcile(thread: ThreadId): void;
  updateAttention(thread: ThreadId): void;
  appendEvent(kind: EventKind, thread: ThreadId, payload: Record<string, unknown>): unknown;
  /** Ends the turn of `session` that started no later than `at`, by the pylon's clock, as its session's hook would. */
  endTurn(thread: ThreadId, session: string, at: number): void;
}

export function claudeWorkerStore(db: Db, on: ClaudeWorkerThread) {
  const { transaction, sql } = db;
  db.hold(holding);

  function claudeWorker(thread: ThreadId): ClaudeWorker | undefined {
    const row = sql("SELECT prompt, state, message, model, session FROM claude_workers WHERE thread = ?").get(thread);
    if (row === undefined) return undefined;
    const worker = { prompt: row.prompt as string, model: row.model as string | null, session: row.session as string | null };
    const state = row.state as ClaudeWorkerState;
    return state === "stalled" || state === "failed" ? { ...worker, state, message: row.message as string } : { ...worker, state };
  }

  function claudeResume(thread: ThreadId): ClaudeResume | null {
    return jsonOrNull<ClaudeResume>(sql("SELECT resume FROM claude_workers WHERE thread = ?").get(thread)?.resume ?? null);
  }

  function claudeTranscript(thread: ThreadId): ClaudeTranscript | undefined {
    const row = sql("SELECT * FROM claude_transcripts WHERE thread = ?").get(thread);
    return row === undefined ? undefined : {
      session: row.session as string, cursor: { offset: row.byte_offset as number, skipping: row.skipping === 1, before: row.before_hash as string }, dropped: row.dropped as number, readAt: row.read_at as number,
    };
  }

  /**
   * What stopped the latest turn of each of the Claude worker threads among `ids`. Derived from the newest entries
   * rather than stored, so it holds whichever of the turn's end and the transcript's read comes first.
   */
  function claudeStops(ids: readonly ThreadId[]): Map<ThreadId, ClaudeStop> {
    const stops = new Map<ThreadId, ClaudeStop>();
    if (ids.length === 0) return stops;
    const workers = sql(`SELECT w.thread, w.turn_at, w.died_at, t.thread IS NOT NULL AS read FROM claude_workers w LEFT JOIN claude_transcripts t ON t.thread = w.thread AND t.session = w.session
      WHERE w.thread IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
    const entries = new Map<ThreadId, ClaudeEntry[]>();
    // Each thread's newest 16 through the index, as a window over the threads' entries would rank every one it keeps.
    for (const r of sql(`SELECT j.value AS thread, e.entry FROM json_each(?) j JOIN claude_entries e ON e.thread = j.value
      AND e.seq > coalesce((SELECT seq FROM claude_entries WHERE thread = j.value ORDER BY seq DESC LIMIT 1 OFFSET 16), -1) ORDER BY j.value, e.seq`).all(JSON.stringify(workers.filter((w) => w.read === 1).map((w) => w.thread)))) {
      const of = r.thread as ThreadId;
      entries.set(of, [...entries.get(of) ?? [], json<ClaudeEntry>(r.entry)]);
    }
    for (const w of workers) {
      const id = w.thread as ThreadId;
      const turnAt = w.turn_at as number | null;
      const stop = errorStop(entries.get(id) ?? []);
      // A turn that started after the stop, by the pylon's clock as the record's time is, ended it, though its prompt may not be read yet.
      const current = stop !== null && (turnAt === null || turnAt <= stop.at) ? stop : null;
      if (current?.usageLimit !== undefined) {
        stops.set(id, { usageLimit: { stoppedAt: current.at, resetsAt: current.usageLimit.resetsAt } });
        continue;
      }
      // A turn that ends with a background task running reports a heartbeat for its end, so its session may end after a
      // turn whose end only the transcript shows, as a turn's duration or an interrupt.
      const finished = turnAt !== null && (entries.get(id) ?? []).some((e) => e.at !== null && e.at >= turnAt && (e.kind === "turn" || (e.kind === "notice" && e.text === "Interrupted")));
      const ended = typeof w.died_at === "number" && turnAt !== null && w.died_at >= turnAt && !finished ? w.died_at : null;
      if (ended !== null && (current === null || ended >= current.at)) stops.set(id, { turnDied: { at: ended, cause: "session-ended", reason: "its Claude session ended during the turn" } });
      else if (current !== null) stops.set(id, { turnDied: { at: current.at, cause: "model-error", reason: current.text } });
    }
    return stops;
  }

  return {
    addWorker(thread: ThreadId, prompt: string, model: string) {
      sql("INSERT INTO claude_workers (thread, prompt, state, model) VALUES (?, ?, 'pending', ?)").run(thread, prompt, model);
    },
    claudeStops,
    workerFailed(thread: ThreadId): boolean {
      const state = claudeWorker(thread)?.state;
      return state === "stalled" || state === "failed";
    },
    /** The threads whose worker's launch is starting, which their pylon's tick settles. */
    launching: (): ThreadId[] => sql("SELECT thread FROM claude_workers WHERE state = 'starting'").all().map((r) => r.thread as ThreadId),
    /** A turn of `session` started at `at`, by the pylon's clock. `named` says the report named the session, as a launch's session is. */
    turnStarted(thread: ThreadId, session: string, at: number, named: boolean) {
      if (named) sql(`UPDATE claude_workers SET state = 'started', message = NULL WHERE thread = ? AND session = ? AND state IN (SELECT value FROM json_each(?))`).run(thread, session, JSON.stringify(startable));
      sql("UPDATE claude_workers SET turn_session = ?, turn_at = ? WHERE thread = ? AND (turn_at IS NULL OR turn_at < ?)").run(session, at, thread, at);
    },
    /** `session` ended at `at`, by the pylon's clock, during a turn of its, which dies with it if it is the latest turn. */
    sessionEnded(thread: ThreadId, session: string, at: number) {
      sql("UPDATE claude_workers SET died_at = ? WHERE thread = ? AND turn_session = ? AND turn_at <= ?").run(at, thread, session, at);
    },
    /**
     * Once the disk that held it is gone, the transcript is read from the start again, keeping the stored entries, so
     * the session's new file appends after them rather than reading as a replaced one.
     */
    rewindTranscript(thread: ThreadId) {
      sql("UPDATE claude_transcripts SET byte_offset = ?, skipping = ?, before_hash = ? WHERE thread = ?")
        .run(transcriptStart.offset, transcriptStart.skipping ? 1 : 0, transcriptStart.before, thread);
    },

    claudeWorker,
    /**
     * Moves the worker as claudeMoves allows, and answers false, changing nothing, for a move it does not. A stall or a
     * failure appends its thread.failed event.
     */
    moveClaudeWorker(thread: ThreadId, move: ClaudeMove): boolean {
      return transaction(() => {
        const from = claudeWorker(thread)?.state;
        if (from === undefined || !canMove(from, move.to)) return false;
        sql("UPDATE claude_workers SET state = ?, message = ?, session = coalesce(?, session) WHERE thread = ?")
          .run(move.to, "message" in move ? move.message : null, move.to === "starting" ? move.session : null, thread);
        on.reconcile(thread);
        on.updateAttention(thread);
        if ("message" in move) on.appendEvent("thread.failed", thread, { message: move.message, cause: "claude-worker" });
        return true;
      });
    },
    claudeResume,
    /** Replaces the worker's resume record, or with null deletes it. */
    saveClaudeResume(thread: ThreadId, resume: ClaudeResume | null) {
      transaction(() => {
        sql("UPDATE claude_workers SET resume = ? WHERE thread = ?").run(resume === null ? null : JSON.stringify(resume), thread);
        on.updateAttention(thread);
      });
    },
    /** The threads with a resume record that a later pass may still change or clear, which is every one but left-alone. */
    resumedThreads: (): ThreadId[] => sql("SELECT thread FROM claude_workers WHERE resume IS NOT NULL AND json_extract(resume, '$.state') != 'left-alone' ORDER BY thread").all().map((r) => r.thread as ThreadId),
    /** The snapshot ID of the latest session.turn-started of any session on a Claude worker thread. */
    latestClaudeTurn(thread: ThreadId): string | null {
      const row = sql("SELECT turn_session, turn_at FROM claude_workers WHERE thread = ? AND turn_at IS NOT NULL").get(thread);
      return row === undefined ? null : claudeTurn(row.turn_session as string, row.turn_at as number);
    },
    claudeTranscript,
    /** The stored entries from the one numbered `from`, where the oldest kept is numbered as the transcript's `dropped`. */
    claudeEntries: (thread: ThreadId, from = 0): ClaudeEntry[] => sql("SELECT entry FROM claude_entries WHERE thread = ? AND seq >= ? ORDER BY seq").all(thread, from).map((r) => json<ClaudeEntry>(r.entry)),
    /**
     * Appends what a read found and keeps the newest maxEntries. A read of another session than the stored one, or of
     * a file that was replaced, replaces the stored entries. A read that did not start where the stored reader stands, such
     * as one applied twice, changes nothing and answers false.
     */
    appendClaudeRead(thread: ThreadId, read: ClaudeRead): boolean {
      return transaction(() => {
        const stored = claudeTranscript(thread);
        const same = stored?.session === read.session;
        const at = same ? stored!.cursor : transcriptStart;
        if (at.offset !== read.from.offset || at.skipping !== read.from.skipping || at.before !== read.from.before) return false;
        const replace = !same || read.reset;
        if (replace) sql("DELETE FROM claude_entries WHERE thread = ?").run(thread);
        const base = replace ? 0 : Number(sql("SELECT coalesce(max(seq) + 1, 0) AS next FROM claude_entries WHERE thread = ?").get(thread)!.next);
        const total = base + read.entries.length;
        const insert = sql("INSERT INTO claude_entries (thread, seq, entry) VALUES (?, ?, ?)");
        const first = Math.max(0, read.entries.length - maxEntries);
        read.entries.slice(first).forEach((entry, i) => insert.run(thread, base + first + i, JSON.stringify(entry)));
        sql("DELETE FROM claude_entries WHERE thread = ? AND seq < ?").run(thread, total - maxEntries);
        sql(`INSERT INTO claude_transcripts (thread, session, byte_offset, skipping, before_hash, dropped, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (thread) DO UPDATE SET session = excluded.session, byte_offset = excluded.byte_offset, skipping = excluded.skipping, before_hash = excluded.before_hash,
            dropped = excluded.dropped, read_at = excluded.read_at`)
          .run(thread, read.session, read.cursor.offset, read.cursor.skipping ? 1 : 0, read.cursor.before, Math.max(0, total - maxEntries), read.readAt);
        // An image without the StopFailure hook reports no end to the turn a usage limit stopped, so the transcript ends it.
        const stop = claudeStops([thread]).get(thread)?.usageLimit;
        if (stop !== undefined) on.endTurn(thread, read.session, stop.stoppedAt);
        on.reconcile(thread);
        on.updateAttention(thread);
        return true;
      });
    },
    claudeMessage(thread: ThreadId, requestId: string): ClaudeMessage | undefined {
      const row = sql("SELECT state, result FROM claude_messages WHERE thread = ? AND request_id = ?").get(thread, requestId);
      return row === undefined ? undefined : row.state === "sent" ? { state: "sent", result: json<ClaudeSent>(row.result) } : { state: "sending" };
    },
    /** Null forgets the message, as for a send that typed nothing. `typed` is who typed it and the hash of its text, kept from the first write. */
    setClaudeMessage(thread: ThreadId, requestId: string, message: ClaudeMessage | null, typed?: { sender: Exclude<ClaudeMessageSender, "unknown">; sha256: string }) {
      transaction(() => {
        if (message === null) {
          for (const table of ["claude_messages", "claude_senders"]) sql(`DELETE FROM ${table} WHERE thread = ? AND request_id = ?`).run(thread, requestId);
          return;
        }
        sql("INSERT INTO claude_messages (thread, request_id, state, result) VALUES (?, ?, ?, ?) ON CONFLICT (thread, request_id) DO UPDATE SET state = excluded.state, result = excluded.result")
          .run(thread, requestId, message.state, message.state === "sent" ? JSON.stringify(message.result) : null);
        if (typed !== undefined) sql("INSERT OR IGNORE INTO claude_senders (thread, request_id, sender, text_sha256) VALUES (?, ?, ?, ?)").run(thread, requestId, typed.sender, typed.sha256);
      });
    },
    /** Who typed each message recorded for the thread's Claude worker, and the hash of its text, null for one recorded before senders were. */
    claudeMessageSenders: (thread: ThreadId) => sql("SELECT coalesce(s.sender, 'unknown') AS sender, s.text_sha256 FROM claude_messages m LEFT JOIN claude_senders s USING (thread, request_id) WHERE m.thread = ?").all(thread)
      .map((r) => ({ sender: r.sender as ClaudeMessageSender, sha256: r.text_sha256 as string | null })),
  };
}
