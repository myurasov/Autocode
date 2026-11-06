/*
 * The server's SQLite database: the schema as numbered migrations, and opening
 * it with missing migrations applied.
 */

import { Database } from "bun:sqlite"
import { AutocodeError } from "@autocode/shared"

// Numbered migrations: entry N (0-based) takes the database from version N to N
// + 1. Never edit a released one; a later tier appends.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE server (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE tokens (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('admin', 'consumer', 'session')),
    session_id TEXT,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX tokens_session ON tokens (session_id);
  CREATE TABLE hosts (
    id TEXT PRIMARY KEY,
    machine TEXT NOT NULL,
    directory TEXT NOT NULL,
    instance TEXT NOT NULL,
    opencode_version TEXT NOT NULL DEFAULT '',
    plugin_version TEXT NOT NULL DEFAULT '',
    online INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES hosts (id),
    directory TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX sessions_host ON sessions (host_id);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE REFERENCES sessions (id),
    description TEXT NOT NULL DEFAULT '',
    registered_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );
  CREATE TABLE settings (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  );
  CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    agent TEXT,
    host TEXT,
    session TEXT,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX history_at ON history (at);
  CREATE INDEX history_agent ON history (agent, at);
  CREATE TABLE instructions (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES hosts (id),
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    acked_at INTEGER,
    result TEXT
  );
  CREATE INDEX instructions_pending ON instructions (host_id, acked_at);
  `,
  // 2: the OpenCode process a host runs in (its kind and process ID).
  `
  ALTER TABLE hosts ADD COLUMN process_kind TEXT NOT NULL DEFAULT '';
  ALTER TABLE hosts ADD COLUMN process_pid INTEGER;
  `,
  // 3: whether a host can set its sessions' shell values (NULL: not said).
  `
  ALTER TABLE hosts ADD COLUMN shell_values INTEGER;
  `,
  /*
   * 4 (tier 0b): turn status, pauses, wakes, the injection queue, injections,
   * messages and the owner's inbox.
   */
  `
  ALTER TABLE sessions ADD COLUMN busy INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN turn_started_at INTEGER;
  ALTER TABLE sessions ADD COLUMN idle_since INTEGER;
  ALTER TABLE sessions ADD COLUMN last_outcome TEXT;
  ALTER TABLE sessions ADD COLUMN last_error TEXT;
  ALTER TABLE sessions ADD COLUMN turn_event_at INTEGER;
  ALTER TABLE sessions ADD COLUMN inject_pending_at INTEGER;
  ALTER TABLE instructions ADD COLUMN expires_at INTEGER;
  ALTER TABLE agents ADD COLUMN paused TEXT NOT NULL DEFAULT '';
  ALTER TABLE agents ADD COLUMN last_injection_at INTEGER;
  CREATE TABLE wakes (
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    trigger TEXT NOT NULL,
    check_cmd TEXT,
    end_at INTEGER,
    anchor INTEGER NOT NULL,
    next_at INTEGER,
    idle_fired_for INTEGER,
    idle_last_at INTEGER,
    check_failures INTEGER NOT NULL DEFAULT 0,
    set_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_fired_at INTEGER,
    PRIMARY KEY (agent_id, name)
  );
  CREATE INDEX wakes_next ON wakes (next_at);
  CREATE TABLE queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('wake', 'message')),
    wake TEXT,
    text TEXT,
    check_cmd TEXT,
    fired_by TEXT,
    extra TEXT,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    check_instruction TEXT,
    check_sent_at INTEGER,
    check_output TEXT
  );
  CREATE INDEX queue_agent ON queue (agent_id, id);
  CREATE TABLE injections (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    reasons TEXT NOT NULL,
    items TEXT NOT NULL DEFAULT '[]',
    text TEXT NOT NULL,
    instruction_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    settled_at INTEGER,
    error TEXT
  );
  CREATE INDEX injections_open ON injections (created_at)
    WHERE settled_at IS NULL;
  CREATE INDEX injections_agent ON injections (agent_id, created_at);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    send_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    to_spec TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    reply_to TEXT,
    body TEXT NOT NULL,
    mime TEXT,
    size INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued'
      CHECK (state IN ('queued', 'delivered', 'read')),
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER
  );
  CREATE INDEX messages_to ON messages (to_id, state, created_at);
  CREATE INDEX messages_at ON messages (created_at);
  CREATE TABLE inbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'alert')),
    agent_id TEXT,
    message_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    answer TEXT
  );
  CREATE INDEX inbox_open ON inbox (closed_at, created_at);
  `,
  // 5 (tier 0b2): a waiting wake keeps its trigger, so its prompt can say
  // what it was after a one-time wake is gone.
  `
  ALTER TABLE queue ADD COLUMN trigger TEXT;
  `,
  // 6 (tier 0b3): an agent's error state (its last turn failed) and its
  // retries; the unused retry backoff setting gives way to retry_interval
  // and retry_attempts.
  `
  ALTER TABLE agents ADD COLUMN error TEXT;
  ALTER TABLE agents ADD COLUMN error_since INTEGER;
  ALTER TABLE agents ADD COLUMN error_at INTEGER;
  ALTER TABLE agents ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agents ADD COLUMN retry_at INTEGER;
  DELETE FROM settings WHERE key = 'retry';
  `,
  /*
   * 7 (tier 0c): locks and semaphores. An entry is an agent's hold on a lock
   * or its place in the lock's queue (arrival order: its ID). No foreign key
   * to agents: unregistering releases the agent's entries itself, so the next
   * in the queue are granted.
   */
  `
  CREATE TABLE locks (
    name TEXT PRIMARY KEY,
    max INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE lock_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lock TEXT NOT NULL REFERENCES locks (name) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    held INTEGER NOT NULL DEFAULT 0,
    ttl INTEGER NOT NULL,
    queued_at INTEGER NOT NULL,
    granted_at INTEGER,
    expires_at INTEGER,
    UNIQUE (lock, agent_id)
  );
  CREATE INDEX lock_entries_expiry ON lock_entries (held, expires_at);
  CREATE INDEX lock_entries_agent ON lock_entries (agent_id);
  `,
  /*
   * 8 (tier 0c, the owner 2026-11-05): when each session token was last used,
   * so that one unused for 30 days is revoked (a running job keeps its own).
   */
  `
  ALTER TABLE tokens ADD COLUMN used_at INTEGER;
  UPDATE tokens SET used_at = created_at WHERE kind = 'session';
  `,
]

export function schemaVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number })
    .user_version
}

export function openStore(
  path: string,
  migrations: string[] = MIGRATIONS,
): Database {
  const db = new Database(path, { create: true, strict: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
  const current = schemaVersion(db)
  if (current > migrations.length) {
    db.close()
    throw new AutocodeError(
      "db_newer",
      `the database at ${path} is at schema ${current}, ` +
        `newer than this autocode knows (${migrations.length})`,
      500,
    )
  }
  for (let version = current; version < migrations.length; version++) {
    const sql = migrations[version] ?? ""
    try {
      db.transaction(() => {
        db.exec(sql)
        db.exec(`PRAGMA user_version = ${version + 1}`)
      })()
    } catch (err) {
      db.close()
      throw err
    }
  }
  return db
}
