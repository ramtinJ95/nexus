/** The integrations read the watch's events, whose types src/contract/watch.ts holds. */
import type { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { CliError } from "../transport.ts";
import { type Api, type Follow, type Command, str, request, int, clip, reconnectMs, untilConsumerGone } from "../kit.ts";
import { transient } from "../config.ts";
import { agentView, threadRoutes, type ClaudeEntry, type ListeningPort, type ThreadDetail } from "../../contract/threads.ts";
import { claudeFrames, maxEntries, queuedOf, streamRoutes, type ClaudeFrame, type ViewFrame } from "../../contract/streams.ts";
import { callOf } from "../../contract/route.ts";
import type { RenderedClaudeEntry, RenderedEntry, RunLiveEvent, ThreadStateEvent, WatchEvent } from "../../contract/watch.ts";
import { entryText, type View, queuedTexts, busy, conversationText, claudeEntryText, claudeText } from "../conversation-text.ts";

function stateOf(d: ThreadDetail, working: boolean, queued: number): ThreadStateEvent {
  const parkedTasks = d.agent?.parkedTasks ?? 0;
  return {
    type: "state", thread: d.thread.id, status: d.thread.status, run: parkedTasks > 0 ? "parked" : working ? "working" : "idle",
    parkedTasks, queued, pylon: d.pylon.actualState, failed: d.pylon.failed, ports: d.ports,
  };
}

type Transcript = Omit<ClaudeFrame, "reset">;

function claudeLiveOf(id: string, c: Transcript): RunLiveEvent {
  const lastTurn = c.entries.findLastIndex((e) => e.kind === "turn");
  const done = new Set(c.entries.flatMap((e) => e.kind === "result" ? [e.toolUseId] : []));
  const running = c.working ? c.entries.slice(lastTurn + 1).flatMap((e) => e.kind === "tool" && !done.has(e.id) ? [{ callId: e.id, output: "" }] : []) : [];
  return { type: "live", thread: id, queued: queuedOf(c.entries).map((q) => q.text ?? ""), tools: running, partial: null, retry: null };
}

function liveOf(id: string, view: View | null): RunLiveEvent {
  const live = view?.docs["pi.live"] as LiveState | undefined;
  const generation = live?.generation;
  const partial = generation?.message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
  return {
    type: "live", thread: id, queued: view === null ? [] : queuedTexts(view),
    tools: (live?.tools ?? []).flatMap((slot) => slot.status === "running" ? [{ callId: slot.callId, output: slot.output ?? "" }] : []),
    partial: partial === "" ? null : partial, retry: generation?.retry?.error ?? null,
  };
}

function stateText(s: ThreadStateEvent): string {
  const run = s.run === "working" ? ", agent working" : s.run === "parked" ? `, ${s.parkedTasks} parked tasks hold the run` : "";
  const ports = (s.ports ?? []).map((l: ListeningPort) => l.preview?.ready === true ? `${l.port} at ${l.preview.url}` : String(l.port));
  return `-- ${s.status}, pylon ${s.pylon}${s.failed === null ? "" : ` (${s.failed.split("\n")[0]})`}${run}${s.queued === 0 ? "" : `, ${s.queued} queued`}${ports.length === 0 ? "" : `, listening on ${ports.join(", ")}`}`;
}

/**
 * The conversation is pi-durable's active context, not the full history: a new head marker, a compaction or a delete can reorder or drop entries.
 * So the first print shows the context whole, a later one that only appends prints each new entry, and any other
 * change prints it whole again. A Claude worker's transcript streams instead, and prints the same way, whole first
 * and when it was replaced. Then the thread's state and the run in flight, when they changed. Every print comes
 * from the latest of both sources, so an answer's entry is printed before the live event that drops its partial.
 * An unreachable or failing control plane is reported once and retried through, so a live pane survives a restart
 * of the control plane. Ends after the state that says the thread is deleted, or once the process that started it
 * is gone.
 */
async function watch(api: Api, follow: Follow, id: string, intervalMs: number, json: boolean, output: Writable): Promise<void> {
  const emit = (event: WatchEvent, text: string) => {
    if (json) output.write(`${JSON.stringify(event)}\n`);
    else if (text !== "") output.write(`${text}\n`);
  };
  const rendered = (entry: EntryRecord): RenderedEntry => ({ entry, text: entryText(entry) });
  const joined = (entries: readonly { text: string }[]) => entries.map((e) => e.text).filter((text) => text !== "").join("\n");
  let printed: number[] | null = null;
  let shown: string | null = null;
  let liveShown: string | null = null;
  let detail: ThreadDetail | null = null;
  let streamed: View | null = null;
  let transcript: Transcript | "none" | null = null;
  /** What of the transcript is printed, so each entry prints once across reconnects. */
  const claudePrinted = claudeFrames();
  /** The pull requests printed since the last whole print of the transcript, which Claude Code names again and again. */
  let pullRequests = new Set<string>();
  let textShown = false;
  const firstDetail = Promise.withResolvers<ThreadDetail>();
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

  function printConversation(d: ThreadDetail): { working: boolean; live: RunLiveEvent } | null {
    if (d.agent !== null && streamed === null) return null;
    const view = d.agent === null ? null : streamed;
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

  function printTranscript(d: ThreadDetail): { working: boolean; live: RunLiveEvent } | null {
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
  /** A thread without a conversation, or a deleted one, refuses the stream, and never streams again. */
  async function stream() {
    const claude = (await firstDetail.promise).claudeWorker !== undefined;
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      let first = true;
      try {
        await follow(callOf(claude ? streamRoutes.claudeEvents : streamRoutes.threadEvents, { thread: id }).path, (data) => {
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
      await sleep(reconnectMs(attempt, intervalMs), undefined, { signal: stop.signal }).catch(() => {});
    }
  }
  async function poll() {
    while (!stop.signal.aborted) {
      try {
        detail = await request(api, threadRoutes.show, { thread: id });
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
  const dispose = untilConsumerGone(output, () => process.exit(0));
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
    help: ["  nexus conversation <thread>                  the agent's transcript, or the Claude worker's"],
    args: [1, 1],
    thread: true,
    async run(api, [id]) {
      const served = agentView((await request(api, threadRoutes.conversation, { thread: id! }))!);
      return { json: served.view, text: served.kind === "claude" ? claudeText(served.view) : conversationText(served.view) };
    },
  },
  watch: {
    help: ["  nexus watch <thread> [--interval MS]         the conversation, or the Claude worker's transcript, as it grows"],
    args: [1, 1],
    thread: true,
    options: { interval: { type: "string" } },
    async run(api, [id], v, follow, { io }) {
      const interval = int(str(v, "interval"), "--interval", 2000);
      if (interval === 0) throw new CliError("invalid", "--interval must be above 0");
      await watch(api, follow, id!, interval, v.json === true, io.stdout);
    },
  },
};
