/**
 * The thread core: each thread, in `threads`, its pylon, sessions, previews, outputs and jobs, in `pylons`, `sessions`,
 * `previews`, `outputs` and `jobs`, the event log, in `events` and `event_receipts`, each session's turn and order, in
 * `session_activity`, `session_order` and `session_order_floor`, its Claude worker, in `claude_workers`,
 * `claude_transcripts`, `claude_entries`, `claude_messages` and `claude_senders`, its attention, in `thread_attention`,
 * each start's request ID, in `start_requests`, the harness conversations aborted, in `aborted_conversations`, and when
 * each archived thread was archived, in `thread_archives`, and the pylons whose disk that cleanup deletes, in
 * `disk_cleanups`. The
 * features with per-thread state of their own take part through a ThreadParticipant each, which the registry registers.
 */
import { attentionOf, type Attention } from "./attention.ts";
import { pylonEventSchema } from "../events.ts";
import type { ReportedEvent } from "../events.ts";
import { eventCursor, sessionActivityTtlMs, maxActiveSessions, type EventFilter, type EventKind, type NexusEvent } from "../events.ts";
import type { Sender } from "../agent-protocol.ts";
import type { StartKey } from "./start-request.ts";
import { HttpError } from "./http-error.ts";
import { json, jsonOrNull, type Db, type Row } from "./db.ts";
import type { ActivityFacts, RegistryWrite, ThreadStatus } from "../reconcile.ts";
import type { NodeName, PylonId, ThreadId } from "../ids.ts";
import type { JobStatus, Subject } from "../protocol/jobs.ts";
import type { HerdrStatus, NodeObservation } from "../protocol/observations.ts";
import type { BootInputs } from "../spawn.ts";
import type { ProjectId } from "../ids.ts";
import type { SessionHarness } from "../session-harness.ts";
import type { ThreadSetup } from "./templates.ts";
import type { PylonRecord } from "../tick.ts";
import { claudeTurn } from "../../images/pylon/nexus-contract.ts";
import { defaultClaudeModel } from "../claude-state.ts";
import { maxEntries, transcriptStart, usageLimitStop, type ClaudeEntry, type TranscriptCursor } from "../claude-transcript.ts";
import type { NodeStore } from "./node-store.ts";

/**
 * The node a thread's pylon boots on, and why. An `auto` placement keeps every node it weighed: the room a node that
 * could run the pylon has left once it boots there, or why the node could not.
 */
export type Placement =
  | { how: "default" | "named"; node: NodeName }
  | { how: "auto"; node: NodeName; weighed: readonly Weighed[] };
export type Weighed = { node: NodeName; left: Room } | { node: NodeName; refused: string };
/** Uncommitted CPUs and memory, and free disk. CPUs may go below zero, because VMs share a node's CPUs. */
export interface Room { cpus: number; memoryGiB: number; diskGiB: number }

/** A thread's own row, without what its sessions and the usage backfill say. */
export interface StoredThread extends Pick<ActivityFacts, "status" | "agentTurnRunning" | "lastAgentActivityAt" | "lastHumanActivityAt"> {
  id: ThreadId;
  title: string;
  project: ProjectId;
  pylonId: PylonId;
  conversationId: string | null; // set once pi-durable runs the thread's agent
  startedBy: string;
  createdAt: number;
  seenAt: number | null;
  lastReplyAt: number | null;
  /** Absent from a thread started before placements were recorded. */
  placement?: Placement;
  /** Absent from a thread started before setups were recorded. */
  setup?: ThreadSetup;
}

export interface Thread extends StoredThread, ActivityFacts {
  sessionWaiting?: boolean;
  /** What the most recently waiting session's report said, when it said anything. */
  sessionWaitingMessage?: string;
  /** A harness turn or a session's turn runs, such as a Claude worker's. */
  working: boolean;
  /** The earliest known start of a running harness or session turn. Absent when none runs or no start is known. */
  workingSince?: number;
  /** The Claude worker's session stopped on its usage limit and no turn of a session runs since. `resetsAt` is null when Claude Code did not say when the limit resets. */
  usageLimit?: { stoppedAt: number; resetsAt: number | null };
}

/** A Claude worker thread's worker. `session` is the Claude Code session its launch opened, null until the launch names one. */
export interface ClaudeWorker { prompt: string; state: string; model: string | null; session: string | null; message?: string }

/**
 * A thread's agent: a conversation in the control plane's harness, a Claude Code worker in its pylon, or none, as a
 * check thread has. A thread's start gives it a conversation ID or a Claude worker, never both.
 */
export type ThreadAgent = { kind: "harness"; conversationId: string } | { kind: "claude"; worker: ClaudeWorker } | { kind: "none" };

/** What the registry keeps of a pylon. The desired phase is derived from its thread on every tick. */
export type StoredPylon = Omit<PylonRecord, "desired" | "thread"> & { thread: ThreadId };

/**
 * A session of a pylon. `id` names it, and is what closes it: its Herdr pane, or `failed-` and a hash for a failed
 * session in no pane. A `paused` session comes back when its pylon wakes. A `failed` one did not come back from the
 * last wake, `message` says why, and the next wake tries it again. `status` is the Herdr status it had when last
 * read running, `unknown` if never. `title` is null for a session last observed from a probe that did not report titles.
 */
export type Session = { pylon: PylonId; id: string; harness: SessionHarness; harnessSessionId: string | null; title: string | null; status: HerdrStatus } & (
  | { state: "running"; herdrPane: string; message: null }
  | { state: "paused"; herdrPane: string | null; message: null }
  | { state: "failed"; herdrPane: string | null; message: string });
/**
 * `url` is what the data model calls a preview's URL, on its node's tailnet name. `failed` says why the preview
 * cannot answer while its node's last observation reports its service failed or its port without a route into the
 * pylon, and null otherwise. `ready` is true once the node publishes the URL, unless the running pylon's last read
 * reports the service starting, stopped or failed, or its port unrouted, whose URL answers 502 or 404 though the node
 * may publish it. A service the read does not list, such as a port linked since, is ready once published.
 */
export interface Preview { pylon: PylonId; service: string; httpsPort: number; ready: boolean; failed: string | null; url: string }
/** The https ports a node's previews are published on, both ends included. */
export interface PortRange { first: number; last: number }
export interface Output { thread: ThreadId; kind: Extract<RegistryWrite, { record: "output" }>["kind"] | "pull-request"; ref: string }

