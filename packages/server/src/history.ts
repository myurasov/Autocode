/*
 * The history: stores each server event (a kind, the agent, host and session
 * involved, and data) in the database, lists them newest first, filtered by
 * agent, kind and time, and deletes those older than the days kept.
 */

import type { Database } from "bun:sqlite"
import { AutocodeError } from "@autocode/shared"

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
  kind?: string
  since?: string
  until?: string
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
    if (filter.kind) {
      where.push("kind = ?")
      args.push(filter.kind)
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
    const sql =
      "SELECT * FROM history " +
      `${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
      "ORDER BY at DESC, id DESC LIMIT ?"
    const rows = this.db.query(sql).all(...args, limit) as any[]
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

  trim(days: number): number {
    const cutoff = this.now() - days * 86_400_000
    return this.db.query("DELETE FROM history WHERE at < ?").run(cutoff).changes
  }
}
