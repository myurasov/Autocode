/*
 * The error state and retries (spec, Retries and Resume; tier 0b3): a
 * registered agent whose turn failed is in the error state until a turn of
 * its session succeeds. Autocode retries with a prompt every retry_interval,
 * at most retry_attempts times (0: no limit), and tells the owner when it
 * stops; failures that would fail the same way again are not retried. The
 * owner can ask for a retry at once.
 */
import type { Database } from "bun:sqlite"
import {
  AutocodeError,
  localTime,
  parseDuration,
  resolveSettings,
} from "@autocode/shared"
import type { History } from "./history.ts"
import type { Inbox } from "./messages.ts"
import type { SettingsStore } from "./settings-store.ts"

// OpenCode's error types that fail again the same way: not retried.
export const NOT_RETRIED = new Set([
  "provider.auth",
  "provider.invalid-request",
  "provider.content-filter",
  "provider.unknown",
  "provider.unsupported-operation",
])

export const retryable = (type: string) => !NOT_RETRIED.has(type)

export interface ErrorView {
  // OpenCode's error type, or "failed" when it gave none
  type: string
  since: string
  at: string
  retries: number
  next_retry: string | null
  retryable: boolean
}

const iso = (ms: number) => new Date(ms).toISOString()

// An agent row's error state, for its views; undefined when there is none.
export function errorView(row: any): ErrorView | undefined {
  if (!row?.error) return undefined
  return {
    type: row.error,
    since: iso(row.error_since),
    at: iso(row.error_at),
    retries: row.retries ?? 0,
    next_retry: row.retry_at == null ? null : iso(row.retry_at),
    retryable: retryable(row.error),
  }
}

// What a retry prompt says, for Delivery.
export interface RetryNote {
  n: number
  of: number
  // the header's part, like "retry 3" or "retry 3 of 5"
  header: string
  // the prompt's first part
  text: string
}

