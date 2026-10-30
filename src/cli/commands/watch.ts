/**
 * `nexus watch` and `nexus conversation`: a thread's conversation as it grows, and as it is now. The integrations read
 * the watch's events, whose types this exports.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { ListeningPort, ThreadDetail } from "../../control/wire.ts";
import type { Thread } from "../../control/thread-store.ts";
import { maxEntries, type ClaudeConversation, type ClaudeEntry } from "../../claude-transcript.ts";
import { agentView, claudeFrames, queuedOf, type ClaudeFrame, type ViewFrame } from "../../control/conversation-view.ts";
import type { ActualState } from "../../reconcile.ts";
import { CliError } from "../transport.ts";
import { type Api, type Follow, type Command, str, thread, int, clip, untilConsumerGone } from "../kit.ts";
import { transient } from "../config.ts";
import { entryText, type View, queuedTexts, busy, conversationText, claudeEntryText, claudeText } from "../conversation-text.ts";

/** What watch reports of a thread, as one event whenever any of it changes. */
export interface WatchState {
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
export interface WatchLive {
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
  | WatchState
  | WatchLive
  | { type: "error"; thread: string; kind: "unreachable" | "failed"; message: string };

function stateOf(d: ThreadDetail, working: boolean, queued: number): WatchState {
  const parkedTasks = d.agent?.parkedTasks ?? 0;
  return {
    type: "state", thread: d.thread.id, status: d.thread.status, run: parkedTasks > 0 ? "parked" : working ? "working" : "idle",
    parkedTasks, queued, pylon: d.pylon.actualState, failed: d.pylon.failed, ports: d.ports,
  };
}

/** What watch keeps of a Claude worker's transcript: the stream's entries, the newest maxEntries of them. */
type Transcript = Omit<ClaudeFrame, "reset">;

/** A Claude worker's run in flight: what Claude Code queued, and each call of the running turn without a result. */
function claudeLiveOf(id: string, c: Transcript): WatchLive {
  const lastTurn = c.entries.findLastIndex((e) => e.kind === "turn");
  const done = new Set(c.entries.flatMap((e) => e.kind === "result" ? [e.toolUseId] : []));
  const running = c.working ? c.entries.slice(lastTurn + 1).flatMap((e) => e.kind === "tool" && !done.has(e.id) ? [{ callId: e.id, output: "" }] : []) : [];
  return { type: "live", thread: id, queued: queuedOf(c.entries).map((q) => q.text ?? ""), tools: running, partial: null, retry: null };
}

function liveOf(id: string, view: View | null): WatchLive {
  const live = view?.docs["pi.live"] as LiveState | undefined;
  const generation = live?.generation;
  const partial = generation?.message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
  return {
    type: "live", thread: id, queued: view === null ? [] : queuedTexts(view),
    tools: (live?.tools ?? []).flatMap((slot) => slot.status === "running" ? [{ callId: slot.callId, output: slot.output ?? "" }] : []),
    partial: partial === "" ? null : partial, retry: generation?.retry?.error ?? null,
  };
}

function stateText(s: WatchState): string {
  const run = s.run === "working" ? ", agent working" : s.run === "parked" ? `, ${s.parkedTasks} parked tasks hold the run` : "";
  const ports = (s.ports ?? []).map((l: ListeningPort) => l.preview?.ready === true ? `${l.port} at ${l.preview.url}` : String(l.port));
  return `-- ${s.status}, pylon ${s.pylon}${s.failed === null ? "" : ` (${s.failed.split("\n")[0]})`}${run}${s.queued === 0 ? "" : `, ${s.queued} queued`}${ports.length === 0 ? "" : `, listening on ${ports.join(", ")}`}`;
}

/**
 * Follows the thread's conversation as the API streams it, and polls the thread. The conversation is pi-durable's
 * active context, not the full history: a new head marker, a compaction or a delete can reorder or drop entries.
 * So the first print shows the context whole, a later one that only appends prints each new entry, and any other
 * change prints it whole again. A Claude worker's transcript streams instead, and prints the same way, whole first
 * and when it was replaced. Then the thread's state and the run in flight, when they changed. Every print comes
 * from the latest of both sources, so an answer's entry is printed before the live event that drops its partial.
 * An unreachable or failing control plane is reported once and retried through, so a live pane survives a restart
 * of the control plane. Ends after the state that says the thread is deleted, or once the process that started it
 * is gone.
 */
async function watch(api: Api, follow: Follow, id: string, intervalMs: number, json: boolean): Promise<void> {
  const emit = (event: WatchEvent, text: string) => {
    if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
    else if (text !== "") process.stdout.write(`${text}\n`);
  };
  const rendered = (entry: EntryRecord): RenderedEntry => ({ entry, text: entryText(entry) });
  const joined = (entries: readonly { text: string }[]) => entries.map((e) => e.text).filter((text) => text !== "").join("\n");
  /** The IDs of the active context as last printed, or null before the first print. */
  let printed: number[] | null = null;
  let shown: string | null = null;
  let liveShown: string | null = null;
  /** The thread as last polled, and its conversation as last streamed. */
  let detail: ThreadDetail | null = null;
  let streamed: View | null = null;
  /** A Claude worker's transcript as streamed, or "none" when it does not stream. */
  let transcript: Transcript | "none" | null = null;
  /** What of the transcript is printed, so each entry prints once across reconnects. */
  const claudePrinted = claudeFrames();
  /** The pull requests printed since the last whole print of the transcript, which Claude Code names again and again. */
  let pullRequests = new Set<string>();
  /** Whether the text stream has printed any of the transcript, which a replaced one then says it replaces. */
  let textShown = false;
  const firstDetail = Promise.withResolvers<ThreadDetail>();
  /** What each source failed with last, while it fails. After an outage the state is printed again. */
  const failing = new Map<"poll" | "stream", string>();
  let recovered = false;
  const failed = (source: "poll" | "stream", err: unknown) => {
    if (!(err instanceof CliError) || !transient(err)) throw err;
    if (![...failing.values()].includes(err.message)) emit({ type: "error", thread: id, kind: err.kind, message: err.message }, `-- ${err.message}. Retrying`);
    failing.set(source, err.message);
  };
  const succeeded = (source: "poll" | "stream") => {
    if (failing.delete(source) && failing.size === 0) recovered = true;
  };

  /** Prints what the harness conversation gained, and answers what its run does, or null until its first frame. */
  function printConversation(d: ThreadDetail): { working: boolean; live: WatchLive } | null {
    // A thread with a conversation waits for its first frame.
    if (d.agent !== null && streamed === null) return null;
    const view = d.agent === null ? null : streamed;
    // Without a conversation, the entries last printed stand. The first print shows an empty context.
    const entries: readonly EntryRecord[] | null = view?.entries ?? (printed === null ? [] : null);
    if (entries !== null) {
      const before = printed;
      const appended = before !== null && entries.length >= before.length && before.every((entryId, i) => entries[i]!.id === entryId);
      if (appended) {
        for (const entry of entries.slice(before.length)) {
          const e = rendered(entry);
          emit({ type: "entry", thread: id, ...e }, e.text);
        }
      } else {
        const all = entries.map(rendered);
        emit({ type: "reset", thread: id, entries: all }, before === null ? joined(all) : `-- The conversation was rewritten. It now reads:\n${joined(all)}`);
      }
      printed = entries.map((e) => e.id);
    }
    return { working: view !== null && busy(view), live: liveOf(id, view) };
  }

  /** Prints what a Claude worker's transcript gained, and answers what its turn does, or null until its first frame. */
  function printTranscript(d: ThreadDetail): { working: boolean; live: WatchLive } | null {
    if (transcript === null) return null;
    if (transcript === "none") return { working: d.thread.sessionTurnRunning === true, live: { type: "live", thread: id, queued: [], tools: [], partial: null, retry: null } };
    const frame = claudePrinted(transcript);
    const claudeRendered = (entry: ClaudeEntry): RenderedClaudeEntry => ({
      entry, text: entry.kind === "result" && entry.isError ? `[tool error] ${clip(entry.output, 400)}` : claudeEntryText(entry, pullRequests),
    });
    if (frame?.reset === true) {
      pullRequests = new Set();
      const all = frame.entries.map(claudeRendered);
      // A worker's first session replaces an empty transcript, which replaces nothing a person saw.
      emit({ type: "claude-reset", thread: id, session: frame.session, dropped: frame.dropped, entries: all }, textShown ? `-- Claude's transcript was replaced. It now reads:\n${joined(all)}` : joined(all));
      textShown = all.some((e) => e.text !== "");
    } else {
      for (const entry of frame?.entries ?? []) {
        const e = claudeRendered(entry);
        textShown ||= e.text !== "";
        emit({ type: "claude-entry", thread: id, ...e }, e.text);
      }
    }
    return { working: transcript.working, live: claudeLiveOf(id, transcript) };
  }

  function print() {
    const d = detail;
    if (d === null) return;
    const run = d.claudeWorker === undefined ? printConversation(d) : printTranscript(d);
    if (run === null) return;
    const state = stateOf(d, run.working, run.live.queued.length);
    const key = JSON.stringify(state);
    // After an outage the state is printed again, which tells the consumer the control plane is back.
    if (key !== shown || recovered) emit(state, stateText(state));
    shown = key;
    recovered = false;
    // The text stream already says what the state does of the run, so only JSON carries it.
    const liveKey = JSON.stringify(run.live);
    if (liveKey !== liveShown) emit(run.live, "");
    liveShown = liveKey;
  }

  /** Each connection's first frame is the whole view, and each later one replaces what changed. */
  const onView = (data: unknown, first: boolean) => {
    const frame = data as ViewFrame;
    const docs = { ...first ? {} : streamed!.docs, ...frame.docs };
    for (const [kind, doc] of Object.entries(docs)) if (doc === null) delete docs[kind];
    streamed = { entries: frame.entries ?? streamed!.entries, docs: docs as View["docs"] };
  };
  /** Each connection's first frame is the whole transcript, and each later one adds entries. */
  const onTranscript = (data: unknown) => {
    const { reset, ...frame } = data as ClaudeFrame;
    const entries = reset || transcript === null || transcript === "none" ? frame.entries : [...transcript.entries, ...frame.entries];
    // The server keeps the same newest maxEntries, and its `dropped` counts every entry before them.
    transcript = { ...frame, entries: entries.slice(-maxEntries) };
  };

  const stop = new AbortController();
  /**
   * A dropped stream is opened again after 100 ms, doubling up to the poll interval, and from 100 ms again once a
   * frame arrives. A thread without a conversation, or a deleted one, refuses the stream, and never streams again.
   */
  async function stream() {
    const claude = (await firstDetail.promise).claudeWorker !== undefined;
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      let first = true;
      try {
        await follow(claude ? `${thread(id)}/claude/events` : `${thread(id)}/events`, (data) => {
          if (claude) onTranscript(data);
          else onView(data, first);
          first = false;
          attempt = 0;
          succeeded("stream");
          print();
        }, stop.signal);
      } catch (err) {
        if (err instanceof CliError && err.kind === "conflict") {
          // A deleted thread's transcript is gone, and its poll still prints its state.
          if (claude) transcript = "none";
          return;
        }
        failed("stream", err);
      }
      await sleep(Math.min(100 * 2 ** attempt, intervalMs), undefined, { signal: stop.signal }).catch(() => {});
    }
  }
  async function poll() {
    while (!stop.signal.aborted) {
      try {
        detail = await api("GET", thread(id)) as ThreadDetail;
        firstDetail.resolve(detail);
        succeeded("poll");
        print();
        if (detail.thread.status === "deleted") return;
      } catch (err) {
        failed("poll", err);
      }
      await sleep(intervalMs, undefined, { signal: stop.signal }).catch(() => {});
    }
  }
  // Only the poll ends the watch. The stream stops early for a thread without a conversation, which leaves the
  // watch running, or with a failure such as a refusal, which ends it.
  const dispose = untilConsumerGone(() => process.exit(0));
  const streaming = stream();
  try {
    await Promise.race([poll(), streaming.then(() => new Promise<never>(() => {}))]);
  } finally {
    stop.abort();
    dispose();
  }
}

export const watchCommands: Readonly<Record<string, Command>> = {
  conversation: {
    args: [1, 1],
    async run(api, [id]) {
      const served = agentView(await api("GET", `${thread(id!)}/conversation`) as ConversationView | ClaudeConversation);
      return { json: served.view, text: served.kind === "claude" ? claudeText(served.view) : conversationText(served.view) };
    },
  },
  watch: {
    args: [1, 1],
    options: { interval: { type: "string" } },
    async run(api, [id], v, follow) {
      const interval = int(str(v, "interval"), "--interval", 2000);
      if (interval === 0) throw new CliError("invalid", "--interval must be above 0");
      await watch(api, follow, id!, interval, v.json === true);
    },
  },
};
