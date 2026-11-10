/*
 * The server's SQLite store: a new database gets every migration in WAL mode,
 * an existing one is upgraded in place, a failing migration changes nothing,
 * and foreign keys are enforced.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MIGRATIONS, openStore, schemaVersion } from "@autocode/server/store"

const dirs: string[] = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "autocode-store-"))
  dirs.push(dir)
  return join(dir, "autocode.db")
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("store", () => {
  test("a new database gets every migration, WAL and the tier 0a tables", () => {
    const db = openStore(tempDb())
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe(
      "wal",
    )
    const tables = (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as any[]
    ).map((r) => r.name)
    for (const t of [
      "server",
      "tokens",
      "hosts",
      "sessions",
      "agents",
      "settings",
      "history",
      "instructions",
    ])
      expect(tables).toContain(t)
    db.close()
  })

  test("opening an existing database keeps its data and runs nothing again", () => {
    const path = tempDb()
    const db = openStore(path)
    db.run("INSERT INTO server (key, value) VALUES ('id', 'kept')")
    db.close()
    const again = openStore(path)
    expect(schemaVersion(again)).toBe(MIGRATIONS.length)
    expect(
      (again.query("SELECT value FROM server WHERE key = 'id'").get() as any)
        .value,
    ).toBe("kept")
    again.close()
  })

  test("a later migration runs on the previous migration's data", () => {
    const path = tempDb()
    const first = ["CREATE TABLE t (a TEXT NOT NULL)"]
    const db = openStore(path, first)
    db.run("INSERT INTO t (a) VALUES ('row')")
    db.close()
    const next = [
      ...first,
      "ALTER TABLE t ADD COLUMN b TEXT NOT NULL DEFAULT 'x'",
    ]
    const upgraded = openStore(path, next)
    expect(schemaVersion(upgraded)).toBe(2)
    expect(upgraded.query("SELECT a, b FROM t").all()).toEqual([
      { a: "row", b: "x" },
    ])
    upgraded.close()
  })

  test("the real migrations upgrade a database left at each earlier version", () => {
    for (let at = 1; at < MIGRATIONS.length; at++) {
      const path = tempDb()
      openStore(path, MIGRATIONS.slice(0, at)).close()
      const db = openStore(path)
      expect(schemaVersion(db)).toBe(MIGRATIONS.length)
      db.close()
    }
  })

  test("migration 4 (tier 0b) keeps a schema-3 agent; its wakes and queue go with it", () => {
    const path = tempDb()
    const old = openStore(path, MIGRATIONS.slice(0, 3))
    old.run(
      "INSERT INTO hosts (id, machine, directory, instance, first_seen, " +
        "last_seen) VALUES ('m:1', 'm', '/w', 'i', 1, 1)",
    )
    old.run(
      "INSERT INTO sessions (id, host_id, created_at, last_seen) " +
        "VALUES ('ses_1', 'm:1', 1, 1)",
    )
    old.run(
      "INSERT INTO agents (id, session_id, registered_at, last_active) " +
        "VALUES ('a:b', 'ses_1', 1, 1)",
    )
    old.close()
    const db = openStore(path)
    expect(db.query("SELECT busy, idle_since FROM sessions").get()).toEqual({
      busy: 0,
      idle_since: null,
    })
    expect(db.query("SELECT id, paused FROM agents").get()).toEqual({
      id: "a:b",
      paused: "",
    })
    db.run(
      "INSERT INTO wakes (agent_id, name, text, trigger, anchor, set_by, " +
        "created_at, updated_at) " +
        "VALUES ('a:b', 'w', 'x', '{}', 1, 'a:b', 1, 1)",
    )
    db.run(
      "INSERT INTO queue (agent_id, kind, wake, created_at) " +
        "VALUES ('a:b', 'wake', 'w', 1)",
    )
    db.run("DELETE FROM agents WHERE id = 'a:b'")
    const n = (table: string) =>
      (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n
    expect([n("wakes"), n("queue")]).toEqual([0, 0])
    db.close()
  })

  // The owner, 2026-11-09: one final state, read, however a copy got there.
  test("migration 16: delivered copies are read (via prompt); the owner's are read once their item closed", () => {
    const path = tempDb()
    const old = openStore(path, MIGRATIONS.slice(0, 15))
    const msg = (id: string, to: string, state: string, at: number | null) =>
      old.run(
        "INSERT INTO messages (id, send_id, from_id, to_id, to_spec, body, " +
          "size, state, created_at, delivered_at) " +
          "VALUES (?, 's', 'a:b', ?, ?, 'x', 1, ?, 1, ?)",
        [id, to, to, state, at],
      )
    msg("m_q", "c:d", "queued", null)
    msg("m_d", "c:d", "delivered", 5)
    msg("m_x", "c:d", "dropped", null)
    msg("m_open", "owner", "delivered", 6)
    msg("m_done", "owner", "delivered", 7)
    old.run(
      "INSERT INTO inbox (id, kind, message_id, title, created_at, " +
        "closed_at) VALUES ('ib_1', 'message', 'm_open', 't', 6, NULL), " +
        "('ib_2', 'message', 'm_done', 't', 7, 9)",
    )
    old.close()
    // as migration 16 left it (19 renames the state and its columns)
    const db = openStore(path, MIGRATIONS.slice(0, 16))
    const rows = db
      .query("SELECT id, state, read_at, read_via FROM messages ORDER BY id")
      .all()
    expect(rows).toEqual([
      { id: "m_d", state: "read", read_at: 5, read_via: "prompt" },
      { id: "m_done", state: "read", read_at: 9, read_via: "inbox" },
      { id: "m_open", state: "queued", read_at: null, read_via: null },
      { id: "m_q", state: "queued", read_at: null, read_via: null },
      { id: "m_x", state: "dropped", read_at: null, read_via: null },
    ])
    expect(() =>
      db.run("UPDATE messages SET state = 'delivered' WHERE id = 'm_q'"),
    ).toThrow()
    expect(() =>
      db.run("UPDATE messages SET read_via = 'mail' WHERE id = 'm_d'"),
    ).toThrow()
    db.close()
  })

  /*
   * The owner, 2026-11-09 (rc2): a run's cost counts for whom it was for.
   * Runs are given their bill_to: the agent that started them (up a chain of
   * runs), the agent that asked (an ask's run), else job:<name>; the spend
   * kept under their own IDs moves there, once.
   */
  test("migration 17: runs get bill_to; their spend moves from their own IDs to it", () => {
    const path = tempDb()
    const old = openStore(path, MIGRATIONS.slice(0, 16))
    const run = (
      id: string,
      job: string,
      by: string,
      how: string,
      ask = null as string | null,
    ) =>
      old.run(
        "INSERT INTO runs (id, job, started_by, how, state, started_at, " +
          "ask_id) VALUES (?, ?, ?, ?, 'succeeded', 1, ?)",
        [id, job, by, how, ask],
      )
    run("mail:2026-11-08T10:00", "mail", "team:lead", "agent")
    run("sub:2026-11-08T10:05", "sub", "mail:2026-11-08T10:00", "agent")
    run("nightly:2026-11-08T02:00", "nightly", "schedule", "schedule")
    run("nightly:2026-11-07T02:00", "nightly", "owner", "owner")
    run("ans:2026-11-08T11:00", "ans", "ask", "ask", "ask_1")
    old.run(
      "INSERT INTO hosts (id, machine, directory, instance, first_seen, " +
        "last_seen) VALUES ('m:1', 'm', '/w', 'i', 1, 1)",
    )
    old.run(
      "INSERT INTO sessions (id, host_id, created_at, last_seen) " +
        "VALUES ('ses_1', 'm:1', 1, 1)",
    )
    old.run(
      "INSERT INTO asks (id, kind, agent_id, session_id, title, body, " +
        "routed, created_at) VALUES ('ask_1', 'approval', 'team:asker', " +
        "'ses_1', 't', '{}', 'agent:ans:2026-11-08T11:00', 1)",
    )
    const spend = (id: string, day: string, usd: number, steps: number) => {
      old.run(
        "INSERT INTO costs (agent_id, day, usd, steps) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (agent_id, day) DO UPDATE SET usd = usd + excluded.usd, " +
          "steps = steps + excluded.steps",
        [id, day, usd, steps],
      )
      old.run(
        "INSERT INTO cost_totals (agent_id, usd, steps, first_day) " +
          "VALUES (?, ?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET " +
          "usd = usd + excluded.usd, steps = steps + excluded.steps, " +
          "first_day = MIN(first_day, excluded.first_day)",
        [id, usd, steps, day],
      )
    }
    spend("team:lead", "2026-11-08", 1, 2)
    spend("mail:2026-11-08T10:00", "2026-11-08", 0.5, 3)
    spend("sub:2026-11-08T10:05", "2026-11-08", 0.25, 1)
    spend("nightly:2026-11-08T02:00", "2026-11-08", 2, 4)
    spend("nightly:2026-11-07T02:00", "2026-11-07", 3, 5)
    spend("ans:2026-11-08T11:00", "2026-11-08", 0.125, 1)
    old.close()
    const db = openStore(path)
    expect(db.query("SELECT id, bill_to FROM runs ORDER BY id").all()).toEqual([
      { id: "ans:2026-11-08T11:00", bill_to: "team:asker" },
      { id: "mail:2026-11-08T10:00", bill_to: "team:lead" },
      { id: "nightly:2026-11-07T02:00", bill_to: "job:nightly" },
      { id: "nightly:2026-11-08T02:00", bill_to: "job:nightly" },
      { id: "sub:2026-11-08T10:05", bill_to: "team:lead" },
    ])
    expect(
      db.query("SELECT * FROM cost_totals ORDER BY agent_id").all(),
    ).toEqual([
      { agent_id: "job:nightly", usd: 5, steps: 9, first_day: "2026-11-07" },
      { agent_id: "team:asker", usd: 0.125, steps: 1, first_day: "2026-11-08" },
      { agent_id: "team:lead", usd: 1.75, steps: 6, first_day: "2026-11-08" },
    ])
    expect(
      db.query("SELECT * FROM costs ORDER BY agent_id, day").all(),
    ).toEqual([
      { agent_id: "job:nightly", day: "2026-11-07", usd: 3, steps: 5 },
      { agent_id: "job:nightly", day: "2026-11-08", usd: 2, steps: 4 },
      { agent_id: "team:asker", day: "2026-11-08", usd: 0.125, steps: 1 },
      { agent_id: "team:lead", day: "2026-11-08", usd: 1.75, steps: 6 },
    ])
    // the runs' own spend, as the Jobs page shows it
    expect(
      db.query("SELECT * FROM run_costs ORDER BY run_id, day").all(),
    ).toEqual([
      {
        run_id: "ans:2026-11-08T11:00",
        day: "2026-11-08",
        usd: 0.125,
        steps: 1,
      },
      {
        run_id: "mail:2026-11-08T10:00",
        day: "2026-11-08",
        usd: 0.5,
        steps: 3,
      },
      {
        run_id: "nightly:2026-11-07T02:00",
        day: "2026-11-07",
        usd: 3,
        steps: 5,
      },
      {
        run_id: "nightly:2026-11-08T02:00",
        day: "2026-11-08",
        usd: 2,
        steps: 4,
      },
      {
        run_id: "sub:2026-11-08T10:05",
        day: "2026-11-08",
        usd: 0.25,
        steps: 1,
      },
    ])
    // the jobs of agents: their creator
    db.run(
      "INSERT INTO jobs (name, host_id, model, prompt, trigger, timeout_ms, " +
        "created_at, updated_at, created_by) VALUES ('team:lead:x', 'm:1', " +
        "'a/b', 'p', '{}', 1, 1, 1, 'team:lead')",
    )
    db.close()
  })

  // The owner, 2026-11-10: the message state read is processed now.
  test("migration 19: read messages are processed, with when and how", () => {
    const path = tempDb()
    const old = openStore(path, MIGRATIONS.slice(0, 18))
    const msg = (
      id: string,
      state: string,
      at: number | null,
      via: string | null,
    ) =>
      old.run(
        "INSERT INTO messages (id, send_id, from_id, to_id, to_spec, body, " +
          "size, state, created_at, read_at, read_via) " +
          "VALUES (?, 's', 'a:b', 'c:d', 'c:d', 'x', 1, ?, 1, ?, ?)",
        [id, state, at, via],
      )
    msg("m_r", "read", 5, "steer")
    msg("m_q", "queued", null, null)
    msg("m_x", "dropped", null, null)
    old.close()
    const db = openStore(path)
    expect(
      db
        .query(
          "SELECT id, state, processed_at, processed_via FROM messages " +
            "ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "m_q", state: "queued", processed_at: null, processed_via: null },
      {
        id: "m_r",
        state: "processed",
        processed_at: 5,
        processed_via: "steer",
      },
      { id: "m_x", state: "dropped", processed_at: null, processed_via: null },
    ])
    expect(() =>
      db.run("UPDATE messages SET state = 'read' WHERE id = 'm_q'"),
    ).toThrow()
    db.close()
  })

  test("a failing migration leaves the database at the version before it", () => {
    const path = tempDb()
    openStore(path, ["CREATE TABLE t (a TEXT)"]).close()
    expect(() =>
      openStore(path, [
        "CREATE TABLE t (a TEXT)",
        "CREATE TABLE u (b TEXT); THIS IS NOT SQL",
      ]),
    ).toThrow()
    const db = openStore(path, ["CREATE TABLE t (a TEXT)"])
    expect(schemaVersion(db)).toBe(1)
    const tables = (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as any[]
    ).map((r) => r.name)
    expect(tables).not.toContain("u")
    db.close()
  })

  test("foreign keys are enforced: an agent needs a known session", () => {
    const db = openStore(tempDb())
    expect(() =>
      db.run(
        "INSERT INTO agents " +
          "(id, session_id, description, registered_at, last_active) " +
          "VALUES ('a', 'ses_x', '', 1, 1)",
      ),
    ).toThrow()
    db.close()
  })
})
