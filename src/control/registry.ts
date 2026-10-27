import { attentionOf, type Attention } from "./attention.ts";
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
import type { Placement } from "./placement.ts";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ActivityFacts, RegistryWrite, ThreadStatus } from "../reconcile.ts";
import type { HerdrStatus, JobStatus, NodeName, NodeObservation, PylonId, Subject, TailnetNodeId } from "../protocol.ts";
import type { BootInputs, Project, ProjectId, SessionHarness } from "../project.ts";
import type { BuildingTemplate, ImageId, ImageManifest, TemplateId, TemplateRecord, ThreadSetup } from "../images.ts";
import type { PylonRecord } from "../tick.ts";
import type { ImageOperation } from "./image-rollout.ts";
import { needsPerson, reviewerCaller, storedReview, type Review } from "./review.ts";
import type { Passkey } from "./passkeys.ts";
import { claudeTurn } from "../../images/pylon/nexus-turn.ts";
import { defaultClaudeModel } from "../claude-state.ts";
import { maxEntries, transcriptStart, usageLimitStop, type ClaudeEntry, type TranscriptCursor } from "../claude-transcript.ts";

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
  /** What the most recently waiting session's report said, when it said anything. */
  sessionWaitingMessage?: string;
  /** A harness turn or a session's turn runs, such as a Claude worker's. */
  working: boolean;
  /** The earliest known start of a running harness or session turn. Absent when none runs or no start is known. */
  workingSince?: number;
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
  /** The Claude worker's session stopped on its usage limit and no turn of a session runs since. `resetsAt` is null when Claude Code did not say when the limit resets. */
  usageLimit?: { stoppedAt: number; resetsAt: number | null };
  /** Absent from a thread started before setups were recorded. */
  setup?: ThreadSetup;
}

/**
 * An image's manifest and `release`, the full commit of the control plane release whose recipe built it. Null when that is
 * unknown, as for a build from a dev checkout or an image recorded through POST /v1/images.
 */
export type RecordedImage = ImageManifest & { release: string | null };

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
/** What a send to a Claude worker answers, and answers again for a resend of its request ID. */
export interface ClaudeSent { session: string; outcome: "sent" | "queued"; resumed: boolean }

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
  `CREATE TABLE session_order (thread TEXT NOT NULL, session TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(thread, session)) STRICT;
   CREATE TABLE session_order_floor (thread TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT;`,
  `ALTER TABLE claude_workers ADD COLUMN message TEXT;`,
  `ALTER TABLE claude_workers ADD COLUMN session TEXT;`,
  `ALTER TABLE claude_workers ADD COLUMN model TEXT;
   UPDATE claude_workers SET model = 'claude-opus-5-5' WHERE state = 'pending';`,
  // A Claude worker's transcript as last read from its pylon, so a paused pylon or a restarted control plane still
  // shows it, and the messages typed into the worker, so a retried send is not typed twice.
  `CREATE TABLE claude_transcripts (thread TEXT PRIMARY KEY, session TEXT NOT NULL, byte_offset INTEGER NOT NULL, skipping INTEGER NOT NULL, dropped INTEGER NOT NULL, read_at INTEGER NOT NULL) STRICT;
   CREATE TABLE claude_entries (thread TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (thread, seq)) STRICT;
   CREATE TABLE claude_messages (thread TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('sending', 'sent')), result TEXT,
     PRIMARY KEY (thread, request_id), CHECK ((state = 'sent') = (result IS NOT NULL))) STRICT;`,
  // The hash of the transcript's bytes before the stored offset. One stored before it matches none, so its reader starts over.
  `ALTER TABLE claude_transcripts ADD COLUMN before_hash TEXT NOT NULL DEFAULT '';`,
  // When the running harness turn and each working session's turn began, by control's clock. A turn running before
  // has none, as its start was never seen.
  `ALTER TABLE threads ADD COLUMN agent_turn_started_at INTEGER;
   ALTER TABLE session_activity ADD COLUMN started_at INTEGER;`,
  // A builder thread's latest review, keyed by its builder. `reviewer` is the thread the review started to review it.
  `CREATE TABLE reviews (builder TEXT PRIMARY KEY REFERENCES threads (id), reviewer TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;`,
  // The session and pylon-side stamp of a Claude worker thread's latest turn, which name its checkout snapshot.
  `ALTER TABLE claude_workers ADD COLUMN turn_session TEXT;
   ALTER TABLE claude_workers ADD COLUMN turn_at INTEGER;`,
  `ALTER TABLE threads ADD COLUMN placement TEXT;`,
  // What a waiting session's report said it waits for, such as a background command still running at the hold's cap.
  `ALTER TABLE session_activity ADD COLUMN message TEXT;`,
  `ALTER TABLE session_order ADD COLUMN event_ids TEXT;`,
  `ALTER TABLE threads ADD COLUMN setup TEXT;`,
  // Every pull request a review ever started for, which outlives the builder's record a later review replaces.
  `CREATE TABLE reviewed_prs (repo TEXT NOT NULL, number INTEGER NOT NULL, PRIMARY KEY (repo, number)) STRICT;
   INSERT OR IGNORE INTO reviewed_prs SELECT json_extract(record, '$.pr.repo'), json_extract(record, '$.pr.number') FROM reviews;`,
  // The person's passkeys, public keys only, and the codes root on the control plane's host makes to enrol one, hashed.
  // It touches nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, credential_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS passkey_codes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER) STRICT;`,
];

