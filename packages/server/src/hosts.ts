/*
 * Hosts on the server: the plugin channel's hello, long poll and events, the
 * instruction queue of each host, the sessions hosts report, the OpenCode
 * process each runs in and whether it can set shell values, and which hosts
 * are online.
 */

import type { Database } from "bun:sqlite"
import { AutocodeError, checkId, VERSION } from "@autocode/shared"
import type { History } from "./history.ts"
import { revokeSessionTokens } from "./tokens.ts"

/*
 * The plugin channel. A host is one plugin instance: one OpenCode server's
 * workspace folder on one machine. It says hello, long-polls for instructions,
 * acknowledges them and reports events. A newer instance of the same host
 * supersedes the older one.
 */

export interface ChannelOptions {
  serverId: string
  pollWait: number
  offlineAfter: number
  redeliverAfter: number
  // After a poll ends, how long the host still counts as in use for an instance
  // that asks without takeover.
  takeoverGraceMs?: number
}

const DAY = 24 * 3600_000
const MAX_SESSIONS = 2000

export interface Instruction {
  id: string
  type: string
  payload: unknown
  created_at: string
  attempts: number
}

function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new AutocodeError(
      "bad_request",
      `${name} must be text of 1 to ${max} characters`,
    )
  return value
}

/*
 * The OpenCode process a plugin reports in its hello: a short kind (service,
 * serve, run, tui, ...) and a process ID. A missing or malformed one is left
 * empty, so older plugins still say hello.
 */
function processOf(value: any): { kind: string; pid: number | null } {
  const kind =
    typeof value?.kind === "string" && /^[a-z][a-z-]{0,19}$/.test(value.kind)
      ? value.kind
      : ""
  const pid =
    Number.isInteger(value?.pid) && value.pid > 0 && value.pid < 2 ** 31
      ? value.pid
      : null
  return { kind, pid }
}

