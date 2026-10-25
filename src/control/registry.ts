import { attentionOf } from "./attention.ts";
import { pylonEventSchema } from "../events.ts";
import type { ReportedEvent } from "../events.ts";
import { eventCursor, sessionActivityTtlMs, maxActiveSessions, type EventFilter, type EventKind, type NexusEvent } from "../events.ts";
import type { DesiredRelease } from "../deploy/plan.ts";
import type { Drain, ReleaseReport } from "../deploy/model.ts";
/**
 * The registry: every Nexus record, in one SQLite file. The control plane process is its only writer, and
 * it holds one connection, so every write is a synchronous statement and no two writes interleave.
 *
 * Nested values (a project's hosts, a pylon's boot inputs, an observation) are stored as JSON columns. Only
 * the control plane reads them, always whole, so they need no columns of their own.
 */
import type { PrWatchState } from "./pr-watch.ts";
import { DatabaseSync } from "node:sqlite";
import type { ActivityFacts, RegistryWrite, ThreadStatus } from "../reconcile.ts";
import type { HerdrStatus, JobStatus, NodeName, NodeObservation, PylonId, Subject, TailnetNodeId } from "../protocol.ts";
import type { Project, ProjectId, SessionHarness } from "../project.ts";
import type { ImageId, ImageManifest, TemplateRecord } from "../images.ts";
import type { PylonRecord } from "../tick.ts";

declare const brand: unique symbol;
/** At most 34 characters, so `pylon-<id>` fits pi-sandbox's 40. */
export type ThreadId = string & { readonly [brand]: "ThreadId" };

export interface NodeRecord {
  name: NodeName;
  tailnetHost: string;
  tailnetNodeId: TailnetNodeId;
  state: "online" | "offline";
  capacity: NodeObservation["capacity"] | null;
  /** The probe's latest observation. While the node is offline the dashboard shows it, marked stale. */
  observation: NodeObservation | null;
}

export interface Thread extends ActivityFacts {
  sessionWaiting?: boolean;
  id: ThreadId;
  title: string;
  project: ProjectId;
  pylonId: PylonId;
  conversationId: string | null; // set once pi-durable runs the thread's agent
  startedBy: string;
  createdAt: number;
  seenAt: number | null;
  lastReplyAt: number | null;
}

/** What the registry keeps of a pylon. The desired phase is derived from its thread on every tick. */
export type StoredPylon = Omit<PylonRecord, "desired">;

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
export interface Orphan { node: NodeName; pylonId: PylonId }

