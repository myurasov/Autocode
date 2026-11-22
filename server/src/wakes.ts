/*
 * Wakes (spec, Wakes): each agent's named wakes with their trigger, text
 * and optional check; setting, listing, cancelling and firing them; when
 * each falls due next; and, on each scheduler tick, the wakes that fell due
 * (by time, or by idle time), handed to the injection queue. A periodic
 * trigger may end (`until`, 1.1.0-rc5): at its end the wake is removed and
 * its agent told.
 */

import type { Database } from "bun:sqlite"
import {
  AutocodeError,
  checkId,
  formatDuration,
  formatTrigger,
  localTime,
  nextRun,
  onlyFields,
  parseDuration,
  parseTrigger,
  type Trigger,
  triggerEnd,
} from "@autocode/shared"
import type { History } from "./history.ts"
import { aliasOf } from "./rename.ts"
import type { WakeStats, WakeWeek } from "./wake-stats.ts"

export interface WakeItem {
  wake: string
  text: string
  check?: string | null
  // the wake's own time limit for its check, in ms (1.1.0)
  check_timeout_ms?: number | null
  fired_by?: string | null
  extra?: string | null
  // the wake's trigger (stored JSON), so its prompt can say what it was
  trigger?: string | null
}

export type Enqueue = (agent: string, item: WakeItem) => void

export interface WakeView {
  agent: string
  name: string
  text: string
  trigger: string
  check: string | null
  // its check's own time limit ("5m"), or null: the owner's check_timeout
  check_timeout: string | null
  next: string | null
  // when it falls due next: its next run, or for an idle wake the time it
  // will if the session stays idle (none while a turn runs)
  due: string | null
  set_by: string
  created_at: string
  updated_at: string
  last_fired_at: string | null
  check_failures: number
  // its last 7 days: due, skipped by its check, turns and dollars (1.1.0)
  week: WakeWeek
}

const MAX_TEXT = 32_000
const MAX_CHECK = 4000
const iso = (ms: number | null) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString()

// The session and agent fields an idle wake's timing needs.
const WITH_SESSION = `
  SELECT w.*, s.busy, s.idle_since, a.registered_at
  FROM wakes w
  JOIN agents a ON a.id = w.agent_id
  JOIN sessions s ON s.id = a.session_id`

/*
 * When an idle wake falls due, if the session stays idle: its idle time counts
 * from the later of the session's idle start (the end of its last turn, or its
 * registration) and the time the wake was set; once per idle stretch, or with
 * repeat again each duration after it last fell due. Null while a turn runs,
 * once a wake without repeat has fallen due in this stretch, or when that
 * time is not before the wake's end.
 */
