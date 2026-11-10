/** The integrations read the watch's events, whose types src/contract/watch.ts holds. */
import type { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { CliError, UsageError } from "../transport.ts";
import { type Api, type Follow, type Command, type Io, type Result, type Values, str, request, int, clip, reconnectMs, untilConsumerGone } from "../kit.ts";
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

/** How a watch that waits for the run's reply ends, by the exit code it ends with, as docs/cli.md#waiting-for-the-reply lists them. */
const untilIdleExits = { replied: 0, parked: 10, failed: 11, waiting: 12 } as const;
interface Ending { outcome: keyof typeof untilIdleExits; text: string }
/** The thread as the wait began. Its reply and its questions then came before the run waited for. */
type Since = Pick<ThreadDetail, "lastReplyAt" | "questions">;
/** With `from`, the text's first print starts at the newest entry that ends with that message. */
interface Until { since: Since | null; from: string | null }

/**
 * A failure, a new question or a Claude prompt ends the wait at once, since the run cannot go on without the person.
 * They need only the thread's detail, so they end it while the conversation's stream has not opened.
 */
function stopped(d: ThreadDetail, since: Since): Ending | null {
  const status = d.thread.status;
  if (status === "archived" || status === "deleted") return { outcome: "failed", text: `The thread was ${status} before its run replied` };
  if (d.attention === "failed") return { outcome: "failed", text: `It failed: ${(d.pylon.failed ?? d.claudeWorker?.message ?? "no reason given").split("\n")[0]}` };
  const asked = d.questions.some((q) => q.answer === null && q.withdrawn === undefined && !since.questions.some((old) => old.id === q.id));
  if (asked) return { outcome: "waiting", text: `It asks you a question, which \`nexus show ${d.thread.id}\` shows` };
  if (d.claudeWorker !== undefined && d.thread.sessionWaiting === true) return { outcome: "waiting", text: `Claude waits for your input in its terminal${d.thread.sessionWaitingMessage === undefined ? "" : `: ${d.thread.sessionWaitingMessage}`}` };
  const parked = d.agent?.parkedTasks ?? 0;
  if (parked > 0) return { outcome: "parked", text: `${parked} parked tasks hold the run, which \`nexus retry ${d.thread.id}\` retries` };
  return null;
}

/**
 * A run has ended once nothing runs or is queued and the control plane holds a reply later than the one before the
 * wait, as it records one at every end of a run, a Claude turn's usage-limit stop and death included.
 */
const runEnded = (d: ThreadDetail, run: { working: boolean; queued: number } | null, since: Since) =>
  run !== null && !run.working && run.queued === 0 && (d.lastReplyAt ?? -Infinity) > (since.lastReplyAt ?? -Infinity);

/** Nexus's resumer records that it resumes a dead turn on its next pass, every 15 s, so the wait gives it two. */
const resumeGraceMs = 30_000;

/**
 * What a dead Claude turn means once it has waited `waitedMs` for Nexus to resume it: null while Nexus resumes it,
 * or may still, since only a builder's turn is resumed and only a pass after the death records that.
 */
function deathEnding(d: ThreadDetail, died: NonNullable<ThreadDetail["thread"]["turnDied"]>, waitedMs: number): Ending | null {
  const resume = d.resume ?? null;
  if (resume?.state === "person") return { outcome: "waiting", text: `Its turn died, and Nexus stopped resuming it: ${resume.why}` };
  if (resume?.state === "left-alone") return { outcome: "failed", text: `Its turn died, and Nexus leaves it to you, as you wrote to it: ${died.reason}` };
  if (resume !== null && resume.turn >= died.at) return null;
  return waitedMs >= resumeGraceMs ? { outcome: "failed", text: `Its turn died, and Nexus did not resume it: ${died.reason}` } : null;
}

/**
 * What the end of a run means, from the detail read once the transcript is read through it, since the control plane
 * finds a Claude turn's usage-limit stop or death in its transcript. Null for a death Nexus resumes or may resume.
 */
function afterRun(d: ThreadDetail): Ending | null {
  const limit = d.thread.usageLimit;
  if (limit !== undefined) return { outcome: "waiting", text: `Claude stopped on its usage limit${limit.resetsAt === null ? "" : `, which resets at ${new Date(limit.resetsAt).toISOString()}`}. Send it "continue" after the reset` };
  if (d.thread.turnDied !== undefined) return deathEnding(d, d.thread.turnDied, 0);
  return d.attention === "decision" ? { outcome: "waiting", text: `It replied, and waits on your decision, which \`nexus show ${d.thread.id}\` says` } : { outcome: "replied", text: "It replied." };
}

/**
 * The conversation is pi-durable's active context, not the full history: a new head marker, a compaction or a delete can reorder or drop entries.
 * So the first print shows the context whole, a later one that only appends prints each new entry, and any other
 * change prints it whole again. A Claude worker's transcript streams instead, and prints the same way, whole first
 * and when it was replaced. Then the thread's state and the run in flight, when they changed. Every print comes
 * from the latest of both sources, so an answer's entry is printed before the live event that drops its partial.
 * An unreachable or failing control plane is reported once and retried through, so a live pane survives a restart
 * of the control plane. Ends after the state that says the thread is deleted, or once the process that started it
 * is gone, and with `until` once the run ends as `ending` says, whose code it answers.
 */
async function watch(api: Api, follow: Follow, id: string, intervalMs: number, json: boolean, output: Writable, until: Until | null = null): Promise<number> {
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
  let transcriptShown = false;
  let since = until?.since ?? null;
  const ended = Promise.withResolvers<number>();
  let over = false;
  /** The dead turn the wait holds for Nexus to resume, and when the wait saw it. */
  let death: { at: number; seen: number } | null = null;
  const sent = until?.from == null ? null : until.from.split("\n").map((line) => `> ${line}`).join("\n");
  /** What the text's first print shows: all of it, or from the sent message on, which is nothing until it joins. */
  const backlogOf = <E extends { text: string }>(all: E[]): E[] => {
    if (sent === null) return all;
    const at = all.findLastIndex((e) => e.text.endsWith(sent));
    return at === -1 ? [] : all.slice(at);
  };
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
        emit({ type: "reset", thread: id, entries: all }, before === null ? joined(backlogOf(all)) : `-- The conversation was rewritten. It now reads:\n${joined(all)}`);
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
      const shownNow = transcriptShown ? all : backlogOf(all);
      emit({ type: "claude-reset", thread: id, session: frame.session, dropped: frame.dropped, entries: all }, textShown ? `-- Claude's transcript was replaced. It now reads:\n${joined(all)}` : joined(shownNow));
      textShown = shownNow.some((e) => e.text !== "");
    } else {
      for (const entry of frame?.entries ?? []) {
        const e = claudeRendered(entry);
        textShown ||= e.text !== "";
        emit({ type: "claude-entry", thread: id, ...e }, e.text);
      }
    }
    transcriptShown = true;
    return { working: transcript.working, live: claudeLiveOf(id, transcript) };
  }

  function print() {
    const d = detail;
    if (d === null || over) return;
    const run = d.claudeWorker === undefined ? printConversation(d) : printTranscript(d);
    if (run !== null) {
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
    if (until === null) return;
    since ??= d;
    const end = stopped(d, since);
    if (end !== null) return finish(end);
    const died = d.thread.turnDied;
    if (death !== null && !d.thread.working && died?.at === death.at && (d.lastReplyAt ?? -Infinity) <= (since.lastReplyAt ?? -Infinity)) {
      const dead = deathEnding(d, died, Date.now() - death.seen);
      return dead === null ? undefined : finish(dead);
    }
    death = null;
    if (!runEnded(d, run === null ? null : { working: run.working, queued: run.live.queued.length }, since)) return;
    over = true;
    void settle(d, since);
  }

  function finish(end: Ending) {
    over = true;
    if (!json) output.write(`-- ${end.text}\n`);
    ended.resolve(untilIdleExits[end.outcome]);
  }

  /**
   * The stream can lag the reply the poll saw recorded: a pi stream that missed the run's commits, or a Claude stream
   * that says the turn ended before the control plane read what it wrote. So the run's end prints what the
   * conversation's route reads, then reads the detail again for what the end means, through any run that ended
   * meanwhile. A run working again, as a resumed turn does, keeps the wait. A failed read still ends the wait, since
   * the reply is recorded and only the printing lags it.
   */
  async function settle(d: ThreadDetail, before: Since) {
    let after = d;
    try {
      for (let through = d; ; through = after) {
        await readThrough(through);
        after = await request(api, threadRoutes.show, { thread: id });
        if ((after.lastReplyAt ?? -Infinity) <= (through.lastReplyAt ?? -Infinity)) break;
      }
    } catch {}
    const end = stopped(after, before) ?? (after.thread.working ? null : afterRun(after));
    if (end !== null) return finish(end);
    since = { ...before, lastReplyAt: after.lastReplyAt };
    const died = after.thread.turnDied;
    if (!after.thread.working && died !== undefined) {
      death = { at: died.at, seen: Date.now() };
      if (!json) output.write(`-- Its turn died: ${died.reason}. Waiting for Nexus to resume it\n`);
    }
    over = false;
  }

  /** The route reads a Claude transcript first, waiting a while, so this reads until a read began after the reply was recorded. */
  async function readThrough(d: ThreadDetail) {
    for (let reads = 0; reads < 3; reads++) {
      const read = agentView((await request(api, threadRoutes.conversation, { thread: id }))!);
      if (read.kind !== "claude") {
        streamed = { entries: read.view.entries, docs: read.view.docs };
        printConversation(d);
        return;
      }
      transcript = { session: read.view.session, entries: read.view.entries.slice(-maxEntries), dropped: read.view.dropped, working: read.view.working };
      printTranscript(d);
      if ((read.view.readAt ?? -Infinity) >= (d.lastReplyAt ?? Infinity)) return;
    }
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
  const dispose = untilConsumerGone(() => process.exit(0));
  const streaming = stream();
  try {
    return await Promise.race([ended.promise, poll().then(() => until === null ? 0 : untilIdleExits.failed), streaming.then(() => new Promise<never>(() => {}))]);
  } finally {
    stop.abort();
    dispose();
  }
}

const intervalOf = (v: Values) => {
  const interval = int(str(v, "interval"), "--interval", 2000);
  if (interval === 0) throw new UsageError("--interval must be above 0");
  return interval;
};

/** The options of a start or send that waits for the reply. */
export const watchOptions = { watch: { type: "boolean" }, interval: { type: "string" } } as const;

/** The poll of a start's or send's `--watch`, or null without one, read before the request so a bad flag sends nothing. */
export function watchOf(v: Values): number | null {
  if (v.watch === true) return intervalOf(v);
  if (v.interval !== undefined) throw new UsageError("--interval goes with --watch");
  return null;
}

/**
 * With `--watch`, prints what the start or send did, then the run as it goes until it ends, as `watch --until-idle`
 * does, and answers its exit code. Its `--json` reply is one line, so every line of the output is one JSON value.
 */
export async function thenWatch(api: Api, follow: Follow, io: Io, v: Values, interval: number | null, id: string, done: Result, until: Until): Promise<Result | number> {
  if (interval === null) return done;
  io.stdout.write(`${v.json === true ? JSON.stringify(done.json) : done.text}\n`);
  return await watch(api, follow, id, interval, v.json === true, io.stdout, until);
}

/** The newest `last` entries that print anything, or with "reply" the newest reply. */
function lastOf<E>(entries: readonly E[], text: (e: E) => string, reply: (e: E) => boolean, last: number | "reply"): { entries: E[]; text: string } {
  const shown = entries.flatMap((e) => {
    const t = text(e);
    return t === "" ? [] : [{ e, t }];
  });
  const picked = last === "reply" ? shown.filter(({ e }) => reply(e)).slice(-1) : shown.slice(-last);
  return { entries: picked.map(({ e }) => e), text: picked.length > 0 ? picked.map(({ t }) => t).join("\n\n") : last === "reply" ? "No reply yet." : "No messages yet." };
}
const repliedIn = (entry: EntryRecord) => (entry.model ?? []).some((m) => m.role === "assistant" && m.content.some((part) => part.type === "text" && part.text !== ""));

export const watchCommands: Readonly<Record<string, Command>> = {
  conversation: {
    help: [
      "  nexus conversation <thread> [--last [N]]     the agent's transcript, or the Claude worker's",
      "    --last prints only the newest reply, and --last N the newest N entries",
    ],
    args: [1, 2],
    thread: true,
    options: { last: { type: "boolean" } },
    async run(api, [id, count], v) {
      if (count !== undefined && v.last !== true) throw new UsageError(`conversation takes a count only after --last, got ${count}`);
      const last = v.last !== true ? null : count === undefined ? "reply" : int(count, "--last", 1);
      if (last === 0) throw new UsageError("--last N must be above 0");
      const served = agentView((await request(api, threadRoutes.conversation, { thread: id! }))!);
      if (last === null) return { json: served.view, text: served.kind === "claude" ? claudeText(served.view) : conversationText(served.view) };
      if (served.kind === "claude") {
        const pullRequests = new Set<string>();
        const picked = lastOf(served.view.entries, (e) => claudeEntryText(e, pullRequests), (e) => e.kind === "reply", last);
        return { json: { ...served.view, entries: picked.entries }, text: picked.text };
      }
      const picked = lastOf(served.view.entries, entryText, repliedIn, last);
      return { json: { ...served.view, entries: picked.entries }, text: picked.text };
    },
  },
  watch: {
    help: [
      "  nexus watch <thread> [--interval MS] [--until-idle]   the conversation, or the Claude worker's transcript, as it grows",
      "    --until-idle ends once the run replies, with exit code 0, or 10 when it parks, 11 when it fails, 12 when it waits on you",
    ],
    args: [1, 1],
    thread: true,
    options: { interval: { type: "string" }, "until-idle": { type: "boolean" } },
    async run(api, [id], v, follow, { io }) {
      return await watch(api, follow, id!, intervalOf(v), v.json === true, io.stdout, v["until-idle"] === true ? { since: null, from: null } : null);
    },
  },
};