/** Applied in order. The database's user_version counts the ones already applied. Never edit one that has shipped. */
const migrations: readonly string[] = [
  `
  CREATE TABLE nodes (
    name TEXT PRIMARY KEY,
    tailnet_host TEXT NOT NULL,
    tailnet_node_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('online', 'offline')),
    capacity TEXT,
    observation TEXT
  ) STRICT;
  CREATE TABLE projects (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project TEXT NOT NULL REFERENCES projects (id),
    status TEXT NOT NULL CHECK (status IN ('active', 'idle', 'archived', 'deleted')),
    conversation_id TEXT,
    started_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    agent_turn_running INTEGER NOT NULL,
    last_agent_activity_at INTEGER NOT NULL,
    last_human_activity_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE pylons (
    id TEXT PRIMARY KEY,
    thread TEXT NOT NULL UNIQUE REFERENCES threads (id),
    node TEXT NOT NULL REFERENCES nodes (name),
    boot TEXT NOT NULL,
    first_boot TEXT NOT NULL,
    live TEXT NOT NULL,
    live_hash TEXT NOT NULL,
    pauses INTEGER NOT NULL,
    submitted TEXT,
    attempts TEXT NOT NULL,
    failed TEXT
  ) STRICT;
  CREATE TABLE sessions (
    pylon TEXT NOT NULL REFERENCES pylons (id),
    herdr_pane TEXT NOT NULL,
    harness TEXT NOT NULL,
    harness_session_id TEXT,
    status TEXT NOT NULL,
    PRIMARY KEY (pylon, herdr_pane)
  ) STRICT;
  CREATE TABLE previews (
    pylon TEXT NOT NULL REFERENCES pylons (id),
    service TEXT NOT NULL,
    https_port INTEGER NOT NULL,
    ready INTEGER NOT NULL,
    PRIMARY KEY (pylon, service)
  ) STRICT;
  CREATE TABLE outputs (
    thread TEXT NOT NULL REFERENCES threads (id),
    kind TEXT NOT NULL CHECK (kind IN ('branch', 'diff', 'preview', 'file')),
    ref TEXT NOT NULL,
    PRIMARY KEY (thread, kind, ref)
  ) STRICT;
  CREATE TABLE orphans (node TEXT NOT NULL, pylon_id TEXT NOT NULL, PRIMARY KEY (node, pylon_id)) STRICT;
  CREATE TABLE jobs (
    subject TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
    status TEXT NOT NULL
  ) STRICT;
  CREATE TABLE images (id TEXT PRIMARY KEY, manifest TEXT NOT NULL) STRICT;
  CREATE TABLE templates (id TEXT PRIMARY KEY, project TEXT NOT NULL, record TEXT NOT NULL) STRICT;
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `,
  // A pylon's attempts carry the last failure's message. Failures recorded before kept only their code.
  `
  UPDATE pylons SET attempts = json_object(
    'count', json_extract(attempts, '$.count'),
    'last', json(CASE WHEN json_extract(attempts, '$.lastCode') IS NULL THEN NULL ELSE json_object(
      'at', json_extract(attempts, '$.lastFailedAt'),
      'code', json_extract(attempts, '$.lastCode'),
      'message', 'recorded before the registry kept failure messages'
    ) END)
  );
  `,
  // A preview's https port is unique on its node, so each row carries the node its pylon runs on.
  `
  CREATE TABLE node_previews (
    pylon TEXT NOT NULL REFERENCES pylons (id),
    node TEXT NOT NULL REFERENCES nodes (name),
    service TEXT NOT NULL,
    https_port INTEGER NOT NULL,
    ready INTEGER NOT NULL,
    PRIMARY KEY (pylon, service),
    UNIQUE (node, https_port)
  ) STRICT;
  INSERT INTO node_previews SELECT previews.pylon, pylons.node, previews.service, previews.https_port, previews.ready
    FROM previews JOIN pylons ON pylons.id = previews.pylon;
  DROP TABLE previews;
  ALTER TABLE node_previews RENAME TO previews;
  `,
  // A human retry of a failed pylon, which lets the planner settle a broken instance once.
  `
  ALTER TABLE pylons ADD COLUMN retrying INTEGER NOT NULL DEFAULT 0;
  `,
  // A session's title, so a human can tell its sessions apart. Sessions observed before keep none until the next observation.
  `
  ALTER TABLE sessions ADD COLUMN title TEXT;
  `,
  // BootInputs.repo became RepoInit. Every stored repo was a clone, which is the old shape plus its kind, in a
  // pylon's boot and in a spawn it has submitted, which a retry sends again.
  `
  UPDATE pylons SET boot = json_set(boot, '$.repo.kind', 'clone');
  UPDATE pylons SET submitted = json_set(submitted, '$.job.boot.repo.kind', 'clone')
    WHERE submitted IS NOT NULL AND json_extract(submitted, '$.job.kind') = 'spawn';
  `,
  // A paused pylon's sessions keep their rows, and a session its last wake failed to bring back has one, which may
  // have no pane, so a session is keyed by its ID. Every session recorded before was running in its pane.
  `
  CREATE TABLE pylon_sessions (
    pylon TEXT NOT NULL REFERENCES pylons (id),
    id TEXT NOT NULL,
    herdr_pane TEXT,
    harness TEXT NOT NULL,
    harness_session_id TEXT,
    status TEXT NOT NULL,
    title TEXT,
    state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'paused', 'failed')),
    message TEXT,
    PRIMARY KEY (pylon, id),
    CHECK ((state = 'failed') = (message IS NOT NULL)),
    CHECK (state <> 'running' OR herdr_pane IS NOT NULL)
  ) STRICT;
  INSERT INTO pylon_sessions (pylon, id, herdr_pane, harness, harness_session_id, status, title)
    SELECT pylon, herdr_pane, herdr_pane, harness, harness_session_id, status, title FROM sessions;
  DROP TABLE sessions;
  ALTER TABLE pylon_sessions RENAME TO sessions;
  `,
  `ALTER TABLE threads ADD COLUMN seen_at INTEGER;
   ALTER TABLE threads ADD COLUMN last_reply_at INTEGER;`,
  `CREATE TABLE pr_watches (thread TEXT PRIMARY KEY REFERENCES threads (id), record TEXT NOT NULL) STRICT;`,
  `CREATE TABLE release_reports (node TEXT NOT NULL, role TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (node, role)) STRICT;`,
  `CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, thread TEXT, project TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL) STRICT;`,
  `CREATE TABLE session_activity (thread TEXT NOT NULL, session TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(thread, session)) STRICT;
   CREATE TABLE event_receipts (node TEXT PRIMARY KEY, sequence INTEGER NOT NULL) STRICT;
   CREATE TABLE claude_workers (thread TEXT PRIMARY KEY, prompt TEXT NOT NULL, state TEXT NOT NULL) STRICT;
   CREATE TABLE thread_attention (thread TEXT PRIMARY KEY, attention TEXT, parked INTEGER NOT NULL DEFAULT 0) STRICT;`,
  `ALTER TABLE session_activity ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX session_activity_updated ON session_activity(updated_at);`,
  `CREATE INDEX events_thread_id ON events(thread, id);
   CREATE INDEX events_project_id ON events(project, id);
   CREATE INDEX events_kind_id ON events(kind, id);`,
];

