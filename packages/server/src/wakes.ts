/*
 * Wakes (spec, Wakes): each agent's named wakes with their trigger, text,
 * optional check and end date; setting, listing, cancelling and firing them;
 * and, on each scheduler tick, the wakes that fell due (by time, or by idle
 * time), handed to the injection queue.
 */

import type { Database } from "bun:sqlite"
import {
  AutocodeError,
  checkId,
  formatTrigger,
  nextRun,
  parseTrigger,
  type Trigger,
} from "@autocode/shared"
import type { History } from "./history.ts"

export interface WakeItem {
  wake: string
  text: string
  check?: string | null
  fired_by?: string | null
  extra?: string | null
}

export type Enqueue = (agent: string, item: WakeItem) => void

export interface WakeView {
  agent: string
  name: string
  text: string
  trigger: string
  check: string | null
  end: string | null
  next: string | null
  set_by: string
  created_at: string
  updated_at: string
  last_fired_at: string | null
  check_failures: number
}

const MAX_TEXT = 32_000
const MAX_CHECK = 4000
const iso = (ms: number | null) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString()

export function notRegistered(): AutocodeError {
  return new AutocodeError(
    "not_registered",
    "this session is not registered: register with autocode_me first",
    403,
  )
}

export class Wakes {
  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly now: () => number,
    private readonly timezone: () => string,
  ) {}

  private agentExists(agent: string) {
    if (!this.db.query("SELECT 1 FROM agents WHERE id = ?").get(agent))
      throw new AutocodeError("not_registered", `no agent ${agent}`, 404)
  }

  private view(row: any): WakeView {
    return {
      agent: row.agent_id,
      name: row.name,
      text: row.text,
      trigger: formatTrigger(JSON.parse(row.trigger)),
      check: row.check_cmd ?? null,
      end: iso(row.end_at),
      next: iso(row.next_at),
      set_by: row.set_by,
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
      last_fired_at: iso(row.last_fired_at),
      check_failures: row.check_failures,
    }
  }

  set(
    agent: string,
    nameInput: unknown,
    body: any,
    by: string,
  ): { status: number; wake: WakeView } {
    this.agentExists(agent)
    const name = checkId(nameInput, "wake name")
    if (!body || typeof body !== "object")
      throw new AutocodeError("bad_request", "the body must be an object")
    const { text, check } = body
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT)
      throw new AutocodeError(
        "bad_request",
        `a wake's text must be 1 to ${MAX_TEXT} characters`,
      )
    if (
      check !== undefined &&
      check !== null &&
      (typeof check !== "string" || !check.trim() || check.length > MAX_CHECK)
    )
      throw new AutocodeError(
        "bad_request",
        `a check must be a command of 1 to ${MAX_CHECK} characters`,
      )
    const now = this.now()
    const tz = this.timezone()
    if (typeof body.trigger !== "string")
      throw new AutocodeError("bad_trigger", "a wake needs a trigger")
    const trigger = parseTrigger(body.trigger, { tz, now })
    let end: number | null = null
    if (body.end !== undefined && body.end !== null) {
      try {
        const at = parseTrigger(`at ${String(body.end)}`, { tz, now })
        end = Date.parse((at as { at: string }).at)
      } catch {
        throw new AutocodeError(
          "bad_request",
          "end must be a time, like 2026-11-30T18:00:00Z or 2026-11-30 18:00",
        )
      }
      if (end <= now)
        throw new AutocodeError("bad_request", "the end has passed already")
    }
    const next = nextRun(trigger, now, { tz, anchor: now })
    if (trigger.kind === "at" && next === null)
      throw new AutocodeError("bad_trigger", "that time has passed already")
    const before = this.db
      .query("SELECT created_at FROM wakes WHERE agent_id = ? AND name = ?")
      .get(agent, name) as any
    this.db
      .query(
        `INSERT INTO wakes (agent_id, name, text, trigger, check_cmd, end_at,
           anchor, next_at, set_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, name) DO UPDATE SET
           text = excluded.text, trigger = excluded.trigger,
           check_cmd = excluded.check_cmd, end_at = excluded.end_at,
           anchor = excluded.anchor, next_at = excluded.next_at,
           set_by = excluded.set_by, updated_at = excluded.updated_at,
           idle_fired_for = NULL, idle_last_at = NULL, check_failures = 0`,
      )
      .run(
        agent,
        name,
        text,
        JSON.stringify(trigger),
        check ?? null,
        end,
        now,
        next,
        by,
        now,
        now,
      )
    this.history.record("wake.set", {
      agent,
      data: { name, trigger: formatTrigger(trigger), by, replaced: !!before },
    })
    return { status: before ? 200 : 201, wake: this.get(agent, name) }
  }

  get(agent: string, name: string): WakeView {
    const row = this.db
      .query("SELECT * FROM wakes WHERE agent_id = ? AND name = ?")
      .get(agent, name)
    if (!row)
      throw new AutocodeError("no_wake", `${agent} has no wake ${name}`, 404)
    return this.view(row)
  }

  list(agent?: string): WakeView[] {
    const rows = agent
      ? this.db
          .query("SELECT * FROM wakes WHERE agent_id = ? ORDER BY name")
          .all(agent)
      : this.db.query("SELECT * FROM wakes ORDER BY agent_id, name").all()
    return (rows as any[]).map((r) => this.view(r))
  }

  cancel(agent: string, nameInput: unknown, by: string) {
    const name = checkId(nameInput, "wake name")
    const res = this.db
      .query("DELETE FROM wakes WHERE agent_id = ? AND name = ?")
      .run(agent, name)
    if (!res.changes)
      throw new AutocodeError("no_wake", `${agent} has no wake ${name}`, 404)
    this.history.record("wake.cancelled", { agent, data: { name, by } })
    return { cancelled: name }
  }

  // Delivers a wake now: it skips its check; the prompt names who fired it.
  fire(
    agent: string,
    nameInput: unknown,
    by: string,
    extra: unknown,
    enqueue: Enqueue,
  ) {
    checkId(agent, "agent ID")
    this.agentExists(agent)
    const name = checkId(nameInput, "wake name")
    const row = this.db
      .query("SELECT * FROM wakes WHERE agent_id = ? AND name = ?")
      .get(agent, name) as any
    if (!row)
      throw new AutocodeError("no_wake", `${agent} has no wake ${name}`, 404)
    if (
      extra !== undefined &&
      extra !== null &&
      (typeof extra !== "string" || extra.length > MAX_TEXT)
    )
      throw new AutocodeError(
        "bad_request",
        `the extra text must be at most ${MAX_TEXT} characters`,
      )
    enqueue(agent, {
      wake: name,
      text: row.text,
      check: null,
      fired_by: by,
      extra: typeof extra === "string" && extra.trim() ? extra : null,
    })
    this.db
      .query(
        "UPDATE wakes SET last_fired_at = ? WHERE agent_id = ? AND name = ?",
      )
      .run(this.now(), agent, name)
    this.history.record("wake.fired", { agent, data: { name, by } })
    return { fired: name, agent }
  }

  // The scheduler's part: expired wakes go, due ones are queued.
  tick(enqueue: Enqueue) {
    const now = this.now()
    const tz = this.timezone()
    for (const row of this.db
      .query(
        "SELECT agent_id, name FROM wakes " +
          "WHERE end_at IS NOT NULL AND end_at <= ?",
      )
      .all(now) as any[]) {
      this.db
        .query("DELETE FROM wakes WHERE agent_id = ? AND name = ?")
        .run(row.agent_id, row.name)
      this.history.record("wake.expired", {
        agent: row.agent_id,
        data: { name: row.name },
      })
    }
    // one bad wake never stops the others
    for (const row of this.db
      .query(
        "SELECT * FROM wakes WHERE next_at IS NOT NULL AND next_at <= ? " +
          "ORDER BY next_at",
      )
      .all(now) as any[])
      try {
        const trigger = JSON.parse(row.trigger) as Trigger
        this.due(row, enqueue)
        if (trigger.kind === "at") {
          this.db
            .query("DELETE FROM wakes WHERE agent_id = ? AND name = ?")
            .run(row.agent_id, row.name)
          continue
        }
        const next = nextRun(trigger, now, { tz, anchor: row.anchor })
        this.db
          .query(
            "UPDATE wakes SET next_at = ?, last_fired_at = ? " +
              "WHERE agent_id = ? AND name = ?",
          )
          .run(next, now, row.agent_id, row.name)
      } catch (err) {
        this.history.record("scheduler.error", {
          agent: row.agent_id,
          data: { wake: row.name, error: (err as Error).message },
        })
      }
    this.idle(enqueue, now)
  }

  private due(row: any, enqueue: Enqueue) {
    enqueue(row.agent_id, {
      wake: row.name,
      text: row.text,
      check: row.check_cmd ?? null,
    })
    this.history.record("wake.due", {
      agent: row.agent_id,
      data: { name: row.name },
    })
  }

  /*
   * Idle wakes: once per idle stretch (the time the session's last turn
   * ended), when the session has been idle that long; with repeat, again each
   * time the duration passes while it stays idle.
   */
  private idle(enqueue: Enqueue, now: number) {
    const rows = this.db
      .query(
        `SELECT w.*, s.busy, s.idle_since, a.registered_at
         FROM wakes w
         JOIN agents a ON a.id = w.agent_id
         JOIN sessions s ON s.id = a.session_id
         WHERE w.next_at IS NULL AND w.trigger LIKE '%"kind":"idle"%'`,
      )
      .all() as any[]
    for (const row of rows) {
      if (row.busy) continue
      const trigger = JSON.parse(row.trigger) as Extract<
        Trigger,
        { kind: "idle" }
      >
      const since = row.idle_since ?? row.registered_at
      const sameStretch = row.idle_fired_for === since
      if (!trigger.repeat && sameStretch) continue
      const last = sameStretch && row.idle_last_at ? row.idle_last_at : since
      if (now < last + trigger.idle_ms) continue
      this.due(row, enqueue)
      this.db
        .query(
          "UPDATE wakes SET idle_fired_for = ?, idle_last_at = ?, " +
            "last_fired_at = ? WHERE agent_id = ? AND name = ?",
        )
        .run(since, now, now, row.agent_id, row.name)
    }
  }

  // A check's outcome: failures in a row, reset by any check that ran.
  checkFailed(agent: string, name: string): number {
    this.db
      .query(
        "UPDATE wakes SET check_failures = check_failures + 1 " +
          "WHERE agent_id = ? AND name = ?",
      )
      .run(agent, name)
    const row = this.db
      .query("SELECT check_failures FROM wakes WHERE agent_id = ? AND name = ?")
      .get(agent, name) as any
    return row?.check_failures ?? 0
  }

  checkRan(agent: string, name: string) {
    this.db
      .query(
        "UPDATE wakes SET check_failures = 0 WHERE agent_id = ? AND name = ?",
      )
      .run(agent, name)
  }
}