export class Hosts {
  private readonly polling = new Map<string, number>()
  // Real time of each host's last poll end (not the server clock, which tests
  // may fake).
  private readonly lastPoll = new Map<string, number>()
  private readonly waiters = new Map<string, Set<() => void>>()

  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly now: () => number,
    private readonly options: ChannelOptions,
  ) {}

  private row(id: string): any {
    return this.db.query("SELECT * FROM hosts WHERE id = ?").get(id)
  }

  private known(id: string): any {
    checkId(id, "host ID")
    const host = this.row(id)
    if (!host)
      throw new AutocodeError(
        "unknown_host",
        `host ${id} has not said hello`,
        404,
      )
    return host
  }

  private markOnline(id: string, wasOnline: boolean) {
    this.db
      .query("UPDATE hosts SET online = 1, last_seen = ? WHERE id = ?")
      .run(this.now(), id)
    if (!wasOnline) this.history.record("host.online", { host: id })
  }

  /*
   * The sessions a plugin reports: IDs, or {id, directory} with the session's
   * folder. An entry that is not a valid session is skipped (one bad entry must
   * not stop the hello for good), and at most MAX_SESSIONS are taken.
   */
  private reportedSessions(
    value: unknown,
    directory: string,
  ): { id: string; directory: string }[] {
    if (value === undefined) return []
    if (!Array.isArray(value))
      throw new AutocodeError("bad_request", "sessions must be a list")
    const out: { id: string; directory: string }[] = []
    for (const item of value.slice(0, MAX_SESSIONS)) {
      try {
        const id = checkId(
          typeof item === "string" ? item : item?.id,
          "session ID",
        )
        const own = typeof item === "object" && item?.directory !== undefined
        out.push({
          id,
          directory: own ? text(item.directory, "directory") : directory,
        })
      } catch {}
    }
    return out
  }

  // Records sessions of a host; a session the server knows was deleted stays
  // deleted.
  noteSessions(host: string, sessions: { id: string; directory: string }[]) {
    const upsert = this.db.prepare(
      `INSERT INTO sessions (id, host_id, directory, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         host_id = excluded.host_id, last_seen = excluded.last_seen,
         directory = CASE WHEN excluded.directory = ''
           THEN sessions.directory ELSE excluded.directory END
       WHERE sessions.deleted_at IS NULL`,
    )
    const now = this.now()
    this.db.transaction(() => {
      for (const s of sessions) upsert.run(s.id, host, s.directory, now, now)
    })()
  }

  hello(id: string, body: any) {
    checkId(id, "host ID")
    if (!body || typeof body !== "object")
      throw new AutocodeError("bad_request", "hello needs a body")
    const instance = text(body.instance, "instance", 200)
    const machine = text(body.machine ?? id.split(":")[0], "machine", 255)
    const directory = text(body.directory ?? "/", "directory")
    const opencode =
      typeof body.opencode?.version === "string" ? body.opencode.version : ""
    const plugin =
      typeof body.plugin?.version === "string" ? body.plugin.version : ""
    const { kind, pid } = processOf(body.process)
    const shellValues =
      typeof body.shell_values === "boolean" ? Number(body.shell_values) : null
    const sessions = this.reportedSessions(body.sessions, directory)
    const now = this.now()
    const before = this.row(id)
    /*
     * An instance that was superseded asks without takeover: it gets the host
     * back only once the current one is gone (no poll open, and none in the
     * last 2 seconds by default, which covers the gap between two polls).
     */
    const grace = this.options.takeoverGraceMs ?? 2000
    const busy =
      (this.polling.get(id) ?? 0) > 0 ||
      Date.now() - (this.lastPoll.get(id) ?? 0) < grace
    if (
      body.takeover === false &&
      before &&
      before.instance !== instance &&
      busy
    )
      throw new AutocodeError(
        "host_busy",
        `host ${id} is in use by a newer instance`,
        409,
      )
    this.db
      .query(
        `INSERT INTO hosts (id, machine, directory, instance, opencode_version,
           plugin_version, process_kind, process_pid, shell_values, online,
           first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           machine = excluded.machine, directory = excluded.directory,
           instance = excluded.instance,
           opencode_version = excluded.opencode_version,
           plugin_version = excluded.plugin_version,
           process_kind = excluded.process_kind,
           process_pid = excluded.process_pid,
           shell_values = excluded.shell_values,
           online = 1, last_seen = excluded.last_seen`,
      )
      .run(
        id,
        machine,
        directory,
        instance,
        opencode,
        plugin,
        kind,
        pid,
        shellValues,
        now,
        now,
      )
    this.noteSessions(id, sessions)
    if (!before?.online)
      this.history.record("host.online", {
        host: id,
        data: { machine, directory, opencode, plugin },
      })
    if (before && before.instance !== instance) this.wake(id)
    return {
      server: { id: this.options.serverId, version: VERSION },
      host: id,
      poll: { wait: this.options.pollWait },
      sessions: this.sessionsOf(id),
    }
  }

  sessionsOf(id: string): string[] {
    return (
      this.db
        .query(
          "SELECT id FROM sessions WHERE host_id = ? " +
            "AND deleted_at IS NULL ORDER BY id",
        )
        .all(id) as {
        id: string
      }[]
    ).map((r) => r.id)
  }

  private pending(id: string): Instruction[] {
    const rows = this.db
      .query(
        `SELECT * FROM instructions
         WHERE host_id = ? AND acked_at IS NULL
           AND (sent_at IS NULL OR sent_at <= ?)
         ORDER BY rowid`,
      )
      .all(id, this.now() - this.options.redeliverAfter * 1000) as any[]
    if (!rows.length) return []
    const mark = this.db.prepare(
      "UPDATE instructions SET sent_at = ?, attempts = attempts + 1 " +
        "WHERE id = ?",
    )
    for (const r of rows) mark.run(this.now(), r.id)
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: JSON.parse(r.payload),
      created_at: new Date(r.created_at).toISOString(),
      attempts: r.attempts + 1,
    }))
  }

  private wake(id: string) {
    for (const resolve of this.waiters.get(id) ?? []) resolve()
  }

  async next(
    id: string,
    instance: string | null,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<{ instructions: Instruction[] }> {
    const host = this.known(id)
    if (!instance || host.instance !== instance)
      throw new AutocodeError(
        "superseded",
        `instance ${instance} of host ${id} was superseded by a newer one`,
        409,
      )
    this.polling.set(id, (this.polling.get(id) ?? 0) + 1)
    this.markOnline(id, !!host.online)
    try {
      const deadline =
        Date.now() + Math.max(0, Math.min(waitSeconds, 120)) * 1000
      for (;;) {
        if (this.row(id)?.instance !== instance)
          throw new AutocodeError(
            "superseded",
            `instance ${instance} of host ${id} was superseded by a newer one`,
            409,
          )
        const ready = this.pending(id)
        if (ready.length || Date.now() >= deadline || signal?.aborted)
          return { instructions: ready }
        await new Promise<void>((resolve) => {
          const set = this.waiters.get(id) ?? new Set()
          this.waiters.set(id, set)
          const done = () => {
            clearTimeout(timer)
            set.delete(done)
            signal?.removeEventListener("abort", done)
            resolve()
          }
          const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
          signal?.addEventListener("abort", done)
          set.add(done)
        })
      }
    } finally {
      this.polling.set(id, (this.polling.get(id) ?? 1) - 1)
      this.lastPoll.set(id, Date.now())
      if (this.row(id)?.instance === instance)
        this.db
          .query("UPDATE hosts SET last_seen = ? WHERE id = ?")
          .run(this.now(), id)
    }
  }

  events(id: string, body: any, onSessionDeleted: (session: string) => void) {
    const host = this.known(id)
    if (!body || !Array.isArray(body.events))
      throw new AutocodeError("bad_request", "events must be a list")
    this.markOnline(id, !!host.online)
    for (const event of body.events) {
      if (!event || typeof event !== "object") continue
      if (event.type === "ack" && typeof event.id === "string") {
        this.db
          .query(
            "UPDATE instructions SET acked_at = ?, result = ? " +
              "WHERE id = ? AND host_id = ? AND acked_at IS NULL",
          )
          .run(
            this.now(),
            JSON.stringify({
              ok: event.ok !== false,
              result: event.result ?? null,
              error: event.error ?? null,
            }),
            event.id,
            id,
          )
      } else if (
        event.type === "session.created" &&
        typeof event.session === "string"
      ) {
        // a malformed one is skipped; the others in the batch still count
        this.noteSessions(
          id,
          this.reportedSessions(
            [{ id: event.session, directory: event.directory }],
            host.directory,
          ),
        )
      } else if (
        event.type === "session.deleted" &&
        typeof event.session === "string"
      ) {
        const session = this.db
          .query("SELECT id FROM sessions WHERE id = ? AND deleted_at IS NULL")
          .get(event.session)
        if (!session) continue
        this.db
          .query("UPDATE sessions SET deleted_at = ? WHERE id = ?")
          .run(this.now(), event.session)
        revokeSessionTokens(this.db, event.session, this.now())
        onSessionDeleted(event.session)
      }
    }
    return { ok: true }
  }

  // Acknowledged instructions are deleted after a day; any instruction after a
  // week.
  prune() {
    const now = this.now()
    this.db
      .query(
        "DELETE FROM instructions " +
          "WHERE (acked_at IS NOT NULL AND acked_at < ?) OR created_at < ?",
      )
      .run(now - DAY, now - 7 * DAY)
  }

  enqueue(id: string, type: string, payload: unknown): string {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20)
    const instructionId = `in_${suffix}`
    this.db
      .query(
        "INSERT INTO instructions (id, host_id, type, payload, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(instructionId, id, type, JSON.stringify(payload ?? {}), this.now())
    this.wake(id)
    return instructionId
  }

  instruction(id: string): { acked: boolean; result: unknown } | undefined {
    const row = this.db
      .query("SELECT acked_at, result FROM instructions WHERE id = ?")
      .get(id) as any
    if (!row) return undefined
    const stored = row.result ? JSON.parse(row.result) : null
    return { acked: row.acked_at !== null, result: stored?.result ?? null }
  }

  sweep() {
    const cutoff = this.now() - this.options.offlineAfter * 1000
    const stale = this.db
      .query("SELECT id FROM hosts WHERE online = 1 AND last_seen < ?")
      .all(cutoff) as {
      id: string
    }[]
    for (const { id } of stale) {
      if ((this.polling.get(id) ?? 0) > 0) continue
      this.db.query("UPDATE hosts SET online = 0 WHERE id = ?").run(id)
      this.history.record("host.offline", { host: id })
    }
  }

  list() {
    return (
      this.db.query("SELECT * FROM hosts ORDER BY id").all() as any[]
    ).map((h) => ({
      id: h.id,
      machine: h.machine,
      directory: h.directory,
      online: !!h.online,
      instance: h.instance,
      opencode_version: h.opencode_version,
      plugin_version: h.plugin_version,
      process_kind: h.process_kind,
      process_pid: h.process_pid,
      shell_values: h.shell_values === null ? null : !!h.shell_values,
      first_seen: new Date(h.first_seen).toISOString(),
      last_seen: new Date(h.last_seen).toISOString(),
    }))
  }

  // Wakes every long poll so the process can stop.
  close() {
    for (const id of this.waiters.keys()) this.wake(id)
  }
}