type Row = Record<string, unknown>;
const json = <T>(value: unknown): T => JSON.parse(value as string) as T;
const jsonOrNull = <T>(value: unknown): T | null => value === null ? null : json<T>(value);

function nodeRow(r: Row): NodeRecord {
  return {
    name: r.name as NodeName,
    tailnetHost: r.tailnet_host as string,
    tailnetNodeId: r.tailnet_node_id as TailnetNodeId,
    state: r.state as NodeRecord["state"],
    capacity: jsonOrNull(r.capacity),
    observation: jsonOrNull(r.observation),
  };
}

function threadRow(r: Row): Thread {
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
    thread: r.thread as string,
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

export type Registry = ReturnType<typeof openRegistry>;

/** Opens the file, creating it if needed, and applies any migrations it has not seen. */
export function openRegistry(path: string, clock = Date.now) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);

  let transactionDepth = 0;
  const transaction = <T>(body: () => T): T => {
    if (transactionDepth > 0) return body();
    transactionDepth++;
    try { return inTransaction(db, body); } finally { transactionDepth--; }
  };

  const q = {
    upsertNode: db.prepare(`INSERT INTO nodes (name, tailnet_host, tailnet_node_id, state) VALUES (?, ?, ?, 'offline')
      ON CONFLICT (name) DO UPDATE SET tailnet_host = excluded.tailnet_host, tailnet_node_id = excluded.tailnet_node_id`),
    nodes: db.prepare("SELECT * FROM nodes ORDER BY name"),
    node: db.prepare("SELECT * FROM nodes WHERE name = ?"),
    nodeState: db.prepare("UPDATE nodes SET state = ? WHERE name = ?"),
    nodeFacts: db.prepare("UPDATE nodes SET state = ?, capacity = ? WHERE name = ?"),
    observation: db.prepare("UPDATE nodes SET observation = ? WHERE name = ?"),
    insertProject: db.prepare("INSERT INTO projects (id, record) VALUES (?, ?)"),
    projects: db.prepare("SELECT record FROM projects ORDER BY id"),
    project: db.prepare("SELECT record FROM projects WHERE id = ?"),
    insertThread: db.prepare(`INSERT INTO threads (id, title, project, status, conversation_id, started_by, created_at,
      agent_turn_running, last_agent_activity_at, last_human_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    threads: db.prepare("SELECT * FROM threads ORDER BY created_at, id"),
    threadsOf: db.prepare("SELECT * FROM threads WHERE project = ? ORDER BY created_at, id"),
    thread: db.prepare("SELECT * FROM threads WHERE id = ?"),
    threadOfPylon: db.prepare("SELECT thread FROM pylons WHERE id = ?"),
    threadStatus: db.prepare("UPDATE threads SET status = ? WHERE id = ?"),
    humanActivity: db.prepare("UPDATE threads SET last_human_activity_at = max(last_human_activity_at, ?) WHERE id = ?"),
    agentActivity: db.prepare("UPDATE threads SET last_agent_activity_at = max(last_agent_activity_at, ?) WHERE id = ?"),
    agentTurn: db.prepare("UPDATE threads SET agent_turn_running = ? WHERE id = ?"),
    insertPylon: db.prepare(`INSERT INTO pylons (id, thread, node, boot, first_boot, live, live_hash, pauses, submitted, attempts, failed, retrying)
      VALUES ($id, $thread, $node, $boot, $firstBoot, $live, $liveHash, $pauses, $submitted, $attempts, $failed, $retrying)`),
    updatePylon: db.prepare(`UPDATE pylons SET thread = $thread, node = $node, boot = $boot, first_boot = $firstBoot, live = $live,
      live_hash = $liveHash, pauses = $pauses, submitted = $submitted, attempts = $attempts, failed = $failed, retrying = $retrying WHERE id = $id`),
    markSeen: db.prepare("UPDATE threads SET seen_at = CASE WHEN ? THEN last_reply_at - 1 ELSE max(coalesce(seen_at, 0), min(max(?, coalesce(last_reply_at, 0)), ?)) END WHERE id = ?"),
    recordReply: db.prepare("UPDATE threads SET last_reply_at = max(coalesce(last_reply_at, 0) + 1, coalesce(seen_at, 0) + 1, ?) WHERE id = ?"),
    retryPylon: db.prepare(`UPDATE pylons SET failed = NULL, attempts = '{"count":0,"last":null}', retrying = 1 WHERE id = ? AND failed IS NOT NULL`),
    pylon: db.prepare("SELECT * FROM pylons WHERE id = ?"),
    pylonsOn: db.prepare("SELECT * FROM pylons WHERE node = ? ORDER BY id"),
    // A null status keeps the one the row has.
    upsertSession: db.prepare(`INSERT INTO sessions (pylon, id, herdr_pane, harness, harness_session_id, status, title, state, message)
      VALUES ($pylon, $id, $herdrPane, $harness, $harnessSessionId, coalesce($status, 'unknown'), $title, $state, $message)
      ON CONFLICT (pylon, id) DO UPDATE SET herdr_pane = excluded.herdr_pane, harness = excluded.harness, harness_session_id = excluded.harness_session_id,
      status = coalesce($status, sessions.status), title = excluded.title, state = excluded.state, message = excluded.message`),
    deleteSession: db.prepare("DELETE FROM sessions WHERE pylon = ? AND id = ?"),
    pauseSessions: db.prepare("UPDATE sessions SET state = 'paused', message = NULL WHERE pylon = ?"),
    sessions: db.prepare("SELECT * FROM sessions WHERE pylon = ? ORDER BY id"),
    session: db.prepare("SELECT * FROM sessions WHERE pylon = ? AND id = ?"),
    insertPreview: db.prepare("INSERT INTO previews (pylon, node, service, https_port, ready) SELECT id, node, ?, ?, 0 FROM pylons WHERE id = ?"),
    previewReady: db.prepare("UPDATE previews SET ready = ? WHERE pylon = ? AND service = ? AND https_port = ?"),
    deletePreviews: db.prepare("DELETE FROM previews WHERE pylon = ?"),
    deletePreview: db.prepare("DELETE FROM previews WHERE pylon = ? AND service = ?"),
    portsOn: db.prepare("SELECT https_port FROM previews WHERE node = ?"),
    previews: db.prepare("SELECT previews.*, nodes.tailnet_host FROM previews JOIN nodes ON nodes.name = previews.node WHERE pylon = ? ORDER BY service"),
    insertOutput: db.prepare("INSERT INTO outputs (thread, kind, ref) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"),
    outputs: db.prepare("SELECT * FROM outputs WHERE thread = ? ORDER BY kind, ref"),
    insertOrphan: db.prepare("INSERT INTO orphans (node, pylon_id) VALUES (?, ?) ON CONFLICT DO NOTHING"),
    orphans: db.prepare("SELECT * FROM orphans ORDER BY node, pylon_id"),
    // A snapshot read before a job finished can arrive after its result. It must not make the job look running again.
    upsertJob: db.prepare(`INSERT INTO jobs (subject, job_id, state, status) VALUES (?, ?, ?, ?)
      ON CONFLICT (subject) DO UPDATE SET job_id = excluded.job_id, state = excluded.state, status = excluded.status
      WHERE NOT (jobs.job_id = excluded.job_id AND jobs.state <> 'running')`),
    job: db.prepare("SELECT status FROM jobs WHERE subject = ?"),
    upsertImage: db.prepare("INSERT INTO images (id, manifest) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET manifest = excluded.manifest"),
    image: db.prepare("SELECT manifest FROM images WHERE id = ?"),
    images: db.prepare("SELECT manifest FROM images ORDER BY id"),
    upsertTemplate: db.prepare("INSERT INTO templates (id, project, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record"),
    templates: db.prepare("SELECT record FROM templates WHERE project = ? ORDER BY id"),
    setSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
    setting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  };

  const pylonParams = (p: StoredPylon) => ({
    $id: p.pylonId, $thread: p.thread, $node: p.node,
    $boot: JSON.stringify(p.boot), $firstBoot: JSON.stringify(p.firstBoot), $live: JSON.stringify(p.live), $liveHash: p.liveHash,
    $pauses: p.pauses, $submitted: p.submitted === null ? null : JSON.stringify(p.submitted), $attempts: JSON.stringify(p.attempts), $failed: p.failed,
    $retrying: p.retrying ? 1 : 0,
  });

  function previews(pylon: PylonId): Preview[] {
    const rows = q.previews.all(pylon) as Row[];
    if (rows.length === 0) return [];
    // A pylon's previews are all on its node.
    const observed = jsonOrNull<NodeObservation>((q.node.get(rows[0]!.node as string) as Row).observation)?.pylons.find((p) => p.pylonId === pylon);
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

  function threadOfPylon(pylonId: PylonId): ThreadId | undefined {
    return (q.threadOfPylon.get(pylonId) as Row | undefined)?.thread as ThreadId | undefined;
  }

  function withSessions(row: Row): Thread {
    const thread = threadRow(row);
    const working = db.prepare("SELECT max(updated_at) AS at FROM session_activity WHERE thread = ? AND state = 'session.turn-started' AND updated_at > ?").get(thread.id, clock() - sessionActivityTtlMs)?.at as number | null;
    const waiting = db.prepare("SELECT 1 FROM session_activity WHERE thread = ? AND state = 'session.waiting' AND updated_at > ? LIMIT 1").get(thread.id, clock() - sessionActivityTtlMs);
    return { ...thread, ...(working === null ? {} : { sessionTurnRunning: true, sessionActiveUntil: working + sessionActivityTtlMs }), ...(waiting === undefined ? {} : { sessionWaiting: true }) };
  }

  function updateAttention(id: ThreadId) {
    const row = q.thread.get(id);
    if (row === undefined) return;
    const t = withSessions(row);
    const old = db.prepare("SELECT * FROM thread_attention WHERE thread = ?").get(id);
    const p = q.pylon.get(t.pylonId);
    const workerFailed = db.prepare("SELECT state FROM claude_workers WHERE thread = ?").get(id)?.state === "failed";
    const attention = attentionOf(p?.failed != null || workerFailed, old?.parked === 1, t.lastReplyAt, t.seenAt, t.agentTurnRunning || t.sessionTurnRunning === true, t.sessionWaiting);
    if ((old?.attention ?? null) === attention) return;
    db.prepare("INSERT INTO thread_attention (thread, attention) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET attention = excluded.attention").run(id, attention);
    appendEvent("attention.changed", id, { attention });
  }

  function pruneSessions() {
    transaction(() => {
      const expired = db.prepare("DELETE FROM session_activity WHERE updated_at <= ? RETURNING thread").all(clock() - sessionActivityTtlMs);
      for (const thread of new Set(expired.map((r) => r.thread as ThreadId))) updateAttention(thread);
    });
  }

  function appendEvent(kind: EventKind, thread: ThreadId | null, payload: Record<string, unknown>, time = clock()): NexusEvent {
    return transaction(() => {
      pruneSessions();
      const project = thread === null ? null : (q.thread.get(thread)?.project as string | undefined) ?? null;
      const result = db.prepare("INSERT INTO events (time, thread, project, kind, payload) VALUES (?, ?, ?, ?, ?)").run(time, thread, project, kind, JSON.stringify(payload));
      const id = Number(result.lastInsertRowid);
      db.prepare("DELETE FROM events WHERE id <= ?").run(id - 10_000);
      return { id: String(id), time, thread, project, kind, payload };
    });
  }

  function eventBatch(since = "0", filter: EventFilter = {}): { events: NexusEvent[]; watermark: string } {
    const cursor = eventCursor(since);
    const oldest = db.prepare("SELECT min(id) AS id FROM events").get()?.id as number | null;
    const newest = db.prepare("SELECT max(id) AS id FROM events").get()?.id as number | null;
    if (cursor !== 0 && oldest !== null && cursor < oldest - 1) throw new Error("event cursor expired; retained events cannot fill the gap");
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
    const events = db.prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY id`).all(...params).map((r): NexusEvent => ({
      id: String(r.id), time: r.time as number, thread: r.thread as string | null, project: r.project as string | null,
      kind: r.kind as EventKind, payload: json<Record<string, unknown>>(r.payload),
    }));
    return { events, watermark: String(Math.max(cursor, newest ?? 0)) };
  }

  pruneSessions();

  return {
    close() { db.close(); },
    appendEvent,
    pruneSessions,
    recordParked(id: ThreadId, parked: boolean) {
      transaction(() => {
        const old = db.prepare("SELECT parked FROM thread_attention WHERE thread = ?").get(id)?.parked === 1;
        db.prepare("INSERT INTO thread_attention (thread, parked) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET parked = excluded.parked").run(id, parked ? 1 : 0);
        if (parked && !old) appendEvent("thread.parked", id, {});
        updateAttention(id);
      });
    },
    claudeWorker(thread: ThreadId): { prompt: string; state: string } | undefined {
      const row = db.prepare("SELECT prompt, state FROM claude_workers WHERE thread = ?").get(thread);
      return row === undefined ? undefined : { prompt: row.prompt as string, state: row.state as string };
    },
    setClaudeWorker(thread: ThreadId, prompt: string, state: string) {
      transaction(() => {
        db.prepare("INSERT INTO claude_workers VALUES (?, ?, ?) ON CONFLICT(thread) DO UPDATE SET state = excluded.state").run(thread, prompt, state);
        updateAttention(thread);
      });
    },
    reportSession(node: NodeName, report: ReportedEvent) {
      const event = pylonEventSchema.parse(report.event);
      const pylon = q.pylon.get(report.pylon);
      if (pylon === undefined || pylon.node !== node) return;
      const thread = pylon.thread as ThreadId;
      transaction(() => {
        const receipt = db.prepare("SELECT sequence FROM event_receipts WHERE node = ?").get(node);
        if (receipt !== undefined && Number(receipt.sequence) >= report.sequence) return;
        db.prepare("INSERT INTO event_receipts VALUES (?, ?) ON CONFLICT(node) DO UPDATE SET sequence = excluded.sequence").run(node, report.sequence);
        pruneSessions();
        const session = event.session ?? "default";
        if (event.kind === "session.ended" || event.kind === "session.turn-ended") {
          db.prepare("DELETE FROM session_activity WHERE thread = ? AND session = ?").run(thread, session);
        } else {
          db.prepare("INSERT INTO session_activity VALUES (?, ?, ?, ?) ON CONFLICT(thread, session) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at")
            .run(thread, session, event.kind === "session.heartbeat" ? "session.turn-started" : event.kind, clock());
          db.prepare("DELETE FROM session_activity WHERE thread = ? AND session NOT IN (SELECT session FROM session_activity WHERE thread = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(thread, thread, maxActiveSessions);
        }
        q.agentActivity.run(clock(), thread);
        if (event.kind === "session.turn-ended") q.recordReply.run(clock(), thread);
        appendEvent(event.kind, thread, { ...(event.session === undefined ? {} : { session: event.session }), ...(event.message === undefined ? {} : { message: event.message }) });
        updateAttention(thread);
      });
    },
    eventBatch,
    events: (since = "0", filter: EventFilter = {}) => eventBatch(since, filter).events,
    prWatch(thread: ThreadId): PrWatchState | null {
      const row = db.prepare("SELECT record FROM pr_watches WHERE thread = ?").get(thread) as Row | undefined;
      return row ? json<PrWatchState>(row.record) : null;
    },
    savePrWatch(thread: ThreadId, state: PrWatchState) {
      const previous = db.prepare("SELECT record FROM pr_watches WHERE thread = ?").get(thread);
      if (state.pending !== null && (previous === undefined || json<PrWatchState>(previous.record).pending?.id !== state.pending.id)) appendEvent("pull-request.feedback", thread, { requestId: state.pending.id });
      db.prepare("INSERT INTO pr_watches (thread, record) VALUES (?, ?) ON CONFLICT (thread) DO UPDATE SET record = excluded.record").run(thread, JSON.stringify(state));
    },
    desiredRelease(): DesiredRelease | null {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'release'").get();
      return row === undefined ? null : JSON.parse(row.value as string) as DesiredRelease;
    },
    setDesiredRelease(release: DesiredRelease) {
      appendEvent("release.changed", null, { desired: release });
      db.prepare("INSERT INTO settings VALUES ('release', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(release));
    },
    releaseReports(): ReleaseReport[] {
      return db.prepare("SELECT record FROM release_reports ORDER BY node, role").all().map((r) => JSON.parse(r.record as string) as ReleaseReport);
    },
    reportRelease(report: ReleaseReport) {
      const previous = db.prepare("SELECT record FROM release_reports WHERE node = ? AND role = ?").get(report.node, report.role);
      const { observedAt: _, ...state } = report;
      const before = previous === undefined ? null : json<ReleaseReport>(previous.record);
      if (before === null || before.state !== report.state || before.commit !== report.commit || before.target !== report.target || before.reason !== report.reason) appendEvent("release.changed", null, state);
      db.prepare("INSERT INTO release_reports VALUES (?, ?, ?) ON CONFLICT(node, role) DO UPDATE SET record = excluded.record").run(report.node, report.role, JSON.stringify(report));
    },
    drain(): Drain | null {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'deploy-drain'").get();
      return row === undefined ? null : JSON.parse(row.value as string) as Drain;
    },
    setDrain(drain: Drain | null) {
      db.prepare("INSERT INTO settings VALUES ('deploy-drain', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(drain));
    },

    /** Nodes come from the config file. Their state and capacity come from observations. */
    upsertNode(node: Pick<NodeRecord, "name" | "tailnetHost" | "tailnetNodeId">) { q.upsertNode.run(node.name, node.tailnetHost, node.tailnetNodeId); },
    nodes: () => (q.nodes.all() as Row[]).map(nodeRow),
    node(name: NodeName): NodeRecord | undefined {
      const row = q.node.get(name) as Row | undefined;
      return row && nodeRow(row);
    },
    /** The loop marks a node offline when its observe link stays down. Every other node fact comes through apply. */
    markOffline(name: NodeName) { q.nodeState.run("offline", name); },

    editProject(id: ProjectId, edit: (stored: Project) => Project): Project | undefined {
      return transaction(() => {
        const row = q.project.get(id) as Row | undefined;
        if (row === undefined) return undefined;
        const project = edit(json<Project>(row.record));
        db.prepare("UPDATE projects SET record = ? WHERE id = ?").run(JSON.stringify(project), id);
        return project;
      });
    },
    updateProject(project: Project) { db.prepare("UPDATE projects SET record = ? WHERE id = ?").run(JSON.stringify(project), project.id); },
    createProject(project: Project) { q.insertProject.run(project.id, JSON.stringify(project)); },
    projects: () => (q.projects.all() as Row[]).map((r) => json<Project>(r.record)),
    project(id: ProjectId): Project | undefined {
      const row = q.project.get(id) as Row | undefined;
      return row && json<Project>(row.record);
    },

    /** A thread and its pylon are created together, because a thread always has exactly one pylon. */
    createThread(thread: Omit<Thread, "seenAt" | "lastReplyAt">, pylon: StoredPylon, claudePrompt?: string) {
      if (pylon.pylonId !== thread.pylonId || pylon.thread !== thread.id) throw new Error(`pylon ${pylon.pylonId} does not belong to thread ${thread.id}`);
      transaction(() => {
        q.insertThread.run(thread.id, thread.title, thread.project, thread.status, thread.conversationId, thread.startedBy, thread.createdAt,
          thread.agentTurnRunning ? 1 : 0, thread.lastAgentActivityAt, thread.lastHumanActivityAt);
        q.insertPylon.run(pylonParams(pylon));
        if (claudePrompt !== undefined) db.prepare("INSERT INTO claude_workers VALUES (?, ?, 'pending')").run(thread.id, claudePrompt);
      });
    },
    threads: (project?: ProjectId) => ((project === undefined ? q.threads.all() : q.threadsOf.all(project)) as Row[]).map(withSessions),
    thread(id: ThreadId): Thread | undefined {
      const row = q.thread.get(id) as Row | undefined;
      return row && withSessions(row);
    },
    markSeen(id: ThreadId, unread: boolean, now = Date.now(), lastReplyAt?: number | null) {
      if (!unread && lastReplyAt === null) return;
      transaction(() => {
        q.markSeen.run(unread ? 1 : 0, now, lastReplyAt ?? Number.MAX_SAFE_INTEGER, id);
        updateAttention(id);
      });
    },
    // The timestamp also identifies a reply, including two events in one millisecond or a clock correction.
    recordReply(id: ThreadId, at: number) {
      transaction(() => { q.recordReply.run(at, id); appendEvent("thread.turn-ended", id, {} , at); updateAttention(id); });
    },
    setThreadStatus(id: ThreadId, status: ThreadStatus) { q.threadStatus.run(status, id); },
    /** Timestamps only move forward, so a late or repeated report cannot make a thread look idle sooner. */
    recordActivity(id: ThreadId, activity: { human?: number; agent?: number; agentTurnRunning?: boolean }) {
      transaction(() => {
        if (activity.human !== undefined) q.humanActivity.run(activity.human, id);
        if (activity.agent !== undefined) q.agentActivity.run(activity.agent, id);
        if (activity.agentTurnRunning !== undefined) q.agentTurn.run(activity.agentTurnRunning ? 1 : 0, id);
        updateAttention(id);
      });
    },

    pylon(id: PylonId): StoredPylon | undefined {
      const row = q.pylon.get(id) as Row | undefined;
      return row && pylonRow(row);
    },
    pylonsOn: (node: NodeName) => (q.pylonsOn.all(node) as Row[]).map(pylonRow),
    /** Takes a whole PylonRecord, so the tick can save what it holds. The desired phase is dropped. */
    savePylon(pylon: StoredPylon) {
      transaction(() => {
        const previous = q.pylon.get(pylon.pylonId);
        const { changes } = q.updatePylon.run(pylonParams(pylon));
        if (changes !== 1) throw new Error(`no pylon ${pylon.pylonId} to save`);
        if (pylon.failed !== null && previous?.failed !== pylon.failed) appendEvent("thread.failed", pylon.thread as ThreadId, { message: pylon.failed });
        updateAttention(pylon.thread as ThreadId);
      });
    },
    /** Clears a failed pylon's verdict and attempts, and marks a human retry. False when the pylon has not failed. */
    retryPylon: (pylonId: PylonId): boolean => transaction(() => {
      const changed = q.retryPylon.run(pylonId).changes === 1;
      const thread = threadOfPylon(pylonId);
      if (thread !== undefined) updateAttention(thread);
      return changed;
    }),

    sessions: (pylon: PylonId) => (q.sessions.all(pylon) as Row[]).map(sessionRow),
    session(pylon: PylonId, id: string): Session | undefined {
      const row = q.session.get(pylon, id) as Row | undefined;
      return row && sessionRow(row);
    },
    /**
     * Gives each of `services` that has no preview yet the lowest port in `range` that no pylon on the pylon's node
     * holds and that the node's last observation does not route. A port the node routes without a row here is left
     * from records that were lost, so handing it out would publish two previews on one URL. A service keeps its port
     * until releasePreviews, so its URL survives pauses and restarts, and asking again changes nothing. Throws when
     * the range is used up, after allocating the services before it.
     */
    allocatePreviews(pylonId: PylonId, services: readonly string[], range: PortRange) {
      const node = (q.pylon.get(pylonId) as Row | undefined)?.node as NodeName | undefined;
      if (node === undefined) throw new Error(`no pylon ${pylonId} to allocate previews for`);
      const routed = (jsonOrNull<NodeObservation>((q.node.get(node) as Row).observation)?.previewRoutes ?? []).map((r) => r.httpsPort);
      const held = new Set(previews(pylonId).map((p) => p.service));
      for (const service of services) {
        if (held.has(service)) continue;
        const taken = new Set([...routed, ...(q.portsOn.all(node) as Row[]).map((r) => r.https_port as number)]);
        let port = range.first;
        while (port <= range.last && taken.has(port)) port++;
        if (port > range.last) throw new Error(`no https port is free for the preview of ${service}: pylons on ${node} hold or ${node} serves every port from ${range.first} to ${range.last}`);
        q.insertPreview.run(service, port, pylonId);
        held.add(service);
      }
    },
    /** Frees a deleted pylon's ports for other pylons on its node. */
    releasePreviews(pylonId: PylonId) { q.deletePreviews.run(pylonId); },
    /** Drops one service's preview, such as an unlinked port's, and frees its port. A service with none is left as it is. */
    releasePreview(pylonId: PylonId, service: string) { q.deletePreview.run(pylonId, service); },
    previews,
    outputs(thread: ThreadId): Output[] {
      const row = db.prepare("SELECT record FROM pr_watches WHERE thread = ?").get(thread) as Row | undefined;
      return [
        ...(q.outputs.all(thread) as Row[]).map((r): Output => ({ thread, kind: r.kind as Output["kind"], ref: r.ref as string })),
        ...(row ? json<PrWatchState>(row.record).links.filter((l) => l.pr.url !== "").map((l): Output => ({ thread, kind: "pull-request", ref: l.pr.url })) : []),
      ];
    },
    orphans: () => (q.orphans.all() as Row[]).map((r): Orphan => ({ node: r.node as NodeName, pylonId: r.pylon_id as PylonId })),

    /** The latest job the node reported for a pylon or an artifact. */
    job(subject: Subject): JobStatus | undefined {
      const row = q.job.get(subject) as Row | undefined;
      return row && json<JobStatus>(row.status);
    },

    saveImage(manifest: ImageManifest) { q.upsertImage.run(manifest.id, JSON.stringify(manifest)); },
    image(id: ImageId): ImageManifest | undefined {
      const row = q.image.get(id) as Row | undefined;
      return row && json<ImageManifest>(row.manifest);
    },
    images: () => (q.images.all() as Row[]).map((r) => json<ImageManifest>(r.manifest)),
    /** The image every new pylon boots. Only a recorded image can become current. */
    setCurrentImage(id: ImageId) {
      if (q.image.get(id) === undefined) throw new Error(`no image ${id} is recorded`);
      q.setSetting.run("current", id);
    },
    currentImage: (): ImageId | null => ((q.setting.get("current") as Row | undefined)?.value ?? null) as ImageId | null,

    saveTemplate(template: TemplateRecord) { q.upsertTemplate.run(template.id, template.key.project, JSON.stringify(template)); },
    templates: (project: ProjectId) => (q.templates.all(project) as Row[]).map((r) => json<TemplateRecord>(r.record)),

    /**
     * Stores the node's new observation together with the writes ingest derived from it. One transaction,
     * because ingest diffs the next event against this observation: a crash between the two would lose the writes.
     */
    ingested(observation: NodeObservation, writes: readonly RegistryWrite[]) {
      transaction(() => {
        q.observation.run(JSON.stringify(observation), observation.node);
        for (const write of writes) apply(write);
      });
    },
    apply,
  };

  /** Folds one of ingest's writes into the records. Each is an upsert, so applying it twice changes nothing. */
  function apply(write: RegistryWrite) {
    switch (write.record) {
      case "node":
        q.nodeFacts.run(write.state, JSON.stringify(write.capacity), write.node);
        return;
      case "sessions": {
        const listed = new Set(write.sessions.map((s) => s.id));
        for (const r of q.sessions.all(write.pylonId) as Row[]) if (!listed.has(r.id as string)) q.deleteSession.run(write.pylonId, r.id as string);
        for (const s of write.sessions) {
          q.upsertSession.run({
            $pylon: write.pylonId, $id: s.id, $herdrPane: s.herdrPane, $harness: s.harness, $harnessSessionId: s.harnessSessionId,
            $status: s.status, $title: s.title, $state: s.state, $message: s.message,
          });
        }
        return;
      }
      case "sessions-paused":
        q.pauseSessions.run(write.pylonId);
        return;
      case "output": {
        const thread = threadOfPylon(write.pylonId);
        if (thread !== undefined) q.insertOutput.run(thread, write.kind, write.ref);
        return;
      }
      case "activity": {
        const thread = threadOfPylon(write.pylonId);
        if (thread === undefined) return;
        if (write.human !== null) q.humanActivity.run(write.human, thread);
        if (write.agent !== null) q.agentActivity.run(write.agent, thread);
        return;
      }
      case "preview":
        // A port the control plane no longer assigns, such as a released one, has no row to mark.
        q.previewReady.run(write.ready ? 1 : 0, write.pylonId, write.service, write.httpsPort);
        return;
      case "orphan":
        q.insertOrphan.run(write.node, write.pylonId);
        return;
      case "job":
        // For the dashboard. The tick settles its own job against the observation, which may lag this.
        q.upsertJob.run(write.status.subject, write.status.jobId, write.status.state, JSON.stringify(write.status));
        return;
    }
  }
}

function migrate(db: DatabaseSync) {
  const applied = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (applied > migrations.length) throw new Error(`the registry is at schema version ${applied}, newer than this control plane's ${migrations.length}`);
  for (let version = applied; version < migrations.length; version++) {
    inTransaction(db, () => {
      db.exec(migrations[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

function inTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
