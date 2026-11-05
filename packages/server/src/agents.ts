/*
 * The agent registry: registers an agent ID to a session, lists agents (the
 * owner's view or the discover view), changes their descriptions, unregisters
 * them, rotates their session tokens, and pauses and resumes them (one, or all
 * at once with stop-all); each change goes into the history, and each
 * registration change is told to the session's plugin (for the agent guide).
 */

import type { Database } from "bun:sqlite"
import {
  AutocodeError,
  checkId,
  isReservedId,
  matchesPattern,
  parsePattern,
} from "@autocode/shared"
import type { History } from "./history.ts"
import type { Hosts } from "./hosts.ts"
import { type ErrorView, errorView } from "./retries.ts"
import { type Caller, revokeSessionTokens } from "./tokens.ts"

/*
 * Registration binds an agent ID to one top-level OpenCode session. Rules, for
 * an ID and a session: a new ID is registered; the same ID from the same
 * session is accepted again; the same ID from another session moves only when
 * the old session is gone (or the owner forces it); a session that holds
 * another ID is refused.
 */

const SELECT = `
  SELECT a.id, a.description, a.session_id, a.registered_at, a.last_active,
         a.paused, a.error, a.error_since, a.error_at, a.retries, a.retry_at,
         s.host_id, s.directory, s.deleted_at, s.busy,
         s.idle_since, s.last_outcome, h.machine, h.online
  FROM agents a
  JOIN sessions s ON s.id = a.session_id
  JOIN hosts h ON h.id = s.host_id`

export interface AgentView {
  id: string
  description: string
  status: string
  last_active: string
  session?: string
  host?: string
  machine?: string
  directory?: string
  registered_at?: string
  paused?: string
  idle_since?: string | null
  last_outcome?: string | null
  // its last turn failed (tier 0b3)
  error?: ErrorView
}

