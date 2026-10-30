import { attentionOf, type Attention } from "./attention.ts";
import { pylonEventSchema } from "../events.ts";
import type { ReportedEvent } from "../events.ts";
import { eventCursor, sessionActivityTtlMs, maxActiveSessions, type EventFilter, type EventKind, type NexusEvent } from "../events.ts";
import type { DesiredRelease, Drain, ReleaseReport } from "../deploy/model.ts";
/**
 * The registry: every Nexus record, in one SQLite file. The control plane process is its only writer, and
 * it holds one connection, so every write is a synchronous statement and no two writes interleave.
 *
 * Nested values (a project's hosts, a pylon's boot inputs, an observation) are stored as JSON columns. Only
 * the control plane reads them, always whole, so they need no columns of their own.
 */
import type { PrWatchState } from "./pr-watch.ts";
import type { Sender } from "../harness/host.ts";
import type { PlanningRecord } from "./planning.ts";
import { askQuestionId, askRecord, type Question, type WaitingAsk } from "./questions.ts";
import type { Nudge } from "./nudge.ts";
import type { Judgment } from "./judgment.ts";
import type { ItemId, ItemRecord } from "./pipeline.ts";
import type { QueuedRecord } from "./queue.ts";
import type { Placement } from "./placement.ts";
import { HttpError } from "./http-error.ts";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ActivityFacts, RegistryWrite, ThreadStatus } from "../reconcile.ts";
import { upgradeObservation, type HerdrStatus, type JobStatus, type NodeName, type NodeObservation, type OlderObservation, type PylonId, type ReportedCapacity, type Subject, type TailnetNodeId } from "../protocol.ts";
import type { BootInputs, Project, ProjectId } from "../project.ts";
import type { SessionHarness } from "../sessions.ts";
import type { BuildingTemplate, ImageId, ImageManifest, TemplateId, TemplateRecord, ThreadSetup } from "../images.ts";
import type { PylonRecord } from "../tick.ts";
import type { ImageOperation } from "./image-rollout.ts";
import { needsPerson, reviewerCaller, storedReview, type Review } from "./review.ts";
import { claudeTurn } from "../../images/pylon/nexus-turn.ts";
import { defaultClaudeModel } from "../claude-state.ts";
import { maxEntries, transcriptStart, usageLimitStop, type ClaudeEntry, type TranscriptCursor } from "../claude-transcript.ts";
import { roleOf, type AgentCall, type BackfillThread, type Breakdown, type UsageBackfill, type UsageReport, type UsageTotals } from "./usage.ts";

declare const brand: unique symbol;
/** At most 34 characters, so `pylon-<id>` fits pi-sandbox's 40. */
export type ThreadId = string & { readonly [brand]: "ThreadId" };

export interface NodeRecord {
  name: NodeName;
  tailnetHost: string;
  tailnetNodeId: TailnetNodeId;
  state: "online" | "offline";
  /** As the probe reported it, which the API sends. Null for a node never observed. */
  capacity: ReportedCapacity | null;
  /** The probe's latest observation. While the node is offline the dashboard shows it, marked stale. */
  observation: NodeObservation | null;
}

/** A node that joined with a token rather than being named in control.json. `deployKey` is the digest of its deployer's token. */
export interface JoinedNode extends Pick<NodeRecord, "name" | "tailnetHost" | "tailnetNodeId"> { deployKey: string; joinedAt: number }

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

/**
 * An image's manifest and `release`, the full commit of the control plane release whose recipe built it. Null when that is
 * unknown, as for a build from a dev checkout or an image recorded through POST /v1/images.
 */
export type RecordedImage = ImageManifest & { release: string | null };

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

/**
 * How far a source of usage was read: a pylon's transcript, by its path, to a byte offset with the SHA-256 of the up
 * to 4 KiB before it, or a harness conversation to an entry, with no hash.
 */
export interface UsageCursor { source: string; key: string; position: number; before: string }
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

