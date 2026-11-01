/**
 * The registry's schema: every migration, in order, under the one user_version that db.ts reads. Each table is made
 * here, so the log stays one ordered history across features. The merge policy holds a change to it as irreversible.
 */
/** Applied in order. The database's user_version counts the ones already applied. Never edit one that has shipped. */
export const migrations: readonly string[] = [
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
  // When each archived thread was archived, which deletes its pylon a day later, and each pylon whose delete that cleanup
  // sent, until its node no longer has it. A thread archived before has no time, so it gets this migration's, and no disk
  // goes until a day after it. It touches nothing an earlier migration made, so a registry rewound past it applies it
  // again unchanged.
  `CREATE TABLE IF NOT EXISTS thread_archives (thread TEXT PRIMARY KEY REFERENCES threads (id), archived_at INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS disk_cleanups (pylon TEXT PRIMARY KEY REFERENCES pylons (id), thread TEXT NOT NULL REFERENCES threads (id), requested_at INTEGER NOT NULL) STRICT;
   INSERT OR IGNORE INTO thread_archives SELECT id, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM threads WHERE status = 'archived';`,
  // Each daily report of nexus doctor's checks, kept 30 days. It touches nothing an earlier migration made, so a registry
  // rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS doctor_reports (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, record TEXT NOT NULL) STRICT;`,
  // Each node's health samples, kept whole in tier raw and as buckets in the coarser tiers, by the bucket's start. The
  // key leads with the node, the tier and the time, so a node's range and pruning a node's tier are each one range of
  // it. It touches nothing an earlier migration made, so a registry rewound past it applies it again unchanged.
  `CREATE TABLE IF NOT EXISTS node_metrics (node TEXT NOT NULL, tier TEXT NOT NULL, at INTEGER NOT NULL, series TEXT NOT NULL,
     min REAL NOT NULL, sum REAL NOT NULL, max REAL NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (node, tier, at, series)) STRICT, WITHOUT ROWID;`,
  // The daily reports become the changes of nexus doctor's checks: a row each time a check's status changes, whose
  // record holds the change and when the person saw it. The daily reports, at most a day old and shown better by the
  // node graphs, are dropped rather than converted, as no change can be read from one. A change has no checks, so a
  // registry rewound past this applies it again and keeps every change.
  `DELETE FROM doctor_reports WHERE json_extract(record, '$.checks') IS NOT NULL;`,
];
