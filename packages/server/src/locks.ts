/*
 * Locks and semaphores (spec, Locks and Semaphores; tier 0c). A lock has a
 * name and a capacity (1: a mutex, N: a semaphore), set by the acquire that
 * creates it. Agents hold it for a ttl (renewable) or wait in its queue in
 * arrival order; a place that comes free (a release, an expiry, an unregister)
 * goes to the oldest in the queue, who gets a notice; an expired hold is
 * freed and its former holder told. A lock with no holders and no queue is
 * removed. Every change is one transaction, so concurrent calls never exceed
 * a capacity; a hold past its ttl is freed before any change to its lock, so
 * it counts as free even before the scheduler's tick.
 */
import type { Database } from "bun:sqlite"
import {
  AutocodeError,
  checkId,
  matchesPattern,
  parseDuration,
  parsePattern,
} from "@autocode/shared"
import type { History } from "./history.ts"

const MAX_CAPACITY = 1000
const MAX_TTL = 30 * 86_400_000

export interface LockNotice {
  agent: string
  kind: "granted" | "expired" | "released" | "removed"
  lock: string
  max: number
  // granted: until when, and the ttl it counts
  expires?: number
  ttl?: number
  // expired: when it ran out; released, removed: when, and by whom
  at?: number
  by?: string
}

export interface LockView {
  name: string
  max: number
  created_at: string
  holders: { agent: string; since: string; expires: string; ttl: string }[]
  queue: { agent: string; position: number; since: string; ttl: string }[]
}

export interface AcquireOptions {
  ttl: string | number
  max?: number
  mode?: "try" | "queue" | "wait"
}

export interface AcquireResult {
  granted: boolean
  // granted: until when; queued: the place in the queue (1: next)
  expires?: string
  position?: number
  lock: LockView
}

const iso = (ms: number) => new Date(ms).toISOString()

// A ttl in one unit: 90m stays 90m, 1h is 1h.
export const formatTtl = (ms: number) => {
  for (const [unit, size] of [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ] as const)
    if (ms % size === 0) return `${ms / size}${unit}`
  return `${ms}ms`
}

