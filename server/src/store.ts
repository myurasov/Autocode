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
  /*
   * 9 (tier 0d): questions, permission prompts and approvals ("asks"). `ref`
   * is OpenCode's form or permission request ID (none for an approval);
   * `body` the JSON of what is asked; `routed` where it went (owner, auto,
   * approve, job:<name> until its run starts,
   * agent:<id>); `notes` the escalations (JSON list).
   */
  `
  CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'permission', 'approval')),
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    host_id TEXT,
    ref TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    routed TEXT NOT NULL DEFAULT 'owner',
    notes TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'open'
      CHECK (state IN ('open', 'answered', 'rejected', 'expired', 'gone')),
    answer TEXT,
    answered_by TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    UNIQUE (session_id, ref)
  );
  CREATE INDEX asks_open ON asks (state, created_at);
  CREATE INDEX asks_agent ON asks (agent_id, state);
  `,
  /*
   * 10 (tier 0e): each agent's spend per day (the server's zone), the last
   * step's context and the model's window, a compaction asked for, a turn
   * cut by a lost OpenCode, and the day a cap warning or pause was made.
   */
  `
  CREATE TABLE costs (
    agent_id TEXT NOT NULL,
    day TEXT NOT NULL,
    usd REAL NOT NULL DEFAULT 0,
    steps INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, day)
  );
  ALTER TABLE agents ADD COLUMN context_tokens INTEGER;
  ALTER TABLE agents ADD COLUMN context_limit INTEGER;
  ALTER TABLE agents ADD COLUMN compact_wanted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agents ADD COLUMN cut_at INTEGER;
  ALTER TABLE agents ADD COLUMN cap_warned TEXT;
  ALTER TABLE agents ADD COLUMN cap_day TEXT;
  `,
  /*
   * 11 (tier 0f): jobs (the owner's: a host, a model, a prompt, a trigger,
   * a destination, limits) and their runs (an ID <job>:<start to the minute>,
   * who started it, its session, state, result and cost).
   */
  `
  CREATE TABLE jobs (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    host_id TEXT NOT NULL,
    model TEXT NOT NULL,
    variant TEXT,
    agent TEXT,
    prompt TEXT NOT NULL,
    trigger TEXT NOT NULL,
    next_at INTEGER,
    dest TEXT NOT NULL DEFAULT 'owner',
    timeout_ms INTEGER NOT NULL,
    run_usd REAL,
    delete_session INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    job TEXT NOT NULL,
    started_by TEXT NOT NULL,
    extra TEXT,
    session_id TEXT,
    state TEXT NOT NULL CHECK (state IN
      ('starting', 'running', 'succeeded', 'failed', 'skipped')),
    reason TEXT,
    result TEXT,
    cost REAL NOT NULL DEFAULT 0,
    instruction_id TEXT,
    ask_id TEXT,
    removed INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX runs_job ON runs (job, started_at);
  CREATE INDEX runs_state ON runs (state);
  `,
  /*
   * 12 (the review of 0d to 0f): an ask's form may be a Subagent's (its own
   * session), its answer's instruction is followed to its ack; a run keeps
   * its start (how), its whole result, and a cost of all its days; a job its
   * schedule's anchor; settings removed by the simplifications go.
   */
  `
  ALTER TABLE asks ADD COLUMN form_session TEXT;
  ALTER TABLE asks ADD COLUMN answer_instruction TEXT;
  ALTER TABLE runs ADD COLUMN how TEXT;
  ALTER TABLE runs ADD COLUMN spawn_host TEXT;
  ALTER TABLE runs ADD COLUMN spawned_at INTEGER;
  ALTER TABLE runs ADD COLUMN remove_pending INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN anchor_at INTEGER;
  ALTER TABLE agents ADD COLUMN cap_override TEXT;
  ALTER TABLE agents ADD COLUMN compacting INTEGER NOT NULL DEFAULT 0;
  DELETE FROM settings WHERE scope = 'server'
    AND key IN ('tools', 'total_usd', 'keep_failed', 'restart_opencode');
  `,
  /*
   * 13 (tier 0g): each agent ID's spend in total, kept when its days are
   * trimmed and when it unregisters; filled from the days kept so far. An
   * agent told that a compaction comes next.
   */
  `
  CREATE TABLE cost_totals (
    agent_id TEXT PRIMARY KEY,
    usd REAL NOT NULL DEFAULT 0,
    steps INTEGER NOT NULL DEFAULT 0,
    first_day TEXT NOT NULL
  );
  INSERT INTO cost_totals (agent_id, usd, steps, first_day)
    SELECT agent_id, SUM(usd), SUM(steps), MIN(day) FROM costs
    GROUP BY agent_id;
  ALTER TABLE agents ADD COLUMN compact_notified INTEGER NOT NULL DEFAULT 0;
  `,
  /*
   * 14 (Phase 1, the owner 2026-11-08): messages reach an agent only in a
   * prompt, whole: a copy is queued, then delivered; no read state, so read
   * copies are delivered ones (their read_at goes). inline_limit is no
   * setting any more.
   */
  `
  CREATE TABLE messages_new (
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
      CHECK (state IN ('queued', 'delivered')),
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  INSERT INTO messages_new (id, send_id, from_id, to_id, to_spec, subject,
      reply_to, body, mime, size, state, created_at, delivered_at)
    SELECT id, send_id, from_id, to_id, to_spec, subject, reply_to, body, mime,
      size, CASE state WHEN 'read' THEN 'delivered' ELSE state END,
      created_at, COALESCE(delivered_at, read_at)
    FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE INDEX messages_to ON messages (to_id, state, created_at);
  CREATE INDEX messages_at ON messages (created_at);
  DELETE FROM settings WHERE key = 'inline_limit';
  `,
  /*
   * 15 (the owner, 2026-11-08): an agent's model, from its last step. A
   * message may be dropped (its agent unregistered before a prompt carried
   * it: the final review), so the state's CHECK widens. The steps already
   * counted are kept (a batch sent again after a restart counts once).
   */
  `
  ALTER TABLE agents ADD COLUMN model TEXT;
  CREATE TABLE messages_new (
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
      CHECK (state IN ('queued', 'delivered', 'dropped')),
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  INSERT INTO messages_new SELECT * FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE INDEX messages_to ON messages (to_id, state, created_at);
  CREATE INDEX messages_at ON messages (created_at);
  UPDATE messages SET state = 'dropped'
    WHERE state = 'queued' AND to_id != 'owner'
      AND to_id NOT IN (SELECT id FROM agents);
  CREATE TABLE cost_steps (
    step TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
  `,
  /*
   * 16 (the owner, 2026-11-09): one final state, read, however a copy got
   * there (read_via: a prompt to an idle session, a steer into a running
   * turn, the agent's read or wait, the owner's inbox). Delivered copies are
   * read via prompt; the owner's are read once their inbox item closed, else
   * queued.
   */
  `
  CREATE TABLE messages_new (
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
      CHECK (state IN ('queued', 'read', 'dropped')),
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    read_via TEXT
      CHECK (read_via IN ('prompt', 'steer', 'read', 'wait', 'inbox'))
  );
  INSERT INTO messages_new (id, send_id, from_id, to_id, to_spec, subject,
      reply_to, body, mime, size, state, created_at, read_at, read_via)
    SELECT m.id, m.send_id, m.from_id, m.to_id, m.to_spec, m.subject,
      m.reply_to, m.body, m.mime, m.size,
      CASE
        WHEN m.state != 'delivered' THEN m.state
        WHEN m.to_id != 'owner' THEN 'read'
        WHEN i.closed_at IS NOT NULL THEN 'read'
        ELSE 'queued'
      END,
      m.created_at,
      CASE
        WHEN m.state != 'delivered' THEN NULL
        WHEN m.to_id != 'owner' THEN m.delivered_at
        ELSE i.closed_at
      END,
      CASE
        WHEN m.state != 'delivered' THEN NULL
        WHEN m.to_id != 'owner' THEN 'prompt'
        WHEN i.closed_at IS NOT NULL THEN 'inbox'
        ELSE NULL
      END
    FROM messages m
    LEFT JOIN (SELECT message_id, MAX(closed_at) AS closed_at FROM inbox
               WHERE message_id IS NOT NULL GROUP BY message_id) i
      ON i.message_id = m.id;
  DROP TABLE messages;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE INDEX messages_to ON messages (to_id, state, created_at);
  CREATE INDEX messages_at ON messages (created_at);
  `,
  /*
   * 17 (the owner, 2026-11-09, rc2): a run's cost counts for whom it was for,
   * its bill_to: the agent that set its job (jobs.created_by), else the agent
   * that started it (up a chain of runs), the agent that asked (an ask's run),
   * else job:<name> (the owner's or a schedule's). Each run's own spend is in
   * run_costs (the Jobs page, run_usd); the spend kept under run IDs moves to
   * their bill_to's rows, once. An approval of a job an agent set keeps its
   * definition (asks.job_def) until the owner answers; it does not make the
   * agent wait.
   */
  `
  ALTER TABLE jobs ADD COLUMN created_by TEXT;
  ALTER TABLE runs ADD COLUMN bill_to TEXT;
  ALTER TABLE asks ADD COLUMN job_def TEXT;
  CREATE TABLE run_costs (
    run_id TEXT NOT NULL,
    day TEXT NOT NULL,
    usd REAL NOT NULL DEFAULT 0,
    steps INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, day)
  );
  UPDATE runs SET bill_to = CASE
      WHEN how = 'ask' THEN (SELECT agent_id FROM asks WHERE asks.id = runs.ask_id)
      WHEN how IN ('owner', 'schedule') THEN 'job:' || job
      ELSE started_by
    END;
  UPDATE runs SET bill_to = 'job:' || job WHERE bill_to IS NULL;
  UPDATE runs SET bill_to = (SELECT p.bill_to FROM runs p
      WHERE p.id = runs.bill_to) WHERE bill_to IN (SELECT id FROM runs);
  UPDATE runs SET bill_to = (SELECT p.bill_to FROM runs p
      WHERE p.id = runs.bill_to) WHERE bill_to IN (SELECT id FROM runs);
  UPDATE runs SET bill_to = (SELECT p.bill_to FROM runs p
      WHERE p.id = runs.bill_to) WHERE bill_to IN (SELECT id FROM runs);
  UPDATE runs SET bill_to = 'job:' || job WHERE bill_to IN (SELECT id FROM runs);
  INSERT INTO run_costs (run_id, day, usd, steps)
    SELECT c.agent_id, c.day, c.usd, c.steps FROM costs c
    WHERE c.agent_id IN (SELECT id FROM runs);
  INSERT INTO costs (agent_id, day, usd, steps)
    SELECT r.bill_to, c.day, SUM(c.usd), SUM(c.steps) FROM costs c
    JOIN runs r ON r.id = c.agent_id GROUP BY r.bill_to, c.day
    ON CONFLICT (agent_id, day) DO UPDATE SET usd = usd + excluded.usd,
      steps = steps + excluded.steps;
  INSERT INTO cost_totals (agent_id, usd, steps, first_day)
    SELECT r.bill_to, SUM(t.usd), SUM(t.steps), MIN(t.first_day)
    FROM cost_totals t JOIN runs r ON r.id = t.agent_id GROUP BY r.bill_to
    ON CONFLICT (agent_id) DO UPDATE SET usd = usd + excluded.usd,
      steps = steps + excluded.steps,
      first_day = MIN(first_day, excluded.first_day);
  DELETE FROM costs WHERE agent_id IN (SELECT id FROM runs);
  DELETE FROM cost_totals WHERE agent_id IN (SELECT id FROM runs);
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
