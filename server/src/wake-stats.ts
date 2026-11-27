/*
 * What each wake costs (spec, Wakes; 1.1.0, the owner, 2026-11-20: one
 * hourly wake cost $225 in a week and nothing showed it). Per agent, wake
 * name and day: how often the wake fell due, how often its check skipped
 * it, the turns its prompts started, and those turns' steps and dollars. A
 * session's turn is its prompt's (sessions.turn_cause, an injection's ID)
 * from its start until the session's next turn starts; a prompt with
 * several wakes divides a step's cost among them equally. A turn that
 * OpenCode's own notice starts (a Subagent's result, a background shell's
 * end) keeps the prompt of the turn before it: one more turn of the same
 * wakes (1.1.0-rc2; the owner, 2026-11-20: "can we fix that?").
 */

import type { Database } from "bun:sqlite"
import { dayBefore } from "./costs.ts"
import type { TurnWork } from "./turn-work.ts"

// A wake's last 7 days: today and the six days before, the server's days.
export interface WakeWeek {
  due: number
  skipped: number
  turns: number
  usd: number
  // of usd, what its turns' first steps cost to load the context
  // (1.1.0-rc7)
  reload_usd: number
}

const NONE: WakeWeek = { due: 0, skipped: 0, turns: 0, usd: 0, reload_usd: 0 }
// to a millionth of a dollar
const round = (n: number) => Math.round(n * 1e6) / 1e6

export class WakeStats {
  constructor(
    private readonly db: Database,
    // the server's day (YYYY-MM-DD) of a time, by default now
    private readonly day: (at?: number) => string,
    private readonly now: () => number,
  ) {}

  // The work that outlives its turn (exact attribution): set by the server.
  work?: TurnWork

  private add(
    agent: string,
    name: string,
    field: "due" | "skipped" | "turns" | "steps",
    usd = 0,
    reload = 0,
  ) {
    this.db
      .query(
        `INSERT INTO wake_stats (agent_id, name, day, ${field}, usd,
           reload_usd)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT (agent_id, name, day) DO UPDATE SET
           ${field} = ${field} + 1, usd = usd + excluded.usd,
           reload_usd = reload_usd + excluded.reload_usd`,
      )
      .run(agent, name, this.day(), usd, reload)
  }

  // A wake fell due (by its time, or by idle time).
  due(agent: string, name: string) {
    this.add(agent, name, "due")
  }

  // Its check skipped that run.
  skipped(agent: string, name: string) {
    this.add(agent, name, "skipped")
  }

  // The agent and the wakes of the prompt that started a session's turn.
  private cause(injection: string): { agent: string; wakes: string[] } | null {
    const row = this.db
      .query("SELECT agent_id, reasons FROM injections WHERE id = ?")
      .get(injection) as { agent_id: string; reasons: string } | null
    if (!row) return null
    try {
      const wakes = JSON.parse(row.reasons ?? "{}")?.wakes
      return Array.isArray(wakes) && wakes.length
        ? { agent: row.agent_id, wakes: wakes.map(String) }
        : null
    } catch {
      return null
    }
  }

  // A turn started from a prompt of Autocode's, or after such a turn from
  // OpenCode's own notice: a turn of each of that prompt's wakes.
  turnStarted(injection: string | null) {
    const cause = injection ? this.cause(injection) : null
    for (const name of cause?.wakes ?? []) this.add(cause!.agent, name, "turns")
  }

  /*
   * A model step of a session, counted once by the caller: it belongs to
   * the wakes of the prompt that started the session's last turn, in equal
   * shares. A turn the owner started has no such prompt. `reload`: of a
   * turn's first step, what it cost to load the context (1.1.0-rc7).
   */
  step(session: string, usd: number, sub?: unknown, reload = 0) {
    // a Subagent's step (`sub`, its own session) is its work's: the prompt
    // of the turn that started the Subagent, whatever turn runs now
    const own = sub === undefined ? undefined : this.work?.causeOf(session, sub)
    const row =
      own !== undefined
        ? { turn_cause: own }
        : (this.db
            .query("SELECT turn_cause FROM sessions WHERE id = ?")
            .get(session) as { turn_cause: string | null } | null)
    const cause = row?.turn_cause ? this.cause(row.turn_cause) : null
    if (!cause) return
    for (const name of cause.wakes)
      this.add(
        cause.agent,
        name,
        "steps",
        usd / cause.wakes.length,
        reload / cause.wakes.length,
      )
  }

  // Every wake's last 7 days (one agent's), by agent and name.
  week(agent?: string): (agent: string, name: string) => WakeWeek {
    const from = dayBefore(this.day(), 6)
    const rows = this.db
      .query(
        `SELECT agent_id, name, SUM(due) AS due, SUM(skipped) AS skipped,
           SUM(turns) AS turns, SUM(usd) AS usd, SUM(reload_usd) AS reload
         FROM wake_stats WHERE day >= ?${agent ? " AND agent_id = ?" : ""}
         GROUP BY agent_id, name`,
      )
      .all(...(agent ? [from, agent] : [from])) as any[]
    const by = new Map<string, WakeWeek>()
    for (const r of rows)
      by.set(`${r.agent_id}\n${r.name}`, {
        due: r.due,
        skipped: r.skipped,
        turns: r.turns,
        usd: round(r.usd),
        reload_usd: round(r.reload),
      })
    return (a, name) => by.get(`${a}\n${name}`) ?? { ...NONE }
  }

  // An agent unregistered: its wakes are gone, and their numbers.
  forget(agent: string) {
    this.db.query("DELETE FROM wake_stats WHERE agent_id = ?").run(agent)
  }

  // Kept as long as the spend per day: history_days, at least 31 days.
  trim(days: number) {
    this.db
      .query("DELETE FROM wake_stats WHERE day < ?")
      .run(this.day(this.now() - Math.max(days, 31) * 86_400_000))
  }
}
