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
    const db = openStore(path)
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
