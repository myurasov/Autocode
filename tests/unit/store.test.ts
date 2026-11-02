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