type Row = Record<string, unknown>;
const json = <T>(value: unknown): T => JSON.parse(value as string) as T;
const jsonOrNull = <T>(value: unknown): T | null => value === null ? null : json<T>(value);
/** An observation stored from a probe older than `grants` has none, which reads as such a probe's null. */
function observationOf(value: unknown): NodeObservation | null {
  const o = jsonOrNull<NodeObservation>(value);
  return o === null ? null : { ...o, grants: o.grants ?? null };
}

/** A row written before images recorded their release has none. */
function recordedImage(r: Row): RecordedImage {
  const image = json<ImageManifest & { release?: string | null }>(r.manifest);
  return { ...image, release: image.release ?? null };
}

function nodeRow(r: Row): NodeRecord {
  return {
    name: r.name as NodeName,
    tailnetHost: r.tailnet_host as string,
    tailnetNodeId: r.tailnet_node_id as TailnetNodeId,
    state: r.state as NodeRecord["state"],
    capacity: jsonOrNull(r.capacity),
    observation: observationOf(r.observation),
  };
}

function threadRow(r: Row): Omit<Thread, "working"> {
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
  // The passkey host command writes the registry from another process, so a write waits out its short transaction.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);

  /**
   * Room a start placed a pylon in before its row exists, so an overlapping start sees it taken. It is held in memory,
   * because a start that a crash ended took no room.
   */
  const reservations = new Map<PylonId, { node: NodeName; resources: BootInputs["resources"] }>();
  let transactionDepth = 0;
  const transaction = <T>(body: () => T): T => {
    if (transactionDepth > 0) return body();
    transactionDepth++;
    try { return inTransaction(db, body); } finally { transactionDepth--; }
  };
  const statements = new Map<string, StatementSync>();
  const sql = (text: string): StatementSync => {
    let statement = statements.get(text);
    if (statement === undefined) statements.set(text, statement = db.prepare(text));
    return statement;
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
      agent_turn_running, last_agent_activity_at, last_human_activity_at, placement, setup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    threads: db.prepare("SELECT * FROM threads ORDER BY created_at, id"),
    threadsOf: db.prepare("SELECT * FROM threads WHERE project = ? ORDER BY created_at, id"),
    thread: db.prepare("SELECT * FROM threads WHERE id = ?"),
    threadOfPylon: db.prepare("SELECT thread FROM pylons WHERE id = ?"),
    threadStatus: db.prepare("UPDATE threads SET status = ? WHERE id = ?"),
    humanActivity: db.prepare("UPDATE threads SET last_human_activity_at = max(last_human_activity_at, ?) WHERE id = ?"),
    agentActivity: db.prepare("UPDATE threads SET last_agent_activity_at = max(last_agent_activity_at, ?) WHERE id = ?"),
    // A turn that keeps running keeps its start, and a turn that ends forgets it.
    agentTurn: db.prepare(`UPDATE threads SET agent_turn_running = $running,
      agent_turn_started_at = CASE WHEN $running = 0 THEN NULL WHEN agent_turn_running = 1 THEN agent_turn_started_at ELSE $start END WHERE id = $id`),
    insertPylon: db.prepare(`INSERT INTO pylons (id, thread, node, boot, first_boot, live, live_hash, pauses, submitted, attempts, failed, retrying)
      VALUES ($id, $thread, $node, $boot, $firstBoot, $live, $liveHash, $pauses, $submitted, $attempts, $failed, $retrying)`),
    updatePylon: db.prepare(`UPDATE pylons SET thread = $thread, node = $node, boot = $boot, first_boot = $firstBoot, live = $live,
      live_hash = $liveHash, pauses = $pauses, submitted = $submitted, attempts = $attempts, failed = $failed, retrying = $retrying WHERE id = $id`),
    markSeen: db.prepare("UPDATE threads SET seen_at = CASE WHEN ? THEN last_reply_at - 1 ELSE max(coalesce(seen_at, 0), min(max(?, coalesce(last_reply_at, 0)), ?)) END WHERE id = ?"),
    recordReply: db.prepare("UPDATE threads SET last_reply_at = max(coalesce(last_reply_at, 0) + 1, coalesce(seen_at, 0) + 1, ?) WHERE id = ?"),
    retryPylon: db.prepare(`UPDATE pylons SET failed = NULL, attempts = '{"count":0,"last":null}', retrying = 1 WHERE id = ? AND failed IS NOT NULL`),
    pylon: db.prepare("SELECT * FROM pylons WHERE id = ?"),
    pylonsOn: db.prepare("SELECT * FROM pylons WHERE node = ? ORDER BY id"),
    pylonIdsOn: db.prepare("SELECT id FROM pylons WHERE node = ? ORDER BY id"),
    // A null status keeps the one the row has.
    upsertSession: db.prepare(`INSERT INTO sessions (pylon, id, herdr_pane, harness, harness_session_id, status, title, state, message)
      VALUES ($pylon, $id, $herdrPane, $harness, $harnessSessionId, coalesce($status, 'unknown'), $title, $state, $message)
      ON CONFLICT (pylon, id) DO UPDATE SET herdr_pane = excluded.herdr_pane, harness = excluded.harness, harness_session_id = excluded.harness_session_id,
      status = coalesce($status, sessions.status), title = excluded.title, state = excluded.state, message = excluded.message`),
    deleteSession: db.prepare("DELETE FROM sessions WHERE pylon = ? AND id = ?"),
    pauseSessions: db.prepare("UPDATE sessions SET state = 'paused', message = NULL WHERE pylon = ?"),
    resumeSessions: db.prepare(`UPDATE sessions SET status = 'unknown', state = CASE WHEN herdr_pane IS NULL THEN 'failed' ELSE 'running' END,
      message = CASE WHEN herdr_pane IS NULL THEN 'its last wake did not bring it back, and whether this one did is not read yet' END
      WHERE pylon = ? AND state = 'paused'`),
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
    buildingTemplates: db.prepare("SELECT record FROM templates WHERE json_extract(record, '$.state') = 'building' AND json_extract(record, '$.on') = ? ORDER BY id"),
    deleteTemplate: db.prepare("DELETE FROM templates WHERE id = ?"),
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
    const observed = observationOf((q.node.get(rows[0]!.node as string) as Row).observation)?.pylons.find((p) => p.pylonId === pylon);
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
    const live = sql("SELECT max(updated_at) AS at, min(started_at) AS since FROM session_activity WHERE thread = ? AND state = 'session.turn-started' AND updated_at > ?").get(thread.id, clock() - sessionActivityTtlMs)!;
    const working = live.at as number | null;
    const waiting = sql("SELECT message FROM session_activity WHERE thread = ? AND state = 'session.waiting' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(thread.id);
    const starts = [thread.agentTurnRunning ? row.agent_turn_started_at : null, live.since].filter((at): at is number => typeof at === "number");
    const usageLimit = working === null ? usageLimitOf(thread.id) : null;
    return {
      ...thread, working: thread.agentTurnRunning || working !== null,
      ...(working === null ? {} : { sessionTurnRunning: true, sessionActiveUntil: working + sessionActivityTtlMs }), ...(waiting === undefined ? {} : { sessionWaiting: true }),
      ...(typeof waiting?.message === "string" ? { sessionWaitingMessage: waiting.message } : {}),
      ...(starts.length === 0 ? {} : { workingSince: Math.min(...starts) }), ...(usageLimit === null ? {} : { usageLimit }),
    };
  }

  /** Derived from the newest entries rather than stored, so it holds whichever of the turn's end and the transcript's read comes first. */
  function usageLimitOf(id: ThreadId) {
    const worker = sql("SELECT w.turn_at FROM claude_workers w JOIN claude_transcripts t ON t.thread = w.thread AND t.session = w.session WHERE w.thread = ?").get(id);
    if (worker === undefined) return null;
    const entries = sql("SELECT entry FROM claude_entries WHERE thread = ? ORDER BY seq DESC LIMIT 16").all(id).map((r) => json<ClaudeEntry>(r.entry)).reverse();
    const stop = usageLimitStop(entries);
    // A turn that started after the stop, by the pylon's clock as the record's time is, ended it, though its prompt may not be read yet.
    return stop !== null && (worker.turn_at === null || Number(worker.turn_at) <= stop.stoppedAt) ? stop : null;
  }

  function updateAttention(id: ThreadId) {
    const row = q.thread.get(id);
    if (row === undefined) return;
    const t = withSessions(row);
    const old = sql("SELECT * FROM thread_attention WHERE thread = ?").get(id);
    const p = q.pylon.get(t.pylonId);
    const workerFailed = ["failed", "stalled"].includes(String(sql("SELECT state FROM claude_workers WHERE thread = ?").get(id)?.state));
    const decision = needsPerson(jsonOrNull<Review>(sql("SELECT record FROM reviews WHERE builder = ?").get(id)?.record ?? null));
    const attention = attentionOf(p?.failed != null || workerFailed, old?.parked === 1, t.lastReplyAt, t.seenAt, t.working, t.sessionWaiting, decision, t.usageLimit !== undefined);
    if ((old?.attention ?? null) === attention) return;
    sql("INSERT INTO thread_attention (thread, attention) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET attention = excluded.attention").run(id, attention);
    appendEvent("attention.changed", id, { attention });
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
      const project = thread === null ? null : (q.thread.get(thread)?.project as string | undefined) ?? null;
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
    const events = sql(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY id`).all(...params).map((r): NexusEvent => ({
      id: String(r.id), time: r.time as number, thread: r.thread as string | null, project: r.project as string | null,
      kind: r.kind as EventKind, payload: json<Record<string, unknown>>(r.payload),
    }));
    return { events, watermark: String(Math.max(cursor, newest ?? 0)) };
  }

  function claudeTranscript(thread: ThreadId): ClaudeTranscript | undefined {
    const row = sql("SELECT * FROM claude_transcripts WHERE thread = ?").get(thread);
    return row === undefined ? undefined : {
      session: row.session as string, cursor: { offset: row.byte_offset as number, skipping: row.skipping === 1, before: row.before_hash as string }, dropped: row.dropped as number, readAt: row.read_at as number,
    };
  }

  const setting = (key: string): string | null => ((q.setting.get(key) as Row | undefined)?.value ?? null) as string | null;

  pruneSessions();
  // A release that computes attention differently, or a thread from before attention was stored, is right from the start.
  // A thread deleted before deletes cleared the parked flag kept it, and the harness no longer tracks it to report.
  transaction(() => {
    sql("UPDATE thread_attention SET parked = 0 WHERE thread IN (SELECT id FROM threads WHERE status = 'deleted')").run();
    for (const { id } of sql("SELECT id FROM threads").all()) updateAttention(id as ThreadId);
  });

  return {
    close() { db.close(); },
    appendEvent,
    pruneSessions,
    attention: (id: ThreadId): Attention => (sql("SELECT attention FROM thread_attention WHERE thread = ?").get(id)?.attention ?? null) as Attention,
    recordParked(id: ThreadId, parked: boolean) {
      // The harness reports on every change of a thread's live document, and nearly every report repeats the stored value.
      if (sql("SELECT parked FROM thread_attention WHERE thread = ?").get(id)?.parked === (parked ? 1 : 0)) return;
      transaction(() => {
        sql("INSERT INTO thread_attention (thread, parked) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET parked = excluded.parked").run(id, parked ? 1 : 0);
        if (parked) appendEvent("thread.parked", id, {});
        updateAttention(id);
      });
    },
    /** `session` is the Claude Code session its launch opened, null until the launch names one. */
    claudeWorker(thread: ThreadId): { prompt: string; state: string; model: string | null; session: string | null; message?: string } | undefined {
      const row = sql("SELECT prompt, state, message, model, session FROM claude_workers WHERE thread = ?").get(thread);
      return row === undefined ? undefined : {
        model: row.model as string | null, prompt: row.prompt as string, state: row.state as string, session: row.session as string | null,
        ...(row.message == null ? {} : { message: row.message as string }),
      };
    },
    /** The snapshot ID of the latest session.turn-started of any session on a Claude worker thread. */
    latestClaudeTurn(thread: ThreadId): string | null {
      const row = sql("SELECT turn_session, turn_at FROM claude_workers WHERE thread = ? AND turn_at IS NOT NULL").get(thread);
      return row === undefined ? null : claudeTurn(row.turn_session as string, row.turn_at as number);
    },
    claudeTranscript,
    claudeEntries: (thread: ThreadId): ClaudeEntry[] => sql("SELECT entry FROM claude_entries WHERE thread = ? ORDER BY seq").all(thread).map((r) => json<ClaudeEntry>(r.entry)),
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
        const stop = usageLimitOf(thread);
        if (stop !== null) {
          sql("DELETE FROM session_activity WHERE thread = ? AND session = ? AND state = 'session.turn-started' AND EXISTS (SELECT 1 FROM session_order o WHERE o.thread = ? AND o.session = ? AND o.at <= ?)")
            .run(thread, read.session, thread, read.session, stop.stoppedAt);
        }
        updateAttention(thread);
        return true;
      });
    },
    claudeMessage(thread: ThreadId, requestId: string): ClaudeMessage | undefined {
      const row = sql("SELECT state, result FROM claude_messages WHERE thread = ? AND request_id = ?").get(thread, requestId);
      return row === undefined ? undefined : row.state === "sent" ? { state: "sent", result: json<ClaudeSent>(row.result) } : { state: "sending" };
    },
    /** Null forgets the message, as for a send that typed nothing. */
    setClaudeMessage(thread: ThreadId, requestId: string, message: ClaudeMessage | null) {
      if (message === null) return void sql("DELETE FROM claude_messages WHERE thread = ? AND request_id = ?").run(thread, requestId);
      sql("INSERT INTO claude_messages (thread, request_id, state, result) VALUES (?, ?, ?, ?) ON CONFLICT (thread, request_id) DO UPDATE SET state = excluded.state, result = excluded.result")
        .run(thread, requestId, message.state, message.state === "sent" ? JSON.stringify(message.result) : null);
    },
    setClaudeWorker(thread: ThreadId, prompt: string, state: string, message?: string, session?: string) {
      transaction(() => {
        sql("INSERT INTO claude_workers (thread, prompt, state, message, session, model) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread) DO UPDATE SET state = excluded.state, message = excluded.message, session = coalesce(excluded.session, claude_workers.session)").run(thread, prompt, state, message ?? null, session ?? null, defaultClaudeModel);
        updateAttention(thread);
      });
    },
    /** The highest journal sequence applied from the node, or null before its first. */
    eventReceipt(node: NodeName): number | null {
      const receipt = sql("SELECT sequence FROM event_receipts WHERE node = ?").get(node);
      return receipt === undefined ? null : Number(receipt.sequence);
    },
    reportSession(node: NodeName, report: ReportedEvent) {
      const event = pylonEventSchema.parse(report.event);
      const pylon = q.pylon.get(report.pylon);
      if (pylon === undefined || pylon.node !== node) return;
      const thread = pylon.thread as ThreadId;
      transaction(() => {
        const receipt = sql("SELECT sequence FROM event_receipts WHERE node = ?").get(node);
        if (receipt !== undefined && Number(receipt.sequence) >= report.sequence) return;
        sql("INSERT INTO event_receipts VALUES (?, ?) ON CONFLICT(node) DO UPDATE SET sequence = excluded.sequence").run(node, report.sequence);
        pruneSessions();
        const session = event.session ?? "default";
        const status = q.thread.get(thread)?.status;
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
        if (event.kind !== "session.waiting") q.agentActivity.run(clock(), thread);
        if (event.kind === "session.turn-ended") q.recordReply.run(clock(), thread);
        appendEvent(event.kind, thread, { at, ...(event.session === undefined ? {} : { session: event.session }), ...(event.message === undefined ? {} : { message: event.message }) });
        updateAttention(thread);
      });
    },
    eventBatch,
    events: (since = "0", filter: EventFilter = {}) => eventBatch(since, filter).events,
    review(builder: ThreadId): Review | null {
      const record = jsonOrNull<Review>(sql("SELECT record FROM reviews WHERE builder = ?").get(builder)?.record ?? null);
      return record === null ? null : storedReview(record);
    },
    reviews: (): Review[] => sql("SELECT record FROM reviews ORDER BY builder").all().map((r) => storedReview(json<Review>(r.record))),
    /** A thread a review started, whether or not a later review replaced the record that names it. */
    isReviewer: (thread: ThreadId) => sql("SELECT 1 FROM threads WHERE id = ? AND started_by = ? UNION SELECT 1 FROM reviews WHERE reviewer = ?").get(thread, reviewerCaller, thread) !== undefined,
    /** Whether a review ever started for the pull request, including one a later review of its builder replaced. */
    prReviewed: (repo: string, number: number) => sql("SELECT 1 FROM reviewed_prs WHERE repo = ? AND number = ?").get(repo, number) !== undefined,
    /** Replaces the builder's review, and tells the event log when its phase, round or label changed, or the person waived holds. */
    saveReview(review: Review) {
      transaction(() => {
        const before = jsonOrNull<Review>(sql("SELECT record FROM reviews WHERE builder = ?").get(review.builder)?.record ?? null);
        sql("INSERT INTO reviews (builder, reviewer, record) VALUES (?, ?, ?) ON CONFLICT (builder) DO UPDATE SET reviewer = excluded.reviewer, record = excluded.record")
          .run(review.builder, review.reviewer, JSON.stringify(review));
        sql("INSERT OR IGNORE INTO reviewed_prs (repo, number) VALUES (?, ?)").run(review.pr.repo, review.pr.number);
        const label = (r: Review | null) => r?.phase.kind === "needs-person" ? r.phase.label?.state : undefined;
        if (before?.id !== review.id || before.phase.kind !== review.phase.kind || before.rounds.length !== review.rounds.length || label(before) !== label(review)) {
          appendEvent("review.changed", review.builder, { review: review.id, reviewer: review.reviewer, phase: review.phase, round: review.rounds.length });
        }
        if (review.waiver != null && JSON.stringify(before?.waiver ?? null) !== JSON.stringify(review.waiver)) {
          appendEvent("review.waived", review.builder, { review: review.id, repo: review.pr.repo, pr: review.pr.number, ...review.waiver });
        }
        updateAttention(review.builder);
      });
    },
    passkeys: (): Passkey[] => sql("SELECT record FROM passkeys ORDER BY id").all().map((r) => json<Passkey>(r.record)),
    passkeyByCredential: (credentialId: string): Passkey | null => jsonOrNull<Passkey>(sql("SELECT record FROM passkeys WHERE credential_id = ?").get(credentialId)?.record ?? null),
    addPasskeyCode(hash: string, expiresAt: number) {
      sql("INSERT INTO passkey_codes (hash, expires_at) VALUES (?, ?)").run(hash, expiresAt);
    },
    passkeyCodeOpen: (hash: string, at: number) => sql("SELECT 1 FROM passkey_codes WHERE hash = ? AND used_at IS NULL AND expires_at > ?").get(hash, at) !== undefined,
    /** Enrols the passkey and uses up its code, or does neither when the code was used or expired meanwhile. */
    enrolPasskey(passkey: Passkey, codeHash: string): boolean {
      return transaction(() => {
        if (sql("UPDATE passkey_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?").run(passkey.createdAt, codeHash, passkey.createdAt).changes === 0) return false;
        sql("INSERT INTO passkeys (id, credential_id, record) VALUES (?, ?, ?)").run(passkey.id, passkey.credentialId, JSON.stringify(passkey));
        appendEvent("passkey.enrolled", null, { passkey: passkey.id, name: passkey.name, by: passkey.createdBy });
        return true;
      });
    },
    savePasskeyUse(passkey: Passkey) {
      sql("UPDATE passkeys SET record = ? WHERE id = ?").run(JSON.stringify(passkey), passkey.id);
    },
    revokePasskey(id: string, by: string): Passkey | null {
      return transaction(() => {
        const passkey = jsonOrNull<Passkey>(sql("SELECT record FROM passkeys WHERE id = ?").get(id)?.record ?? null);
        if (passkey === null) return null;
        sql("DELETE FROM passkeys WHERE id = ?").run(id);
        appendEvent("passkey.revoked", null, { passkey: id, name: passkey.name, by });
        return passkey;
      });
    },
    prWatch(thread: ThreadId): PrWatchState | null {
      const row = sql("SELECT record FROM pr_watches WHERE thread = ?").get(thread) as Row | undefined;
      return row ? json<PrWatchState>(row.record) : null;
    },
    savePrWatch(thread: ThreadId, state: PrWatchState) {
      const previous = sql("SELECT record FROM pr_watches WHERE thread = ?").get(thread);
      if (state.pending !== null && (previous === undefined || json<PrWatchState>(previous.record).pending?.id !== state.pending.id)) appendEvent("pull-request.feedback", thread, { requestId: state.pending.id });
      sql("INSERT INTO pr_watches (thread, record) VALUES (?, ?) ON CONFLICT (thread) DO UPDATE SET record = excluded.record").run(thread, JSON.stringify(state));
    },
    desiredRelease(): DesiredRelease | null {
      const row = sql("SELECT value FROM settings WHERE key = 'release'").get();
      return row === undefined ? null : JSON.parse(row.value as string) as DesiredRelease;
    },
    setDesiredRelease(release: DesiredRelease) {
      appendEvent("release.changed", null, { desired: release });
      sql("INSERT INTO settings VALUES ('release', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(release));
    },
    releaseReports(): ReleaseReport[] {
      return sql("SELECT record FROM release_reports ORDER BY node, role").all().map((r) => JSON.parse(r.record as string) as ReleaseReport);
    },
    reportRelease(report: ReleaseReport) {
      const previous = sql("SELECT record FROM release_reports WHERE node = ? AND role = ?").get(report.node, report.role);
      const { observedAt: _, ...state } = report;
      const before = previous === undefined ? null : json<ReleaseReport>(previous.record);
      if (before === null || before.state !== report.state || before.commit !== report.commit || before.target !== report.target || before.reason !== report.reason) appendEvent("release.changed", null, state);
      sql("INSERT INTO release_reports VALUES (?, ?, ?) ON CONFLICT(node, role) DO UPDATE SET record = excluded.record").run(report.node, report.role, JSON.stringify(report));
    },
    drain(): Drain | null {
      const row = sql("SELECT value FROM settings WHERE key = 'deploy-drain'").get();
      return row === undefined ? null : JSON.parse(row.value as string) as Drain;
    },
    setDrain(drain: Drain | null) {
      sql("INSERT INTO settings VALUES ('deploy-drain', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(drain));
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
        sql("UPDATE projects SET record = ? WHERE id = ?").run(JSON.stringify(project), id);
        return project;
      });
    },
    updateProject(project: Project) { sql("UPDATE projects SET record = ? WHERE id = ?").run(JSON.stringify(project), project.id); },
    createProject(project: Project) { q.insertProject.run(project.id, JSON.stringify(project)); },
    projects: () => (q.projects.all() as Row[]).map((r) => json<Project>(r.record)),
    project(id: ProjectId): Project | undefined {
      const row = q.project.get(id) as Row | undefined;
      return row && json<Project>(row.record);
    },

    /** A thread and its pylon are created together, because a thread always has exactly one pylon. */
    createThread(thread: Omit<Thread, "seenAt" | "lastReplyAt">, pylon: StoredPylon, claudePrompt?: string, model = defaultClaudeModel) {
      if (pylon.pylonId !== thread.pylonId || pylon.thread !== thread.id) throw new Error(`pylon ${pylon.pylonId} does not belong to thread ${thread.id}`);
      transaction(() => {
        q.insertThread.run(thread.id, thread.title, thread.project, thread.status, thread.conversationId, thread.startedBy, thread.createdAt,
          thread.agentTurnRunning ? 1 : 0, thread.lastAgentActivityAt, thread.lastHumanActivityAt, thread.placement === undefined ? null : JSON.stringify(thread.placement),
          thread.setup === undefined ? null : JSON.stringify(thread.setup));
        q.insertPylon.run(pylonParams(pylon));
        if (claudePrompt !== undefined) sql("INSERT INTO claude_workers (thread, prompt, state, model) VALUES (?, ?, 'pending', ?)").run(thread.id, claudePrompt, model);
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
    setThreadStatus(id: ThreadId, status: ThreadStatus) {
      transaction(() => {
        q.threadStatus.run(status, id);
        if (status === "archived" || status === "deleted") sql("DELETE FROM session_activity WHERE thread = ?").run(id);
        if (status === "deleted") {
          // The delete aborts the run, so nothing is left to retry, and the harness stops tracking the thread without a report.
          sql("UPDATE thread_attention SET parked = 0 WHERE thread = ?").run(id);
          for (const table of ["session_order", "session_order_floor", "claude_transcripts", "claude_entries", "claude_messages"]) sql(`DELETE FROM ${table} WHERE thread = ?`).run(id);
        }
        updateAttention(id);
      });
    },
    /** Timestamps only move forward, so a late or repeated report cannot make a thread look idle sooner. */
    recordActivity(id: ThreadId, activity: { human?: number; agent?: number; agentTurnRunning?: boolean }) {
      transaction(() => {
        if (activity.human !== undefined) q.humanActivity.run(activity.human, id);
        if (activity.agent !== undefined) q.agentActivity.run(activity.agent, id);
        // The harness reports its last activity as the moment the turn flipped.
        if (activity.agentTurnRunning !== undefined) q.agentTurn.run({ $running: activity.agentTurnRunning ? 1 : 0, $start: activity.agent ?? clock(), $id: id });
        updateAttention(id);
      });
    },

    pylon(id: PylonId): StoredPylon | undefined {
      const row = q.pylon.get(id) as Row | undefined;
      return row && pylonRow(row);
    },
    pylonsOn: (node: NodeName) => (q.pylonsOn.all(node) as Row[]).map(pylonRow),
    pylonIdsOn: (node: NodeName) => (q.pylonIdsOn.all(node) as Row[]).map((r) => r.id as PylonId),
    /** Returns what releases it, once the pylon's row counts it or the start failed. */
    reserve(pylonId: PylonId, node: NodeName, resources: BootInputs["resources"]): () => void {
      reservations.set(pylonId, { node, resources });
      return () => { reservations.delete(pylonId); };
    },
    reserved: (node: NodeName) => [...reservations.values()].filter((r) => r.node === node).map((r) => r.resources),
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
      const routed = (observationOf((q.node.get(node) as Row).observation)?.previewRoutes ?? []).map((r) => r.httpsPort);
      const held = new Set((q.previews.all(pylonId) as Row[]).map((r) => r.service as string));
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
      const row = sql("SELECT record FROM pr_watches WHERE thread = ?").get(thread) as Row | undefined;
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

    /** Kept in the manifest column, so a control plane older than `release` still reads the row. */
    saveImage(manifest: ImageManifest, release: string | null) { q.upsertImage.run(manifest.id, JSON.stringify({ ...manifest, release })); },
    image(id: ImageId): RecordedImage | undefined {
      const row = q.image.get(id) as Row | undefined;
      return row && recordedImage(row);
    },
    images: () => (q.images.all() as Row[]).map(recordedImage),
    /** The image every new pylon boots. Only a recorded image can become current, and the one it replaces becomes the previous image. */
    setCurrentImage(id: ImageId) {
      transaction(() => {
        if (q.image.get(id) === undefined) throw new Error(`no image ${id} is recorded`);
        const current = setting("current");
        if (current !== null && current !== id) q.setSetting.run("previous-image", current);
        q.setSetting.run("current", id);
      });
    },
    currentImage: (): ImageId | null => setting("current") as ImageId | null,
    previousImage: (): ImageId | null => setting("previous-image") as ImageId | null,
    /** The latest image build or rollout. One runs at a time, and it stays readable once it has finished. */
    imageOperation: (): ImageOperation | null => jsonOrNull<ImageOperation>(setting("image-operation")),
    saveImageOperation(operation: ImageOperation) { q.setSetting.run("image-operation", JSON.stringify(operation)); },

    saveTemplate(template: TemplateRecord) { q.upsertTemplate.run(template.id, template.key.project, JSON.stringify(template)); },
    templates: (project: ProjectId) => (q.templates.all(project) as Row[]).map((r) => json<TemplateRecord>(r.record)),
    /** The builds the node's loop pass moves along, in every project. */
    buildingTemplates: (node: NodeName) => (q.buildingTemplates.all(node) as Row[]).map((r) => json<BuildingTemplate>(r.record)),
    deleteTemplate(id: TemplateId) { q.deleteTemplate.run(id); },

    /**
     * Stores the node's new observation together with the writes ingest derived from it. One transaction,
     * because ingest diffs the next event against this observation: a crash between the two would lose the writes.
     * The observation is null when the event left it as it was.
     */
    ingested(observation: NodeObservation | null, writes: readonly RegistryWrite[]) {
      if (observation === null && writes.length === 0) return;
      transaction(() => {
        if (observation !== null) q.observation.run(JSON.stringify(observation), observation.node);
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
      case "sessions-resumed":
        q.resumeSessions.run(write.pylonId);
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
