/*
 * The history: stores each server event (a kind, the agent, host and session
 * involved, and data) in the database, lists them newest first, filtered by
 * agent (or an agent pattern), kind (or a kind prefix), time and paging, says
 * which kinds there are, and deletes those older than the days kept.
 */

import type { Database } from "bun:sqlite"
import { AutocodeError, matchesPattern, parsePattern } from "@autocode/shared"

export interface HistoryFields {
  agent?: string | null
  host?: string | null
  session?: string | null
  data?: Record<string, unknown>
}

export interface HistoryEntry {
  id: number
  at: string
  kind: string
  agent?: string
  host?: string
  session?: string
  data: Record<string, unknown>
}

export interface HistoryFilter {
  agent?: string
  // an agent pattern or list (kaggle:*, a:b,c:*)
  match?: string
  // a kind, or a prefix ending in .* (wake.*)
  kind?: string
  since?: string
  until?: string
  // an entry's ID: only entries older than it (paging)
  before?: string
  limit?: string
}

function parseTime(value: string, name: string): number {
  const t = Date.parse(value)
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(t))
    throw new AutocodeError(
      "bad_request",
      `${name} must be a time like 2026-10-28T12:00:00Z`,
    )
  return t
}

export class History {
  constructor(
    private readonly db: Database,
    private readonly now: () => number,
  ) {}

  record(kind: string, fields: HistoryFields = {}) {
    this.db
      .query(
        "INSERT INTO history (at, kind, agent, host, session, data) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.now(),
        kind,
        fields.agent ?? null,
        fields.host ?? null,
        fields.session ?? null,
        JSON.stringify(fields.data ?? {}),
      )
  }

  list(filter: HistoryFilter): HistoryEntry[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (filter.agent) {
      where.push("agent = ?")
      args.push(filter.agent)
    }
    if (filter.kind?.endsWith(".*")) {
      const prefix = filter.kind.slice(0, -1)
      if (!/^[a-z_]+(\.[a-z_]+)*\.$/.test(prefix))
        throw new AutocodeError(
          "bad_request",
          "kind takes a kind, or a prefix like wake.*",
        )
      where.push("substr(kind, 1, ?) = ?")
      args.push(prefix.length, prefix)
    } else if (filter.kind?.includes("*"))
      throw new AutocodeError(
        "bad_request",
        "kind takes a kind, or a prefix like wake.*",
      )
    else if (filter.kind) {
      where.push("kind = ?")
      args.push(filter.kind)
    }
    if (filter.before !== undefined) {
      const id = Number(filter.before)
      if (!Number.isInteger(id) || id < 1)
        throw new AutocodeError("bad_request", "before takes an entry's ID")
      const at = this.db.query("SELECT at FROM history WHERE id = ?").get(id) as
        | { at: number }
        | undefined
      // older than that entry, in the list's order (time, then ID)
      where.push("(at < ? OR (at = ? AND id < ?))")
      args.push(at?.at ?? 0, at?.at ?? 0, id)
    }
    if (filter.since) {
      where.push("at >= ?")
      args.push(parseTime(filter.since, "since"))
    }
    if (filter.until) {
      where.push("at <= ?")
      args.push(parseTime(filter.until, "until"))
    }
    const limit = filter.limit === undefined ? 100 : Number(filter.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new AutocodeError(
        "bad_request",
        "limit must be a whole number from 1 to 1000",
      )
    const pattern = filter.match ? parsePattern(filter.match) : null
    const sql =
      "SELECT * FROM history " +
      `${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
      "ORDER BY at DESC, id DESC"
    let rows: any[]
    if (!pattern) rows = this.db.query(`${sql} LIMIT ?`).all(...args, limit)
    else {
      // a pattern is matched here, in order, until the page is full
      rows = []
      for (const r of this.db.query(sql).iterate(...args) as Iterable<any>) {
        if (r.agent && matchesPattern(pattern, r.agent)) rows.push(r)
        if (rows.length >= limit) break
      }
    }
    return rows.map((r) => {
      const entry: HistoryEntry = {
        id: r.id,
        at: new Date(r.at).toISOString(),
        kind: r.kind,
        data: JSON.parse(r.data),
      }
      if (r.agent) entry.agent = r.agent
      if (r.host) entry.host = r.host
      if (r.session) entry.session = r.session
      return entry
    })
  }

  // The kinds there are, with how many of each, most first.
  kinds(): { kind: string; count: number }[] {
    return this.db
      .query(
        "SELECT kind, COUNT(*) AS count FROM history GROUP BY kind " +
          "ORDER BY count DESC, kind",
      )
      .all() as { kind: string; count: number }[]
  }

  trim(days: number): number {
    const cutoff = this.now() - days * 86_400_000
    return this.db.query("DELETE FROM history WHERE at < ?").run(cutoff).changes
  }
}
