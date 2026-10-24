/**
 * The registry: every Nexus record, in one SQLite file. The control plane process is its only writer, and
 * it holds one connection, so every write is a synchronous statement and no two writes interleave.
 *
 * Nested values (a project's hosts, a pylon's boot inputs, an observation) are stored as JSON columns. Only
 * the control plane reads them, always whole, so they need no columns of their own.
 */
import { DatabaseSync } from "node:sqlite";
import type { ActivityFacts, RegistryWrite, ThreadStatus } from "../reconcile.ts";
import type { JobStatus, NodeName, NodeObservation, PylonId, SessionFact, Subject, TailnetNodeId } from "../protocol.ts";
import type { Project, ProjectId } from "../project.ts";
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
  id: ThreadId;
  title: string;
  project: ProjectId;
  pylonId: PylonId;
  conversationId: string | null; // set once pi-durable runs the thread's agent
  startedBy: string;
  createdAt: number;
}

/** What the registry keeps of a pylon. The desired phase is derived from its thread on every tick. */
export type StoredPylon = Omit<PylonRecord, "desired">;

export type Session = SessionFact & { pylon: PylonId };
/** `url` is what the data model calls a preview's URL, on its node's tailnet name. */
export interface Preview { pylon: PylonId; service: string; httpsPort: number; ready: boolean; url: string }
/** The https ports a node's previews are published on, both ends included. */
export interface PortRange { first: number; last: number }
export interface Output { thread: ThreadId; kind: Extract<RegistryWrite, { record: "output" }>["kind"]; ref: string }
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
  };
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
export function openRegistry(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);

  const transaction = <T>(body: () => T): T => inTransaction(db, body);

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
    retryPylon: db.prepare(`UPDATE pylons SET failed = NULL, attempts = '{"count":0,"last":null}', retrying = 1 WHERE id = ? AND failed IS NOT NULL`),
    pylon: db.prepare("SELECT * FROM pylons WHERE id = ?"),
    pylonsOn: db.prepare("SELECT * FROM pylons WHERE node = ? ORDER BY id"),
    upsertSession: db.prepare(`INSERT INTO sessions (pylon, herdr_pane, harness, harness_session_id, status) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (pylon, herdr_pane) DO UPDATE SET harness = excluded.harness, harness_session_id = excluded.harness_session_id, status = excluded.status`),
    deleteSession: db.prepare("DELETE FROM sessions WHERE pylon = ? AND herdr_pane = ?"),
    sessions: db.prepare("SELECT * FROM sessions WHERE pylon = ? ORDER BY herdr_pane"),
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
    return (q.previews.all(pylon) as Row[]).map((r): Preview => ({
      pylon: r.pylon as PylonId, service: r.service as string, httpsPort: r.https_port as number, ready: r.ready === 1,
      url: `https://${r.tailnet_host as string}:${r.https_port as number}/`,
    }));
  }

  function threadOfPylon(pylonId: PylonId): ThreadId | undefined {
    return (q.threadOfPylon.get(pylonId) as Row | undefined)?.thread as ThreadId | undefined;
  }

  return {
    close() { db.close(); },

    /** Nodes come from the config file. Their state and capacity come from observations. */
    upsertNode(node: Pick<NodeRecord, "name" | "tailnetHost" | "tailnetNodeId">) { q.upsertNode.run(node.name, node.tailnetHost, node.tailnetNodeId); },
    nodes: () => (q.nodes.all() as Row[]).map(nodeRow),
    node(name: NodeName): NodeRecord | undefined {
      const row = q.node.get(name) as Row | undefined;
      return row && nodeRow(row);
    },
    /** The loop marks a node offline when its observe link stays down. Every other node fact comes through apply. */
    markOffline(name: NodeName) { q.nodeState.run("offline", name); },

    createProject(project: Project) { q.insertProject.run(project.id, JSON.stringify(project)); },
    projects: () => (q.projects.all() as Row[]).map((r) => json<Project>(r.record)),
    project(id: ProjectId): Project | undefined {
      const row = q.project.get(id) as Row | undefined;
      return row && json<Project>(row.record);
    },

    /** A thread and its pylon are created together, because a thread always has exactly one pylon. */
    createThread(thread: Thread, pylon: StoredPylon) {
      if (pylon.pylonId !== thread.pylonId || pylon.thread !== thread.id) throw new Error(`pylon ${pylon.pylonId} does not belong to thread ${thread.id}`);
      transaction(() => {
        q.insertThread.run(thread.id, thread.title, thread.project, thread.status, thread.conversationId, thread.startedBy, thread.createdAt,
          thread.agentTurnRunning ? 1 : 0, thread.lastAgentActivityAt, thread.lastHumanActivityAt);
        q.insertPylon.run(pylonParams(pylon));
      });
    },
    threads: (project?: ProjectId) => ((project === undefined ? q.threads.all() : q.threadsOf.all(project)) as Row[]).map(threadRow),
    thread(id: ThreadId): Thread | undefined {
      const row = q.thread.get(id) as Row | undefined;
      return row && threadRow(row);
    },
    setThreadStatus(id: ThreadId, status: ThreadStatus) { q.threadStatus.run(status, id); },
    /** Timestamps only move forward, so a late or repeated report cannot make a thread look idle sooner. */
    recordActivity(id: ThreadId, activity: { human?: number; agent?: number; agentTurnRunning?: boolean }) {
      transaction(() => {
        if (activity.human !== undefined) q.humanActivity.run(activity.human, id);
        if (activity.agent !== undefined) q.agentActivity.run(activity.agent, id);
        if (activity.agentTurnRunning !== undefined) q.agentTurn.run(activity.agentTurnRunning ? 1 : 0, id);
      });
    },

    pylon(id: PylonId): StoredPylon | undefined {
      const row = q.pylon.get(id) as Row | undefined;
      return row && pylonRow(row);
    },
    pylonsOn: (node: NodeName) => (q.pylonsOn.all(node) as Row[]).map(pylonRow),
    /** Takes a whole PylonRecord, so the tick can save what it holds. The desired phase is dropped. */
    savePylon(pylon: StoredPylon) {
      const { changes } = q.updatePylon.run(pylonParams(pylon));
      if (changes !== 1) throw new Error(`no pylon ${pylon.pylonId} to save`);
    },
    /** Clears a failed pylon's verdict and attempts, and marks a human retry. False when the pylon has not failed. */
    retryPylon: (pylonId: PylonId): boolean => q.retryPylon.run(pylonId).changes === 1,

    sessions: (pylon: PylonId) => (q.sessions.all(pylon) as Row[]).map((r): Session => ({
      pylon: r.pylon as PylonId, herdrPane: r.herdr_pane as string, harness: r.harness as Session["harness"],
      harnessSessionId: r.harness_session_id as string | null, status: r.status as Session["status"],
    })),
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
    outputs: (thread: ThreadId) => (q.outputs.all(thread) as Row[]).map((r): Output => ({
      thread: r.thread as ThreadId, kind: r.kind as Output["kind"], ref: r.ref as string,
    })),
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
      case "session":
        if (write.fact === null) q.deleteSession.run(write.pylonId, write.herdrPane);
        else q.upsertSession.run(write.pylonId, write.herdrPane, write.fact.harness, write.fact.harnessSessionId, write.fact.status);
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