/** A start's request ID and a hash of the body it came with, stored with the thread or queued record the start made. */
export interface StartKey { requestId: string; body: string }

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
  // Threads queued to start once other threads' pull requests merge, keyed by the ID the thread gets when it starts.
  // It touches nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS queued_threads (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;`,
  // Landing from the dashboard no longer asks for a passkey, so their tables go. They never held a row, and dropping
  // them touches nothing an earlier migration needs, so a registry rewound past it applies it again unchanged.
  `DROP TABLE IF EXISTS passkeys;
   DROP TABLE IF EXISTS passkey_codes;`,
  // Every model call an agent made, by the ID its own record gives it, their sums per UTC day, and how far each source
  // was read. usage_since holds when counting started. It touches nothing an earlier migration made, so a registry rewound past it applies it
  // again unchanged.
  `CREATE TABLE IF NOT EXISTS usage_records (id TEXT PRIMARY KEY, thread TEXT NOT NULL, project TEXT NOT NULL, role TEXT NOT NULL, agent TEXT NOT NULL,
     model TEXT NOT NULL, at INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_read INTEGER NOT NULL) STRICT;
   CREATE INDEX IF NOT EXISTS usage_records_at ON usage_records(at);
   CREATE INDEX IF NOT EXISTS usage_records_thread ON usage_records(thread);
   CREATE TABLE IF NOT EXISTS usage_days (day TEXT NOT NULL, project TEXT NOT NULL, role TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
     input INTEGER NOT NULL, output INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_read INTEGER NOT NULL, calls INTEGER NOT NULL,
     PRIMARY KEY (day, project, role, agent, model)) STRICT;
   CREATE TABLE IF NOT EXISTS usage_cursors (source TEXT NOT NULL, key TEXT NOT NULL, position INTEGER NOT NULL, before TEXT NOT NULL, PRIMARY KEY (source, key)) STRICT;
   CREATE TABLE IF NOT EXISTS usage_since (at INTEGER NOT NULL) STRICT;
   INSERT INTO usage_since SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE NOT EXISTS (SELECT 1 FROM usage_since);`,
  // The usage backfill's run, with the pylon it holds and what it waits for, and each thread a run listed. It touches
  // nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS usage_backfill (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL CHECK (state IN ('running', 'stopped', 'done')),
     started_at INTEGER NOT NULL, finished_at INTEGER, thread TEXT, phase TEXT CHECK (phase IN ('reading', 'pausing')), since INTEGER, waiting TEXT,
     CHECK ((thread IS NULL) = (phase IS NULL) AND (thread IS NULL) = (since IS NULL))) STRICT;
   CREATE TABLE IF NOT EXISTS usage_backfill_threads (thread TEXT PRIMARY KEY REFERENCES threads (id), state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'skipped')),
     reason TEXT, calls INTEGER NOT NULL, tokens INTEGER NOT NULL, at INTEGER,
     CHECK ((state = 'skipped') = (reason IS NOT NULL)), CHECK ((state = 'pending') = (at IS NULL))) STRICT;`,
  // Each start's request ID, the thread it made, started or queued, and a hash of the body it was asked with. It touches
  // nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS start_requests (request_id TEXT PRIMARY KEY, thread TEXT NOT NULL, body TEXT NOT NULL) STRICT;`,
  // Each question a thread asked the person, keyed by the ID its asker chose, with its answer once there is one. It
  // touches nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, thread TEXT NOT NULL REFERENCES threads (id), record TEXT NOT NULL) STRICT;`,
  // Each builder's nudges toward a pull request. It touches nothing an earlier migration made, so a registry rewound
  // past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS nudges (thread TEXT PRIMARY KEY REFERENCES threads (id), record TEXT NOT NULL) STRICT;`,
  // Pipeline items, and the pipeline on for project nexus, whose items start on their own. A project whose pipeline the
  // person turned off keeps it as null, so a registry rewound past this applies it again without turning it back on.
  `CREATE TABLE IF NOT EXISTS pipeline_items (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
   UPDATE projects SET record = json_set(record, '$.pipeline', json('{"autoStart":true}')) WHERE id = 'nexus' AND json_type(record, '$.pipeline') IS NULL;`,
  // Each failed pylon's judgment, keyed by the thread.failed event of its failure, and the newest event when judgments
  // began, so no failure from before is ever judged. It touches nothing an earlier migration made, so a registry rewound
  // past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS judgments (failure INTEGER PRIMARY KEY, thread TEXT NOT NULL REFERENCES threads (id), record TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS judgment_since (event INTEGER NOT NULL) STRICT;
   INSERT INTO judgment_since SELECT (SELECT coalesce(max(id), 0) FROM events) WHERE NOT EXISTS (SELECT 1 FROM judgment_since);`,
  // Each planning thread's token and what the control plane read from it and told it. It touches nothing an earlier
  // migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS planning_threads (thread TEXT PRIMARY KEY REFERENCES threads (id), record TEXT NOT NULL) STRICT;`,
  // The asks whose AskUserQuestion dialogs each thread's pylon last reported waiting, which open its Claude worker's
  // questions. It touches nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS waiting_asks (thread TEXT PRIMARY KEY REFERENCES threads (id), report TEXT NOT NULL) STRICT;`,
  // The join tokens root on the control plane's machine mints, hashed, and the nodes that joined with one, beside the
  // nodes control.json names. It touches nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS join_tokens (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER, used_by TEXT) STRICT;
   CREATE TABLE IF NOT EXISTS joined_nodes (name TEXT PRIMARY KEY REFERENCES nodes (name), deploy_key TEXT NOT NULL, joined_at INTEGER NOT NULL) STRICT;`,
  // Each deleted thread's conversation the harness aborted, so a start aborts only those a crashed delete left. It
  // touches nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS aborted_conversations (conversation TEXT PRIMARY KEY) STRICT;`,
  // The dashboard and the API list a node's orphans from its observation, so nothing read this table. Dropping it
  // touches nothing an earlier migration needs, so a registry rewound past it applies it again unchanged.
  `DROP TABLE IF EXISTS orphans;`,
  // Who typed each message in claude_messages, and a SHA-256 of its text as typed, so a transcript's prompt reads as
  // Nexus's only when Nexus typed exactly that text. A message recorded before has no row here, so its sender is
  // unknown. It touches nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS claude_senders (thread TEXT NOT NULL, request_id TEXT NOT NULL, sender TEXT NOT NULL, text_sha256 TEXT NOT NULL,
     PRIMARY KEY (thread, request_id)) STRICT;`,
];

type Row = Record<string, unknown>;
/** The tables that keep each record as JSON in a `record` column under one key. */
type RecordTable = "reviews" | "pr_watches" | "nudges" | "planning_threads" | "pipeline_items" | "queued_threads" | "questions" | "judgments";
type RecordKey = "builder" | "thread" | "id" | "failure";
const json = <T>(value: unknown): T => JSON.parse(value as string) as T;
const jsonOrNull = <T>(value: unknown): T | null => value === null ? null : json<T>(value);
function observationOf(value: unknown): NodeObservation | null {
  const o = jsonOrNull<OlderObservation>(value);
  return o === null ? null : upgradeObservation(o);
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

export type Registry = ReturnType<typeof openRegistry>;

/** Opens the file, creating it if needed, and applies any migrations it has not seen. */
export function openRegistry(path: string, clock = Date.now) {
  const db = new DatabaseSync(path);
  // Another process may write the registry, such as a second open of it, so a write waits out its short transaction.
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

  function node(name: NodeName): NodeRecord | undefined {
    const row = sql("SELECT * FROM nodes WHERE name = ?").get(name);
    return row && nodeRow(row);
  }

  function upsertNode(node: Pick<NodeRecord, "name" | "tailnetHost" | "tailnetNodeId">) {
    sql(`INSERT INTO nodes (name, tailnet_host, tailnet_node_id, state) VALUES (?, ?, ?, 'offline')
      ON CONFLICT (name) DO UPDATE SET tailnet_host = excluded.tailnet_host, tailnet_node_id = excluded.tailnet_node_id`).run(node.name, node.tailnetHost, node.tailnetNodeId);
  }

  function project(id: ProjectId): Project | undefined {
    const row = sql("SELECT record FROM projects WHERE id = ?").get(id);
    return row && json<Project>(row.record);
  }

  const pylonsOn = (node: NodeName) => sql("SELECT * FROM pylons WHERE node = ? ORDER BY id").all(node).map(pylonRow);

  const sessions = (pylon: PylonId) => sql("SELECT * FROM sessions WHERE pylon = ? ORDER BY id").all(pylon).map(sessionRow);

  function image(id: ImageId): RecordedImage | undefined {
    const row = sql("SELECT manifest FROM images WHERE id = ?").get(id);
    return row && recordedImage(row);
  }

  /** The highest journal sequence applied from the node, or null before its first. */
  function eventReceipt(node: NodeName): number | null {
    const receipt = sql("SELECT sequence FROM event_receipts WHERE node = ?").get(node);
    return receipt === undefined ? null : Number(receipt.sequence);
  }

  const setting = (key: string): string | null => (sql("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null) as string | null;
  const setSetting = (key: string, value: string) => sql("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);

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

  /** The table and key column are SQL, so they come only from this code, never from input. */
  function recordOf<T>(table: RecordTable, keyColumn: RecordKey, key: string | number): T | null {
    return jsonOrNull<T>(sql(`SELECT record FROM ${table} WHERE ${keyColumn} = ?`).get(key)?.record ?? null);
  }

  function saveRecord(table: RecordTable, keyColumn: RecordKey, key: string | number, record: unknown) {
    sql(`INSERT INTO ${table} (${keyColumn}, record) VALUES (?, ?) ON CONFLICT (${keyColumn}) DO UPDATE SET record = excluded.record`).run(key, JSON.stringify(record));
  }

  const queuedThread = (id: ThreadId): QueuedRecord | undefined => recordOf<QueuedRecord>("queued_threads", "id", id) ?? undefined;
  const storedReviewOf = (builder: ThreadId): Review | null => {
    const record = recordOf<Review>("reviews", "builder", builder);
    return record === null ? null : storedReview(record);
  };
  const isCurrentReview = (review: Review) => JSON.stringify(storedReviewOf(review.builder)) === JSON.stringify(review);

  function saveQueued(record: QueuedRecord, key?: StartKey) {
    transaction(() => {
      saveRecord("queued_threads", "id", record.id, record);
      if (key !== undefined) saveStartKey(key, record.id);
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
    const reading = sql("SELECT thread FROM usage_backfill WHERE state = 'running' AND phase = 'reading'").get()?.thread;
    const limits = usageLimits(rows.map((r) => r.id as ThreadId).filter((id) => !live.has(id)));
    return rows.map((row): Thread => {
      const thread = threadRow(row);
      const working = (live.get(thread.id)?.at ?? null) as number | null;
      const wait = waiting.get(thread.id);
      const starts = [thread.agentTurnRunning ? row.agent_turn_started_at : null, live.get(thread.id)?.since].filter((at): at is number => typeof at === "number");
      const usageLimit = limits.get(thread.id);
      return {
        ...thread, working: thread.agentTurnRunning || working !== null,
        ...(working === null ? {} : { sessionTurnRunning: true, sessionActiveUntil: working + sessionActivityTtlMs }), ...(wait === undefined ? {} : { sessionWaiting: true }),
        ...(typeof wait?.message === "string" ? { sessionWaitingMessage: wait.message } : {}),
        ...(starts.length === 0 ? {} : { workingSince: Math.min(...starts) }), ...(usageLimit === undefined ? {} : { usageLimit }),
        ...(reading === thread.id ? { readingUsage: true } : {}),
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

  function questionRecord(id: string): Question | null {
    return recordOf<Question>("questions", "id", id);
  }

  function waitingAsks(thread: ThreadId): WaitingAsk[] {
    return jsonOrNull<WaitingAsk[]>(sql("SELECT report FROM waiting_asks WHERE thread = ?").get(thread)?.report ?? null) ?? [];
  }

  /**
   * Asks a question for each ask the thread's pylon last reported waiting for its Claude worker's current session, and
   * withdraws each unanswered ask that is not one. The transcript only closes one, once it holds the call's result,
   * since Claude may write the call itself only once the dialog is answered. Other sessions' asks, such as the
   * person's own Claude's in the pylon, ask nothing. Answers whether it asked or withdrew any.
   */
  function reconcileAsks(thread: ThreadId): boolean {
    const session = sql("SELECT session FROM claude_workers WHERE thread = ?").get(thread)?.session;
    const answered = sql("SELECT 1 FROM claude_entries WHERE thread = ? AND json_extract(entry, '$.kind') = 'result' AND json_extract(entry, '$.toolUseId') = ?");
    const open = waitingAsks(thread).filter(({ ask }) => ask.session === session && answered.get(thread, ask.toolUseId) === undefined).map(({ ask, at }) => askRecord(thread, ask, at));
    let changes = 0;
    for (const question of open) {
      changes += Number(sql("INSERT OR IGNORE INTO questions (id, thread, record) VALUES (?, ?, ?)").run(question.id, thread, JSON.stringify({ ...question, answer: null })).changes);
    }
    changes += Number(sql(`DELETE FROM questions WHERE thread = ? AND json_extract(record, '$.ask') IS NOT NULL AND json_extract(record, '$.answer') IS NULL
      AND id NOT IN (SELECT value FROM json_each(?))`).run(thread, JSON.stringify(open.map((q) => q.id))).changes);
    return changes > 0;
  }

  function updateAttention(id: ThreadId) {
    const t = thread(id);
    if (t === undefined) return;
    const old = sql("SELECT * FROM thread_attention WHERE thread = ?").get(id);
    const p = pylon(t.pylonId);
    const workerFailed = ["failed", "stalled"].includes(String(sql("SELECT state FROM claude_workers WHERE thread = ?").get(id)?.state));
    const decision = needsPerson(recordOf<Review>("reviews", "builder", id))
      || sql("SELECT 1 FROM questions WHERE thread = ? AND json_extract(record, '$.answer') IS NULL").get(id) !== undefined
      || recordOf<Nudge>("nudges", "thread", id)?.state === "person";
    const attention = attentionOf(p?.failed != null || workerFailed, old?.parked === 1, t.lastReplyAt, t.seenAt, t.working, t.sessionWaiting, decision, t.usageLimit !== undefined);
    if ((old?.attention ?? null) === attention) return;
    sql("INSERT INTO thread_attention (thread, attention) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET attention = excluded.attention").run(id, attention);
    appendEvent("attention.changed", id, { attention });
  }

  function setThreadStatus(id: ThreadId, status: ThreadStatus) {
    transaction(() => {
      sql("UPDATE threads SET status = ? WHERE id = ?").run(status, id);
      if (status === "archived" || status === "deleted") {
        // The thread's pylon pauses, so no turn of it runs and no dialog waits.
        for (const table of ["session_activity", "waiting_asks"]) sql(`DELETE FROM ${table} WHERE thread = ?`).run(id);
      }
      if (status === "deleted") {
        // The delete aborts the run, so nothing is left to retry, and the harness stops tracking the thread without a report.
        sql("UPDATE thread_attention SET parked = 0 WHERE thread = ?").run(id);
        for (const table of ["session_order", "session_order_floor", "claude_transcripts", "claude_entries", "claude_messages", "claude_senders"]) sql(`DELETE FROM ${table} WHERE thread = ?`).run(id);
      }
      reconcileAsks(id);
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

  pruneSessions();
  // A release that computes attention differently, or a thread from before attention was stored, is right from the start.
  // A thread deleted before deletes cleared the parked flag kept it, and the harness no longer tracks it to report.
  transaction(() => {
    sql("UPDATE thread_attention SET parked = 0 WHERE thread IN (SELECT id FROM threads WHERE status = 'deleted')").run();
    for (const { id } of sql("SELECT id FROM threads").all()) updateAttention(id as ThreadId);
  });

  /**
   * Each breakdown's grouping, and its order: biggest first, or newest day first. A report over threads reads the
   * calls, and any other the sums per day, which stay few however many calls there are.
   */
  const groupings: Readonly<Record<Breakdown, { key: string; order: string }>> = {
    model: { key: "model", order: "total DESC, key" },
    project: { key: "project", order: "total DESC, key" },
    kind: { key: "agent", order: "total DESC, key" },
    role: { key: "role", order: "total DESC, key" },
    day: { key: "day", order: "key DESC" },
  };
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  const totalsOf = (r: Row): UsageTotals => {
    const [input, output, cacheWrite, cacheRead] = [r.input, r.output, r.cache_write, r.cache_read] as number[];
    return { input: input!, output: output!, cacheWrite: cacheWrite!, cacheRead: cacheRead!, total: input! + output! + cacheWrite! + cacheRead!, calls: r.calls as number };
  };
  function usageBackfillThreads(): BackfillThread[] {
    return sql("SELECT b.*, t.title FROM usage_backfill_threads b JOIN threads t ON t.id = b.thread ORDER BY t.created_at, t.id").all().map((r) => ({
      thread: r.thread as ThreadId, title: r.title as string, state: r.state as BackfillThread["state"], reason: r.reason as string | null,
      calls: r.calls as number, tokens: r.tokens as number, at: r.at as number | null,
    }));
  }

  function usageBackfill(): UsageBackfill {
    const run = sql("SELECT * FROM usage_backfill").get();
    if (run === undefined) return { state: "never" };
    const count = sql("SELECT count(*) AS of, coalesce(sum(state <> 'pending'), 0) AS read, coalesce(sum(calls), 0) AS calls, coalesce(sum(tokens), 0) AS tokens FROM usage_backfill_threads").get()!;
    return {
      state: run.state as "running" | "stopped" | "done", startedAt: run.started_at as number, finishedAt: run.finished_at as number | null,
      current: run.thread === null ? null : { thread: run.thread as ThreadId, phase: run.phase as "reading" | "pausing", since: run.since as number },
      waiting: run.waiting as string | null, read: count.read as number, of: count.of as number,
      recovered: { calls: count.calls as number, tokens: count.tokens as number }, skipped: usageBackfillThreads().filter((t) => t.state === "skipped"),
    };
  }

  function endUsageBackfill(state: "stopped" | "done", now: number) {
    sql("UPDATE usage_backfill SET state = ?, finished_at = ?, thread = NULL, phase = NULL, since = NULL, waiting = NULL WHERE state = 'running'").run(state, now);
  }

  const sums = (calls: string) => `coalesce(sum(input), 0) AS input, coalesce(sum(output), 0) AS output, coalesce(sum(cache_write), 0) AS cache_write,
    coalesce(sum(cache_read), 0) AS cache_read, ${calls} AS calls, coalesce(sum(input + output + cache_write + cache_read), 0) AS total`;

  return {
    close() { db.close(); },
    /**
     * Records each call under the thread it was read from, with the thread's project and role, and moves each cursor
     * to where its read ended. A call recorded before keeps its thread and time, and each count the larger of the two
     * reads, since every record of one call carries the same usage. Returns how many calls were new, and the tokens
     * the recorded counts grew by. `backfill` adds them to the thread's usage backfill row in the same transaction.
     */
    recordUsage(thread: ThreadId, calls: readonly AgentCall[], cursors: readonly UsageCursor[] = [], backfill = false): { calls: number; tokens: number } {
      const t = threadRecord(thread);
      if (t === undefined) throw new Error(`no thread ${thread} to record usage under`);
      const role = roleOf(t.started_by as string);
      const added = { calls: 0, tokens: 0 };
      transaction(() => {
        for (const c of calls) {
          const stored = sql("SELECT * FROM usage_records WHERE id = ?").get(c.id);
          // Another thread's read of a call, as of a session copied into its pylon, changes nothing.
          if (stored !== undefined && stored.thread !== thread) continue;
          const was = stored === undefined ? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } : totalsOf({ ...stored, calls: 1 });
          const now = { input: Math.max(was.input, c.input), output: Math.max(was.output, c.output), cacheWrite: Math.max(was.cacheWrite, c.cacheWrite), cacheRead: Math.max(was.cacheRead, c.cacheRead) };
          const at = (stored?.at as number | undefined) ?? c.at;
          const key = stored === undefined ? [thread, t.project as string, role, c.agent, c.model] : [thread, stored.project, stored.role, stored.agent, stored.model] as string[];
          sql("INSERT OR REPLACE INTO usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(c.id, ...key, at, now.input, now.output, now.cacheWrite, now.cacheRead);
          sql(`INSERT INTO usage_days VALUES ($day, $project, $role, $agent, $model, $input, $output, $cacheWrite, $cacheRead, $calls)
            ON CONFLICT DO UPDATE SET input = input + $input, output = output + $output, cache_write = cache_write + $cacheWrite, cache_read = cache_read + $cacheRead, calls = calls + $calls`).run({
            $day: day(at), $project: key[1]!, $role: key[2]!, $agent: key[3]!, $model: key[4]!, $calls: stored === undefined ? 1 : 0,
            $input: now.input - was.input, $output: now.output - was.output, $cacheWrite: now.cacheWrite - was.cacheWrite, $cacheRead: now.cacheRead - was.cacheRead,
          });
          if (stored === undefined) added.calls++;
          added.tokens += now.input - was.input + now.output - was.output + now.cacheWrite - was.cacheWrite + now.cacheRead - was.cacheRead;
        }
        for (const { source, key, position, before } of cursors) {
          sql("INSERT INTO usage_cursors VALUES (?, ?, ?, ?) ON CONFLICT (source, key) DO UPDATE SET position = excluded.position, before = excluded.before").run(source, key, position, before);
        }
        if (backfill) sql("UPDATE usage_backfill_threads SET calls = calls + ?, tokens = tokens + ? WHERE thread = ?").run(added.calls, added.tokens, thread);
      });
      return added;
    },
    /** Where each of the source's files or conversations was last read to. */
    usageCursor(source: string, key: string): UsageCursor | undefined {
      const r = sql("SELECT * FROM usage_cursors WHERE source = ? AND key = ?").get(source, key);
      return r && { source, key, position: r.position as number, before: r.before as string };
    },
    usageCursors: (source: string): Map<string, UsageCursor> =>
      new Map(sql("SELECT * FROM usage_cursors WHERE source = ?").all(source).map((r) => [r.key as string, { source, key: r.key as string, position: r.position as number, before: r.before as string }])),
    /** `since` is a UTC day's start, or null for all. */
    usageReport(filter: { since: number | null; project?: ProjectId | null; thread?: ThreadId | null; by?: readonly Breakdown[] }): UsageReport {
      const params = { $since: filter.since === null ? null : day(filter.since), $project: filter.project ?? null, $thread: filter.thread ?? null };
      const [from, calls, dayOf] = params.$thread === null ? ["usage_days", "coalesce(sum(calls), 0)", "day"] : ["usage_records", "count(*)", "date(at / 1000, 'unixepoch')"];
      const where = `WHERE ($since IS NULL OR ${dayOf} >= $since) AND ($project IS NULL OR project = $project)${params.$thread === null ? " AND $thread IS NULL" : " AND thread = $thread"}`;
      const by: UsageReport["by"] = {};
      for (const breakdown of filter.by ?? []) {
        const { key, order } = groupings[breakdown];
        by[breakdown] = sql(`SELECT ${key === "day" ? dayOf : key} AS key, ${sums(calls)} FROM ${from} ${where} GROUP BY 1 ORDER BY ${order}`)
          .all(params).map((r) => ({ key: r.key as string, ...totalsOf(r) }));
      }
      return {
        since: filter.since, countingSince: sql("SELECT at FROM usage_since").get()!.at as number, project: params.$project, thread: params.$thread,
        total: totalsOf(sql(`SELECT ${sums(calls)} FROM ${from} ${where}`).get(params)!), by, backfill: usageBackfill(),
      };
    },
    usageBackfill,
    /** Every thread a run of the backfill listed, oldest thread first. */
    usageBackfillThreads,
    /**
     * Starts a run that reads `threads`, unless one runs. Each listed thread with no row gets a pending one, and a
     * skipped one is pending again. A done thread is never read again.
     */
    startUsageBackfill(threads: readonly ThreadId[], now: number): UsageBackfill {
      transaction(() => {
        if (sql("SELECT state FROM usage_backfill").get()?.state === "running") return;
        for (const thread of threads) {
          sql(`INSERT INTO usage_backfill_threads (thread, state, calls, tokens) VALUES (?, 'pending', 0, 0)
            ON CONFLICT (thread) DO UPDATE SET state = 'pending', reason = NULL, at = NULL WHERE state = 'skipped'`).run(thread);
        }
        sql(`INSERT INTO usage_backfill (id, state, started_at) VALUES (1, 'running', ?) ON CONFLICT (id) DO UPDATE SET state = 'running',
          started_at = excluded.started_at, finished_at = NULL, thread = NULL, phase = NULL, since = NULL, waiting = NULL`).run(now);
      });
      return usageBackfill();
    },
    /** A running run stops, and lets go of its pylon, whose desired phase is then paused again. */
    stopUsageBackfill(now: number): UsageBackfill {
      endUsageBackfill("stopped", now);
      return usageBackfill();
    },
    /** A running run has read every thread it listed. */
    finishUsageBackfill(now: number) { endUsageBackfill("done", now); },
    /** Why a running run waits before its next pylon, or null when it does not. */
    waitUsageBackfill(waiting: string | null) {
      sql("UPDATE usage_backfill SET waiting = ? WHERE state = 'running' AND waiting IS NOT ?").run(waiting, waiting);
    },
    /** A running run holds the thread's pylon, which it wants woken to read. */
    holdUsageBackfill(thread: ThreadId, now: number) {
      sql("UPDATE usage_backfill SET thread = ?, phase = 'reading', since = ?, waiting = NULL WHERE state = 'running'").run(thread, now);
    },
    /** The run lets go of the pylon it holds, once it is paused. */
    releaseUsageBackfill() {
      sql("UPDATE usage_backfill SET thread = NULL, phase = NULL, since = NULL").run();
    },
    /**
     * The thread was read, or skipped for `reason`, and keeps what its reads recovered. A run that holds its pylon now
     * waits for its pause.
     */
    finishUsageBackfillThread(thread: ThreadId, state: "done" | "skipped", reason: string | null, now: number) {
      transaction(() => {
        sql("UPDATE usage_backfill_threads SET state = ?, reason = ?, at = ? WHERE thread = ?").run(state, reason, now, thread);
        sql("UPDATE usage_backfill SET phase = 'pausing', since = ? WHERE state = 'running' AND thread = ?").run(now, thread);
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
        reconcileAsks(thread);
        updateAttention(thread);
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
    setClaudeWorker(thread: ThreadId, prompt: string, state: string, message?: string, session?: string) {
      transaction(() => {
        sql("INSERT INTO claude_workers (thread, prompt, state, message, session, model) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread) DO UPDATE SET state = excluded.state, message = excluded.message, session = coalesce(excluded.session, claude_workers.session)").run(thread, prompt, state, message ?? null, session ?? null, defaultClaudeModel);
        reconcileAsks(thread);
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
    review: storedReviewOf,
    /** Whether `review` is the builder's review as stored, so no other save came since it was read. */
    isCurrentReview,
    reviews: (): Review[] => sql("SELECT record FROM reviews ORDER BY builder").all().map((r) => storedReview(json<Review>(r.record))),
    /** The reviews but those whose phase is one of `settled` with no message left to send. */
    reviewsToStep: (settled: readonly string[]): Review[] => sql(`SELECT record FROM reviews WHERE json_extract(record, '$.phase.kind') NOT IN (SELECT value FROM json_each(?))
      OR json_extract(record, '$.outbox') IS NOT NULL ORDER BY builder`).all(JSON.stringify(settled)).map((r) => storedReview(json<Review>(r.record))),
    /** A thread a review started, whether or not a later review replaced the record that names it. */
    isReviewer: (thread: ThreadId) => sql("SELECT 1 FROM threads WHERE id = ? AND started_by = ? UNION SELECT 1 FROM reviews WHERE reviewer = ?").get(thread, reviewerCaller, thread) !== undefined,
    /** Whether a review ever started for the pull request, including one a later review of its builder replaced. */
    prReviewed: (repo: string, number: number) => sql("SELECT 1 FROM reviewed_prs WHERE repo = ? AND number = ?").get(repo, number) !== undefined,
    /**
     * Replaces the builder's review, and tells the event log when its phase, round or label changed, or the person waived
     * holds. The threads in `archive` are archived in the same transaction. Given `previous`, the review as it was read,
     * false, with nothing written, when the stored review is no longer that: another save came first.
     */
    saveReview(review: Review, archive: readonly ThreadId[] = [], previous?: Review): boolean {
      return transaction(() => {
        if (previous !== undefined && !isCurrentReview(previous)) return false;
        const before = storedReviewOf(review.builder);
        for (const id of archive) setThreadStatus(id, "archived");
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
        return true;
      });
    },
    /** Stores the question unless one with its ID exists, and answers the stored one either way. */
    askQuestion(question: Omit<Question, "answer">): Question {
      return transaction(() => {
        sql("INSERT OR IGNORE INTO questions (id, thread, record) VALUES (?, ?, ?)").run(question.id, question.thread, JSON.stringify({ ...question, answer: null }));
        updateAttention(question.thread);
        return questionRecord(question.id)!;
      });
    },
    question: (id: string): Question | null => questionRecord(id),
    /**
     * Stores the asks the thread's pylon reports waiting, in place of its last report, and asks or withdraws its Claude
     * worker's questions to match. An archived or deleted thread's pylon is paused, so its report is dropped. Answers
     * whether a question was asked or withdrawn.
     */
    setWaitingAsks(thread: ThreadId, asks: readonly WaitingAsk[]): boolean {
      return transaction(() => {
        const status = threadStatus(thread);
        if (status === undefined || status === "archived" || status === "deleted") return false;
        sql("INSERT INTO waiting_asks (thread, report) VALUES (?, ?) ON CONFLICT (thread) DO UPDATE SET report = excluded.report").run(thread, JSON.stringify(asks));
        const changed = reconcileAsks(thread);
        updateAttention(thread);
        return changed;
      });
    },
    /**
     * Withdraws an ask whose dialog no hook waits on any more, such as one its terminal answered, and drops it from the
     * stored report, so nothing before the pylon's next report asks it again. An answered one stays.
     */
    withdrawAsk(id: string) {
      transaction(() => {
        const thread = sql("SELECT thread FROM questions WHERE id = ?").get(id)?.thread as ThreadId | undefined;
        if (thread === undefined) return;
        const report = waitingAsks(thread).filter(({ ask }) => askQuestionId(ask.toolUseId) !== id);
        sql("UPDATE waiting_asks SET report = ? WHERE thread = ?").run(JSON.stringify(report), thread);
        reconcileAsks(thread);
        updateAttention(thread);
      });
    },
    questions: (thread: ThreadId): Question[] => sql("SELECT record FROM questions WHERE thread = ? ORDER BY json_extract(record, '$.askedAt'), id").all(thread).map((r) => json<Question>(r.record)),
    /**
     * Records the answer to an open question. An answered one keeps its first answer, which this returns. `then` runs
     * in the same transaction once the answer is recorded, and a throw from it records nothing.
     */
    answerQuestion(id: string, answer: NonNullable<Question["answer"]>, then?: (answered: Question) => void): Question {
      return transaction(() => {
        const stored = questionRecord(id);
        if (stored === null) throw new Error(`no question ${id}`);
        if (stored.answer !== null) return stored;
        const answered = { ...stored, answer };
        sql("UPDATE questions SET record = ? WHERE id = ?").run(JSON.stringify(answered), id);
        then?.(answered);
        updateAttention(stored.thread);
        return answered;
      });
    },
    planning: (thread: ThreadId): PlanningRecord | null => recordOf<PlanningRecord>("planning_threads", "thread", thread),
    planningThreads: (): PlanningRecord[] => sql("SELECT record FROM planning_threads ORDER BY rowid").all().map((r) => json<PlanningRecord>(r.record)),
    savePlanning(record: PlanningRecord) {
      saveRecord("planning_threads", "thread", record.thread, record);
    },
    prWatch: (thread: ThreadId): PrWatchState | null => recordOf<PrWatchState>("pr_watches", "thread", thread),
    /**
     * Replaces the thread's PR watch, and tells the event log of new feedback, of each PR linked since the last save, and
     * of an error that starts or clears.
     */
    savePrWatch(thread: ThreadId, state: PrWatchState) {
      transaction(() => {
        const previous = recordOf<PrWatchState>("pr_watches", "thread", thread);
        if (state.pending !== null && previous?.pending?.id !== state.pending.id) appendEvent("pull-request.feedback", thread, { requestId: state.pending.id });
        // A link counts once the watch has read its PR, as outputs() counts it, so a placeholder never fires.
        const linked = new Set(previous?.links.filter((l) => l.pr.url !== "").map((l) => `${l.pr.repo}#${l.pr.number}`));
        for (const { pr } of state.links) {
          if (pr.url !== "" && !linked.has(`${pr.repo}#${pr.number}`)) appendEvent("pull-request.linked", thread, { repo: pr.repo, number: pr.number, url: pr.url, title: pr.title, state: pr.state });
        }
        if ((previous?.error ?? null) === null && state.error !== null) appendEvent("pull-request.error", thread, { error: state.error });
        if ((previous?.error ?? null) !== null && state.error === null) appendEvent("pull-request.error-cleared", thread, {});
        saveRecord("pr_watches", "thread", thread, state);
      });
    },
    judgment: (failure: number): Judgment | null => recordOf<Judgment>("judgments", "failure", failure),
    /** The thread's judgments, oldest failure first. */
    judgments: (thread: ThreadId): Judgment[] => sql("SELECT record FROM judgments WHERE thread = ? ORDER BY failure").all(thread).map((r) => json<Judgment>(r.record)),
    /** Every judgment not done, whatever its thread's status, oldest failure first. */
    unfinishedJudgments: (): Judgment[] => sql("SELECT record FROM judgments WHERE json_extract(record, '$.phase.kind') != 'done' ORDER BY failure").all().map((r) => json<Judgment>(r.record)),
    /**
     * Replaces the judgment as it was read, `previous`, or adds it when that is null, and runs `alongside` in the same
     * transaction. False, with nothing written or run, when the stored record is not `previous`: another pass saved first.
     */
    saveJudgment(next: Judgment, previous: Judgment | null, alongside: () => void = () => {}): boolean {
      return transaction(() => {
        const { changes } = previous === null
          ? sql("INSERT INTO judgments (failure, thread, record) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(next.failure, next.thread, JSON.stringify(next))
          : sql("UPDATE judgments SET record = ? WHERE failure = ? AND record = ?").run(JSON.stringify(next), next.failure, JSON.stringify(previous));
        if (changes === 1) alongside();
        return changes === 1;
      });
    },
    /** The newest event when judgments began. No failure at or below it is judged. */
    judgmentSince: (): number => sql("SELECT event FROM judgment_since").get()!.event as number,
    /**
     * The failure the thread's pylon holds: the thread.failed event its pylon's `failed` appended. Null while the pylon
     * has not failed, or once that event is pruned. A failed Claude launch appends one too, with another message.
     */
    failure(thread: ThreadId): { event: number; at: number } | null {
      const row = sql(`SELECT e.id, e.time FROM pylons p JOIN events e ON e.thread = p.thread AND e.kind = 'thread.failed' AND json_extract(e.payload, '$.message') = p.failed
        WHERE p.thread = ? ORDER BY e.id DESC LIMIT 1`).get(thread);
      return row === undefined ? null : { event: row.id as number, at: row.time as number };
    },
    nudge: (thread: ThreadId): Nudge | null => recordOf<Nudge>("nudges", "thread", thread),
    /** The threads with a nudge record that a later pass may still change or clear, which is every one but left-alone. */
    nudgedThreads: (): ThreadId[] => sql("SELECT thread FROM nudges WHERE json_extract(record, '$.state') != 'left-alone' ORDER BY thread").all().map((r) => r.thread as ThreadId),
    /** Replaces the builder's nudge record, or with null deletes it. */
    saveNudge(thread: ThreadId, nudge: Nudge | null) {
      transaction(() => {
        if (nudge === null) sql("DELETE FROM nudges WHERE thread = ?").run(thread);
        else saveRecord("nudges", "thread", thread, nudge);
        updateAttention(thread);
      });
    },
    desiredRelease: (): DesiredRelease | null => jsonOrNull<DesiredRelease>(setting("release")),
    setDesiredRelease(release: DesiredRelease) {
      appendEvent("release.changed", null, { desired: release });
      setSetting("release", JSON.stringify(release));
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
    drain: (): Drain | null => jsonOrNull<Drain>(setting("deploy-drain")),
    /** Null is stored as the JSON text null, which reads back as null. */
    setDrain(drain: Drain | null) { setSetting("deploy-drain", JSON.stringify(drain)); },

    /** Nodes come from the config file or a join. Their state and capacity come from observations. */
    upsertNode,
    nodes: () => (sql("SELECT * FROM nodes ORDER BY name").all() as Row[]).map(nodeRow),
    node,
    /** Each node's tailnet node ID, without reading its observation. */
    nodeIds: (): Map<NodeName, TailnetNodeId> => new Map(sql("SELECT name, tailnet_node_id FROM nodes").all().map((r) => [r.name as NodeName, r.tailnet_node_id as TailnetNodeId])),
    /** The node with this tailnet ID and the deploy key it joined with, null for a configured node, without reading its observation. */
    nodeByTailnetId(id: TailnetNodeId): { name: NodeName; deployKey: string | null } | undefined {
      const row = sql("SELECT name, deploy_key FROM nodes LEFT JOIN joined_nodes USING (name) WHERE tailnet_node_id = ?").get(id);
      return row === undefined ? undefined : { name: row.name as NodeName, deployKey: row.deploy_key as string | null };
    },
    /** The loop marks a node offline when its observe link stays down. Every other node fact comes through apply. */
    markOffline(name: NodeName) { sql("UPDATE nodes SET state = ? WHERE name = ?").run("offline", name); },
    addJoinToken(hash: string, expiresAt: number) { sql("INSERT INTO join_tokens (hash, expires_at) VALUES (?, ?)").run(hash, expiresAt); },
    joinToken(hash: string): { expiresAt: number; usedAt: number | null } | undefined {
      const row = sql("SELECT expires_at, used_at FROM join_tokens WHERE hash = ?").get(hash);
      return row === undefined ? undefined : { expiresAt: row.expires_at as number, usedAt: row.used_at as number | null };
    },
    /** Records the node and uses up its token, or does neither when the token was used or expired meanwhile. */
    joinNode(hash: string, node: Omit<JoinedNode, "joinedAt">, at: number): boolean {
      return transaction(() => {
        if (sql("UPDATE join_tokens SET used_at = ?, used_by = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?").run(at, node.tailnetNodeId, hash, at).changes === 0) return false;
        upsertNode(node);
        sql("INSERT INTO joined_nodes VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET deploy_key = excluded.deploy_key, joined_at = excluded.joined_at").run(node.name, node.deployKey, at);
        return true;
      });
    },
    joinedNodes: (): JoinedNode[] => sql("SELECT nodes.*, deploy_key, joined_at FROM joined_nodes JOIN nodes USING (name) ORDER BY name").all().map((r) => ({
      name: r.name as NodeName, tailnetHost: r.tailnet_host as string, tailnetNodeId: r.tailnet_node_id as TailnetNodeId, deployKey: r.deploy_key as string, joinedAt: r.joined_at as number,
    })),

    editProject(id: ProjectId, edit: (stored: Project) => Project): Project | undefined {
      return transaction(() => {
        const stored = project(id);
        if (stored === undefined) return undefined;
        const edited = edit(stored);
        sql("UPDATE projects SET record = ? WHERE id = ?").run(JSON.stringify(edited), id);
        return edited;
      });
    },
    updateProject(project: Project) { sql("UPDATE projects SET record = ? WHERE id = ?").run(JSON.stringify(project), project.id); },
    createProject(project: Project) { sql("INSERT INTO projects (id, record) VALUES (?, ?)").run(project.id, JSON.stringify(project)); },
    projects: () => (sql("SELECT record FROM projects ORDER BY id").all() as Row[]).map((r) => json<Project>(r.record)),
    project,

    /**
     * A thread and its pylon are created together, because a thread always has exactly one pylon. A `queued` thread's
     * queue record is marked started in the same transaction, so a queued thread starts at most once, and so is a
     * start's `key`, so a repeat of its request ID finds the thread.
     */
    createThread(thread: Omit<Thread, "seenAt" | "lastReplyAt">, pylon: Omit<PylonRecord, "desired">, claudePrompt?: string, model = defaultClaudeModel, queued = false, key?: StartKey) {
      if (pylon.pylonId !== thread.pylonId || pylon.thread !== thread.id) throw new Error(`pylon ${pylon.pylonId} does not belong to thread ${thread.id}`);
      transaction(() => {
        if (queued) {
          const record = queuedThread(thread.id);
          if (record === undefined || record.status !== "queued") throw new Error(`thread ${thread.id} is no longer queued`);
          saveQueued({ ...record, status: "started", startedAt: thread.createdAt, lastError: null, firstMessage: record.message === null ? null : "pending" });
        }
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
    items: (): ItemRecord[] => sql("SELECT record FROM pipeline_items ORDER BY rowid").all().map((r) => json<ItemRecord>(r.record)),
    item: (id: ItemId): ItemRecord | undefined => recordOf<ItemRecord>("pipeline_items", "id", id) ?? undefined,
    saveItem(record: ItemRecord) { saveRecord("pipeline_items", "id", record.id, record); },
    queuedThreads: (): QueuedRecord[] => sql("SELECT record FROM queued_threads ORDER BY rowid").all().map((r) => json<QueuedRecord>(r.record)),
    queuedThread,
    saveQueued,
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
      const watch = recordOf<PrWatchState>("pr_watches", "thread", thread);
      return [
        ...(sql("SELECT * FROM outputs WHERE thread = ? ORDER BY kind, ref").all(thread) as Row[]).map((r): Output => ({ thread, kind: r.kind as Output["kind"], ref: r.ref as string })),
        ...(watch ? watch.links.filter((l) => l.pr.url !== "").map((l): Output => ({ thread, kind: "pull-request", ref: l.pr.url })) : []),
      ];
    },

    /** The latest job the node reported for a pylon or an artifact. */
    job(subject: Subject): JobStatus | undefined {
      const row = sql("SELECT status FROM jobs WHERE subject = ?").get(subject) as Row | undefined;
      return row && json<JobStatus>(row.status);
    },

    /** Kept in the manifest column, so a control plane older than `release` still reads the row. */
    saveImage(manifest: ImageManifest, release: string | null) { sql("INSERT INTO images (id, manifest) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET manifest = excluded.manifest").run(manifest.id, JSON.stringify({ ...manifest, release })); },
    image,
    images: () => (sql("SELECT manifest FROM images ORDER BY id").all() as Row[]).map(recordedImage),
    /** The image every new pylon boots. Only a recorded image can become current, and the one it replaces becomes the previous image. */
    setCurrentImage(id: ImageId) {
      transaction(() => {
        if (image(id) === undefined) throw new Error(`no image ${id} is recorded`);
        const current = setting("current");
        if (current !== null && current !== id) setSetting("previous-image", current);
        setSetting("current", id);
      });
    },
    currentImage: (): ImageId | null => setting("current") as ImageId | null,
    previousImage: (): ImageId | null => setting("previous-image") as ImageId | null,
    /** The latest image build or rollout. One runs at a time, and it stays readable once it has finished. */
    imageOperation: (): ImageOperation | null => jsonOrNull<ImageOperation>(setting("image-operation")),
    saveImageOperation(operation: ImageOperation) { setSetting("image-operation", JSON.stringify(operation)); },

    saveTemplate(template: TemplateRecord) { sql("INSERT INTO templates (id, project, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record").run(template.id, template.key.project, JSON.stringify(template)); },
    templates: (project: ProjectId) => (sql("SELECT record FROM templates WHERE project = ? ORDER BY id").all(project) as Row[]).map((r) => json<TemplateRecord>(r.record)),
    /** The builds the node's loop pass moves along, in every project. */
    buildingTemplates: (node: NodeName) => (sql("SELECT record FROM templates WHERE json_extract(record, '$.state') = 'building' AND json_extract(record, '$.on') = ? ORDER BY id").all(node) as Row[]).map((r) => json<BuildingTemplate>(r.record)),
    deleteTemplate(id: TemplateId) { sql("DELETE FROM templates WHERE id = ?").run(id); },

    /**
     * Stores the node's new observation together with the writes ingest derived from it. One transaction,
     * because ingest diffs the next event against this observation: a crash between the two would lose the writes.
     * The observation is null when the event left it as it was.
     */
    ingested(observation: NodeObservation | null, writes: readonly RegistryWrite[]) {
      if (observation === null && writes.length === 0) return;
      transaction(() => {
        if (observation !== null) sql("UPDATE nodes SET observation = ? WHERE name = ?").run(JSON.stringify(observation), observation.node);
        for (const write of writes) apply(write);
      });
    },
    apply,
  };

  /** Folds one of ingest's writes into the records. Each is an upsert, so applying it twice changes nothing. */
  function apply(write: RegistryWrite) {
    switch (write.record) {
      case "node":
        sql("UPDATE nodes SET state = ?, capacity = ? WHERE name = ?").run(write.state, JSON.stringify(write.capacity), write.node);
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
