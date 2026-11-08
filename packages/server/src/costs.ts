/*
 * Tier 0e: costs, the daily cap, compaction, cut turns and expiry (spec,
 * Costs and Caps; Context Size; Retries and Resume; Expiry and History).
 * The plugin reports each model step's cost and context (session.step.ended);
 * they add up per agent and day in the server's zone. At cap_warn of
 * daily_usd the agent gets one notice a day; past the cap, once its turn
 * ends, it is paused ("cap") and the owner alerted, until the next day, a
 * higher cap or a resume. A session whose last context passed compact_at
 * (or that asked) is compacted before its next injection. A turn that was
 * running when its OpenCode went away is "cut" and gets a resume prompt.
 * An agent expire_after its last turn is unregistered.
 */
import type { Database } from "bun:sqlite"
import { parseDuration, resolveSettings, wallTime } from "@autocode/shared"
import type { History } from "./history.ts"
import type { Inbox } from "./messages.ts"
import type { SettingsStore } from "./settings-store.ts"

const MAX_STEP_USD = 1000
const MAX_COMPACT = 500_000

export interface CostNotice {
  agent: string
  subject: string
  text: string
}

const usd = (n: number) => `$${n.toFixed(2)}`

export class Costs {
  constructor(
    private readonly db: Database,
    private readonly history: History,
    private readonly settings: SettingsStore,
    private readonly inbox: Inbox,
    private readonly now: () => number,
    private readonly notify: (n: CostNotice) => void,
    // the agent's session runs a turn now
    private readonly busy: (agent: string) => boolean,
  ) {}

  private values(agent: string) {
    return resolveSettings(this.settings.layers(), agent).values
  }

