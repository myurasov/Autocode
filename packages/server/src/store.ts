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