export class Retries {
  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly settings: SettingsStore,
    private readonly inbox: Inbox,
    private readonly now: () => number,
  ) {}

  // An agent whose failed turns are not retried (or no longer): a run of a
  // job fails then (tier 0f).
  onGivenUp: (agent: string, reason: string) => void = () => {}

  private row(agent: string): any {
    return this.db.query("SELECT * FROM agents WHERE id = ?").get(agent)
  }

  private values(agent: string) {
    return resolveSettings(this.settings.layers(), agent).values
  }

  private interval(agent: string): number {
    return parseDuration(String(this.values(agent).retry_interval))
  }

  private attempts(agent: string): number {
    return Number(this.values(agent).retry_attempts) || 0
  }

  private set(agent: string, fields: Record<string, unknown>) {
    const keys = Object.keys(fields)
    this.db
      .query(
        `UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(", ")} ` +
          "WHERE id = ?",
      )
      .run(...(Object.values(fields) as any[]), agent)
  }

  // The next retry an interval from now, when one may still come.
  private plan(agent: string, row: any) {
    const max = this.attempts(agent)
    if (!retryable(row.error) || (max && row.retries >= max)) return false
    this.set(agent, { retry_at: this.now() + this.interval(agent) })
    return true
  }

  // A turn of an agent's session ended: succeeded, failed or interrupted.
  turnEnded(agent: string, outcome: string, error: string | null) {
    const row = this.row(agent)
    if (!row) return
    const now = this.now()
    if (outcome === "succeeded") {
      if (!row.error) return
      this.set(agent, {
        error: null,
        error_since: null,
        error_at: null,
        retries: 0,
        retry_at: null,
      })
      this.history.record("agent.recovered", {
        agent,
        data: { error: row.error, retries: row.retries },
      })
      this.inbox.closeErrorAlerts(agent)
      return
    }
    if (outcome === "interrupted") {
      // the owner (or the agent) stopped it: the error stays, the next
      // retry an interval later
      if (row.error) this.plan(agent, row)
      return
    }
    if (outcome !== "failed") return
    const type = error || "failed"
    const first = !row.error
    this.set(agent, {
      error: type,
      error_since: row.error_since ?? now,
      error_at: now,
      retry_at: null,
    })
    if (first)
      this.history.record("agent.error", { agent, data: { error: type } })
    const failed = { ...row, error: type }
    if (!retryable(type)) {
      try {
        this.onGivenUp(agent, `its turn failed (${type}); not retried`)
      } catch {}
      // one alert as the agent comes to an error that is not retried
      if (first || retryable(row.error))
        this.inbox.open("alert", {
          agent,
          title: `Agent ${agent}: its turn failed (${type}); not retried`,
          body:
            "This error comes back the same way when retried. Fix its " +
            "cause, then retry from the Agents page or with `autocode " +
            `retry ${agent}\`.`,
        })
      return
    }
    if (this.plan(agent, failed)) return
    try {
      this.onGivenUp(
        agent,
        `its turns still fail after ${row.retries} retries (${type})`,
      )
    } catch {}
    this.history.record("retry.exhausted", {
      agent,
      data: { error: type, retries: row.retries },
    })
    this.inbox.open("alert", {
      agent,
      title:
        `Agent ${agent}: its turns still fail after ${row.retries} ` +
        `retries (${type})`,
      body:
        "Autocode stopped retrying. Retry from the Agents page or with " +
        `\`autocode retry ${agent}\`; retry_attempts sets how many retries ` +
        "come (0: no limit).",
    })
  }

  // The owner's retry: one now (the count starts again after a stop).
  request(agent: string, by: string) {
    const row = this.row(agent)
    if (!row)
      throw new AutocodeError("not_registered", `no agent ${agent}`, 404)
    if (!row.error)
      throw new AutocodeError(
        "not_in_error",
        `${agent} is not in the error state`,
        409,
      )
    const max = this.attempts(agent)
    const stopped = !retryable(row.error) || (max && row.retries >= max)
    this.set(agent, {
      retry_at: this.now(),
      ...(stopped ? { retries: 0 } : {}),
    })
    this.history.record("retry.requested", { agent, data: { by } })
  }

  // The agents whose retry is due.
  due(): string[] {
    return (
      this.db
        .query(
          "SELECT id FROM agents WHERE retry_at IS NOT NULL AND retry_at <= ?",
        )
        .all(this.now()) as { id: string }[]
    ).map((r) => r.id)
  }

  /*
   * The retry an agent row is due for (null when none is): its number, and
   * what its prompt says, in the server's zone.
   */
  note(row: any, tz: string): RetryNote | null {
    if (!row?.error || row.retry_at == null || this.now() < row.retry_at)
      return null
    const n = (row.retries ?? 0) + 1
    const of = this.attempts(row.id)
    const when =
      row.error_since !== row.error_at
        ? `at ${localTime(row.error_at, tz)}; ` +
          `failing since ${localTime(row.error_since, tz)}`
        : `at ${localTime(row.error_at, tz)}`
    return {
      n,
      of,
      header: `retry ${n}${of && n <= of ? ` of ${of}` : ""}`,
      text:
        `Your last turn failed: ${row.error} (${when}). ` +
        "Continue where you left off.",
    }
  }

  // A retry prompt went out.
  sent(agent: string, note: RetryNote) {
    this.set(agent, { retries: note.n, retry_at: null })
    this.history.record("retry.sent", {
      agent,
      data: { n: note.n, error: this.row(agent)?.error ?? null },
    })
  }

  /*
   * A retry prompt that never reached the session (it failed, or a pause took
   * it back): it does not count, and comes again (at once after a pause).
   */
  unsent(agent: string, wait: boolean) {
    const row = this.row(agent)
    if (!row?.error) return
    this.set(agent, {
      retries: Math.max(0, (row.retries ?? 0) - 1),
      retry_at: this.now() + (wait ? this.interval(agent) : 0),
    })
  }

  // A retry prompt that started no turn: the next one an interval later.
  noTurn(agent: string) {
    const row = this.row(agent)
    if (row?.error && row.retry_at == null) this.plan(agent, row)
  }

  // An agent moved to another session: its old session's error goes.
  clear(agent: string) {
    this.set(agent, {
      error: null,
      error_since: null,
      error_at: null,
      retries: 0,
      retry_at: null,
    })
  }
}