/** Where the reader of a Claude worker's transcript is in its session's file, how many entries it dropped to keep maxEntries, and when it last read. */
export interface ClaudeTranscript { session: string; cursor: TranscriptCursor; dropped: number; readAt: number }
/** What one read of a Claude worker's transcript found, from `from` to `cursor`. `reset` says the file was replaced, so `entries` start it over. */
export interface ClaudeRead { session: string; from: TranscriptCursor; entries: readonly ClaudeEntry[]; cursor: TranscriptCursor; reset: boolean; readAt: number }
/**
 * A message typed into a Claude worker, by its request ID. It is `sending` from before the probe is asked until the
 * probe answers, so a send whose answer was lost, which may have typed some of it, is not typed again. A thread keeps
 * every request ID until it is deleted, since a forgotten ID would be typed again on a resend however late it comes.
 */
export type ClaudeMessage = { state: "sending" } | { state: "sent"; result: ClaudeSent };
/** Who typed a message into a Claude worker: the person, a Nexus sender, or `unknown` for a send recorded before senders were. */
export type ClaudeMessageSender = Sender | "person" | "unknown";
/** What a send to a Claude worker answers, and answers again for a resend of its request ID. */
export interface ClaudeSent { session: string; outcome: "sent" | "queued"; resumed: boolean }

function threadRow(r: Row): StoredThread {
  return {
    id: r.id as ThreadId,
    title: r.title as string,
    project: r.project as ProjectId,
    pylonId: `pylon-${r.id as string}` as PylonId,
    status: r.status as ThreadStatus,
    conversationId: r.conversation_id as string | null,
    startedBy: r.started_by as string,
    createdAt: r.created_at as number,
    agentTurnRunning: r.agent_turn_running === 1,
    lastAgentActivityAt: r.last_agent_activity_at as number,
    lastHumanActivityAt: r.last_human_activity_at as number,
    seenAt: r.seen_at as number | null,
    lastReplyAt: r.last_reply_at as number | null,
    ...(r.placement === null ? {} : { placement: json<Placement>(r.placement) }),
    ...(r.setup === null ? {} : { setup: json<ThreadSetup>(r.setup) }),
  };
}

/** The table's checks hold each state to its fields. */
function sessionRow(r: Row): Session {
  return {
    pylon: r.pylon as PylonId, id: r.id as string, herdrPane: r.herdr_pane as string | null, harness: r.harness as SessionHarness,
    harnessSessionId: r.harness_session_id as string | null, title: r.title as string | null, status: r.status as HerdrStatus,
    state: r.state as Session["state"], message: r.message as string | null,
  } as Session;
}

function pylonRow(r: Row): StoredPylon {
  return {
    pylonId: r.id as PylonId,
    thread: r.thread as ThreadId,
    node: r.node as NodeName,
    boot: json(r.boot),
    firstBoot: json(r.first_boot),
    live: json(r.live),
    liveHash: r.live_hash as StoredPylon["liveHash"],
    pauses: r.pauses as number,
    submitted: jsonOrNull(r.submitted),
    attempts: json(r.attempts),
    failed: r.failed as string | null,
    retrying: r.retrying === 1,
  };
}

/** A feature with per-thread state the core consults or keeps in step, registered before start(). */
export interface ThreadParticipant {
  /** Whether the feature waits on the person for the thread, which makes its attention a decision. */
  needsPerson?(thread: ThreadId): boolean;
  /** The thread was archived or deleted, so its pylon pauses. */
  closed?(thread: ThreadId): void;
  /** The thread's Claude worker, its transcript or its status changed. */
  reconcile?(thread: ThreadId): void;
  /** What the feature counts among the thread's outputs. */
  outputs?(thread: ThreadId): Output[];
  /** A queued thread starts at `at`, in the transaction that creates it. Throws when it may not start. */
  startQueued?(thread: ThreadId, at: number): void;
}

export type ThreadStore = ReturnType<typeof threadStore>;

