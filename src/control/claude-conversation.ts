/**
 * The conversations of Claude worker threads. Each is read from its session's transcript in the pylon and kept in
 * the registry, so a paused pylon, or a control plane that restarted, still shows what the last read saw.
 *
 * Reading never wakes a pylon and is never human activity: a thread is read only while its node's last observation
 * reports its pylon running, and a read that fails, such as on a pylon that stopped meanwhile, keeps what is stored.
 * The session events say when to read, so an idle thread costs no pylon traffic. Each session event the log retains
 * for a Claude worker thread is followed by a read, a watched thread is read every `workingReadMs` while a turn of
 * its session runs, so its entries show during the turn, and a watch reads once when it starts.
 *
 * A read that reaches the transcript's end then asks the pylon's hook which AskUserQuestion dialogs wait, and the
 * registry opens and withdraws the worker's asks from that. The transcript cannot say: Claude may write the call to it
 * only once its dialog is answered. It asks while one of the thread's asks is open, and while a turn runs or waits it
 * asks once after each session event or the reader's start, since the hook reports an event once a dialog waits, and
 * at each read until the hook reports none, once it reported some. The working reads alone do not ask otherwise.
 */
import { sessionKinds } from "../events.ts";
import { readTranscript, transcriptDeadlineMs, transcriptStart, type ClaudeConversation, type ClaudeEntry, type TranscriptRead } from "../claude-transcript.ts";
import { claudeHook, maxAsksBytes } from "../../images/pylon/nexus-contract.ts";
import { followEvents } from "./follow-events.ts";
import { pipeOutput, type OpenPipe } from "../pipe.ts";
import type { NodeName, PylonId, ThreadId } from "../ids.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { runningProbe } from "./observed.ts";
import { reportedAsks, type WaitingAsk } from "./questions.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import type { Watch } from "./conversation-view.ts";

export interface ClaudeConversations {
  /** From the registry alone, so it never reaches the pylon. */
  view(t: Thread): ClaudeConversation;
  /** Reads what the transcript gained since the last read. It never rejects: a failed read keeps what is stored. */
  refresh(t: Thread): Promise<void>;
  /** The view now, then the view after each read that changed it and whenever a turn starts or ends, until `stop`. */
  watch(t: Thread): Promise<Watch<ClaudeConversation>>;
  close(): void;
}

/** A watch's listener is null until it starts. */
interface Watcher { listener: ((view: ClaudeConversation) => void | Promise<void>) | null; closed: PromiseWithResolvers<void> }

/** One thread's reads run one at a time. A refresh asked for while one runs joins the one that runs after it. */
interface Reader {
  reading: Promise<void> | null;
  next: Promise<void> | null;
  watchers: Set<Watcher>;
  /** Reads a watched thread while a turn runs. */
  timer: NodeJS.Timeout | null;
  /** Whether a turn ran when the watchers were last told, so they hear when it starts or ends. */
  working: boolean;
  /** The failure logged last, so a pylon that keeps failing is logged once. */
  failure: string | null;
  /** The same, for pulls of the asks that wait. */
  askFailure: string | null;
  /** Whether a pull is due while a turn runs or waits: since the reader started, a session event, or a failed pull. */
  asksDue: boolean;
  /**
   * Whether the last report this reader stored was empty, which storing an empty one again would not change. Until it
   * is, each read asks while a turn runs or waits, since a withdrawn ask's hook may still wait.
   */
  storedNone: boolean;
  /**
   * The newest view while the thread is watched, whose entries the next view reads on from. A read that replaces the
   * transcript drops it, as only these reads write the transcript.
   */
  kept: ClaudeConversation | null;
}

/** The asks whose dialogs wait in the pylon, as its hook reports them. */
async function readWaitingAsks(open: OpenPipe): Promise<WaitingAsk[]> {
  const { out } = await pipeOutput(await open([claudeHook, "asks"]), { deadlineMs: transcriptDeadlineMs, maxBytes: maxAsksBytes, what: "its waiting asks" });
  return reportedAsks(out.toString("utf8"));
}

/** One refresh takes this many reads at most. A transcript with more to read goes on in the refresh after it. */
const maxReadsPerRefresh = 16;