export function idleDue(
  row: any,
  trigger: Extract<Trigger, { kind: "idle" }>,
): { due: number | null; since: number } {
  const since = Math.max(row.idle_since ?? row.registered_at, row.anchor)
  if (row.busy) return { due: null, since }
  const sameStretch = row.idle_fired_for === since
  if (!trigger.repeat && sameStretch) return { due: null, since }
  const last = sameStretch && row.idle_last_at ? row.idle_last_at : since
  const due = last + trigger.idle_ms
  const end = triggerEnd(trigger)
  return { due: end !== null && due >= end ? null : due, since }
}

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
    // the longest a wake of this agent may ask for its check, in ms (the
    // owner's check_timeout_max)
    private readonly checkMax: (agent: string) => number = () => 600_000,
  ) {}

  /*
   * A wake's own time limit for its check (1.1.0): a duration of at least
   * 1s and at most the owner's check_timeout_max; it needs a check.
   */
  private checkTimeout(agent: string, body: any): number | null {
    const input = body.check_timeout
    if (input === undefined || input === null) return null
    if (!body.check)
      throw new AutocodeError(
        "bad_request",
        "a check_timeout needs a check: it is that check's time limit",
      )
    let ms = Number.NaN
    try {
      if (typeof input === "string" && input.trim()) ms = parseDuration(input)
    } catch {}
    if (!(ms >= 1000))
      throw new AutocodeError(
        "bad_request",
        "a check_timeout is a duration of at least 1s, like 90s or 5m " +
          `(got ${JSON.stringify(input)})`,
      )
    const max = this.checkMax(agent)
    if (ms > max)
      throw new AutocodeError(
        "bad_request",
        `a check may run ${formatDuration(max)} at most here (the owner's ` +
          `check_timeout_max); got ${formatDuration(ms)}`,
      )
    return ms
  }

  // What each wake costs (1.1.0): set by the server once it exists.
  stats?: WakeStats

  // Tells an agent something of Autocode's own (a wake that ended).
  notify: (agent: string, subject: string, text: string) => void = () => {}

  private agentExists(agent: string) {
    if (!this.db.query("SELECT 1 FROM agents WHERE id = ?").get(agent))
      throw new AutocodeError("not_registered", `no agent ${agent}`, 404)
  }

  private view(row: any, week = this.stats?.week(row.agent_id)): WakeView {
    const trigger = JSON.parse(row.trigger) as Trigger
    const due =
      trigger.kind === "idle" ? idleDue(row, trigger).due : row.next_at
    return {
      agent: row.agent_id,
      name: row.name,
      text: row.text,
      trigger: formatTrigger(trigger),
      check: row.check_cmd ?? null,
      check_timeout: row.check_timeout_ms
        ? formatDuration(row.check_timeout_ms)
        : null,
      next: iso(row.next_at),
      due: iso(due ?? null),
      set_by: row.set_by,
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
      last_fired_at: iso(row.last_fired_at),
      check_failures: row.check_failures,
      week: week?.(row.agent_id, row.name) ?? {
        due: 0,
        skipped: 0,
        turns: 0,
        usd: 0,
      },
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
    onlyFields(body, ["text", "trigger", "check", "check_timeout"])
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
    const checkTimeout = this.checkTimeout(agent, body)
    const now = this.now()
    const tz = this.timezone()
    if (typeof body.trigger !== "string")
      throw new AutocodeError("bad_trigger", "a wake needs a trigger")
    const trigger = parseTrigger(body.trigger, { tz, now })
    const next = nextRun(trigger, now, { tz, anchor: now })
    if (trigger.kind === "at" && next === null)
      throw new AutocodeError("bad_trigger", "that time has passed already")
    // a wake with an end must have a run before it (1.1.0-rc5)
    const end = triggerEnd(trigger)
    if (
      end !== null &&
      (trigger.kind === "idle" ? now + trigger.idle_ms >= end : next === null)
    )
      throw new AutocodeError(
        "bad_trigger",
        "the wake would never run: its first run would not come before " +
          `its end (${localTime(end, tz)})`,
      )
    const before = this.db
      .query("SELECT created_at FROM wakes WHERE agent_id = ? AND name = ?")
      .get(agent, name) as any
    this.db.query("SAVEPOINT wake_set").run()
    this.db
      .query(
        `INSERT INTO wakes (agent_id, name, text, trigger, check_cmd,
           check_timeout_ms, anchor, next_at, end_at, set_by, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, name) DO UPDATE SET
           text = excluded.text, trigger = excluded.trigger,
           check_cmd = excluded.check_cmd,
           check_timeout_ms = excluded.check_timeout_ms,
           anchor = excluded.anchor, next_at = excluded.next_at,
           end_at = excluded.end_at,
           set_by = excluded.set_by, updated_at = excluded.updated_at,
           idle_fired_for = NULL, idle_last_at = NULL, check_failures = 0`,
      )
      .run(
        agent,
        name,
        text,
        JSON.stringify(trigger),
        check ?? null,
        checkTimeout,
        now,
        next,
        end,
        by,
        now,
        now,
      )
    // the wake's view must hold (its times are dates); else nothing is set
    let wake: WakeView
    try {
      wake = this.get(agent, name)
    } catch (err) {
      this.db.query("ROLLBACK TO wake_set").run()
      this.db.query("RELEASE wake_set").run()
      throw err instanceof AutocodeError
        ? err
        : new AutocodeError("bad_trigger", `bad trigger: ${body.trigger}`)
    }
    this.db.query("RELEASE wake_set").run()
    this.history.record("wake.set", {
      agent,
      data: { name, trigger: formatTrigger(trigger), by, replaced: !!before },
    })
    return { status: before ? 200 : 201, wake }
  }

  get(agent: string, name: string): WakeView {
    const row = this.db
      .query(`${WITH_SESSION} WHERE w.agent_id = ? AND w.name = ?`)
      .get(agent, name)
    if (!row)
      throw new AutocodeError("no_wake", `${agent} has no wake ${name}`, 404)
    return this.view(row)
  }

  list(agent?: string): WakeView[] {
    const rows = agent
      ? this.db
          .query(`${WITH_SESSION} WHERE w.agent_id = ? ORDER BY w.name`)
          .all(agent)
      : this.db.query(`${WITH_SESSION} ORDER BY w.agent_id, w.name`).all()
    const week = this.stats?.week(agent)
    return (rows as any[]).map((r) => this.view(r, week))
  }

  // An agent's wakes in short: how many, and the one due first.
  summary(agent: string): {
    count: number
    next: { name: string; due: string } | null
  } {
    const wakes = this.list(agent)
    const timed = wakes
      .filter((w) => w.due !== null)
      .sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!))
    const first = timed[0]
    return {
      count: wakes.length,
      next: first ? { name: first.name, due: first.due! } : null,
    }
  }

  // The stored wake, for its prompt (undefined once a one-time wake ran).
  row(agent: string, name: string): any {
    return this.db
      .query("SELECT * FROM wakes WHERE agent_id = ? AND name = ?")
      .get(agent, name)
  }

  cancel(agent: string, nameInput: unknown, by: string) {
    const name = checkId(nameInput, "wake name")
    const res = this.db
      .query("DELETE FROM wakes WHERE agent_id = ? AND name = ?")
      .run(agent, name)
    // its runs that wait to be delivered go with it: also the run of a
    // one-time wake that is gone already (an `at` wake after its time, a
    // `fire-only once` wake after its fire: 1.1.0)
    const waiting = this.db
      .query(
        "DELETE FROM queue WHERE agent_id = ? AND kind = 'wake' AND wake = ?",
      )
      .run(agent, name)
    if (!res.changes && !waiting.changes)
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
    // a renamed agent's old ID forwards to it (1.1.0)
    if (!this.db.query("SELECT 1 FROM agents WHERE id = ?").get(agent))
      agent = aliasOf(this.db, agent) ?? agent
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
      trigger: row.trigger,
      fired_by: by,
      extra: typeof extra === "string" && extra.trim() ? extra : null,
    })
    // `fire-only once` (1.1.0): fired once, then removed, as an `at` wake
    // is after its time; its run waits for delivery like any other
    const trigger = JSON.parse(row.trigger) as Trigger
    const once = trigger.kind === "fire-only" && trigger.once === true
    if (once)
      this.db
        .query("DELETE FROM wakes WHERE agent_id = ? AND name = ?")
        .run(agent, name)
    else
      this.db
        .query(
          "UPDATE wakes SET last_fired_at = ? WHERE agent_id = ? AND name = ?",
        )
        .run(this.now(), agent, name)
    this.history.record("wake.fired", {
      agent,
      data: { name, by, ...(once ? { once: true } : {}) },
    })
    return { fired: name, agent }
  }

  /*
   * Wakes whose end has come (1.1.0-rc5) are removed, and their agents
   * told. A run that fell due before and still waits is delivered. This
   * comes before the due wakes, so that a server that was down across an
   * end delivers no late run.
   */
  private ended(now: number, tz: string) {
    for (const row of this.db
      .query(
        "SELECT * FROM wakes WHERE end_at IS NOT NULL AND end_at <= ? " +
          "ORDER BY end_at, agent_id, name",
      )
      .all(now) as any[])
      try {
        this.db
          .query("DELETE FROM wakes WHERE agent_id = ? AND name = ?")
          .run(row.agent_id, row.name)
        const trigger = JSON.parse(row.trigger) as Trigger
        this.history.record("wake.ended", {
          agent: row.agent_id,
          data: { name: row.name, trigger: formatTrigger(trigger) },
        })
        const shown = formatTrigger(trigger, (iso) =>
          localTime(Date.parse(iso), tz),
        )
        this.notify(
          row.agent_id,
          `wake "${row.name}" ended`,
          `Your wake "${row.name}" (${shown}) reached its end and was ` +
            "removed. If it is still needed, set it again (autocode_wake " +
            "action=set).",
        )
      } catch (err) {
        this.history.record("scheduler.error", {
          agent: row.agent_id,
          data: { wake: row.name, error: (err as Error).message },
        })
      }
  }

  // The scheduler's part: due wakes are queued (a one-time one then goes).
  tick(enqueue: Enqueue) {
    const now = this.now()
    const tz = this.timezone()
    this.ended(now, tz)
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
      check_timeout_ms: row.check_timeout_ms ?? null,
      trigger: row.trigger,
    })
    this.stats?.due(row.agent_id, row.name)
    this.history.record("wake.due", {
      agent: row.agent_id,
      data: { name: row.name },
    })
  }

  // Idle wakes that fell due (idleDue says when).
  private idle(enqueue: Enqueue, now: number) {
    const rows = this.db
      .query(
        `${WITH_SESSION} WHERE w.next_at IS NULL ` +
          `AND w.trigger LIKE '%"kind":"idle"%'`,
      )
      .all() as any[]
    for (const row of rows) {
      const trigger = JSON.parse(row.trigger) as Extract<
        Trigger,
        { kind: "idle" }
      >
      const { due, since } = idleDue(row, trigger)
      if (due === null || now < due) continue
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