export function threadStore(db: Db, clock: () => number, nodes: Pick<NodeStore, "node" | "saveObservation" | "saveNodeState">, participants: readonly ThreadParticipant[], readingUsage: () => unknown) {
  const { transaction, sql } = db;
  const { node } = nodes;
  const reconcile = (thread: ThreadId) => { for (const p of participants) p.reconcile?.(thread); };

  /**
   * Room a start placed a pylon in before its row exists, so an overlapping start sees it taken. It is held in memory,
   * because a start that a crash ended took no room.
   */
  const reservations = new Map<PylonId, { node: NodeName; resources: BootInputs["resources"] }>();


  const pylonParams = (p: Omit<PylonRecord, "desired">) => ({
    $id: p.pylonId, $thread: p.thread, $node: p.node,
    $boot: JSON.stringify(p.boot), $firstBoot: JSON.stringify(p.firstBoot), $live: JSON.stringify(p.live), $liveHash: p.liveHash,
    $pauses: p.pauses, $submitted: p.submitted === null ? null : JSON.stringify(p.submitted), $attempts: JSON.stringify(p.attempts), $failed: p.failed,
    $retrying: p.retrying ? 1 : 0,
  });

  const threadRecord = (id: ThreadId) => sql("SELECT * FROM threads WHERE id = ?").get(id);
  const humanActivity = (at: number, id: ThreadId) => sql("UPDATE threads SET last_human_activity_at = max(last_human_activity_at, ?) WHERE id = ?").run(at, id);
  const agentActivity = (at: number, id: ThreadId) => sql("UPDATE threads SET last_agent_activity_at = max(last_agent_activity_at, ?) WHERE id = ?").run(at, id);
  const recordReply = (at: number, id: ThreadId) => sql("UPDATE threads SET last_reply_at = max(coalesce(last_reply_at, 0) + 1, coalesce(seen_at, 0) + 1, ?) WHERE id = ?").run(at, id);

  function pylon(id: PylonId): StoredPylon | undefined {
    const row = sql("SELECT * FROM pylons WHERE id = ?").get(id);
    return row && pylonRow(row);
  }

  const pylonsOn = (node: NodeName) => sql("SELECT * FROM pylons WHERE node = ? ORDER BY id").all(node).map(pylonRow);

  const sessions = (pylon: PylonId) => sql("SELECT * FROM sessions WHERE pylon = ? ORDER BY id").all(pylon).map(sessionRow);

  /** The highest journal sequence applied from the node, or null before its first. */
  function eventReceipt(node: NodeName): number | null {
    const receipt = sql("SELECT sequence FROM event_receipts WHERE node = ?").get(node);
    return receipt === undefined ? null : Number(receipt.sequence);
  }

  /** `observation` is the pylon's node's latest, which a caller that holds it passes so it is not read again. */
  function previews(pylon: PylonId, observation?: NodeObservation | null): Preview[] {
    const rows = sql("SELECT previews.*, nodes.tailnet_host FROM previews JOIN nodes ON nodes.name = previews.node WHERE pylon = ? ORDER BY service").all(pylon);
    if (rows.length === 0) return [];
    // A pylon's previews are all on its node.
    const observed = (observation === undefined ? node(rows[0]!.node as NodeName)!.observation : observation)?.pylons.find((p) => p.pylonId === pylon);
    // Only a running pylon's services are known. A paused one's preview shows the waking page, which answers.
    const facts = new Map(observed?.phase === "running" ? (observed.services ?? []).map((s) => [s.name, s]) : []);
    return rows.map((r): Preview => {
      const service = r.service as string;
      const fact = facts.get(service);
      const why = fact?.unrouted ?? (fact?.state === "failed" ? `the service ${service} failed. \`nexus service logs ${service}\` in the pylon shows why` : null);
      return {
        pylon: r.pylon as PylonId, service, httpsPort: r.https_port as number,
        ready: r.ready === 1 && (fact === undefined || (fact.state === "ready" && fact.unrouted === undefined)), failed: why,
        url: `https://${r.tailnet_host as string}:${r.https_port as number}/`,
      };
    });
  }

  function saveStartKey(key: StartKey, thread: ThreadId) {
    sql("INSERT INTO start_requests (request_id, thread, body) VALUES (?, ?, ?)").run(key.requestId, thread, key.body);
  }

  function threadOfPylon(pylonId: PylonId): ThreadId | undefined {
    return (sql("SELECT thread FROM pylons WHERE id = ?").get(pylonId) as Row | undefined)?.thread as ThreadId | undefined;
  }

  /** The threads of `rows` with what their sessions and the usage backfill say, read in a few queries however many rows there are. */
  function withSessions(rows: readonly Row[]): Thread[] {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((r) => r.id));
    const live = new Map(sql(`SELECT thread, max(updated_at) AS at, min(started_at) AS since FROM session_activity
      WHERE thread IN (SELECT value FROM json_each(?)) AND state = 'session.turn-started' AND updated_at > ? GROUP BY thread`)
      .all(ids, clock() - sessionActivityTtlMs).map((r) => [r.thread as ThreadId, r]));
    const waiting = new Map(sql(`SELECT thread, message FROM (SELECT thread, message, row_number() OVER (PARTITION BY thread ORDER BY updated_at DESC, rowid DESC) AS n
      FROM session_activity WHERE thread IN (SELECT value FROM json_each(?)) AND state = 'session.waiting') WHERE n = 1`).all(ids).map((r) => [r.thread as ThreadId, r]));
    const reading = readingUsage();
    const archived = new Map(sql("SELECT thread, archived_at FROM thread_archives WHERE thread IN (SELECT value FROM json_each(?))").all(ids)
      .map((r) => [r.thread as ThreadId, r.archived_at as number]));
    const limits = usageLimits(rows.map((r) => r.id as ThreadId).filter((id) => !live.has(id)));
    return rows.map((row): Thread => {
      const thread = threadRow(row);
      const working = (live.get(thread.id)?.at ?? null) as number | null;
      const wait = waiting.get(thread.id);
      const starts = [thread.agentTurnRunning ? row.agent_turn_started_at : null, live.get(thread.id)?.since].filter((at): at is number => typeof at === "number");
      const usageLimit = limits.get(thread.id);
      const archivedAt = archived.get(thread.id);
      return {
        ...thread, working: thread.agentTurnRunning || working !== null,
        ...(working === null ? {} : { sessionTurnRunning: true, sessionActiveUntil: working + sessionActivityTtlMs }), ...(wait === undefined ? {} : { sessionWaiting: true }),
        ...(typeof wait?.message === "string" ? { sessionWaitingMessage: wait.message } : {}),
        ...(starts.length === 0 ? {} : { workingSince: Math.min(...starts) }), ...(usageLimit === undefined ? {} : { usageLimit }),
        ...(reading === thread.id ? { readingUsage: true } : {}), ...(archivedAt === undefined ? {} : { archivedAt }),
      };
    });
  }

  function thread(id: ThreadId): Thread | undefined {
    const row = threadRecord(id);
    return row && withSessions([row])[0];
  }

  /**
   * The usage limit each of the Claude worker threads among `ids` stopped on. Derived from the newest entries rather
   * than stored, so it holds whichever of the turn's end and the transcript's read comes first.
   */
  function usageLimits(ids: readonly ThreadId[]): Map<ThreadId, NonNullable<Thread["usageLimit"]>> {
    const limits = new Map<ThreadId, NonNullable<Thread["usageLimit"]>>();
    if (ids.length === 0) return limits;
    const turns = new Map(sql(`SELECT w.thread, w.turn_at FROM claude_workers w JOIN claude_transcripts t ON t.thread = w.thread AND t.session = w.session
      WHERE w.thread IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)).map((r) => [r.thread as ThreadId, r.turn_at as number | null]));
    if (turns.size === 0) return limits;
    const entries = new Map<ThreadId, ClaudeEntry[]>();
    // Each thread's newest 16 through the index, as a window over the threads' entries would rank every one it keeps.
    for (const r of sql(`SELECT j.value AS thread, e.entry FROM json_each(?) j JOIN claude_entries e ON e.thread = j.value
      AND e.seq > coalesce((SELECT seq FROM claude_entries WHERE thread = j.value ORDER BY seq DESC LIMIT 1 OFFSET 16), -1) ORDER BY j.value, e.seq`).all(JSON.stringify([...turns.keys()]))) {
      const of = r.thread as ThreadId;
      entries.set(of, [...entries.get(of) ?? [], json<ClaudeEntry>(r.entry)]);
    }
    for (const [id, turnAt] of turns) {
      const stop = usageLimitStop(entries.get(id) ?? []);
      // A turn that started after the stop, by the pylon's clock as the record's time is, ended it, though its prompt may not be read yet.
      if (stop !== null && (turnAt === null || turnAt <= stop.stoppedAt)) limits.set(id, stop);
    }
    return limits;
  }

  const threadStatus = (id: ThreadId) => sql("SELECT status FROM threads WHERE id = ?").get(id)?.status as ThreadStatus | undefined;
  function updateAttention(id: ThreadId) {
    const t = thread(id);
    if (t === undefined) return;
    const old = sql("SELECT * FROM thread_attention WHERE thread = ?").get(id);
    const p = pylon(t.pylonId);
    const workerFailed = ["failed", "stalled"].includes(String(sql("SELECT state FROM claude_workers WHERE thread = ?").get(id)?.state));
    const decision = participants.some((p) => p.needsPerson?.(id));
    const attention = attentionOf(p?.failed != null || workerFailed, old?.parked === 1, t.lastReplyAt, t.seenAt, t.working, t.sessionWaiting, decision, t.usageLimit !== undefined);
    if ((old?.attention ?? null) === attention) return;
    sql("INSERT INTO thread_attention (thread, attention) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET attention = excluded.attention").run(id, attention);
    appendEvent("attention.changed", id, { attention });
  }

  function setThreadStatus(id: ThreadId, status: ThreadStatus) {
    transaction(() => {
      sql("UPDATE threads SET status = ? WHERE id = ?").run(status, id);
      if (status === "archived") sql("INSERT INTO thread_archives (thread, archived_at) VALUES (?, ?) ON CONFLICT(thread) DO NOTHING").run(id, clock());
      else sql("DELETE FROM thread_archives WHERE thread = ?").run(id);
      if (status === "archived" || status === "deleted") {
        // The thread's pylon pauses, so no turn of it runs and no dialog waits.
        sql("DELETE FROM session_activity WHERE thread = ?").run(id);
        for (const p of participants) p.closed?.(id);
      }
      if (status === "deleted") {
        // The delete aborts the run, so nothing is left to retry, and the harness stops tracking the thread without a report.
        sql("UPDATE thread_attention SET parked = 0 WHERE thread = ?").run(id);
        for (const table of ["session_order", "session_order_floor", "claude_transcripts", "claude_entries", "claude_messages", "claude_senders", "disk_cleanups"]) sql(`DELETE FROM ${table} WHERE thread = ?`).run(id);
      }
      reconcile(id);
      updateAttention(id);
    });
  }

  function pruneSessions() {
    transaction(() => {
      const expired = sql("DELETE FROM session_activity WHERE state = 'session.turn-started' AND updated_at <= ? RETURNING thread").all(clock() - sessionActivityTtlMs);
      for (const thread of new Set(expired.map((r) => r.thread as ThreadId))) updateAttention(thread);
    });
  }

  function appendEvent(kind: EventKind, thread: ThreadId | null, payload: Record<string, unknown>, time = clock()): NexusEvent {
    return transaction(() => {
      pruneSessions();
      const project = thread === null ? null : (threadRecord(thread)?.project as string | undefined) ?? null;
      const result = sql("INSERT INTO events (time, thread, project, kind, payload) VALUES (?, ?, ?, ?, ?)").run(time, thread, project, kind, JSON.stringify(payload));
      const id = Number(result.lastInsertRowid);
      sql("DELETE FROM events WHERE id <= ?").run(id - 10_000);
      return { id: String(id), time, thread, project, kind, payload };
    });
  }

  function eventBatch(since = "0", filter: EventFilter = {}): { events: NexusEvent[]; watermark: string } {
    const cursor = eventCursor(since);
    const oldest = sql("SELECT min(id) AS id FROM events").get()?.id as number | null;
    const newest = sql("SELECT max(id) AS id FROM events").get()?.id as number | null;
    if (cursor !== 0 && oldest !== null && cursor < oldest - 1) throw new HttpError(409, "event cursor expired; retained events cannot fill the gap");
    const clauses = ["id > ?"];
    const params: (string | number)[] = [cursor];
    for (const column of ["thread", "project"] as const) {
      if (filter[column] === undefined) continue;
      clauses.push(`${column} = ?`);
      params.push(filter[column]);
    }
    if (filter.kinds?.length) {
      clauses.push(`kind IN (${filter.kinds.map(() => "?").join(",")})`);
      params.push(...filter.kinds);
    }
    const events = sql(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY id`).all(...params).map((r): NexusEvent => ({
      id: String(r.id), time: r.time as number, thread: r.thread as string | null, project: r.project as string | null,
      kind: r.kind as EventKind, payload: json<Record<string, unknown>>(r.payload),
    }));
    return { events, watermark: String(Math.max(cursor, newest ?? 0)) };
  }

  function claudeWorker(thread: ThreadId): ClaudeWorker | undefined {
    const row = sql("SELECT prompt, state, message, model, session FROM claude_workers WHERE thread = ?").get(thread);
    return row === undefined ? undefined : {
      model: row.model as string | null, prompt: row.prompt as string, state: row.state as string, session: row.session as string | null,
      ...(row.message == null ? {} : { message: row.message as string }),
    };
  }

  function claudeTranscript(thread: ThreadId): ClaudeTranscript | undefined {
    const row = sql("SELECT * FROM claude_transcripts WHERE thread = ?").get(thread);
    return row === undefined ? undefined : {
      session: row.session as string, cursor: { offset: row.byte_offset as number, skipping: row.skipping === 1, before: row.before_hash as string }, dropped: row.dropped as number, readAt: row.read_at as number,
    };
  }

  return {
    updateAttention,
    threadRecord,
    saveStartKey,
    /** The registry runs it once the participants are registered, since the recompute asks them. */
    start() {
      pruneSessions();
      // A release that computes attention differently, or a thread from before attention was stored, is right from the start.
      // A thread deleted before deletes cleared the parked flag kept it, and the harness no longer tracks it to report.
      transaction(() => {
        sql("UPDATE thread_attention SET parked = 0 WHERE thread IN (SELECT id FROM threads WHERE status = 'deleted')").run();
        for (const { id } of sql("SELECT id FROM threads").all()) updateAttention(id as ThreadId);
      });
    },
    appendEvent,
    pruneSessions,
    attention: (id: ThreadId): Attention => (sql("SELECT attention FROM thread_attention WHERE thread = ?").get(id)?.attention ?? null) as Attention,
    recordParked(id: ThreadId, parked: boolean) {
      // The harness reports each flip, but a process's first report for a thread may repeat what an earlier process stored.
      if (sql("SELECT parked FROM thread_attention WHERE thread = ?").get(id)?.parked === (parked ? 1 : 0)) return;
      transaction(() => {
        sql("INSERT INTO thread_attention (thread, parked) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET parked = excluded.parked").run(id, parked ? 1 : 0);
        if (parked) appendEvent("thread.parked", id, {});
        updateAttention(id);
      });
    },
    claudeWorker,
    agent(t: Pick<Thread, "id" | "conversationId">): ThreadAgent {
      const worker = claudeWorker(t.id);
      return worker !== undefined ? { kind: "claude", worker } : t.conversationId !== null ? { kind: "harness", conversationId: t.conversationId } : { kind: "none" };
    },
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
        const stop = usageLimits([thread]).get(thread);
        if (stop !== undefined) {
          sql("DELETE FROM session_activity WHERE thread = ? AND session = ? AND state = 'session.turn-started' AND EXISTS (SELECT 1 FROM session_order o WHERE o.thread = ? AND o.session = ? AND o.at <= ?)")
            .run(thread, read.session, thread, read.session, stop.stoppedAt);
        }
        reconcile(thread);
        updateAttention(thread);
        return true;
      });
    },
    /** Records, before the archived-disk cleanup sends its delete, that the pylon's disk is going. */
    requestCleanup(pylonId: PylonId, thread: ThreadId) {
      sql("INSERT OR IGNORE INTO disk_cleanups (pylon, thread, requested_at) VALUES (?, ?, ?)").run(pylonId, thread, clock());
    },
    cleanupRequested: (pylonId: PylonId): boolean => sql("SELECT 1 FROM disk_cleanups WHERE pylon = ?").get(pylonId) !== undefined,
    /**
     * Once the node no longer has the pylon, the disk took the Claude transcript and whatever failed on it. The thread's
     * transcript is read from the start again, keeping the stored entries, so the session's new file appends after them
     * rather than reading as a replaced one, and the pylon's failure and failed attempts are cleared, so an unarchive boots
     * it fresh.
     */
    finishCleanup(pylonId: PylonId) {
      transaction(() => {
        const thread = sql("DELETE FROM disk_cleanups WHERE pylon = ? RETURNING thread").get(pylonId)?.thread as ThreadId | undefined;
        if (thread === undefined) return;
        sql("UPDATE claude_transcripts SET byte_offset = ?, skipping = ?, before_hash = ? WHERE thread = ?")
          .run(transcriptStart.offset, transcriptStart.skipping ? 1 : 0, transcriptStart.before, thread);
        sql(`UPDATE pylons SET failed = NULL, attempts = '{"count":0,"last":null}', retrying = 0 WHERE id = ?`).run(pylonId);
        updateAttention(thread);
      });
    },
    /** An unarchive came before the delete ran, and the old disk booted, so nothing of it is forgotten. */
    dropCleanup(pylonId: PylonId) { sql("DELETE FROM disk_cleanups WHERE pylon = ?").run(pylonId); },
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
    setClaudeWorker(thread: ThreadId, prompt: string, state: string, message?: string, session?: string) {
      transaction(() => {
        sql("INSERT INTO claude_workers (thread, prompt, state, message, session, model) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread) DO UPDATE SET state = excluded.state, message = excluded.message, session = coalesce(excluded.session, claude_workers.session)").run(thread, prompt, state, message ?? null, session ?? null, defaultClaudeModel);
        reconcile(thread);
        updateAttention(thread);
      });
    },
    eventReceipt,
    reportSession(node: NodeName, report: ReportedEvent) {
      const event = pylonEventSchema.parse(report.event);
      const stored = pylon(report.pylon);
      if (stored === undefined || stored.node !== node) return;
      const thread = stored.thread;
      transaction(() => {
        const receipt = eventReceipt(node);
        if (receipt !== null && receipt >= report.sequence) return;
        sql("INSERT INTO event_receipts VALUES (?, ?) ON CONFLICT(node) DO UPDATE SET sequence = excluded.sequence").run(node, report.sequence);
        pruneSessions();
        const session = event.session ?? "default";
        const status = threadStatus(thread);
        if (status === "archived" || status === "deleted") return;
        const at = event.at ?? report.time;
        const previous = sql("SELECT at, kind, event_ids FROM session_order WHERE thread = ? AND session = ?").get(thread, session);
        const previousIds = previous?.event_ids == null ? [] : json<string[]>(previous.event_ids);
        const floor = sql("SELECT at FROM session_order_floor WHERE thread = ?").get(thread)?.at as number | undefined;
        if (previous !== undefined) {
          if (at < Number(previous.at)) return;
          // The pylon's outbox sends an event again when its acknowledgement was lost, under the ID it was applied with.
          if (event.id !== undefined && at === previous.at && previousIds.includes(event.id)) return;
          if (at === previous.at && (event.kind === "session.turn-started" || event.kind === "session.heartbeat") && previous.kind !== "session.turn-started" && previous.kind !== "session.heartbeat") return;
        } else if (floor !== undefined && at <= floor) return;
        const current = sql("SELECT state, started_at FROM session_activity WHERE thread = ? AND session = ?").get(thread, session);
        if (event.kind === "session.heartbeat" && current?.state !== "session.turn-started" && current?.state !== "session.waiting") return;
        if (event.kind === "session.turn-started" && event.session !== undefined) {
          sql("UPDATE claude_workers SET state = 'started', message = NULL WHERE thread = ? AND session = ? AND state IN ('starting', 'stalled', 'failed')").run(thread, event.session);
        }
        if (event.kind === "session.turn-started") {
          sql("UPDATE claude_workers SET turn_session = ?, turn_at = ? WHERE thread = ? AND (turn_at IS NULL OR turn_at < ?)").run(session, at, thread, at);
        }
        // Only reports at the cursor's own stamp can still be resent and pass the stamp checks, so only their IDs are kept.
        const ids = [...(previous !== undefined && at === previous.at ? previousIds : []), ...(event.id === undefined ? [] : [event.id])];
        sql("INSERT INTO session_order (thread, session, at, kind, event_ids) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread, session) DO UPDATE SET at = excluded.at, kind = excluded.kind, event_ids = excluded.event_ids")
          .run(thread, session, at, event.kind, ids.length === 0 ? null : JSON.stringify(ids));
        // Keep tombstones after activity rows end, with a floor guarding reports older than evicted cursors.
        const evicted = sql("DELETE FROM session_order WHERE thread = ? AND session NOT IN (SELECT session FROM session_order WHERE thread = ? ORDER BY at DESC, rowid DESC LIMIT ?) RETURNING at")
          .all(thread, thread, maxActiveSessions * 2);
        if (evicted.length > 0) sql("INSERT INTO session_order_floor VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET at = max(at, excluded.at)").run(thread, Math.max(...evicted.map((r) => Number(r.at))));
        if (event.kind === "session.ended" || event.kind === "session.turn-ended") {
          sql("DELETE FROM session_activity WHERE thread = ? AND session = ?").run(thread, session);
        } else {
          // A heartbeat keeps a running turn's start and starts a new turn for a waiting session.
          const startedAt = event.kind === "session.waiting" ? null
            : event.kind === "session.heartbeat" && current?.state === "session.turn-started" ? current.started_at as number | null
            : clock();
          sql(`INSERT INTO session_activity (thread, session, state, updated_at, started_at, message) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread, session) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, started_at = excluded.started_at, message = excluded.message`)
            .run(thread, session, event.kind === "session.heartbeat" ? "session.turn-started" : event.kind, clock(), startedAt, event.kind === "session.waiting" ? event.message ?? null : null);
          sql("DELETE FROM session_activity WHERE thread = ? AND session NOT IN (SELECT session FROM session_activity WHERE thread = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(thread, thread, maxActiveSessions);
        }
        if (event.kind !== "session.waiting") agentActivity(clock(), thread);
        if (event.kind === "session.turn-ended") recordReply(clock(), thread);
        appendEvent(event.kind, thread, { at, ...(event.session === undefined ? {} : { session: event.session }), ...(event.message === undefined ? {} : { message: event.message }) });
        updateAttention(thread);
      });
    },
    eventBatch,
    /** The newest event's ID, a cursor that follows only the events after it. */
    newestEvent: () => String(sql("SELECT max(id) AS id FROM events").get()?.id ?? 0),
    events: (since = "0", filter: EventFilter = {}) => eventBatch(since, filter).events,
    /**
     * The failure the thread's pylon holds: the thread.failed event its pylon's `failed` appended. Null while the pylon
     * has not failed, or once that event is pruned. A failed Claude launch appends one too, with another message.
     */
    failure(thread: ThreadId): { event: number; at: number } | null {
      const row = sql(`SELECT e.id, e.time FROM pylons p JOIN events e ON e.thread = p.thread AND e.kind = 'thread.failed' AND json_extract(e.payload, '$.message') = p.failed
        WHERE p.thread = ? ORDER BY e.id DESC LIMIT 1`).get(thread);
      return row === undefined ? null : { event: row.id as number, at: row.time as number };
    },
    /**
     * A thread and its pylon are created together, because a thread always has exactly one pylon. A `queued` thread's
     * queue record is marked started in the same transaction, so a queued thread starts at most once, and so is a
     * start's `key`, so a repeat of its request ID finds the thread.
     */
    createThread(thread: Omit<Thread, "seenAt" | "lastReplyAt">, pylon: Omit<PylonRecord, "desired">, claudePrompt?: string, model = defaultClaudeModel, queued = false, key?: StartKey) {
      if (pylon.pylonId !== thread.pylonId || pylon.thread !== thread.id) throw new Error(`pylon ${pylon.pylonId} does not belong to thread ${thread.id}`);
      transaction(() => {
        if (queued) for (const p of participants) p.startQueued?.(thread.id, thread.createdAt);
        sql(`INSERT INTO threads (id, title, project, status, conversation_id, started_by, created_at,
          agent_turn_running, last_agent_activity_at, last_human_activity_at, placement, setup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(thread.id, thread.title, thread.project, thread.status, thread.conversationId, thread.startedBy, thread.createdAt,
          thread.agentTurnRunning ? 1 : 0, thread.lastAgentActivityAt, thread.lastHumanActivityAt, thread.placement === undefined ? null : JSON.stringify(thread.placement),
          thread.setup === undefined ? null : JSON.stringify(thread.setup));
        sql(`INSERT INTO pylons (id, thread, node, boot, first_boot, live, live_hash, pauses, submitted, attempts, failed, retrying)
          VALUES ($id, $thread, $node, $boot, $firstBoot, $live, $liveHash, $pauses, $submitted, $attempts, $failed, $retrying)`).run(pylonParams(pylon));
        if (claudePrompt !== undefined) sql("INSERT INTO claude_workers (thread, prompt, state, model) VALUES (?, ?, 'pending', ?)").run(thread.id, claudePrompt, model);
        if (key !== undefined) saveStartKey(key, thread.id);
      });
    },
    startRequest(requestId: string): { thread: ThreadId; body: string } | undefined {
      const row = sql("SELECT thread, body FROM start_requests WHERE request_id = ?").get(requestId);
      return row === undefined ? undefined : { thread: row.thread as ThreadId, body: row.body as string };
    },
    threads: (project?: ProjectId) => withSessions(project === undefined ? sql("SELECT * FROM threads ORDER BY created_at, id").all() : sql("SELECT * FROM threads WHERE project = ? ORDER BY created_at, id").all(project)),
    thread,
    /** The threads with any of the statuses and started by `startedBy`, each as its row holds it, without what its sessions say. */
    storedThreads(filter: { status?: readonly ThreadStatus[]; startedBy?: string } = {}): StoredThread[] {
      return sql(`SELECT * FROM threads WHERE ($statuses IS NULL OR status IN (SELECT value FROM json_each($statuses))) AND ($startedBy IS NULL OR started_by = $startedBy)
        ORDER BY created_at, id`).all({ $statuses: filter.status === undefined ? null : JSON.stringify(filter.status), $startedBy: filter.startedBy ?? null }).map(threadRow);
    },
    threadStatus,
    /**
     * The threads whose agent is a harness conversation, as agent() decides: a conversation ID and no Claude worker. A
     * deleted one is left out once its conversation's abort is recorded.
     */
    harnessThreads: (): StoredThread[] => sql(`SELECT * FROM threads t WHERE conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM claude_workers WHERE thread = t.id)
      AND (status <> 'deleted' OR conversation_id NOT IN (SELECT conversation FROM aborted_conversations)) ORDER BY created_at, id`).all().map(threadRow),
    recordAborted(conversationId: string) { sql("INSERT OR IGNORE INTO aborted_conversations (conversation) VALUES (?)").run(conversationId); },
    markSeen(id: ThreadId, unread: boolean, now = Date.now(), lastReplyAt?: number | null) {
      if (!unread && lastReplyAt === null) return;
      transaction(() => {
        sql("UPDATE threads SET seen_at = CASE WHEN ? THEN last_reply_at - 1 ELSE max(coalesce(seen_at, 0), min(max(?, coalesce(last_reply_at, 0)), ?)) END WHERE id = ?").run(unread ? 1 : 0, now, lastReplyAt ?? Number.MAX_SAFE_INTEGER, id);
        updateAttention(id);
      });
    },
    // The timestamp also identifies a reply, including two events in one millisecond or a clock correction.
    recordReply(id: ThreadId, at: number) {
      transaction(() => { recordReply(at, id); appendEvent("thread.turn-ended", id, {} , at); updateAttention(id); });
    },
    setThreadStatus,
    /** Timestamps only move forward, so a late or repeated report cannot make a thread look idle sooner. */
    recordActivity(id: ThreadId, activity: { human?: number; agent?: number; agentTurnRunning?: boolean }) {
      transaction(() => {
        if (activity.human !== undefined) humanActivity(activity.human, id);
        if (activity.agent !== undefined) agentActivity(activity.agent, id);
        // The harness reports its last activity as the moment the turn flipped. A turn that keeps running keeps its
        // start, and a turn that ends forgets it.
        if (activity.agentTurnRunning !== undefined) {
          sql(`UPDATE threads SET agent_turn_running = $running,
            agent_turn_started_at = CASE WHEN $running = 0 THEN NULL WHEN agent_turn_running = 1 THEN agent_turn_started_at ELSE $start END WHERE id = $id`)
            .run({ $running: activity.agentTurnRunning ? 1 : 0, $start: activity.agent ?? clock(), $id: id });
        }
        updateAttention(id);
      });
    },

    pylon,
    pylonsOn,
    /** The node's pylons, each with its thread's status, in one read. */
    pylonsWithStatusOn: (node: NodeName): { pylon: StoredPylon; status: ThreadStatus }[] =>
      sql("SELECT p.*, t.status AS thread_status FROM pylons p JOIN threads t ON t.id = p.thread WHERE p.node = ? ORDER BY p.id").all(node)
        .map((r) => ({ pylon: pylonRow(r), status: r.thread_status as ThreadStatus })),
    /** The node's pylons, each with its thread as thread() reads it, in a few reads however many there are. */
    pylonsWithThreadsOn(node: NodeName): { pylon: StoredPylon; thread: Thread }[] {
      const threads = new Map(withSessions(sql("SELECT t.* FROM threads t JOIN pylons p ON p.thread = t.id WHERE p.node = ?").all(node)).map((t) => [t.id, t]));
      return pylonsOn(node).map((pylon) => ({ pylon, thread: threads.get(pylon.thread)! }));
    },
    /**
     * The node's pylons less those of deleted threads with nothing left to tear down: the node neither has nor routes
     * them, as `present` says, and no job, preview, retry or Claude launch is left to settle, so a tick would change nothing.
     */
    pylonIdsToTick: (node: NodeName, present: readonly PylonId[]) =>
      (sql(`SELECT p.id FROM pylons p JOIN threads t ON t.id = p.thread WHERE p.node = $node AND (t.status != 'deleted'
        OR p.submitted IS NOT NULL OR p.retrying = 1 OR p.id IN (SELECT value FROM json_each($present))
        OR EXISTS (SELECT 1 FROM previews WHERE pylon = p.id) OR EXISTS (SELECT 1 FROM claude_workers WHERE thread = t.id AND state = 'starting'))
        ORDER BY p.id`).all({ $node: node, $present: JSON.stringify(present) }) as Row[]).map((r) => r.id as PylonId),
    /** Returns what releases it, once the pylon's row counts it or the start failed. */
    reserve(pylonId: PylonId, node: NodeName, resources: BootInputs["resources"]): () => void {
      reservations.set(pylonId, { node, resources });
      return () => { reservations.delete(pylonId); };
    },
    reserved: (node: NodeName) => [...reservations.values()].filter((r) => r.node === node).map((r) => r.resources),
    /** Takes a whole PylonRecord, so the tick can save what it holds. The desired phase is dropped. */
    savePylon(saved: Omit<PylonRecord, "desired">) {
      transaction(() => {
        const previous = pylon(saved.pylonId);
        if (previous === undefined) throw new Error(`no pylon ${saved.pylonId} to save`);
        sql(`UPDATE pylons SET thread = $thread, node = $node, boot = $boot, first_boot = $firstBoot, live = $live,
          live_hash = $liveHash, pauses = $pauses, submitted = $submitted, attempts = $attempts, failed = $failed, retrying = $retrying WHERE id = $id`).run(pylonParams(saved));
        if (saved.failed !== null && previous.failed !== saved.failed) appendEvent("thread.failed", previous.thread, { message: saved.failed });
        updateAttention(previous.thread);
      });
    },
    /** Forgets the pylon's failed jobs, and only those, as the usage backfill does for a wake it gave up on. */
    clearPylonAttempts(pylonId: PylonId) { sql(`UPDATE pylons SET attempts = '{"count":0,"last":null}' WHERE id = ?`).run(pylonId); },
    /**
     * Moves a failed pylon to another node and clears its failure as retryPylon does, with its thread's new placement and
     * setup, in one transaction. False when the pylon is not failed on `from`.
     */
    movePylon(pylonId: PylonId, from: NodeName, to: Pick<StoredPylon, "node" | "firstBoot" | "live" | "liveHash"> & { placement: Placement; setup: ThreadSetup }): boolean {
      return transaction(() => {
        const thread = threadOfPylon(pylonId);
        if (thread === undefined) return false;
        const moved = sql(`UPDATE pylons SET node = ?, first_boot = ?, live = ?, live_hash = ?, attempts = '{"count":0,"last":null}', failed = NULL, retrying = 0
          WHERE id = ? AND node = ? AND failed IS NOT NULL`).run(to.node, JSON.stringify(to.firstBoot), JSON.stringify(to.live), to.liveHash, pylonId, from).changes === 1;
        if (!moved) return false;
        sql("UPDATE threads SET placement = ?, setup = ? WHERE id = ?").run(JSON.stringify(to.placement), JSON.stringify(to.setup), thread);
        updateAttention(thread);
        return true;
      });
    },
    /** Clears a failed pylon's verdict and attempts, and marks a human retry. False when the pylon has not failed. */
    retryPylon: (pylonId: PylonId): boolean => transaction(() => {
      const changed = sql(`UPDATE pylons SET failed = NULL, attempts = '{"count":0,"last":null}', retrying = 1 WHERE id = ? AND failed IS NOT NULL`).run(pylonId).changes === 1;
      const thread = threadOfPylon(pylonId);
      if (thread !== undefined) updateAttention(thread);
      return changed;
    }),

    sessions,
    session(pylon: PylonId, id: string): Session | undefined {
      const row = sql("SELECT * FROM sessions WHERE pylon = ? AND id = ?").get(pylon, id) as Row | undefined;
      return row && sessionRow(row);
    },
    /**
     * Gives each of `services` that has no preview yet the lowest port in `range` that no pylon on the pylon's node
     * holds and that the node's last observation does not route. A port the node routes without a row here is left
     * from records that were lost, so handing it out would publish two previews on one URL. A service keeps its port
     * until releasePreviews, so its URL survives pauses and restarts, and asking again changes nothing. Throws when
     * the range is used up, after allocating the services before it. `observation` is as for previews.
     */
    allocatePreviews(pylonId: PylonId, services: readonly string[], range: PortRange, observation?: NodeObservation | null) {
      const on = pylon(pylonId)?.node;
      if (on === undefined) throw new Error(`no pylon ${pylonId} to allocate previews for`);
      const last = observation === undefined ? node(on)!.observation : observation;
      const routed = (last?.previewRoutes ?? []).map((r) => r.httpsPort);
      const held = new Set(previews(pylonId, last).map((p) => p.service));
      for (const service of services) {
        if (held.has(service)) continue;
        const taken = new Set([...routed, ...(sql("SELECT https_port FROM previews WHERE node = ?").all(on) as Row[]).map((r) => r.https_port as number)]);
        let port = range.first;
        while (port <= range.last && taken.has(port)) port++;
        if (port > range.last) throw new HttpError(503, `no https port is free for the preview of ${service}: pylons on ${on} hold or ${on} serves every port from ${range.first} to ${range.last}`);
        sql("INSERT INTO previews (pylon, node, service, https_port, ready) SELECT id, node, ?, ?, 0 FROM pylons WHERE id = ?").run(service, port, pylonId);
        held.add(service);
      }
    },
    /** Frees a deleted pylon's ports for other pylons on its node. */
    releasePreviews(pylonId: PylonId) { sql("DELETE FROM previews WHERE pylon = ?").run(pylonId); },
    /** Drops one service's preview, such as an unlinked port's, and frees its port. A service with none is left as it is. */
    releasePreview(pylonId: PylonId, service: string) { sql("DELETE FROM previews WHERE pylon = ? AND service = ?").run(pylonId, service); },
    previews,
    outputs(thread: ThreadId): Output[] {
      return [
        ...(sql("SELECT * FROM outputs WHERE thread = ? ORDER BY kind, ref").all(thread) as Row[]).map((r): Output => ({ thread, kind: r.kind as Output["kind"], ref: r.ref as string })),
        ...participants.flatMap((p) => p.outputs?.(thread) ?? []),
      ];
    },

    /** The latest job the node reported for a pylon or an artifact. */
    job(subject: Subject): JobStatus | undefined {
      const row = sql("SELECT status FROM jobs WHERE subject = ?").get(subject) as Row | undefined;
      return row && json<JobStatus>(row.status);
    },

    /**
     * Stores the node's new observation together with the writes ingest derived from it. One transaction,
     * because ingest diffs the next event against this observation: a crash between the two would lose the writes.
     * The observation is null when the event left it as it was.
     */
    ingested(observation: NodeObservation | null, writes: readonly RegistryWrite[]) {
      if (observation === null && writes.length === 0) return;
      transaction(() => {
        if (observation !== null) nodes.saveObservation(observation);
        for (const write of writes) apply(write);
      });
    },
    apply,
  };

  /** Folds one of ingest's writes into the records. Each is an upsert, so applying it twice changes nothing. */
  function apply(write: RegistryWrite) {
    switch (write.record) {
      case "node":
        nodes.saveNodeState(write.node, write.state, write.capacity);
        return;
      case "sessions": {
        const listed = new Set(write.sessions.map((s) => s.id));
        for (const { id } of sessions(write.pylonId)) if (!listed.has(id)) sql("DELETE FROM sessions WHERE pylon = ? AND id = ?").run(write.pylonId, id);
        for (const s of write.sessions) {
          // A null status keeps the one the row has.
          sql(`INSERT INTO sessions (pylon, id, herdr_pane, harness, harness_session_id, status, title, state, message)
            VALUES ($pylon, $id, $herdrPane, $harness, $harnessSessionId, coalesce($status, 'unknown'), $title, $state, $message)
            ON CONFLICT (pylon, id) DO UPDATE SET herdr_pane = excluded.herdr_pane, harness = excluded.harness, harness_session_id = excluded.harness_session_id,
            status = coalesce($status, sessions.status), title = excluded.title, state = excluded.state, message = excluded.message`).run({
            $pylon: write.pylonId, $id: s.id, $herdrPane: s.herdrPane, $harness: s.harness, $harnessSessionId: s.harnessSessionId,
            $status: s.status, $title: s.title, $state: s.state, $message: s.message,
          });
        }
        return;
      }
      case "sessions-paused":
        sql("UPDATE sessions SET state = 'paused', message = NULL WHERE pylon = ?").run(write.pylonId);
        return;
      case "sessions-resumed":
        sql(`UPDATE sessions SET status = 'unknown', state = CASE WHEN herdr_pane IS NULL THEN 'failed' ELSE 'running' END,
          message = CASE WHEN herdr_pane IS NULL THEN 'its last wake did not bring it back, and whether this one did is not read yet' END
          WHERE pylon = ? AND state = 'paused'`).run(write.pylonId);
        return;
      case "output": {
        const thread = threadOfPylon(write.pylonId);
        if (thread !== undefined) sql("INSERT INTO outputs (thread, kind, ref) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(thread, write.kind, write.ref);
        return;
      }
      case "activity": {
        const thread = threadOfPylon(write.pylonId);
        if (thread === undefined) return;
        if (write.human !== null) humanActivity(write.human, thread);
        if (write.agent !== null) agentActivity(write.agent, thread);
        return;
      }
      case "preview":
        // A port the control plane no longer assigns, such as a released one, has no row to mark.
        sql("UPDATE previews SET ready = ? WHERE pylon = ? AND service = ? AND https_port = ?").run(write.ready ? 1 : 0, write.pylonId, write.service, write.httpsPort);
        return;
      case "job":
        // For the dashboard. The tick settles its own job against the observation, which may lag this. A snapshot read
        // before a job finished can arrive after its result. It must not make the job look running again.
        sql(`INSERT INTO jobs (subject, job_id, state, status) VALUES (?, ?, ?, ?)
          ON CONFLICT (subject) DO UPDATE SET job_id = excluded.job_id, state = excluded.state, status = excluded.status
          WHERE NOT (jobs.job_id = excluded.job_id AND jobs.state <> 'running')`).run(write.status.subject, write.status.jobId, write.status.state, JSON.stringify(write.status));
        return;
    }
  }
}