  // Today in the server's zone, YYYY-MM-DD.
  day(at = this.now()): string {
    const tz = String(this.settings.value("timezone")) || "UTC"
    const w = wallTime(at, tz)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${w.year}-${pad(w.month)}-${pad(w.day)}`
  }

  // An agent's spend over all days (a run's cost, which may cross midnight),
  // to a millionth of a dollar.
  total(agent: string): number {
    const usd =
      (
        this.db
          .query("SELECT SUM(usd) AS usd FROM costs WHERE agent_id = ?")
          .get(agent) as any
      )?.usd ?? 0
    return Math.round(usd * 1e6) / 1e6
  }

  today(agent: string): number {
    return (
      (
        this.db
          .query("SELECT usd FROM costs WHERE agent_id = ? AND day = ?")
          .get(agent, this.day()) as any
      )?.usd ?? 0
    )
  }

  private cap(agent: string): number | null {
    const v = this.values(agent).daily_usd
    return v === "off" || v === undefined || v === null ? null : Number(v)
  }

  view(agent: string) {
    const row = this.db
      .query("SELECT context_tokens, context_limit FROM agents WHERE id = ?")
      .get(agent) as any
    return {
      today_usd: Math.round(this.today(agent) * 1e6) / 1e6,
      daily_usd: this.values(agent).daily_usd ?? "off",
      context: row?.context_tokens ?? null,
      context_limit: row?.context_limit ?? null,
    }
  }

  // Step IDs already counted (a batch sent again after a lost reply).
  private readonly counted = new Map<string, number>()

  // A model step of an agent's session (the plugin's cost event).
  step(agent: string, event: any) {
    const amount = Number(event.usd)
    if (
      typeof event.usd !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      amount > MAX_STEP_USD
    )
      return
    if (typeof event.step === "string" && event.step) {
      if (this.counted.has(event.step)) return
      this.counted.set(event.step, this.now())
      if (this.counted.size > 5000)
        for (const k of [...this.counted.keys()].slice(0, 1000))
          this.counted.delete(k)
    }
    // a Subagent's step carries no context of the agent's own session
    const context =
      event.context === undefined || event.context === null
        ? Number.NaN
        : Number(event.context)
    const limit = Number(event.limit)
    this.db
      .query(
        `INSERT INTO costs (agent_id, day, usd, steps) VALUES (?, ?, ?, 1)
         ON CONFLICT (agent_id, day) DO UPDATE SET usd = usd + excluded.usd,
           steps = steps + 1`,
      )
      .run(agent, this.day(), amount)
    // the compaction's own step reads the old conversation: not the context
    const compacting = !!(
      this.db
        .query("SELECT compacting FROM agents WHERE id = ?")
        .get(agent) as any
    )?.compacting
    if (Number.isInteger(context) && context >= 0 && !compacting)
      this.db
        .query(
          "UPDATE agents SET context_tokens = ?, context_limit = ? " +
            "WHERE id = ?",
        )
        .run(
          context,
          Number.isInteger(limit) && limit > 0 ? limit : null,
          agent,
        )
    this.warn(agent)
  }

  // The notice at cap_warn, once a day.
  private warn(agent: string) {
    const cap = this.cap(agent)
    if (cap === null || cap <= 0) return
    const share = parseFloat(String(this.values(agent).cap_warn)) / 100
    const spent = this.today(agent)
    const day = this.day()
    const row = this.db
      .query("SELECT cap_warned FROM agents WHERE id = ?")
      .get(agent) as any
    if (spent < cap * share || row?.cap_warned === day || spent > cap) return
    this.db
      .query("UPDATE agents SET cap_warned = ? WHERE id = ?")
      .run(day, agent)
    this.history.record("cap.warned", {
      agent,
      data: { spent, cap },
    })
    try {
      this.notify({
        agent,
        subject: "cost warning",
        text:
          `You have spent ${usd(spent)} today of your daily cap of ` +
          `${usd(cap)} (cap_warn ${this.values(agent).cap_warn}). Past the ` +
          "cap you are paused after your turn until tomorrow (in the " +
          "server's zone) or until the owner raises it. Finish what " +
          "matters, and keep your state in files.",
      })
    } catch {}
  }

  /*
   * A turn ended: past the cap, the agent is paused, once a day (the owner's
   * resume holds for the rest of the day: cap_override).
   */
  turnEnded(agent: string) {
    const cap = this.cap(agent)
    if (cap === null) return
    const spent = this.today(agent)
    if (spent <= cap) return
    const row = this.db
      .query("SELECT paused, cap_day, cap_override FROM agents WHERE id = ?")
      .get(agent) as any
    const day = this.day()
    if (!row || row.paused || row.cap_override === day) return
    this.db
      .query("UPDATE agents SET paused = 'cap', cap_day = ? WHERE id = ?")
      .run(day, agent)
    this.history.record("cap.reached", { agent, data: { spent, cap } })
    this.inbox.open("alert", {
      agent,
      title: `${agent} reached its daily cap (${usd(spent)} of ${usd(cap)})`,
      body:
        "It is paused until tomorrow (the server's zone), or until you " +
        "raise daily_usd or resume it.",
    })
  }

  // A cap's pause ends with a new day or a higher cap.
  tick() {
    for (const row of this.db
      .query("SELECT id, cap_day FROM agents WHERE paused = 'cap'")
      .all() as any[]) {
      const cap = this.cap(row.id)
      if (
        row.cap_day !== this.day() ||
        cap === null ||
        this.today(row.id) <= cap
      ) {
        this.db
          .query("UPDATE agents SET paused = '', cap_day = NULL WHERE id = ?")
          .run(row.id)
        this.history.record("cap.lifted", { agent: row.id })
      }
    }
  }

  /*
   * Whether a session should be compacted before its next injection: it
   * asked, or its last step's context passed compact_at.
   */
  compactDue(agent: string): { context: number; limit: number } | null {
    const row = this.db
      .query(
        "SELECT context_tokens, context_limit, compact_wanted, compacting " +
          "FROM agents WHERE id = ?",
      )
      .get(agent) as any
    if (!row) return null
    // a compaction went out and no injection since
    if (row.compacting) return null
    if (row.compact_wanted)
      return { context: row.context_tokens ?? 0, limit: 0 }
    const setting = this.values(agent).compact_at
    const context = row.context_tokens
    if (setting === "off" || context === null || context === undefined)
      return null
    let limit: number
    if (typeof setting === "number") limit = setting
    else {
      const m = /^(\d+)%(?:\s+max\s+(\d+))?$/.exec(String(setting))
      if (!m || !row.context_limit) return null
      limit = Math.floor((row.context_limit * Number(m[1])) / 100)
      limit = Math.min(limit, m[2] ? Number(m[2]) : MAX_COMPACT)
    }
    return context > limit ? { context, limit } : null
  }

  /*
   * A compaction went out: the context starts over; until the next injection
   * no other compaction comes, and the compaction's own steps (which read the
   * whole old conversation) do not count as the context.
   */
  compacted(agent: string, due: { context: number; limit: number }) {
    this.db
      .query(
        "UPDATE agents SET compact_wanted = 0, context_tokens = NULL, " +
          "compacting = 1 WHERE id = ?",
      )
      .run(agent)
    this.history.record("session.compacted", { agent, data: due })
  }

  // autocode_me compact: after the current turn.
  wantCompact(agent: string) {
    this.db
      .query("UPDATE agents SET compact_wanted = 1 WHERE id = ?")
      .run(agent)
    this.history.record("session.compact.asked", { agent })
  }

  // An injection went out: compactions may come again.
  injected(agent: string) {
    this.db.query("UPDATE agents SET compacting = 0 WHERE id = ?").run(agent)
  }

  /*
   * A turn ended: a cut found at the hello just before was no cut (the
   * plugin's outbox held its end); the cap's pause.
   */
  uncut(agent: string) {
    const row = this.db
      .query("SELECT cut_at FROM agents WHERE id = ?")
      .get(agent) as any
    if (!row?.cut_at) return
    this.db.query("UPDATE agents SET cut_at = NULL WHERE id = ?").run(agent)
    this.history.record("turn.uncut", { agent })
  }

  // A turn that was running when its OpenCode went away.
  cut(agent: string) {
    this.db
      .query("UPDATE agents SET cut_at = ? WHERE id = ?")
      .run(this.now(), agent)
    this.history.record("turn.cut", { agent })
  }

  // The resume prompt a cut turn is due for, once.
  resumeNote(agent: string) {
    const row = this.db
      .query("SELECT cut_at FROM agents WHERE id = ?")
      .get(agent) as any
    if (!row?.cut_at) return null
    return {
      header: "resume",
      text:
        "Your last turn was cut off (its OpenCode server restarted). " +
        "Continue where you left off.",
    }
  }

  resumed(agent: string) {
    this.db.query("UPDATE agents SET cut_at = NULL WHERE id = ?").run(agent)
    this.history.record("turn.resumed", { agent })
  }

  // Agents whose session's last turn ended expire_after ago.
  expired(): string[] {
    const out: string[] = []
    for (const row of this.db
      .query(
        `SELECT a.id, s.idle_since, a.registered_at FROM agents a
         JOIN sessions s ON s.id = a.session_id
         WHERE s.busy = 0 AND a.paused NOT IN ('owner', 'stop-all')
           AND NOT EXISTS (SELECT 1 FROM asks k WHERE k.agent_id = a.id
                           AND k.state = 'open')`,
      )
      .all() as any[]) {
      const after = parseDuration(String(this.values(row.id).expire_after))
      const last = row.idle_since ?? row.registered_at
      if (after > 0 && this.now() - last > after && !this.busy(row.id))
        out.push(row.id)
    }
    return out
  }

  trim(days: number) {
    this.db
      .query("DELETE FROM costs WHERE day < ?")
      .run(this.day(this.now() - Math.max(days, 31) * 86_400_000))
  }
}