export class Agents {
  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly hosts: Hosts,
    private readonly now: () => number,
    private readonly onUnregister: (agent: string) => void = () => {},
    // A pause takes back what the plugin has not fetched yet.
    private readonly onPause: (agent: string) => void = () => {},
  ) {}

  // offline (its host gone or its session deleted), paused, working (a turn
  // runs), error (its last turn failed: tier 0b3), else idle. Tier 0d adds
  // waiting.
  private status(row: any): string {
    if (!row.online || row.deleted_at) return "offline"
    if (row.paused) return "paused"
    if (row.busy) return "working"
    return row.error ? "error" : "idle"
  }

  // The plugin of the session's host keeps the agent guide's line from these.
  private notice(host: string | null, session: string, agent: string | null) {
    if (host) this.hosts.enqueue(host, "registration", { session, agent })
  }

  ownerView(row: any): AgentView {
    return {
      id: row.id,
      description: row.description,
      status: this.status(row),
      session: row.session_id,
      host: row.host_id,
      machine: row.machine,
      directory: row.directory,
      registered_at: new Date(row.registered_at).toISOString(),
      last_active: new Date(row.last_active).toISOString(),
      paused: row.paused ?? "",
      idle_since: row.idle_since
        ? new Date(row.idle_since).toISOString()
        : null,
      last_outcome: row.last_outcome ?? null,
      ...(row.error ? { error: errorView(row) } : {}),
    }
  }

  private discoverView(row: any): AgentView {
    return {
      id: row.id,
      description: row.description,
      status: this.status(row),
      last_active: new Date(row.last_active).toISOString(),
    }
  }

  private byId(id: string): any {
    return this.db.query(`${SELECT} WHERE a.id = ?`).get(id)
  }

  private bySession(session: string): any {
    return this.db.query(`${SELECT} WHERE a.session_id = ?`).get(session)
  }

  touch(session: string) {
    this.db
      .query("UPDATE agents SET last_active = ? WHERE session_id = ?")
      .run(this.now(), session)
  }

  me(session: string) {
    const row = this.bySession(session)
    return row
      ? { registered: true, session, agent: this.ownerView(row) }
      : { registered: false, session }
  }

  register(caller: Caller, body: any): { status: number; agent: AgentView } {
    if (!body || typeof body !== "object")
      throw new AutocodeError("bad_request", "the body must be an object")
    const id = checkId(body.id, "agent ID")
    if (isReservedId(id))
      throw new AutocodeError("reserved_id", `${id} is reserved`)
    const description = body.description === undefined ? "" : body.description
    if (typeof description !== "string" || description.length > 1000)
      throw new AutocodeError(
        "bad_request",
        "the description must be text of at most 1000 characters",
      )
    let session = caller.session
    let force = false
    if (caller.kind === "admin") {
      session = checkId(body.session, "session ID")
      force = body.force === true
      const known = this.db
        .query("SELECT deleted_at FROM sessions WHERE id = ?")
        .get(session) as any
      if (!known || known.deleted_at)
        throw new AutocodeError(
          "unknown_session",
          `session ${session} is not known or is gone`,
          404,
        )
    }
    if (!session)
      throw new AutocodeError(
        "forbidden",
        "registering needs a session token or the admin token",
        403,
      )
    const sessionRow = this.db
      .query("SELECT host_id FROM sessions WHERE id = ?")
      .get(session) as any
    const fields = { agent: id, session, host: sessionRow?.host_id ?? null }

    const holder = this.byId(id)
    if (holder?.session_id === session)
      return { status: 200, agent: this.ownerView(holder) }
    const other = this.bySession(session)
    if (other) {
      this.history.record("agent.refused", {
        ...fields,
        data: { reason: "session_has_id", holds: other.id },
      })
      throw new AutocodeError(
        "session_has_id",
        `this session is already registered as ${other.id}; unregister first`,
        409,
      )
    }
    if (holder) {
      if (!holder.deleted_at && !force) {
        this.history.record("agent.refused", {
          ...fields,
          data: { reason: "id_taken", by: holder.session_id },
        })
        throw new AutocodeError(
          "id_taken",
          `${id} belongs to another session that is still there ` +
            `(${holder.session_id}); the owner can force the move`,
          409,
        )
      }
      this.db
        .query(
          "UPDATE agents SET session_id = ?, last_active = ?, error = NULL, " +
            "error_since = NULL, error_at = NULL, retries = 0, " +
            "retry_at = NULL WHERE id = ?",
        )
        .run(session, this.now(), id)
      this.history.record("agent.moved", {
        ...fields,
        data: { from: holder.session_id, forced: force && !holder.deleted_at },
      })
      if (!holder.deleted_at)
        this.notice(holder.host_id, holder.session_id, null)
      this.notice(fields.host, session, id)
      return { status: 200, agent: this.ownerView(this.byId(id)) }
    }
    const now = this.now()
    this.db
      .query(
        "INSERT INTO agents (id, session_id, description, registered_at, " +
          "last_active) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, session, description, now, now)
    this.history.record("agent.registered", {
      ...fields,
      data: { description },
    })
    this.notice(fields.host, session, id)
    return { status: 201, agent: this.ownerView(this.byId(id)) }
  }

  unregister(id: string, by: "self" | "owner") {
    const row = this.byId(id)
    if (!row) throw new AutocodeError("not_registered", `no agent ${id}`, 404)
    this.db.query("DELETE FROM agents WHERE id = ?").run(id)
    this.history.record("agent.unregistered", {
      agent: id,
      session: row.session_id,
      host: row.host_id,
      data: { by },
    })
    this.onUnregister(id)
    if (!row.deleted_at) this.notice(row.host_id, row.session_id, null)
    return { unregistered: id }
  }

  unregisterSession(session: string) {
    const row = this.bySession(session)
    if (!row)
      throw new AutocodeError(
        "not_registered",
        "this session is not registered",
        404,
      )
    return this.unregister(row.id, "self")
  }

  list(match: string | null, view: "owner" | "discover"): AgentView[] {
    const pattern = match ? parsePattern(match) : null
    const rows = this.db.query(`${SELECT} ORDER BY a.id`).all() as any[]
    return rows
      .filter((r) => !pattern || matchesPattern(pattern, r.id))
      .map((r) => (view === "owner" ? this.ownerView(r) : this.discoverView(r)))
  }

  get(id: string): AgentView {
    const row = this.byId(checkId(id, "agent ID"))
    if (!row) throw new AutocodeError("not_registered", `no agent ${id}`, 404)
    return this.ownerView(row)
  }

  patch(id: string, body: any): AgentView {
    const row = this.byId(checkId(id, "agent ID"))
    if (!row) throw new AutocodeError("not_registered", `no agent ${id}`, 404)
    if (body?.description !== undefined) {
      if (
        typeof body.description !== "string" ||
        body.description.length > 1000
      )
        throw new AutocodeError(
          "bad_request",
          "the description must be text of at most 1000 characters",
        )
      this.db
        .query("UPDATE agents SET description = ? WHERE id = ?")
        .run(body.description, id)
      this.history.record("agent.changed", {
        agent: id,
        session: row.session_id,
        data: { description: body.description },
      })
    }
    return this.get(id)
  }

  // Revokes the session's tokens and tells its plugin to get a new one (the
  // instruction carries no token, so none is ever stored in plain text).
  rotate(id: string) {
    const row = this.byId(checkId(id, "agent ID"))
    if (!row) throw new AutocodeError("not_registered", `no agent ${id}`, 404)
    revokeSessionTokens(this.db, row.session_id, this.now())
    this.hosts.enqueue(row.host_id, "token", { session: row.session_id })
    this.history.record("token.rotated", {
      agent: id,
      session: row.session_id,
      host: row.host_id,
    })
    return { rotated: true, agent: id, session: row.session_id }
  }

  pause(idInput: string, by: "owner" | "stop-all" = "owner"): AgentView {
    const id = checkId(idInput, "agent ID")
    const row = this.byId(id)
    if (!row) throw new AutocodeError("not_registered", `no agent ${id}`, 404)
    // the owner's own pause outlasts stop-all's (resume-all leaves it)
    if (!row.paused || (by === "owner" && row.paused === "stop-all")) {
      this.db.query("UPDATE agents SET paused = ? WHERE id = ?").run(by, id)
      this.history.record("agent.paused", {
        agent: id,
        session: row.session_id,
        data: { by },
      })
    }
    this.onPause(id)
    return this.get(id)
  }

  resume(idInput: string): AgentView {
    const id = checkId(idInput, "agent ID")
    const row = this.byId(id)
    if (!row) throw new AutocodeError("not_registered", `no agent ${id}`, 404)
    if (row.paused) {
      this.db.query("UPDATE agents SET paused = '' WHERE id = ?").run(id)
      this.history.record("agent.resumed", {
        agent: id,
        session: row.session_id,
        data: { was: row.paused },
      })
    }
    return this.get(id)
  }

  /*
   * Pauses every agent that is not paused yet and interrupts the session of
   * every agent whose host is online (the server may not know of every turn);
   * an interrupt not fetched within two minutes is dropped, so a host that
   * returns later never cuts an unrelated turn.
   */
  stopAll() {
    const rows = this.db.query(`${SELECT} ORDER BY a.id`).all() as any[]
    const paused: string[] = []
    const interrupted: string[] = []
    for (const r of rows) {
      if (!r.paused) {
        this.pause(r.id, "stop-all")
        paused.push(r.id)
      } else this.onPause(r.id)
      if (r.online && !r.deleted_at) {
        this.hosts.enqueue(
          r.host_id,
          "interrupt",
          { session: r.session_id },
          120_000,
        )
        interrupted.push(r.session_id)
      }
    }
    this.history.record("stop_all", { data: { paused, interrupted } })
    return { paused, interrupted }
  }

  // Resumes the agents stop-all paused; the owner's own pauses stay.
  resumeAll() {
    const rows = this.db
      .query("SELECT id FROM agents WHERE paused = 'stop-all' ORDER BY id")
      .all() as { id: string }[]
    for (const r of rows) this.resume(r.id)
    const resumed = rows.map((r) => r.id)
    this.history.record("resume_all", { data: { resumed } })
    return { resumed }
  }

  agentOfSession(session: string): string | undefined {
    return (
      this.db
        .query("SELECT id FROM agents WHERE session_id = ?")
        .get(session) as any
    )?.id
  }
}