export class Locks {
  // Calls waiting inside acquire (mode wait), by lock.
  private readonly waiters = new Map<string, Set<() => void>>()
  private closed = false

  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly now: () => number,
    // A grant, an expiry or the owner's release, for the agent to be told.
    private readonly notify: (notice: LockNotice) => void,
  ) {}

  private ttlOf(value: unknown): number {
    if (value === undefined || value === null || value === "")
      throw new AutocodeError(
        "bad_request",
        "acquire needs a ttl: how long you hold the lock, like 10m or 6h",
      )
    const ms = parseDuration(value as string | number)
    if (ms < 1000 || ms > MAX_TTL)
      throw new AutocodeError(
        "bad_request",
        "a ttl is from 1s to 30d (renew to hold longer)",
      )
    return ms
  }

  private lockRow(name: string): any {
    return this.db.query("SELECT * FROM locks WHERE name = ?").get(name)
  }

  private entry(name: string, agent: string): any {
    return this.db
      .query("SELECT * FROM lock_entries WHERE lock = ? AND agent_id = ?")
      .get(name, agent)
  }

  private view(row: any): LockView {
    const entries = this.db
      .query("SELECT * FROM lock_entries WHERE lock = ? ORDER BY id")
      .all(row.name) as any[]
    const held = entries
      .filter((e) => e.held)
      .sort((x, y) => x.granted_at - y.granted_at || x.id - y.id)
    const queued = entries.filter((e) => !e.held)
    return {
      name: row.name,
      max: row.max,
      created_at: iso(row.created_at),
      holders: held.map((e) => ({
        agent: e.agent_id,
        since: iso(e.granted_at),
        expires: iso(e.expires_at),
        ttl: formatTtl(e.ttl),
      })),
      queue: queued.map((e, i) => ({
        agent: e.agent_id,
        position: i + 1,
        since: iso(e.queued_at),
        ttl: formatTtl(e.ttl),
      })),
    }
  }

  private position(name: string, agent: string): number {
    const ids = (
      this.db
        .query(
          "SELECT agent_id FROM lock_entries WHERE lock = ? AND held = 0 " +
            "ORDER BY id",
        )
        .all(name) as { agent_id: string }[]
    ).map((r) => r.agent_id)
    return ids.indexOf(agent) + 1
  }

  private heldCount(name: string): number {
    return (
      this.db
        .query(
          "SELECT COUNT(*) AS n FROM lock_entries WHERE lock = ? AND held = 1",
        )
        .get(name) as { n: number }
    ).n
  }

  // Frees a lock's holds past their ttl (inside a transaction).
  private expire(name: string): LockNotice[] {
    const now = this.now()
    const row = this.lockRow(name)
    const out: LockNotice[] = []
    for (const e of this.db
      .query(
        "SELECT * FROM lock_entries WHERE lock = ? AND held = 1 " +
          "AND expires_at <= ? ORDER BY expires_at, id",
      )
      .all(name, now) as any[]) {
      this.db.query("DELETE FROM lock_entries WHERE id = ?").run(e.id)
      this.history.record("lock.expired", {
        agent: e.agent_id,
        data: { lock: name, ttl: formatTtl(e.ttl) },
      })
      out.push({
        agent: e.agent_id,
        kind: "expired",
        lock: name,
        max: row?.max ?? 1,
        at: e.expires_at,
        ttl: e.ttl,
      })
    }
    return out.length ? [...out, ...this.grant(name)] : out
  }

  // Frees a lock's holds past their ttl, before a change to it.
  private settle(name: string) {
    const notices = this.db.transaction(() => this.expire(name))()
    if (notices.length) this.after(name, notices)
  }

  // Free places go to the oldest in the queue; an empty lock is removed.
  private grant(name: string): LockNotice[] {
    const row = this.lockRow(name)
    if (!row) return []
    const out: LockNotice[] = []
    const now = this.now()
    let free = row.max - this.heldCount(name)
    while (free > 0) {
      const next = this.db
        .query(
          "SELECT * FROM lock_entries WHERE lock = ? AND held = 0 " +
            "ORDER BY id LIMIT 1",
        )
        .get(name) as any
      if (!next) break
      this.db
        .query(
          "UPDATE lock_entries SET held = 1, granted_at = ?, expires_at = ? " +
            "WHERE id = ?",
        )
        .run(now, now + next.ttl, next.id)
      this.history.record("lock.acquired", {
        agent: next.agent_id,
        data: { lock: name, max: row.max, queued: true },
      })
      out.push({
        agent: next.agent_id,
        kind: "granted",
        lock: name,
        max: row.max,
        expires: now + next.ttl,
        ttl: next.ttl,
      })
      free--
    }
    if (
      !(this.db
        .query("SELECT 1 FROM lock_entries WHERE lock = ? LIMIT 1")
        .get(name) as any)
    )
      this.db.query("DELETE FROM locks WHERE name = ?").run(name)
    return out
  }

  // After a change: tell the agents (one that cannot be told does not stop
  // the others), and wake the calls waiting on the lock.
  private after(name: string, notices: LockNotice[]) {
    try {
      for (const n of notices)
        try {
          this.notify(n)
        } catch {}
    } finally {
      for (const done of this.waiters.get(name) ?? []) done()
    }
  }

  acquire(agent: string, nameInput: string, opts: AcquireOptions) {
    const name = checkId(nameInput, "lock name")
    const ttl = this.ttlOf(opts?.ttl)
    const mode = opts.mode ?? "queue"
    if (!["try", "queue", "wait"].includes(mode))
      throw new AutocodeError("bad_request", "mode is try, queue or wait")
    if (
      opts.max !== undefined &&
      (!Number.isInteger(opts.max) || opts.max < 1 || opts.max > MAX_CAPACITY)
    )
      throw new AutocodeError(
        "bad_request",
        `max is a whole number from 1 to ${MAX_CAPACITY}`,
      )
    this.settle(name)
    let notices: LockNotice[] = []
    const result = this.db.transaction((): AcquireResult => {
      const now = this.now()
      let row = this.lockRow(name)
      if (row && opts.max !== undefined && opts.max !== row.max)
        throw new AutocodeError(
          "lock_capacity",
          `lock ${name} has capacity ${row.max}, not ${opts.max}`,
          409,
          { max: row.max },
        )
      if (!row) {
        this.db
          .query("INSERT INTO locks (name, max, created_at) VALUES (?, ?, ?)")
          .run(name, opts.max ?? 1, now)
        row = this.lockRow(name)
      }
      const mine = this.entry(name, agent)
      if (mine?.held) {
        // its holder again: the hold renewed to the new ttl
        this.db
          .query("UPDATE lock_entries SET ttl = ?, expires_at = ? WHERE id = ?")
          .run(ttl, now + ttl, mine.id)
        this.history.record("lock.renewed", {
          agent,
          data: { lock: name, ttl: formatTtl(ttl) },
        })
        return {
          granted: true,
          expires: iso(now + ttl),
          lock: this.view(row),
        }
      }
      const line = this.db
        .query("SELECT 1 FROM lock_entries WHERE lock = ? AND held = 0 LIMIT 1")
        .get(name)
      if (!mine && !line && this.heldCount(name) < row.max) {
        this.db
          .query(
            `INSERT INTO lock_entries (lock, agent_id, held, ttl, queued_at,
               granted_at, expires_at) VALUES (?, ?, 1, ?, ?, ?, ?)`,
          )
          .run(name, agent, ttl, now, now, now + ttl)
        this.history.record("lock.acquired", {
          agent,
          data: { lock: name, max: row.max },
        })
        return {
          granted: true,
          expires: iso(now + ttl),
          lock: this.view(row),
        }
      }
      if (mode === "try") {
        const view = this.view(row)
        const by = view.holders.map((h) => h.agent).join(", ")
        throw new AutocodeError(
          "lock_busy",
          `lock ${name} is held by ${by}` +
            (view.queue.length ? ` (${view.queue.length} queued)` : ""),
          409,
          { lock: view },
        )
      }
      // queued already: it keeps its place, with the new ttl
      if (mine) {
        this.db
          .query("UPDATE lock_entries SET ttl = ? WHERE id = ?")
          .run(ttl, mine.id)
        return {
          granted: false,
          position: this.position(name, agent),
          lock: this.view(row),
        }
      }
      this.db
        .query(
          `INSERT INTO lock_entries (lock, agent_id, held, ttl, queued_at)
           VALUES (?, ?, 0, ?, ?)`,
        )
        .run(name, agent, ttl, now)
      const position = this.position(name, agent)
      this.history.record("lock.queued", {
        agent,
        data: { lock: name, max: row.max, position },
      })
      notices = this.grant(name)
      return { granted: false, position, lock: this.view(row) }
    })()
    this.after(name, notices)
    return result
  }

  /*
   * Waits up to `ms` (real time) until the agent holds the lock or leaves its
   * line; the state then.
   */
  async wait(
    agent: string,
    name: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<{ held: boolean; position?: number; expires?: string }> {
    const deadline = Date.now() + ms
    for (;;) {
      this.settle(name)
      const e = this.entry(name, agent)
      if (!e) return { held: false }
      if (e.held) return { held: true, expires: iso(e.expires_at) }
      if (this.closed || Date.now() >= deadline || signal?.aborted)
        return { held: false, position: this.position(name, agent) }
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(name) ?? new Set()
        this.waiters.set(name, set)
        const done = () => {
          clearTimeout(timer)
          set.delete(done)
          if (!set.size) this.waiters.delete(name)
          signal?.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
        signal?.addEventListener("abort", done)
        set.add(done)
      })
    }
  }

  renew(agent: string, nameInput: string, ttlInput?: string | number) {
    const name = checkId(nameInput, "lock name")
    this.settle(name)
    const e = this.entry(name, agent)
    if (!this.lockRow(name))
      throw new AutocodeError("no_lock", `no lock ${name}`, 404)
    if (!e?.held)
      throw new AutocodeError(
        "not_held",
        `${agent} does not hold lock ${name}`,
        404,
      )
    const ttl =
      ttlInput === undefined || ttlInput === null || ttlInput === ""
        ? e.ttl
        : this.ttlOf(ttlInput)
    const expires = this.now() + ttl
    this.db
      .query("UPDATE lock_entries SET ttl = ?, expires_at = ? WHERE id = ?")
      .run(ttl, expires, e.id)
    this.history.record("lock.renewed", {
      agent,
      data: { lock: name, ttl: formatTtl(ttl) },
    })
    return { expires: iso(expires), lock: this.view(this.lockRow(name)) }
  }

  // Frees a hold, or leaves the queue.
  release(
    agent: string,
    nameInput: string,
    by: "self" | "owner" | "unregister" = "self",
  ): { released: "held" | "queued" } {
    const name = checkId(nameInput, "lock name")
    this.settle(name)
    let notices: LockNotice[] = []
    const out = this.db.transaction(() => {
      const row = this.lockRow(name)
      if (!row) throw new AutocodeError("no_lock", `no lock ${name}`, 404)
      const e = this.entry(name, agent)
      if (!e)
        throw new AutocodeError(
          "not_held",
          `${agent} does not hold lock ${name} and is not in its queue`,
          404,
        )
      this.db.query("DELETE FROM lock_entries WHERE id = ?").run(e.id)
      this.history.record(e.held ? "lock.released" : "lock.left", {
        agent,
        data: { lock: name, by },
      })
      notices = this.grant(name)
      if (by === "owner")
        notices.unshift({
          agent,
          kind: e.held ? "released" : "removed",
          lock: name,
          max: row.max,
          at: this.now(),
          by: "owner",
        })
      return { released: e.held ? ("held" as const) : ("queued" as const) }
    })()
    this.after(name, notices)
    return out
  }

  // Frees the holds that ran out; their former holders are told.
  tick() {
    const names = (
      this.db
        .query(
          "SELECT DISTINCT lock FROM lock_entries WHERE held = 1 " +
            "AND expires_at <= ? ORDER BY lock",
        )
        .all(this.now()) as { lock: string }[]
    ).map((r) => r.lock)
    for (const name of names) this.settle(name)
  }

  /*
   * At the start: entries of agents that are gone (a crash between an
   * unregister and its release) are removed, and the next in the queue granted.
   */
  sweep() {
    const names = (
      this.db
        .query(
          "SELECT DISTINCT lock FROM lock_entries WHERE agent_id NOT IN " +
            "(SELECT id FROM agents) ORDER BY lock",
        )
        .all() as { lock: string }[]
    ).map((r) => r.lock)
    for (const name of names) {
      const notices = this.db.transaction(() => {
        this.db
          .query(
            "DELETE FROM lock_entries WHERE lock = ? AND agent_id NOT IN " +
              "(SELECT id FROM agents)",
          )
          .run(name)
        return this.grant(name)
      })()
      this.after(name, notices)
    }
  }

  // The server stops: waits end.
  close() {
    this.closed = true
    for (const set of this.waiters.values()) for (const done of set) done()
  }

  // An agent unregistered: its holds released, its queues left.
  unregistered(agent: string) {
    const names = (
      this.db
        .query(
          "SELECT lock FROM lock_entries WHERE agent_id = ? ORDER BY held, id",
        )
        .all(agent) as { lock: string }[]
    ).map((r) => r.lock)
    // its places in the queue first, so a freed hold never goes to it
    for (const name of names)
      try {
        this.release(agent, name, "unregister")
      } catch {}
  }

  get(name: string): LockView | undefined {
    const row = this.lockRow(name)
    return row ? this.view(row) : undefined
  }

  list(match?: string | null): LockView[] {
    const pattern = match ? parsePattern(match) : null
    return (this.db.query("SELECT * FROM locks ORDER BY name").all() as any[])
      .filter((r) => !pattern || matchesPattern(pattern, r.name))
      .map((r) => this.view(r))
  }

  // What an agent holds and where it waits.
  of(agent: string) {
    const rows = this.db
      .query(
        `SELECT e.*, l.max FROM lock_entries e JOIN locks l ON l.name = e.lock
         WHERE e.agent_id = ? ORDER BY e.lock`,
      )
      .all(agent) as any[]
    return {
      held: rows
        .filter((r) => r.held)
        .map((r) => ({ name: r.lock, expires: iso(r.expires_at), max: r.max })),
      queued: rows
        .filter((r) => !r.held)
        .map((r) => ({
          name: r.lock,
          position: this.position(r.lock, agent),
          max: r.max,
        })),
    }
  }
}
