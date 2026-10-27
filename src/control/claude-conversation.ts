/**
 * The conversations of Claude worker threads. Each is read from its session's transcript in the pylon and kept in
 * the registry, so a paused pylon, or a control plane that restarted, still shows what the last read saw.
 *
 * Reading never wakes a pylon and is never human activity: a thread is read only while its node's last observation
 * reports its pylon running, and a read that fails, such as on a pylon that stopped meanwhile, keeps what is stored.
 * The session events say when to read, so an idle thread costs no pylon traffic. Each session event the log retains
 * for a Claude worker thread is followed by a read, a watched thread is read every `workingReadMs` while a turn of
 * its session runs, so its entries show during the turn, and a watch reads once when it starts.
 */
import { sessionKinds } from "../events.ts";
import { readTranscript, transcriptStart, type ClaudeConversation, type ClaudeEntry, type TranscriptRead } from "../claude-transcript.ts";
import type { NodeName, ProbeClient } from "../protocol.ts";
import type { Registry, Thread, ThreadId } from "./registry.ts";

export interface ClaudeConversations {
  /** From the registry alone, so it never reaches the pylon. */
  view(t: Thread): ClaudeConversation;
  /** Reads what the transcript gained since the last read. It never rejects: a failed read keeps what is stored. */
  refresh(t: Thread): Promise<void>;
  /** The view now, then the view after each read that changed it and whenever a turn starts or ends, until `stop`. */
  watch(t: Thread): Promise<ClaudeWatch>;
  close(): void;
}

export interface ClaudeWatch {
  readonly value: ClaudeConversation;
  start(listener: (view: ClaudeConversation) => void | Promise<void>): void;
  stop(): Promise<void>;
  /** Settles once the watch is stopped, or the service closed. */
  readonly closed: Promise<unknown>;
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
  /**
   * The newest view while the thread is watched, whose entries the next view reads on from. A read that replaces the
   * transcript drops it, as only these reads write the transcript.
   */
  kept: ClaudeConversation | null;
}

/** One refresh takes this many reads at most. A transcript with more to read goes on in the refresh after it. */
const maxReadsPerRefresh = 16;

export function claudeConversations(options: { registry: Registry; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "stream">>; workingReadMs?: number; followMs?: number }): ClaudeConversations {
  const { registry, probes, workingReadMs = 2_000, followMs = 1_000 } = options;
  const readers = new Map<ThreadId, Reader>();
  let closed = false;

  const readerOf = (id: ThreadId): Reader => {
    let r = readers.get(id);
    if (r === undefined) readers.set(id, r = { reading: null, next: null, watchers: new Set(), timer: null, working: false, failure: null, kept: null });
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

  /** The probe that can read the thread's pylon now, or null while its node does not report it running. */
  function probeOf(t: Thread): Pick<ProbeClient, "stream"> | null {
    const pylon = registry.pylon(t.pylonId);
    const node = pylon === undefined ? undefined : registry.node(pylon.node);
    const running = node?.state === "online" && node.observation?.pylons.some((p) => p.pylonId === t.pylonId && p.phase === "running") === true;
    return running ? probes.get(pylon!.node) ?? null : null;
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
      const probe = probeOf(t);
      if (probe === null) return;
      const stored = registry.claudeTranscript(id);
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
      // Null is a session that has written no transcript yet, which the read still dates.
      const appended = registry.appendClaudeRead(id, {
        session, from, entries: found?.entries ?? [], cursor: found?.cursor ?? from, reset: found?.reset ?? false, readAt: Date.now(),
      });
      if (appended && found?.reset === true) r.kept = null;
      // A read that found nothing new changes only `readAt`, which no watcher shows once it is set.
      update(id, r, appended && (stored?.session !== session || (found !== null && (found.entries.length > 0 || found.reset))));
      if (found === null || !found.more) return;
    }
    if (!closed) void refreshOf(id);
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
  let cursor = registry.eventBatch("0", { kinds: sessionKinds }).watermark;
  const follow = setInterval(() => {
    let batch: ReturnType<Registry["eventBatch"]>;
    try {
      batch = registry.eventBatch(cursor, { kinds: sessionKinds });
    } catch (err) {
      console.error(`following session events for Claude transcripts: ${(err as Error).message}. Following from the newest`);
      cursor = registry.eventBatch("0", { kinds: sessionKinds }).watermark;
      return;
    }
    cursor = batch.watermark;
    for (const id of new Set(batch.events.flatMap((e) => e.thread === null ? [] : [e.thread as ThreadId]))) {
      if (registry.claudeWorker(id) === undefined) continue;
      update(id, readerOf(id), false);
      void refreshOf(id);
    }
  }, followMs);
  follow.unref();

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
      clearInterval(follow);
      for (const r of readers.values()) {
        clearInterval(r.timer ?? undefined);
        r.timer = null;
        for (const w of r.watchers) w.closed.resolve();
      }
    },
  };
}