export function claudeConversations(options: { registry: Registry; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "stream">>; workingReadMs?: number; followMs?: number }): ClaudeConversations {
  const { registry, probes, workingReadMs = 2_000, followMs = 1_000 } = options;
  const readers = new Map<ThreadId, Reader>();
  let closed = false;

  const readerOf = (id: ThreadId): Reader => {
    let r = readers.get(id);
    if (r === undefined) readers.set(id, r = { reading: null, next: null, watchers: new Set(), timer: null, working: false, failure: null, askFailure: null, asksDue: true, storedNone: false, kept: null });
    return r;
  };

  function view(t: Thread): ClaudeConversation {
    const now = registry.thread(t.id) ?? t;
    const session = registry.claudeWorker(t.id)?.session ?? null;
    const stored = registry.claudeTranscript(t.id);
    // A transcript of another session than the worker's is one its launch replaced, and the next read replaces it.
    const current = stored !== undefined && stored.session === session ? stored : undefined;
    const r = readers.get(t.id);
    const kept = r !== undefined && r.watchers.size > 0 ? r.kept : undefined;
    const value: ClaudeConversation = {
      kind: "claude", session,
      entries: current === undefined ? [] : entriesOf(t.id, current.dropped, kept?.session === session ? kept : null), dropped: current?.dropped ?? 0, readAt: current?.readAt ?? null,
      working: now.sessionTurnRunning === true, usageLimit: now.usageLimit ?? null,
    };
    if (kept !== undefined) r!.kept = value;
    return value;
  }

  /** The stored entries, reading only those after `kept`'s, and `kept`'s own while nothing was added or dropped. */
  function entriesOf(id: ThreadId, dropped: number, kept: ClaudeConversation | null): readonly ClaudeEntry[] {
    if (kept === null) return registry.claudeEntries(id);
    const after = registry.claudeEntries(id, kept.dropped + kept.entries.length);
    return after.length === 0 && dropped === kept.dropped ? kept.entries : [...kept.entries.slice(dropped - kept.dropped), ...after];
  }

  /**
   * Starts or stops the reads of a watched turn, and tells the watchers after a read that changed the transcript or
   * when a turn starts or ends.
   */
  function update(id: ThreadId, r: Reader, read: boolean) {
    const t = registry.thread(id);
    const working = t?.sessionTurnRunning === true;
    if (working && r.watchers.size > 0 && !closed) {
      r.timer ??= setInterval(() => void refreshOf(id), workingReadMs);
      r.timer.unref();
    } else if (r.timer !== null) {
      clearInterval(r.timer);
      r.timer = null;
    }
    const changed = working !== r.working;
    r.working = working;
    if (t === undefined || r.watchers.size === 0 || (!read && !changed)) return;
    const value = view(t);
    for (const w of r.watchers) void w.listener?.(value);
  }

  async function catchUp(id: ThreadId, r: Reader) {
    for (let reads = 0; reads < maxReadsPerRefresh && !closed; reads++) {
      const t = registry.thread(id);
      const session = registry.claudeWorker(id)?.session ?? null;
      if (t === undefined || t.status === "deleted" || session === null) return;
      const probe = runningProbe(registry, probes, t);
      if (probe === null) return;
      const stored = registry.claudeTranscript(id);
      const startedAt = Date.now();
      const from = stored?.session === session ? stored.cursor : transcriptStart;
      let found: TranscriptRead | null;
      try {
        found = await readTranscript((argv) => probe.stream(t.pylonId, argv), session, from);
      } catch (err) {
        const message = (err as Error).message;
        if (r.failure !== message) console.error(`${t.pylonId}: reading Claude's transcript failed, so it shows the last read: ${message}`);
        r.failure = message;
        return;
      }
      r.failure = null;
      // A delete meanwhile removed the transcript, which this read must not bring back.
      if (closed || registry.thread(id)?.status === "deleted") return;
      // A read that reaches the transcript's end dates it by its start, so every reply recorded before then is stored.
      // One that stops short keeps the date of the last that reached the end. Null is a session that has written no
      // transcript yet, which the read still dates.
      const readAt = found === null || !found.more ? startedAt : stored?.session === session && !found.reset ? stored.readAt : 0;
      const appended = registry.appendClaudeRead(id, {
        session, from, entries: found?.entries ?? [], cursor: found?.cursor ?? from, reset: found?.reset ?? false, readAt,
      });
      if (appended && found?.reset === true) r.kept = null;
      // A read that found nothing new changes only `readAt`, which no watcher shows once it is set.
      update(id, r, appended && (stored?.session !== session || (found !== null && (found.entries.length > 0 || found.reset))));
      if (found === null || !found.more) return await pullAsks(id, r, t.pylonId, probe);
    }
    if (!closed) void refreshOf(id);
  }

  /**
   * Stores which asks wait in the pylon, while one of the thread's asks is open and may have closed, or while a turn
   * runs or waits, and so may show a dialog, and a pull is due or the last report stored had asks. A delivery that
   * gave up withdraws its ask while the hook may still wait, and no event follows. A pull that fails keeps the last
   * report, as a failed read keeps the transcript, and is due again. An empty report after an empty one is not stored
   * again. A report with asks is, since withdrawing an ask or archiving the thread drops what is stored.
   */
  async function pullAsks(id: ThreadId, r: Reader, pylonId: PylonId, probe: Pick<ProbeClient, "stream">) {
    const t = registry.thread(id);
    if (t === undefined) return;
    const open = registry.questions(id).some((q) => q.ask !== undefined && q.answer === null);
    if (!open && !((r.asksDue || !r.storedNone) && (t.sessionTurnRunning === true || t.sessionWaiting === true))) return;
    r.asksDue = false;
    let asks: WaitingAsk[];
    try {
      asks = await readWaitingAsks((argv) => probe.stream(pylonId, argv));
    } catch (err) {
      r.asksDue = true;
      const message = (err as Error).message;
      if (r.askFailure !== message) console.error(`${pylonId}: asking which of Claude's questions wait failed, so the last report stands: ${message}`);
      r.askFailure = message;
      return;
    }
    r.askFailure = null;
    if (closed || registry.thread(id)?.status === "deleted") return;
    if (asks.length === 0 && r.storedNone) return;
    r.storedNone = asks.length === 0;
    update(id, r, registry.setWaitingAsks(id, asks));
  }

  /** A deleted thread's reader goes once nothing reads or watches it. */
  function release(id: ThreadId, r: Reader) {
    if (!closed && r.reading === null && r.next === null && r.watchers.size === 0 && registry.thread(id)?.status === "deleted") readers.delete(id);
  }

  function refreshOf(id: ThreadId): Promise<void> {
    const r = readerOf(id);
    if (r.reading === null) {
      return r.reading = catchUp(id, r)
        .catch((err: unknown) => console.error(`${id}: following Claude's transcript failed: ${(err as Error).message}`))
        .finally(() => {
          r.reading = null;
          release(id, r);
        });
    }
    return r.next ??= r.reading.then(() => {
      r.next = null;
      return refreshOf(id);
    });
  }

  // From the newest event, so a restart reads each thread at its next event or watch rather than every thread at once.
  const stopFollowing = followEvents(registry, sessionKinds, followMs, (events) => {
    for (const id of new Set(events.flatMap((e) => e.thread === null ? [] : [e.thread as ThreadId]))) {
      if (registry.claudeWorker(id) === undefined) continue;
      const r = readerOf(id);
      r.asksDue = true;
      update(id, r, false);
      void refreshOf(id);
    }
  }, (err) => {
    console.error(`following session events for Claude transcripts: ${err.message}. Following from the newest`);
    // The events skipped may have told a reader that a dialog waits.
    for (const r of readers.values()) r.asksDue = true;
  });

  return {
    view,
    refresh: (t) => refreshOf(t.id),
    async watch(t) {
      const r = readerOf(t.id);
      const watcher: Watcher = { listener: null, closed: Promise.withResolvers() };
      r.watchers.add(watcher);
      update(t.id, r, false);
      return {
        value: view(t),
        start(listener) {
          watcher.listener = listener;
          void refreshOf(t.id);
        },
        async stop() {
          if (r.watchers.delete(watcher)) {
            if (r.watchers.size === 0) r.kept = null;
            update(t.id, r, false);
            release(t.id, r);
          }
          watcher.closed.resolve();
        },
        closed: watcher.closed.promise,
      };
    },
    close() {
      closed = true;
      stopFollowing();
      for (const r of readers.values()) {
        clearInterval(r.timer ?? undefined);
        r.timer = null;
        for (const w of r.watchers) w.closed.resolve();
      }
    },
  };
}
